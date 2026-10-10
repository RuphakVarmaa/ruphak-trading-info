/**
 * Groww market data and portfolio reads: index/option LTP, quotes with depth, option chain,
 * historical candles (naive timestamps are IST), expiries/contracts, positions and margins.
 * Runs over any GrowwTransport: direct (GrowwHttp) or the relay's read-only data proxy.
 */
import { istAt } from "../../clock";
import type { OptionChainRow } from "../../ports";
import type { Candle, Exchange, FeatureIndexId, Level, Quote } from "../../types";
import type { GrowwTransport } from "./http";

type Rec = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);

/** Groww exchange symbols for the index LTP call. */
export const INDEX_LTP_SYMBOLS: Record<FeatureIndexId, string> = {
  NIFTY: "NSE_NIFTY",
  SENSEX: "BSE_SENSEX",
  BANKNIFTY: "NSE_BANKNIFTY",
};

/** Parses a Groww timestamp: epoch s/ms, ISO with offset, or naive "YYYY-MM-DD[T ]HH:mm[:ss]" in IST. */
export function parseGrowwTime(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n < 1e12 ? n * 1000 : n;
  const s = str(v)?.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return istAt(m[1], `${m[2] ?? "00"}:${m[3] ?? "00"}`) + Number(m[4] ?? 0) * 1000;
}

function levels(v: unknown): Level[] {
  if (!Array.isArray(v)) return [];
  const out: Level[] = [];
  for (const l of v) {
    const r = rec(l);
    const price = num(r?.price);
    const qty = num(r?.quantity ?? r?.qty);
    if (price !== null && qty !== null && price > 0 && qty > 0) out.push({ price, qty });
  }
  return out;
}

/**
 * Maps /live-data/quote's payload to an engine Quote. `t` is the fetch time: bid/ask are current.
 * `iv` is in percent, like every Quote (the planner divides it by 100): Groww's implied_volatility is
 * read as percent above 3 and as a decimal at or below it.
 */
export function parseQuote(symbol: string, payload: unknown, fetchedMs: number): Quote {
  const p = rec(payload) ?? {};
  const depth = rec(p.depth);
  const buy = levels(depth?.buy);
  const sell = levels(depth?.sell);
  const bid = num(p.bid_price) ?? buy[0]?.price ?? 0;
  const ask = num(p.offer_price) ?? sell[0]?.price ?? 0;
  const ivRaw = num(p.implied_volatility);
  const q: Quote = {
    symbol,
    t: fetchedMs,
    ltp: num(p.last_price) ?? 0,
    bid,
    ask,
    bidQty: num(p.bid_quantity) ?? buy[0]?.qty ?? 0,
    askQty: num(p.offer_quantity) ?? sell[0]?.qty ?? 0,
    source: "groww",
  };
  if (buy.length > 0 || sell.length > 0) q.depth = { buy, sell };
  if (ivRaw !== null && ivRaw > 0) q.iv = ivRaw > 3 ? ivRaw : ivRaw * 100;
  const oi = num(p.open_interest);
  if (oi !== null) q.oi = oi;
  const vol = num(p.volume);
  if (vol !== null) q.volume = vol;
  return q;
}

/** Maps /option-chain's payload to rows (iv as a decimal). */
export function parseOptionChain(payload: unknown): { underlyingLtp: number; rows: OptionChainRow[] } {
  const p = rec(payload) ?? {};
  const strikes = rec(p.strikes) ?? {};
  const rows: OptionChainRow[] = [];
  for (const [k, v] of Object.entries(strikes)) {
    const strike = num(k);
    const byType = rec(v);
    if (strike === null || !byType) continue;
    for (const type of ["CE", "PE"] as const) {
      const leg = rec(byType[type]);
      if (!leg) continue;
      const greeks = rec(leg.greeks);
      const iv = num(greeks?.iv);
      rows.push({
        strike,
        type,
        tradingSymbol: str(leg.trading_symbol) ?? "",
        ltp: num(leg.ltp),
        oi: num(leg.open_interest),
        iv: iv === null ? null : iv > 3 ? iv / 100 : iv,
        delta: num(greeks?.delta),
      });
    }
  }
  rows.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  return { underlyingLtp: num(p.underlying_ltp) ?? 0, rows };
}

/** Maps /historical/candles' payload ([ts, o, h, l, c, v, oi] rows) to candles sorted by time. */
export function parseHistoricalCandles(payload: unknown): Candle[] {
  const p = rec(payload);
  const raw = Array.isArray(p?.candles) ? (p.candles as unknown[]) : Array.isArray(payload) ? (payload as unknown[]) : [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = parseGrowwTime(row[0]);
    const o = num(row[1]);
    const h = num(row[2]);
    const l = num(row[3]);
    const c = num(row[4]);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    const candle: Candle = { t, o, h, l, c, v: num(row[5]) ?? 0 };
    const oi = num(row[6]);
    if (oi !== null) candle.oi = oi;
    out.push(candle);
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((c, i) => i === 0 || c.t !== out[i - 1].t);
}

export interface GrowwPosition {
  tradingSymbol: string;
  exchange: string | null;
  product: string | null;
  /** Net quantity: long positive, short negative. */
  qty: number;
  avgPrice: number;
  realisedPnl: number | null;
}

export function parsePositions(payload: unknown): GrowwPosition[] {
  const p = rec(payload);
  const raw = Array.isArray(p?.positions) ? (p.positions as unknown[]) : Array.isArray(payload) ? (payload as unknown[]) : [];
  const out: GrowwPosition[] = [];
  for (const item of raw) {
    const r = rec(item);
    const sym = str(r?.trading_symbol);
    if (!r || !sym) continue;
    const qty = num(r.quantity) ?? (num(r.credit_quantity) ?? 0) - (num(r.debit_quantity) ?? 0);
    out.push({
      tradingSymbol: sym,
      exchange: str(r.exchange),
      product: str(r.product),
      qty,
      avgPrice: num(r.net_price) ?? 0,
      realisedPnl: num(r.realised_pnl),
    });
  }
  return out;
}

const fmtIst = (ms: number): string => {
  const d = new Date(ms + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

export type CandleInterval = "1minute" | "5minute" | "10minute" | "15minute" | "30minute" | "1hour" | "1day";

export class GrowwDataClient {
  constructor(
    private readonly http: GrowwTransport,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** LTP by exchange symbol ("NSE_NIFTY", "NSE_NIFTY26O1322600CE"), up to 50 per call. */
  async ltp(segment: "CASH" | "FNO", exchangeSymbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (let i = 0; i < exchangeSymbols.length; i += 50) {
      const chunk = exchangeSymbols.slice(i, i + 50);
      const payload = await this.http.request<Rec>("GET", "/live-data/ltp", {
        query: { segment, exchange_symbols: chunk.join(",") },
        category: "live",
      });
      for (const [k, v] of Object.entries(rec(payload) ?? {})) {
        const n = num(v) ?? num(rec(v)?.ltp);
        if (n !== null && n > 0) out[k] = n;
      }
    }
    return out;
  }

  /** Index spot (NIFTY, SENSEX, BANKNIFTY) for decision-time pricing. */
  async indexLtp(): Promise<Partial<Record<FeatureIndexId, number>>> {
    const res = await this.ltp("CASH", Object.values(INDEX_LTP_SYMBOLS));
    const out: Partial<Record<FeatureIndexId, number>> = {};
    for (const [id, sym] of Object.entries(INDEX_LTP_SYMBOLS) as [FeatureIndexId, string][]) {
      if (res[sym] !== undefined) out[id] = res[sym];
    }
    return out;
  }

  async quote(exchange: Exchange, segment: "CASH" | "FNO", tradingSymbol: string): Promise<Quote> {
    const payload = await this.http.request<unknown>("GET", "/live-data/quote", {
      query: { exchange, segment, trading_symbol: tradingSymbol },
      category: "live",
    });
    return parseQuote(tradingSymbol, payload, this.now());
  }

  async optionChain(exchange: Exchange, underlying: string, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }> {
    const payload = await this.http.request<unknown>(
      "GET",
      `/option-chain/exchange/${encodeURIComponent(exchange)}/underlying/${encodeURIComponent(underlying)}`,
      { query: { expiry_date: expiry }, category: "live" },
    );
    return parseOptionChain(payload);
  }

  /** Historical candles; Groww caps a 1-5 minute request at 30 days, so callers chunk ranges. */
  async historicalCandles(o: {
    exchange: Exchange;
    segment: "CASH" | "FNO";
    growwSymbol: string;
    startMs: number;
    endMs: number;
    interval: CandleInterval;
  }): Promise<Candle[]> {
    const payload = await this.http.request<unknown>("GET", "/historical/candles", {
      query: {
        exchange: o.exchange,
        segment: o.segment,
        groww_symbol: o.growwSymbol,
        start_time: fmtIst(o.startMs),
        end_time: fmtIst(o.endMs),
        candle_interval: o.interval,
      },
      category: "nontrading",
      timeoutMs: 30_000,
    });
    return parseHistoricalCandles(payload);
  }

  async historicalExpiries(exchange: Exchange, underlying: string, year: number, month?: number): Promise<string[]> {
    const payload = await this.http.request<Rec>("GET", "/historical/expiries", {
      query: { exchange, underlying_symbol: underlying, year, month },
      category: "nontrading",
    });
    const list = Array.isArray(rec(payload)?.expiries) ? (rec(payload)!.expiries as unknown[]) : [];
    return list.filter((e): e is string => typeof e === "string").sort();
  }

  async historicalContracts(exchange: Exchange, underlying: string, expiry: string): Promise<string[]> {
    const payload = await this.http.request<Rec>("GET", "/historical/contracts", {
      query: { exchange, underlying_symbol: underlying, expiry_date: expiry },
      category: "nontrading",
    });
    const list = Array.isArray(rec(payload)?.contracts) ? (rec(payload)!.contracts as unknown[]) : [];
    return list.filter((e): e is string => typeof e === "string");
  }

  async positions(segment: "CASH" | "FNO" = "FNO"): Promise<GrowwPosition[]> {
    return parsePositions(await this.http.request<unknown>("GET", "/positions/user", { query: { segment }, category: "nontrading" }));
  }

  async margins(): Promise<Rec | null> {
    return rec(await this.http.request<unknown>("GET", "/margins/detail/user", { category: "nontrading" }));
  }
}
