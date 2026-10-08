/**
 * Walk-forward evaluation: fit parameters on a training window, test on the following window,
 * roll forward, and report only out-of-sample results. Grids stay small (<= 50 combos) to limit
 * overfitting; placebo runs (no events, shuffled event times) give the baseline an edge must beat.
 */
import type { AccountId } from "../accounts";
import { addDays } from "../clock";
import { withOverrides, type DeepPartial, type EngineConfig } from "../config";
import type { DayLedger, TradeRecord } from "../types";
import { summarize, type Summary } from "./metrics";
import { runBacktest, runBacktestAccounts, type BacktestInput } from "./runBacktest";

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

/**
 * Default grid (12 combos): conviction gain x threshold shift x theta-gate minimum edge. Exits and
 * the expected-move multiplier stay fixed: kEM is an honest-expectation parameter, not a knob to
 * fit, and stop/target pairs add little but over-fitting risk on short histories.
 */
export function defaultGrid(base: EngineConfig): GridPoint[] {
  const out: GridPoint[] = [];
  for (const gain of [1.2, 1.5]) {
    for (const dt of [-0.05, 0, 0.05]) {
      for (const minEdgeRatio of [0.1, 0.15]) {
        const thresholds = Object.fromEntries(Object.entries(base.conviction.thresholds).map(([k, v]) => [k, Math.min(0.95, Math.max(0.05, v + dt))]));
        out.push({
          name: `gain${gain} thr${dt >= 0 ? "+" : ""}${dt} edge${minEdgeRatio}`,
          overrides: { conviction: { gain, thresholds }, gates: { minEdgeRatio } } as DeepPartial<EngineConfig>,
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
      // Deep merge: a shallow spread would reset the other keys of the nested groups to the defaults.
      const cfg = withOverrides(base, g.overrides);
      const out = await runBacktest({ ...input, cfg, from: fold.trainFrom, to: fold.trainTo });
      const score = objective(out.summary);
      if (!best || score > best.score) best = { g, s: out.summary, score };
    }
    const chosen = best!.g;
    const cfg = withOverrides(base, chosen.overrides);
    const test = await runBacktest({ ...input, cfg, from: fold.testFrom, to: fold.testTo });
    oosTrades.push(...test.trades);
    oosLedgers.push(...test.ledgers);
    results.push({ fold, chosen: chosen.name, train: best!.s, test: test.summary });
    onProgress?.(`fold ${fold.testFrom}..${fold.testTo}: ${chosen.name} -> OOS trades ${test.summary.trades}, net ₹${test.summary.netPnl}`);
  }
  return { folds: results, oos: summarize(oosTrades, oosLedgers, base.capitalRupees) };
}

/**
 * Exit grid for a follower account (12 combos): stop x target x time-stop floor. Main's signals
 * and settings stay fixed; only how the follower's single lot is exited is fitted.
 */
export function followerExitGrid(): GridPoint[] {
  const out: GridPoint[] = [];
  for (const stopPct of [-30, -40, -50]) {
    for (const targetPct of [50, 80]) {
      for (const timeStopMinPnlPct of [0, 10]) {
        out.push({ name: `stop${stopPct} target${targetPct} timeFloor${timeStopMinPnlPct}`, overrides: { exits: { stopPct, targetPct, timeStopMinPnlPct } } });
      }
    }
  }
  return out;
}

/**
 * Walk-forward for a follower account: main runs with `mainCfg` throughout; on each training window
 * the follower's grid point with the best objective is chosen and then tested on the next window.
 * Only the follower's out-of-sample results are reported.
 */
export async function walkForwardFollower(
  input: Omit<BacktestInput, "from" | "to" | "cfg" | "followers">,
  mainCfg: EngineConfig,
  account: AccountId,
  followerBase: EngineConfig,
  folds: Fold[],
  grid: GridPoint[] = followerExitGrid(),
  onProgress?: (msg: string) => void,
  minTrades = 5,
): Promise<WalkForwardResult> {
  const results: WalkForwardResult["folds"] = [];
  const oosTrades: TradeRecord[] = [];
  const oosLedgers: DayLedger[] = [];
  const run = async (g: GridPoint, from: string, to: string) => {
    const cfg = withOverrides(followerBase, g.overrides);
    const out = await runBacktestAccounts({ ...input, cfg: mainCfg, from, to, followers: [{ account, cfg }] });
    return out.followers[account]!;
  };
  for (const fold of folds) {
    let best: { g: GridPoint; s: Summary; score: number } | null = null;
    for (const g of grid) {
      const out = await run(g, fold.trainFrom, fold.trainTo);
      const score = objective(out.summary, minTrades);
      if (!best || score > best.score) best = { g, s: out.summary, score };
    }
    const test = await run(best!.g, fold.testFrom, fold.testTo);
    oosTrades.push(...test.trades);
    oosLedgers.push(...test.ledgers);
    results.push({ fold, chosen: best!.g.name, train: best!.s, test: test.summary });
    onProgress?.(`fold ${fold.testFrom}..${fold.testTo}: ${best!.g.name} -> OOS trades ${test.summary.trades}, net ₹${test.summary.netPnl}`);
  }
  return { folds: results, oos: summarize(oosTrades, oosLedgers, followerBase.capitalRupees) };
}
