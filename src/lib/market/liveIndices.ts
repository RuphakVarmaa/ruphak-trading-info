/**
 * Contract for the continuous index feed (GET /api/market/live): NIFTY 50 and SENSEX 1-minute
 * bars plus India VIX, refreshed every 1–2 s in market hours from one upstream poll per isolate.
 * Types and pure helpers only (safe in the browser); the route builds the payload.
 */

export type LiveIndexId = "NIFTY" | "SENSEX";

/** One 1-minute bar; `t` is the bar's open time in epoch ms. Index volume is always 0 on Yahoo. */
export interface LiveIndexBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface LiveIndex {
  index: LiveIndexId;
  /** "NIFTY 50" or "SENSEX". */
  label: string;
  /** Upstream symbol, e.g. "^NSEI". */
  symbol: string;
  price: number;
  /** The previous session's close (from the daily chart, calendar-checked); null when unknown. */
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Session VWAP of the 1-minute bars (typical price, equal weights: index volume is 0); null before the open. */
  vwap: number | null;
  /** 09:15–09:30 IST high and low; null until 09:30. */
  openingRange: { high: number; low: number } | null;
  /** IST date (YYYY-MM-DD) of the bars: the previous session before the open. */
  session: string;
  /** IST ISO time of the last trade the source reports. */
  asOf: string;
  /** Today's 1-minute bars, oldest first. */
  bars: LiveIndexBar[];
}

export interface LiveVix {
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** IST ISO time of the last value. */
  asOf: string;
}

export interface LiveIndicesFeed {
  /** NIFTY first, then SENSEX; only those that loaded (see `missing`). */
  indices: LiveIndex[];
  vix: LiveVix | null;
  /** Market phase by the exchange calendar at `generatedAt`. */
  marketPhase: "PRE_OPEN" | "OPEN" | "CLOSED" | "HOLIDAY";
  /** Human-readable source, e.g. "Yahoo Finance · about 1–2 min delayed". */
  source: string;
  /** ISO time the server built this payload. */
  generatedAt: string;
  /** ISO time of the upstream fetch this payload came from (shared cache). */
  fetchedAt: string;
  /** True when the upstream failed and the last good payload is being served. */
  stale: boolean;
  missing: LiveIndexId[];
}

/** Client poll interval while the market is open or in pre-open, and otherwise. */
export const LIVE_POLL_MS = 1500;
export const IDLE_POLL_MS = 30_000;
/** Feed age (since the last good response) at which the UI turns orange, then red. */
export const STALE_AFTER_MS = 10_000;
export const OFFLINE_AFTER_MS = 60_000;

export type Freshness = "loading" | "live" | "stale" | "offline";

/** Freshness of the feed from the browser time of the last good response. Pure. */
export function freshnessOf(lastOkAt: number | null, now: number | null): Freshness {
  if (lastOkAt == null || now == null) return "loading";
  const age = Math.max(0, now - lastOkAt);
  if (age <= STALE_AFTER_MS) return "live";
  if (age <= OFFLINE_AFTER_MS) return "stale";
  return "offline";
}
