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
 *            --indicator-cutoff 15:15|off  --body-clip   (WP1 data cleaning; cutoff 15:15 by default, body clip off, docs/DATA.md)
 *            --strategy noise-area|orb5   (published rule instead of the conviction model; one position per index)
 *              noise-area: --noise-stop opposite-band|band-vwap  --noise-sizing engine|vol-target
 *                          --noise-lookback 14  --noise-band-mult 1  --noise-every 30
 *              orb5:       --orb-entry engine-window|published (published: entry window opens at the range end)
 *                          --orb-target-r 10  --orb-range-min 5
 *   evaluation harness (WP0; see the delimited block below):
 *            --placebo-random 3000 --seed 7   random-entry placebo with the run's exits, costs and horizons
 *              (--placebo-horizon 45  --placebo-sizing engine|uncapped  --placebo-window 09:25-14:30)
 *            --copy-delay   fills priced off the next closed 5-min bar, +2 ticks per side, at market
 *              (--fill-delay-bars 1  --extra-ticks 2)
 *            --protocol     PLAN §5 verdicts (copy delay, placebo, 10,000 day-block bootstrap, ±20%
 *              perturbations, Bonferroni and deflated Sharpe over the trials ledger); --frozen "<source>"
 *              declares a frozen published rule; --perturb stop,target|all  --no-perturb  --bootstrap 10000
 *            --trial-ledger [reports/trials.jsonl]  --wp WP0  --variant name   (append-only trials ledger;
 *              --protocol always logs its runs)
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
import { DEFAULT_CONFIG, withOverrides, type DeepPartial, type EngineConfig } from "../src/engine/config";
import type { Candle, ScoredEvent } from "../src/engine/types";
import { MARKET_SYMBOLS } from "../src/engine/types";
import { fail, num, parseArgs, readJson, ROOT, str, table, writeJson } from "./lib/node";
// WP0 evaluation harness imports.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AccountId } from "../src/engine/accounts";
import { randomEntryPlacebo, regimeLookup, type PlaceboResult, type PlaceboSizing } from "../src/engine/backtest/placebo";
import { backtestTrial, evaluateProtocol, formatProtocol, perturbParams, placeboTrial, PROTOCOL, runProtocol, tradeStats, type AccountRuns } from "../src/engine/backtest/protocol";
import { describeCopyDelay, type CopyDelay } from "../src/engine/backtest/runBacktest";
import { TrialLedger, type TrialKind, type TrialRecord } from "../src/engine/backtest/trials";

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
// ---- WP1 data cleaning switches (both off unless given; see docs/DATA.md) ----
//   --indicator-cutoff 15:15|off   leave index bars from that IST time out of every feature (closing auction; default 15:15)
//   --body-clip                flatten (and log) a NIFTY/SENSEX bar that moved > 0.6% while the other moved < 0.1%
if (args["indicator-cutoff"] === true) fail("--indicator-cutoff needs a time or off, e.g. --indicator-cutoff 15:15");
const cutoffArg = str(args, "indicator-cutoff", undefined);
const dataCleaning = {
  // The cutoff is on by default (15:15); `--indicator-cutoff off` keeps every bar.
  indicatorCutoffIst: cutoffArg === "off" ? null : cutoffArg,
  bodyClip: args["body-clip"] === true ? true : undefined,
};
const dataCleaningOn = dataCleaning.indicatorCutoffIst !== undefined || dataCleaning.bodyClip === true;
// ---- end WP1 ----
// --- WP3/WP4 published strategies: begin ---
/**
 * --strategy noise-area|orb5: a published rule replaces the conviction model (main and followers).
 * The rules hold one position per index, so that limit is 1 even with --prod-limits; ORB's
 * --orb-entry published opens the entry window at the end of the opening range for that run only.
 */
function publishedStrategyOverrides(): DeepPartial<EngineConfig> {
  const name = str(args, "strategy", undefined);
  if (name === undefined || name === "conviction") return {};
  const pick = <T extends string>(flag: string, allowed: readonly T[], fallback: T): T => {
    const v = (str(args, flag, fallback) ?? fallback).toUpperCase().replace(/-/g, "_") as T;
    return allowed.includes(v) ? v : fail(`--${flag} must be one of ${allowed.map((a) => a.toLowerCase().replace(/_/g, "-")).join(", ")}`);
  };
  if (name === "noise-area") {
    return {
      strategy: {
        mode: "NOISE_AREA",
        noiseArea: {
          stop: pick("noise-stop", ["OPPOSITE_BAND", "BAND_VWAP"] as const, "OPPOSITE_BAND"),
          sizing: pick("noise-sizing", ["ENGINE", "VOL_TARGET"] as const, "ENGINE"),
          lookbackSessions: opt("noise-lookback"),
          bandMult: opt("noise-band-mult"),
          decisionEveryMin: opt("noise-every"),
        },
      },
      sizing: { maxOpenPerIndex: 1 },
    };
  }
  if (name === "orb5") {
    const entry = pick("orb-entry", ["ENGINE_WINDOW", "PUBLISHED"] as const, "ENGINE_WINDOW");
    const rangeMin = opt("orb-range-min") ?? DEFAULT_CONFIG.strategy.orb5.rangeMin;
    const end = 9 * 60 + 15 + rangeMin;
    const rangeEnd = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    return {
      strategy: { mode: "ORB5", orb5: { entry, targetR: opt("orb-target-r"), rangeMin } },
      sizing: { maxOpenPerIndex: 1 },
      gates: entry === "PUBLISHED" ? { noEntryBeforeIst: rangeEnd } : {},
    };
  }
  return fail("--strategy must be noise-area, orb5 or conviction");
}
// --- WP3/WP4 published strategies: end ---
const cfg = withOverrides(withOverrides(configForParams(DEFAULT_CONFIG, mainParams), {
  conviction: { gain: opt("gain"), minActiveWeight: opt("min-active") },
  gates: { minEdgeRatio: opt("min-edge"), minExpectedVsImplied: opt("min-evi"), kEM: opt("kem") },
  sizing: mainLimits,
  features: dataCleaning, // WP1
}), publishedStrategyOverrides()); // WP3/WP4
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

// ===========================================================================
// BEGIN WP0 evaluation harness (PLAN §5 and §6 WP0): random-entry placebo, copy delay, the
// acceptance protocol and the append-only trials ledger. Additive: without these flags a run is
// exactly what it was before. Other work packages: add your flags outside this block.
// ===========================================================================

/** --copy-delay (1 bar, 2 ticks) or --fill-delay-bars / --extra-ticks: the copier's fills; null = the engine's own. */
const wp0Copy: CopyDelay | null = (() => {
  const bars = opt("fill-delay-bars");
  const ticks = opt("extra-ticks");
  if (bars !== undefined && !(Number.isInteger(bars) && bars >= 0 && bars <= 12)) fail("--fill-delay-bars must be an integer from 0 to 12");
  if (ticks !== undefined && !(Number.isInteger(ticks) && ticks >= 0 && ticks <= 20)) fail("--extra-ticks must be an integer from 0 to 20");
  const on = args["copy-delay"] !== undefined;
  if (!on && bars === undefined && ticks === undefined) return null;
  const c = { fillDelayBars: bars ?? (on ? PROTOCOL.copyDelay.fillDelayBars : 0), extraTicks: ticks ?? (on ? PROTOCOL.copyDelay.extraTicks : 0) };
  return c.fillDelayBars > 0 || c.extraTicks > 0 ? c : null;
})();
/** --placebo-random N (bare flag: the protocol's 3,000 draws). */
const wp0Draws: number | null = (() => {
  const v = args["placebo-random"];
  if (v === undefined) return null;
  const n = v === true ? PROTOCOL.placeboMinDraws : Number(v);
  if (!(Number.isInteger(n) && n >= 1 && n <= 1_000_000)) fail("--placebo-random must be a positive integer (number of draws)");
  return n;
})();
const wp0PlaceboOpts = (() => {
  const horizonMin = opt("placebo-horizon");
  if (horizonMin !== undefined && !(horizonMin >= 5 && horizonMin <= 375)) fail("--placebo-horizon must be minutes from 5 to 375");
  const sizing = str(args, "placebo-sizing", "engine") as PlaceboSizing;
  if (sizing !== "engine" && sizing !== "uncapped") fail("--placebo-sizing must be engine or uncapped");
  const w = str(args, "placebo-window", undefined);
  const m = w ? /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(w) : null;
  if (w && !m) fail("--placebo-window must look like 09:25-14:30 (bar-close times)");
  return { horizonMin, sizing, window: m ? { from: m[1], to: m[2] } : undefined };
})();
const wp0Seed = num(args, "seed", 7);
/** Ledger path: --trial-ledger [path], always for --protocol. */
const wp0LedgerPath: string | null =
  typeof args["trial-ledger"] === "string" ? args["trial-ledger"] : args["trial-ledger"] !== undefined || args.protocol !== undefined ? "reports/trials.jsonl" : null;
/** Extra inputs for the replay: empty unless a WP0 flag asks, so default runs are unchanged. */
const wp0RunInput = { ...(wp0Copy ?? {}), ...(wp0Draws ? { recordSignals: true } : {}) };

/** What data a run used: the snapshot path and content hash, or the live fetch. */
function wp0DataId(source: string): string {
  const snap = str(args, "history", undefined);
  if (!snap) return `${source} fetched ${new Date().toISOString()}${str(args, "save-history", undefined) ? ` (saved to ${str(args, "save-history", undefined)})` : ""}; ${from}..${to}`;
  const hash = createHash("sha256").update(readFileSync(resolve(ROOT, snap))).digest("hex").slice(0, 16);
  return `${source}: ${snap} sha256:${hash}; ${from}..${to}`;
}

function wp0Ledger(path: string): TrialLedger {
  const p = resolve(ROOT, path);
  const io = {
    read: () => (existsSync(p) ? readFileSync(p, "utf8") : null),
    append: (text: string) => {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, text);
    },
  };
  return new TrialLedger(io, p);
}

type TrialFields = Omit<TrialRecord, "ts" | "wp" | "variant" | "params" | "data" | "notes">;

function wp0Trial(suffix: string, fields: TrialFields, c: typeof cfg, dataId: string, extra: Record<string, unknown>, notes: string): TrialRecord {
  const variant = [str(args, "variant", "default"), suffix].filter(Boolean).join(" / ");
  return { ts: new Date().toISOString(), wp: str(args, "wp", "unlabelled")!, variant, params: { args, strategy: strategyOf(c), ...extra }, data: dataId, notes, ...fields };
}

function wp0ReportPlacebo(name: string, p: PlaceboResult, strategy: BacktestOutput, capital: number): void {
  const s = p.summary;
  const e = p.settings.exits;
  console.log(`\n=== ${name}: ${s.n} draws, seed ${p.settings.seed} (${p.settings.sessions} sessions) ===`);
  console.log(`sizing ${p.settings.sizing}; horizon: ${p.settings.horizon}; ${p.settings.window}; copy delay: ${p.settings.copyDelay}`);
  console.log(`exits: stop ${e.stopPct}%, target +${e.targetPct}%, trail ${e.trailActivatePct}%/${e.trailGivebackPct}%, time stop below +${e.timeStopMinPnlPct}%, square-off ${e.squareOffIst}`);
  console.log(
    table([
      ["draws", "mean ₹", "SE iid", "SE day", "sd ₹", "hit", "PF", "gross ₹", "charges ₹", "avg win", "avg loss", "hold min"],
      [s.n, s.mean, s.se, s.seDay, s.sd, s.hitRate, s.profitFactor, s.grossPerTrade, s.chargesPerTrade, s.avgWin, s.avgLoss, s.avgHoldingMin],
    ]),
  );
  console.log("By exit: " + Object.entries(s.byExit).map(([k, v]) => `${k} ${v.n} (avg ₹${v.avg})`).join(", "));
  console.log("By index: " + Object.entries(s.byIndex).map(([k, v]) => `${k} ${v.n} (avg ₹${v.avg})`).join(", ") + "; lots: " + Object.entries(s.lots).map(([k, v]) => `${k}×${v}`).join(", "));
  if (Object.keys(p.rejected).length) console.log("Redrawn: " + Object.entries(p.rejected).map(([k, v]) => `${k} ${v}`).join(", "));
  const st = tradeStats(strategy.trades, strategy.days, capital);
  const diff = st.mean - s.mean;
  console.log(
    `Strategy ₹${st.mean.toFixed(2)}/trade (SE ₹${st.se.toFixed(0)}, n ${st.trades}) − placebo ₹${s.mean.toFixed(2)} = ${diff >= 0 ? "+" : ""}₹${diff.toFixed(0)}/trade = ${st.se > 0 ? (diff / st.se).toFixed(2) : "n/a"} SE of the strategy mean (§5.5 needs ≥ 2).`,
  );
}

/** After a plain run: the copy-delay note, the random-entry placebo and the ledger lines, when asked. */
async function wp0AfterRun(main: BacktestOutput, follower: BacktestOutput | null, base: { candles: Record<string, Candle[]>; daily: Record<string, Candle[]> }, out: Record<string, unknown>, source: string): Promise<void> {
  if (!wp0Copy && !wp0Draws && !wp0LedgerPath) return;
  if (wp0Copy) out.copyDelay = wp0Copy;
  const dataId = wp0LedgerPath ? wp0DataId(source) : "";
  const kind: TrialKind = wp0Copy ? "copy-delay" : "strategy";
  const copyNote = `copy delay: ${describeCopyDelay(wp0Copy)}`;
  const trials: TrialRecord[] = [wp0Trial("main", backtestTrial(main, cfg.capitalRupees, kind, "main"), cfg, dataId, { copyDelay: wp0Copy }, copyNote)];
  if (follower && followerCfg) trials.push(wp0Trial(account, backtestTrial(follower, followerCfg.capitalRupees, kind, account), followerCfg, dataId, { copyDelay: wp0Copy }, copyNote));
  if (wp0Draws) {
    const regimeAt = regimeLookup(main.signals ?? []);
    const run = (c: typeof cfg) => randomEntryPlacebo({ cfg: c, candles: base.candles, daily: base.daily, from, to, days: main.days, draws: wp0Draws, seed: wp0Seed, regimeAt, ...wp0PlaceboOpts, ...(wp0Copy ?? {}) });
    const placebo: Record<string, unknown> = {};
    const accounts: [AccountId, typeof cfg, BacktestOutput][] = [["main", cfg, main]];
    if (follower && followerCfg) accounts.push([account, followerCfg, follower]);
    for (const [id, c, strat] of accounts) {
      const p = await run(c);
      wp0ReportPlacebo(`Random-entry placebo: ${accountSpec(id).label}`, p, strat, c.capitalRupees);
      placebo[id] = { settings: p.settings, attempts: p.attempts, rejected: p.rejected, summary: p.summary };
      trials.push(wp0Trial(`placebo ${id}`, placeboTrial(p, id), c, dataId, { placebo: p.settings }, `random-entry placebo; ${copyNote}`));
    }
    out.placeboRandom = placebo;
  }
  if (wp0LedgerPath) {
    const ledger = wp0Ledger(wp0LedgerPath);
    ledger.append(...trials);
    console.log(`\nLogged ${trials.length} trial(s) to ${ledger.path} (${ledger.stats().n} in total).`);
  }
}

/** Ledger lines for every replay and placebo of a protocol run. */
function wp0ProtocolTrials(runs: { main: AccountRuns; follower: AccountRuns | null }, dataId: string): TrialRecord[] {
  const out: TrialRecord[] = [];
  for (const r of runs.follower ? [runs.main, runs.follower] : [runs.main]) {
    const cap = r.cfg.capitalRupees;
    const copyNote = describeCopyDelay(r.copyDelay);
    out.push(wp0Trial(`protocol ${r.account} engine fills`, backtestTrial(r.noDelay, cap, "strategy", r.account), r.cfg, dataId, { protocol: true }, "protocol replay with the engine's own fills"));
    out.push(wp0Trial(`protocol ${r.account} copy delay`, backtestTrial(r.delayed, cap, "copy-delay", r.account), r.cfg, dataId, { protocol: true, copyDelay: r.copyDelay }, `protocol evaluation run; ${copyNote}`));
    out.push(wp0Trial(`protocol ${r.account} placebo`, placeboTrial(r.placebo.noDelay, r.account), r.cfg, dataId, { placebo: r.placebo.noDelay.settings }, "random-entry placebo, engine fills"));
    out.push(wp0Trial(`protocol ${r.account} placebo copy delay`, placeboTrial(r.placebo.delayed, r.account), r.cfg, dataId, { placebo: r.placebo.delayed.settings }, `random-entry placebo; ${copyNote}`));
    for (const p of r.perturbations ?? []) {
      if (p.error) continue;
      const fields: TrialFields = { trades: p.trades, net: p.net, kind: "perturbation", account: r.account, sessions: p.sessions, srSession: p.srSession };
      out.push(wp0Trial(`protocol ${r.account} ${p.param} x${p.factor}`, fields, r.cfg, dataId, { perturb: { param: p.param, factor: p.factor } }, `±${Math.round(PROTOCOL.perturbFraction * 100)}% one-at-a-time perturbation; ${copyNote}`));
    }
  }
  return out;
}

/** --protocol: the PLAN §5 verdicts for this variant (and the small account given with --account). */
async function wp0Protocol(base: { candles: Record<string, Candle[]>; daily: Record<string, Candle[]>; events: ScoredEvent[] }, source: string): Promise<void> {
  if (args["walk-forward"]) fail("--protocol evaluates one replay; walk-forward out-of-sample trades are not wired into it yet.");
  if (args.frozen === true) fail('--frozen needs the published source, e.g. --frozen "Zarattini, Aziz & Barbon (2024), SSRN 4824172"');
  const frozen = typeof args.frozen === "string" ? args.frozen : null;
  const resamples = num(args, "bootstrap", PROTOCOL.bootstrapResamples);
  if (!(Number.isInteger(resamples) && resamples >= 1_000)) fail("--bootstrap must be an integer of at least 1000 (resamples)");
  let perturb: ReturnType<typeof perturbParams> | null = null;
  try {
    perturb = args["no-perturb"] !== undefined ? null : perturbParams(str(args, "perturb", undefined));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const t0 = Date.now();
  const log = (m: string) => console.log(`[protocol ${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
  log(`variant "${str(args, "variant", "default")}", ${from} .. ${to}${perturb ? `; ${perturb.length * 2} perturbation replays follow the two main ones` : ""}`);
  const runs = await runProtocol(
    {
      base: { candles: base.candles, daily: base.daily, events: base.events, noEvents: params.noEvents },
      cfg,
      from,
      to,
      follower: followerCfg ? { account, cfg: followerCfg } : null,
      copyDelay: wp0Copy ?? PROTOCOL.copyDelay,
      placebo: { draws: wp0Draws ?? PROTOCOL.placeboMinDraws, seed: wp0Seed, ...wp0PlaceboOpts },
      perturb,
      fraction: PROTOCOL.perturbFraction,
    },
    log,
  );
  report("Strategy, engine fills", runs.main.noDelay);
  report("Strategy, copy delay (evaluation run)", runs.main.delayed);
  if (runs.follower) report(`${accountSpec(account).label}, copy delay (evaluation run)`, runs.follower.delayed);
  // Every replay and placebo of the protocol is a trial: log them, then count.
  const dataId = wp0DataId(source);
  const ledger = wp0Ledger(wp0LedgerPath ?? "reports/trials.jsonl");
  const lines = wp0ProtocolTrials(runs, dataId);
  ledger.append(...lines);
  const stats = ledger.stats();
  const ctx = { from, to, frozen, ledger: stats, thresholds: PROTOCOL, bootstrap: { resamples, seed: wp0Seed } };
  const fRep = runs.follower ? evaluateProtocol(runs.follower, accountSpec(account).label, ctx) : null;
  const mRep = evaluateProtocol(runs.main, accountSpec("main").label, { ...ctx, followers: fRep ? [{ account, label: fRep.label, verdict: fRep.verdict }] : undefined });
  console.log(`\n${formatProtocol(mRep)}`);
  if (fRep) console.log(`\n${formatProtocol(fRep)}`);
  const json = (rep: typeof mRep, r: AccountRuns) => ({
    ...rep,
    runs: {
      noDelay: { summary: r.noDelay.summary, trades: r.noDelay.trades, notes: r.noDelay.notes },
      delayed: { summary: r.delayed.summary, trades: r.delayed.trades, notes: r.delayed.notes },
      placebo: { noDelay: { attempts: r.placebo.noDelay.attempts, rejected: r.placebo.noDelay.rejected }, delayed: { attempts: r.placebo.delayed.attempts, rejected: r.placebo.delayed.rejected } },
      perturbations: r.perturbations,
    },
  });
  const path = writeJson(str(args, "out", `reports/protocol-${from}-${to}.json`)!, {
    params,
    config: strategyOf(cfg),
    history: source,
    data: dataId,
    ledger: stats,
    main: json(mRep, runs.main),
    follower: fRep && runs.follower ? json(fRep, runs.follower) : null,
  });
  console.log(`\nLogged ${lines.length} trial(s) to ${stats.path} (${stats.n} in total). Saved ${path} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ===========================================================================
// END WP0 evaluation harness
// ===========================================================================

async function main() {
  const history = await loadHistory();
  if (history.errors.length) console.log(`History warnings: ${history.errors.slice(0, 5).join("; ")}`);
  const nifty = history.candles[MARKET_SYMBOLS.NIFTY] ?? [];
  if (nifty.length === 0) fail("No NIFTY 5-minute history available.");
  console.log(`History source: ${history.source}; NIFTY 5m bars ${istDate(nifty[0].t)} .. ${istDate(nifty.at(-1)!.t)}`);
  const events = params.noEvents ? [] : loadEvents();
  const base = { candles: history.candles, daily: history.daily, events };

  if (args.protocol !== undefined) return wp0Protocol(base, history.source); // WP0 hook: the acceptance protocol

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
    ? await runBacktestAccounts({ ...base, cfg, from, to, noEvents: params.noEvents, followers: [{ account, cfg: followerCfg }], ...wp0RunInput }, progress)
    : { main: await runBacktest({ ...base, cfg, from, to, noEvents: params.noEvents, ...wp0RunInput }, progress), followers: {} };
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
  // ---- WP1: recorded only when a cleaning switch is on, so default reports stay byte-identical ----
  if (dataCleaningOn) {
    const { indicatorCutoffIst, bodyClip } = cfg.features;
    out.dataCleaning = { indicatorCutoffIst, bodyClip };
    console.log(`Data cleaning: indicator cutoff ${indicatorCutoffIst ?? "off"}, body clip ${bodyClip ? "on" : "off"}.`);
  }
  // ---- end WP1 ----
  // --- WP3/WP4 published strategies: begin ---
  if (cfg.strategy.mode !== "CONVICTION") {
    out.published = { ...cfg.strategy, entryWindow: [cfg.gates.noEntryBeforeIst, cfg.gates.noEntryAfterIst], maxOpenPerIndex: cfg.sizing.maxOpenPerIndex };
    console.log(`Published strategy ${cfg.strategy.mode}: ${JSON.stringify(cfg.strategy.mode === "ORB5" ? cfg.strategy.orb5 : cfg.strategy.noiseArea)}; entry window ${cfg.gates.noEntryBeforeIst}-${cfg.gates.noEntryAfterIst}.`);
  }
  // --- WP3/WP4 published strategies: end ---
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
  await wp0AfterRun(main, follower ?? null, base, out, history.source); // WP0 hook: copy delay, random placebo, ledger
  const path = writeJson(str(args, "out", `reports/backtest-${from}-${to}.json`)!, out);
  console.log(`\nSaved ${path} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
