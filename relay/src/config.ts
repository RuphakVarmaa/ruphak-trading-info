// Environment parsing and validation. Every cap has a conservative default; secrets are
// validated but never logged (see describeConfig).
import { base32Decode } from "./totp.js";
import { formatHhMm, formatWindow, parseHhMm, parseWindow, type TimeWindow } from "./ist.js";

export const UNDERLYINGS = ["NIFTY", "SENSEX"] as const;
export type Underlying = (typeof UNDERLYINGS)[number];
export const PRODUCTS = ["MIS", "NRML"] as const;
export type Product = (typeof PRODUCTS)[number];

/** Exchange each underlying's options trade on (NIFTY -> NSE F&O, SENSEX -> BSE F&O). */
export const UNDERLYING_EXCHANGE: Record<Underlying, "NSE" | "BSE"> = { NIFTY: "NSE", SENSEX: "BSE" };

/**
 * NSE/BSE weekday trading holidays for 2026 (NSE circular NSE/CMTR/71775; BSE follows the
 * same list). Used when MARKET_HOLIDAYS is unset; set MARKET_HOLIDAYS to replace it.
 */
export const DEFAULT_HOLIDAYS_2026 = [
  "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
  "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
  "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
];

export interface CfAccessConfig {
  teamDomain: string;
  certsUrl: string;
  issuer: string;
  aud: string;
}

export interface RelayConfig {
  host: string;
  port: number;
  hmacSecret: string;
  live: boolean;
  dataProxy: boolean;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  allowedUnderlyings: Underlying[];
  productAllowlist: Product[];
  maxLotsPerOrder: number;
  maxOrdersPerDay: number;
  tradingWindow: TimeWindow;
  /** Minutes after 00:00 IST until which risk-reducing SELL exits stay allowed. */
  exitWindowEndMin: number;
  allowShort: boolean;
  maxPremiumPerOrderInr: number;
  maxDailyPremiumInr: number;
  /** Relay-side lot sizes; an order whose lotSize differs is rejected. Empty = trust the order. */
  lotSizes: Partial<Record<Underlying, number>>;
  holidays: Set<string>;
  growwApiKey: string | null;
  growwTotpSecret: string | null;
  growwBaseUrl: string;
  growwTimeoutMs: number;
  orderMinIntervalMs: number;
  cfAccess: CfAccessConfig | null;
  version: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid relay configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function normalizeTeamDomain(value: string): string {
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
}

export function loadConfig(env: Env, opts: { version?: string } = {}): { config: RelayConfig; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const bool = (key: string, def: boolean): boolean => {
    const v = str(env, key);
    if (v === undefined) return def;
    const lower = v.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    problems.push(`${key} must be "true" or "false"`);
    return def;
  };

  const int = (key: string, def: number, min: number, max: number): number => {
    const v = str(env, key);
    if (v === undefined) return def;
    if (!/^\d+$/.test(v)) {
      problems.push(`${key} must be an integer`);
      return def;
    }
    const n = Number(v);
    if (n < min || n > max) {
      problems.push(`${key} must be between ${min} and ${max}`);
      return def;
    }
    return n;
  };

  const money = (key: string, def: number): number => {
    const v = str(env, key);
    if (v === undefined) return def;
    const n = Number(v);
    if (!/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(n) || n <= 0) {
      problems.push(`${key} must be a positive number of rupees`);
      return def;
    }
    return n;
  };

  const list = <T extends string>(key: string, def: readonly T[], allowed: readonly T[]): T[] => {
    const v = str(env, key);
    if (v === undefined) return [...def];
    const items = v.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s !== "");
    const bad = items.filter((s) => !(allowed as readonly string[]).includes(s));
    if (bad.length > 0) problems.push(`${key} has unsupported values: ${bad.join(", ")} (allowed: ${allowed.join(", ")})`);
    if (items.length === 0) problems.push(`${key} must not be empty`);
    return [...new Set(items.filter((s): s is T => (allowed as readonly string[]).includes(s)))];
  };

  const live = bool("RELAY_LIVE", false);

  const hmacSecret = env.RELAY_HMAC_SECRET ?? "";
  if (hmacSecret.length === 0) problems.push("RELAY_HMAC_SECRET is required (generate one with: openssl rand -hex 32)");
  else if (hmacSecret.length < 16) problems.push("RELAY_HMAC_SECRET must be at least 16 characters");
  else if (live && hmacSecret.length < 32) problems.push("RELAY_HMAC_SECRET must be at least 32 characters when RELAY_LIVE=true");

  const host = str(env, "RELAY_HOST") ?? "127.0.0.1";
  const port = int("RELAY_PORT", 8790, 1, 65535);

  let tradingWindow: TimeWindow = { startMin: 9 * 60 + 16, endMin: 15 * 60 + 12 };
  const windowRaw = str(env, "TRADING_WINDOW_IST");
  if (windowRaw !== undefined) {
    try {
      tradingWindow = parseWindow(windowRaw);
    } catch (e) {
      problems.push(`TRADING_WINDOW_IST: ${(e as Error).message}`);
    }
  }
  let exitWindowEndMin = 15 * 60 + 25;
  const exitRaw = str(env, "EXIT_WINDOW_END_IST");
  if (exitRaw !== undefined) {
    try {
      exitWindowEndMin = parseHhMm(exitRaw);
    } catch (e) {
      problems.push(`EXIT_WINDOW_END_IST: ${(e as Error).message}`);
    }
  }
  if (exitWindowEndMin < tradingWindow.endMin) {
    problems.push(`EXIT_WINDOW_END_IST (${formatHhMm(exitWindowEndMin)}) must not be before the end of TRADING_WINDOW_IST`);
  }

  const lotSizes: Partial<Record<Underlying, number>> = {};
  const lotRaw = env.LOT_SIZES === undefined ? "NIFTY:65,SENSEX:20" : env.LOT_SIZES.trim();
  if (lotRaw !== "" && lotRaw.toLowerCase() !== "off") {
    for (const part of lotRaw.split(",")) {
      const m = /^\s*([A-Za-z]+)\s*:\s*(\d+)\s*$/.exec(part);
      const u = m?.[1]?.toUpperCase();
      if (!m || !u || !(UNDERLYINGS as readonly string[]).includes(u) || Number(m[2]) < 1) {
        problems.push(`LOT_SIZES entry "${part.trim()}" must look like NIFTY:65`);
        continue;
      }
      lotSizes[u as Underlying] = Number(m[2]);
    }
  }

  const holidays = new Set<string>();
  const holidayRaw = env.MARKET_HOLIDAYS === undefined ? DEFAULT_HOLIDAYS_2026.join(",") : env.MARKET_HOLIDAYS;
  for (const d of holidayRaw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) problems.push(`MARKET_HOLIDAYS has an invalid date "${d}"`);
    else holidays.add(d);
  }

  const growwApiKey = str(env, "GROWW_API_KEY") ?? null;
  const growwTotpSecret = str(env, "GROWW_TOTP_SECRET") ?? null;
  if (growwTotpSecret !== null) {
    try {
      base32Decode(growwTotpSecret);
    } catch {
      problems.push("GROWW_TOTP_SECRET is not valid base32");
    }
  }
  if ((growwApiKey === null) !== (growwTotpSecret === null)) problems.push("set both GROWW_API_KEY and GROWW_TOTP_SECRET, or neither");
  if (live && (growwApiKey === null || growwTotpSecret === null)) problems.push("RELAY_LIVE=true requires GROWW_API_KEY and GROWW_TOTP_SECRET");

  const growwBaseUrl = (str(env, "GROWW_BASE_URL") ?? "https://api.groww.in/v1").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(growwBaseUrl)) problems.push("GROWW_BASE_URL must be an http(s) URL");

  let cfAccess: CfAccessConfig | null = null;
  const team = str(env, "CF_ACCESS_TEAM_DOMAIN");
  const aud = str(env, "CF_ACCESS_AUD");
  if ((team === undefined) !== (aud === undefined)) {
    problems.push("set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither");
  } else if (team !== undefined && aud !== undefined) {
    const domain = normalizeTeamDomain(team);
    cfAccess = { teamDomain: domain, certsUrl: `https://${domain}/cdn-cgi/access/certs`, issuer: `https://${domain}`, aud };
  }

  const logLevelRaw = (str(env, "RELAY_LOG_LEVEL") ?? "info").toLowerCase();
  const logLevel = (["debug", "info", "warn", "error"] as const).find((l) => l === logLevelRaw);
  if (!logLevel) problems.push("RELAY_LOG_LEVEL must be debug, info, warn or error");

  const config: RelayConfig = {
    host,
    port,
    hmacSecret,
    live,
    dataProxy: bool("RELAY_DATA_PROXY", false),
    dbPath: str(env, "RELAY_DB_PATH") ?? "./data/relay.sqlite",
    logLevel: logLevel ?? "info",
    allowedUnderlyings: list("ALLOWED_UNDERLYINGS", UNDERLYINGS, UNDERLYINGS),
    productAllowlist: list("PRODUCT_ALLOWLIST", ["MIS"], PRODUCTS),
    maxLotsPerOrder: int("MAX_LOTS_PER_ORDER", 2, 1, 100),
    maxOrdersPerDay: int("MAX_ORDERS_PER_DAY", 12, 0, 1000),
    tradingWindow,
    exitWindowEndMin,
    allowShort: bool("ALLOW_SHORT", false),
    maxPremiumPerOrderInr: money("MAX_PREMIUM_PER_ORDER_INR", 25_000),
    maxDailyPremiumInr: money("MAX_DAILY_PREMIUM_INR", 60_000),
    lotSizes,
    holidays,
    growwApiKey,
    growwTotpSecret,
    growwBaseUrl,
    growwTimeoutMs: int("GROWW_TIMEOUT_MS", 8_000, 1_000, 60_000),
    orderMinIntervalMs: int("ORDER_MIN_INTERVAL_MS", 250, 200, 10_000),
    cfAccess,
    version: opts.version ?? "0.0.0",
  };

  if (config.maxDailyPremiumInr < config.maxPremiumPerOrderInr) {
    warnings.push("MAX_DAILY_PREMIUM_INR is below MAX_PREMIUM_PER_ORDER_INR; the daily cap binds first");
  }
  if (live && cfAccess === null) {
    warnings.push("RELAY_LIVE=true without CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD: requests are authenticated by HMAC only");
  }
  if (config.allowShort) warnings.push("ALLOW_SHORT=true: SELL orders may open short option positions");
  if (Object.keys(lotSizes).length === 0) warnings.push("LOT_SIZES is off: the lots cap trusts the lotSize sent by the engine");

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}

/** Cap values exposed by GET /health (no secrets). */
export function capsSummary(c: RelayConfig): Record<string, unknown> {
  return {
    allowedUnderlyings: c.allowedUnderlyings,
    productAllowlist: c.productAllowlist,
    maxLotsPerOrder: c.maxLotsPerOrder,
    maxOrdersPerDay: c.maxOrdersPerDay,
    tradingWindowIst: formatWindow(c.tradingWindow),
    exitWindowEndIst: formatHhMm(c.exitWindowEndMin),
    allowShort: c.allowShort,
    maxPremiumPerOrderInr: c.maxPremiumPerOrderInr,
    maxDailyPremiumInr: c.maxDailyPremiumInr,
    lotSizes: c.lotSizes,
  };
}

/** Redacted configuration for the startup log line. */
export function describeConfig(c: RelayConfig): Record<string, unknown> {
  return {
    version: c.version,
    host: c.host,
    port: c.port,
    live: c.live,
    dataProxy: c.dataProxy,
    dbPath: c.dbPath,
    hmacSecret: `set (${c.hmacSecret.length} chars)`,
    growwCredentials: c.growwApiKey !== null && c.growwTotpSecret !== null ? "set" : "missing",
    growwBaseUrl: c.growwBaseUrl,
    cfAccess: c.cfAccess ? { teamDomain: c.cfAccess.teamDomain, aud: `${c.cfAccess.aud.slice(0, 8)}...` } : "off",
    holidays: c.holidays.size,
    caps: capsSummary(c),
  };
}
