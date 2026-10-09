import { describe, expect, it } from "vitest";
import { addDays } from "../clock";
import { GLOBAL_KEYS, type GlobalKey } from "../types";
import { mulberry32 } from "../__fixtures__/market/loadFixtures";
import { expectedGapPct, fitGapBetas, type GapObservation } from "./crossAsset";
import { chooseGapLambda, gapForecastMetrics, GAP_LAMBDA_GRID, isCompleteObservation, sessionBootstrap, walkForwardGapForecasts } from "./gapFit";

const keys: GlobalKey[] = ["ES", "USDINR", "N225"];
const truth: Record<string, number> = { ES: 0.37, USDINR: -0.9, N225: 0.08 };

function noMoves(): Record<GlobalKey, number | null> {
  return Object.fromEntries(GLOBAL_KEYS.map((k) => [k, null])) as Record<GlobalKey, number | null>;
}

/**
 * `sessions` dated sessions with two rows each (NIFTY- and SENSEX-like: same moves, own noise).
 * gap = truth · moves + noise, or pure noise when `signal` is false.
 */
function synthetic(sessions: number, noise: number, seed: number, signal = true): GapObservation[] {
  const rnd = mulberry32(seed);
  const out: GapObservation[] = [];
  for (let i = 0; i < sessions; i++) {
    const moves = noMoves();
    moves.ES = (rnd() - 0.5) * 2;
    moves.USDINR = (rnd() - 0.5) * 0.6;
    moves.N225 = (rnd() - 0.5) * 3;
    const base = signal ? keys.reduce((s, k) => s + truth[k] * (moves[k] as number), 0) : 0;
    for (let r = 0; r < 2; r++) out.push({ date: addDays("2025-01-01", i), gapPct: base + (rnd() - 0.5) * noise, moves: { ...moves } });
  }
  return out;
}

describe("isCompleteObservation", () => {
  it("needs a finite gap and a finite move for every key", () => {
    const [o] = synthetic(1, 0.1, 1);
    expect(isCompleteObservation(o, keys)).toBe(true);
    expect(isCompleteObservation({ ...o, moves: { ...o.moves, N225: null } }, keys)).toBe(false);
    expect(isCompleteObservation({ ...o, moves: { ...o.moves, ES: Number.NaN } }, keys)).toBe(false);
    expect(isCompleteObservation({ ...o, gapPct: Number.NaN }, keys)).toBe(false);
    // Keys outside the list do not matter.
    expect(isCompleteObservation(o, ["ES"])).toBe(true);
  });
});

describe("chooseGapLambda", () => {
  it("keeps the penalty small when the moves explain the gap", () => {
    expect(chooseGapLambda(synthetic(150, 0.05, 2), keys)).toBeLessThanOrEqual(3);
  });

  it("shrinks hard when the gap is unrelated to the moves", () => {
    expect(chooseGapLambda(synthetic(150, 1, 3, false), keys)).toBeGreaterThanOrEqual(300);
  });

  it("returns a value from the grid, or NaN when nothing can be validated", () => {
    expect(GAP_LAMBDA_GRID).toContain(chooseGapLambda(synthetic(80, 0.3, 4), keys));
    expect(chooseGapLambda(synthetic(4, 0.1, 5), keys)).toBeNaN(); // fewer sessions than blocks
    expect(chooseGapLambda(synthetic(10, 0.1, 5), keys)).toBeNaN(); // no fold reaches 20 training rows
    expect(chooseGapLambda(synthetic(80, 0.1, 6), keys, [])).toBeNaN();
  });
});

describe("walkForwardGapForecasts", () => {
  const obs = synthetic(90, 0.2, 7);

  it("forecasts each session with betas fitted on earlier sessions only", () => {
    const wf = walkForwardGapForecasts(obs, keys, { minTrainSessions: 40 });
    expect(wf).toHaveLength(2 * 50);
    expect(wf[0].obs.date).toBe(addDays("2025-01-01", 40));
    expect(wf[0].trainSessions).toBe(40);
    for (const f of [wf[0], wf[37], wf[wf.length - 1]]) {
      const train = obs.filter((o) => o.date < f.obs.date);
      const lambda = chooseGapLambda(train, keys);
      expect(f.lambda).toBe(lambda);
      expect(f.pred).toBeCloseTo(expectedGapPct(f.obs.moves, fitGapBetas(train, keys, lambda)), 12);
    }
    // Both rows of a session share the betas.
    expect(wf[0].betas).toEqual(wf[1].betas);
    expect(wf[0].obs.date).toBe(wf[1].obs.date);
  });

  it("never looks at the forecast session or later ones", () => {
    const wf = walkForwardGapForecasts(obs, keys, { minTrainSessions: 40 });
    const cut = addDays("2025-01-01", 60);
    const changed = obs.map((o) => (o.date >= cut ? { ...o, gapPct: o.gapPct * -5 + 3 } : o));
    const wf2 = walkForwardGapForecasts(changed, keys, { minTrainSessions: 40 });
    const before = (list: typeof wf) => list.filter((f) => f.obs.date <= cut).map((f) => f.pred);
    expect(before(wf2)).toEqual(before(wf));
    expect(wf2.filter((f) => f.obs.date > cut).map((f) => f.pred)).not.toEqual(wf.filter((f) => f.obs.date > cut).map((f) => f.pred));
  });

  it("limits the forecast range and skips incomplete rows", () => {
    const from = addDays("2025-01-01", 70);
    const to = addDays("2025-01-01", 74);
    const wf = walkForwardGapForecasts(obs, keys, { minTrainSessions: 40, fromDate: from, toDate: to });
    expect([...new Set(wf.map((f) => f.obs.date))]).toEqual([0, 1, 2, 3, 4].map((i) => addDays(from, i)));
    const holed = obs.map((o, i) => (i === 2 * 70 ? { ...o, moves: { ...o.moves, ES: null } } : o));
    expect(walkForwardGapForecasts(holed, keys, { minTrainSessions: 40, fromDate: from, toDate: from })).toHaveLength(1);
  });
});

describe("gapForecastMetrics", () => {
  it("scores forecasts twice as large as the outcome", () => {
    const preds = [1, -2, 0.5, 3, -1];
    const m = gapForecastMetrics(preds.map((p) => ({ pred: p, actual: p / 2 })));
    expect(m.n).toBe(5);
    expect(m.slope).toBeCloseTo(0.5, 12);
    expect(m.intercept).toBeCloseTo(0, 12);
    expect(m.mae).toBeCloseTo((0.5 + 1 + 0.25 + 1.5 + 0.5) / 5, 12);
    expect(m.rmse).toBeCloseTo(Math.sqrt((0.25 + 1 + 0.0625 + 2.25 + 0.25) / 5), 12);
    expect(m.hitRate).toBe(1);
    // SSE equals the sum of squared outcomes when every forecast is twice the outcome: no better than zero.
    expect(m.r2VsZero).toBeCloseTo(0, 12);
  });

  it("counts hits only where both forecast and outcome have a sign", () => {
    const m = gapForecastMetrics([
      { pred: 1, actual: 2 },
      { pred: -1, actual: 0.5 },
      { pred: 0, actual: 1 },
      { pred: 2, actual: 0 },
    ]);
    expect(m.hitN).toBe(2);
    expect(m.hitRate).toBe(0.5);
  });

  it("has no slope for a constant forecast and nothing for no points", () => {
    expect(gapForecastMetrics([{ pred: 0, actual: 1 }, { pred: 0, actual: -1 }]).slope).toBeNaN();
    expect(gapForecastMetrics([{ pred: 0, actual: 1 }, { pred: 0, actual: -1 }]).r2VsZero).toBe(0);
    expect(gapForecastMetrics([])).toMatchObject({ n: 0, hitN: 0 });
    expect(gapForecastMetrics([]).mae).toBeNaN();
  });
});

describe("sessionBootstrap", () => {
  const rows = synthetic(30, 0.2, 8);

  it("resamples whole sessions and is reproducible", () => {
    const samples = sessionBootstrap(rows, (s) => s, 20, 3);
    expect(samples).toHaveLength(20);
    for (const s of samples) {
      expect(s).toHaveLength(rows.length);
      const perDate = new Map<string, number>();
      for (const r of s) perDate.set(r.date, (perDate.get(r.date) ?? 0) + 1);
      for (const n of perDate.values()) expect(n % 2).toBe(0); // both rows of a session travel together
    }
    const mean = (s: GapObservation[]) => s.reduce((a, r) => a + r.gapPct, 0) / s.length;
    expect(sessionBootstrap(rows, mean, 50, 3)).toEqual(sessionBootstrap(rows, mean, 50, 3));
    expect(sessionBootstrap(rows, mean, 50, 3)).not.toEqual(sessionBootstrap(rows, mean, 50, 4));
    expect(sessionBootstrap([], mean, 10, 1)).toEqual([]);
  });
});
