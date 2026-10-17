/**
 * WP15 research helpers (reports/wp15-overnight-drift.md; research only, nothing in the live engine
 * imports this): the nights between consecutive regular sessions and their calendar kind, the
 * night filters known at the entry (weekday, after a down day, after a sell-off), the fair-coin
 * random side of a one-sided strategy, tail statistics (value at risk and expected shortfall) and
 * what a stop can and cannot do when a price gaps through it overnight. Every definition is frozen
 * in the report's §1.
 *
 * Pure and web-standard (no node: imports), like intraday1m.ts and expiryCalendar.ts.
 */
import type { PairedDay } from "./intraday1m";

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const utcMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** ISO weekday of a YYYY-MM-DD date: 1 = Monday … 7 = Sunday. */
const isoWeekday = (d: string) => ((new Date(utcMs(d)).getUTCDay() + 6) % 7) + 1;

/** Whole calendar days from `d` to `e` (e − d). */
export function calendarDays(d: string, e: string): number {
  return Math.round((utcMs(e) - utcMs(d)) / DAY_MS);
}

/**
 * Calendar kind of the night from session `d` to the next session `e`: "weekday" when `e` is the
 * next calendar day; "weekend" when every day strictly between is a Saturday or a Sunday; "holiday"
 * when a weekday without a session lies between them (with or without a weekend).
 */
export type NightKind = "weekday" | "weekend" | "holiday";

export function nightKind(d: string, e: string): NightKind {
  const n = calendarDays(d, e);
  if (!(n > 0)) throw new Error(`night ${d} → ${e} does not move forward`);
  if (n === 1) return "weekday";
  for (let i = 1; i < n; i++) if (isoWeekday(isoOf(utcMs(d) + i * DAY_MS)) <= 5) return "holiday";
  return "weekend";
}

export interface Night {
  /** The regular session whose close starts the night. */
  d: string;
  /** The next regular session, whose open ends it. */
  e: string;
  kind: NightKind;
  calendarDays: number;
  /** Special sessions (a Muhurat or weekend session, a short DR drill) between d and e: such a night holds trading, not just a gap. */
  spans: string[];
}

/**
 * The nights between consecutive regular sessions of a calendar. `sessions` is every session (regular
 * and special) in any order; a session is special when `isSpecial` says so. A special session is never
 * the start or the end of a night; one lying between two regular sessions is listed in `spans`.
 */
export function nightsBetween(sessions: Iterable<string>, isSpecial: (d: string) => boolean): Night[] {
  const all = [...new Set(sessions)].sort();
  const out: Night[] = [];
  let prev: string | null = null;
  let spans: string[] = [];
  for (const s of all) {
    if (isSpecial(s)) {
      if (prev !== null) spans.push(s);
      continue;
    }
    if (prev !== null) out.push({ d: prev, e: s, kind: nightKind(prev, s), calendarDays: calendarDays(prev, s), spans });
    prev = s;
    spans = [];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Night filters (what is known when the position is opened)
// ---------------------------------------------------------------------------

/**
 * all: every night; weekday: the next session is the next calendar day; weekend: a weekend or holiday
 * night; down / up: the index below / above the previous session's close at the entry; selloff: at
 * least `selloff` below it (a negative fraction, −0.01 = a 1% fall).
 */
export type NightFilter = "all" | "weekday" | "weekend" | "down" | "up" | "selloff";

export function passesFilter(f: NightFilter, n: { kind: NightKind; change: number | null }, selloff = -0.01): boolean {
  switch (f) {
    case "all":
      return true;
    case "weekday":
      return n.kind === "weekday";
    case "weekend":
      return n.kind !== "weekday";
    case "down":
      return n.change !== null && n.change < 0;
    case "up":
      return n.change !== null && n.change > 0;
    case "selloff":
      return n.change !== null && n.change <= selloff;
  }
}

/** Whether a filter needs the change from the previous close (a night without one is not eligible for it). */
export const needsChange = (f: NightFilter): boolean => f === "down" || f === "up" || f === "selloff";

// ---------------------------------------------------------------------------
// The fair-coin random side of a one-sided strategy
// ---------------------------------------------------------------------------

/**
 * A strategy that always takes one side (always the call, always long) cannot be compared with a random
 * side drawn at its own share of that side: the placebo would be the strategy. Its placebo is a fair
 * coin between the side it takes (`s`) and the opposite side (`o`) at the same minutes, whose exact
 * expectation is (s + o) / 2; the gap s − (s + o) / 2 = (s − o) / 2 is what choosing the side adds.
 * One PairedDay per session, for pairedGap.
 */
export function fairCoinDays(rows: readonly { s: number; o: number }[]): PairedDay[] {
  return rows.map((r) => ({ n: 1, s: r.s, p: (r.s + r.o) / 2 }));
}

// ---------------------------------------------------------------------------
// Tails
// ---------------------------------------------------------------------------

/**
 * The worst `q` share of a P&L series (at least one value): `count` = max(1, ⌊q·n⌋) values, the value
 * at risk `var` (the count-th worst value: no worse night was outside the tail) and the expected
 * shortfall `es` (the mean of the `count` worst values). NaN for an empty series.
 */
export function tailRisk(xs: readonly number[], q: number): { count: number; var: number; es: number } {
  if (xs.length === 0) return { count: 0, var: NaN, es: NaN };
  const sorted = [...xs].sort((a, b) => a - b);
  const count = Math.max(1, Math.floor(q * sorted.length));
  const worst = sorted.slice(0, count);
  return { count, var: worst[count - 1], es: worst.reduce((a, b) => a + b, 0) / count };
}

// ---------------------------------------------------------------------------
// Stops and overnight gaps
// ---------------------------------------------------------------------------

/**
 * A stop on a long position at `stopFrac` below its entry price (0.3: 30% below) can only fill at a
 * traded price. Overnight nothing trades, so when the first price of the next session (`firstPx`) is
 * already at or below the stop level the stop fills there, not at the stop: `gapped`, and
 * `beyondStop` = stop level − firstPx (≥ 0), the loss per unit the stop did not prevent.
 */
export function gapThroughStop(entry: number, firstPx: number, stopFrac: number): { stopPx: number; gapped: boolean; fill: number | null; beyondStop: number } {
  const stopPx = entry * (1 - stopFrac);
  const gapped = firstPx <= stopPx;
  return { stopPx, gapped, fill: gapped ? firstPx : null, beyondStop: gapped ? stopPx - firstPx : 0 };
}

/** The first and second halves of a dated list by count (the first half takes the odd one). */
export function halves<T extends { day: string }>(xs: readonly T[]): [T[], T[]] {
  const sorted = [...xs].sort((a, b) => a.day.localeCompare(b.day));
  const k = Math.ceil(sorted.length / 2);
  return [sorted.slice(0, k), sorted.slice(k)];
}
