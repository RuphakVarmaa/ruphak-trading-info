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

// ---------------------------------------------------------------------------------------------
// Classic intraday indicators (Wilder smoothing where the textbook definition uses it). Each
// returns the value at the last bar and a finite neutral value while warming up.
// ---------------------------------------------------------------------------------------------

/** Wilder's smoothing (RMA): the first value is the mean of the first n inputs, then (prev·(n−1) + x) / n. [] with fewer than n inputs. */
export function wilderSmooth(xs: number[], n: number): number[] {
  const k = Math.floor(n);
  if (!(k >= 1) || xs.length < k) return [];
  let prev = mean(xs.slice(0, k));
  const out = [prev];
  for (let i = k; i < xs.length; i++) {
    prev = (prev * (k - 1) + xs[i]) / k;
    out.push(prev);
  }
  return out;
}

/** Wilder RSI of the closes; 50 with fewer than n + 1 closes, 100 when there were no losses. */
export function rsi(closes: number[], n = 14): number {
  const k = Math.floor(n);
  if (!(k >= 1) || closes.length < k + 1) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const g = wilderSmooth(gains, k).at(-1) ?? 0;
  const l = wilderSmooth(losses, k).at(-1) ?? 0;
  if (!(l > 0)) return g > 0 ? 100 : 50;
  return 100 - 100 / (1 + g / l);
}

export interface Dmi {
  adx: number;
  plusDi: number;
  minusDi: number;
}

/** Wilder's directional movement: +DI/−DI need n + 1 bars, ADX needs 2n; missing values are 0. */
export function dmi(candles: Candle[], n = 14): Dmi {
  const k = Math.floor(n);
  if (!(k >= 1) || candles.length < k + 1) return { adx: 0, plusDi: 0, minusDi: 0 };
  const tr: number[] = [];
  const pdm: number[] = [];
  const mdm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.h - p.h;
    const down = p.l - c.l;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const sTr = wilderSmooth(tr, k);
  const sP = wilderSmooth(pdm, k);
  const sM = wilderSmooth(mdm, k);
  const dx: number[] = [];
  let plusDi = 0;
  let minusDi = 0;
  for (let i = 0; i < sTr.length; i++) {
    plusDi = sTr[i] > 0 ? (100 * sP[i]) / sTr[i] : 0;
    minusDi = sTr[i] > 0 ? (100 * sM[i]) / sTr[i] : 0;
    const total = plusDi + minusDi;
    dx.push(total > 0 ? (100 * Math.abs(plusDi - minusDi)) / total : 0);
  }
  const adx = wilderSmooth(dx, k).at(-1) ?? 0;
  return { adx, plusDi, minusDi };
}

export interface Supertrend {
  /** +1 up (price above the trailing band), −1 down, 0 while warming up. */
  dir: -1 | 0 | 1;
  /** The active band: the lower band in an uptrend, the upper band in a downtrend. */
  line: number;
}

/** Supertrend with a Wilder ATR(n) and the usual band carry-forward rules. */
export function supertrend(candles: Candle[], n = 10, mult = 3): Supertrend {
  const k = Math.floor(n);
  if (!(k >= 1) || candles.length < k + 1) return { dir: 0, line: 0 };
  const atrs = wilderSmooth(trueRanges(candles), k); // atrs[j] belongs to bar j + k - 1
  let upper = 0;
  let lower = 0;
  let dir: -1 | 1 = 1;
  for (let j = 0; j < atrs.length; j++) {
    const i = j + k - 1;
    const c = candles[i];
    const mid = (c.h + c.l) / 2;
    const bu = mid + mult * atrs[j];
    const bl = mid - mult * atrs[j];
    if (j === 0) {
      upper = bu;
      lower = bl;
      dir = c.c >= mid ? 1 : -1;
      continue;
    }
    const pc = candles[i - 1].c;
    upper = bu < upper || pc > upper ? bu : upper;
    lower = bl > lower || pc < lower ? bl : lower;
    if (dir === 1 && c.c < lower) dir = -1;
    else if (dir === -1 && c.c > upper) dir = 1;
  }
  return { dir, line: dir === 1 ? lower : upper };
}

export interface Bollinger {
  mid: number;
  upper: number;
  lower: number;
  /** Where the last close sits in the band: 0 at the lower band, 1 at the upper band. */
  pctB: number;
  /** Band width as a percentage of the middle band. */
  bandwidthPct: number;
}

/** Bollinger bands on the last n closes (population standard deviation); neutral with fewer than n closes. */
export function bollinger(closes: number[], n = 20, k = 2): Bollinger {
  const m = Math.floor(n);
  if (!(m >= 2) || closes.length < m) return { mid: 0, upper: 0, lower: 0, pctB: 0.5, bandwidthPct: 0 };
  const w = closes.slice(-m);
  const mid = mean(w);
  const sd = Math.sqrt(mean(w.map((x) => (x - mid) * (x - mid))));
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const last = w[w.length - 1];
  const width = upper - lower;
  return {
    mid,
    upper,
    lower,
    pctB: width > 0 ? (last - lower) / width : 0.5,
    bandwidthPct: mid > 0 ? (width / mid) * 100 : 0,
  };
}

export interface VwapBands {
  vwap: number;
  /** Standard deviation of typical prices around VWAP (same weights as the VWAP). */
  sigma: number;
  /** (price − VWAP) / sigma, clamped to ±5; 0 with fewer than 6 bars or no dispersion. */
  z: number;
}

const VWAP_BANDS_MIN_BARS = 6;

/**
 * VWAP and its standard-deviation bands for the session bars. Volume-weighted when the bars carry
 * volume, equal-weighted otherwise (Yahoo reports zero volume on index bars).
 */
export function vwapBands(candles: Candle[], price: number): VwapBands {
  if (candles.length === 0) return { vwap: 0, sigma: 0, z: 0 };
  const volTotal = candles.reduce((s, c) => s + (Number.isFinite(c.v) && c.v > 0 ? c.v : 0), 0);
  let wSum = 0;
  let tpSum = 0;
  let tp2Sum = 0;
  for (const c of candles) {
    const w = volTotal > 0 ? (Number.isFinite(c.v) && c.v > 0 ? c.v : 0) : 1;
    const tp = typicalPrice(c);
    wSum += w;
    tpSum += w * tp;
    tp2Sum += w * tp * tp;
  }
  const vw = wSum > 0 ? tpSum / wSum : 0;
  const variance = wSum > 0 ? tp2Sum / wSum - vw * vw : 0;
  const sigma = variance > 0 ? Math.sqrt(variance) : 0;
  const usable = candles.length >= VWAP_BANDS_MIN_BARS && sigma > 0 && Number.isFinite(price) && price > 0;
  const z = usable ? Math.max(-5, Math.min(5, (price - vw) / sigma)) : 0;
  return { vwap: vw, sigma, z };
}
