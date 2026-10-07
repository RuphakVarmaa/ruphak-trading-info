/**
 * Candle helpers: session filtering, point-in-time slicing, resampling.
 * All candle arrays are sorted ascending by bar OPEN time `t` (epoch ms) unless noted.
 * IST arithmetic is done with integers (no Date objects) because these run per bar in backtests.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { DAY_MS, IST_OFFSET_MS, MINUTE_MS, SESSION, istAt, istDate, istMidnight } from "../clock";
import type { Candle } from "../types";

export const BAR_5M_MS = 5 * MINUTE_MS;

/** Days since 1970-01-01 in IST (integer). */
export function istDayIndex(t: number): number {
  return Math.floor((t + IST_OFFSET_MS) / DAY_MS);
}

/** Minutes since IST midnight (seconds dropped). */
export function istMinuteOfDay(t: number): number {
  const msOfDay = (((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.floor(msOfDay / MINUTE_MS);
}

const dateByDayIndex = new Map<number, string>();

/** IST date (YYYY-MM-DD) of an instant, memoized per day. */
export function istDateOf(t: number): string {
  const idx = istDayIndex(t);
  let d = dateByDayIndex.get(idx);
  if (d === undefined) {
    d = istDate(idx * DAY_MS - IST_OFFSET_MS + 12 * 60 * MINUTE_MS);
    dateByDayIndex.set(idx, d);
  }
  return d;
}

const tradingDayCache = new WeakMap<TradingCalendar, Map<string, boolean>>();

/** calendar.isTradingDay with a per-calendar memo (calendars are immutable). */
export function isTradingDayCached(calendar: TradingCalendar, date: string): boolean {
  let m = tradingDayCache.get(calendar);
  if (!m) {
    m = new Map();
    tradingDayCache.set(calendar, m);
  }
  let v = m.get(date);
  if (v === undefined) {
    v = calendar.isTradingDay(date);
    m.set(date, v);
  }
  return v;
}

/** Bars whose open time lies in [09:15, 15:30) IST on a trading day (drops Yahoo's 15:30 closing tick). */
export function sessionBars(candles: Candle[], calendar: TradingCalendar): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const m = istMinuteOfDay(c.t);
    if (m < SESSION.open || m >= SESSION.close) continue;
    if (!isTradingDayCached(calendar, istDateOf(c.t))) continue;
    out.push(c);
  }
  return out;
}

/** Bars already closed at `t`: c.t + barMs <= t. Order is preserved. */
export function closedBars(candles: Candle[], t: number, barMs: number): Candle[] {
  return candles.filter((c) => c.t + barMs <= t);
}

/** Bars whose open time falls on the given IST date. */
export function barsOnDate(candles: Candle[], date: string): Candle[] {
  const lo = istMidnight(date);
  const hi = lo + DAY_MS;
  return candles.filter((c) => c.t >= lo && c.t < hi);
}

/** Ascending unique IST dates of the bars' open times. */
export function sessionDates(candles: Candle[]): string[] {
  const days = new Set<number>();
  for (const c of candles) days.add(istDayIndex(c.t));
  return [...days].sort((a, b) => a - b).map((d) => istDateOf(d * DAY_MS - IST_OFFSET_MS));
}

/** Groups bars by IST date (insertion order follows the input). */
export function groupByDate(candles: Candle[]): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();
  for (const c of candles) {
    const d = istDateOf(c.t);
    const arr = out.get(d);
    if (arr) arr.push(c);
    else out.set(d, [c]);
  }
  return out;
}

function aggregate(t: number, bars: Candle[]): Candle {
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  for (const b of bars) {
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    v += Number.isFinite(b.v) ? b.v : 0;
  }
  const last = bars[bars.length - 1];
  const out: Candle = { t, o: bars[0].o, h, l, c: last.c, v };
  if (last.oi !== undefined) out.oi = last.oi;
  return out;
}

/**
 * Aggregates bars into `minutes`-long buckets aligned to 09:15 IST of each day
 * (09:15, 09:15+m, ...). Bars before 09:15 fall into buckets that end at 09:15.
 */
export function resample(candles: Candle[], minutes: number): Candle[] {
  if (!(minutes > 0)) return candles.slice();
  const bucketMs = minutes * MINUTE_MS;
  const buckets = new Map<number, Candle[]>();
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    const dayStart = istDayIndex(c.t) * DAY_MS - IST_OFFSET_MS;
    const anchor = dayStart + SESSION.open * MINUTE_MS;
    const start = anchor + Math.floor((c.t - anchor) / bucketMs) * bucketMs;
    const arr = buckets.get(start);
    if (arr) arr.push(c);
    else buckets.set(start, [c]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, bars]) => aggregate(t, bars));
}

/** One bar per IST date, stamped at that day's 09:15 IST. */
export function dailyFromIntraday(candles: Candle[]): Candle[] {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const [date, bars] of groupByDate(sorted)) out.push(aggregate(istAt(date, SESSION.open), bars));
  return out.sort((a, b) => a.t - b.t);
}

/** Union by open time; bars from `b` replace bars from `a` with the same `t`. Sorted ascending. */
export function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of a) m.set(c.t, c);
  for (const c of b) m.set(c.t, c);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/**
 * Cache update for a fresh download: bars of `old` before the first fresh bar are kept, everything from
 * there on is replaced by `fresh` (so bars Yahoo revised or dropped do not linger). Empty `fresh` keeps `old`.
 */
export function spliceCandles(old: Candle[], fresh: Candle[]): Candle[] {
  if (fresh.length === 0) return old;
  const next = normalizeCandles(fresh);
  const from = next[0].t;
  const kept = old.filter((c) => c.t < from);
  return kept.length > 0 ? [...kept, ...next] : next;
}

/** Sorts ascending and removes duplicate open times (the later element wins). Returns a new array. */
export function normalizeCandles(candles: Candle[]): Candle[] {
  return mergeCandles([], candles);
}

/** Index of the last bar with open time <= t (binary search on a sorted array), -1 if none. */
export function lastIndexAtOrBefore(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Last bar whose OPEN time is <= t, or null. */
export function lastAtOrBefore(candles: Candle[], t: number): Candle | null {
  const i = lastIndexAtOrBefore(candles, t);
  return i >= 0 ? candles[i] : null;
}
