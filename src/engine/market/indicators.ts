/** Technical indicators and small statistics used by the feature builder. Pure functions. */
import type { Candle } from "../types";
import { logRetPct, mean, stdev } from "../util/math";

/** Consecutive log returns in percent (length = closes.length - 1). Non-positive prices give 0. */
export function logReturnsPct(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(logRetPct(closes[i - 1], closes[i]));
  return out;
}

export function typicalPrice(c: Candle): number {
  return (c.h + c.l + c.c) / 3;
}

/**
 * Running (cumulative) VWAP over the bars, one value per bar, using typical price.
 * Volume-weighted while cumulative volume is positive; equal-weighted otherwise
 * (Yahoo reports zero volume on intraday index bars). Each value depends only on bars up to it.
 */
export function vwapSeries(candles: Candle[]): number[] {
  const out: number[] = [];
  let pv = 0;
  let vol = 0;
  let tpSum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = typicalPrice(c);
    const v = Number.isFinite(c.v) && c.v > 0 ? c.v : 0;
    pv += tp * v;
    vol += v;
    tpSum += tp;
    out.push(vol > 0 ? pv / vol : tpSum / (i + 1));
  }
  return out;
}

/** VWAP of all bars (0 for an empty list). */
export function vwap(candles: Candle[]): number {
  const s = vwapSeries(candles);
  return s.length > 0 ? s[s.length - 1] : 0;
}

/**
 * +n when the latest n closes are all above the running VWAP, -n when below,
 * 0 when the latest close equals its VWAP (or there are no bars).
 */
export function barsSameSideOfVwap(candles: Candle[]): number {
  const vw = vwapSeries(candles);
  if (vw.length === 0) return 0;
  const side = (i: number) => Math.sign(candles[i].c - vw[i]);
  const last = side(vw.length - 1);
  if (last === 0) return 0;
  let n = 0;
  for (let i = vw.length - 1; i >= 0 && side(i) === last; i--) n++;
  return last * n;
}

/** Kaufman efficiency ratio: |last - first| / sum |diff|. 0 when flat or fewer than 2 points. */
export function efficiencyRatio(closes: number[]): number {
  if (closes.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  if (!(path > 0)) return 0;
  return Math.abs(closes[closes.length - 1] - closes[0]) / path;
}

/** True ranges; the first bar uses its own high - low. */
export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.h - c.l);
      continue;
    }
    const pc = candles[i - 1].c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  return out;
}

/** Mean of the last n true ranges (fewer when fewer bars exist; 0 for none). */
export function atr(candles: Candle[], n: number): number {
  if (!(n >= 1) || candles.length === 0) return 0;
  return mean(trueRanges(candles).slice(-Math.floor(n)));
}

/** Annualized volatility in percent from per-period log returns in percent. 0 with fewer than 2 returns. */
export function annualizedVolPct(returnsPct: number[], periodsPerYear: number): number {
  if (returnsPct.length < 2 || !(periodsPerYear > 0)) return 0;
  return stdev(returnsPct) * Math.sqrt(periodsPerYear);
}

/** Realized volatility in percent: stdev of log returns * sqrt(periodsPerYear) * 100. */
export function realizedVolPct(closes: number[], periodsPerYear: number): number {
  return annualizedVolPct(logReturnsPct(closes), periodsPerYear);
}

/** (x - mean) / stdev of the sample; 0 when the sample has fewer than 5 values or zero dispersion. */
export function zScore(x: number, sample: number[]): number {
  if (sample.length < 5 || !Number.isFinite(x)) return 0;
  const sd = stdev(sample);
  if (!(sd > 0) || !Number.isFinite(sd)) return 0;
  return (x - mean(sample)) / sd;
}

/** Exponential moving average (alpha = 2 / (n + 1)), seeded with the first value. */
export function ema(xs: number[], n: number): number[] {
  const alpha = 2 / (Math.max(1, n) + 1);
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) out.push(i === 0 ? xs[0] : alpha * xs[i] + (1 - alpha) * out[i - 1]);
  return out;
}

/** OLS slope of y on x (with intercept). 0 when x has no variance or fewer than 2 points. */
export function olsBeta(y: number[], x: number[]): number {
  const n = Math.min(y.length, x.length);
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varX += (x[i] - mx) * (x[i] - mx);
  }
  return varX > 0 ? cov / varX : 0;
}

/**
 * Solves A x = b by Gaussian elimination with partial pivoting.
 * Columns without a usable pivot (singular directions) get coefficient 0.
 */
export function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row.slice(0, n), b[i]]);
  let scale = 0;
  for (const row of M) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(row[j]));
  const eps = (scale > 0 ? scale : 1) * 1e-12;
  const pivotCols: number[] = [];
  let r = 0;
  for (let col = 0; col < n && r < n; col++) {
    let best = r;
    for (let i = r + 1; i < n; i++) if (Math.abs(M[i][col]) > Math.abs(M[best][col])) best = i;
    if (Math.abs(M[best][col]) <= eps) continue;
    [M[r], M[best]] = [M[best], M[r]];
    for (let i = r + 1; i < n; i++) {
      const f = M[i][col] / M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[i][j] -= f * M[r][j];
    }
    pivotCols.push(col);
    r++;
  }
  const x = new Array<number>(n).fill(0);
  for (let k = pivotCols.length - 1; k >= 0; k--) {
    const col = pivotCols[k];
    let s = M[k][n];
    for (let j = col + 1; j < n; j++) s -= M[k][j] * x[j];
    x[col] = s / M[k][col];
  }
  return x;
}

/**
 * Ridge regression without intercept: solves (X'X + lambda I) beta = X'y.
 * Non-finite inputs are treated as 0. Returns [] for empty input.
 */
export function ridgeRegression(X: number[][], y: number[], lambda: number): number[] {
  const n = Math.min(X.length, y.length);
  if (n === 0) return [];
  const p = X.reduce((m, row) => Math.max(m, row.length), 0);
  if (p === 0) return [];
  const fin = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    const yi = fin(y[i]);
    for (let j = 0; j < p; j++) {
      const xj = fin(row[j]);
      if (xj === 0) continue;
      b[j] += xj * yi;
      for (let k = 0; k < p; k++) A[j][k] += xj * fin(row[k]);
    }
  }
  const lam = Number.isFinite(lambda) && lambda > 0 ? lambda : 0;
  for (let j = 0; j < p; j++) A[j][j] += lam;
  return solveLinearSystem(A, b);
}
