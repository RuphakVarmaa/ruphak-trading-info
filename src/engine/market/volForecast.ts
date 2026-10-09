/**
 * Realized-variance forecasts for the vol-cheapness gate (WP5).
 *
 * HAR-RV (Corsi 2009, J. Financial Econometrics 7:174-196), on variance levels:
 *
 *   RV[t+1] = b0 + bd * RV[t] + bw * mean(RV[t-4..t]) + bm * mean(RV[t-21..t]) + e,
 *
 * fitted by ordinary least squares. RV is the variance of log returns in percent squared (%² per
 * session) over the regular session only (open to close; the overnight gap is excluded):
 * - `parkinsonVariancePct2`: Parkinson's (1980) range estimator on one daily bar,
 *   (100 ln(H/L))² / (4 ln 2). This is what the engine's gate uses, because it is the only measure
 *   with enough history at run time (production keeps ~6 months of daily bars, backtests 2 years,
 *   while 5-minute bars cover only ~60 days).
 * - `sessionRealizedVariancePct2`: the sum of squared intraday log returns of one session's bars
 *   (used by the research diagnostics on 5-minute and hourly bars).
 *
 * Point-in-time: the forecast for the session dated D uses only sessions dated before D, and the
 * regression is refitted on those sessions only (expanding window). It is therefore fixed at the
 * open and never sees the session it forecasts.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, SESSION, istDate } from "../clock";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type IndexId } from "../types";
import { istDateOf, istMinuteOfDay } from "./candles";
import { solveLinearSystem } from "./indicators";

/** Sessions in the weekly and monthly HAR components. */
export const HAR_WEEK = 5;
export const HAR_MONTH = 22;
/** Fewest regression observations (sessions with a full monthly lag and a next session) for a fit. */
export const HAR_MIN_OBS = 60;
/** Intraday RV default window: 09:15 up to the 15:15 bar (the closing-auction bars are excluded). */
export const RV_FROM_MIN = SESSION.open;
export const RV_TO_MIN = 15 * 60 + 15;

const FOUR_LN2 = 4 * Math.LN2;

/**
 * Parkinson range variance of one bar in %²: (100 ln(H/L))² / (4 ln 2). The range is widened to
 * contain the open and close (a high below the close is a feed inconsistency). Null when unusable.
 */
export function parkinsonVariancePct2(c: Pick<Candle, "o" | "h" | "l" | "c">): number | null {
  const vals = [c.o, c.h, c.l, c.c];
  if (!vals.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const x = 100 * Math.log(hi / lo);
  return (x * x) / FOUR_LN2;
}

/**
 * Realized variance of one session in %²: the sum of squared log returns (percent) of consecutive
 * closes, the first bar contributing open -> close, over bars whose IST open minute lies in
 * [fromMin, toMin). Bars must belong to one session and be sorted. Null with fewer than 2 bars.
 */
export function sessionRealizedVariancePct2(bars: readonly Candle[], fromMin = RV_FROM_MIN, toMin = RV_TO_MIN): number | null {
  let prev: number | null = null;
  let sum = 0;
  let n = 0;
  for (const b of bars) {
    const m = istMinuteOfDay(b.t);
    if (m < fromMin || m >= toMin) continue;
    if (!(b.o > 0 && b.c > 0)) continue;
    const from: number = prev ?? b.o;
    const r = 100 * Math.log(b.c / from);
    sum += r * r;
    prev = b.c;
    n++;
  }
  return n >= 2 ? sum : null;
}

export interface SessionVariance {
  /** IST date of the session. */
  date: string;
  /** Variance of the session's log returns, %². */
  rv: number;
}

/** Parkinson variance of each daily bar dated before `beforeDate` (all when null), ascending by date. */
export function parkinsonSeries(daily: readonly Candle[], beforeDate: string | null = null): SessionVariance[] {
  const byDate = new Map<string, number>();
  for (const c of daily) {
    const d = istDateOf(c.t);
    if (beforeDate !== null && d >= beforeDate) continue;
    const rv = parkinsonVariancePct2(c);
    if (rv !== null) byDate.set(d, rv);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, rv]) => ({ date, rv }));
}

/**
 * Intraday realized variance of each session dated before `beforeDate` (all when null), ascending.
 * Sessions with fewer than `minBars` bars inside the window are skipped (partial data).
 */
export function intradaySeries(
  bars: readonly Candle[],
  beforeDate: string | null = null,
  opts: { fromMin?: number; toMin?: number; minBars?: number } = {},
): SessionVariance[] {
  const groups = new Map<string, Candle[]>();
  for (const b of bars) {
    const d = istDateOf(b.t);
    if (beforeDate !== null && d >= beforeDate) continue;
    const g = groups.get(d);
    if (g) g.push(b);
    else groups.set(d, [b]);
  }
  const fromMin = opts.fromMin ?? RV_FROM_MIN;
  const toMin = opts.toMin ?? RV_TO_MIN;
  const out: SessionVariance[] = [];
  for (const [date, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    g.sort((a, b) => a.t - b.t);
    const inside = g.filter((b) => {
      const m = istMinuteOfDay(b.t);
      return m >= fromMin && m < toMin;
    }).length;
    if (inside < (opts.minBars ?? 2)) continue;
    const rv = sessionRealizedVariancePct2(g, fromMin, toMin);
    if (rv !== null) out.push({ date, rv });
  }
  return out;
}

/** HAR regressors at position t: [RV_t, weekly mean, monthly mean]. Null before a full month of lags. */
export function harRegressors(rv: readonly number[], t: number): [number, number, number] | null {
  if (t < HAR_MONTH - 1 || t >= rv.length) return null;
  let w = 0;
  let m = 0;
  for (let i = 0; i < HAR_MONTH; i++) {
    const x = rv[t - i];
    if (i < HAR_WEEK) w += x;
    m += x;
  }
  return [rv[t], w / HAR_WEEK, m / HAR_MONTH];
}

export interface HarFit {
  b0: number;
  bd: number;
  bw: number;
  bm: number;
  /** Regression observations. */
  n: number;
  /** In-sample R². */
  r2: number;
}

/** Accumulates X'X and X'y of the HAR regression one observation at a time (expanding window). */
class HarAccumulator {
  readonly xtx: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  readonly xty = [0, 0, 0, 0];
  n = 0;
  sumY = 0;
  sumYY = 0;

  add(x: readonly number[], y: number): void {
    const row = [1, x[0], x[1], x[2]];
    for (let i = 0; i < 4; i++) {
      this.xty[i] += row[i] * y;
      for (let j = 0; j < 4; j++) this.xtx[i][j] += row[i] * row[j];
    }
    this.n++;
    this.sumY += y;
    this.sumYY += y * y;
  }

  /** OLS coefficients and in-sample R² (from the normal equations); null below `minObs`. */
  fit(minObs: number): HarFit | null {
    if (this.n < Math.max(minObs, 5)) return null;
    const b = solveLinearSystem(this.xtx, this.xty);
    if (!b.every(Number.isFinite)) return null;
    // SSE = y'y - 2 b'X'y + b'X'X b
    let bxty = 0;
    let bxxb = 0;
    for (let i = 0; i < 4; i++) {
      bxty += b[i] * this.xty[i];
      for (let j = 0; j < 4; j++) bxxb += b[i] * this.xtx[i][j] * b[j];
    }
    const sse = Math.max(0, this.sumYY - 2 * bxty + bxxb);
    const sst = this.sumYY - (this.sumY * this.sumY) / this.n;
    return { b0: b[0], bd: b[1], bw: b[2], bm: b[3], n: this.n, r2: sst > 0 ? 1 - sse / sst : 0 };
  }
}

/** OLS fit of the HAR regression on the whole series; null with fewer than `minObs` observations. */
export function fitHar(rv: readonly number[], minObs = HAR_MIN_OBS): HarFit | null {
  const acc = new HarAccumulator();
  for (let t = HAR_MONTH - 1; t + 1 < rv.length; t++) acc.add(harRegressors(rv, t)!, rv[t + 1]);
  return acc.fit(minObs);
}

/** Forecast of the session after the last element of `rv`. Null without a full month of history. */
export function harForecast(fit: HarFit, rv: readonly number[]): number | null {
  const x = harRegressors(rv, rv.length - 1);
  if (!x) return null;
  const f = fit.b0 + fit.bd * x[0] + fit.bw * x[1] + fit.bm * x[2];
  return Number.isFinite(f) ? f : null;
}

export interface OosPoint {
  /** Position in the series of the session forecast. */
  t: number;
  actual: number;
  /** HAR forecast fitted on sessions before t only. */
  forecast: number;
  /** Benchmark: mean of all sessions before t. */
  mean: number;
  /** Benchmark: the previous session's RV (random walk). */
  last: number;
}

/**
 * Expanding-window out-of-sample forecasts: for each session t, the regression is fitted on the
 * observations whose target lies before t (so nothing from t or later), then t is forecast.
 */
export function harOutOfSample(rv: readonly number[], minObs = HAR_MIN_OBS): OosPoint[] {
  const out: OosPoint[] = [];
  const acc = new HarAccumulator();
  let sum = 0;
  for (let t = 0; t < rv.length; t++) {
    // Observation with target t-1 (regressors at t-2) becomes available once t-1 is known.
    if (t - 2 >= HAR_MONTH - 1) acc.add(harRegressors(rv, t - 2)!, rv[t - 1]);
    if (t > 0) sum += rv[t - 1];
    const x = harRegressors(rv, t - 1);
    const fit = x ? acc.fit(minObs) : null;
    if (x && fit) {
      out.push({ t, actual: rv[t], forecast: fit.b0 + fit.bd * x[0] + fit.bw * x[1] + fit.bm * x[2], mean: sum / t, last: rv[t - 1] });
    }
  }
  return out;
}

/** Out-of-sample R² of the HAR forecasts against a benchmark: 1 - SSE(HAR) / SSE(benchmark). */
export function oosR2(points: readonly OosPoint[], benchmark: "mean" | "last" = "mean"): number {
  let sse = 0;
  let sseB = 0;
  for (const p of points) {
    sse += (p.actual - p.forecast) ** 2;
    sseB += (p.actual - p[benchmark]) ** 2;
  }
  return sseB > 0 ? 1 - sse / sseB : 0;
}

/** Variance per session (%²) charged by an annualized implied vol given as a decimal. */
export function impliedSessionVariancePct2(vol: number, tradingDaysPerYear: number): number {
  const v = 100 * vol;
  return Number.isFinite(v) && v > 0 && tradingDaysPerYear > 0 ? (v * v) / tradingDaysPerYear : 0;
}

export interface VolForecast {
  index: IndexId;
  /** IST date of the session forecast. */
  date: string;
  /** Latest session the forecast used. */
  lastSession: string;
  /** Forecast realized variance of the session, %² (Parkinson scale). */
  forecastPct2: number;
  fit: HarFit;
  measure: "parkinson";
}

/** HAR-RV forecast of session `date` from daily bars (only bars dated before `date` are used). */
export function forecastFromDaily(index: IndexId, daily: readonly Candle[], date: string, minObs = HAR_MIN_OBS): VolForecast | null {
  const series = parkinsonSeries(daily, date);
  const rv = series.map((s) => s.rv);
  const fit = fitHar(rv, minObs);
  if (!fit) return null;
  const f = harForecast(fit, rv);
  if (f === null) return null;
  return { index, date, lastSession: series[series.length - 1].date, forecastPct2: f, fit, measure: "parkinson" };
}

/** A forecast missing the previous session (daily data published late) is recomputed after this. */
const INCOMPLETE_RETRY_MS = 5 * MINUTE_MS;
const cache = new WeakMap<MarketDataSource, Map<string, { at: number; value: VolForecast | null; complete: boolean }>>();

/**
 * Today's HAR-RV forecast for `index`, from the daily bars of `market`'s point-in-time snapshot.
 * Computed once per data source, index and IST date (a forecast built before the previous
 * session's daily bar arrived is retried every few minutes). Never throws: null when the data is
 * missing or too short, so the caller can fail closed.
 */
export async function sessionVolForecast(
  market: MarketDataSource | undefined,
  index: IndexId,
  t: number,
  calendar: TradingCalendar,
): Promise<VolForecast | null> {
  if (!market) return null;
  const date = istDate(t);
  let byKey = cache.get(market);
  if (!byKey) cache.set(market, (byKey = new Map()));
  const key = `${index}|${date}`;
  const hit = byKey.get(key);
  if (hit && (hit.complete || t - hit.at < INCOMPLETE_RETRY_MS)) return hit.value;
  let value: VolForecast | null = null;
  let complete = false;
  try {
    const snap = await market.snapshot(t);
    value = forecastFromDaily(index, snap.daily[MARKET_SYMBOLS[index]] ?? [], date);
    let prev: string | null = null;
    try {
      prev = calendar.prevTradingDay(date);
    } catch {
      prev = null;
    }
    complete = value !== null && (prev === null || value.lastSession >= prev);
  } catch {
    value = null;
  }
  byKey.set(key, { at: t, value, complete });
  return value;
}
