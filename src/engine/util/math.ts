/** Small numeric helpers shared across the engine. */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

/** Sample standard deviation (n - 1). Returns 0 for fewer than two values. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Percentile rank (0-100) of `x` within `xs`: share of values strictly below plus half of ties. */
export function percentileRank(xs: readonly number[], x: number): number {
  if (xs.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const v of xs) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return ((below + equal / 2) / xs.length) * 100;
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function round(x: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/** Rounds a price to the exchange tick (0.05 for index options). */
export function roundToTick(price: number, tick = 0.05, mode: "nearest" | "up" | "down" = "nearest"): number {
  const n = price / tick;
  const k = mode === "up" ? Math.ceil(n - 1e-9) : mode === "down" ? Math.floor(n + 1e-9) : Math.round(n);
  return Math.round(k * tick * 100) / 100;
}

/** Log return in percent between two prices. */
export function logRetPct(from: number, to: number): number {
  if (!(from > 0) || !(to > 0)) return 0;
  return Math.log(to / from) * 100;
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
