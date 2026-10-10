/**
 * WP2 (edge-gate honesty) and WP5 (HAR-RV vol-cheapness gate): calibration and diagnostics.
 *
 *   npx tsx scripts/research/wp2-wp5-gates.ts --history <snapshot.json> --hourly <dir> \
 *       [--from 2026-07-23] [--to 2026-10-08] [--out reports/wp2-wp5-calibration.json]
 *
 * Inputs (read only; nothing is fetched): a backtest history snapshot saved with
 * `npm run backtest -- ... --save-history` (5-minute bars ~60 days, daily bars 2 years) and Yahoo
 * chart v8 JSON files with 1-hour bars (`NSEI.json`, `BSESN.json`, `INDIAVIX.json`, range 730d).
 *
 * WP2. The engine is replayed exactly as `npm run backtest -- --no-events --prod-limits` does
 * (same config, 90 s data lag, 5-minute decisions) and every decision point inside the entry
 * window is recorded: conviction score, regime, the engine's holding horizon h, spot and VIX.
 * For each point the realized log move to t + h is taken from the 5-minute bars visible at t + h,
 * and the option's implied sigma over h is VIX × vixMultiplier × sqrt(h / (375 × 252)).
 *  - realizedVolFactor f = RMS(realized move) / RMS(implied sigma) over all entry-window points;
 *  - beta = slope (through the origin, as the gate uses it) of z = sign(score) × move / (f × sigma)
 *    on |score| over the points with score != 0; standard errors clustered by session.
 * Both are estimated walk-forward: 42 calendar days of training, then 14 days of testing
 * (makeFolds, as in the evaluation protocol); a fold's parameters never see its test window.
 *
 * WP5. HAR-RV is fitted on per-session realized variance (5-minute RV, hourly RV, daily Parkinson
 * range) and evaluated out of sample with an expanding window (every forecast refitted on earlier
 * sessions only). The gate's pass rate over two years uses the engine's own forecast function.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TradingCalendar } from "../../src/engine/calendar/calendar";
import { MINUTE_MS, addDays, istAt } from "../../src/engine/clock";
import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../../src/engine/config";
import { configForParams } from "../../src/engine/backtest/runBacktest";
import { makeFolds, type Fold } from "../../src/engine/backtest/walkForward";
import { istDateOf, istMinuteOfDay, lastIndexAtOrBefore } from "../../src/engine/market/candles";
import { YAHOO_LAG_MS } from "../../src/engine/market/replayMarketData";
import {
  HAR_MIN_OBS,
  fitHar,
  forecastFromDaily,
  harOutOfSample,
  impliedSessionVariancePct2,
  intradaySeries,
  oosR2,
  parkinsonSeries,
  type HarFit,
  type SessionVariance,
} from "../../src/engine/market/volForecast";
import { parseYahooChart } from "../../src/engine/market/yahooClient";
import { runEndOfDay } from "../../src/engine/pipeline/dayLifecycle";
import { runPositionCycle } from "../../src/engine/pipeline/positionCycle";
import { runTradingCycle } from "../../src/engine/pipeline/tradingCycle";
import { yearsToExpiry } from "../../src/engine/pricing/timeToExpiry";
import { syntheticQuote, syntheticVol } from "../../src/engine/pricing/syntheticOptionPricer";
import { edgeGates, evaluateEdge, squareOffMs, volCheapnessGate } from "../../src/engine/strategy/gates";
import { sigmaPct } from "../../src/engine/strategy/signals";
import { createReplayDeps } from "../../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type IndexId, type OptionContract, type Regime, type TradeRecord } from "../../src/engine/types";
import { fail, parseArgs, str, table, writeJson } from "../lib/node";

const args = parseArgs();
const historyPath = str(args, "history") ?? fail("--history <snapshot.json> is required");
const hourlyDir = str(args, "hourly") ?? fail("--hourly <dir with NSEI.json BSESN.json INDIAVIX.json> is required");
const from = str(args, "from", "2026-07-23")!;
const to = str(args, "to", "2026-10-08")!;
const outPath = str(args, "out", "reports/wp2-wp5-calibration.json")!;

interface Snapshot {
  candles: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
}
const hist = JSON.parse(readFileSync(resolve(historyPath), "utf8")) as Snapshot;
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];
const calendar = new TradingCalendar();
const LAG = YAHOO_LAG_MS;
const BAR = 5 * MINUTE_MS;

// The backtest CLI's config for `--no-events --prod-limits` (index BOTH, default stop/target).
const cfg: EngineConfig = withOverrides(
  configForParams(DEFAULT_CONFIG, { from, to, index: "BOTH", thresholdDelta: 0, stopPct: 30, targetPct: 50, noEvents: true }),
  { sizing: { maxOpenPerIndex: 2, maxOpenTotal: 2, maxTradesPerDay: 8 } },
);

const r2 = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : NaN);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rms = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));
const sorted = <T>(xs: T[], key: (x: T) => number) => [...xs].sort((a, b) => key(a) - key(b));

// ------------------------------------------------------------------------------------------------
// 1. Replay the engine and record every decision point
// ------------------------------------------------------------------------------------------------

interface DecisionPoint {
  index: IndexId;
  t: number;
  date: string;
  /** IST minute of day of the decision. */
  minute: number;
  spot: number;
  vix: number;
  /** The option's implied vol the edge gate uses (decimal). */
  vol: number;
  score: number;
  passes: boolean;
  regime: Regime;
  /** The engine's holding horizon at t (regime horizon capped by the square-off). */
  horizonMin: number;
  plan: null | { contract: OptionContract; refPremium: number; horizonMin: number; refSpot: number };
}

function engineHorizon(regime: Regime, t: number): number {
  return Math.max(5, Math.min(cfg.exits.horizonMinByRegime[regime], Math.floor((squareOffMs(t, cfg) - t) / MINUTE_MS)));
}

async function replay(): Promise<{ points: DecisionPoint[]; trades: TradeRecord[]; days: string[] }> {
  const nifty = new Set(hist.candles[MARKET_SYMBOLS.NIFTY].map((c) => istDateOf(c.t)));
  const sensex = new Set(hist.candles[MARKET_SYMBOLS.SENSEX].map((c) => istDateOf(c.t)));
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (calendar.isTradingDay(d) && nifty.has(d) && sensex.has(d)) days.push(d);
  const deps = createReplayDeps({ cfg, startMs: istAt(days[0], "09:00"), candles: hist.candles, daily: hist.daily, calendar, lagMs: LAG });
  const points: DecisionPoint[] = [];
  const entryFrom = Number(cfg.gates.noEntryBeforeIst.slice(0, 2)) * 60 + Number(cfg.gates.noEntryBeforeIst.slice(3));
  const entryTo = Number(cfg.gates.noEntryAfterIst.slice(0, 2)) * 60 + Number(cfg.gates.noEntryAfterIst.slice(3));
  for (const day of days) {
    // Same loop as BacktestRun.step (src/engine/backtest/runBacktest.ts).
    for (let t = istAt(day, "09:15") + LAG; t <= istAt(day, "15:30") + LAG; t += BAR) {
      deps.clock.set(t);
      const r = await runTradingCycle(deps, { events: [], noEvents: true, decisionEveryMs: BAR, snapshotEveryMs: 30 * MINUTE_MS });
      const minute = istMinuteOfDay(t);
      if (r.phase === "OPEN" && minute >= entryFrom && minute <= entryTo) {
        for (const index of INDICES) {
          const f = r.features[index];
          const c = r.convictions[index];
          if (!f || !c || !(f.spot > 0) || !(f.vix > 0) || f.dataAgeSec > cfg.gates.maxDataAgeSec) continue;
          const d = r.decisions.find((x) => x.index === index);
          const p = d?.plan ?? null;
          points.push({
            index,
            t,
            date: day,
            minute,
            spot: f.spot,
            vix: f.vix,
            vol: syntheticVol(index, f.vix, cfg),
            score: c.score,
            passes: c.passes,
            regime: c.regime,
            horizonMin: engineHorizon(c.regime, t),
            plan: p ? { contract: p.contract, refPremium: p.refPremium, horizonMin: p.horizonMin, refSpot: p.refSpot } : null,
          });
        }
      }
      await runPositionCycle(deps, { convictions: r.convictions, events: [] });
    }
    deps.clock.set(istAt(day, "16:00"));
    await runEndOfDay(deps);
  }
  const trades = (await deps.repo.trades.between(istAt(from, "00:00"), istAt(addDays(to, 1), "00:00"), "BACKTEST")).sort((a, b) => a.entryMs - b.entryMs);
  return { points, trades, days };
}

// ------------------------------------------------------------------------------------------------
// Realized moves from the 5-minute bars (point-in-time: the bar must have closed lag before T)
// ------------------------------------------------------------------------------------------------

const bars5: Record<IndexId, Candle[]> = {
  NIFTY: [...hist.candles[MARKET_SYMBOLS.NIFTY]].sort((a, b) => a.t - b.t),
  SENSEX: [...hist.candles[MARKET_SYMBOLS.SENSEX]].sort((a, b) => a.t - b.t),
};

/** Close of the last 5-minute bar of `date` that had closed (and been published) by T. */
function visibleClose(index: IndexId, T: number, date: string): number | null {
  const arr = bars5[index];
  const i = lastIndexAtOrBefore(arr, T - LAG - BAR);
  if (i < 0 || istDateOf(arr[i].t) !== date) return null;
  return arr[i].c;
}

interface MovePoint {
  p: DecisionPoint;
  h: number;
  /** Log move over h, percent (index direction). */
  move: number;
  /** Implied 1-sigma move over h, percent. */
  sigma: number;
}

function moveAt(p: DecisionPoint, h: number, latestEndMin: number | null): MovePoint | null {
  const end = p.t + h * MINUTE_MS;
  if (latestEndMin !== null && istMinuteOfDay(end - LAG) > latestEndMin) return null;
  const s0 = visibleClose(p.index, p.t, p.date);
  const s1 = visibleClose(p.index, end, p.date);
  if (s0 === null || s1 === null) return null;
  return { p, h, move: 100 * Math.log(s1 / s0), sigma: sigmaPct(p.vol * 100, h, cfg) };
}

// ------------------------------------------------------------------------------------------------
// Estimators
// ------------------------------------------------------------------------------------------------

/** Through-origin OLS slope of y on x with standard errors clustered by `group` (sessions). */
function slopeThroughOrigin(rows: { x: number; y: number; group: string }[]): { beta: number; se: number; n: number; groups: number } {
  let sxx = 0;
  let sxy = 0;
  for (const r of rows) {
    sxx += r.x * r.x;
    sxy += r.x * r.y;
  }
  const beta = sxx > 0 ? sxy / sxx : NaN;
  const byGroup = new Map<string, number>();
  for (const r of rows) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + r.x * (r.y - beta * r.x));
  const g = byGroup.size;
  let meat = 0;
  for (const v of byGroup.values()) meat += v * v;
  const se = sxx > 0 && g > 1 ? Math.sqrt(((g / (g - 1)) * meat) / (sxx * sxx)) : NaN;
  return { beta, se, n: rows.length, groups: g };
}

/** OLS with intercept: y = a + b x; b's standard error clustered by group. */
function slopeWithIntercept(rows: { x: number; y: number; group: string }[]): { a: number; b: number; seB: number } {
  const mx = mean(rows.map((r) => r.x));
  const my = mean(rows.map((r) => r.y));
  let sxx = 0;
  let sxy = 0;
  for (const r of rows) {
    sxx += (r.x - mx) ** 2;
    sxy += (r.x - mx) * (r.y - my);
  }
  const b = sxx > 0 ? sxy / sxx : NaN;
  const a = my - b * mx;
  const byGroup = new Map<string, number>();
  for (const r of rows) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + (r.x - mx) * (r.y - a - b * r.x));
  const g = byGroup.size;
  let meat = 0;
  for (const v of byGroup.values()) meat += v * v;
  return { a, b, seB: sxx > 0 && g > 1 ? Math.sqrt(((g / (g - 1)) * meat) / (sxx * sxx)) : NaN };
}

/** realizedVolFactor and beta from the decision points of a window. */
function calibrate(moves: MovePoint[]) {
  const f = rms(moves.map((m) => m.move)) / rms(moves.map((m) => m.sigma));
  const scored = moves.filter((m) => m.p.score !== 0);
  const rows = scored.map((m) => ({ x: Math.abs(m.p.score), y: (Math.sign(m.p.score) * m.move) / (f * m.sigma), group: m.p.date }));
  const passRows = scored.filter((m) => m.p.passes).map((m) => ({ x: Math.abs(m.p.score), y: (Math.sign(m.p.score) * m.move) / (f * m.sigma), group: m.p.date }));
  const origin = slopeThroughOrigin(rows);
  const icpt = slopeWithIntercept(rows);
  const pass = passRows.length >= 10 ? slopeThroughOrigin(passRows) : { beta: NaN, se: NaN, n: passRows.length, groups: new Set(passRows.map((r) => r.group)).size };
  const hit = scored.length ? scored.filter((m) => Math.sign(m.p.score) * m.move > 0).length / scored.length : NaN;
  return {
    f,
    beta: origin.beta,
    betaSe: origin.se,
    nScored: origin.n,
    sessionsScored: origin.groups,
    sessions: new Set(moves.map((m) => m.p.date)).size,
    alpha: icpt.a,
    betaIcpt: icpt.b,
    betaIcptSe: icpt.seB,
    betaPass: pass.beta,
    betaPassSe: pass.se,
    nPass: pass.n,
    hit,
    nAll: moves.length,
  };
}

// ------------------------------------------------------------------------------------------------
// Hourly data (Yahoo 1h, ~3 years)
// ------------------------------------------------------------------------------------------------

function loadHourly(file: string, symbol: string): Candle[] {
  const json = JSON.parse(readFileSync(resolve(hourlyDir, file), "utf8")) as unknown;
  return parseYahooChart(json, symbol).candles;
}

const HOURLY_SLOTS = [555, 615, 675, 735, 795, 855, 915]; // 09:15 ... 15:15 bar opens (IST minutes)

/** Sessions with all seven regular hourly bars, keyed by date: bars ordered by slot. */
function hourlySessions(bars: Candle[]): Map<string, Candle[]> {
  const by = new Map<string, Map<number, Candle>>();
  for (const b of bars) {
    const m = istMinuteOfDay(b.t);
    if (!HOURLY_SLOTS.includes(m)) continue;
    const d = istDateOf(b.t);
    let s = by.get(d);
    if (!s) by.set(d, (s = new Map()));
    s.set(m, b);
  }
  const out = new Map<string, Candle[]>();
  for (const [d, s] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.size === HOURLY_SLOTS.length) out.set(d, HOURLY_SLOTS.map((m) => s.get(m)!));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const out: Record<string, unknown> = { inputs: { history: historyPath, hourly: hourlyDir, from, to }, generatedAt: new Date().toISOString() };
  console.log(`Replaying ${from}..${to} (no events, production limits) and recording decision points...`);
  const { points, trades, days } = await replay();
  const net = trades.reduce((s, x) => s + x.pnl, 0);
  console.log(`Replay: ${days.length} sessions, ${points.length} entry-window decision points, ${trades.length} trades, net ₹${net.toFixed(2)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  out.replay = { sessions: days.length, points: points.length, trades: trades.length, net: r2(net) };

  // Sanity: the decision's spot equals the visible 5-minute close used for realized moves.
  const spotMismatch = points.filter((p) => {
    const s0 = visibleClose(p.index, p.t, p.date);
    return s0 === null || Math.abs(s0 - p.spot) > 1e-6;
  }).length;
  console.log(`Spot check: ${spotMismatch} of ${points.length} points differ from the visible 5-minute close.`);

  // ---------------- WP2: realized vs implied by horizon (5-minute grid) ----------------
  const folds: Fold[] = makeFolds(from, to, 42, 14);
  const windows: { name: string; from: string; to: string }[] = [
    { name: `all ${from}..${to}`, from, to },
    ...folds.map((f, i) => ({ name: `fold ${i + 1} train ${f.trainFrom}..${f.trainTo}`, from: f.trainFrom, to: f.trainTo })),
  ];
  const HORIZONS_5M = [15, 30, 60, 90, 120, 180];
  const rvi5: (string | number)[][] = [["window", "h min", "n", "mean |move| %", "RMS move %", "mean implied σ %", "RMS ratio f_h", "mean|move| / mean σ"]];
  const rvi5Json: unknown[] = [];
  for (const w of windows) {
    for (const h of HORIZONS_5M) {
      const ms = points
        .filter((p) => p.date >= w.from && p.date <= w.to)
        .map((p) => moveAt(p, h, 15 * 60 + 15))
        .filter((m): m is MovePoint => m !== null);
      if (ms.length === 0) continue;
      const row = { window: w.name, h, n: ms.length, meanAbs: mean(ms.map((m) => Math.abs(m.move))), rmsMove: rms(ms.map((m) => m.move)), meanSigma: mean(ms.map((m) => m.sigma)), f: rms(ms.map((m) => m.move)) / rms(ms.map((m) => m.sigma)) };
      rvi5Json.push(row);
      rvi5.push([w.name, h, row.n, r2(row.meanAbs, 3), r2(row.rmsMove, 3), r2(row.meanSigma, 3), r2(row.f, 3), r2(row.meanAbs / row.meanSigma, 3)]);
    }
  }
  console.log("\n## WP2 realized vs implied by horizon (5-minute bars, decision points 09:25-14:30, both indices)\n");
  console.log(table(rvi5));
  out.realizedVsImplied5m = rvi5Json;

  // ---------------- WP2: realized vs implied by horizon (hourly, ~3 years) ----------------
  const vixH = hourlySessions(loadHourly("INDIAVIX.json", "^INDIAVIX"));
  const hourlyIdx: Record<IndexId, Map<string, Candle[]>> = {
    NIFTY: hourlySessions(loadHourly("NSEI.json", "^NSEI")),
    SENSEX: hourlySessions(loadHourly("BSESN.json", "^BSESN")),
  };
  const HORIZONS_1H = [60, 120, 180, 240, 300];
  type HourMove = { year: string; h: number; move: number; sigma: number };
  const hourMoves: HourMove[] = [];
  for (const index of INDICES) {
    for (const [d, bars] of hourlyIdx[index]) {
      const v = vixH.get(d);
      if (!v) continue;
      // Boundaries: close of the bar opening at slot k is the price at slot k + 1 (10:15 ... 15:15).
      for (let k = 0; k < 5; k++) {
        const s0 = bars[k].c;
        const vix = v[k].c;
        const vol = syntheticVol(index, vix, cfg);
        for (const h of HORIZONS_1H) {
          const j = k + h / 60;
          if (j > 5) continue; // end at the 15:15 boundary at the latest (closing-auction bar excluded)
          hourMoves.push({ year: d.slice(0, 4), h, move: 100 * Math.log(bars[j].c / s0), sigma: sigmaPct(vol * 100, h, cfg) });
        }
      }
    }
  }
  const years = [...new Set(hourMoves.map((m) => m.year))].sort();
  const rvih: (string | number)[][] = [["period", "h min", "n", "mean |move| %", "RMS move %", "mean implied σ %", "RMS ratio f_h", "mean|move| / mean σ"]];
  const rvihJson: unknown[] = [];
  for (const period of ["all", ...years]) {
    for (const h of HORIZONS_1H) {
      const ms = hourMoves.filter((m) => m.h === h && (period === "all" || m.year === period));
      if (!ms.length) continue;
      const row = { period, h, n: ms.length, meanAbs: mean(ms.map((m) => Math.abs(m.move))), rmsMove: rms(ms.map((m) => m.move)), meanSigma: mean(ms.map((m) => m.sigma)), f: rms(ms.map((m) => m.move)) / rms(ms.map((m) => m.sigma)) };
      rvihJson.push(row);
      rvih.push([period, h, row.n, r2(row.meanAbs, 3), r2(row.rmsMove, 3), r2(row.meanSigma, 3), r2(row.f, 3), r2(row.meanAbs / row.meanSigma, 3)]);
    }
  }
  console.log("\n## WP2 realized vs implied by horizon (Yahoo 1-hour bars, starts 10:15-14:15, ends <= 15:15, NIFTY+SENSEX)\n");
  console.log(table(rvih));
  out.realizedVsImpliedHourly = rvihJson;

  // ---------------- WP2: f and beta at the engine's own horizon, by walk-forward fold ----------------
  const engineMoves = points.map((p) => moveAt(p, p.horizonMin, null)).filter((m): m is MovePoint => m !== null);
  const inWindow = (a: string, b: string) => engineMoves.filter((m) => m.p.date >= a && m.p.date <= b);
  const calRows: (string | number)[][] = [
    ["window", "sessions", "points", "f", "scored pts", "scored sess.", "beta (origin)", "SE", "alpha", "beta (w/ intercept)", "SE", "beta passing only", "SE", "n passing", "dir. right"],
  ];
  const calJson: unknown[] = [];
  const addCal = (name: string, ms: MovePoint[]) => {
    const c = calibrate(ms);
    calJson.push({ window: name, ...c });
    calRows.push([name, c.sessions, c.nAll, r2(c.f, 3), c.nScored, c.sessionsScored, r2(c.beta, 3), r2(c.betaSe, 3), r2(c.alpha, 3), r2(c.betaIcpt, 3), r2(c.betaIcptSe, 3), r2(c.betaPass, 3), r2(c.betaPassSe, 3), c.nPass, r2(c.hit, 3)]);
    return c;
  };
  const full = addCal(`all ${from}..${to}`, inWindow(from, to));
  const foldParams: { fold: Fold; f: number; beta: number; betaSe: number }[] = [];
  folds.forEach((fold, i) => {
    const tr = addCal(`fold ${i + 1} train ${fold.trainFrom}..${fold.trainTo}`, inWindow(fold.trainFrom, fold.trainTo));
    addCal(`fold ${i + 1} test  ${fold.testFrom}..${fold.testTo}`, inWindow(fold.testFrom, fold.testTo));
    foldParams.push({ fold, f: tr.f, beta: tr.beta, betaSe: tr.betaSe });
  });
  // Pooled out-of-sample check of the score -> move relation: test-window points of all folds.
  const pooledTest = folds.flatMap((fold) => inWindow(fold.testFrom, fold.testTo));
  if (pooledTest.length) addCal(`pooled test windows (${folds.length} folds)`, pooledTest);
  // Sessions with no non-zero score inside the entry window (the conviction needs 0.3 of active weight).
  const scoredDates = new Set(engineMoves.filter((m) => m.p.score !== 0).map((m) => m.p.date));
  const unscored = [...new Set(engineMoves.map((m) => m.p.date))].filter((d) => !scoredDates.has(d));
  console.log(`Sessions without any non-zero score in the entry window: ${unscored.length} (${unscored.join(", ")})`);
  console.log("\n## WP2 realizedVolFactor and beta at the engine's horizon (z = signed move / (f × implied σ) on |score|; SE clustered by session)\n");
  console.log(table(calRows));
  out.calibration = calJson;
  out.foldParams = foldParams;

  // Continuity with the planning note: realized signed move at the planned horizon vs the legacy expected move, per trade.
  const tradePoints = trades.map((tr) => ({ tr, p: points.find((p) => p.index === tr.index && p.t === tr.entryMs && p.plan?.contract.tradingSymbol === tr.tradingSymbol) ?? null }));
  const unmatched = tradePoints.filter((x) => !x.p).length;
  const legacyRows = tradePoints
    .filter((x) => x.p)
    .map(({ tr, p }) => {
      const m = moveAt(p!, p!.plan!.horizonMin, null);
      const expected = Math.abs(p!.score) * cfg.gates.kEM * sigmaPct(p!.vol * 100, p!.plan!.horizonMin, cfg) * cfg.gates.intradayVolFactor;
      return { tr, p: p!, expected, realized: m ? Math.sign(p!.score) * m.move : NaN };
    })
    .filter((x) => Number.isFinite(x.realized));
  const lr = slopeWithIntercept(legacyRows.map((x) => ({ x: x.expected, y: x.realized, group: x.p.date })));
  const legacySummary = {
    trades: legacyRows.length,
    unmatched,
    meanExpected: mean(legacyRows.map((x) => x.expected)),
    meanRealized: mean(legacyRows.map((x) => x.realized)),
    slope: lr.b,
    slopeSe: lr.seB,
    right: legacyRows.filter((x) => x.realized > 0).length,
  };
  console.log(
    `\nTrades (n=${legacySummary.trades}, unmatched ${unmatched}): legacy expected move ${legacySummary.meanExpected.toFixed(3)}% vs realized signed move at the planned horizon ${legacySummary.meanRealized.toFixed(3)}%; OLS slope realized on expected ${legacySummary.slope.toFixed(2)} (SE ${legacySummary.slopeSe.toFixed(2)}); direction right ${legacySummary.right}/${legacySummary.trades}.`,
  );
  out.legacyOnTrades = legacySummary;

  // ---------------- WP2: the calibrated gate on the baseline's trades (counterfactual filter) ----------------
  /**
   * The calibrated gate at one entry decision. `ivScale` re-prices the option at a different implied
   * vol (VIX × vixMultiplier × ivScale) while keeping the same absolute realized move (f / ivScale).
   */
  const gateOn = (p: DecisionPoint, f: number, beta: number, ivScale = 1) => {
    const plan = p.plan!;
    const vix = p.vix * ivScale;
    const vol = syntheticVol(p.index, vix, cfg);
    const q = syntheticQuote(plan.contract, { t: p.t, spot: p.spot, vix }, calendar, cfg);
    const run = (b: number) => {
      const c2 = withOverrides(cfg, { gates: { expectedMoveModel: "calibrated", realizedVolFactor: f / ivScale, scoreMoveBeta: b } });
      const e = evaluateEdge({ spot: p.spot, premium: q.ask, bid: q.bid, contract: plan.contract, tYears: yearsToExpiry(p.t, plan.contract.expiry, calendar, cfg), vol, score: p.score, horizonMin: plan.horizonMin, t: p.t }, c2);
      return { e, g: edgeGates(e, c2) };
    };
    const { e, g } = run(beta);
    // The calibrated edge is linear in beta: the beta at which each calibrated check would pass.
    const e0 = run(0).e.calibrated!.edgeRatio;
    const slope = run(1).e.calibrated!.edgeRatio - e0;
    const betaForEdge = slope > 0 ? (cfg.gates.minEdgeRatio - e0) / slope : Infinity;
    const betaForMove = cfg.gates.minExpectedVsImplied / Math.abs(p.score);
    return {
      askMatches: Math.abs(q.ask - plan.refPremium) < 1e-9,
      legacyPass: g.slice(0, 2).every((x) => x.passed !== false),
      kept: g.every((x) => x.passed !== false),
      cal: e.calibrated!,
      betaNeeded: Math.max(betaForEdge, betaForMove),
      betaForEdge,
    };
  };
  const tradeRows: (string | number)[][] = [["#", "entry (IST)", "index", "side", "score", "h", "net ₹", "fold", "f", "beta", "cal. edge %", "beta needed", "OOS verdict", "in-sample verdict"]];
  interface TradeVerdict {
    entryMs: number;
    index: IndexId;
    side: string;
    score: number;
    horizonMin: number;
    pnl: number;
    fold: number | null;
    legacyPass: boolean;
    oosKept: boolean | null;
    inSampleKept: boolean;
    upperCiKept: boolean;
    oosEdgeRatio: number | null;
    inSampleEdgeRatio: number;
    betaNeeded: number;
  }
  const tradeJson: TradeVerdict[] = [];
  let askMismatch = 0;
  const betaHi = full.beta + 1.96 * full.betaSe;
  tradePoints.forEach(({ tr, p }, i) => {
    if (!p) return;
    const fp = foldParams.find((x) => p.date >= x.fold.testFrom && p.date <= x.fold.testTo) ?? null;
    const ins = gateOn(p, full.f, full.beta);
    const oos = fp ? gateOn(p, fp.f, fp.beta) : null;
    const hi = gateOn(p, full.f, betaHi);
    if (!ins.askMatches) askMismatch++;
    tradeJson.push({
      entryMs: tr.entryMs,
      index: tr.index,
      side: tr.side,
      score: p.score,
      horizonMin: p.plan!.horizonMin,
      pnl: tr.pnl,
      fold: fp ? folds.indexOf(fp.fold) + 1 : null,
      legacyPass: ins.legacyPass,
      oosKept: oos?.kept ?? null,
      inSampleKept: ins.kept,
      upperCiKept: hi.kept,
      oosEdgeRatio: oos?.cal.edgeRatio ?? null,
      inSampleEdgeRatio: ins.cal.edgeRatio,
      betaNeeded: ins.betaNeeded,
    });
    tradeRows.push([
      i + 1,
      new Date(tr.entryMs + 5.5 * 3600_000).toISOString().slice(5, 16).replace("T", " "),
      tr.index,
      tr.side,
      r2(p.score, 2),
      p.plan!.horizonMin,
      r2(tr.pnl, 0),
      fp ? folds.indexOf(fp.fold) + 1 : "-",
      fp ? r2(fp.f, 3) : r2(full.f, 3),
      fp ? r2(fp.beta, 3) : r2(full.beta, 3),
      oos ? r2(oos.cal.edgeRatio * 100, 1) : r2(ins.cal.edgeRatio * 100, 1),
      r2(ins.betaNeeded, 2),
      oos ? (oos.kept ? "kept" : "blocked") : "no OOS fit",
      ins.kept ? "kept" : "blocked",
    ]);
  });
  console.log(`\n## WP2 calibrated gate on the baseline's ${trades.length} trades (counterfactual; ask re-priced exactly: ${trades.length - unmatched - askMismatch}/${trades.length - unmatched})`);
  console.log("(f, beta: the fold's training estimates for trades in a test window, else the full-sample estimates; 'beta needed' = smallest beta at which both calibrated checks pass, full-sample f)\n");
  console.log(table(tradeRows));
  const summarizeVerdict = (name: string, rows: TradeVerdict[], kept: (r: TradeVerdict) => boolean) => {
    const k = rows.filter(kept);
    const b = rows.filter((r) => !kept(r));
    return { name, trades: rows.length, kept: k.length, blocked: b.length, keptNet: k.reduce((s, r) => s + r.pnl, 0), blockedNet: b.reduce((s, r) => s + r.pnl, 0) };
  };
  const inTest = tradeJson.filter((r) => r.fold !== null);
  const verdicts = [
    summarizeVerdict(`out of sample: fold parameters, trades in the ${folds.length} test windows`, inTest, (r) => r.oosKept === true),
    summarizeVerdict(`in sample: full-sample f ${full.f.toFixed(3)}, beta ${full.beta.toFixed(3)}, all trades`, tradeJson, (r) => r.inSampleKept),
    summarizeVerdict(`sensitivity: beta at the upper 95% bound ${betaHi.toFixed(3)}, all trades`, tradeJson, (r) => r.upperCiKept),
  ];
  console.log("");
  console.log(table([["evaluation", "trades", "kept", "blocked", "kept net ₹", "blocked net ₹"], ...verdicts.map((v) => [v.name, v.trades, v.kept, v.blocked, r2(v.keptNet, 2), r2(v.blockedNet, 2)])]));
  const needed = sorted(tradeJson.map((r) => r.betaNeeded), (x) => x);
  console.log(`Beta needed to keep a trade: min ${needed[0].toFixed(2)}, median ${needed[Math.floor(needed.length / 2)].toFixed(2)}, max ${needed[needed.length - 1].toFixed(2)} (measured: ${full.beta.toFixed(2)} ± ${full.betaSe.toFixed(2)}).`);
  out.calibratedGateOnTrades = { perTrade: tradeJson, verdicts, betaUpper95: betaHi, betaNeeded: { min: needed[0], median: needed[Math.floor(needed.length / 2)], max: needed[needed.length - 1] } };

  // Sensitivity: options priced at the implied vol measured on exchange prices (WP6 research note,
  // NSE/BSE weekly options 2024-2026: NIFTY 0.88-0.91 × India VIX, SENSEX 0.92-0.93 ×), instead of
  // the engine's VIX × vixMultiplier (NIFTY 1.00, SENSEX 1.05). Same absolute realized move.
  const realIv: Record<IndexId, [number, number]> = { NIFTY: [0.88, 0.91], SENSEX: [0.92, 0.93] };
  const ivRows: (string | number)[][] = [["IV vs VIX (NIFTY / SENSEX)", "kept at beta -0.10", "kept at upper bound", "beta needed: min", "median", "max"]];
  const ivJson: unknown[] = [];
  for (const end of [0, 1] as const) {
    const res = tradePoints
      .filter((x) => x.p)
      .map(({ p }) => {
        const scale = realIv[p!.index][end] / cfg.pricing.vixMultiplier[p!.index];
        return { atBeta: gateOn(p!, full.f, full.beta, scale), atHi: gateOn(p!, full.f, betaHi, scale) };
      });
    const need = sorted(res.map((r) => r.atBeta.betaNeeded), (x) => x);
    const row = { niftyIv: realIv.NIFTY[end], sensexIv: realIv.SENSEX[end], keptAtBeta: res.filter((r) => r.atBeta.kept).length, keptAtUpper: res.filter((r) => r.atHi.kept).length, betaNeeded: { min: need[0], median: need[Math.floor(need.length / 2)], max: need[need.length - 1] } };
    ivJson.push(row);
    ivRows.push([`${row.niftyIv} / ${row.sensexIv}`, row.keptAtBeta, row.keptAtUpper, r2(need[0], 2), r2(row.betaNeeded.median, 2), r2(need[need.length - 1], 2)]);
  }
  console.log(`\nSensitivity: the ${tradePoints.length} trades re-priced at the measured real implied vol (realized move unchanged)\n`);
  console.log(table(ivRows));
  out.calibratedGateRealIv = ivJson;

  // ---------------- WP5: realized-variance measures and HAR fits ----------------
  const series: { name: string; index: IndexId; rv: SessionVariance[]; minObs: number }[] = [];
  for (const index of INDICES) {
    series.push({ name: "5-min RV 09:15-15:15 (snapshot)", index, rv: intradaySeries(bars5[index], null, { minBars: 60 }), minObs: 20 });
    const hs = [...hourlyIdx[index].entries()].map(([date, b]) => ({ date, rv: intradaySeries(b, null, { minBars: 6 })[0]?.rv ?? NaN })).filter((x) => Number.isFinite(x.rv));
    const pk = parkinsonSeries(hist.daily[MARKET_SYMBOLS[index]] ?? []);
    series.push({ name: "hourly RV 09:15-15:15 (1h, 3y)", index, rv: hs, minObs: HAR_MIN_OBS });
    // Same span as the daily bars (drops Nov 2023-Oct 2024, including 4 Jun 2024, election results).
    series.push({ name: "hourly RV, daily-bar span (2y)", index, rv: hs.filter((x) => x.date >= pk[0].date), minObs: HAR_MIN_OBS });
    series.push({ name: "daily Parkinson (daily bars, 2y)", index, rv: pk, minObs: HAR_MIN_OBS });
  }
  const harRows: (string | number)[][] = [["index", "measure", "sessions", "first", "last", "mean RV %²", "b0", "bd", "bw", "bm", "R² in-sample", "OOS n", "OOS from", "R²oos vs mean", "R²oos vs RW"]];
  const harJson: unknown[] = [];
  for (const s of series) {
    const rv = s.rv.map((x) => x.rv);
    const fit: HarFit | null = fitHar(rv, s.minObs);
    const oos = harOutOfSample(rv, s.minObs);
    const row = { index: s.index, measure: s.name, sessions: rv.length, first: s.rv[0]?.date, last: s.rv.at(-1)?.date, meanRv: mean(rv), fit, oosN: oos.length, oosFrom: oos.length ? s.rv[oos[0].t].date : null, r2Mean: oosR2(oos, "mean"), r2Rw: oosR2(oos, "last"), minObs: s.minObs };
    harJson.push(row);
    harRows.push([s.index, s.name, rv.length, row.first ?? "", row.last ?? "", r2(row.meanRv, 3), r2(fit?.b0 ?? NaN, 3), r2(fit?.bd ?? NaN, 3), r2(fit?.bw ?? NaN, 3), r2(fit?.bm ?? NaN, 3), r2(fit?.r2 ?? NaN, 3), oos.length, row.oosFrom ?? "-", r2(row.r2Mean, 3), r2(row.r2Rw, 3)]);
  }
  console.log("\n## WP5 HAR-RV fits (OLS on variance levels) and expanding-window out-of-sample R²\n");
  console.log(table(harRows));
  out.har = harJson;

  // ---------------- WP5: gate pass rate over two years (the engine's own forecast) ----------------
  const KS = [0.8, 1.0, 1.2];
  const passRows: (string | number)[][] = [["index", "measure", "k", "sessions from..to", "sessions", "decision hours", "pass (hours)", "pass rate", "sessions with a pass", "mean forecast / implied"]];
  const passJson: unknown[] = [];
  const dailyByIndex: Record<IndexId, Candle[]> = { NIFTY: hist.daily[MARKET_SYMBOLS.NIFTY] ?? [], SENSEX: hist.daily[MARKET_SYMBOLS.SENSEX] ?? [] };
  // Forecasts per index and date (engine function: daily Parkinson, expanding fit on earlier sessions only).
  const engineForecast: Record<IndexId, Map<string, number>> = { NIFTY: new Map(), SENSEX: new Map() };
  for (const index of INDICES) {
    for (const s of parkinsonSeries(dailyByIndex[index])) {
      const fc = forecastFromDaily(index, dailyByIndex[index], s.date);
      if (fc) engineForecast[index].set(s.date, fc.forecastPct2);
    }
  }
  // Same rule on hourly RV (expanding fit over the 3-year file), as a robustness check on the measure;
  // evaluated on the same sessions as the engine's forecast.
  const hourlyForecast: Record<IndexId, Map<string, number>> = { NIFTY: new Map(), SENSEX: new Map() };
  for (const index of INDICES) {
    const s = series.find((x) => x.index === index && x.name.startsWith("hourly RV 09:15"))!;
    for (const p of harOutOfSample(s.rv.map((x) => x.rv), HAR_MIN_OBS)) hourlyForecast[index].set(s.rv[p.t].date, p.forecast);
  }
  const variants = [
    ["daily Parkinson (engine)", engineForecast, true],
    ["hourly RV (3y fit)", hourlyForecast, true],
    ["hourly RV (3y fit), all its sessions", hourlyForecast, false],
  ] as const;
  for (const [measure, fcs, sameSessions] of variants) {
    for (const index of INDICES) {
      for (const k of KS) {
        let hours = 0;
        let pass = 0;
        let ratioSum = 0;
        const daysWithPass = new Set<string>();
        let sessions = 0;
        let first = "";
        let last = "";
        for (const [date, fc] of fcs[index]) {
          const v = vixH.get(date);
          if (!v || (sameSessions && !engineForecast[index].has(date))) continue;
          if (!first || date < first) first = date;
          if (date > last) last = date;
          sessions++;
          // Decision hours: VIX at the close of the 09:15 ... 13:15 hourly bars (10:15 ... 14:15).
          for (let s = 0; s < 5; s++) {
            const implied = impliedSessionVariancePct2(syntheticVol(index, v[s].c, cfg), cfg.pricing.tradingDaysPerYear);
            if (!(implied > 0)) continue;
            hours++;
            ratioSum += fc / implied;
            if (fc >= k * implied) {
              pass++;
              daysWithPass.add(date);
            }
          }
        }
        const row = { index, measure, k, first, last, sessions, hours, pass, rate: hours ? pass / hours : NaN, sessionsWithPass: daysWithPass.size, meanRatio: hours ? ratioSum / hours : NaN };
        passJson.push(row);
        passRows.push([index, measure, k, `${first}..${last}`, sessions, hours, pass, r2(row.rate, 4), daysWithPass.size, r2(row.meanRatio, 3)]);
      }
    }
  }
  console.log("\n## WP5 gate pass rate (forecast >= k × implied session variance; implied from hourly VIX at 10:15-14:15)\n");
  console.log(table(passRows));
  out.gatePassRate = passJson;
  // Which sessions pass at all (engine forecast, any decision hour), for k = 0.8.
  const passDates: Record<string, string[]> = {};
  for (const index of INDICES) {
    passDates[index] = [...engineForecast[index].entries()]
      .filter(([date, fc]) => (vixH.get(date) ?? []).slice(0, 5).some((b) => fc >= 0.8 * impliedSessionVariancePct2(syntheticVol(index, b.c, cfg), cfg.pricing.tradingDaysPerYear)))
      .map(([date]) => date);
    console.log(`${index} sessions passing at k = 0.8 (engine forecast): ${passDates[index].join(", ") || "none"}`);
  }
  out.passDatesK08 = passDates;

  // Sensitivity: implied session variance from the real option IV (realIv × VIX) instead of the
  // engine's VIX × vixMultiplier; frozen k = 1. Ex post: realized Parkinson / that implied variance.
  const pkByIndex: Record<IndexId, Map<string, number>> = {
    NIFTY: new Map(parkinsonSeries(dailyByIndex.NIFTY).map((x) => [x.date, x.rv])),
    SENSEX: new Map(parkinsonSeries(dailyByIndex.SENSEX).map((x) => [x.date, x.rv])),
  };
  const realRows: (string | number)[][] = [["index", "IV / VIX", "sessions", "pass rate (hours)", "sessions with a pass", "mean forecast / implied", "realized / implied: pass days", "n", "other days", "n"]];
  const realJson: unknown[] = [];
  for (const index of INDICES) {
    for (const r of realIv[index]) {
      let hours = 0;
      let pass = 0;
      let ratioSum = 0;
      const passDays = new Set<string>();
      const expost: Record<"pass" | "fail", number[]> = { pass: [], fail: [] };
      let sessions = 0;
      for (const [date, fc] of engineForecast[index]) {
        const v = vixH.get(date);
        if (!v) continue;
        sessions++;
        for (let s = 0; s < 5; s++) {
          const implied = impliedSessionVariancePct2((v[s].c * r) / 100, cfg.pricing.tradingDaysPerYear);
          if (!(implied > 0)) continue;
          hours++;
          ratioSum += fc / implied;
          if (fc >= implied) {
            pass++;
            passDays.add(date);
          }
        }
        const realized = pkByIndex[index].get(date);
        const implied1015 = impliedSessionVariancePct2((v[0].c * r) / 100, cfg.pricing.tradingDaysPerYear);
        if (realized !== undefined && implied1015 > 0) expost[passDays.has(date) ? "pass" : "fail"].push(realized / implied1015);
      }
      const row = { index, ivOverVix: r, sessions, hours, pass, rate: hours ? pass / hours : NaN, sessionsWithPass: passDays.size, passDays: [...passDays], meanRatio: ratioSum / hours, expostPass: mean(expost.pass), nPass: expost.pass.length, expostFail: mean(expost.fail), nFail: expost.fail.length };
      realJson.push(row);
      realRows.push([index, r, row.sessions, r2(row.rate, 4), row.sessionsWithPass, r2(row.meanRatio, 3), r2(row.expostPass, 3), row.nPass, r2(row.expostFail, 3), row.nFail]);
    }
  }
  console.log("\n## WP5 sensitivity: implied variance from the real option IV measured on exchange prices (k = 1)\n");
  console.log(table(realRows));
  out.gateRealIv = realJson;

  // Realized intraday variance relative to implied, and with the overnight gap added (definition check).
  const ratioRows: (string | number)[][] = [["index", "sessions", "first", "last", "mean Parkinson / implied", "median", "mean (overnight² + Parkinson) / implied", "share of sessions with Parkinson >= implied"]];
  const ratioJson: unknown[] = [];
  const vixDaily = new Map((hist.daily[MARKET_SYMBOLS.INDIAVIX] ?? []).map((c) => [istDateOf(c.t), c.c]));
  for (const index of INDICES) {
    const d = sorted(dailyByIndex[index], (c) => c.t);
    const ratios: number[] = [];
    const withGap: number[] = [];
    let first = "";
    let last = "";
    for (let i = 1; i < d.length; i++) {
      const date = istDateOf(d[i].t);
      const prevVix = vixDaily.get(istDateOf(d[i - 1].t));
      const pk = parkinsonSeries([d[i]])[0]?.rv;
      if (!prevVix || pk === undefined) continue;
      const implied = impliedSessionVariancePct2(syntheticVol(index, prevVix, cfg), cfg.pricing.tradingDaysPerYear);
      const gap = 100 * Math.log(d[i].o / d[i - 1].c);
      ratios.push(pk / implied);
      withGap.push((pk + gap * gap) / implied);
      if (!first) first = date;
      last = date;
    }
    const s = sorted(ratios, (x) => x);
    const row = { index, n: ratios.length, first, last, meanRatio: mean(ratios), medianRatio: s[Math.floor(s.length / 2)], meanWithGap: mean(withGap), shareAbove: ratios.filter((x) => x >= 1).length / ratios.length };
    ratioJson.push(row);
    ratioRows.push([index, row.n, first, last, r2(row.meanRatio, 3), r2(row.medianRatio, 3), r2(row.meanWithGap, 3), r2(row.shareAbove, 3)]);
  }
  console.log("\n## WP5 realized session variance vs the implied session variance (VIX × vixMultiplier at the previous close)\n");
  console.log(table(ratioRows));
  out.realizedOverImplied = ratioJson;

  // Ex post: do the sessions the gate would pass (k = 0.8, to have some) realize more variance than implied?
  const expostRows: (string | number)[][] = [["index", "k", "group", "sessions", "mean realized / implied (Parkinson)"]];
  const expostJson: unknown[] = [];
  for (const index of INDICES) {
    const pkByDate = new Map(parkinsonSeries(dailyByIndex[index]).map((x) => [x.date, x.rv]));
    for (const k of KS) {
      const groups: Record<string, number[]> = { pass: [], fail: [] };
      for (const [date, fc] of engineForecast[index]) {
        const v = vixH.get(date);
        const realized = pkByDate.get(date);
        if (!v || realized === undefined) continue;
        const implied = impliedSessionVariancePct2(syntheticVol(index, v[0].c, cfg), cfg.pricing.tradingDaysPerYear);
        if (!(implied > 0)) continue;
        groups[fc >= k * implied ? "pass" : "fail"].push(realized / implied);
      }
      for (const [g, xs] of Object.entries(groups)) {
        expostJson.push({ index, k, group: g, n: xs.length, meanRatio: mean(xs) });
        expostRows.push([index, k, g, xs.length, r2(mean(xs), 3)]);
      }
    }
  }
  console.log("\n## WP5 ex post: realized / implied on sessions the gate passes vs blocks (VIX at 10:15)\n");
  console.log(table(expostRows));
  out.expost = expostJson;

  // The gate on the baseline's trades (counterfactual), at k = 0.8, 1.0, 1.2.
  const volRows: (string | number)[][] = [["k", "kept", "blocked", "kept net ₹", "blocked net ₹"]];
  const volJson: unknown[] = [];
  const perTrade: unknown[] = [];
  for (const k of KS) {
    const c2 = withOverrides(cfg, { gates: { volCheapness: { enabled: true, k } } });
    let kept = 0;
    let blocked = 0;
    let keptNet = 0;
    let blockedNet = 0;
    for (const { tr, p } of tradePoints) {
      if (!p) continue;
      const fc = forecastFromDaily(p.index, dailyByIndex[p.index], p.date);
      const g = volCheapnessGate(fc, p.vol, c2);
      if (g.passed) {
        kept++;
        keptNet += tr.pnl;
      } else {
        blocked++;
        blockedNet += tr.pnl;
      }
      if (k === 1) perTrade.push({ entryMs: tr.entryMs, index: tr.index, pnl: tr.pnl, forecast: fc?.forecastPct2 ?? null, implied: impliedSessionVariancePct2(p.vol, cfg.pricing.tradingDaysPerYear), passed: g.passed, detail: g.detail });
    }
    volJson.push({ k, kept, blocked, keptNet, blockedNet });
    volRows.push([k, kept, blocked, r2(keptNet, 2), r2(blockedNet, 2)]);
  }
  console.log(`\n## WP5 vol-cheapness gate on the baseline's ${trades.length} trades (counterfactual)\n`);
  console.log(table(volRows));
  const ratiosAtTrades = (perTrade as { forecast: number | null; implied: number }[]).filter((x) => x.forecast !== null).map((x) => x.forecast! / x.implied);
  console.log(`Forecast / implied at the trades' entries: min ${Math.min(...ratiosAtTrades).toFixed(3)}, mean ${mean(ratiosAtTrades).toFixed(3)}, max ${Math.max(...ratiosAtTrades).toFixed(3)}.`);
  out.volGateOnTrades = { summary: volJson, perTrade };

  const path = writeJson(outPath, out);
  console.log(`\nSaved ${path} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
