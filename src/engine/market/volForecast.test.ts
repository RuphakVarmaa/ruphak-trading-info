import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, istAt, weekdayOf } from "../clock";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type MarketSnapshot } from "../types";
import { ReplayMarketDataSource } from "./replayMarketData";
import {
  HAR_MIN_OBS,
  HAR_MONTH,
  fitHar,
  forecastFromDaily,
  harForecast,
  harOutOfSample,
  harRegressors,
  impliedSessionVariancePct2,
  intradaySeries,
  oosR2,
  parkinsonSeries,
  parkinsonVariancePct2,
  sessionRealizedVariancePct2,
  sessionVolForecast,
} from "./volForecast";

const cal = new TradingCalendar();

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A series following a known HAR process with positive multiplicative noise. */
function harSeries(n: number, b: [number, number, number, number], seed = 1): number[] {
  const r = rng(seed);
  const rv: number[] = Array.from({ length: HAR_MONTH }, () => 0.3 + 0.2 * r());
  while (rv.length < n) {
    const x = harRegressors(rv, rv.length - 1)!;
    const mu = b[0] + b[1] * x[0] + b[2] * x[1] + b[3] * x[2];
    rv.push(mu * (0.5 + r())); // mean-one noise in [0.5, 1.5)
  }
  return rv;
}

/** Weekday dates ending the day before `before`, ascending. */
function weekdaysBefore(before: string, n: number): string[] {
  const out: string[] = [];
  for (let d = addDays(before, -1); out.length < n; d = addDays(d, -1)) if (weekdayOf(d) <= 5) out.unshift(d);
  return out;
}

/** Daily bars whose Parkinson variance is `rv[i]` (open = close = 100 inside the range). */
function dailyBars(dates: string[], rv: number[]): Candle[] {
  return dates.map((d, i) => {
    const range = Math.sqrt(rv[i] * 4 * Math.LN2) / 100; // ln(H/L)
    const l = 100 * Math.exp(-range / 2);
    const h = 100 * Math.exp(range / 2);
    return { t: istAt(d, "09:15"), o: 100, h, l, c: 100, v: 0 };
  });
}

describe("realized-variance measures", () => {
  it("Parkinson: (100 ln(H/L))² / (4 ln 2), with the range widened to the open and close", () => {
    expect(parkinsonVariancePct2({ o: 100, h: 101, l: 100, c: 100.5 })).toBeCloseTo((100 * Math.log(1.01)) ** 2 / (4 * Math.LN2), 12);
    // A high printed below the close: the close bounds the range.
    expect(parkinsonVariancePct2({ o: 100, h: 100.5, l: 100, c: 101 })).toBeCloseTo((100 * Math.log(1.01)) ** 2 / (4 * Math.LN2), 12);
    expect(parkinsonVariancePct2({ o: 100, h: 0, l: 100, c: 100 })).toBeNull();
    expect(parkinsonVariancePct2({ o: 100, h: NaN, l: 99, c: 100 })).toBeNull();
  });

  it("intraday RV sums squared log returns (first bar open -> close) and leaves out the closing-auction bars", () => {
    const d = "2026-10-07";
    const bar = (hhmm: string, o: number, c: number): Candle => ({ t: istAt(d, hhmm), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0 });
    const bars = [bar("09:15", 100, 101), bar("09:20", 101, 100), bar("09:25", 100, 102), bar("15:15", 102, 110), bar("15:20", 110, 90)];
    const want = (100 * Math.log(1.01)) ** 2 + (100 * Math.log(100 / 101)) ** 2 + (100 * Math.log(1.02)) ** 2;
    expect(sessionRealizedVariancePct2(bars)).toBeCloseTo(want, 12);
    // The window is configurable: including 15:15-15:30 adds the auction prints.
    expect(sessionRealizedVariancePct2(bars, 9 * 60 + 15, 15 * 60 + 30)!).toBeGreaterThan(want + 50);
    expect(sessionRealizedVariancePct2([bars[0]])).toBeNull();
  });

  it("series builders keep only sessions dated before the cutoff, ascending", () => {
    const dates = weekdaysBefore("2026-10-07", 5);
    const daily = dailyBars(dates, [0.1, 0.2, 0.3, 0.4, 0.5]).reverse();
    const s = parkinsonSeries(daily, dates[3]);
    expect(s.map((x) => x.date)).toEqual(dates.slice(0, 3));
    expect(s.map((x) => x.rv)).toEqual([0.1, 0.2, 0.3].map((v) => expect.closeTo(v, 10)));
    const intraday = dates.flatMap((d) => [0, 5, 10].map((m) => ({ t: istAt(d, 9 * 60 + 15 + m), o: 100, h: 101, l: 99, c: 100 + m / 10, v: 0 })));
    expect(intradaySeries(intraday, dates[2]).map((x) => x.date)).toEqual(dates.slice(0, 2));
    expect(intradaySeries(intraday, null, { minBars: 4 })).toEqual([]);
  });

  it("implied session variance = (100 vol)² / trading days", () => {
    expect(impliedSessionVariancePct2(0.16, 252)).toBeCloseTo(256 / 252, 12);
    expect(impliedSessionVariancePct2(0, 252)).toBe(0);
    expect(impliedSessionVariancePct2(NaN, 252)).toBe(0);
  });
});

describe("HAR-RV", () => {
  const truth: [number, number, number, number] = [0.05, 0.3, 0.3, 0.25];

  it("regressors are the last value, the 5-session mean and the 22-session mean", () => {
    const rv = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(harRegressors(rv, 20)).toBeNull();
    expect(harRegressors(rv, 29)).toEqual([30, (26 + 27 + 28 + 29 + 30) / 5, (9 + 30) / 2]);
  });

  it("OLS recovers the coefficients of a known HAR process", () => {
    const rv = harSeries(6000, truth, 3);
    const fit = fitHar(rv)!;
    expect(fit.n).toBe(6000 - HAR_MONTH);
    expect(fit.bd).toBeCloseTo(truth[1], 1);
    expect(fit.bw).toBeCloseTo(truth[2], 1);
    expect(fit.bm).toBeCloseTo(truth[3], 1);
    expect(fit.r2).toBeGreaterThan(0);
    expect(fit.r2).toBeLessThan(1);
    const f = harForecast(fit, rv)!;
    const x = harRegressors(rv, rv.length - 1)!;
    expect(f).toBeCloseTo(fit.b0 + fit.bd * x[0] + fit.bw * x[1] + fit.bm * x[2], 12);
  });

  it("needs a minimum number of observations", () => {
    const rv = harSeries(HAR_MONTH + HAR_MIN_OBS, truth);
    expect(fitHar(rv.slice(0, -1))).toBeNull();
    expect(fitHar(rv)).not.toBeNull();
  });

  it("out-of-sample forecasts never use the session forecast or later ones", () => {
    const rv = harSeries(400, truth, 5);
    const base = harOutOfSample(rv);
    expect(base[0].t).toBe(HAR_MONTH + HAR_MIN_OBS);
    const cut = 250;
    const shocked = rv.map((x, i) => (i >= cut ? x * 50 : x));
    const after = harOutOfSample(shocked);
    for (const p of base.filter((x) => x.t <= cut)) {
      const q = after.find((x) => x.t === p.t)!;
      expect(q.forecast).toBe(p.forecast);
      expect(q.mean).toBe(p.mean);
      expect(q.last).toBe(p.last);
    }
    // Each forecast equals a fit on the sessions before it.
    const p = base.find((x) => x.t === 300)!;
    expect(p.forecast).toBeCloseTo(harForecast(fitHar(rv.slice(0, 300))!, rv.slice(0, 300))!, 9);
  });

  it("R² out of sample: 1 for perfect forecasts, about 0 for the benchmark itself", () => {
    const pts = [1, 2, 3].map((v, t) => ({ t, actual: v, forecast: v, mean: 2, last: v - 1 }));
    expect(oosR2(pts)).toBe(1);
    expect(oosR2(pts.map((p) => ({ ...p, forecast: p.mean })))).toBe(0);
    expect(oosR2(harOutOfSample(harSeries(1500, truth, 9)))).toBeGreaterThan(0);
  });
});

describe("the day's forecast from daily bars", () => {
  const date = "2026-10-07";
  const dates = weekdaysBefore(date, 150);
  const rv = harSeries(150, [0.05, 0.3, 0.3, 0.25], 11);

  it("uses only bars dated before the session it forecasts", () => {
    const daily = dailyBars(dates, rv);
    const fc = forecastFromDaily("NIFTY", daily, date)!;
    expect(fc.lastSession).toBe(dates.at(-1));
    expect(fc.fit.n).toBe(150 - HAR_MONTH);
    // A bar for the session itself (or later) changes nothing.
    const withToday = [...daily, ...dailyBars([date, addDays(date, 1)], [50, 50])];
    expect(forecastFromDaily("NIFTY", withToday, date)).toEqual(fc);
    expect(forecastFromDaily("NIFTY", daily.slice(0, HAR_MONTH + HAR_MIN_OBS - 1), date)).toBeNull();
  });

  it("reads the point-in-time snapshot once per index and day, and fails soft", async () => {
    const daily = { [MARKET_SYMBOLS.NIFTY]: dailyBars(dates, rv), [MARKET_SYMBOLS.SENSEX]: dailyBars(dates, rv.map((x) => 2 * x)) };
    const src = new ReplayMarketDataSource({ candles: {}, daily });
    let calls = 0;
    const market: MarketDataSource = {
      snapshot: (t: number): Promise<MarketSnapshot> => {
        calls++;
        return src.snapshot(t);
      },
    };
    const a = await sessionVolForecast(market, "NIFTY", istAt(date, "09:30"), cal);
    const b = await sessionVolForecast(market, "NIFTY", istAt(date, "14:00"), cal);
    expect(a).toEqual(forecastFromDaily("NIFTY", daily[MARKET_SYMBOLS.NIFTY], date));
    expect(b).toBe(a);
    expect(calls).toBe(1);
    const s = await sessionVolForecast(market, "SENSEX", istAt(date, "09:30"), cal);
    expect(s!.forecastPct2).not.toBe(a!.forecastPct2);
    expect(calls).toBe(2);
    expect(await sessionVolForecast(undefined, "NIFTY", istAt(date, "09:30"), cal)).toBeNull();
    const broken: MarketDataSource = { snapshot: () => Promise.reject(new Error("feed down")) };
    expect(await sessionVolForecast(broken, "NIFTY", istAt(date, "09:30"), cal)).toBeNull();
  });

  it("retries a forecast built before the previous session's daily bar arrived", async () => {
    let daily = dailyBars(dates.slice(0, -1), rv.slice(0, -1)); // the last session is missing
    let calls = 0;
    const market: MarketDataSource = {
      snapshot: async (t: number): Promise<MarketSnapshot> => {
        calls++;
        return { t, candles: {}, daily: { [MARKET_SYMBOLS.NIFTY]: daily }, ltp: {}, dataAgeSec: 0 };
      },
    };
    const first = await sessionVolForecast(market, "NIFTY", istAt(date, "09:20"), cal);
    expect(first!.lastSession).toBe(dates.at(-2));
    // Within five minutes the incomplete forecast is reused; after that it is rebuilt.
    expect(await sessionVolForecast(market, "NIFTY", istAt(date, "09:22"), cal)).toBe(first);
    daily = dailyBars(dates, rv);
    const later = await sessionVolForecast(market, "NIFTY", istAt(date, "09:26"), cal);
    expect(later!.lastSession).toBe(dates.at(-1));
    expect(calls).toBe(2);
    await sessionVolForecast(market, "NIFTY", istAt(date, "10:30"), cal);
    expect(calls).toBe(2);
  });
});
