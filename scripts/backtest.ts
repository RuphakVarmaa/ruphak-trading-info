/**
 * Backtest CLI: replays NIFTY/SENSEX through the production engine and prints an honest report.
 *
 *   npm run backtest -- --from 2026-08-10 --to 2026-10-07
 *   npm run backtest -- --from 2026-08-10 --to 2026-10-07 --placebo           # + no-events and shuffled-events baselines
 *   npm run backtest -- --from 2026-07-01 --to 2026-10-07 --walk-forward      # out-of-sample folds (slow)
 *   npm run backtest -- --from 2026-07-23 --to 2026-10-08 --index NIFTY --no-events --account small10k   # + the ₹10k account
 *   npm run backtest -- --from 2026-07-23 --to 2026-10-08 --no-events --prod-limits --account small5k    # + the ₹5k account
 *   npm run backtest -- ... --account small10k --walk-forward --train-days 28 --test-days 14             # fit its exits out of sample
 *   options: --index NIFTY|SENSEX|BOTH  --events .cache/events/scored.json  --no-events
 *            --account small10k|small5k (follower account; --stop/--target/--band 40-70 then apply to it)
 *            --threshold-delta 0.1  --stop 30  --target 50  --seed 7  --out reports/name.json
 *            --gain 1.2  --min-edge 0.10  --min-evi 0.35  --min-active 0.30  --kem 1.0   (strategy overrides)
 *            --prod-limits (main at the production limits: 2 open per index, 2 in total, 8 entries a day)
 *            --max-open-per-index 2  --max-open-total 2  --max-trades-per-day 8   (main's limits one by one)
 *            --save-history .cache/history/snap.json  --history .cache/history/snap.json   (replay identical data)
 *
 * History: Groww 5-minute index candles cached by `npm run fetch-history` when present (multi-year),
 * otherwise Yahoo (about 60 days of 5-minute bars). Option prices are synthetic (Black-Scholes on
 * India VIX); the report says so. --history replays a snapshot saved by --save-history instead of
 * fetching, so before/after comparisons see the same bars.
 */
import type { BacktestParams } from "../src/engine/api-types";
import { loadYahooHistory, type MarketHistory } from "../src/engine/backtest/history";
import { attribution } from "../src/engine/backtest/metrics";
import { ACCOUNT_IDS, accountConfig, accountSpec, parseAccountId } from "../src/engine/accounts";
import { configForParams, runBacktest, runBacktestAccounts, type BacktestOutput } from "../src/engine/backtest/runBacktest";
import { followerExitGrid, makeFolds, walkForward, walkForwardFollower } from "../src/engine/backtest/walkForward";
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
const account = parseAccountId(str(args, "account", "main")) ?? fail(`--account must be one of ${ACCOUNT_IDS.join(", ")}`);
const follows = account !== "main";
// With a follower account, --stop/--target apply to the follower; main keeps its default exits.
const mainParams = follows ? { ...params, stopPct: Math.abs(DEFAULT_CONFIG.exits.stopPct), targetPct: DEFAULT_CONFIG.exits.targetPct } : params;
// Main's position and entry limits. --prod-limits uses production's: MAX_OPEN_PER_INDEX 2 and
// MAX_TRADES_PER_DAY 8 (workers/engine/wrangler.jsonc) and 2 open positions in total (main's stored
// settings). Follower accounts pin their own limits, so these never reach them.
const prodLimits = args["prod-limits"] === true;
const limit = (name: string, prod: number, ok: (n: number) => boolean): number | undefined => {
  const v = opt(name) ?? (prodLimits ? prod : undefined);
  if (v !== undefined && !ok(v)) fail(`--${name} is out of range`);
  return v;
};
const mainLimits = {
  maxOpenPerIndex: limit("max-open-per-index", 2, (n) => Number.isInteger(n) && n >= 1 && n <= 3),
  maxOpenTotal: limit("max-open-total", 2, (n) => Number.isInteger(n) && n >= 1),
  maxTradesPerDay: limit("max-trades-per-day", 8, (n) => Number.isInteger(n) && n >= 1 && n <= 12),
};
const cfg = withOverrides(configForParams(DEFAULT_CONFIG, mainParams), {
  conviction: { gain: opt("gain"), minActiveWeight: opt("min-active") },
  gates: { minEdgeRatio: opt("min-edge"), minExpectedVsImplied: opt("min-evi"), kEM: opt("kem") },
  sizing: mainLimits,
});
// --- WP2/WP5 gate flags (begin): additive and tightening only; nothing changes unless a flag is given ---
//   --em-model legacy|calibrated  --realized-vol-factor 0.6  --move-beta 0   (WP2: calibrated edge gate)
//   --vol-cheapness  --vol-k 1                                               (WP5: HAR-RV vol-cheapness gate)
// Applied to cfg's gates group after the statement above (validated by withOverrides), so that statement
// stays as it is for the other work packages. Followers inherit these gates through accountConfig(cfg).
{
  const model = str(args, "em-model", undefined);
  if (model !== undefined && model !== "legacy" && model !== "calibrated") fail("--em-model must be legacy or calibrated");
  cfg.gates = withOverrides(cfg, {
    gates: {
      expectedMoveModel: model as "legacy" | "calibrated" | undefined,
      realizedVolFactor: opt("realized-vol-factor"),
      scoreMoveBeta: opt("move-beta"),
      volCheapness: { enabled: args["vol-cheapness"] === true ? true : undefined, k: opt("vol-k") },
    },
  }).gates;
  const g = cfg.gates;
  if (g.expectedMoveModel !== "legacy") console.log(`Edge gate: calibrated (realized vol ${g.realizedVolFactor}× implied, beta ${g.scoreMoveBeta}) on top of the legacy gate.`);
  if (g.volCheapness.enabled) console.log(`Vol-cheapness gate: HAR-RV forecast >= ${g.volCheapness.k}× implied session variance.`);
}
// --- WP2/WP5 gate flags (end) ---
const band = str(args, "band", undefined);
const bandMatch = band ? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(band) : null;
if (band && !bandMatch) fail("--band must look like 40-70");
const followerCfg = follows
  ? withOverrides(accountConfig(cfg, account), {
      exits: { stopPct: args.stop !== undefined ? -Math.abs(num(args, "stop", 35)) : undefined, targetPct: args.target !== undefined ? num(args, "target", 60) : undefined },
      selection: bandMatch ? { minPremium: Number(bandMatch[1]), maxPremium: Number(bandMatch[2]) } : {},
    })
  : null;

/** The strategy settings a report was produced with. */
function strategyOf(c: typeof cfg) {
  const { gain, minActiveWeight, thresholds, counterTrendThreshold, priorWeights } = c.conviction;
  const { minEdgeRatio, minExpectedVsImplied, kEM } = c.gates;
  const { maxOpenPerIndex, maxOpenTotal, maxTradesPerDay } = c.sizing;
  return {
    gain,
    minActiveWeight,
    thresholds,
    counterTrendThreshold,
    priorWeights,
    minEdgeRatio,
    minExpectedVsImplied,
    kEM,
    stopPct: c.exits.stopPct,
    targetPct: c.exits.targetPct,
    limits: { maxOpenPerIndex, maxOpenTotal: maxOpenTotal ?? null, maxTradesPerDay },
  };
}

function mergeCandles(a: Candle[] = [], b: Candle[] = []): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of a) m.set(c.t, c);
  for (const c of b) m.set(c.t, c);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

async function fetchHistory(): Promise<MarketHistory & { source: string }> {
  console.log("Loading Yahoo history (5m ~60 days, daily 2 years)...");
  const yahoo = await loadYahooHistory({ dailyRange: "2y" });
  const cached = readJson<Record<string, Candle[]>>(".cache/history/groww-5m.json");
  if (!cached) return { ...yahoo, source: "yahoo" };
  for (const [sym, arr] of Object.entries(cached)) yahoo.candles[sym] = mergeCandles(arr, yahoo.candles[sym]);
  return { ...yahoo, source: "groww cache + yahoo" };
}

/** Fetched history, or a snapshot saved earlier with --save-history (--history path). */
async function loadHistory(): Promise<MarketHistory & { source: string }> {
  const snapshot = str(args, "history", undefined);
  if (snapshot) {
    const h = readJson<MarketHistory & { source: string; savedAt?: string }>(snapshot) ?? fail(`No history snapshot at ${snapshot}.`);
    console.log(`Replaying the history snapshot ${snapshot} (${h.source}, saved ${h.savedAt ?? "?"}).`);
    return { ...h, source: `snapshot of ${h.source}` };
  }
  const h = await fetchHistory();
  const save = str(args, "save-history", undefined);
  if (save) console.log(`Saved the history snapshot to ${writeJson(save, { ...h, savedAt: new Date().toISOString() })}.`);
  return h;
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
  const byIndex = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const t of out.trades) {
    const e = byIndex.get(t.index) ?? { n: 0, wins: 0, pnl: 0 };
    e.n++;
    if (t.pnl >= 0) e.wins++;
    e.pnl += t.pnl;
    byIndex.set(t.index, e);
  }
  if (byIndex.size) console.log("By index: " + [...byIndex].map(([k, v]) => `${k} ${v.n} trades, ${v.wins} won (₹${Math.round(v.pnl)})`).join("; "));
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
    if (followerCfg) {
      console.log(`Fitting the ${accountSpec(account).label}'s exits (${followerExitGrid().length} combos); main's settings stay fixed.`);
      const wf = await walkForwardFollower(base, cfg, account, followerCfg, folds, followerExitGrid(), (m) => console.log(m));
      console.log(`\n=== Walk-forward out-of-sample: ${accountSpec(account).label} ===`);
      console.log(table([["trades", "hit", "exp %", "net ₹", "PF", "Sharpe", "maxDD %"], [wf.oos.trades, wf.oos.hitRate, wf.oos.expectancyPct, wf.oos.netPnl, wf.oos.profitFactor, wf.oos.sharpe, wf.oos.maxDrawdownPct]]));
      const path = writeJson(str(args, "out", `reports/walkforward-${account}-${from}-${to}.json`)!, { params, account, selection: followerCfg.selection, folds: wf.folds, oos: wf.oos });
      console.log(`\nSaved ${path}`);
      return;
    }
    const wf = await walkForward(base, cfg, folds, undefined, (m) => console.log(m));
    console.log("\n=== Walk-forward out-of-sample ===");
    console.log(table([["trades", "hit", "exp %", "net ₹", "PF", "Sharpe", "maxDD %"], [wf.oos.trades, wf.oos.hitRate, wf.oos.expectancyPct, wf.oos.netPnl, wf.oos.profitFactor, wf.oos.sharpe, wf.oos.maxDrawdownPct]]));
    const path = writeJson(str(args, "out", `reports/walkforward-${from}-${to}.json`)!, { params, strategy: strategyOf(cfg), folds: wf.folds, oos: wf.oos });
    console.log(`\nSaved ${path}`);
    return;
  }

  const t0 = Date.now();
  const progress = (day: string, p: number) => process.stdout.write(`\r${day} ${(p * 100).toFixed(0)}%   `);
  const runs = followerCfg
    ? await runBacktestAccounts({ ...base, cfg, from, to, noEvents: params.noEvents, followers: [{ account, cfg: followerCfg }] }, progress)
    : { main: await runBacktest({ ...base, cfg, from, to, noEvents: params.noEvents }, progress), followers: {} };
  const main = runs.main;
  process.stdout.write("\n");
  report(followerCfg ? "Main account" : "Strategy", main);
  const out: Record<string, unknown> = {
    params,
    config: strategyOf(cfg),
    history: history.source,
    strategy: { summary: main.summary, trades: main.trades, ledgers: main.ledgers, attribution: main.attribution, notes: main.notes },
  };
  // --- WP2/WP5 gate flags (begin): recorded only when used, so the default output stays byte-identical ---
  {
    const { expectedMoveModel, realizedVolFactor, scoreMoveBeta, volCheapness } = cfg.gates;
    if (expectedMoveModel !== "legacy" || volCheapness.enabled) out.gateModels = { expectedMoveModel, realizedVolFactor, scoreMoveBeta, volCheapness };
  }
  // --- WP2/WP5 gate flags (end) ---
  const follower = runs.followers[account as keyof typeof runs.followers];
  if (followerCfg && follower) {
    report(accountSpec(account).label, follower);
    out.account = { id: account, config: strategyOf(followerCfg), selection: followerCfg.selection, summary: follower.summary, trades: follower.trades, ledgers: follower.ledgers, notes: follower.notes };
  }

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
