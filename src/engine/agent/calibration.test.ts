import { describe, expect, it } from "vitest";
import { addDays, istAt, MINUTE_MS } from "../clock";
import {
  baselineBrier,
  betaQuantile,
  betaRegularized,
  brier,
  buckets,
  calibrationSummary,
  lnGamma,
  overlapWeights,
  pav,
  sizingProbability,
  toGraded,
  toGradedNeutral,
} from "./calibration";
import { agentRiskPct } from "./kelly";
import type { DecisionRecord, GradedDecision, GradedNeutral } from "./types";

const V = "core-1/abcd1234";
const OLD = "core-1/00000000";
const T0 = istAt("2026-10-19", "10:00");

function row(over: Partial<GradedDecision> = {}): GradedDecision {
  return {
    id: "g", date: "2026-10-19", barCloseMs: T0, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: V, effective: true,
    direction: "LONG", directionConfidence: 0.85, y: 1, paid: true,
    ...over,
  };
}

/** n rows an hour apart (no two 30-minute windows overlap); `paid(i)` and `y(i)` label row i. */
function spaced(n: number, o: { conf?: number; paid?: (i: number) => boolean; y?: (i: number) => 0 | 1; version?: string; from?: number } = {}): GradedDecision[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + (o.from ?? 0);
    const date = addDays("2026-01-05", Math.floor(i / 6));
    return row({
      id: `r${i}`, date, barCloseMs: istAt(date, "09:20") + (i % 6) * 60 * MINUTE_MS, directionConfidence: o.conf ?? 0.85,
      paid: o.paid ? o.paid(k) : false, y: o.y ? o.y(k) : 0, instructionVersion: o.version ?? V,
    });
  });
}

/** I_x(a, b) for integer a, b by the binomial identity P(Bin(a + b − 1, x) ≥ a), in log space. */
function binomialTail(x: number, a: number, b: number): number {
  const n = a + b - 1;
  let s = 0;
  for (let j = a; j <= n; j++) s += Math.exp(lnGamma(n + 1) - lnGamma(j + 1) - lnGamma(n - j + 1) + j * Math.log(x) + (n - j) * Math.log1p(-x));
  return s;
}

describe("the regularized incomplete beta function", () => {
  it("matches closed forms", () => {
    for (const x of [0.001, 0.2, 0.5, 0.77, 0.999]) {
      expect(betaRegularized(x, 1, 1)).toBeCloseTo(x, 14);
      expect(betaRegularized(x, 2.5, 1)).toBeCloseTo(x ** 2.5, 14);
      expect(betaRegularized(x, 1, 3.5)).toBeCloseTo(1 - (1 - x) ** 3.5, 14);
      expect(betaRegularized(x, 0.5, 0.5)).toBeCloseTo((2 / Math.PI) * Math.asin(Math.sqrt(x)), 13);
    }
    for (const a of [0.7, 2, 50, 1_000]) expect(betaRegularized(0.5, a, a)).toBeCloseTo(0.5, 13);
  });

  it("matches exact values (binomial identity, 60-digit arithmetic) and numerically integrated ones", () => {
    expect(betaRegularized(0.3, 2, 3)).toBeCloseTo(0.3483, 14);
    expect(betaRegularized(0.45, 50, 50)).toBeCloseTo(0.1586521989370988, 13);
    expect(betaRegularized(0.4, 110, 190)).toBeCloseTo(0.8837870895205964, 13);
    expect(betaRegularized(0.33, 110, 190)).toBeCloseTo(0.09224208353716952, 13);
    expect(betaRegularized(0.9, 30, 3)).toBeCloseTo(0.3666835190806202, 13);
    // Non-integer shapes, against Simpson's rule on the density (2,000,000 intervals).
    expect(betaRegularized(0.5, 52.5, 47.25)).toBeCloseTo(0.29875509884223933, 10);
    expect(betaRegularized(0.42, 60.75, 89.5)).toBeCloseTo(0.6553932051190844, 10);
    expect(betaRegularized(0.2, 2.5, 3.5)).toBeCloseTo(0.1328173097780503, 10);
  });

  it("agrees with the binomial identity across shapes and is symmetric", () => {
    for (const [a, b] of [[1, 9], [3, 4], [17, 5], [60, 61], [110, 190], [400, 20]]) {
      for (const x of [0.05, 0.3, 0.5, 0.62, 0.95]) {
        expect(betaRegularized(x, a, b)).toBeCloseTo(binomialTail(x, a, b), 12);
        expect(betaRegularized(x, a, b) + betaRegularized(1 - x, b, a)).toBeCloseTo(1, 13);
      }
    }
  });

  it("is 0 below the support, 1 above it, and NaN for an invalid shape", () => {
    expect(betaRegularized(0, 2, 3)).toBe(0);
    expect(betaRegularized(-1, 2, 3)).toBe(0);
    expect(betaRegularized(1, 2, 3)).toBe(1);
    expect(betaRegularized(0.5, 0, 3)).toBeNaN();
    expect(betaRegularized(0.5, 2, Number.NaN)).toBeNaN();
  });
});

describe("the Beta quantile", () => {
  it("matches exact quantiles", () => {
    expect(betaQuantile(0.2, 50, 50)).toBeCloseTo(0.4578886359060713, 12);
    expect(betaQuantile(0.2, 110, 190)).toBeCloseTo(0.3431634016085107, 12);
    expect(betaQuantile(0.2, 15, 15)).toBeCloseTo(0.42299199657887553, 12);
    expect(betaQuantile(0.2, 200, 100)).toBeCloseTo(0.6438693316212441, 12);
    expect(betaQuantile(0.05, 2, 3)).toBeCloseTo(0.09761146288641434, 12);
    expect(betaQuantile(0.5, 2, 3)).toBeCloseTo(0.38572756813238955, 12);
    expect(betaQuantile(0.95, 2, 3)).toBeCloseTo(0.7513953742698185, 12);
    expect(betaQuantile(0.001, 5, 7)).toBeCloseTo(0.07994850289833218, 12);
    expect(betaQuantile(0.999, 5, 7)).toBeCloseTo(0.8206063062753938, 12);
  });

  it("matches closed forms and inverts the CDF across shapes", () => {
    for (const q of [0.001, 0.2, 0.5, 0.9, 0.999]) {
      expect(betaQuantile(q, 1, 1)).toBeCloseTo(q, 13);
      expect(betaQuantile(q, 3, 1)).toBeCloseTo(q ** (1 / 3), 12);
      expect(betaQuantile(q, 0.5, 0.5)).toBeCloseTo(Math.sin((Math.PI * q) / 2) ** 2, 12);
      for (const [a, b] of [[0.3, 0.7], [2.5, 9.25], [50, 50], [62.4, 141.6], [5_000, 4_000]]) {
        expect(betaRegularized(betaQuantile(q, a, b), a, b)).toBeCloseTo(q, 11);
      }
    }
  });

  it("is 0 at q = 0, 1 at q = 1, and NaN for an invalid shape", () => {
    expect(betaQuantile(0, 50, 50)).toBe(0);
    expect(betaQuantile(1, 50, 50)).toBe(1);
    expect(betaQuantile(0.2, -1, 50)).toBeNaN();
    expect(betaQuantile(Number.NaN, 50, 50)).toBeNaN();
  });
});

describe("Brier scores and buckets", () => {
  const rows = [
    { p: 0.9, y: 1 as const },
    { p: 0.8, y: 0 as const },
    { p: 0.6, y: 1 as const },
    { p: 0.3, y: 0 as const },
  ];

  it("scores known rows against the base rate", () => {
    expect(brier(rows)).toBeCloseTo((0.01 + 0.64 + 0.16 + 0.09) / 4, 15);
    expect(baselineBrier(rows)).toBe(0.25);
    expect(baselineBrier([{ y: 1 }, { y: 1 }, { y: 1 }, { y: 0 }])).toBeCloseTo(0.1875, 15);
    expect(brier([])).toBeNull();
    expect(baselineBrier([])).toBeNull();
    expect(brier([{ p: Number.NaN, y: 1 }, { p: 1.2, y: 0 }])).toBeNull();
  });

  it("buckets by stated probability with hit and paid rates; 1.0 falls in the last bucket", () => {
    const b = buckets([
      { p: 0.55, y: 1, paid: false },
      { p: 0.58, y: 0, paid: false },
      { p: 0.85, y: 1, paid: true },
      { p: 0.95, y: 1, paid: true },
      { p: 1, y: 0, paid: false },
    ]);
    expect(b.map((x) => [x.from, x.to, x.n])).toEqual([
      [0, 0.5, 0],
      [0.5, 0.6, 2],
      [0.6, 0.7, 0],
      [0.7, 0.8, 0],
      [0.8, 0.9, 1],
      [0.9, 1, 2],
    ]);
    expect(b[1]).toMatchObject({ statedMean: 0.565, hitRate: 0.5, paidRate: 0 });
    expect(b[5]).toMatchObject({ statedMean: 0.975, hitRate: 0.5, paidRate: 0.5 });
    expect(b[0]).toMatchObject({ statedMean: null, hitRate: null, paidRate: null });
    expect(buckets([{ p: 0.55, y: 1, w: 3 }, { p: 0.58, y: 0, w: 1 }])[1]).toMatchObject({ n: 4, hitRate: 0.75, paidRate: null });
  });
});

describe("pav", () => {
  it("pools adjacent violators by weight", () => {
    expect(pav([{ p: 1, w: 1 }, { p: 3, w: 1 }, { p: 2, w: 1 }])).toEqual([1, 2.5, 2.5]);
    expect(pav([{ p: 3, w: 1 }, { p: 2, w: 1 }, { p: 1, w: 1 }])).toEqual([2, 2, 2]);
    expect(pav([{ p: 0.6, w: 3 }, { p: 0.3, w: 1 }]).map((x) => Number(x.toFixed(12)))).toEqual([0.525, 0.525]);
    expect(pav([{ p: 0.6, w: 0 }, { p: 0.3, w: 2 }])).toEqual([0.3, 0.3]);
    expect(pav([])).toEqual([]);
  });

  it("is monotone and keeps the weighted mean", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    for (let trial = 0; trial < 50; trial++) {
      const values = Array.from({ length: 1 + Math.floor(rand() * 9) }, () => ({ p: rand(), w: 0.1 + rand() * 5 }));
      const fit = pav(values);
      for (let i = 1; i < fit.length; i++) expect(fit[i]).toBeGreaterThanOrEqual(fit[i - 1] - 1e-15);
      const mean = (xs: number[]) => xs.reduce((s, x, i) => s + x * values[i].w, 0);
      expect(mean(fit)).toBeCloseTo(mean(values.map((v) => v.p)), 12);
    }
  });
});

describe("overlap weights (#15)", () => {
  const total = (ws: { w: number }[]) => ws.reduce((s, x) => s + x.w, 0);

  it("counts 6 identical rows as 1", () => {
    const six = Array.from({ length: 6 }, (_, i) => row({ id: `g${i}` }));
    const w = overlapWeights(six, V);
    expect(w).toHaveLength(1);
    expect(w[0].w).toBe(1);
  });

  it("counts 6 overlapping rows on consecutive candles as 1", () => {
    const six = Array.from({ length: 6 }, (_, i) => row({ id: `g${i}`, barCloseMs: T0 + i * 5 * MINUTE_MS }));
    const w = overlapWeights(six, V);
    expect(w.map((x) => x.w)).toEqual([1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6]);
    expect(total(w)).toBeCloseTo(1, 12);
  });

  it("does not count windows that only touch as overlapping, nor another index or direction as the same call", () => {
    const apart = [row({ id: "a" }), row({ id: "b", barCloseMs: T0 + 30 * MINUTE_MS })];
    expect(overlapWeights(apart, V).map((x) => x.w)).toEqual([1, 1]);
    const indices = [row({ id: "a" }), row({ id: "b", index: "SENSEX" })];
    expect(overlapWeights(indices, V)).toHaveLength(2);
    const sides = [row({ id: "a" }), row({ id: "b", direction: "SHORT" })];
    expect(overlapWeights(sides, V).map((x) => x.w)).toEqual([0.5, 0.5]);
    // A middle candle overlaps five on each side.
    const run = Array.from({ length: 11 }, (_, i) => row({ id: `g${i}`, barCloseMs: T0 + i * 5 * MINUTE_MS }));
    expect(overlapWeights(run, V)[5].w).toBeCloseTo(1 / 11, 15);
  });

  it("counts NIFTY and SENSEX as one market: their windows overlap each other (C3)", () => {
    // A call on each index at one bar: one observation, not two.
    const pair = [row({ id: "n" }), row({ id: "s", index: "SENSEX" })];
    expect(overlapWeights(pair, V).map((x) => x.w)).toEqual([0.5, 0.5]);
    // A SENSEX call 10 minutes after a NIFTY one overlaps it too; one 30 minutes later only touches it.
    const near = [row({ id: "n" }), row({ id: "s", index: "SENSEX", barCloseMs: T0 + 10 * MINUTE_MS })];
    expect(overlapWeights(near, V).map((x) => x.w)).toEqual([0.5, 0.5]);
    const apart = [row({ id: "n" }), row({ id: "s", index: "SENSEX", barCloseMs: T0 + 30 * MINUTE_MS })];
    expect(overlapWeights(apart, V).map((x) => x.w)).toEqual([1, 1]);
    // Six consecutive candles on each index: 12 rows that weigh 1 in all.
    const run = (["NIFTY", "SENSEX"] as const).flatMap((index) => Array.from({ length: 6 }, (_, i) => row({ id: `${index}${i}`, index, barCloseMs: T0 + i * 5 * MINUTE_MS })));
    expect(total(overlapWeights(run, V))).toBeCloseTo(1, 12);
  });

  it("weighs other instruction versions at half, keeping the active version's row of an identical pair", () => {
    expect(overlapWeights([row({ instructionVersion: OLD })], V)[0].w).toBe(0.5);
    const pair = overlapWeights([row({ id: "old", instructionVersion: OLD }), row({ id: "new" })], V);
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({ w: 1, row: { id: "new" } });
  });
});

describe("sizingProbability", () => {
  it("is below 0.5 with no history: the 20th percentile of Beta(50, 50)", () => {
    const h = sizingProbability(0.95, [], V);
    expect(h).toMatchObject({ mode: "pooled", n: 0, mean: 0.5 });
    expect(h.p).toBeCloseTo(0.4578886359060713, 12);
    expect(h.p).toBeLessThan(0.5);
  });

  it("sizes on the paid label of reflex calls in force above 0.80, never the stated confidence or the hit label", () => {
    const rows = spaced(200, { paid: (i) => i < 60, y: (i) => (i < 112 ? 1 : 0) });
    const h = sizingProbability(0.85, rows, V);
    expect(h).toMatchObject({ mode: "pooled", n: 200 });
    expect(h.mean).toBeCloseTo(110 / 300, 12);
    expect(h.p).toBeCloseTo(betaQuantile(0.2, 110, 190), 12);
    // The decision's own confidence does not move the pooled p.
    expect(sizingProbability(0.99, rows, V).p).toBe(h.p);
    // Calls at 0.80 exactly, escalations and superseded rows add nothing.
    const noise = [
      ...spaced(50, { conf: 0.8, paid: () => true, from: 1_000 }),
      ...spaced(50, { paid: () => true, from: 2_000 }).map((r) => ({ ...r, source: "ESCALATION" as const })),
      ...spaced(50, { paid: () => true, from: 3_000 }).map((r) => ({ ...r, effective: false })),
    ];
    expect(sizingProbability(0.85, [...rows, ...noise], V)).toEqual(h);
  });

  it("sizes an escalation on the escalations' own record, never the reflex's (C2)", () => {
    const reflex = spaced(300, { paid: (i) => i % 4 !== 0 });
    const escalations = spaced(40, { paid: (i) => i % 2 === 0, from: 5_000 }).map((r) => ({ ...r, source: "ESCALATION" as const }));
    const all = [...reflex, ...escalations];
    // With no graded escalation, the prior only: n = 0 (agentCycle then takes no trade).
    const none = sizingProbability(0.88, reflex, V, "ESCALATION");
    expect(none).toMatchObject({ mode: "pooled", n: 0, mean: 0.5 });
    expect(none.p).toBeCloseTo(0.4578886359060713, 12);
    // A rich reflex record would clear Kelly; it never sizes an escalation.
    expect(agentRiskPct(sizingProbability(0.88, reflex, V).p, 1).riskPct).toBeGreaterThan(0);
    const e = sizingProbability(0.88, all, V, "ESCALATION");
    expect(e).toEqual(sizingProbability(0.88, escalations.map((r) => ({ ...r, source: "REFLEX" as const })), V));
    expect(e.n).toBe(40);
    expect(e.p).toBeCloseTo(betaQuantile(0.2, 20 + 50, 20 + 50), 12);
    // The reflex's own sizing ignores the escalations, as before.
    expect(sizingProbability(0.88, all, V)).toEqual(sizingProbability(0.88, reflex, V));
  });

  it("counts a call on each index at one bar once: no trade from evidence counted twice (probe-crossindex)", () => {
    // 40 sessions, a confident LONG on NIFTY and on SENSEX at 10:00 and 13:00, 55% paid, the same label on both.
    const rows: GradedDecision[] = [];
    let k = 0;
    for (let d = 0; d < 40; d++) {
      const date = addDays("2026-07-01", d);
      for (const hhmm of ["10:00", "13:00"]) {
        const paid = k % 20 < 11;
        for (const index of ["NIFTY", "SENSEX"] as const) {
          rows.push(row({ id: `${index}${k}`, date, barCloseMs: istAt(date, hhmm), index, directionConfidence: 0.85, y: paid ? 1 : 0, paid }));
        }
        k++;
      }
    }
    const both = sizingProbability(0.85, rows, V);
    const oneIndex = sizingProbability(0.85, rows.filter((r) => r.index === "NIFTY"), V);
    expect(both.n).toBeCloseTo(80, 9);
    expect(both.p).toBeCloseTo(oneIndex.p, 12);
    expect(agentRiskPct(both.p, 1).riskPct).toBe(0);
  });

  it("counts 6 overlapping calls as 1", () => {
    const six = Array.from({ length: 6 }, (_, i) => row({ id: `g${i}`, barCloseMs: T0 + i * 5 * MINUTE_MS }));
    const h = sizingProbability(0.85, six, V);
    expect(h.n).toBeCloseTo(1, 12);
    expect(h.mean).toBeCloseTo(51 / 101, 12);
    const same = Array.from({ length: 6 }, (_, i) => row({ id: `g${i}` }));
    expect(sizingProbability(0.85, same, V).n).toBe(1);
  });

  it("weighs calls under other instruction versions at half", () => {
    const old = spaced(100, { paid: () => true, version: OLD });
    const h = sizingProbability(0.85, old, V);
    expect(h.n).toBe(50);
    expect(h.p).toBeCloseTo(betaQuantile(0.2, 100, 50), 12);
  });

  it("switches to buckets at 300 weighted calls and 30 in the decision's bucket", () => {
    const low = spaced(150, { conf: 0.85, paid: (i) => i % 3 === 0 });
    const high = spaced(150, { conf: 0.95, paid: (i) => i % 2 === 0, from: 150 });
    const h = sizingProbability(0.85, [...low, ...high], V);
    expect(h).toMatchObject({ mode: "buckets", n: 150 });
    expect(h.p).toBeCloseTo(betaQuantile(0.2, 50 + 15, 100 + 15), 12);
    expect(sizingProbability(0.95, [...low, ...high], V).p).toBeCloseTo(betaQuantile(0.2, 75 + 15, 75 + 15), 12);
    // A bucket with fewer than 30 calls falls back to pooled.
    expect(sizingProbability(0.75, [...low, ...high], V).mode).toBe("pooled");
    // 299 calls in all: pooled.
    expect(sizingProbability(0.85, [...low, ...high.slice(1)], V).mode).toBe("pooled");
  });

  it("counts each window once for the switch to buckets, whatever bucket it fell in (C4, probe-bucketswitch)", () => {
    // 5 sessions of one index, a call on every candle with the confidence cycling through the six buckets: each bucket
    // holds calls 30 minutes apart (weight 1 each, about 58 per bucket), but the windows themselves overlap.
    const confs = [0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
    const rows: GradedDecision[] = [];
    let k = 0;
    for (let d = 0; d < 5; d++) {
      const date = addDays("2026-10-19", d);
      for (let i = 0; i < 70; i++) {
        const paid = (k * 7) % 10 < 6;
        rows.push(row({ id: `r${k}`, date, barCloseMs: istAt(date, "09:20") + i * 5 * MINUTE_MS, directionConfidence: confs[i % 6], y: paid ? 1 : 0, paid }));
        k++;
      }
    }
    const joint = overlapWeights(rows, V).reduce((s, x) => s + x.w, 0);
    expect(joint).toBeLessThan(60);
    const h = sizingProbability(0.85, rows, V);
    expect(h.mode).toBe("pooled");
    // Sizing stays pooled: the same p as on the confident calls alone (probe-bucketswitch2).
    expect(h).toEqual(sizingProbability(0.85, rows.filter((r) => r.directionConfidence > 0.8), V));
  });

  it("makes the bucket values non-decreasing in confidence", () => {
    // The 0.9+ bucket paid less often than the 0.8–0.9 one: the two pool.
    const low = spaced(200, { conf: 0.85, paid: (i) => i % 2 === 0 });
    const high = spaced(100, { conf: 0.95, paid: (i) => i % 4 === 0, from: 200 });
    const qLow = betaQuantile(0.2, 100 + 15, 100 + 15);
    const qHigh = betaQuantile(0.2, 25 + 15, 75 + 15);
    const pooled = (200 * qLow + 100 * qHigh) / 300;
    expect(sizingProbability(0.85, [...low, ...high], V).p).toBeCloseTo(pooled, 12);
    expect(sizingProbability(0.95, [...low, ...high], V).p).toBeCloseTo(pooled, 12);
  });
});

describe("calibrationSummary", () => {
  const rows: GradedDecision[] = [
    row({ id: "a", directionConfidence: 0.9, y: 1, paid: true }),
    row({ id: "b", index: "SENSEX", directionConfidence: 0.7, y: 0, paid: false, barCloseMs: T0 + 60 * MINUTE_MS }),
    row({ id: "c", finalistKind: "IDEA", source: "ESCALATION", directionConfidence: 0.6, y: 1, paid: false, barCloseMs: T0 + 120 * MINUTE_MS }),
    row({ id: "d", instructionVersion: OLD, directionConfidence: 0.85, y: 0, paid: false, barCloseMs: T0 + 180 * MINUTE_MS }),
    // Superseded by an escalation: graded, not counted.
    row({ id: "e", effective: false, directionConfidence: 0.2, y: 1, paid: true, barCloseMs: T0 + 120 * MINUTE_MS }),
  ];
  const neutral: GradedNeutral[] = [
    { id: "n1", date: "2026-10-19", barCloseMs: T0, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: V, effective: true, directionConfidence: 0.7, y: 1 },
    { id: "n2", date: "2026-10-19", barCloseMs: T0, index: "SENSEX", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: V, effective: true, directionConfidence: 0.6, y: 0 },
    { id: "n3", date: "2026-10-19", barCloseMs: T0, index: "SENSEX", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: V, effective: false, directionConfidence: 0.1, y: 0 },
  ];

  it("scores the decisions in force by index, kind, version and source, and NEUTRAL on its own line", () => {
    const s = calibrationSummary(rows, V, 123, neutral);
    expect(s.asOfMs).toBe(123);
    expect(s.graded).toBe(4);
    expect(s.brier).toBeCloseTo((0.01 + 0.49 + 0.16 + 0.7225) / 4, 12);
    expect(s.baselineBrier).toBe(0.25);
    expect(s.byIndex).toEqual([
      { index: "NIFTY", n: 3, brier: expect.closeTo((0.01 + 0.16 + 0.7225) / 3, 12) },
      { index: "SENSEX", n: 1, brier: expect.closeTo(0.49, 12) },
    ]);
    expect(s.byKind.map((k) => [k.kind, k.n])).toEqual([["GENERIC", 3], ["IDEA", 1]]);
    expect(s.bySource.map((k) => [k.source, k.n])).toEqual([["REFLEX", 3], ["ESCALATION", 1]]);
    expect(s.byVersion.map((k) => [k.version, k.n])).toEqual([[OLD, 1], [V, 3]]);
    expect(s.neutral).toEqual({ n: 2, brier: expect.closeTo((0.09 + 0.36) / 2, 12), baselineBrier: 0.25 });
    expect(s.paidRate).toBe(0.25);
    // 0.6, 0.7, 0.85 and 0.9: one call in each of the top four buckets.
    expect(s.buckets.map((b) => b.n)).toEqual([0, 0, 1, 1, 1, 1]);
    expect(s.buckets[5]).toMatchObject({ hitRate: 1, paidRate: 1 });
  });

  it("reports the sizing probability for a call just above 0.80 and the weight behind it", () => {
    const s = calibrationSummary(rows, V, 0);
    const h = sizingProbability(0.80001, rows, V);
    expect(s).toMatchObject({ sizingMode: "pooled", sizingP: h.p, sizingN: h.n });
    // Reflex calls in force above 0.80: "a" (active) and "d" (older version, half weight).
    expect(s.sizingN).toBe(1.5);
    const empty = calibrationSummary([], V, 0);
    expect(empty).toMatchObject({ graded: 0, brier: null, baselineBrier: null, paidRate: null, sizingN: 0, neutral: { n: 0, brier: null, baselineBrier: null } });
    expect(empty.sizingP).toBeCloseTo(0.4578886359060713, 12);
  });
});

describe("graded rows from decisions", () => {
  const base: DecisionRecord = {
    id: "d1", date: "2026-10-19", barCloseMs: T0, index: "NIFTY", finalistKind: "IDEA", source: "REFLEX", callId: "c", instructionVersion: V, effective: true,
    sizing: null, execution: null, finalistId: "idea:b:i", regime: "TRENDING", direction: "SHORT", directionConfidence: 0.83, toxicFlow: false, setupQuality: 2,
    riskState: "SAFE", reason: "", outcome: { status: "HIT", y: 1, ret30Pct: -0.2, paid: true, source: "BARS_5M", gradedMs: 1 },
  };

  it("maps HIT and MISS to directional rows and NEUTRAL to its own rows", () => {
    expect(toGraded(base)).toEqual({
      id: "d1", date: "2026-10-19", barCloseMs: T0, index: "NIFTY", finalistKind: "IDEA", source: "REFLEX", instructionVersion: V, effective: true,
      direction: "SHORT", directionConfidence: 0.83, y: 1, paid: true,
    });
    expect(toGradedNeutral(base)).toBeNull();
    const n = { ...base, direction: "NEUTRAL" as const, outcome: { status: "NEUTRAL" as const, y: 0 as const, ret30Pct: 0.2, paid: null, source: "STORED" as const, gradedMs: 1 } };
    expect(toGradedNeutral(n)).toMatchObject({ id: "d1", directionConfidence: 0.83, y: 0 });
    expect(toGraded(n)).toBeNull();
    for (const status of ["CENSORED", "MISSING"] as const) {
      expect(toGraded({ ...base, outcome: { status, y: null, ret30Pct: null, paid: null, source: null, gradedMs: 1 } })).toBeNull();
    }
    expect(toGraded({ ...base, outcome: null })).toBeNull();
  });

  it("never scores a code-made row (C8)", () => {
    expect(toGraded({ ...base, codeMade: true })).toBeNull();
    const n = { ...base, direction: "NEUTRAL" as const, directionConfidence: 0.5, codeMade: true, outcome: { status: "NEUTRAL" as const, y: 1 as const, ret30Pct: 0.02, paid: null, source: "STORED" as const, gradedMs: 1 } };
    expect(toGradedNeutral(n)).toBeNull();
    expect(toGradedNeutral({ ...n, codeMade: false })).toMatchObject({ id: "d1", y: 1 });
    expect(toGraded({ ...base, codeMade: false })).not.toBeNull();
  });
});
