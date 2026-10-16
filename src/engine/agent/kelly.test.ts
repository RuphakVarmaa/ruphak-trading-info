import { describe, expect, it } from "vitest";
import { addDays, istAt, MINUTE_MS } from "../clock";
import { kellyFraction } from "../strategy/sizing";
import { sizingProbability } from "./calibration";
import { agentRiskPct, payoffRatio } from "./kelly";
import type { AgentTradeRecord, GradedDecision } from "./types";

const V = "core-1/abcd1234";

function trade(positionId: string, pnlPctPremium: number): AgentTradeRecord {
  return {
    positionId, date: "2026-10-19", index: "NIFTY", side: "BULL", finalistId: "gen:NIFTY", decisionId: `d-${positionId}`, tradingSymbol: "NIFTY26O2025000CE",
    entryMs: 0, exitMs: 1, lots: 1, pnlRupees: pnlPctPremium * 100, pnlPctPremium, exitReason: "TARGET", agentExit: null,
  };
}
/** `wins` trades at +win% and `losses` at −loss% of premium. */
const trades = (wins: number, win: number, losses: number, loss: number) => [
  ...Array.from({ length: wins }, (_, i) => trade(`w${i}`, win)),
  ...Array.from({ length: losses }, (_, i) => trade(`l${i}`, -loss)),
];

/** n graded reflex calls above 0.80, an hour apart (no 30-minute windows overlap): the first `hits` hit, the first `paid` paid. */
function graded(n: number, hits: number, paid: number): GradedDecision[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays("2026-09-01", Math.floor(i / 6));
    return {
      id: `g${i}`, date, barCloseMs: istAt(date, "09:20") + (i % 6) * 60 * MINUTE_MS, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX",
      instructionVersion: V, effective: true, direction: "LONG", directionConfidence: 0.85, y: i < hits ? 1 : 0, paid: i < paid,
    } satisfies GradedDecision;
  });
}

describe("agentRiskPct", () => {
  it("risks nothing at a coin flip with even payoffs", () => {
    expect(agentRiskPct(0.5, 1)).toMatchObject({ kelly: 0, quarterKelly: 0, riskPct: 0 });
    expect(agentRiskPct(0.5, 1).reason).toBe("Kelly ≤ 0: no measured edge yet (p=0.5, b=1)");
  });

  it("takes a quarter of full Kelly and caps it at 1% of equity", () => {
    const capped = agentRiskPct(0.56, 1);
    expect(capped.kelly).toBeCloseTo(0.12, 12);
    expect(capped.quarterKelly).toBeCloseTo(0.03, 12);
    expect(capped.riskPct).toBe(1);
    expect(capped.reason).toBe("quarter Kelly 3% of equity, capped at 1% (p=0.56, b=1)");
    const small = agentRiskPct(0.505, 1);
    expect(small.riskPct).toBeCloseTo(0.25, 12);
    expect(small.reason).toBe("quarter Kelly 0.25% of equity (p=0.505, b=1)");
  });

  it("uses the engine's Kelly formula f* = p − (1 − p) / b", () => {
    expect(agentRiskPct(0.42, 1.5).kelly).toBeCloseTo(kellyFraction(0.42, 1.5, -1), 15);
    // 0.42 − 0.58 / 1.5 = 0.0333; a quarter is 0.83% of equity, under the cap.
    expect(agentRiskPct(0.42, 1.5).riskPct).toBeCloseTo(0.25 * (0.42 - 0.58 / 1.5) * 100, 12);
    expect(agentRiskPct(0.4, 1.5).riskPct).toBe(0);
  });

  it("risks nothing on inputs it cannot use", () => {
    for (const [p, b] of [[Number.NaN, 1], [1.2, 1], [-0.1, 1], [0.6, 0], [0.6, -1], [0.6, Number.POSITIVE_INFINITY]]) expect(agentRiskPct(p, b).riskPct).toBe(0);
  });
});

describe("payoffRatio", () => {
  it("is 1 with no trades, or without both a win and a loss", () => {
    expect(payoffRatio([])).toEqual({ b: 1, n: 0, measured: null });
    expect(payoffRatio(trades(5, 40, 0, 0))).toEqual({ b: 1, n: 5, measured: null });
    expect(payoffRatio(trades(0, 0, 40, 30))).toEqual({ b: 1, n: 40, measured: null });
  });

  it("is held at or below 1 until 30 trades have closed", () => {
    // Measured 50 / 30 = 1.67 over 10 trades: shrunk to (10 × 1.67 + 20) / 30 = 1.22, then held at 1.
    const ten = payoffRatio(trades(5, 50, 5, 30));
    expect(ten.measured).toBeCloseTo(5 / 3, 12);
    expect(ten.b).toBe(1);
    // A measured ratio below 1 is not held up: (10 × 0.6 + 20) / 30.
    expect(payoffRatio(trades(5, 18, 5, 30)).b).toBeCloseTo(26 / 30, 12);
    expect(payoffRatio(trades(15, 50, 14, 30))).toMatchObject({ n: 29, b: 1 });
  });

  it("uses the shrunk measured ratio from 30 trades on", () => {
    // 40 trades measuring 1.5: (40 × 1.5 + 20 × 1) / 60.
    const forty = payoffRatio(trades(20, 45, 20, 30));
    expect(forty).toMatchObject({ n: 40, measured: 1.5 });
    expect(forty.b).toBeCloseTo(80 / 60, 12);
    expect(payoffRatio(trades(15, 45, 15, 30)).b).toBeCloseTo((30 * 1.5 + 20) / 50, 12);
  });

  it("counts each position once and skips numbers it cannot read", () => {
    const rows = [...trades(1, 50, 1, 25), trade("w0", 50), trade("x", Number.NaN)];
    expect(payoffRatio(rows)).toMatchObject({ n: 2, measured: 2 });
  });
});

describe("Kelly sizing end to end", () => {
  it("risks nothing with no history", () => {
    const p = sizingProbability(0.95, [], V).p;
    expect(p).toBeLessThan(0.5);
    expect(agentRiskPct(p, payoffRatio([]).b).riskPct).toBe(0);
  });

  it("risks nothing when the direction is right 56% of the time but only 30% of calls paid, even with a measured b of 1.5", () => {
    const rows = graded(200, 112, 60);
    const p = sizingProbability(0.85, rows, V);
    // The 20th percentile of Beta(60 + 50, 140 + 50).
    expect(p).toMatchObject({ mode: "pooled", n: 200 });
    expect(p.p).toBeCloseTo(0.3431634016085107, 9);
    for (const t of [trades(5, 45, 5, 30), trades(20, 45, 20, 30)]) {
      const { b, measured } = payoffRatio(t);
      expect(measured).toBe(1.5);
      expect(agentRiskPct(p.p, b)).toMatchObject({ riskPct: 0, quarterKelly: 0 });
    }
    // The 0.03% hit rate alone would have sized at the cap: that is the mismatch the paid label removes.
    expect(agentRiskPct(0.56, 1.5).riskPct).toBe(1);
  });
});
