/**
 * Metal and oil prices for the metals terminal: front-month futures from Yahoo Finance (works from
 * Cloudflare Workers, no key). Nothing here invents a price: a symbol Yahoo does not answer for is
 * listed in `missing`, and a board with no quotes at all is null.
 *
 * The daily chart (1d, 1mo) gives the price, today's range and the sparkline. The previous settlement
 * comes from the 5-minute chart's `meta.previousClose` (5m, 1d): the daily history can be missing a
 * session (PL=F had no 2026-10-07 bar) or come from a thin contract (SI=F's 10-07 daily close was
 * 59.899 while the front month traded 60.19-60.29 at the settlement and settled 60.294). Without it, the
 * daily chart's previous bar is used, but never across a missing weekday (that would be a two-session change).
 * (Not for ^NSEI: there Yahoo's 1-day meta.previousClose is the stale one.)
 */
import type { YahooChart } from "@/engine/market/yahooClient";
import { fetchYahooChart } from "@/engine/market/yahooClient";

export type CommodityKey = "GOLD" | "SILVER" | "PLATINUM" | "COPPER" | "WTI" | "BRENT";

export interface CommoditySpec {
  key: CommodityKey;
  name: string;
  /** Yahoo symbol of the front-month future. */
  symbol: string;
  unit: string;
  /** Decimals to show. */
  decimals: number;
}

export const COMMODITIES: CommoditySpec[] = [
  { key: "GOLD", name: "Gold", symbol: "GC=F", unit: "$/oz", decimals: 2 },
  { key: "SILVER", name: "Silver", symbol: "SI=F", unit: "$/oz", decimals: 2 },
  { key: "PLATINUM", name: "Platinum", symbol: "PL=F", unit: "$/oz", decimals: 2 },
  { key: "COPPER", name: "Copper", symbol: "HG=F", unit: "$/lb", decimals: 3 },
  { key: "WTI", name: "WTI crude", symbol: "CL=F", unit: "$/bbl", decimals: 2 },
  { key: "BRENT", name: "Brent crude", symbol: "BZ=F", unit: "$/bbl", decimals: 2 },
];

export interface CommodityQuote {
  key: CommodityKey;
  name: string;
  symbol: string;
  unit: string;
  decimals: number;
  price: number;
  /** Previous session's settlement; null when it is not known for sure. */
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** The current session's range; null when Yahoo has no bar for it yet. */
  dayHigh: number | null;
  dayLow: number | null;
  /** ISO UTC time of the last trade Yahoo reports (else of the last daily bar). */
  asOf: string;
  /** Daily closes, oldest first, ending with the current price: up to 22 points, for a sparkline. */
  closes: number[];
}

export interface CommodityBoard {
  /** In COMMODITIES order. */
  quotes: CommodityQuote[];
  /** Commodities Yahoo did not return a price for in this refresh. */
  missing: CommodityKey[];
  source: string;
  generatedAt: string;
  /** True when the refresh failed and this is the previous board (see generatedAt for its age). */
  stale: boolean;
}

export const COMMODITY_SOURCE = "Yahoo Finance · front-month futures, may be delayed";

/** The last daily bar is the current session when its close is within 0.05% of Yahoo's last price. */
const SAME_SESSION_TOLERANCE = 0.0005;
const MAX_CLOSES = 22;
/** Open pages share one Yahoo refresh per minute (this isolate's memory only). */
const FRESH_MS = 60_000;
/** When a refresh loads nothing, the previous board is served for up to 15 minutes, marked stale. */
const STALE_OK_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

/** Rounds away float32 noise in Yahoo's bars (4140.7001953125 -> 4140.7); one decimal past `decimals` keeps every tick. */
function rounder(decimals: number): (x: number) => number {
  const f = 10 ** (decimals + 1);
  return (x) => Math.round(x * f) / f;
}

/** True when a weekday falls strictly between two YYYY-MM-DD dates (a session is missing; weekends are not). Pure. */
export function hasSessionGap(prevDate: string, nextDate: string): boolean {
  const end = Date.parse(`${nextDate}T00:00:00Z`);
  for (let t = Date.parse(`${prevDate}T00:00:00Z`) + DAY_MS; t < end; t += DAY_MS) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) return true;
  }
  return false;
}

/**
 * One commodity's quote from its daily chart, or null when the chart has no price. Pure.
 * `settle` is the previous settlement from the 5-minute chart's meta.previousClose; when it is missing,
 * the daily chart's previous bar is used unless a weekday is missing before the session (then null).
 */
export function buildCommodityQuote(spec: CommoditySpec, chart: YahooChart, settle: number | null = null): CommodityQuote | null {
  const bars = chart.candles.filter((c) => c.c > 0);
  const last = bars[bars.length - 1];
  const live = chart.meta.regularMarketPrice;
  const price = live != null && live > 0 ? live : last?.c;
  if (price === undefined || !(price > 0)) return null;
  const r = rounder(spec.decimals);
  const ms = chart.meta.regularMarketTime != null ? chart.meta.regularMarketTime * 1000 : (last?.t ?? null);
  if (ms === null) return null;

  // Exchange-local dates: bars are stamped at exchange midnight (rounding absorbs a DST hour), trades at their time.
  const off = (chart.meta.gmtoffset ?? 0) * 1000;
  const barDate = (t: number) => new Date(Math.round((t + off) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  const tradeDate = (t: number) => new Date(t + off).toISOString().slice(0, 10);

  let dailyPrev: number | null = null;
  let gap = false;
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  let history: number[] = [];
  if (last && Math.abs(last.c - price) / price < SAME_SESSION_TOLERANCE) {
    // The last bar is today's session (its close is the live price).
    const before = bars[bars.length - 2];
    dailyPrev = before ? before.c : null;
    gap = before !== undefined && hasSessionGap(barDate(before.t), barDate(last.t));
    dayHigh = Math.max(last.h, price);
    dayLow = Math.min(last.l, price);
    history = bars.slice(0, -1).map((c) => c.c);
  } else if (last) {
    // Yahoo has no bar for the current session yet: the last bar is the previous session.
    dailyPrev = last.c;
    gap = hasSessionGap(barDate(last.t), tradeDate(ms));
    history = bars.map((c) => c.c);
  }
  const prevClose = settle != null && Number.isFinite(settle) && settle > 0 ? settle : gap ? null : dailyPrev;

  const p = r(price);
  const prev = prevClose != null ? r(prevClose) : null;
  return {
    key: spec.key,
    name: spec.name,
    symbol: spec.symbol,
    unit: spec.unit,
    decimals: spec.decimals,
    price: p,
    prevClose: prev,
    change: prev != null ? r(p - prev) : null,
    changePct: prev ? Math.round(((p - prev) / prev) * 100_000) / 1000 : null,
    dayHigh: dayHigh != null ? r(dayHigh) : null,
    dayLow: dayLow != null ? r(dayLow) : null,
    asOf: new Date(ms).toISOString(),
    closes: last ? [...history.slice(-(MAX_CLOSES - 1)).map(r), p] : [],
  };
}

let cache: { at: number; board: CommodityBoard } | null = null;

/** Clears this module's board cache (tests only). */
export function __resetCommodityCacheForTests(): void {
  cache = null;
}

/** One symbol: its daily chart, with the previous settlement from the 5-minute chart when Yahoo gives it. */
async function loadQuote(spec: CommoditySpec, fetchImpl: typeof fetch | undefined): Promise<CommodityQuote | null> {
  const [daily, intraday] = await Promise.allSettled([
    fetchYahooChart(spec.symbol, { interval: "1d", range: "1mo", timeoutMs: 8000, fetchImpl }),
    fetchYahooChart(spec.symbol, { interval: "5m", range: "1d", timeoutMs: 8000, fetchImpl }),
  ]);
  if (daily.status === "rejected") return null;
  return buildCommodityQuote(spec, daily.value, intraday.status === "fulfilled" ? intraday.value.meta.previousClose : null);
}

/**
 * All six quotes, refreshed at most once a minute. Symbols that fail are listed in `missing`.
 * When nothing loads, the previous board (up to 15 minutes old) comes back with `stale: true`; else null.
 */
export async function fetchCommodityBoard(opts: { fetchImpl?: typeof fetch; nowMs?: number } = {}): Promise<CommodityBoard | null> {
  const nowMs = opts.nowMs ?? Date.now();
  if (cache && nowMs - cache.at < FRESH_MS) return cache.board;

  const loaded = await Promise.all(COMMODITIES.map((spec) => loadQuote(spec, opts.fetchImpl).catch(() => null)));
  const quotes: CommodityQuote[] = [];
  const missing: CommodityKey[] = [];
  COMMODITIES.forEach((spec, i) => {
    const quote = loaded[i];
    if (quote) quotes.push(quote);
    else missing.push(spec.key);
  });

  if (quotes.length === 0) {
    if (cache && nowMs - cache.at < STALE_OK_MS) return { ...cache.board, stale: true };
    return null;
  }
  const board: CommodityBoard = { quotes, missing, source: COMMODITY_SOURCE, generatedAt: new Date(nowMs).toISOString(), stale: false };
  cache = { at: nowMs, board };
  return board;
}
