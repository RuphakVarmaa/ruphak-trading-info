import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig, withOverrides } from "../config";
import { bsGreeks, bsPrice } from "../pricing/blackScholes";
import type { HarFit, VolForecast } from "../market/volForecast";
import type { OptionContract } from "../types";
import { calibratedEdge, edgeGates, evaluateEdge, volCheapnessGate, type EdgeInput } from "./gates";
import { sigmaPct } from "./signals";

const T = istAt("2026-10-07", "11:00");
const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1325000CE",
  growwSymbol: "NSE-NIFTY-13Oct26-25000-CE",
  exchangeToken: "1",
  expiry: "2026-10-13",
  strike: 25_000,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
  freezeQty: 1755,
};
const base: EdgeInput = { spot: 25_000, premium: 153, bid: 152.6, contract, tYears: 3 / 252, vol: 0.14, score: 0.6, horizonMin: 120, t: T };
const calibrated = (realizedVolFactor: number, scoreMoveBeta: number, extra: Parameters<typeof withOverrides>[1] = {}) =>
  withOverrides(withOverrides(DEFAULT_CONFIG, extra), { gates: { expectedMoveModel: "calibrated", realizedVolFactor, scoreMoveBeta } });
const allPass = (gs: { passed: boolean | null }[]) => gs.every((g) => g.passed !== false);

describe("edge gate: legacy model (the default) is unchanged", () => {
  it("defaults keep the legacy model and the vol-cheapness gate off", () => {
    expect(DEFAULT_CONFIG.gates.expectedMoveModel).toBe("legacy");
    expect(DEFAULT_CONFIG.gates.volCheapness).toEqual({ enabled: false, k: 1 });
  });

  it("returns only the two legacy rows and no calibrated numbers", () => {
    const e = evaluateEdge(base, DEFAULT_CONFIG);
    expect(e.calibrated).toBeUndefined();
    expect(edgeGates(e, DEFAULT_CONFIG).map((g) => g.gate)).toEqual(["edge_ratio", "expected_vs_implied"]);
    // The design worked example: |score| × kEM × VIX sigma × 1.1.
    expect(e.expectedMovePct).toBeCloseTo(0.6 * 1.0 * 14 * Math.sqrt(120 / (252 * 375)) * 1.1, 9);
  });
});

describe("edge gate: calibrated model (WP2)", () => {
  it("keeps every legacy number and row, and appends the two calibrated checks", () => {
    const legacy = evaluateEdge(base, DEFAULT_CONFIG);
    const cfg = calibrated(0.54, 0.2);
    const e = evaluateEdge(base, cfg);
    const { calibrated: cal, ...rest } = e;
    expect(rest).toEqual(legacy);
    const rows = edgeGates(e, cfg);
    expect(rows.slice(0, 2)).toEqual(edgeGates(legacy, DEFAULT_CONFIG));
    expect(rows.map((g) => g.gate)).toEqual(["edge_ratio", "expected_vs_implied", "edge_calibrated", "move_calibrated"]);
    expect(cal).toBeDefined();
  });

  it("prices the expected move, convexity, theta and costs as documented", () => {
    const f = 0.54;
    const beta = 0.2;
    const cfg = calibrated(f, beta);
    const e = evaluateEdge(base, cfg);
    const g = bsGreeks({ spot: base.spot, strike: contract.strike, tYears: base.tYears, vol: base.vol, r: cfg.pricing.r, type: "CE" });
    const realized = sigmaPct(14, 120, cfg) * f;
    const expected = beta * 0.6 * realized;
    const convexity = 0.5 * g.gamma * ((realized / 100) * base.spot) ** 2;
    const edge = Math.abs(g.delta) * (expected / 100) * base.spot + convexity - e.thetaOverHorizon - e.costsPerUnit;
    expect(e.calibrated!.realizedMovePct).toBeCloseTo(realized, 12);
    expect(e.calibrated!.expectedMovePct).toBeCloseTo(expected, 12);
    expect(e.calibrated!.convexityPerUnit).toBeCloseTo(convexity, 9);
    expect(e.calibrated!.edgePerUnit).toBeCloseTo(edge, 9);
    expect(e.calibrated!.edgeRatio).toBeCloseTo(edge / base.premium, 12);
  });

  it("with no measured directional skill (beta 0) and realized vol below implied, theta wins: blocked", () => {
    const cfg = calibrated(0.54, 0);
    const e = evaluateEdge(base, cfg);
    // Convexity recovers about f² of the time decay (Black-Scholes: θ = ½ Γ S² σ² per unit time).
    expect(e.calibrated!.convexityPerUnit / e.thetaOverHorizon).toBeGreaterThan(0.2);
    expect(e.calibrated!.convexityPerUnit / e.thetaOverHorizon).toBeLessThan(0.4);
    expect(e.calibrated!.edgeRatio).toBeLessThan(0);
    const rows = edgeGates(e, cfg);
    expect(rows.find((g) => g.gate === "edge_calibrated")!.passed).toBe(false);
    expect(rows.find((g) => g.gate === "move_calibrated")!.passed).toBe(false);
  });

  it("a negative beta means an expected move against the trade", () => {
    const e = evaluateEdge(base, calibrated(0.54, -0.1));
    expect(e.calibrated!.expectedMovePct).toBeLessThan(0);
  });

  it("is linear in beta (so the beta needed to pass is well defined)", () => {
    const at = (b: number) => evaluateEdge(base, calibrated(0.54, b)).calibrated!.edgeRatio;
    expect(at(1) - at(0)).toBeCloseTo(at(2) - at(1), 12);
    expect(at(1) - at(0)).toBeGreaterThan(0);
  });

  it("can only block: never passes a decision the legacy gates reject (randomized)", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let calibratedPasses = 0;
    let legacyRejects = 0;
    for (let i = 0; i < 2000; i++) {
      const spot = 24_000 + 2_000 * rnd();
      const strike = Math.round(spot / 50) * 50 + 50 * Math.round(4 * rnd() - 2);
      const vol = 0.08 + 0.2 * rnd();
      const tYears = (0.2 + 5 * rnd()) / 252;
      const type = rnd() < 0.5 ? "CE" : "PE";
      const mid = bsPrice({ spot, strike, tYears, vol, r: DEFAULT_CONFIG.pricing.r, type });
      if (!(mid > 1)) continue;
      const input: EdgeInput = {
        spot,
        premium: mid + 0.2,
        bid: mid - 0.2,
        contract: { ...contract, strike, type },
        tYears,
        vol,
        score: (rnd() < 0.5 ? -1 : 1) * rnd(),
        horizonMin: 5 + Math.floor(175 * rnd()),
        t: T,
      };
      // Even absurdly optimistic calibrations (beta up to 10, realized vol up to 3× implied).
      const extra = { gates: { minEdgeRatio: -0.2 + 0.4 * rnd(), minExpectedVsImplied: rnd(), kEM: 0.2 + 1.5 * rnd() } };
      const cfg = calibrated(0.2 + 2.8 * rnd(), -2 + 12 * rnd(), extra);
      const legacyCfg = withOverrides(DEFAULT_CONFIG, extra);
      const legacyOk = allPass(edgeGates(evaluateEdge(input, legacyCfg), legacyCfg));
      const calOk = allPass(edgeGates(evaluateEdge(input, cfg), cfg));
      if (calOk) {
        calibratedPasses++;
        expect(legacyOk).toBe(true);
      }
      if (!legacyOk) legacyRejects++;
    }
    // The property was exercised on both sides.
    expect(calibratedPasses).toBeGreaterThan(50);
    expect(legacyRejects).toBeGreaterThan(50);
  });

  it("calibratedEdge is usable on its own (shared by the research script)", () => {
    const cfg = calibrated(0.5, 0);
    const c = calibratedEdge(base, { delta: 0.5, gamma: 0.0004, thetaOverHorizon: 10, costsPerUnit: 1 }, cfg);
    expect(c.edgePerUnit).toBeCloseTo(0.5 * 0.0004 * ((c.realizedMovePct / 100) * base.spot) ** 2 - 11, 9);
  });
});

describe("config validation for the WP2/WP5 flags", () => {
  it("rejects an unknown model, a non-positive vol factor, a non-finite beta and a bad k", () => {
    expect(() => makeConfig({ gates: { expectedMoveModel: "calibrate" as "calibrated" } })).toThrow(/expectedMoveModel/);
    expect(() => makeConfig({ gates: { realizedVolFactor: 0 } })).toThrow(/realizedVolFactor/);
    expect(() => makeConfig({ gates: { scoreMoveBeta: NaN } })).toThrow(/scoreMoveBeta/);
    expect(() => makeConfig({ gates: { volCheapness: { k: 0 } } })).toThrow(/volCheapness\.k/);
    expect(makeConfig({ gates: { scoreMoveBeta: -0.5, volCheapness: { enabled: true } } }).gates.volCheapness).toEqual({ enabled: true, k: 1 });
  });
});

describe("vol-cheapness gate (WP5)", () => {
  const fit: HarFit = { b0: 0.1, bd: 0.1, bw: 0.3, bm: 0.4, n: 400, r2: 0.12 };
  const fc = (forecastPct2: number): VolForecast => ({ index: "NIFTY", date: "2026-10-07", lastSession: "2026-10-06", forecastPct2, fit, measure: "parkinson" });
  const on = (k: number) => withOverrides(DEFAULT_CONFIG, { gates: { volCheapness: { enabled: true, k } } });
  const implied = (0.14 * 100) ** 2 / 252; // VIX 14: 0.778 %² per session

  it("passes when the forecast is at least k × the implied session variance", () => {
    expect(volCheapnessGate(fc(implied * 1.01), 0.14, on(1)).passed).toBe(true);
    expect(volCheapnessGate(fc(implied * 0.99), 0.14, on(1)).passed).toBe(false);
    expect(volCheapnessGate(fc(implied * 0.85), 0.14, on(0.8)).passed).toBe(true);
    expect(volCheapnessGate(fc(implied * 1.1), 0.14, on(1.2)).passed).toBe(false);
    expect(volCheapnessGate(fc(implied * 0.5), 0.14, on(1)).detail).toMatch(/variance ratio 0\.50/);
  });

  it("fails closed without a forecast or an implied vol", () => {
    const none = volCheapnessGate(null, 0.14, on(1));
    expect(none.passed).toBe(false);
    expect(none.detail).toMatch(/no HAR-RV forecast/);
    expect(volCheapnessGate(fc(5), 0, on(1)).passed).toBe(false);
  });
});
