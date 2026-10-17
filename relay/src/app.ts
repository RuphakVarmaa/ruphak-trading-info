// Hono app factory. All dependencies are injected so tests run the relay in-process with
// app.request(), a fake Groww and a fake clock.
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AccessJwtVerifier, relayAuth, requestTarget, type AccessVerifier, type AppEnv } from "./auth.js";
import { isValidReferenceId } from "./caps.js";
import { realSleep, type Clock, type Sleep } from "./clock.js";
import { capsSummary, type RelayConfig } from "./config.js";
import type { FetchLike, GrowwApi } from "./groww.js";
import { istDate } from "./ist.js";
import type { Ledger } from "./ledger.js";
import { errorFields, silentLogger, type Logger } from "./log.js";
import { growwErrorResult, isValidGrowwOrderId, OrderService, parseSegment, type ServiceResult } from "./orders.js";

export interface AppDeps {
  config: RelayConfig;
  groww: GrowwApi;
  ledger: Ledger;
  clock: Clock;
  logger?: Logger;
  sleep?: Sleep;
  /** Used for the public-IP lookup and the Cloudflare Access certs. */
  fetch?: FetchLike;
  /** Overrides the verifier built from config.cfAccess (null disables Access checks). */
  accessVerifier?: AccessVerifier | null;
}

/** Path prefixes the read-only data proxy may forward to Groww (GET only). */
export const PROXY_PREFIXES = ["live-data/", "option-chain/", "historical/", "positions/", "margins/"];

export function isAllowedProxyPath(path: string): boolean {
  if (!/^[A-Za-z0-9._~/-]+$/.test(path)) return false; // no %-encoding, no backslashes
  const segments = path.split("/");
  if (segments.some((s, i) => s === "." || s === ".." || (s === "" && i < segments.length - 1))) return false;
  return PROXY_PREFIXES.some((p) => path.startsWith(p));
}

const PUBLIC_IP_TTL_MS = 10 * 60_000;
const PUBLIC_IP_FAILURE_TTL_MS = 60_000;
const REACHABLE_TTL_MS = 60_000;

function send(c: Context<AppEnv>, r: ServiceResult): Response {
  return c.json(r.body, r.httpStatus as ContentfulStatusCode);
}

function badRequest(c: Context<AppEnv>, error: string): Response {
  return c.json({ error, code: "BAD_REQUEST" }, 400);
}

function jsonBody(c: Context<AppEnv>): { ok: true; value: unknown } | { ok: false } {
  const raw = c.get("rawBody") ?? "";
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config, groww, ledger, clock } = deps;
  const logger = deps.logger ?? silentLogger;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const orders = new OrderService({ config, groww, ledger, clock, sleep: deps.sleep ?? realSleep, logger });
  const access =
    deps.accessVerifier !== undefined
      ? deps.accessVerifier
      : config.cfAccess
        ? new AccessJwtVerifier({ certsUrl: config.cfAccess.certsUrl, issuer: config.cfAccess.issuer, aud: config.cfAccess.aud, fetch: fetchImpl, clock, logger })
        : null;

  // ---- cached health probes ----
  let ipCache: { at: number; value: string | null } | null = null;
  const publicIp = async (): Promise<string | null> => {
    const now = clock.now();
    if (ipCache && now - ipCache.at < (ipCache.value === null ? PUBLIC_IP_FAILURE_TTL_MS : PUBLIC_IP_TTL_MS)) return ipCache.value;
    let value: string | null = null;
    try {
      const res = await fetchImpl("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { ip?: unknown };
      value = res.ok && typeof body.ip === "string" ? body.ip : null;
    } catch (e) {
      logger.warn("public IP lookup failed", { err: errorFields(e) });
    }
    ipCache = { at: clock.now(), value };
    return value;
  };

  let reachCache: { at: number; value: boolean } | null = null;
  const growwReachable = async (): Promise<boolean> => {
    const now = clock.now();
    if (reachCache && now - reachCache.at < REACHABLE_TTL_MS) return reachCache.value;
    let value = false;
    try {
      await groww.getMargins();
      value = true;
    } catch (e) {
      logger.warn("groww reachability probe failed", { err: errorFields(e) });
    }
    reachCache = { at: clock.now(), value };
    return value;
  };

  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = requestTarget(c.req.url).split("?")[0];
    if (path !== "/healthz") logger.info("request", { method: c.req.method, path, status: c.res.status, ms: Date.now() - started });
  });

  // Unauthenticated liveness probe for local health checks (Docker/systemd).
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("*", relayAuth({ secret: config.hmacSecret, clock, nonces: ledger, logger, access, publicPaths: ["/healthz"] }));

  app.get("/health", async (c) => {
    const now = clock.now();
    const today = istDate(now);
    const [ip, token] = await Promise.all([
      publicIp(),
      groww.ensureToken().then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
      ),
    ]);
    const reachable = token.ok ? await growwReachable() : false;
    const status = groww.tokenStatus();
    const body: Record<string, unknown> = {
      ok: token.ok,
      live: config.live,
      version: config.version,
      publicIp: ip,
      tokenValidUntil: status.validUntil !== null ? new Date(status.validUntil).toISOString() : null,
      ordersToday: ledger.countSentOrders(today),
      buyPremiumToday: ledger.buyPremium(today),
      caps: capsSummary(config),
      growwReachable: reachable,
      clockIso: new Date(now).toISOString(),
      clockSkewMs: c.get("skewMs"),
      dataProxy: config.dataProxy,
    };
    if (!token.ok) body.tokenError = token.error;
    return c.json(body);
  });

  app.post("/v1/orders", async (c) => {
    const body = jsonBody(c);
    if (!body.ok) return badRequest(c, "body is not valid JSON");
    return send(c, await orders.placeOrder(body.value));
  });

  app.get("/v1/orders/ref/:ref", async (c) => {
    const ref = c.req.param("ref");
    if (!isValidReferenceId(ref)) return badRequest(c, "invalid order reference id");
    const segment = parseSegment(c.req.query("segment"));
    if (segment === null) return badRequest(c, 'segment must be "FNO" or "CASH"');
    try {
      const s = await groww.getOrderStatusByRef(ref, segment);
      if (!s) return c.json({ error: `no order with reference ${ref}`, code: "NOT_FOUND" }, 404);
      let avgFillPrice = s.avgFillPrice;
      if (avgFillPrice === null && (s.filledQty ?? 0) > 0 && s.growwOrderId) {
        try {
          avgFillPrice = (await groww.getOrderDetail(s.growwOrderId, segment)).avgFillPrice; // status payload has no average price
        } catch (e) {
          logger.warn("order detail lookup failed", { growwOrderId: s.growwOrderId, err: errorFields(e) });
        }
      }
      const row = ledger.findSentOrder(ref);
      if (row && (row.status === "UNKNOWN" || (row.status === "ACCEPTED" && row.orderStatus !== s.orderStatus))) {
        ledger.updateOrder(row.id, { status: "ACCEPTED", growwOrderId: s.growwOrderId ?? row.growwOrderId, orderStatus: s.orderStatus });
      }
      return c.json({ growwOrderId: s.growwOrderId, orderStatus: s.orderStatus, filledQty: s.filledQty ?? 0, avgFillPrice, remark: s.remark });
    } catch (e) {
      return send(c, growwErrorResult(e));
    }
  });

  app.get("/v1/orders/:growwOrderId/trades", async (c) => {
    const id = c.req.param("growwOrderId");
    if (!isValidGrowwOrderId(id)) return badRequest(c, "invalid groww order id");
    const segment = parseSegment(c.req.query("segment"));
    if (segment === null) return badRequest(c, 'segment must be "FNO" or "CASH"');
    try {
      return c.json({ trades: await groww.getTrades(id, segment) });
    } catch (e) {
      return send(c, growwErrorResult(e));
    }
  });

  app.post("/v1/orders/:growwOrderId/cancel", async (c) => {
    const body = jsonBody(c);
    if (!body.ok) return badRequest(c, "body is not valid JSON");
    return send(c, await orders.cancel(c.req.param("growwOrderId"), body.value));
  });

  app.post("/v1/orders/:growwOrderId/modify", async (c) => {
    const body = jsonBody(c);
    if (!body.ok) return badRequest(c, "body is not valid JSON");
    return send(c, await orders.modify(c.req.param("growwOrderId"), body.value));
  });

  app.get("/v1/positions", async (c) => {
    const segment = parseSegment(c.req.query("segment"));
    if (segment === null) return badRequest(c, 'segment must be "FNO" or "CASH"');
    try {
      const positions = await groww.getPositions(segment);
      return c.json({
        positions: positions.map((p) => ({ tradingSymbol: p.tradingSymbol, exchange: p.exchange, qty: p.qty, avgPrice: p.avgPrice, product: p.product })),
      });
    } catch (e) {
      return send(c, growwErrorResult(e));
    }
  });

  app.get("/v1/margin", async (c) => {
    try {
      return c.json((await groww.getMargins()) ?? {});
    } catch (e) {
      return send(c, growwErrorResult(e));
    }
  });

  app.post("/v1/panic", async (c) => {
    const body = jsonBody(c);
    return send(c, await orders.panic(body.ok ? body.value : {}));
  });

  app.all("/v1/groww/*", async (c) => {
    if (!config.dataProxy) return c.json({ error: "data proxy disabled (RELAY_DATA_PROXY=false)", code: "DATA_PROXY_DISABLED" }, 404);
    if (c.req.method !== "GET") return c.json({ error: "the data proxy is read-only (GET)", code: "METHOD_NOT_ALLOWED" }, 405);
    const target = requestTarget(c.req.url);
    const rest = target.slice("/v1/groww/".length);
    const q = rest.indexOf("?");
    const path = q === -1 ? rest : rest.slice(0, q);
    const search = q === -1 ? "" : rest.slice(q);
    if (!isAllowedProxyPath(path)) {
      return c.json({ error: `path not allowed; allowed prefixes: ${PROXY_PREFIXES.join(", ")}`, code: "PATH_NOT_ALLOWED" }, 403);
    }
    try {
      const r = await groww.proxyGet(`/${path}${search}`);
      c.header("x-groww-status", String(r.status));
      // Keep 401/403 for the relay's own auth failures: report Groww's as a gateway error.
      const status = r.status === 401 || r.status === 403 ? 502 : r.status >= 200 && r.status <= 599 && ![204, 205, 304].includes(r.status) ? r.status : 502;
      return c.json(r.body, status as ContentfulStatusCode);
    } catch (e) {
      return send(c, growwErrorResult(e));
    }
  });

  app.notFound((c) => c.json({ error: "not found", code: "NOT_FOUND" }, 404));

  app.onError((err, c) => {
    logger.error("unhandled error", { path: requestTarget(c.req.url).split("?")[0], err: errorFields(err) });
    return c.json({ error: "internal error", code: "INTERNAL" }, 500);
  });

  return app;
}
