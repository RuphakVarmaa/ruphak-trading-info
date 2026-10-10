/**
 * Read-only option quotes from Upstox's official Market Data API, with the free Upstox Analytics Token
 * (one year, read-only, GET only, no static IP needed for market quotes:
 * https://upstox.com/developer/api-documentation/analytics-token/). For the quote recorder only
 * (workers/engine/src/runtime.ts recorderQuoteSource), used when the Worker secret UPSTOX_ANALYTICS_TOKEN
 * is set and the Groww Trade API keys (a paid live-data plan) are not. Nothing here can place an order,
 * and the token cannot either.
 *
 * One GET /v2/market-quote/quotes covers up to 500 contracts: five-level depth, the last trade and its
 * exchange time (epoch ms), volume and open interest, as Upstox reports them. Contracts are addressed by
 * instrument key "NSE_FO|<exchange token>" or "BSE_FO|<exchange token>", from the instrument master's
 * exchange tokens: on 10 Oct 2026 every one of the 4,942 NIFTY and SENSEX options in Upstox's published
 * instrument files matched Groww's master by exchange token, strike and type. Index spots come from the
 * same endpoint ("NSE_INDEX|Nifty 50", "BSE_INDEX|SENSEX").
 *
 * Pure and web-standard (no node: imports); the token is only ever sent in the Authorization header.
 */
import type { Exchange, FeatureIndexId, Level, OptionContract, Quote } from "../types";

type Rec = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);

export const UPSTOX_API_BASE = "https://api.upstox.com";
/** `source` of the rows recorded from Upstox (D1 `option_quotes`). */
export const UPSTOX_QUOTE_SOURCE = "upstox:v2/market-quote/quotes";
/** Instrument keys Upstox accepts in one call. */
export const UPSTOX_MAX_KEYS = 500;
export const UPSTOX_INDEX_KEYS: Partial<Record<FeatureIndexId, string>> = {
  NIFTY: "NSE_INDEX|Nifty 50",
  SENSEX: "BSE_INDEX|SENSEX",
};

/** The failures the recorder acts on: auth, forbidden and rate_limited stop a snapshot. */
export type UpstoxErrorKind = "auth" | "forbidden" | "bad_request" | "not_found" | "rate_limited" | "transient" | "unknown";

export class UpstoxError extends Error {
  constructor(
    message: string,
    readonly kind: UpstoxErrorKind,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UpstoxError";
  }
}

export function classifyUpstoxStatus(status: number): UpstoxErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "transient";
  return "unknown";
}

/** The instrument key of an option contract: its exchange segment and exchange token. */
export function upstoxInstrumentKey(c: Pick<OptionContract, "exchange" | "exchangeToken">): string {
  const segment: Record<Exchange, string> = { NSE: "NSE_FO", BSE: "BSE_FO" };
  return `${segment[c.exchange]}|${c.exchangeToken}`;
}

/** One side of an Upstox depth array ([{quantity, price, orders}]): positive levels, best first. */
export function parseUpstoxLevels(v: unknown, side: "buy" | "sell"): Level[] {
  if (!Array.isArray(v)) return [];
  const out: Level[] = [];
  for (const l of v) {
    const r = rec(l);
    const price = num(r?.price);
    const qty = num(r?.quantity);
    if (price !== null && qty !== null && price > 0 && qty > 0) out.push({ price, qty });
  }
  return out.sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
}

/** Epoch ms from Upstox's last_trade_time ("1697624972130"; seconds are scaled), or null. */
export function parseUpstoxTime(v: unknown): number | null {
  const n = num(v);
  // A number (or numeric string) is epoch time; "0" means no trade yet, never a date.
  if (n !== null) return n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** One entry of the quotes response as a Quote (`t` is the fetch time) and the exchange time of its last trade. */
export function parseUpstoxQuote(symbol: string, entry: unknown, fetchedMs: number): { quote: Quote; lastTradeMs: number | null } {
  const e = rec(entry) ?? {};
  const depth = rec(e.depth);
  const buy = parseUpstoxLevels(depth?.buy, "buy");
  const sell = parseUpstoxLevels(depth?.sell, "sell");
  const quote: Quote = {
    symbol,
    t: fetchedMs,
    ltp: num(e.last_price) ?? 0,
    bid: buy[0]?.price ?? 0,
    ask: sell[0]?.price ?? 0,
    bidQty: buy[0]?.qty ?? 0,
    askQty: sell[0]?.qty ?? 0,
    source: "upstox",
  };
  if (buy.length > 0 || sell.length > 0) quote.depth = { buy, sell };
  const oi = num(e.oi);
  if (oi !== null && oi >= 0) quote.oi = oi;
  const volume = num(e.volume);
  if (volume !== null && volume >= 0) quote.volume = volume;
  return { quote, lastTradeMs: parseUpstoxTime(e.last_trade_time) };
}

/**
 * The quotes response's entries by instrument key: each entry's `instrument_token` (the pipe form). Without
 * one, the data key with its first ":" read as "|" ("NSE_INDEX:Nifty 50"; an option's data key carries its
 * symbol instead of the token, so it then matches nothing and the contract counts as not returned).
 */
export function upstoxEntriesByKey(payload: unknown): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const data = rec(rec(payload)?.data);
  if (!data) return out;
  for (const [dataKey, v] of Object.entries(data)) {
    const e = rec(v);
    if (!e) continue;
    const key = str(e.instrument_token) ?? dataKey.replace(":", "|");
    out.set(key, e);
  }
  return out;
}

export interface UpstoxQuotesOptions {
  /** The Analytics Token (Worker secret UPSTOX_ANALYTICS_TOKEN). */
  token: string;
  /** Defaults to the global fetch. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Per request (default 8 s). */
  timeoutMs?: number;
}

export interface QuoteBatch {
  /** By trading symbol; a contract Upstox did not return is missing. */
  quotes: Map<string, { quote: Quote; lastTradeMs: number | null }>;
  requests: number;
}

/** The quote recorder's Upstox source (the recorder's QuoteSource shape, with batch quotes). */
export class UpstoxQuotes {
  readonly name = UPSTOX_QUOTE_SOURCE;

  constructor(private readonly o: UpstoxQuotesOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async quotes(keys: readonly string[]): Promise<unknown> {
    const url = `${UPSTOX_API_BASE}/v2/market-quote/quotes?instrument_key=${keys.map(encodeURIComponent).join(",")}`;
    const init: RequestInit = {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.o.token}` },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8_000),
    };
    let res: Response;
    try {
      // Call the global fetch directly: a detached fetch loses its binding in Workers.
      res = this.o.fetch ? await this.o.fetch(url, init) : await fetch(url, init);
    } catch (err) {
      throw new UpstoxError(`Upstox GET /v2/market-quote/quotes: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const first = rec(Array.isArray(rec(body)?.errors) ? (rec(body)!.errors as unknown[])[0] : null);
    const code = str(first?.errorCode) ?? str(first?.error_code) ?? undefined;
    const message = str(first?.message) ?? "";
    if (!res.ok) {
      // Never echo the request (it carries no secret, but keep errors short and about the failure).
      throw new UpstoxError(`Upstox GET /v2/market-quote/quotes: HTTP ${res.status}${code ? ` ${code}` : ""}${message ? ` ${message.slice(0, 120)}` : ""}`, classifyUpstoxStatus(res.status), res.status, code);
    }
    if (rec(body)?.status !== "success") {
      throw new UpstoxError(`Upstox GET /v2/market-quote/quotes: status ${String(rec(body)?.status ?? "missing")}${code ? ` ${code}` : ""}`, "unknown", res.status, code);
    }
    return body;
  }

  /** Index spots (NIFTY, SENSEX) in one call. */
  async indexLtp(): Promise<Partial<Record<FeatureIndexId, number>>> {
    const pairs = Object.entries(UPSTOX_INDEX_KEYS) as [FeatureIndexId, string][];
    const byKey = upstoxEntriesByKey(await this.quotes(pairs.map(([, k]) => k)));
    const out: Partial<Record<FeatureIndexId, number>> = {};
    for (const [id, key] of pairs) {
      const v = num(byKey.get(key)?.last_price);
      if (v !== null && v > 0) out[id] = v;
    }
    return out;
  }

  /** Quotes of every contract, at most 500 a request. */
  async quoteBatch(contracts: readonly OptionContract[]): Promise<QuoteBatch> {
    const quotes = new Map<string, { quote: Quote; lastTradeMs: number | null }>();
    let requests = 0;
    const keyed = contracts.map((c) => ({ c, key: upstoxInstrumentKey(c) }));
    for (let i = 0; i < keyed.length; i += UPSTOX_MAX_KEYS) {
      const part = keyed.slice(i, i + UPSTOX_MAX_KEYS);
      requests++;
      const byKey = upstoxEntriesByKey(await this.quotes(part.map((p) => p.key)));
      const fetchedMs = this.now();
      for (const { c, key } of part) {
        const e = byKey.get(key);
        if (e) quotes.set(c.tradingSymbol, parseUpstoxQuote(c.tradingSymbol, e, fetchedMs));
      }
    }
    return { quotes, requests };
  }
}
