/**
 * WP10 short-premium research helpers (research only; nothing in the live engine imports this):
 * dated historical charges, multi-leg option P&L per lot with spread and charges, expected moves
 * and wing strikes, the iron-fly opening-print checks, Black-76 implied volatilities, tail
 * statistics and the scheduled-event calendar used by scripts/research/wp10-short-premium.ts.
 * The definitions are frozen in reports/wp10-short-premium.md §1.
 *
 * Pure and web-standard (no node: imports), like realPrices.ts.
 */
import { computeCharges } from "../broker/charges";
import { CHARGE_SCHEDULES, type ChargeSchedule } from "../config";
import { bsPrice, impliedVol } from "../pricing/blackScholes";
import type { Exchange } from "../types";

// ---------------------------------------------------------------------------
// Charges at the rates in force on each date
// ---------------------------------------------------------------------------

const BASE = CHARGE_SCHEDULES[0];

/**
 * The engine's dated schedules extended backwards for research on 2019-2024 data. Rates as brokers
 * billed them to clients (Zerodha bulletins of 3 Apr 2023, 15 Mar 2024 and 28 Sep 2024):
 * STT on option sales 0.05% until 31 Mar 2023, then 0.0625%; NSE option transaction charges
 * 0.053% until 31 Mar 2023, 0.05% from 1 Apr 2023, 0.0495% from 1 Apr 2024; BSE option charges
 * billed like NSE's until the "true to label" rates of 1 Oct 2024 (an assumption for 2023-24).
 * Stamp duty 0.003% on buys throughout (uniform from 1 Jul 2020; state rates of similar size before).
 * From 1 Oct 2024 the engine's own CHARGE_SCHEDULES apply unchanged.
 */
export const RESEARCH_CHARGE_SCHEDULES: readonly ChargeSchedule[] = [
  { ...BASE, effectiveFrom: "2016-06-01", sttSellPct: 0.05, exchangeTxnPct: { NSE: 0.053, BSE: 0.053 } },
  { ...BASE, effectiveFrom: "2023-04-01", sttSellPct: 0.0625, exchangeTxnPct: { NSE: 0.05, BSE: 0.05 } },
  { ...BASE, effectiveFrom: "2024-04-01", sttSellPct: 0.0625, exchangeTxnPct: { NSE: 0.0495, BSE: 0.0495 } },
  ...CHARGE_SCHEDULES,
];

/** STT on a long option exercised at expiry, percent of its intrinsic value (0.15% from 1 Apr 2026). */
export function exerciseSttPct(date: string): number {
  return date >= "2026-04-01" ? 0.15 : 0.125;
}

// ---------------------------------------------------------------------------
// Spreads and multi-leg P&L
// ---------------------------------------------------------------------------

export const TICK = 0.05;

/** Full bid-ask spread for a premium. */
export type SpreadFn = (price: number) => number;

/** The engine's spread model: max(1 tick, 0.4% of premium), rounded up to whole ticks. */
export const engineSpread: SpreadFn = (p) => Math.max(1, Math.ceil((0.004 * p) / TICK - 1e-9)) * TICK;

/** The engine's spread scaled by `k` (2 = the 2x sensitivity). */
export function scaledSpread(k: number): SpreadFn {
  return (p) => k * engineSpread(p);
}

export interface LegSpec {
  side: "short" | "long";
  /** Printed price at entry (opening print, VWAP or close). */
  entry: number;
  /** Printed price at exit, or the intrinsic value at final settlement when `settled`. */
  exit: number;
  /** Held to final settlement: no exit order, no exit spread; long legs pay exercise STT when in the money. */
  settled: boolean;
}

export interface StructurePnl {
  /** ₹ per lot before costs, at printed prices. */
  gross: number;
  /** ₹ per lot paid to the spread (half the spread per leg per order). */
  spread: number;
  /** ₹ per lot of charges (and exercise STT). */
  charges: number;
  net: number;
  /** ₹ per lot of premium of the short legs at their printed entry prices. */
  premium: number;
}

/**
 * P&L of one lot of a multi-leg position. Shorts sell at entry − half spread and buy back at exit +
 * half spread; longs the reverse (a sale is floored at 0). Charges are computed per order (one order
 * per leg per side) at the schedule in force on the order's date.
 */
export function structurePnl(
  legs: readonly LegSpec[],
  o: { lot: number; exchange: Exchange; entryDate: string; exitDate: string; spread: SpreadFn; schedules?: readonly ChargeSchedule[] },
): StructurePnl {
  const sch = o.schedules ?? RESEARCH_CHARGE_SCHEDULES;
  let gross = 0;
  let filled = 0;
  let charges = 0;
  let premium = 0;
  for (const l of legs) {
    const hsIn = o.spread(l.entry) / 2;
    if (l.side === "short") {
      premium += l.entry * o.lot;
      gross += (l.entry - l.exit) * o.lot;
      const sell = Math.max(0, l.entry - hsIn);
      charges += computeCharges("SELL", sell, o.lot, o.exchange, o.entryDate, sch).total;
      if (l.settled) {
        filled += (sell - l.exit) * o.lot;
      } else {
        const buy = l.exit + o.spread(l.exit) / 2;
        charges += computeCharges("BUY", buy, o.lot, o.exchange, o.exitDate, sch).total;
        filled += (sell - buy) * o.lot;
      }
    } else {
      gross += (l.exit - l.entry) * o.lot;
      const buy = l.entry + hsIn;
      charges += computeCharges("BUY", buy, o.lot, o.exchange, o.entryDate, sch).total;
      if (l.settled) {
        filled += (l.exit - buy) * o.lot;
        if (l.exit > 0) charges += (l.exit * o.lot * exerciseSttPct(o.exitDate)) / 100;
      } else {
        const sell = Math.max(0, l.exit - o.spread(l.exit) / 2);
        charges += computeCharges("SELL", sell, o.lot, o.exchange, o.exitDate, sch).total;
        filled += (sell - buy) * o.lot;
      }
    }
  }
  return { gross, spread: gross - filled, charges, net: filled - charges, premium };
}

/** Intrinsic value of an option at an index level. */
export function intrinsic(type: "CE" | "PE", strike: number, level: number): number {
  return type === "CE" ? Math.max(level - strike, 0) : Math.max(strike - level, 0);
}

// ---------------------------------------------------------------------------
// Expected moves and strikes
// ---------------------------------------------------------------------------

/** Expected 1-sigma move in index points over `sessions` sessions: level × VIX/100 × √(sessions/252). */
export function expectedMove(level: number, vixPct: number, sessions = 1): number {
  return level * (vixPct / 100) * Math.sqrt(sessions / 252);
}

/** The listed strike strictly above (or below) `from` nearest `target`; ties go to the strike nearer `from`. Null when none. */
export function strikeBeyond(strikes: readonly number[], from: number, target: number, side: "above" | "below"): number | null {
  let best: number | null = null;
  for (const k of strikes) {
    if (side === "above" ? !(k > from) : !(k < from)) continue;
    if (best === null) {
      best = k;
      continue;
    }
    const d = Math.abs(k - target);
    const db = Math.abs(best - target);
    if (d < db || (d === db && Math.abs(k - from) < Math.abs(best - from))) best = k;
  }
  return best;
}

/** Most common non-null value (ties to the larger); null for none. */
export function modeLot(lots: readonly (number | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const l of lots) if (l !== null && l > 0) counts.set(l, (counts.get(l) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && best !== null && v > best)) [best, bestN] = [v, n];
  return best;
}

// ---------------------------------------------------------------------------
// Opening-print checks for an iron fly (reports/wp10-short-premium.md §1.4)
// ---------------------------------------------------------------------------

export type FlyArbCheck = "ok" | "call-vertical" | "put-vertical" | "fly-value";

/**
 * No-arbitrage bounds on the four opening prints of an iron fly: each vertical (ATM minus wing of the
 * same type) in [0, its width], and the fly's value (the sum of the verticals) in (0, the wider width).
 */
export function flyNoArbitrage(o: { k: number; kc: number; kp: number; c: number; p: number; wc: number; wp: number }): FlyArbCheck {
  const callVert = o.c - o.wc;
  const putVert = o.p - o.wp;
  if (callVert < 0 || callVert > o.kc - o.k) return "call-vertical";
  if (putVert < 0 || putVert > o.k - o.kp) return "put-vertical";
  const v = callVert + putVert;
  if (!(v > 0) || !(v < Math.max(o.kc - o.k, o.k - o.kp))) return "fly-value";
  return "ok";
}

/** x lies within a factor `f` of `ref` (both positive). */
export function withinFactor(x: number, ref: number, f: number): boolean {
  return x > 0 && ref > 0 && x <= ref * f && x >= ref / f;
}

/** Black-76 (undiscounted) implied volatility of one option on forward `fwd`; null when not reachable. */
export function black76Iv(price: number, fwd: number, strike: number, tYears: number, type: "CE" | "PE"): number | null {
  return impliedVol(price, { spot: fwd, strike, tYears, r: 0, type });
}

/** Black-76 implied volatility of a straddle (call + put at one strike) by bisection; null when not reachable. */
export function black76StraddleIv(price: number, fwd: number, strike: number, tYears: number): number | null {
  if (!(price > 0) || !(fwd > 0) || !(strike > 0) || !(tYears > 0)) return null;
  const f = (v: number) => bsPrice({ spot: fwd, strike, tYears, vol: v, r: 0, type: "CE" }) + bsPrice({ spot: fwd, strike, tYears, vol: v, r: 0, type: "PE" }) - price;
  let lo = 0.005;
  let hi = 5;
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Tail statistics on a P&L series in date order
// ---------------------------------------------------------------------------

/** Lowest sum of `k` consecutive values and where it starts (the whole series when shorter than k). */
export function worstRun(xs: readonly number[], k: number): { sum: number; start: number } {
  if (xs.length === 0) return { sum: 0, start: -1 };
  const w = Math.max(1, Math.min(k, xs.length));
  let s = 0;
  for (let i = 0; i < w; i++) s += xs[i];
  let best = s;
  let start = 0;
  for (let i = w; i < xs.length; i++) {
    s += xs[i] - xs[i - w];
    if (s < best) {
      best = s;
      start = i - w + 1;
    }
  }
  return { sum: best, start };
}

/** Largest fall of the cumulative sum from a running peak (the start counts as a peak at 0). */
export function maxDrawdown(xs: readonly number[]): { depth: number; peak: number; trough: number } {
  let cum = 0;
  let peak = 0;
  let peakAt = -1;
  let depth = 0;
  let at = { peak: -1, trough: -1 };
  xs.forEach((x, i) => {
    cum += x;
    if (cum > peak) {
      peak = cum;
      peakAt = i;
    }
    if (peak - cum > depth) {
      depth = peak - cum;
      at = { peak: peakAt, trough: i };
    }
  });
  return { depth, ...at };
}

/**
 * The worst `q` share of values (at least one): their count and sum, the total, and the sum as a
 * multiple of the total (e.g. -2 means the worst days lost twice what the whole series netted).
 */
export function tailShare(xs: readonly number[], q = 0.05): { count: number; worstSum: number; total: number; multiple: number } {
  const total = xs.reduce((a, b) => a + b, 0);
  if (xs.length === 0) return { count: 0, worstSum: 0, total: 0, multiple: NaN };
  const count = Math.max(1, Math.floor(q * xs.length));
  const worstSum = [...xs].sort((a, b) => a - b).slice(0, count).reduce((a, b) => a + b, 0);
  return { count, worstSum, total, multiple: total !== 0 ? worstSum / total : NaN };
}

// ---------------------------------------------------------------------------
// Breakdown keys
// ---------------------------------------------------------------------------

export function dteBucket(dte: number): "0" | "1" | "2-5" | "6+" {
  return dte <= 0 ? "0" : dte === 1 ? "1" : dte <= 5 ? "2-5" : "6+";
}

/** Opening-gap bucket by |open / previous close − 1|. */
export function gapBucket(gap: number): "<0.25%" | "0.25-0.5%" | "0.5-1%" | ">=1%" {
  const a = Math.abs(gap);
  return a < 0.0025 ? "<0.25%" : a < 0.005 ? "0.25-0.5%" : a < 0.01 ? "0.5-1%" : ">=1%";
}

/** Tercile (0 low, 1 middle, 2 high) of a percentile rank in [0, 100]. */
export function tercile(rankPct: number): 0 | 1 | 2 {
  return rankPct < 100 / 3 ? 0 : rankPct < 200 / 3 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Scheduled events 2019-2026 (reports/wp10-short-premium.md §1.6)
// ---------------------------------------------------------------------------

export type EventKind = "budget" | "rbi" | "election";

const RBI_DATES = [
  "2019-02-07", "2019-04-04", "2019-06-06", "2019-08-07", "2019-10-04", "2019-12-05",
  "2020-02-06", "2020-08-06", "2020-10-09", "2020-12-04",
  "2021-02-05", "2021-04-07", "2021-06-04", "2021-08-06", "2021-10-08", "2021-12-08",
  "2022-02-10", "2022-04-08", "2022-06-08", "2022-08-05", "2022-09-30", "2022-12-07",
  "2023-02-08", "2023-04-06", "2023-06-08", "2023-08-10", "2023-10-06", "2023-12-08",
  "2024-02-08", "2024-04-05", "2024-06-07", "2024-08-08", "2024-10-09", "2024-12-06",
  "2025-02-07", "2025-04-09", "2025-06-06", "2025-08-06", "2025-10-01", "2025-12-05",
  "2026-02-06", "2026-04-08", "2026-06-05", "2026-08-05", "2026-10-07",
];
const BUDGET_DATES = ["2019-02-01", "2019-07-05", "2020-02-01", "2021-02-01", "2022-02-01", "2023-02-01", "2024-02-01", "2024-07-23", "2025-02-01", "2026-02-01"];
const ELECTION_DATES = ["2019-05-23", "2024-06-04"];

/** Union Budgets, scheduled RBI policy decisions and general-election results (off-cycle RBI moves excluded). */
export const SCHEDULED_EVENTS: readonly { date: string; kind: EventKind }[] = [
  ...BUDGET_DATES.map((date) => ({ date, kind: "budget" as const })),
  ...RBI_DATES.map((date) => ({ date, kind: "rbi" as const })),
  ...ELECTION_DATES.map((date) => ({ date, kind: "election" as const })),
].sort((a, b) => a.date.localeCompare(b.date));

const EVENT_BY_DATE = new Map(SCHEDULED_EVENTS.map((e) => [e.date, e.kind]));

export function eventOn(date: string): EventKind | null {
  return EVENT_BY_DATE.get(date) ?? null;
}
