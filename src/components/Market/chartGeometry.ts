/**
 * Pure geometry for LiveIndexChart: the 09:15–15:30 IST time scale, the price path, the y-domain (with the
 * previous close kept in view when it is near), nice ticks and label de-collision. No React, so it is unit-tested.
 */
import { runningVwap, type LiveIndex, type LiveIndexBar } from "@/lib/market/liveIndices";

export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;
const IST_OFFSET_MS = 330 * 60_000;
const BAR_MS = 60_000;

export interface ChartMarks {
  /** The trade's entry: time (epoch ms), index level and order side. */
  entry?: { t: number; price: number; side: "BUY" | "SELL" };
  exit?: { t: number; price: number };
  /** Index levels drawn as horizontal lines. */
  stop?: number;
  target?: number;
  /** Index level past which copying the trade is too late. */
  skipBeyond?: number;
}

/** IST date (YYYY-MM-DD) of an instant. */
export function istDay(t: number): string {
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The marks to draw on a session's chart: an entry or exit from another day is left out; levels stay. */
export function marksOnSession(marks: ChartMarks | undefined, session: string): ChartMarks {
  if (!marks) return {};
  const ok = (t: number | undefined) => t != null && Number.isFinite(t) && istDay(t) === session;
  return {
    ...marks,
    entry: marks.entry && ok(marks.entry.t) && Number.isFinite(marks.entry.price) ? marks.entry : undefined,
    exit: marks.exit && ok(marks.exit.t) && Number.isFinite(marks.exit.price) ? marks.exit : undefined,
  };
}

/** Minutes after 09:15 IST on the instant's IST day (seconds kept), clamped to the session. */
export function sessionMinute(t: number): number {
  const d = new Date(t + IST_OFFSET_MS);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - SESSION_OPEN_MIN;
  return Math.min(SESSION_MINUTES, Math.max(0, m));
}

export interface PricePoint {
  /** Time on the axis (epoch ms): the session open for the first bar's open, else a bar's close time. */
  t: number;
  price: number;
  /** The bar this point closes (index into bars); -1 for the opening print. */
  bar: number;
  vwap: number | null;
}

/**
 * The price path: the first bar's open at its open time, then each bar's close at its close time (bar open
 * + 1 min; the forming last bar at the last trade time, never in the future), with the running VWAP.
 */
export function pricePoints(bars: readonly LiveIndexBar[], asOfMs: number | null): PricePoint[] {
  if (bars.length === 0) return [];
  const vwap = runningVwap(bars);
  const out: PricePoint[] = [{ t: bars[0].t, price: bars[0].o, bar: -1, vwap: null }];
  bars.forEach((b, i) => {
    let t = b.t + BAR_MS;
    if (i === bars.length - 1 && asOfMs != null && asOfMs >= b.t && asOfMs < t) t = asOfMs;
    out.push({ t, price: b.c, bar: i, vwap: vwap[i] });
  });
  return out;
}

export interface YDomain {
  min: number;
  max: number;
  /** Where the previous close sits: drawn in view, or off the top or bottom (shown as an edge note). */
  prevClose: "in" | "above" | "below" | null;
}

/**
 * The price axis: every point, the VWAP, the opening range and the trade levels, plus the previous close
 * when it is within one day-range of them (a far gap would squash the day into a sliver). 6% headroom.
 */
export function yDomain(index: Pick<LiveIndex, "prevClose" | "openingRange" | "price">, points: readonly PricePoint[], marks: ChartMarks = {}): YDomain {
  const values: number[] = [];
  for (const p of points) {
    values.push(p.price);
    if (p.vwap != null) values.push(p.vwap);
  }
  if (values.length === 0) values.push(index.price);
  if (index.openingRange) values.push(index.openingRange.high, index.openingRange.low);
  for (const v of [marks.entry?.price, marks.exit?.price, marks.stop, marks.target, marks.skipBeyond]) if (v != null && Number.isFinite(v)) values.push(v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  let prevClose: YDomain["prevClose"] = null;
  const pc = index.prevClose;
  if (pc != null) {
    const reach = Math.max(hi - lo, Math.abs(hi) * 0.002);
    if (pc >= lo - reach && pc <= hi + reach) {
      lo = Math.min(lo, pc);
      hi = Math.max(hi, pc);
      prevClose = "in";
    } else prevClose = pc > hi ? "above" : "below";
  }
  const span = hi - lo || Math.abs(hi) * 0.002 || 1;
  return { min: lo - span * 0.06, max: hi + span * 0.06, prevClose };
}

/** The round step nearest `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

/** Round tick values inside [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [];
  const step = niceStep((max - min) / count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Time-axis labels in priority order. */
const TIME_LABELS = ["09:15", "15:30", "12:00", "11:00", "13:00", "14:00", "10:00", "15:00"];

/**
 * Time-axis labels that fit: the first is drawn from its x, the last up to its x, the rest centred; a label
 * is dropped when its box would come within `gapPx` of a kept one (`labelPx` is a label's width).
 */
export function timeTicks(innerWidth: number, labelPx = 28, gapPx = 10): { label: string; minute: number }[] {
  const kept: { label: string; minute: number; from: number; to: number }[] = [];
  for (const label of TIME_LABELS) {
    const [h, m] = label.split(":").map(Number);
    const minute = h * 60 + m - SESSION_OPEN_MIN;
    const x = (minute / SESSION_MINUTES) * innerWidth;
    const from = minute === 0 ? x : minute === SESSION_MINUTES ? x - labelPx : x - labelPx / 2;
    const to = from + labelPx;
    if (kept.every((k) => from >= k.to + gapPx || to <= k.from - gapPx)) kept.push({ label, minute, from, to });
  }
  return kept.sort((a, b) => a.minute - b.minute).map(({ label, minute }) => ({ label, minute }));
}

/** Width (px) of the price gutter for tags like "72,638.70" or "↑ 1,00,000.00" at 10 px. */
export function gutterWidth(texts: readonly string[]): number {
  const longest = Math.max(0, ...texts.map((t) => t.length));
  return Math.max(62, Math.ceil(longest * 6.2) + 12);
}

/**
 * Moves labels (by their wanted y, in px) apart so neighbours are at least `gap` apart, staying inside
 * [top, bottom]. Keeps the input order of equal values. Returns the placed y for each input, in input order.
 */
export function spreadLabels(wanted: readonly number[], gap: number, top: number, bottom: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const placed = order.map((o) => Math.min(bottom, Math.max(top, o.y)));
  for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k], placed[k - 1] + gap);
  // Pushed past the bottom: shift the run back up.
  const over = placed.length > 0 ? placed[placed.length - 1] - bottom : 0;
  if (over > 0) {
    placed[placed.length - 1] -= over;
    for (let k = placed.length - 2; k >= 0; k--) placed[k] = Math.min(placed[k], placed[k + 1] - gap);
  }
  const out = new Array<number>(wanted.length);
  order.forEach((o, k) => (out[o.i] = placed[k]));
  return out;
}

/** Index of the point whose time is nearest `t` (points sorted by time); -1 for none. */
export function nearestPoint(points: readonly PricePoint[], t: number): number {
  if (points.length === 0) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[hi].t - t) < Math.abs(points[lo].t - t) ? hi : lo;
}

/** SVG path through (x, y) pairs. */
export function linePath(xy: readonly (readonly [number, number])[]): string {
  return xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}
