/**
 * Overnight-gap betas (config.features.gapBetas): out-of-sample check and refit.
 *
 *   npx tsx scripts/research/fit-gap-betas.ts --history <snapshot.json> [--fit-to 2026-07-22]
 *        [--holdout-from 2026-07-23] [--min-train 120] [--bootstrap 1000] [--seed 1]
 *        [--daily-only | --hourly <dir>] [--betas <sets.json>] [--show 2026-08-05] [--json <out.json>]
 *        [--rows <rows.csv>]
 *
 * Inputs (read only, nothing is fetched): a history snapshot as written by `npm run backtest --
 * --save-history` or `npm run fetch-history -- --save` (5-minute bars, about 2 years of daily bars);
 * with --hourly, a directory of Yahoo chart v8 responses with 1-hour bars named <symbol>.json (e.g.
 * ES=F.json, ^TNX.json; interval=1h, range=730d) for the nine keys.
 *
 * Observations come from the engine's own overnightObservations(): for NIFTY and SENSEX, each
 * session's opening gap (first 5-minute open, else the daily open, against the previous session's
 * close) and the global moves from the previous session's 15:30 IST close to the 09:15 IST open, taken
 * from intraday bars when the snapshot has them and from final daily closes otherwise
 * (crossAsset.globalMoves, the same code the engine trades on). Each row is tagged by where its moves
 * came from: "intraday" when every key has intraday bars from before the window (as in live trading),
 * "daily" when none has intraday bars in it, else "mixed". Window variants:
 * - default: the snapshot's own bars (the cross assets' 5-minute bars where they exist);
 * - --daily-only: cross-asset intraday bars dropped, so every window uses daily closes (what the
 *   reference backtest sees on most sessions);
 * - --hourly: the cross assets' intraday bars are the 1-hour bars instead, each re-stamped 55 minutes
 *   later so the engine's rule "a bar is usable 5 minutes after its timestamp" means "once its hour has
 *   closed". At 09:15 IST the window then ends with the last hour closed (08:30 for futures, FX and
 *   Tokyo, 09:00 for Hong Kong and Shanghai), about as live trading sees it.
 *
 * Compared on the same rows: the hand-set betas this script was written to check, the configured
 * defaults (DEFAULT_CONFIG.features.gapBetas), fitGapBetas walk-forward (expanding window; for each
 * session the ridge penalty is chosen and the betas fitted on earlier sessions only, see
 * src/engine/market/gapFit.ts), the betas fitted once on the sessions before --holdout-from (scored on
 * the sessions from it), any fixed sets in --betas ({"name": {"ES": 0.3, ...}}), and a zero forecast.
 * Metrics: MAE, RMSE, directional hit rate [90% Wilson] and the calibration slope of the actual gap on
 * the forecast [90% session bootstrap].
 *
 * Calendar: the bundled holiday list starts in 2026, so weekdays with no NIFTY bar in the snapshot
 * count as closed and weekend days with one (1 Feb 2025, budget day) as open. Muhurat sessions
 * (one-hour special sessions) and the sessions after them are left out.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TradingCalendar, type CalendarOverride } from "../../src/engine/calendar/calendar";
import { addDays, DAY_MS, istIso, MINUTE_MS, weekdayOf } from "../../src/engine/clock";
import { DEFAULT_CONFIG } from "../../src/engine/config";
import { istDateOf } from "../../src/engine/market/candles";
import {
  dailyFinalAfterMs,
  expectedGapPct,
  fitGapBetas,
  GLOBAL_SYMBOL,
  overnightObservations,
  pricePointAtOrBefore,
  type GapObservation,
} from "../../src/engine/market/crossAsset";
import {
  chooseGapLambda,
  gapForecastMetrics,
  GAP_LAMBDA_GRID,
  isCompleteObservation,
  sessionBootstrap,
  walkForwardGapForecasts,
  type GapForecastMetrics,
} from "../../src/engine/market/gapFit";
import { parseYahooChart } from "../../src/engine/market/yahooClient";
import { quantile } from "../../src/engine/util/math";
import { MARKET_SYMBOLS, type Candle, type GlobalKey, type IndexId, type MarketSnapshot } from "../../src/engine/types";
import { fail, num, parseArgs, readJson, str, table, writeJson } from "../lib/node";

/** The hand-set betas in config.ts before this check (never fitted). */
const HAND_SET_BETAS: Record<string, number> = { ES: 0.45, NQ: 0.1, CL: -0.08, DXY: -0.15, USDINR: -1.5, US10Y: -0.01, N225: 0.1, HSI: 0.1, SSE: 0.05 };
/** Keys fitted: the ones the engine has always used for the gap model. */
const KEYS = Object.keys(HAND_SET_BETAS) as GlobalKey[];
/** NSE/BSE Muhurat trading sessions in the snapshot's span (one-hour evening/afternoon sessions). */
const MUHURAT_SESSIONS = new Set(["2024-11-01", "2025-10-21"]);
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];

interface History {
  source?: string;
  savedAt?: string;
  candles: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
}

type WindowSource = "intraday" | "daily" | "mixed";

interface Row extends GapObservation {
  index: IndexId;
  prior: string;
  source: WindowSource;
}

const args = parseArgs();
const historyPath = str(args, "history") ?? fail("--history <snapshot.json> is required (npm run backtest -- --save-history, or the fetch-history archive).");
const holdoutFrom = str(args, "holdout-from", "2026-07-23")!;
const minTrain = num(args, "min-train", 120);
const draws = num(args, "bootstrap", 1000);
const seed = num(args, "seed", 1);
const dailyOnly = args["daily-only"] === true;
const hourlyDir = str(args, "hourly", undefined);
if (dailyOnly && hourlyDir) fail("--daily-only and --hourly are alternatives.");
const history = readJson<History>(historyPath) ?? fail(`No history snapshot at ${historyPath}.`);

const CROSS_SYMBOLS = new Set<string>(Object.values(GLOBAL_SYMBOL));
const candles: Record<string, Candle[]> = {};
for (const [sym, arr] of Object.entries(history.candles ?? {})) if (!((dailyOnly || hourlyDir) && CROSS_SYMBOLS.has(sym))) candles[sym] = arr;
const daily = history.daily ?? {};

/** Width of a 1-hour bar beyond the engine's 5-minute bar: the re-stamp that makes "closed" mean "hour closed". */
const HOUR_RESTAMP_MS = 55 * MINUTE_MS;
const windowBars = dailyOnly ? "daily closes only" : hourlyDir ? "1-hour bars" : "the snapshot's 5-minute bars";
if (hourlyDir) {
  for (const key of Object.keys(HAND_SET_BETAS) as GlobalKey[]) {
    const sym = GLOBAL_SYMBOL[key];
    const chart = parseYahooChart(JSON.parse(readFileSync(join(hourlyDir, `${sym}.json`), "utf8")), sym);
    // The newest bar may still have been forming when the file was fetched: leave it out. Bars start on
    // each market's own grid (^TNX at :20 UTC); a bar that really closed early (lunch, an early close) is
    // used no sooner than an hour after its start.
    candles[sym] = chart.candles.slice(0, -1).map((c) => ({ ...c, t: c.t + HOUR_RESTAMP_MS }));
  }
}

/** Extra fixed beta sets to score: {"name": {"ES": 0.3, ...}}. */
const extraBetas: Record<string, Record<string, number>> = (() => {
  const path = str(args, "betas", undefined);
  if (!path) return {};
  const sets = readJson<Record<string, Record<string, number>>>(path) ?? fail(`No beta sets at ${path}.`);
  for (const [name, b] of Object.entries(sets)) {
    for (const [k, v] of Object.entries(b)) if (!(k in GLOBAL_SYMBOL) || !Number.isFinite(v)) fail(`--betas ${name}: ${k} = ${v} is not a known key with a finite beta.`);
  }
  return sets;
})();

/** Weekdays without a NIFTY bar are closed; weekend days with one are special sessions. */
function dataCalendar(): TradingCalendar {
  const have = new Set<string>();
  for (const c of daily[MARKET_SYMBOLS.NIFTY] ?? []) have.add(istDateOf(c.t));
  for (const c of candles[MARKET_SYMBOLS.NIFTY] ?? []) have.add(istDateOf(c.t));
  const dates = [...have].sort();
  if (dates.length === 0) fail("The snapshot has no NIFTY bars.");
  const overrides: CalendarOverride[] = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) {
    const weekend = weekdayOf(d) >= 6;
    if (!weekend && !have.has(d)) overrides.push({ date: d, open: false, note: "no NIFTY bar in the snapshot" });
    if (weekend && have.has(d)) overrides.push({ date: d, open: true, note: "special session in the snapshot" });
  }
  return new TradingCalendar().withOverrides(overrides);
}

const calendar = dataCalendar();
let lastMs = 0;
for (const group of [candles, daily]) for (const arr of Object.values(group)) if (arr.length) lastMs = Math.max(lastMs, arr[arr.length - 1].t);
const snap: MarketSnapshot = { t: lastMs + DAY_MS, candles, daily, ltp: {}, dataAgeSec: 0 };

/** Where a window's moves come from: intraday bars for every key from before the window, none, or a mix. */
function windowSource(fromMs: number, toMs: number): WindowSource {
  let intraday = 0;
  let none = 0;
  for (const key of KEYS) {
    const bars = candles[GLOBAL_SYMBOL[key]] ?? [];
    const first = bars.length ? bars[0].t : Infinity;
    if (first + 5 * MINUTE_MS <= fromMs) intraday++;
    else if (first + 5 * MINUTE_MS > toMs) none++;
  }
  return intraday === KEYS.length ? "intraday" : none === KEYS.length ? "daily" : "mixed";
}

const rows: Row[] = [];
let muhurat = 0;
for (const index of INDICES) {
  for (const o of overnightObservations(snap, index, calendar, 1_000_000)) {
    const prior = calendar.prevTradingDay(o.date);
    if (MUHURAT_SESSIONS.has(o.date) || MUHURAT_SESSIONS.has(prior)) {
      muhurat++;
      continue;
    }
    rows.push({ ...o, index, prior, source: windowSource(calendar.closeMs(prior), calendar.openMs(o.date)) });
  }
}
const complete = rows.filter((r) => isCompleteObservation(r, KEYS));
const dates = [...new Set(complete.map((r) => r.date))].sort();
if (dates.length <= minTrain) fail(`Only ${dates.length} complete sessions; --min-train is ${minTrain}.`);
const fitTo = str(args, "fit-to", dates[dates.length - 1])!;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");

/** Wilson score interval for a proportion (z = 1.645 for 90%). */
function wilson(p: number, n: number, z = 1.645): [number, number] {
  if (!(n > 0)) return [NaN, NaN];
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

interface Scored {
  date: string;
  actual: number;
  pred: number;
}

interface MetricsRow extends GapForecastMetrics {
  model: string;
  sessions: number;
  slopeLo: number;
  slopeHi: number;
  hitLo: number;
  hitHi: number;
}

function scoreModel(model: string, points: Scored[]): MetricsRow {
  const m = gapForecastMetrics(points);
  const slopes = sessionBootstrap(points, (s) => gapForecastMetrics(s).slope, draws, seed).filter(Number.isFinite);
  const [hitLo, hitHi] = wilson(m.hitRate, m.hitN);
  return { model, ...m, sessions: new Set(points.map((p) => p.date)).size, slopeLo: quantile(slopes, 0.05), slopeHi: quantile(slopes, 0.95), hitLo, hitHi };
}

function metricsTable(title: string, list: MetricsRow[]): void {
  console.log(`\n${title}`);
  console.log(
    table([
      ["model", "rows", "sessions", "MAE %", "RMSE %", "hit [90%]", "slope [90%]", "R² vs 0"],
      ...list.map((m) => [
        m.model,
        m.n,
        m.sessions,
        f3(m.mae),
        f3(m.rmse),
        `${pct(m.hitRate)} [${pct(m.hitLo)}–${pct(m.hitHi)}] (${m.hitN})`,
        `${f2(m.slope)} [${f2(m.slopeLo)}, ${f2(m.slopeHi)}]`,
        f3(m.r2VsZero),
      ]),
    ]),
  );
}

function betasLine(b: Record<string, number>): string {
  return KEYS.map((k) => `${k} ${f3(b[k] ?? 0)}`).join(", ");
}

// ---------------------------------------------------------------------------
// Data summary
// ---------------------------------------------------------------------------

console.log(`History ${historyPath} (${history.source ?? "?"}, saved ${history.savedAt ?? "?"}); cross-asset windows from ${windowBars}${hourlyDir ? ` in ${hourlyDir}` : ""}.`);
const bySource = (list: Row[]) => (["intraday", "mixed", "daily"] as const).map((s) => `${s} ${new Set(list.filter((r) => r.source === s).map((r) => r.date)).size}`).join(", ");
console.log(
  `Observations: ${rows.length} rows (${new Set(rows.map((r) => r.date)).size} sessions, ${rows[0]?.date ?? "?"} .. ${rows.at(-1)?.date ?? "?"}; ${muhurat} Muhurat-affected rows left out); ` +
    `${complete.length} complete rows over ${dates.length} sessions (${dates[0]} .. ${dates.at(-1)}). Sessions by window source: ${bySource(complete)}.`,
);

const show = str(args, "show", undefined);
if (show) {
  const prior = calendar.prevTradingDay(show);
  const fromMs = calendar.closeMs(prior);
  const toMs = calendar.openMs(show);
  console.log(`\nWindow for ${show}: ${istIso(fromMs)} -> ${istIso(toMs)} (previous session ${prior})`);
  for (const key of KEYS) {
    const sym = GLOBAL_SYMBOL[key];
    const fin = dailyFinalAfterMs(sym);
    const a = pricePointAtOrBefore(candles[sym], daily[sym], fromMs, fin);
    const b = pricePointAtOrBefore(candles[sym], daily[sym], toMs, fin);
    const at = (p: typeof a) => (p ? `${p.price} (${p.source}, observable ${istIso(p.obsMs)})` : "none");
    console.log(`  ${key.padEnd(6)} ${sym.padEnd(10)} from ${at(a)}  to ${at(b)}`);
  }
  for (const r of rows.filter((x) => x.date === show)) console.log(`  ${r.index} gap ${f3(r.gapPct)}%, moves ${KEYS.map((k) => `${k} ${f3(r.moves[k] ?? NaN)}`).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Walk-forward out of sample
// ---------------------------------------------------------------------------

const t0 = Date.now();
const wf = walkForwardGapForecasts(complete, KEYS, { minTrainSessions: minTrain });
const oosDates = [...new Set(wf.map((f) => f.obs.date))];
console.log(
  `\nWalk-forward: ${wf.length} forecasts over ${oosDates.length} sessions (${oosDates[0]} .. ${oosDates.at(-1)}), each fitted on every earlier session ` +
    `(at least ${minTrain}); penalty chosen on those sessions from {${GAP_LAMBDA_GRID.join(", ")}} (${((Date.now() - t0) / 1000).toFixed(1)} s).`,
);
const lambdas = new Map<number, number>();
for (const f of wf) lambdas.set(f.lambda, (lambdas.get(f.lambda) ?? 0) + 1);
console.log(`Penalties chosen (rows): ${[...lambdas].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}: ${n}`).join(", ")}`);

const configured = DEFAULT_CONFIG.features.gapBetas;
const sameAsHandSet = KEYS.every((k) => configured[k] === HAND_SET_BETAS[k]) && Object.keys(configured).length === KEYS.length;

// The betas fitted once on the sessions before the holdout, scored on the holdout.
const preRows = complete.filter((r) => r.date < holdoutFrom);
const preLambda = chooseGapLambda(preRows, KEYS);
const preBetas = fitGapBetas(preRows, KEYS, preLambda);

type Model = { name: string; predict: (r: Row, wfPred: number) => number };
const models: Model[] = [
  { name: "hand-set betas", predict: (r) => expectedGapPct(r.moves, HAND_SET_BETAS) },
  ...(sameAsHandSet ? [] : [{ name: "configured defaults", predict: (r: Row) => expectedGapPct(r.moves, configured) }]),
  { name: "fitGapBetas walk-forward", predict: (_r, p) => p },
  { name: `fit before ${holdoutFrom} (fixed)`, predict: (r) => expectedGapPct(r.moves, preBetas) },
  ...Object.entries(extraBetas).map(([name, b]) => ({ name, predict: (r: Row) => expectedGapPct(r.moves, b) })),
  { name: "zero (no gap)", predict: () => 0 },
];

function scoreAll(title: string, keep: (r: Row) => boolean, skip: string[] = []): MetricsRow[] {
  const sel = wf.filter((f) => keep(f.obs));
  if (sel.length === 0) return [];
  const list = models.filter((m) => !skip.includes(m.name)).map((m) => scoreModel(m.name, sel.map((f) => ({ date: f.obs.date, actual: f.obs.gapPct, pred: m.predict(f.obs, f.pred) }))));
  metricsTable(title, list);
  return list;
}

const preName = `fit before ${holdoutFrom} (fixed)`;
const results: Record<string, MetricsRow[]> = {};
results.allBeforeHoldout = scoreAll(`Out of sample, every walk-forward session before ${holdoutFrom} (both indices; the fixed fit is in-sample here):`, (r) => r.date < holdoutFrom);
results.holdout = scoreAll(`Out of sample, sessions from ${holdoutFrom} (both indices):`, (r) => r.date >= holdoutFrom);
results.all = scoreAll("Out of sample, every walk-forward session (both indices):", () => true, [preName]);
for (const index of INDICES) results[index] = scoreAll(`Out of sample, ${index} only, every walk-forward session:`, (r) => r.index === index, [preName]);
for (const s of ["intraday", "mixed", "daily"] as const) {
  if (wf.some((f) => f.obs.source === s)) results[`source_${s}`] = scoreAll(`Out of sample, ${s} windows (${s === "intraday" ? windowBars : s === "daily" ? "daily closes" : "some keys intraday"}):`, (r) => r.source === s);
}

// ---------------------------------------------------------------------------
// Fits with bootstrap ranges
// ---------------------------------------------------------------------------

function fitWithRanges(label: string, list: Row[]) {
  const lambda = chooseGapLambda(list, KEYS);
  const betas = fitGapBetas(list, KEYS, lambda);
  const boots = sessionBootstrap(list, (s) => fitGapBetas(s, KEYS, lambda), draws, seed);
  const ranges: Record<string, [number, number, number]> = {};
  for (const k of KEYS) {
    const v = boots.map((b) => b[k]).filter(Number.isFinite);
    ranges[k] = [quantile(v, 0.05), quantile(v, 0.5), quantile(v, 0.95)];
  }
  const ds = [...new Set(list.map((r) => r.date))].sort();
  console.log(`\n${label}: ${list.length} rows, ${ds.length} sessions (${ds[0]} .. ${ds.at(-1)}), penalty ${lambda} (chosen on these sessions)`);
  console.log(table([["key", "beta", "bootstrap 5%", "median", "95%", "hand-set"], ...KEYS.map((k) => [k, f3(betas[k]), f3(ranges[k][0]), f3(ranges[k][1]), f3(ranges[k][2]), f3(HAND_SET_BETAS[k])])]));
  console.log(`  ${betasLine(betas)}`);
  return { from: ds[0], to: ds.at(-1), sessions: ds.length, rows: list.length, lambda, betas, ranges };
}

const fits = {
  beforeHoldout: fitWithRanges(`Fit on every session before ${holdoutFrom}`, preRows),
  toFitTo: fitWithRanges(`Fit on every session up to ${fitTo}`, complete.filter((r) => r.date <= fitTo)),
};

// In-sample calibration of the hand-set betas over every complete row (the 2.1x check).
const inSample = scoreModel("hand-set betas, every complete row", complete.map((r) => ({ date: r.date, actual: r.gapPct, pred: expectedGapPct(r.moves, HAND_SET_BETAS) })));
metricsTable("Hand-set betas on every complete row (no fitting involved):", [inSample]);

const rowsPath = str(args, "rows", undefined);
if (rowsPath) {
  // Every complete row, for checking the fits outside this code (gap and moves as the engine computes them).
  const lines = [["date", "index", "prior", "source", "gapPct", ...KEYS].join(",")];
  for (const r of complete) lines.push([r.date, r.index, r.prior, r.source, r.gapPct, ...KEYS.map((k) => r.moves[k])].join(","));
  writeFileSync(rowsPath, lines.join("\n") + "\n");
  console.log(`\nSaved ${complete.length} rows to ${rowsPath}`);
}

const jsonPath = str(args, "json", undefined);
if (jsonPath) {
  const out = {
    history: { path: historyPath, source: history.source, savedAt: history.savedAt, windows: windowBars, hourlyDir: hourlyDir ?? null },
    extraBetas,
    keys: KEYS,
    handSet: HAND_SET_BETAS,
    configured,
    sessions: { from: dates[0], to: dates.at(-1), complete: dates.length, muhuratRowsLeftOut: muhurat },
    walkForward: { minTrainSessions: minTrain, grid: GAP_LAMBDA_GRID, forecasts: wf.length, sessions: oosDates.length, from: oosDates[0], to: oosDates.at(-1), lambdas: Object.fromEntries(lambdas) },
    holdoutFrom,
    results,
    fits,
    inSampleHandSet: inSample,
    bootstrap: { draws, seed },
  };
  console.log(`\nSaved ${writeJson(jsonPath, out)}`);
}
