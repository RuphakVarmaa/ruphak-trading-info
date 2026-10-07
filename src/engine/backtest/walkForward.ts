/**
 * Walk-forward evaluation: fit parameters on a training window, test on the following window,
 * roll forward, and report only out-of-sample results. Grids stay small (<= 50 combos) to limit
 * overfitting; placebo runs (no events, shuffled event times) give the baseline an edge must beat.
 */
import { addDays } from "../clock";
import { makeConfig, type DeepPartial, type EngineConfig } from "../config";
import type { DayLedger, TradeRecord } from "../types";
import { summarize, type Summary } from "./metrics";
import { runBacktest, type BacktestInput } from "./runBacktest";

export interface Fold {
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
}

/** Consecutive folds: `trainDays` calendar days of training followed by `testDays` of testing, stepping by testDays. */
export function makeFolds(from: string, to: string, trainDays = 56, testDays = 14): Fold[] {
  const out: Fold[] = [];
  for (let start = from; ; start = addDays(start, testDays)) {
    const trainTo = addDays(start, trainDays - 1);
    const testFrom = addDays(trainTo, 1);
    const testTo = addDays(testFrom, testDays - 1);
    if (testFrom > to) break;
    out.push({ trainFrom: start, trainTo, testFrom, testTo: testTo > to ? to : testTo });
    if (testTo >= to) break;
  }
  return out;
}

export interface GridPoint {
  name: string;
  overrides: DeepPartial<EngineConfig>;
}

/** Default grid: threshold shifts x expected-move multiplier x stop/target pairs (18 combos). */
export function defaultGrid(base: EngineConfig): GridPoint[] {
  const out: GridPoint[] = [];
  for (const dt of [-0.1, 0, 0.1]) {
    for (const kEM of [0.8, 1, 1.2]) {
      for (const [stop, target] of [
        [-30, 50],
        [-35, 60],
      ]) {
        const thresholds = Object.fromEntries(Object.entries(base.conviction.thresholds).map(([k, v]) => [k, Math.max(0.05, v + dt)]));
        out.push({
          name: `thr${dt >= 0 ? "+" : ""}${dt} kEM${kEM} stop${stop}/tgt${target}`,
          overrides: { conviction: { thresholds }, gates: { kEM }, exits: { stopPct: stop, targetPct: target } } as DeepPartial<EngineConfig>,
        });
      }
    }
  }
  return out;
}

/** Objective for choosing parameters on a training window (needs a minimum number of trades). */
export function objective(s: Summary, minTrades = 10): number {
  if (s.trades < minTrades) return -Infinity;
  return s.sharpe + 0.1 * s.expectancyPct;
}

export interface WalkForwardResult {
  folds: { fold: Fold; chosen: string; train: Summary; test: Summary }[];
  oos: Summary;
}

export async function walkForward(
  input: Omit<BacktestInput, "from" | "to" | "cfg">,
  base: EngineConfig,
  folds: Fold[],
  grid: GridPoint[] = defaultGrid(base),
  onProgress?: (msg: string) => void,
): Promise<WalkForwardResult> {
  const results: WalkForwardResult["folds"] = [];
  const oosTrades: TradeRecord[] = [];
  const oosLedgers: DayLedger[] = [];
  for (const fold of folds) {
    let best: { g: GridPoint; s: Summary; score: number } | null = null;
    for (const g of grid) {
      const cfg = makeConfig({ ...base, ...g.overrides } as DeepPartial<EngineConfig>);
      const out = await runBacktest({ ...input, cfg, from: fold.trainFrom, to: fold.trainTo });
      const score = objective(out.summary);
      if (!best || score > best.score) best = { g, s: out.summary, score };
    }
    const chosen = best!.g;
    const cfg = makeConfig({ ...base, ...chosen.overrides } as DeepPartial<EngineConfig>);
    const test = await runBacktest({ ...input, cfg, from: fold.testFrom, to: fold.testTo });
    oosTrades.push(...test.trades);
    oosLedgers.push(...test.ledgers);
    results.push({ fold, chosen: chosen.name, train: best!.s, test: test.summary });
    onProgress?.(`fold ${fold.testFrom}..${fold.testTo}: ${chosen.name} -> OOS trades ${test.summary.trades}, net ₹${test.summary.netPnl}`);
  }
  return { folds: results, oos: summarize(oosTrades, oosLedgers, base.capitalRupees) };
}
