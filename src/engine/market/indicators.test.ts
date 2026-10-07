import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { mulberry32, normalSampler, sessionFromCloses } from "../__fixtures__/market/loadFixtures";
import {
  atr,
  barsSameSideOfVwap,
  efficiencyRatio,
  ema,
  logReturnsPct,
  olsBeta,
  realizedVolPct,
  ridgeRegression,
  solveLinearSystem,
  trueRanges,
  typicalPrice,
  vwap,
  vwapSeries,
  zScore,
} from "./indicators";

const bar = (o: number, h: number, l: number, c: number, v = 0): Candle => ({ t: 0, o, h, l, c, v });

describe("returns", () => {
  it("logReturnsPct", () => {
    const r = logReturnsPct([100, 101, 100]);
    expect(r[0]).toBeCloseTo(Math.log(1.01) * 100, 12);
    expect(r[1]).toBeCloseTo(Math.log(100 / 101) * 100, 12);
    expect(logReturnsPct([100])).toEqual([]);
    expect(logReturnsPct([0, 100])).toEqual([0]);
  });
});

describe("VWAP", () => {
  it("falls back to equal weights when volume is zero (Yahoo index bars)", () => {
    const bars = [bar(100, 102, 98, 101), bar(101, 104, 100, 103), bar(103, 103, 99, 100)];
    const tps = bars.map(typicalPrice);
    expect(tps[0]).toBeCloseTo((102 + 98 + 101) / 3, 12);
    const s = vwapSeries(bars);
    expect(s[0]).toBeCloseTo(tps[0], 12);
    expect(s[1]).toBeCloseTo((tps[0] + tps[1]) / 2, 12);
    expect(s[2]).toBeCloseTo((tps[0] + tps[1] + tps[2]) / 3, 12);
    expect(vwap(bars)).toBeCloseTo(s[2], 12);
  });

  it("weights by volume when present", () => {
    const bars = [bar(100, 100, 100, 100, 1), bar(110, 110, 110, 110, 3)];
    expect(vwap(bars)).toBeCloseTo((100 * 1 + 110 * 3) / 4, 12);
    // Zero-volume prefix uses equal weights until volume shows up.
    const mixed = [bar(100, 100, 100, 100, 0), bar(110, 110, 110, 110, 2)];
    expect(vwapSeries(mixed)).toEqual([100, 110]);
    expect(vwap([])).toBe(0);
  });

  it("counts consecutive closes on the same side of the running VWAP", () => {
    const up = sessionFromCloses("2026-10-07", [100, 101, 102, 103], 100);
    // The first bar closes exactly on its own VWAP, so only the three later bars count.
    expect(barsSameSideOfVwap(up)).toBe(3);
    const down = sessionFromCloses("2026-10-07", [100, 99, 98], 100);
    expect(barsSameSideOfVwap(down)).toBe(-2);
    expect(barsSameSideOfVwap([bar(100, 100, 100, 100)])).toBe(0);
    expect(barsSameSideOfVwap([])).toBe(0);
    const flip = sessionFromCloses("2026-10-07", [100, 105, 106, 90], 100);
    expect(barsSameSideOfVwap(flip)).toBe(-1);
  });
});

describe("efficiency ratio", () => {
  it("is 1 for a straight line, small for chop, 0 when flat", () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5])).toBe(1);
    expect(efficiencyRatio([1, 3, 1, 3, 1])).toBe(0);
    expect(efficiencyRatio([10, 11, 10, 11, 12])).toBeCloseTo(2 / 4, 12);
    expect(efficiencyRatio([5, 5, 5])).toBe(0);
    expect(efficiencyRatio([5])).toBe(0);
  });
});

describe("true range and ATR", () => {
  it("uses high-low for the first bar and the prior close afterwards", () => {
    const bars = [bar(100, 102, 99, 101), bar(104, 106, 103, 105), bar(105, 105.5, 100, 101), bar(101, 101.5, 100.5, 101)];
    expect(trueRanges(bars)).toEqual([3, 5, 5.5, 1]);
    expect(atr(bars, 2)).toBeCloseTo((5.5 + 1) / 2, 12);
    expect(atr(bars, 10)).toBeCloseTo((3 + 5 + 5.5 + 1) / 4, 12);
    expect(atr([], 12)).toBe(0);
  });
});

describe("realized volatility", () => {
  it("recovers the volatility of a synthetic constant-vol path", () => {
    const z = normalSampler(42);
    const sigmaPerBar = 0.001; // 0.1% per 5 minutes
    const closes = [20000];
    for (let i = 0; i < 20000; i++) closes.push(closes[i] * Math.exp(sigmaPerBar * z()));
    const ppy = 75 * 252;
    const expected = sigmaPerBar * Math.sqrt(ppy) * 100; // 13.75%
    const rv = realizedVolPct(closes, ppy);
    expect(Math.abs(rv / expected - 1)).toBeLessThan(0.02);
  });

  it("matches a hand computation on an alternating path", () => {
    // Returns alternate +-r exactly: sample stdev = r * sqrt(n / (n - 1)).
    const r = 0.5; // percent
    const closes = [100];
    for (let i = 0; i < 10; i++) closes.push(closes[i] * Math.exp(((i % 2 === 0 ? 1 : -1) * r) / 100));
    const n = 10;
    expect(realizedVolPct(closes, 252)).toBeCloseTo(r * Math.sqrt(n / (n - 1)) * Math.sqrt(252), 9);
    expect(realizedVolPct([100, 101], 252)).toBe(0);
  });
});

describe("zScore, ema, olsBeta", () => {
  it("zScore guards small or flat samples", () => {
    expect(zScore(3, [1, 2, 3, 4])).toBe(0);
    expect(zScore(3, [2, 2, 2, 2, 2])).toBe(0);
    const s = [1, 2, 3, 4, 5];
    expect(zScore(5, s)).toBeCloseTo((5 - 3) / Math.sqrt(2.5), 12);
  });

  it("ema seeds with the first value", () => {
    const e = ema([10, 20, 20], 3);
    expect(e[0]).toBe(10);
    expect(e[1]).toBeCloseTo(15, 12);
    expect(e[2]).toBeCloseTo(17.5, 12);
  });

  it("olsBeta recovers a slope with an intercept", () => {
    const x = [1, 2, 3, 4, 5];
    expect(olsBeta(x.map((v) => 3 + 2 * v), x)).toBeCloseTo(2, 12);
    expect(olsBeta([1, 2], [5, 5])).toBe(0);
  });
});

describe("ridge regression", () => {
  it("recovers known betas with a small penalty", () => {
    const rnd = mulberry32(7);
    const beta = [0.45, -0.15, 2.5];
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 300; i++) {
      const row = [rnd() * 2 - 1, rnd() * 4 - 2, (rnd() - 0.5) * 0.2];
      X.push(row);
      y.push(row.reduce((s, v, j) => s + v * beta[j], 0) + (rnd() - 0.5) * 1e-4);
    }
    const b = ridgeRegression(X, y, 1e-6);
    b.forEach((v, j) => expect(v).toBeCloseTo(beta[j], 3));
  });

  it("shrinks toward zero as lambda grows", () => {
    const X = [[1], [2], [3]];
    const y = [2, 4, 6];
    expect(ridgeRegression(X, y, 0)[0]).toBeCloseTo(2, 12);
    // (14 + lambda) beta = 28
    expect(ridgeRegression(X, y, 14)[0]).toBeCloseTo(1, 12);
  });

  it("handles collinear columns without NaN", () => {
    const X = [
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    const b0 = ridgeRegression(X, [1, 2, 3], 0);
    expect(b0.every(Number.isFinite)).toBe(true);
    expect(b0[0] + b0[1]).toBeCloseTo(1, 9);
    const b1 = ridgeRegression(X, [1, 2, 3], 1);
    expect(b1[0]).toBeCloseTo(b1[1], 12);
    expect(ridgeRegression([], [], 1)).toEqual([]);
  });

  it("solveLinearSystem pivots", () => {
    // A zero in the first pivot position forces a row swap. Solution (1, 2, 3).
    const A = [
      [0, 2, 1],
      [1, 1, 1],
      [2, 1, 0],
    ];
    const x = solveLinearSystem(A, [7, 6, 4]);
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(2, 12);
    expect(x[2]).toBeCloseTo(3, 12);
    const rnd = mulberry32(3);
    const B = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => rnd() - 0.5));
    const b = Array.from({ length: 6 }, () => rnd());
    const sol = solveLinearSystem(B, b);
    B.forEach((row, i) => expect(row.reduce((s, v, j) => s + v * sol[j], 0)).toBeCloseTo(b[i], 9));
  });
});
