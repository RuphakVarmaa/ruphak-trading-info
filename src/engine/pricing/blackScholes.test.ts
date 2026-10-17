import { describe, expect, it } from "vitest";
import { bsGreeks, bsPrice, impliedVol, normCdf, normPdf, type BsInput } from "./blackScholes";

describe("normal distribution", () => {
  // Reference: 0.5 * erfc(-x / sqrt(2)) in double precision (Python math.erfc).
  const ref: [number, number][] = [
    [0, 0.5],
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [1.96, 0.9750021048517795],
    [-1.96, 0.024997895148220435],
    [2.5, 0.9937903346742238],
    [-3, 0.0013498980316300957],
    [3, 0.9986501019683699],
    [-4.5, 3.3976731247300615e-6],
    [-6, 9.865876450377012e-10],
    [-8, 6.220960574271819e-16],
    [-10, 7.619853024160593e-24],
    [7.5, 0.9999999999999681],
  ];

  it("normCdf is accurate to well under 1e-7 (absolute), and relatively accurate in the tails", () => {
    for (const [x, v] of ref) {
      expect(Math.abs(normCdf(x) - v)).toBeLessThan(1e-14);
      // Relative error stays ~1e-9 even deep in the tail (x = -10: value 7.6e-24).
      if (v > 0) expect(Math.abs(normCdf(x) - v) / v).toBeLessThan(1e-8);
    }
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(40)).toBe(1);
    expect(Number.isNaN(normCdf(NaN))).toBe(true);
  });

  it("is symmetric and matches the pdf derivative", () => {
    for (const x of [-3.3, -1.2, 0.01, 0.7, 2.2, 6.9, 7.2]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 14);
      const h = 1e-5;
      expect((normCdf(x + h) - normCdf(x - h)) / (2 * h)).toBeCloseTo(normPdf(x), 8);
    }
    expect(normPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 15);
  });
});

describe("Black-Scholes", () => {
  const base = { spot: 100, strike: 100, tYears: 1, vol: 0.2, r: 0.05 };

  it("matches textbook values", () => {
    expect(bsPrice({ ...base, type: "CE" })).toBeCloseTo(10.4506, 4);
    expect(bsPrice({ ...base, type: "PE" })).toBeCloseTo(5.5735, 4);
    const g = bsGreeks({ ...base, type: "CE" });
    expect(g.delta).toBeCloseTo(0.6368, 4);
    expect(g.gamma).toBeCloseTo(0.018762, 6);
    expect(g.vega).toBeCloseTo(37.524, 3);
    expect(g.thetaPerYear).toBeCloseTo(-6.414, 3);
    expect(g.thetaPerDay).toBeCloseTo(-6.414 / 252, 5);
  });

  it("satisfies put-call parity", () => {
    for (const [spot, strike, tYears, vol, r] of [
      [22600, 22650, 4 / 252, 0.14, 0.065],
      [72600, 72000, 1 / 252, 0.16, 0.065],
      [100, 130, 0.5, 0.45, 0.02],
    ]) {
      const c = bsPrice({ spot, strike, tYears, vol, r, type: "CE" });
      const p = bsPrice({ spot, strike, tYears, vol, r, type: "PE" });
      expect(c - p).toBeCloseTo(spot - strike * Math.exp(-r * tYears), 8);
    }
  });

  it("keeps deltas in range and greeks consistent with finite differences", () => {
    for (const strike of [21000, 22000, 22600, 23200, 24000]) {
      const i: BsInput = { spot: 22600, strike, tYears: 3 / 252, vol: 0.14, r: 0.065, type: "CE" };
      const c = bsGreeks(i);
      const p = bsGreeks({ ...i, type: "PE" });
      expect(c.delta).toBeGreaterThanOrEqual(0);
      expect(c.delta).toBeLessThanOrEqual(1);
      expect(p.delta).toBeGreaterThanOrEqual(-1);
      expect(p.delta).toBeLessThanOrEqual(0);
      expect(c.delta - p.delta).toBeCloseTo(1, 12);
      expect(c.gamma).toBeCloseTo(p.gamma, 12);
      const h = 0.01;
      expect((bsPrice({ ...i, spot: i.spot + h }) - bsPrice({ ...i, spot: i.spot - h })) / (2 * h)).toBeCloseTo(c.delta, 5);
      expect((bsPrice({ ...i, vol: i.vol + 1e-5 }) - bsPrice({ ...i, vol: i.vol - 1e-5 })) / 2e-5).toBeCloseTo(c.vega, 2);
      const dt = 1e-6;
      expect((bsPrice({ ...i, tYears: i.tYears - dt }) - bsPrice({ ...i, tYears: i.tYears + dt })) / (2 * dt)).toBeCloseTo(c.thetaPerYear, 0);
    }
    // ATM call delta is a bit above 0.5; deep ITM call ~1, deep OTM ~0.
    expect(bsGreeks({ spot: 22600, strike: 22600, tYears: 3 / 252, vol: 0.14, r: 0.065, type: "CE" }).delta).toBeGreaterThan(0.5);
    expect(bsGreeks({ spot: 22600, strike: 20000, tYears: 3 / 252, vol: 0.14, r: 0.065, type: "CE" }).delta).toBeGreaterThan(0.999);
    expect(bsGreeks({ spot: 22600, strike: 26000, tYears: 3 / 252, vol: 0.14, r: 0.065, type: "CE" }).delta).toBeLessThan(0.001);
  });

  it("returns intrinsic value at expiry or zero vol", () => {
    expect(bsPrice({ ...base, spot: 105, tYears: 0, type: "CE" })).toBe(5);
    expect(bsPrice({ ...base, spot: 105, tYears: 0, type: "PE" })).toBe(0);
    expect(bsPrice({ ...base, spot: 95, vol: 0, type: "PE" })).toBe(5);
    expect(bsPrice({ ...base, tYears: -1, type: "CE" })).toBe(0);
    const g = bsGreeks({ ...base, spot: 105, tYears: 0, type: "CE" });
    expect(g).toEqual({ price: 5, delta: 1, gamma: 0, vega: 0, thetaPerYear: 0, thetaPerDay: 0 });
    expect(bsGreeks({ ...base, tYears: 0, type: "PE" }).delta).toBe(-0.5);
    expect(bsGreeks({ ...base, spot: 120, tYears: 0, type: "PE" }).delta).toBe(0);
  });

  it("produces a sane NIFTY weekly ATM premium", () => {
    // NIFTY 22,600, VIX 14, 4 trading days: ATM straddle ~ 0.8 * S * sigma * sqrt(T) ~ 400.
    const i = { spot: 22600, strike: 22600, tYears: 4 / 252, vol: 0.14, r: 0.065 };
    const straddle = bsPrice({ ...i, type: "CE" }) + bsPrice({ ...i, type: "PE" });
    expect(straddle).toBeGreaterThan(0.75 * 22600 * 0.14 * Math.sqrt(4 / 252));
    expect(straddle).toBeLessThan(0.85 * 22600 * 0.14 * Math.sqrt(4 / 252));
  });
});

describe("impliedVol", () => {
  it("round-trips prices across strikes, expiries and vols", () => {
    for (const type of ["CE", "PE"] as const) {
      for (const strike of [21500, 22400, 22600, 22800, 23800]) {
        for (const tYears of [0.5 / 252, 3 / 252, 30 / 252]) {
          for (const vol of [0.08, 0.14, 0.35, 1.2]) {
            const i = { spot: 22600, strike, tYears, r: 0.065, type };
            const price = bsPrice({ ...i, vol });
            // Vol is not identifiable when its time value is below one tick (deep ITM/OTM, short-dated).
            if (price - bsPrice({ ...i, vol: 0.01 }) < 0.05) continue;
            const iv = impliedVol(price, i);
            expect(iv, `${type} K=${strike} T=${tYears} vol=${vol}`).not.toBeNull();
            expect(bsPrice({ ...i, vol: iv! })).toBeCloseTo(price, 6);
            expect(iv!).toBeCloseTo(vol, 4);
          }
        }
      }
    }
    expect(impliedVol(10.450583572185565, { spot: 100, strike: 100, tYears: 1, r: 0.05, type: "CE" })).toBeCloseTo(0.2, 9);
  });

  it("returns null outside [0.01, 3] or for degenerate inputs", () => {
    const i = { spot: 100, strike: 100, tYears: 1, r: 0.05, type: "CE" as const };
    expect(impliedVol(1.5, i)).toBeNull(); // below the vol=0.01 price (~4.9 from carry alone)
    expect(impliedVol(99.9, i)).toBeNull(); // above the vol=3 price
    expect(impliedVol(10, { ...i, tYears: 0 })).toBeNull();
    expect(impliedVol(Number.NaN, i)).toBeNull();
  });
});
