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
  /** The source's last price (2 decimals). */
  price: number;
  /**
   * Close of the trading day before the last price's day (from the daily chart, calendar-checked); null
   * when unknown. Never the 1-minute chart's meta.previousClose, which can be two sessions old.
   */
  prevClose: number | null;
  /** price - prevClose (2 decimals); null without a previous close. */
  change: number | null;
  /** Percent (3 decimals); null without a previous close. */
  changePct: number | null;
  /** Open of the session's first 1-minute bar. */
  open: number | null;
  /** The session's high and low as the source reports them for the day (bars' extremes when it does not). */
  high: number | null;
  low: number | null;
  /**
   * VWAP of `bars` (running mean of the typical price, equal weights: index volume is 0); null while the
   * session has no bars. Before the open it is the previous session's, like the bars.
   */
  vwap: number | null;
  /** High and low of the session's 09:15–09:29 bars; null until a bar at or after 09:30 IST is in. */
  openingRange: { high: number; low: number } | null;
  /** IST date (YYYY-MM-DD) of the bars: the previous session before the open. */
  session: string;
  /** IST ISO time of the last trade the source reports. */
  asOf: string;
  /** The session's 1-minute bars from 09:15 through the 15:30 closing print, oldest first. */
  bars: LiveIndexBar[];
  /**
   * True when this symbol failed in the latest upstream fetch and its last good value (at most two
   * minutes old, see `fetchedAt`) is served instead. Absent means false.
   */
  stale?: boolean;
  /** ISO time of the upstream fetch this entry came from. */
  fetchedAt?: string;
  /**
   * Set only in a `?since=` update: `bars` then holds just the bars from this time (epoch ms) on, and the
   * earlier ones are unchanged (see mergeBars). useLiveIndices merges them, so its data never carries it.
   */
  barsFrom?: number;
}

export interface LiveVix {
  price: number;
  /** Close of the trading day before the last value's day (daily chart, calendar-checked); null when unknown. */
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** IST ISO time of the last value. */
  asOf: string;
  /** As on LiveIndex: the last good value served after a failed fetch. Absent means false. */
  stale?: boolean;
  /** ISO time of the upstream fetch this value came from. */
  fetchedAt?: string;
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
  /** Indices with no price in this payload (failed, and no good value in the last two minutes). */
  missing: LiveIndexId[];
  /** Why the exchange is shut today ("Dussehra", "Weekend") when marketPhase is HOLIDAY. */
  holidayName?: string | null;
  /** IST ISO time of the next session open (09:15) by the exchange calendar. */
  nextOpenAt?: string;
}

/** Client poll interval while the market is open or in pre-open, and otherwise. */
export const LIVE_POLL_MS = 1500;
export const IDLE_POLL_MS = 30_000;
/** Feed age (since the last good response) at which the UI turns orange, then red. */
export const STALE_AFTER_MS = 10_000;
export const OFFLINE_AFTER_MS = 60_000;

export type Freshness = "loading" | "live" | "stale" | "offline";

/**
 * Freshness of the feed from the browser time of the last good response. Pure. `pollMs` is the poll
 * interval in force: a slower poll moves both thresholds out by the extra wait, so a 30 s idle poll
 * does not read as stale between its own polls (default: the 1.5 s live poll, the plain thresholds).
 */
export function freshnessOf(lastOkAt: number | null, now: number | null, pollMs: number = LIVE_POLL_MS): Freshness {
  if (lastOkAt == null || now == null) return "loading";
  const age = Math.max(0, now - lastOkAt);
  const slack = Math.max(0, pollMs - LIVE_POLL_MS);
  if (age <= STALE_AFTER_MS + slack) return "live";
  if (age <= OFFLINE_AFTER_MS + slack) return "stale";
  return "offline";
}

/** The client poll interval for a payload's market phase. */
export const pollIntervalFor = (phase: LiveIndicesFeed["marketPhase"]): number => (phase === "OPEN" || phase === "PRE_OPEN" ? LIVE_POLL_MS : IDLE_POLL_MS);

/** A bar's typical price, (high + low + close) / 3. */
export const typicalPrice = (b: LiveIndexBar): number => (b.h + b.l + b.c) / 3;

/**
 * Running session VWAP at each bar's close: the mean typical price so far. Yahoo reports index volume
 * as 0, so every bar weighs the same (as the engine's VWAP does without volume). Pure.
 */
export function runningVwap(bars: readonly LiveIndexBar[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += typicalPrice(bars[i]);
    out.push(sum / (i + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Updates: a poll can ask for the bars since a time instead of the whole session (a few hundred bytes
// instead of ~50 KB every 1.5 s); the client merges them into what it has.
// ---------------------------------------------------------------------------

/** How far back an update re-sends bars, so a bar Yahoo revises after the fact is picked up. */
export const SINCE_OVERLAP_MS = 5 * 60_000;

/** IST date (YYYY-MM-DD) of an instant. */
const istDateOfMs = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/** The `since` to ask with after `feed` (its last bars minus the overlap); null to ask for everything. Pure. */
export function sinceFor(feed: LiveIndicesFeed | null): number | null {
  if (!feed || feed.indices.length === 0 || feed.missing.length > 0) return null;
  const lasts = feed.indices.map((i) => i.bars[i.bars.length - 1]?.t);
  if (lasts.some((t) => t == null)) return null;
  return Math.min(...(lasts as number[])) - SINCE_OVERLAP_MS;
}

/** Server side: each index of the same IST day as `since` keeps only its bars from `since` on (marked barsFrom). Pure. */
export function barsSince(feed: LiveIndicesFeed, since: number): LiveIndicesFeed {
  const day = istDateOfMs(since);
  return { ...feed, indices: feed.indices.map((i) => (i.session === day ? { ...i, bars: i.bars.filter((b) => b.t >= since), barsFrom: since } : i)) };
}

/**
 * Client side: `next` with every `since` update joined to the earlier bars of `prev`. Null when an index
 * cannot be joined (no earlier bars of that session): ask for the whole feed instead. Pure.
 */
export function mergeBars(prev: LiveIndicesFeed | null, next: LiveIndicesFeed): LiveIndicesFeed | null {
  if (next.indices.every((i) => i.barsFrom == null)) return next;
  const indices: LiveIndex[] = [];
  for (const entry of next.indices) {
    const { barsFrom, ...rest } = entry;
    if (barsFrom == null) {
      indices.push(entry);
      continue;
    }
    const before = prev?.indices.find((i) => i.index === entry.index);
    if (!before || before.session !== entry.session) return null;
    indices.push({ ...rest, bars: [...before.bars.filter((b) => b.t < barsFrom), ...entry.bars] });
  }
  return { ...next, indices };
}

/** Epoch ms of an IST wall-clock time ("HH:MM") on a YYYY-MM-DD date. */
export const istTimeOn = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+05:30`);

/**
 * High and low of the session's 09:15–09:29 bars once a bar at or after 09:30 IST exists (from then on
 * those bars are final); null before that, or without a bar in the window. Pure.
 */
export function openingRangeOf(bars: readonly LiveIndexBar[], session: string): { high: number; low: number } | null {
  const start = istTimeOn(session, "09:15");
  const end = istTimeOn(session, "09:30");
  const window = bars.filter((b) => b.t >= start && b.t < end);
  if (window.length === 0 || !bars.some((b) => b.t >= end)) return null;
  return { high: Math.max(...window.map((b) => b.h)), low: Math.min(...window.map((b) => b.l)) };
}
