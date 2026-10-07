// Process entrypoint: config -> ledger -> Groww client -> Hono server on RELAY_HOST:RELAY_PORT.
import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { systemClock } from "./clock.js";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { GrowwClient, GrowwTokenManager } from "./groww.js";
import { describeIst } from "./ist.js";
import { Ledger } from "./ledger.js";
import { createLogger, errorFields } from "./log.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(): void {
  // Local convenience: read ./.env if present (variables already in the environment win).
  if (existsSync(".env")) process.loadEnvFile(".env");

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(process.env, { version: readVersion() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { config, warnings } = loaded;
  const logger = createLogger({ level: config.logLevel, base: { svc: "order-relay" } });
  for (const w of warnings) logger.warn(w);

  const clock = systemClock;
  const ledger = new Ledger(config.dbPath, clock);
  const recovered = ledger.markPendingUnknown();
  if (recovered > 0) logger.warn("orders left in flight by a previous run are marked UNKNOWN; reconcile them by reference", { count: recovered });

  const fetchImpl = (input: string, init?: RequestInit) => fetch(input, init);
  const tokens = new GrowwTokenManager({
    apiKey: config.growwApiKey,
    totpSecret: config.growwTotpSecret,
    baseUrl: config.growwBaseUrl,
    fetch: fetchImpl,
    clock,
    store: ledger,
    logger,
    timeoutMs: config.growwTimeoutMs,
  });
  const groww = new GrowwClient({ baseUrl: config.growwBaseUrl, fetch: fetchImpl, tokens, timeoutMs: config.growwTimeoutMs, logger });
  const app = createApp({ config, groww, ledger, clock, logger, fetch: fetchImpl });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info("relay listening", { address: info.address, port: info.port, istNow: describeIst(clock.now()), config: describeConfig(config) });
  });
  server.on("error", (e) => {
    logger.error("server error", { err: errorFields(e) });
    process.exit(1);
  });
  ledger.event("startup", { version: config.version, live: config.live, host: config.host, port: config.port });

  // Startup token: reuse the cached one if still valid, otherwise mint (never blocks serving).
  if (tokens.hasCredentials) {
    tokens
      .getToken()
      .then(() => {
        const s = tokens.status();
        logger.info("groww token ready", { validUntil: s.validUntil !== null ? new Date(s.validUntil).toISOString() : null });
      })
      .catch((e: unknown) => logger.error("groww token unavailable at startup", { err: errorFields(e) }));
  } else {
    logger.warn("Groww credentials not configured: /health reports ok=false and no order can be sent");
  }

  // Proactive daily re-mint after 06:05 IST (tokens expire at 06:00 IST).
  const timer = setInterval(() => {
    tokens.maybeScheduledRefresh().catch((e: unknown) => logger.error("scheduled token refresh failed", { err: errorFields(e) }));
  }, 60_000);
  timer.unref();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    clearInterval(timer);
    server.close(() => {
      ledger.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => logger.error("unhandled rejection", { err: errorFields(e) }));
}

main();
