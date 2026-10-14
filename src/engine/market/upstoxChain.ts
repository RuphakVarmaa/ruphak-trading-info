/**
 * The live option chain and index levels from Upstox's Market Data API, read with the free, read-only
 * Upstox Analytics Token (the same secret as the quote recorder, src/engine/market/upstoxQuotes.ts):
 *
 * - GET /v2/option/contract?instrument_key=<underlying>: every listed contract, for the expiries and lot size;
 * - GET /v2/option/chain?instrument_key=<underlying>&expiry_date=YYYY-MM-DD: one row per strike with both
 *   sides' market data and Upstox's greeks;
 * - GET /v2/market-quote/quotes for the index levels (NIFTY, SENSEX, BANKNIFTY, India VIX).
 *
 * Parsing and the chain's figures (ATM, PCR, max pain) are pure; the client takes fetch and the token by
 * injection. Pure and web-standard (no node: imports); the token is only ever sent in the Authorization header.
 */
import { SESSION, istDate, istIso, istMinutes } from "../clock";
import type { IndexId, LiveIndexLevelsView, OptionChainRowView, OptionChainView, OptionSideView } from "../api-types";
import { UPSTOX_API_BASE, UpstoxError, classifyUpstoxStatus, upstoxEntriesByKey } from "./upstoxQuotes";

type Rec = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const nonNeg = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const round = (v: number, dp: number): number => Math.round(v * 10 ** dp) / 10 ** dp;

/** The underlying's instrument key for the option endpoints. */
export const UPSTOX_UNDERLYING_KEYS: Record<IndexId, string> = {
  NIFTY: "NSE_INDEX|Nifty 50",
  SENSEX: "BSE_INDEX|SENSEX",
};

export type LiveIndexKey = LiveIndexLevelsView["levels"][number]["key"];
export type LiveIndexLevel = LiveIndexLevelsView["levels"][number];

/** Index levels for the ticker, in display order. */
export const UPSTOX_LIVE_INDEX_KEYS: readonly (readonly [LiveIndexKey, string])[] = [
  ["NIFTY", "NSE_INDEX|Nifty 50"],
  ["SENSEX", "BSE_INDEX|SENSEX"],
  ["BANKNIFTY", "NSE_INDEX|Nifty Bank"],
  ["INDIAVIX", "NSE_INDEX|India VIX"],
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OptionContractsMeta {
  /** YYYY-MM-DD, ascending, unique. */
  expiries: string[];
  /** 0 when no contract reports one. */
  lotSize: number;
}

/** The /v2/option/contract response: listed expiries and the (most common) lot size. */
export function parseUpstoxContracts(payload: unknown): OptionContractsMeta {
  const data = rec(payload)?.data;
  const expiries = new Set<string>();
  const lots = new Map<number, number>();
  if (Array.isArray(data)) {
    for (const v of data) {
      const r = rec(v);
      const expiry = str(r?.expiry)?.slice(0, 10);
      if (expiry && DATE_RE.test(expiry)) expiries.add(expiry);
      const lot = pos(r?.lot_size);
      if (lot !== null) lots.set(lot, (lots.get(lot) ?? 0) + 1);
    }
  }
  let lotSize = 0;
  let best = 0;
  for (const [lot, n] of lots) if (n > best) [lotSize, best] = [lot, n];
  return { expiries: [...expiries].sort(), lotSize };
}

/** One side of a chain row; null without an instrument key. Zero prices (no bid, no trade) are null. */
export function parseUpstoxOptionSide(v: unknown): OptionSideView | null {
  const r = rec(v);
  const instrumentKey = str(r?.instrument_key);
  if (!r || !instrumentKey) return null;
  const md = rec(r.market_data) ?? {};
  const g = rec(r.option_greeks) ?? {};
  const ltp = pos(md.ltp);
  const close = pos(md.close_price);
  const bid = pos(md.bid_price);
  const ask = pos(md.ask_price);
  const oi = nonNeg(md.oi);
  const prevOi = nonNeg(md.prev_oi);
  const change = ltp !== null && close !== null ? round(ltp - close, 2) : null;
  return {
    instrumentKey,
    ltp,
    close,
    change,
    changePct: change !== null && close !== null ? round(((ltp! - close) / close) * 100, 2) : null,
    bid,
    ask,
    bidQty: bid !== null ? nonNeg(md.bid_qty) : null,
    askQty: ask !== null ? nonNeg(md.ask_qty) : null,
    volume: nonNeg(md.volume),
    oi,
    prevOi,
    oiChange: oi !== null && prevOi !== null ? oi - prevOi : null,
    // Upstox reports iv 0 where it could not solve for one.
    iv: pos(g.iv),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    pop: num(g.pop),
  };
}

export interface ParsedChain {
  /** The underlying's level Upstox reported with the chain (0 when missing). */
  spot: number;
  /** By strike, ascending; one row per strike. */
  rows: OptionChainRowView[];
}

/** The /v2/option/chain response. */
export function parseUpstoxChain(payload: unknown): ParsedChain {
  const data = rec(payload)?.data;
  const byStrike = new Map<number, OptionChainRowView>();
  let spot = 0;
  if (Array.isArray(data)) {
    for (const v of data) {
      const r = rec(v);
      const strike = pos(r?.strike_price);
      if (!r || strike === null) continue;
      spot ||= pos(r.underlying_spot_price) ?? 0;
      const ce = parseUpstoxOptionSide(r.call_options);
      const pe = parseUpstoxOptionSide(r.put_options);
      if (!ce && !pe) continue;
      byStrike.set(strike, { strike, ce, pe });
    }
  }
  return { spot, rows: [...byStrike.values()].sort((a, b) => a.strike - b.strike) };
}

/** The strike nearest the spot (the lower one on a tie); 0 without rows. */
export function atmStrike(rows: readonly OptionChainRowView[], spot: number): number {
  let best = 0;
  let dist = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.strike - spot);
    if (d < dist) [best, dist] = [r.strike, d];
  }
  return best;
}

/** Sum of PE open interest over sum of CE open interest; null when CE OI is 0. */
export function putCallRatio(rows: readonly OptionChainRowView[]): number | null {
  let ce = 0;
  let pe = 0;
  for (const r of rows) {
    ce += r.ce?.oi ?? 0;
    pe += r.pe?.oi ?? 0;
  }
  return ce > 0 ? round(pe / ce, 4) : null;
}

/**
 * The strike at which option holders' total intrinsic payout at expiry (OI-weighted, every strike) is
 * smallest; the lowest such strike on a tie, null without OI.
 */
export function maxPainStrike(rows: readonly OptionChainRowView[]): number | null {
  if (!rows.some((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0)) return null;
  let best: number | null = null;
  let bestPayout = Infinity;
  for (const settle of rows) {
    let payout = 0;
    for (const r of rows) {
      payout += (r.ce?.oi ?? 0) * Math.max(0, settle.strike - r.strike);
      payout += (r.pe?.oi ?? 0) * Math.max(0, r.strike - settle.strike);
    }
    if (payout < bestPayout) [best, bestPayout] = [settle.strike, payout];
  }
  return best;
}

/** The nearest listed expiry on or after today (IST), skipping today's once the session closes at 15:30. */
export function defaultExpiry(expiries: readonly string[], nowMs: number): string | null {
  const today = istDate(nowMs);
  const closed = istMinutes(nowMs) >= SESSION.close;
  return [...expiries].sort().find((e) => e > today || (e === today && !closed)) ?? null;
}

export interface ChainViewInput {
  index: IndexId;
  expiry: string;
  meta: OptionContractsMeta;
  chain: ParsedChain;
  fetchedMs: number;
  error?: string | null;
}

export function buildOptionChainView(i: ChainViewInput): OptionChainView {
  const { rows, spot } = i.chain;
  return {
    index: i.index,
    expiry: i.expiry,
    expiries: i.meta.expiries,
    lotSize: i.meta.lotSize,
    spot,
    atmStrike: atmStrike(rows, spot),
    pcr: putCallRatio(rows),
    maxPain: maxPainStrike(rows),
    rows,
    fetchedAt: istIso(i.fetchedMs),
    source: "upstox",
    error: i.error ?? null,
  };
}

/** The full-quote response's index levels, in UPSTOX_LIVE_INDEX_KEYS order; an index without a price is left out. */
export function parseUpstoxIndexLevels(payload: unknown): LiveIndexLevel[] {
  const byKey = upstoxEntriesByKey(payload);
  const out: LiveIndexLevel[] = [];
  for (const [key, instrumentKey] of UPSTOX_LIVE_INDEX_KEYS) {
    const e = byKey.get(instrumentKey);
    const price = pos(e?.last_price);
    if (!e || price === null) continue;
    const ohlc = rec(e.ohlc);
    const netChange = num(e.net_change);
    const prevClose = netChange !== null ? round(price - netChange, 2) : null;
    out.push({
      key,
      price,
      open: pos(ohlc?.open),
      high: pos(ohlc?.high),
      low: pos(ohlc?.low),
      prevClose,
      change: netChange !== null ? round(netChange, 2) : null,
      changePct: netChange !== null && prevClose !== null && prevClose > 0 ? round((netChange / prevClose) * 100, 2) : null,
    });
  }
  return out;
}

/** A short, token-free message for a failed fetch, for the views' `error`. */
export function upstoxFailureMessage(err: unknown): string {
  if (err instanceof UpstoxError) {
    if (err.kind === "rate_limited") return "Upstox rate limit (HTTP 429)";
    if (err.kind === "auth") return "Upstox rejected the token (HTTP 401): renew UPSTOX_ANALYTICS_TOKEN";
    return err.message.slice(0, 160);
  }
  return `Upstox: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
}

export interface UpstoxChainOptions {
  /** The Analytics Token (Worker secret UPSTOX_ANALYTICS_TOKEN). */
  token: string;
  /** Defaults to the global fetch. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Per request (default 8 s). */
  timeoutMs?: number;
}

/** The three read-only GETs behind the chain and the ticker. */
export class UpstoxChainClient {
  constructor(private readonly o: UpstoxChainOptions) {}

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    const qs = Object.entries(query)
      .map(([k, v]) => `${k}=${k === "instrument_key" ? v.split(",").map(encodeURIComponent).join(",") : encodeURIComponent(v)}`)
      .join("&");
    const init: RequestInit = {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.o.token}` },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8_000),
    };
    let res: Response;
    try {
      // Call the global fetch directly: a detached fetch loses its binding in Workers.
      res = this.o.fetch ? await this.o.fetch(`${UPSTOX_API_BASE}${path}?${qs}`, init) : await fetch(`${UPSTOX_API_BASE}${path}?${qs}`, init);
    } catch (err) {
      throw new UpstoxError(`Upstox GET ${path}: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
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
      throw new UpstoxError(`Upstox GET ${path}: HTTP ${res.status}${code ? ` ${code}` : ""}${message ? ` ${message.slice(0, 120)}` : ""}`, classifyUpstoxStatus(res.status), res.status, code);
    }
    if (rec(body)?.status !== "success") {
      throw new UpstoxError(`Upstox GET ${path}: status ${String(rec(body)?.status ?? "missing")}${code ? ` ${code}` : ""}`, "unknown", res.status, code);
    }
    return body;
  }

  async contracts(index: IndexId): Promise<OptionContractsMeta> {
    return parseUpstoxContracts(await this.get("/v2/option/contract", { instrument_key: UPSTOX_UNDERLYING_KEYS[index] }));
  }

  async chain(index: IndexId, expiry: string): Promise<ParsedChain> {
    return parseUpstoxChain(await this.get("/v2/option/chain", { instrument_key: UPSTOX_UNDERLYING_KEYS[index], expiry_date: expiry }));
  }

  async indexLevels(): Promise<LiveIndexLevel[]> {
    const keys = UPSTOX_LIVE_INDEX_KEYS.map(([, k]) => k).join(",");
    return parseUpstoxIndexLevels(await this.get("/v2/market-quote/quotes", { instrument_key: keys }));
  }
}
