/**
 * Out-of-sample checks and refits of the overnight-gap betas (config.features.gapBetas), used by
 * scripts/research/fit-gap-betas.ts. The engine itself only reads the configured betas; nothing here
 * runs in a trading cycle.
 *
 * - chooseGapLambda: the ridge penalty for fitGapBetas, chosen by time-ordered validation inside the
 *   sessions it is given (each block of sessions is predicted by a fit on all earlier blocks);
 * - walkForwardGapForecasts: for each session, betas fitted only on earlier sessions (the penalty is
 *   chosen on those sessions too), applied to that session's moves;
 * - gapForecastMetrics: MAE, RMSE, directional hit rate, calibration slope (actual gap regressed on the
 *   predicted gap: 1 = calibrated, 0.5 = predictions twice too large) and R² against a zero forecast;
 * - sessionBootstrap: resamples whole sessions (every row of a date together, e.g. NIFTY and SENSEX).
 */
import type { GlobalKey } from "../types";
import { expectedGapPct, fitGapBetas, type GapObservation } from "./crossAsset";

/**
 * Ridge penalties tried, in fitGapBetas' units: columns are scaled to unit RMS, so the penalty is
 * comparable with the number of rows (a penalty equal to the row count roughly halves uncorrelated betas).
 */
export const GAP_LAMBDA_GRID: readonly number[] = [0, 1, 3, 10, 30, 100, 300, 1000];

/** Time-ordered validation folds used by chooseGapLambda by default. */
export const GAP_LAMBDA_FOLDS = 4;

/** True when every key's move is a finite number (the rows fitGapBetas uses). */
export function isCompleteObservation(o: GapObservation, keys: readonly GlobalKey[]): boolean {
  if (!Number.isFinite(o.gapPct)) return false;
  return keys.every((k) => {
    const v = o.moves[k];
    return typeof v === "number" && Number.isFinite(v);
  });
}

function sessionDates(rows: readonly { date: string }[]): string[] {
  return [...new Set(rows.map((r) => r.date))].sort();
}

/**
 * Penalty with the lowest mean squared error over time-ordered validation inside `obs`: the sessions
 * are split by date into `folds + 1` consecutive blocks, and each block from the second on is predicted
 * by a fit on all earlier blocks. Folds whose training part is too small to fit (fitGapBetas needs 20
 * complete rows) are skipped for every penalty alike. On equal error the smaller penalty wins.
 * NaN when no fold can be fitted.
 */
export function chooseGapLambda(
  obs: readonly GapObservation[],
  keys: readonly GlobalKey[],
  grid: readonly number[] = GAP_LAMBDA_GRID,
  folds = GAP_LAMBDA_FOLDS,
): number {
  const rows = obs.filter((o) => isCompleteObservation(o, keys));
  const dates = sessionDates(rows);
  const blocks = Math.max(2, Math.floor(folds) + 1);
  if (dates.length < blocks || grid.length === 0) return NaN;
  const blockOf = new Map(dates.map((d, i) => [d, Math.floor((i * blocks) / dates.length)]));
  const splits: { train: GapObservation[]; test: GapObservation[] }[] = [];
  for (let k = 1; k < blocks; k++) {
    splits.push({
      train: rows.filter((o) => (blockOf.get(o.date) as number) < k),
      test: rows.filter((o) => blockOf.get(o.date) === k),
    });
  }
  let best = NaN;
  let bestMse = Infinity;
  for (const lambda of grid) {
    let sse = 0;
    let n = 0;
    for (const { train, test } of splits) {
      const betas = fitGapBetas(train, [...keys], lambda);
      if (Object.keys(betas).length === 0) continue;
      for (const o of test) {
        const e = o.gapPct - expectedGapPct(o.moves, betas);
        sse += e * e;
        n++;
      }
    }
    if (n === 0) continue;
    const mse = sse / n;
    if (mse < bestMse) {
      bestMse = mse;
      best = lambda;
    }
  }
  return best;
}

export interface GapForecast<T extends GapObservation> {
  obs: T;
  /** Predicted gap, percent. */
  pred: number;
  lambda: number;
  betas: Record<string, number>;
  /** Sessions the betas were fitted on (all of them before obs.date). */
  trainSessions: number;
}

export interface WalkForwardOptions {
  /** Sessions required before the first forecast. */
  minTrainSessions: number;
  /** First session to forecast (YYYY-MM-DD); earlier sessions only train. */
  fromDate?: string;
  /** Last session to forecast (YYYY-MM-DD). */
  toDate?: string;
  grid?: readonly number[];
  folds?: number;
}

/**
 * Expanding-window forecasts: for each session after the first `minTrainSessions`, the penalty is
 * chosen and the betas are fitted on the sessions before it only, then applied to that session's rows.
 * Only complete rows (every key known) are fitted and forecast.
 */
export function walkForwardGapForecasts<T extends GapObservation>(
  obs: readonly T[],
  keys: readonly GlobalKey[],
  opts: WalkForwardOptions,
): GapForecast<T>[] {
  const rows = obs.filter((o) => isCompleteObservation(o, keys)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dates = sessionDates(rows);
  const out: GapForecast<T>[] = [];
  let start = 0;
  for (let i = Math.max(1, Math.floor(opts.minTrainSessions)); i < dates.length; i++) {
    const date = dates[i];
    if (opts.fromDate !== undefined && date < opts.fromDate) continue;
    if (opts.toDate !== undefined && date > opts.toDate) break;
    while (start < rows.length && rows[start].date < date) start++;
    const train = rows.slice(0, start);
    const lambda = chooseGapLambda(train, keys, opts.grid ?? GAP_LAMBDA_GRID, opts.folds ?? GAP_LAMBDA_FOLDS);
    if (!Number.isFinite(lambda)) continue;
    const betas = fitGapBetas(train, [...keys], lambda);
    if (Object.keys(betas).length === 0) continue;
    for (let j = start; j < rows.length && rows[j].date === date; j++) {
      out.push({ obs: rows[j], pred: expectedGapPct(rows[j].moves, betas), lambda, betas, trainSessions: i });
    }
  }
  return out;
}

export interface GapForecastMetrics {
  n: number;
  /** Mean absolute error of the gap, percent. */
  mae: number;
  /** Root mean squared error of the gap, percent. */
  rmse: number;
  /** Share of rows where the forecast and the gap have the same sign; rows where either is 0 are left out. */
  hitRate: number;
  hitN: number;
  /** OLS slope of the actual gap on the forecast (1 = calibrated, 0.5 = twice too large); NaN for a constant forecast. */
  slope: number;
  intercept: number;
  /** 1 - SSE / sum(actual²): squared error explained against forecasting no gap. */
  r2VsZero: number;
}

export function gapForecastMetrics(points: readonly { actual: number; pred: number }[]): GapForecastMetrics {
  const n = points.length;
  if (n === 0) return { n: 0, mae: NaN, rmse: NaN, hitRate: NaN, hitN: 0, slope: NaN, intercept: NaN, r2VsZero: NaN };
  let abs = 0;
  let sq = 0;
  let sq0 = 0;
  let hits = 0;
  let hitN = 0;
  let mp = 0;
  let ma = 0;
  for (const { actual, pred } of points) {
    const e = actual - pred;
    abs += Math.abs(e);
    sq += e * e;
    sq0 += actual * actual;
    if (actual !== 0 && pred !== 0) {
      hitN++;
      if (Math.sign(actual) === Math.sign(pred)) hits++;
    }
    mp += pred;
    ma += actual;
  }
  mp /= n;
  ma /= n;
  let sxy = 0;
  let sxx = 0;
  for (const { actual, pred } of points) {
    sxy += (pred - mp) * (actual - ma);
    sxx += (pred - mp) * (pred - mp);
  }
  const slope = sxx > 1e-18 * n ? sxy / sxx : NaN;
  return {
    n,
    mae: abs / n,
    rmse: Math.sqrt(sq / n),
    hitRate: hitN > 0 ? hits / hitN : NaN,
    hitN,
    slope,
    intercept: Number.isFinite(slope) ? ma - slope * mp : NaN,
    r2VsZero: sq0 > 0 ? 1 - sq / sq0 : NaN,
  };
}

/** Deterministic PRNG (mulberry32), so bootstrap intervals are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `draws` bootstrap resamples of whole sessions: dates are drawn with replacement and every row of a
 * drawn date is kept (NIFTY and SENSEX of one morning stay together). Returns `stat` of each resample.
 */
export function sessionBootstrap<T extends { date: string }, R>(rows: readonly T[], stat: (sample: T[]) => R, draws: number, seed = 1): R[] {
  const byDate = new Map<string, T[]>();
  for (const r of rows) {
    const arr = byDate.get(r.date);
    if (arr) arr.push(r);
    else byDate.set(r.date, [r]);
  }
  const groups = [...byDate.values()];
  if (groups.length === 0) return [];
  const rnd = mulberry32(seed);
  const out: R[] = [];
  for (let b = 0; b < Math.floor(draws); b++) {
    const sample: T[] = [];
    for (let i = 0; i < groups.length; i++) sample.push(...groups[Math.floor(rnd() * groups.length)]);
    out.push(stat(sample));
  }
  return out;
}
