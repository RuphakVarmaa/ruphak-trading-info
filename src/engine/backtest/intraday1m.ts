/**
 * WP11 research helpers for real 1-minute option and index bars (the TradeMarkk "India Index &
 * Options - 1-minute OHLC" dataset; research only, nothing in the live engine imports this):
 * minute series with gap-aware lookups, fills at a bar's low/high (conservative) or close (mid),
 * n-minute aggregation, windowed VWAPs, multi-leg positions with a stop on the combined premium,
 * listed-strike pickers and the walk-forward split. Every definition is frozen in
 * reports/wp11-real-intraday.md §1.
 *
 * Pure and web-standard (no node: imports), like realPrices.ts and shortPremium.ts.
 */

/** One 1-minute bar; `m` is the IST minute of the day at which the bar starts (09:15 = 555). */
export interface MinuteBar {
  m: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi: number;
}

/** First regular-session minute (09:15) and the last bar start kept (15:30). */
export const OPEN_MIN = 9 * 60 + 15;
export const LAST_MIN = 15 * 60 + 30;

/** "09:15" -> 555. */
export function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid HH:MM ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 555 -> "09:15". */
export function minToHhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Bars of one contract (or the index) on one day, sorted by minute. Minutes without a trade have no
 * bar. Lookups never read a bar later than the minute asked for unless the method says so.
 */
export class MinuteSeries {
  readonly bars: readonly MinuteBar[];

  constructor(bars: readonly MinuteBar[]) {
    const sorted = [...bars].sort((a, b) => a.m - b.m);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].m === sorted[i - 1].m) throw new Error(`duplicate bar at minute ${sorted[i].m}`);
    this.bars = sorted;
  }

  /** Index of the first bar starting at or after `m` (bars.length when none). */
  private lowerBound(m: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid].m < m) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The bar starting exactly at `m`. */
  at(m: number): MinuteBar | undefined {
    const b = this.bars[this.lowerBound(m)];
    return b && b.m === m ? b : undefined;
  }

  /** The first bar starting in [m, m + maxWait] (an order resting for up to maxWait minutes). */
  firstFrom(m: number, maxWait: number): MinuteBar | undefined {
    const b = this.bars[this.lowerBound(m)];
    return b && b.m <= m + maxWait ? b : undefined;
  }

  /** The last bar starting at or before `m`. */
  lastUpTo(m: number): MinuteBar | undefined {
    const i = this.lowerBound(m + 1) - 1;
    return i >= 0 ? this.bars[i] : undefined;
  }

  /** Bars starting in [from, to). */
  between(from: number, to: number): MinuteBar[] {
    const out: MinuteBar[] = [];
    for (let i = this.lowerBound(from); i < this.bars.length && this.bars[i].m < to; i++) out.push(this.bars[i]);
    return out;
  }

  get first(): MinuteBar | undefined {
    return this.bars[0];
  }

  private denseCache: DenseMinutes | null = null;

  /**
   * Every minute from OPEN_MIN to LAST_MIN: the bar's high, low and close, or, in a minute without a
   * bar, the last close carried forward in all three (NaN before the first bar); `has` marks real bars.
   */
  dense(): DenseMinutes {
    if (this.denseCache) return this.denseCache;
    const n = LAST_MIN - OPEN_MIN + 1;
    const d: DenseMinutes = { h: new Float64Array(n).fill(NaN), l: new Float64Array(n).fill(NaN), c: new Float64Array(n).fill(NaN), has: new Uint8Array(n) };
    let last = NaN;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const m = OPEN_MIN + i;
      while (j < this.bars.length && this.bars[j].m < m) last = this.bars[j++].c;
      const b = this.bars[j];
      if (b && b.m === m) {
        d.h[i] = b.h;
        d.l[i] = b.l;
        d.c[i] = b.c;
        d.has[i] = 1;
      } else {
        d.h[i] = d.l[i] = d.c[i] = last;
      }
    }
    this.denseCache = d;
    return d;
  }

  get last(): MinuteBar | undefined {
    return this.bars[this.bars.length - 1];
  }
}

/** A series laid out minute by minute (see MinuteSeries.dense). */
export interface DenseMinutes {
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  has: Uint8Array;
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/**
 * conservative: a sell fills at the bar's low and a buy at its high (no quotes exist, so the worst
 * traded price of the minute stands in for crossing the spread); mid: the bar's close; print: the
 * bar's open (for a 09:15 bar, the day's first trade, which the bhavcopy prints as OPEN).
 */
export type FillMode = "conservative" | "mid" | "print";
export type OrderSide = "buy" | "sell";

export function fillPrice(bar: Pick<MinuteBar, "o" | "h" | "l" | "c">, side: OrderSide, mode: FillMode): number {
  if (mode === "mid") return bar.c;
  if (mode === "print") return bar.o;
  return side === "sell" ? bar.l : bar.h;
}

/** The price of the leg's later orders under a fill mode: "print" applies to the entry only, later orders fill at the close. */
export function laterMode(mode: FillMode): FillMode {
  return mode === "print" ? "mid" : mode;
}

// ---------------------------------------------------------------------------
// Aggregation and windowed prices
// ---------------------------------------------------------------------------

/** (high + low + close) / 3. */
export function typical(b: Pick<MinuteBar, "h" | "l" | "c">): number {
  return (b.h + b.l + b.c) / 3;
}

/** Volume-weighted price of the bars starting in [from, to), each bar at `price(bar)`; null without volume. */
export function vwapOf(bars: readonly MinuteBar[], from: number, to: number, price: (b: MinuteBar) => number = typical): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    if (b.m < from || b.m >= to || !(b.v > 0)) continue;
    pv += price(b) * b.v;
    v += b.v;
  }
  return v > 0 ? pv / v : null;
}

/**
 * n-minute bars aligned to `origin`: the bar starting at origin + k·n covers the 1-minute bars
 * starting in [origin + k·n, origin + (k + 1)·n) that are before `until`. Missing minutes are
 * skipped; an empty bucket gives no bar. Open is the first bar's open, close the last bar's close.
 */
export function aggregate(bars: readonly MinuteBar[], n: number, origin = OPEN_MIN, until = LAST_MIN): MinuteBar[] {
  const out: MinuteBar[] = [];
  let cur: MinuteBar | null = null;
  for (const b of [...bars].sort((x, y) => x.m - y.m)) {
    if (b.m < origin || b.m >= until) continue;
    const start = origin + Math.floor((b.m - origin) / n) * n;
    if (cur === null || cur.m !== start) {
      if (cur) out.push(cur);
      cur = { m: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, oi: b.oi };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.oi = b.oi;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Strikes
// ---------------------------------------------------------------------------

/** The listed strike nearest `level`; a tie goes to the lower strike. Null for none. */
export function nearestListed(strikes: readonly number[], level: number): number | null {
  let best: number | null = null;
  for (const k of strikes) {
    if (best === null) best = k;
    else {
      const d = Math.abs(k - level);
      const db = Math.abs(best - level);
      if (d < db || (d === db && k < best)) best = k;
    }
  }
  return best;
}

/** The listed strike `steps` strikes in the money from `atm` (below it for a call, above it for a put); null when not listed. */
export function itmStrike(strikes: readonly number[], atm: number, type: "CE" | "PE", steps: number): number | null {
  if (steps === 0) return strikes.includes(atm) ? atm : null;
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const i = sorted.indexOf(atm);
  if (i < 0) return null;
  const j = type === "CE" ? i - steps : i + steps;
  return j >= 0 && j < sorted.length ? sorted[j] : null;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface PositionLeg {
  series: MinuteSeries;
  side: "short" | "long";
}

export interface LegFill {
  side: "short" | "long";
  entry: number;
  exit: number;
  entryMin: number;
  exitMin: number;
  /** The exit used the last trade before the exit window (no bar in it). */
  staleExit: boolean;
}

export interface PositionResult {
  legs: LegFill[];
  /** Minute at which the position was complete (the last leg's entry bar). */
  entryMin: number;
  /** Minute of the exit orders. */
  exitMin: number;
  exitReason: "time" | "stop" | "rule";
  /** Position value at entry: Σ long − Σ short entry fills (negative for a net credit). */
  entryValue: number;
}

/**
 * Value of the position at minute m: long legs at their low (conservative) or close, short legs at
 * their high (conservative) or close, i.e. what closing it would fetch, adverse case first. A leg
 * without a bar that minute is valued at its last close at or before m; null when a leg has none.
 */
export function positionValue(legs: readonly PositionLeg[], m: number, mode: FillMode): number | null {
  const i = m - OPEN_MIN;
  if (i < 0 || i > LAST_MIN - OPEN_MIN) return null;
  let v = 0;
  for (const leg of legs) {
    const d = leg.series.dense();
    const px = mode === "conservative" ? (leg.side === "long" ? d.l[i] : d.h[i]) : d.c[i];
    if (Number.isNaN(px)) return null;
    v += leg.side === "long" ? px : -px;
  }
  return v;
}

export interface PositionSpec {
  legs: readonly PositionLeg[];
  /** Minute of the entry orders; each leg fills in its first bar within [entryMin, entryMin + entryWait]. */
  entryMin: number;
  entryWait: number;
  /** Scheduled (or rule) exit minute; each leg fills in its first bar within [exitMin, exitMin + exitWait], else at its last close before (stale). */
  exitMin: number;
  exitWait: number;
  exitReason?: "time" | "rule";
  /** Stop when the position's value falls to entryValue − stopFrac·|entryValue| (e.g. 0.3: a short premium 30% dearer, a long 30% cheaper); null for none. */
  stopFrac: number | null;
  mode: FillMode;
}

/**
 * Enters, scans for the stop on every minute after the position is complete and before the exit
 * minute, and exits. The stop is checked on adverse prices (conservative) or closes (mid, print) and
 * fills at the same prices in the trigger minute. Null when a leg has no bar in its entry window or
 * the exit comes before the entry is complete.
 */
export function runPosition(s: PositionSpec): PositionResult | null {
  const entries: { bar: MinuteBar; leg: PositionLeg }[] = [];
  for (const leg of s.legs) {
    const bar = leg.series.firstFrom(s.entryMin, s.entryWait);
    if (!bar) return null;
    entries.push({ bar, leg });
  }
  const entryMin = Math.max(...entries.map((e) => e.bar.m));
  if (!(s.exitMin > entryMin)) return null;
  const fills = entries.map(({ bar, leg }) => fillPrice(bar, leg.side === "long" ? "buy" : "sell", s.mode));
  const entryValue = fills.reduce((a, px, i) => a + (s.legs[i].side === "long" ? px : -px), 0);
  const later = laterMode(s.mode);
  if (s.stopFrac !== null) {
    const trigger = entryValue - s.stopFrac * Math.abs(entryValue);
    for (let m = entryMin + 1; m < s.exitMin; m++) {
      const v = positionValue(s.legs, m, later);
      if (v !== null && v <= trigger) {
        const legs: LegFill[] = s.legs.map((leg, i) => {
          const b = leg.series.at(m);
          const px = b ? fillPrice(b, leg.side === "long" ? "sell" : "buy", later) : leg.series.lastUpTo(m)!.c;
          return { side: leg.side, entry: fills[i], exit: px, entryMin: entries[i].bar.m, exitMin: m, staleExit: !b };
        });
        return { legs, entryMin, exitMin: m, exitReason: "stop", entryValue };
      }
    }
  }
  const legs: LegFill[] = s.legs.map((leg, i) => {
    const b = leg.series.firstFrom(s.exitMin, s.exitWait);
    if (b) return { side: leg.side, entry: fills[i], exit: fillPrice(b, leg.side === "long" ? "sell" : "buy", later), entryMin: entries[i].bar.m, exitMin: b.m, staleExit: false };
    const prev = leg.series.lastUpTo(s.exitMin)!;
    return { side: leg.side, entry: fills[i], exit: prev.c, entryMin: entries[i].bar.m, exitMin: s.exitMin, staleExit: true };
  });
  return { legs, entryMin, exitMin: s.exitMin, exitReason: s.exitReason ?? "time", entryValue };
}

// ---------------------------------------------------------------------------
// Placebo comparison and perturbations
// ---------------------------------------------------------------------------

/** One session of a paired comparison: the strategy's trades that day and the placebo's mean per trade that day. */
export interface PairedDay {
  /** Strategy trades that session. */
  n: number;
  /** Strategy mean net per trade that session. */
  s: number;
  /** Placebo mean net per trade that session (same session, same structure). */
  p: number;
}

/**
 * Strategy minus placebo per trade, paired by session: the trade-weighted mean of (s − p) over the
 * sessions where both exist, with its cluster-robust (CR1, one cluster per session) standard error.
 */
export function pairedGap(days: readonly PairedDay[]): { gap: number; se: number; t: number; sessions: number; trades: number } {
  const ds = days.filter((d) => d.n > 0 && Number.isFinite(d.s) && Number.isFinite(d.p));
  const w = ds.reduce((a, d) => a + d.n, 0);
  if (ds.length === 0 || w === 0) return { gap: NaN, se: NaN, t: NaN, sessions: 0, trades: 0 };
  const gap = ds.reduce((a, d) => a + d.n * (d.s - d.p), 0) / w;
  const g = ds.length;
  const ss = ds.reduce((a, d) => a + (d.n * (d.s - d.p - gap)) ** 2, 0);
  const se = g > 1 ? Math.sqrt((g / (g - 1)) * ss) / w : NaN;
  return { gap, se, t: se > 0 ? gap / se : NaN, sessions: g, trades: w };
}

/**
 * ±20% perturbations of a time measured from an anchor (minutes after 09:15 for an entry, minutes
 * before 15:30 for an exit): the anchor distance × 0.8 and × 1.2, rounded, moved by at least one
 * minute, never past the anchor. Returns the perturbed distances (deduplicated, without the base).
 */
export function perturbDistance(dist: number, lo = 0): number[] {
  const out = new Set<number>();
  for (const f of [0.8, 1.2]) {
    let d = Math.round(dist * f);
    if (d === dist) d = f < 1 ? dist - 1 : dist + 1;
    if (d >= lo && d !== dist) out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/** The first ⌈frac·n⌉ sorted days (train) and the rest (test). */
export function walkForwardSplit(days: readonly string[], frac = 0.6): { train: string[]; test: string[] } {
  const sorted = [...days].sort();
  const cut = Math.ceil(frac * sorted.length);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/** Uniform integer in [lo, hi] from a uniform [0, 1) draw. */
export function drawInt(u: number, lo: number, hi: number): number {
  return lo + Math.min(hi - lo, Math.floor(u * (hi - lo + 1)));
}
