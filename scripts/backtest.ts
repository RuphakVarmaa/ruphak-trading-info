/**
 * Backtest CLI: replays NIFTY/SENSEX through the production engine and prints an honest report.
 *
 *   npm run backtest -- --from 2026-08-10 --to 2026-10-07
 *   npm run backtest -- --from 2026-08-10 --to 2026-10-07 --placebo           # + no-events and shuffled-events baselines
 *   npm run backtest -- --from 2026-07-01 --to 2026-10-07 --walk-forward      # out-of-sample folds (slow)
 *   options: --index NIFTY|SENSEX|BOTH  --events .cache/events/scored.json  --no-events
 *            --threshold-delta 0.1  --stop 30  --target 50  --seed 7  --out reports/name.json
 *            --gain 1.2  --min-edge 0.10  --min-evi 0.35  --min-active 0.30  --kem 1.0   (strategy overrides)
 *
 * History: Groww 5-minute index candles cached by `npm run fetch-history` when present (multi-year),
 * otherwise Yahoo (about 60 days of 5-minute bars). Option prices are synthetic (Black-Scholes on
 * India VIX); the report says so.
 */
import type { BacktestParams } from "../src/engine/api-types";
import { loadYahooHistory, type MarketHistory } from "../src/engine/backtest/history";
import { attribution } from "../src/engine/backtest/metrics";
import { configForParams, runBacktest, type BacktestOutput } from "../src/engine/backtest/runBacktest";
import { makeFolds, walkForward } from "../src/engine/backtest/walkForward";
import { addDays, istDate } from "../src/engine/clock";
import { DEFAULT_CONFIG, withOverrides } from "../src/engine/config";
import type { Candle, ScoredEvent } from "../src/engine/types";
import { MARKET_SYMBOLS } from "../src/engine/types";
import { fail, num, parseArgs, readJson, str, table, writeJson } from "./lib/node";

const args = parseArgs();
const today = istDate(Date.now());
const to = str(args, "to", addDays(today, -1))!;
const from = str(args, "from", addDays(to, -45))!;
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail("--from and --to must be YYYY-MM-DD with from <= to");
const index = (str(args, "index", "BOTH") ?? "BOTH").toUpperCase() as BacktestParams["index"];
const params: BacktestParams = {
  from,
  to,
  index,
  thresholdDelta: num(args, "threshold-delta", 0),
  stopPct: num(args, "stop", Math.abs(DEFAULT_CONFIG.exits.stopPct)),
  targetPct: num(args, "target", DEFAULT_CONFIG.exits.targetPct),
  noEvents: args["no-events"] === true,
};
// Optional strategy overrides on top of the parameters above (deep-merged, validated).
const opt = (name: string): number | undefined => {
  if (args[name] === undefined) return undefined;
  const v = num(args, name, NaN);
  if (!Number.isFinite(v)) fail(`--${name} must be a number`);
  return v;
};
const cfg = withOverrides(configForParams(DEFAULT_CONFIG, params), {
  conviction: { gain: opt("gain"), minActiveWeight: opt("min-active") },
  gates: { minEdgeRatio: opt("min-edge"), minExpectedVsImplied: opt("min-evi"), kEM: opt("kem") },
});

/** The strategy settings a report was produced with. */
function strategyOf(c: typeof cfg) {
  const { gain, minActiveWeight, thresholds, counterTrendThreshold, priorWeights } = c.conviction;
  const { minEdgeRatio, minExpectedVsImplied, kEM } = c.gates;
  return { gain, minActiveWeight, thresholds, counterTrendThreshold, priorWeights, minEdgeRatio, minExpectedVsImplied, kEM, stopPct: c.exits.stopPct, targetPct: c.exits.targetPct };
}

function mergeCandles(a: Candle[] = [], b: Candle[] = []): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of a) m.set(c.t, c);
  for (const c of b) m.set(c.t, c);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

async function loadHistory(): Promise<MarketHistory & { source: string }> {
  console.log("Loading Yahoo history (5m ~60 days, daily 2 years)...");
  const yahoo = await loadYahooHistory({ dailyRange: "2y" });
  const cached = readJson<Record<string, Candle[]>>(".cache/history/groww-5m.json");
  if (!cached) return { ...yahoo, source: "yahoo" };
  for (const [sym, arr] of Object.entries(cached)) yahoo.candles[sym] = mergeCandles(arr, yahoo.candles[sym]);
  return { ...yahoo, source: "groww cache + yahoo" };
}

function loadEvents(): ScoredEvent[] {
  const path = str(args, "events", ".cache/events/scored.json")!;
  const events = readJson<ScoredEvent[]>(path);
  if (!events) {
    console.log(`No scored events at ${path}: the event layer contributes nothing (run bootstrap-events + score-batch).`);
    return [];
  }
  console.log(`Loaded ${events.length} scored events from ${path}.`);
  return events;
}

function report(name: string, out: BacktestOutput): void {
  const s = out.summary;
  console.log(`\n=== ${name}: ${out.days[0] ?? from} .. ${out.days.at(-1) ?? to} (${s.days} sessions) ===`);
  console.log(
    table([
      ["trades", "hit", "exp %prem", "exp ₹", "net ₹", "gross ₹", "charges ₹", "PF", "Sharpe", "Sortino", "maxDD ₹", "maxDD %", "hold min", "trades/day"],
      [s.trades, s.hitRate, s.expectancyPct, s.expectancyRupees, s.netPnl, s.grossPnl, s.charges, s.profitFactor, s.sharpe, s.sortino, s.maxDrawdown, s.maxDrawdownPct, s.avgHoldingMin, s.tradesPerDay],
    ]),
  );
  const attr = attribution(out.trades);
  if (attr.length) {
    console.log("\nBy dominant signal (and P&L attributed by entry shares):");
    console.log(table([["source", "trades", "hit", "exp %", "PF", "t", "attributed ₹"], ...attr.map((a) => [a.source, a.trades, a.hitRate, a.expectancyPct, a.profitFactor, a.tStat, a.attributedPnl])]));
  }
  const byExit = new Map<string, { n: number; pnl: number }>();
  for (const t of out.trades) {
    const e = byExit.get(t.exitReason) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.pnl;
    byExit.set(t.exitReason, e);
  }
  if (byExit.size) console.log("\nBy exit: " + [...byExit].map(([k, v]) => `${k} ${v.n} (₹${Math.round(v.pnl)})`).join(", "));
  for (const n of out.notes) console.log(`note: ${n}`);
}

async function main() {
  const history = await loadHistory();
  if (history.errors.length) console.log(`History warnings: ${history.errors.slice(0, 5).join("; ")}`);
  const nifty = history.candles[MARKET_SYMBOLS.NIFTY] ?? [];
  if (nifty.length === 0) fail("No NIFTY 5-minute history available.");
  console.log(`History source: ${history.source}; NIFTY 5m bars ${istDate(nifty[0].t)} .. ${istDate(nifty.at(-1)!.t)}`);
  const events = params.noEvents ? [] : loadEvents();
  const base = { candles: history.candles, daily: history.daily, events };

  if (args["walk-forward"]) {
    const folds = makeFolds(from, to, num(args, "train-days", 56), num(args, "test-days", 14));
    if (folds.length === 0) fail("Range too short for walk-forward folds (needs train + test days).");
    console.log(`Walk-forward over ${folds.length} fold(s); only out-of-sample results count.`);
    const wf = await walkForward(base, cfg, folds, undefined, (m) => console.log(m));
    console.log("\n=== Walk-forward out-of-sample ===");
    console.log(table([["trades", "hit", "exp %", "net ₹", "PF", "Sharpe", "maxDD %"], [wf.oos.trades, wf.oos.hitRate, wf.oos.expectancyPct, wf.oos.netPnl, wf.oos.profitFactor, wf.oos.sharpe, wf.oos.maxDrawdownPct]]));
    const path = writeJson(str(args, "out", `reports/walkforward-${from}-${to}.json`)!, { params, strategy: strategyOf(cfg), folds: wf.folds, oos: wf.oos });
    console.log(`\nSaved ${path}`);
    return;
  }

  const t0 = Date.now();
  const main = await runBacktest({ ...base, cfg, from, to, noEvents: params.noEvents }, (day, p) => process.stdout.write(`\r${day} ${(p * 100).toFixed(0)}%   `));
  process.stdout.write("\n");
  report("Strategy", main);
  const out: Record<string, unknown> = {
    params,
    config: strategyOf(cfg),
    history: history.source,
    strategy: { summary: main.summary, trades: main.trades, ledgers: main.ledgers, attribution: main.attribution, notes: main.notes },
  };

  if (args.placebo) {
    const seed = num(args, "seed", 7);
    const noEv = await runBacktest({ ...base, cfg, from, to, noEvents: true });
    report("Placebo: no events", noEv);
    const shuffled = await runBacktest({ ...base, cfg, from, to, shuffleSeed: seed });
    report(`Placebo: shuffled event times (seed ${seed})`, shuffled);
    console.log(`\nEvent layer edge vs no-events: ₹${(main.summary.netPnl - noEv.summary.netPnl).toFixed(0)}; vs shuffled: ₹${(main.summary.netPnl - shuffled.summary.netPnl).toFixed(0)}.`);
    console.log("A real event edge should beat the shuffled run; if shuffled does as well, the gain is noise or leakage.");
    out.placebo = { noEvents: noEv.summary, shuffled: shuffled.summary, seed };
  }
  const path = writeJson(str(args, "out", `reports/backtest-${from}-${to}.json`)!, out);
  console.log(`\nSaved ${path} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
