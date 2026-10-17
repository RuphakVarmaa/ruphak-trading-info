/**
 * WP14: does FII positioning (vs retail) predict NIFTY, and can an option buyer profit from it?
 * (reports/wp14-positioning.md; every definition is frozen in its §1, committed before any
 * signal-conditional return or P&L was computed). Research only: nothing here changes the engine.
 *
 *   Signals from NSE's participant-wise open interest (fao_participant_oi_DDMMYYYY.csv, published
 *   about 19:00 IST on day T, so used from the next session's 09:15): S1 the FII index-futures long
 *   share L, S2 its daily change, S3 L(FII) − L(Client), S4 the FII index-options net direction;
 *   each a percentile rank within the trailing 250 readings, bottom vs top tercile.
 *   Direction tests on the NIFTY index (D1 E open → E close, W1 E open → E+4 close, M1 E open →
 *   E+19 close, E the entry session after T), the D1 option buyer on real 1-minute prices (ATM CE
 *   or PE, 09:30 → 15:20, ≥ 2 sessions to expiry), descriptive W1 (1-minute) and M1 (bhavcopy)
 *   option holds, three published rules (untuned) and the replications of report §1.9.
 *
 * Data: NSE's published participant OI files (wp14_fetch.py); Yahoo ^NSEI daily bars; the Hugging
 * Face dataset "India Index & Options - 1-minute OHLC" by TradeMarkk (thetrademarkk/india-index-
 * options-1m, revision 0f4800e4, licence CC-BY-NC-4.0, research only) as reduced by WP13's
 * wp13_extract.py; the compact NSE bhavcopy cache (lots, expiries, EOD option prices, short
 * sessions); NSDL's FPI daily series (the owner's example). Raw data is never committed.
 *
 *   npx tsx scripts/research/wp14-positioning.ts coverage --oi <dir> --fetchlog <jsonl> --daily <^NSEI 1d json> --x <x13 extract> --dir <bhavcopy cache> --fpi <nsdl csv> [--nsefii <json>] [--out reports/wp14]
 *   npx tsx scripts/research/wp14-positioning.ts run      (same inputs) [--out reports/wp14] [--ledger] [--smoke]
 *   npx tsx scripts/research/wp14-positioning.ts debug    (same inputs) --day YYYY-MM-DD   (an entry session E)
 *
 *   --nsefii  optional: NSE's provisional FII/DII figures (a short Moneycontrol window), listed beside the owner's example
 *
 *   --smoke  replaces every signal with a fixed, uninformative cycle and prints only counts, skips
 *            and finiteness checks (no P&L): a test of the code paths that reveals nothing about S1–S4
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blocksOf, cutDate, overallVerdict, pickBest, robustness, runOvernight, type CriterionVerdict } from "../../src/engine/backtest/expiryCalendar";
import { hhmmToMin, minToHhmm, MinuteSeries, nearestListed, OPEN_MIN, pairedGap, runPosition, type MinuteBar } from "../../src/engine/backtest/intraday1m";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, type BlockBootstrap } from "../../src/engine/backtest/metrics";
import { blockBootstrap, extremeBucket, fiiDiiLabelsSwapped, INDEX_COLUMNS, longShare, optionsNetDirection, parseParticipantOi, trailingRank, wilson, type OiRow, type SeriesBootstrap } from "../../src/engine/backtest/positioning";
import { engineSpread, maxDrawdown, modeLot, structurePnl, tailShare, type SpreadFn } from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { weekdayOf } from "../../src/engine/clock";
import { quantile } from "../../src/engine/util/math";
import { ROOT, fail, parseArgs, str } from "../lib/node";
import { loadResearchData, md, spotClose, RESEARCH_INDICES, type ResearchData } from "./real_prices";
import { bothListed, CAPITAL, fx, key, loadChainDay, loadIndex, loadManifest, lotOf, pct, rs, type ChainDay, type Manifest, type OptType } from "./wp11-real-intraday";

// ---------------------------------------------------------------------------
// Frozen constants (report §1)
// ---------------------------------------------------------------------------

const WP = "WP14";
const SIGNALS = ["S1", "S2", "S3", "S4"] as const;
type SignalId = (typeof SIGNALS)[number];
const SIGNAL_LABEL: Record<SignalId, string> = {
  S1: "FII index-futures long share L",
  S2: "daily change in L",
  S3: "L(FII) − L(Client)",
  S4: "FII index-options net direction",
};
type HorizonId = "D1" | "W1" | "M1";
const HORIZONS: readonly HorizonId[] = ["D1", "W1", "M1"];
/** Sessions held, the entry session included: D1 E only, W1 E..E+4, M1 E..E+19. */
const HOLD: Record<HorizonId, number> = { D1: 1, W1: 5, M1: 20 };
/** Bootstrap block (sessions): one session for D1 (the day block), twice the holding period for W1 and M1. */
const BLOCK: Record<HorizonId, number> = { D1: 1, W1: 10, M1: 40 };
type Sign = "follow" | "fade";
const SIGNS: readonly Sign[] = ["fade", "follow"];
interface SignalDef {
  window: number;
  q: number;
}
const BASE: SignalDef = { window: 250, q: 3 };
const DEF_PERTURBATIONS: { label: string; def: SignalDef }[] = [
  { label: "quartiles", def: { window: 250, q: 4 } },
  { label: "quintiles", def: { window: 250, q: 5 } },
  { label: "trailing 200", def: { window: 200, q: 3 } },
  { label: "trailing 300", def: { window: 300, q: 3 } },
];
const IS_FRAC = 0.6;
const MIN_OOS = 180;
const BOOT = 20_000;
const BOOT_SUB = 10_000;
const BOOT_LIGHT = 2_000;
const BOOT_FINAL = 100_000;
const SEED = 7;
/** Last session whose option bars hold every trade (WP11 §2); later bars are built from sampled prices. */
const ERA_END = "2024-12-31";
/** The two positioning regimes reported side by side (descriptive; R5 §3.3). */
const REGIME_SPLIT = "2019-12-31";
const ENTRY = hhmmToMin("09:30");
const EXIT = hhmmToMin("15:20");
const ENTRY_ALT = hhmmToMin("09:45");
const EXIT_ALT = hhmmToMin("15:05");
const ENTRY_WAIT = 2;
const EXIT_WAIT = 5;
const MIN_INDEX_BARS = 370;
const CLOSE_MIN = 930;
/** Sessions to expiry at entry: D1 ≥ 2 (plan rule N4); W1 ≥ 6 and M1 ≥ 21 (≥ 2 left on the exit session). */
const MIN_DTE = { D1: 2, W1: 6, M1: 21 };
const MODES = ["conservative", "mid"] as const;
type Mode = (typeof MODES)[number];
const EOD_MODES = ["close", "close+spread"] as const;
type EodMode = (typeof EOD_MODES)[number];
/** Marketcalls' window (Sep 2016 – Sep 2026). */
const MC_FROM = "2016-09-01";
const MC_TO = "2026-09-30";
const OWNER_THRESHOLD = -10_000;
/** Published rules (R5 §2, §5), untuned. */
const HDFC_LS = 0.15;
const HDFC_EPISODES = ["2022-09-29", "2023-03-29", "2023-10-26", "2024-05-30"];
const HDFC_PUBLISHED = "2025-08-07";
const FLIP_CONFIRM = 3;
const FLIP_HOLD = 30;
const DECILE = 0.1;
const DECILE_MEAN = 5;
const DECILE_HOLDS = [20, 30];
/**
 * NSE's Diwali Muhurat sessions (about one hour each), Lakshmi Puja days 2012–2025: special sessions
 * whatever the weekday. A calendar, not market data; coverage §1 checks each against the files and bars.
 */
const MUHURAT = ["2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11", "2016-10-30", "2017-10-19", "2018-11-07", "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"];

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs: readonly number[]) => quantile(xs, 0.5);
const bp = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 1e4).toFixed(d)} bp` : "–");
const pp = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%` : "–");
const bump = (o: Record<string, number>, k: string) => void (o[k] = (o[k] ?? 0) + 1);

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface DailyBar {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Yahoo chart JSON (daily): IST date → bar, or null when Yahoo's row has a missing field. */
function loadYahooDaily(path: string): Map<string, DailyBar | null> {
  const j = JSON.parse(readFileSync(path, "utf8")) as {
    chart: { result: { timestamp: number[]; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] };
  };
  const r = j.chart.result[0];
  const q = r.indicators.quote[0];
  const out = new Map<string, DailyBar | null>();
  r.timestamp.forEach((t, i) => {
    const day = new Date(t * 1000 + 330 * 60_000).toISOString().slice(0, 10);
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    out.set(day, o && h && l && c && o > 0 && c > 0 ? { o, h, l, c } : null);
  });
  return out;
}

interface FetchRec {
  date: string;
  status: number | string;
  lastModified: string | null;
  /** Set when the response was not saved ("unexpected response", "failed after retries", "blocked"). */
  note?: string;
}

function loadFetchLog(path: string): Map<string, FetchRec> {
  const out = new Map<string, FetchRec>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as FetchRec;
    const prev = out.get(r.date);
    // The latest record wins unless an earlier one saved the file and this one did not.
    if (!prev || prev.status !== 200 || prev.note !== undefined) out.set(r.date, r);
  }
  return out;
}

interface OiFile {
  day: string;
  firstHeader: string;
  order: string;
  warnings: string[];
  problems: string[];
}

interface OiDay {
  day: string;
  fii: OiRow;
  client: OiRow;
  dii: OiRow;
  pro: OiRow;
}

/** Every participant OI file in `dir`, parsed and checked; usable days ascending (report §2.1). */
function loadOi(dir: string): { days: OiDay[]; files: OiFile[] } {
  const files: OiFile[] = [];
  const days: OiDay[] = [];
  const names = readdirSync(dir).filter((f) => /^fao_participant_oi_\d{8}\.csv$/.test(f));
  for (const name of names) {
    const m = /(\d{2})(\d{2})(\d{4})/.exec(name)!;
    const day = `${m[3]}-${m[2]}-${m[1]}`;
    const p = parseParticipantOi(readFileSync(resolve(dir, name), "utf8"), { strict: INDEX_COLUMNS });
    const problems = [...p.problems];
    if (p.asOf !== null && p.asOf !== day) problems.push(`title date ${p.asOf} ≠ file date`);
    const { FII: fii, DII: dii, Client: client, Pro: pro } = p.rows;
    if (fii && dii && fiiDiiLabelsSwapped(fii, dii)) problems.push("FII/DII labels appear swapped (the FII row has no index-option shorts, the DII row has some)");
    files.push({ day, firstHeader: p.firstHeader, order: p.order.join(","), warnings: p.warnings, problems });
    if (problems.length === 0 && fii && dii && client && pro) days.push({ day, fii, dii, client, pro });
  }
  files.sort((a, b) => a.day.localeCompare(b.day));
  days.sort((a, b) => a.day.localeCompare(b.day));
  return { days, files };
}

/** NSDL FPI daily (Q2's parsed archive): the stock-exchange net (₹ crore) by report date. */
function loadFpi(path: string): { report: string; net: number }[] {
  const lines = readFileSync(path, "utf8").split("\n").slice(1);
  const out: { report: string; net: number }[] = [];
  for (const l of lines) {
    const f = l.split(",");
    if (f.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(f[0])) continue;
    const net = Number(f[3]);
    if (Number.isFinite(net)) out.push({ report: f[0], net });
  }
  return out.sort((a, b) => a.report.localeCompare(b.report));
}

// ---------------------------------------------------------------------------
// Sessions and signals (report §1.2–§1.3)
// ---------------------------------------------------------------------------

interface World {
  oi: { days: OiDay[]; files: OiFile[] };
  oiIx: Map<string, number>;
  fetch: Map<string, FetchRec>;
  yahoo: Map<string, DailyBar | null>;
  /** NSE sessions: a participant file, a complete Yahoo bar or a bhavcopy that day. */
  cal: string[];
  calIx: Map<string, number>;
  /** Weekend sessions, Muhurat sessions and the bhavcopy's short sessions (DR drills): never an entry, not counted in a hold. */
  special: Set<string>;
  /** The sessions that should have a file: cal minus the special sessions without a usable file (for adjacency). */
  fileCal: string[];
  fileIx: Map<string, number>;
  /** Regular sessions (cal minus special), ascending. */
  reg: string[];
  regIx: Map<string, number>;
  /** Raw signal values aligned with oi.days. */
  raw: Record<SignalId, (number | null)[]>;
  rankCache: Map<string, (number | null)[]>;
}

function buildWorld(I: Inputs, data: ResearchData): World {
  const oi = loadOi(I.oiDir);
  const fetch = loadFetchLog(I.fetchLog);
  const yahoo = loadYahooDaily(I.daily);
  const calSet = new Set<string>(oi.files.map((f) => f.day));
  for (const [d, b] of yahoo) if (b && d >= "2011-12-01") calSet.add(d);
  for (const d of data.book.dates("NIFTY")) calSet.add(d);
  const cal = [...calSet].sort();
  const calIx = new Map(cal.map((d, i) => [d, i]));
  const special = new Set<string>([...cal.filter((d) => weekdayOf(d) >= 6 || MUHURAT.includes(d)), ...data.special]);
  const reg = cal.filter((d) => !special.has(d));
  const regIx = new Map(reg.map((d, i) => [d, i]));
  const oiIx = new Map(oi.days.map((d, i) => [d.day, i]));
  const fileCal = cal.filter((d) => !special.has(d) || oiIx.has(d));
  const fileIx = new Map(fileCal.map((d, i) => [d, i]));
  const L = oi.days.map((d) => longShare(d.fii.futIdxLong, d.fii.futIdxShort));
  const LC = oi.days.map((d) => longShare(d.client.futIdxLong, d.client.futIdxShort));
  const raw: Record<SignalId, (number | null)[]> = {
    S1: L,
    S2: L.map((v, i) => {
      if (i === 0 || v === null || L[i - 1] === null) return null;
      // Only across consecutive sessions: a missing or excluded file breaks the daily change.
      return fileIx.get(oi.days[i].day)! - fileIx.get(oi.days[i - 1].day)! === 1 ? v - L[i - 1]! : null;
    }),
    S3: L.map((v, i) => (v === null || LC[i] === null ? null : v - LC[i]!)),
    S4: oi.days.map((d) => optionsNetDirection(d.fii)),
  };
  return { oi, oiIx, fetch, yahoo, cal, calIx, special, fileCal, fileIx, reg, regIx, raw, rankCache: new Map() };
}

function ranks(w: World, s: SignalId, window: number): (number | null)[] {
  const k = `${s}|${window}`;
  let r = w.rankCache.get(k);
  if (!r) {
    r = trailingRank(w.raw[s], window);
    w.rankCache.set(k, r);
  }
  return r;
}

/** Buckets aligned with oi.days: −1 bottom, +1 top, 0 middle, null without a rank. --smoke: a fixed cycle. */
function buckets(w: World, s: SignalId, def: SignalDef, smoke: boolean): (-1 | 0 | 1 | null)[] {
  const r = ranks(w, s, def.window);
  if (smoke) return r.map((v, i) => (v === null ? null : ([1, -1, 0] as const)[i % 3]));
  return r.map((v) => (v === null ? null : extremeBucket(v, def.q)));
}

/**
 * The session whose file is the latest one published before `day`'s open: the session immediately
 * before it, skipping special sessions that have no usable file (a regular session without one is
 * not skipped: its reading is simply missing).
 */
const prevSession = (w: World, day: string): string | null => {
  let lo = 0;
  let hi = w.fileCal.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (w.fileCal[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? w.fileCal[lo - 1] : null;
};

/** The regular session k ≥ 0 sessions after the regular session E (k = 0: E itself). */
const regFrom = (w: World, E: string, k: number): string | null => {
  const i = w.regIx.get(E);
  return i === undefined || i + k >= w.reg.length ? null : w.reg[i + k];
};

/** The first regular session strictly after `day`. */
const regAfter = (w: World, day: string): string | null => {
  let lo = 0;
  let hi = w.reg.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (w.reg[mid] <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo < w.reg.length ? w.reg[lo] : null;
};

type SignalAt = { T: string; i: number; b: -1 | 0 | 1 } | { skip: string };

/** The signal an entry session E trades on: the file of the session immediately before E (report §1.2). */
function signalAt(w: World, E: string, bs: readonly (-1 | 0 | 1 | null)[]): SignalAt {
  const T = prevSession(w, E);
  if (!T) return { skip: "no session before" };
  const i = w.oiIx.get(T);
  if (i === undefined) return { skip: "no usable file for the session before" };
  const b = bs[i];
  if (b === null) return { skip: "no rank yet" };
  return { T, i, b };
}

// ---------------------------------------------------------------------------
// Direction tests on the index (report §1.4)
// ---------------------------------------------------------------------------

interface IndexObs {
  T: string;
  entry: string;
  exit: string;
  r: number;
  b: -1 | 0 | 1;
}

/**
 * Every regular entry session with a signal and an index return over the horizon: E official open →
 * E+h−1 official close. `withReturns = false` (the coverage step) checks the bars but leaves r NaN.
 */
function indexObs(w: World, s: SignalId, def: SignalDef, h: HorizonId, smoke: boolean, withReturns = true): { obs: IndexObs[]; skips: Record<string, number> } {
  const bs = buckets(w, s, def, smoke);
  const obs: IndexObs[] = [];
  const skips: Record<string, number> = {};
  for (const E of w.reg) {
    if (E < w.oi.days[0]?.day) continue;
    const sig = signalAt(w, E, bs);
    if ("skip" in sig) {
      if (sig.skip !== "no rank yet") bump(skips, sig.skip);
      continue;
    }
    const X = regFrom(w, E, HOLD[h] - 1);
    if (!X) {
      bump(skips, "after the end of the calendar");
      continue;
    }
    const eb = w.yahoo.get(E);
    const xb = w.yahoo.get(X);
    if (!eb || !xb) {
      bump(skips, "no complete index bar");
      continue;
    }
    obs.push({ T: sig.T, entry: E, exit: X, r: withReturns ? xb.c / eb.o - 1 : NaN, b: sig.b });
  }
  return { obs, skips };
}

interface DirSub {
  label: string;
  sessions: number;
  n: number;
  /** Independent-trade equivalent: signal days ÷ sessions held. */
  nEff: number;
  mean: number;
  boot: SeriesBootstrap;
  pf: number;
  hit: number;
  /** Hit rate of a random side drawn at the strategy's own share of long trades, on the same days. */
  base: number;
  /** Share of the same days on which the index rose over the horizon. */
  up: number;
  pLong: number;
  gap: number;
  gapSe: number;
  /** Per-session signed return (0 without a trade), for the DSR. */
  rets: number[];
}

function dirSub(label: string, obs: readonly IndexObs[], sign: Sign, h: HorizonId, resamples: number, gapResamples = Math.min(resamples, BOOT_SUB)): DirSub {
  const sg = sign === "follow" ? 1 : -1;
  const trade = obs.map((o) => o.b !== 0);
  const s = obs.map((o) => sg * o.b);
  const x = obs.map((o, i) => (trade[i] ? s[i] * o.r : 0));
  const tx = x.filter((_, i) => trade[i]);
  const tobs = obs.filter((_, i) => trade[i]);
  const n = tx.length;
  const pLong = n ? s.filter((v, i) => trade[i] && v > 0).length / n : NaN;
  const base = n ? avg(tobs.map((o) => (o.r > 0 ? pLong : 0) + (o.r < 0 ? 1 - pLong : 0))) : NaN;
  const g = obs.map((o, i) => (trade[i] ? (s[i] - (2 * pLong - 1)) * o.r : 0));
  const boot = blockBootstrap(x, trade, { block: BLOCK[h], resamples, seed: SEED });
  const gb = n ? blockBootstrap(g, trade, { block: BLOCK[h], resamples: gapResamples, seed: SEED }) : null;
  return {
    label,
    sessions: obs.length,
    n,
    nEff: n / HOLD[h],
    mean: n ? sum(tx) / n : NaN,
    boot,
    pf: profitFactor(tx),
    hit: n ? tx.filter((v) => v > 0).length / n : NaN,
    base,
    up: n ? tobs.filter((o) => o.r > 0).length / n : NaN,
    pLong,
    gap: gb ? gb.perTrade.estimate : NaN,
    gapSe: gb ? gb.perTrade.se : NaN,
    rets: x,
  };
}

interface DirRun {
  name: string;
  signal: SignalId;
  horizon: HorizonId;
  sign: Sign;
  def: SignalDef;
  kind: "strategy" | "perturbation";
  base?: string;
  label?: string;
  obs: IndexObs[];
  skips: Record<string, number>;
}

interface DirStats {
  full: DirSub;
  is: DirSub;
  oos: DirSub;
  regime1: DirSub;
  regime2: DirSub;
  years: { year: string; n: number; mean: number; hit: number }[];
  sr: number;
}

const sharpe = (rets: readonly number[]) => {
  const m = avg(rets);
  const sd = Math.sqrt(sum(rets.map((x) => (x - m) ** 2)) / Math.max(1, rets.length - 1));
  return sd > 0 ? m / sd : 0;
};

/** Statistics of an index variant; in sample = entries whose whole hold ends by the cut (purged), out of sample = entries after it. */
function dirStats(r: DirRun, cut: string, light = false): DirStats {
  const n = (k: number) => (light ? BOOT_LIGHT : k);
  const full = dirSub("all", r.obs, r.sign, r.horizon, n(BOOT));
  const isObs = r.obs.filter((o) => o.exit <= cut);
  const oosObs = r.obs.filter((o) => o.entry > cut);
  let oos = dirSub("last 40%", oosObs, r.sign, r.horizon, n(BOOT));
  if (!light && oos.boot.perTrade.lo > 0 && oos.boot.perSession.lo > 0) oos = dirSub("last 40%", oosObs, r.sign, r.horizon, BOOT_FINAL);
  const sg = r.sign === "follow" ? 1 : -1;
  const years = [...new Set(r.obs.map((o) => o.entry.slice(0, 4)))].sort().map((year) => {
    const xs = r.obs.filter((o) => o.entry.startsWith(year) && o.b !== 0).map((o) => sg * o.b * o.r);
    return { year, n: xs.length, mean: avg(xs), hit: xs.length ? xs.filter((v) => v > 0).length / xs.length : NaN };
  });
  return {
    full,
    is: dirSub("first 60% (purged)", isObs, r.sign, r.horizon, n(BOOT_SUB)),
    oos,
    regime1: dirSub(`to ${REGIME_SPLIT.slice(0, 4)}`, r.obs.filter((o) => o.entry <= REGIME_SPLIT), r.sign, r.horizon, BOOT_LIGHT),
    regime2: dirSub(`from ${Number(REGIME_SPLIT.slice(0, 4)) + 1}`, r.obs.filter((o) => o.entry > REGIME_SPLIT), r.sign, r.horizon, BOOT_LIGHT),
    years,
    sr: sharpe(full.rets),
  };
}

// ---------------------------------------------------------------------------
// The option buyer on real 1-minute prices (report §1.5)
// ---------------------------------------------------------------------------

interface OptCtx {
  data: ResearchData;
  x: string;
  man: Manifest[string];
  index: Map<string, MinuteBar[]>;
  /** Valid 1-minute sessions (WP11 §1.1). */
  daySet: Set<string>;
  chains: Map<string, ChainDay | null>;
  idx: Map<string, MinuteSeries>;
}

function optCtx(data: ResearchData, x: string): OptCtx {
  const man = loadManifest(x).NIFTY;
  const index = loadIndex(x, "NIFTY");
  const bookDays = new Set(data.book.dates("NIFTY"));
  const daySet = new Set(
    man.sessions.filter((day) => {
      const session = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m < CLOSE_MIN);
      return bookDays.has(day) && !data.special.has(day) && session.length >= MIN_INDEX_BARS && session[0]?.m === OPEN_MIN;
    }),
  );
  return { data, x, man, index, daySet, chains: new Map(), idx: new Map() };
}

/** A contract's bars on a day, cached (the oldest of more than 256 cached days is dropped: sessions are visited in date order). */
function chainOf(c: OptCtx, day: string, expiry: string): ChainDay | null {
  const k = `${day}_${expiry}`;
  if (!c.chains.has(k)) {
    const info = c.man.pairs[k];
    c.chains.set(k, info ? loadChainDay(c.x, "NIFTY", day, expiry, info.role) : null);
    if (c.chains.size > 256) c.chains.delete(c.chains.keys().next().value!);
  }
  return c.chains.get(k)!;
}

function idxOf(c: OptCtx, day: string): MinuteSeries {
  let s = c.idx.get(day);
  if (!s) {
    s = new MinuteSeries((c.index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= CLOSE_MIN));
    c.idx.set(day, s);
  }
  return s;
}

/** The nearest listed expiry (bhavcopy) with at least `minDte` NSE sessions after `day` up to and including it. */
function expiryWithDte(data: ResearchData, day: string, minDte: number): { expiry: string; dte: number } | null {
  for (const e of data.book.expiries("NIFTY", day)) {
    const dte = data.book.sessionsToExpiry("NIFTY", day, e);
    if (dte >= minDte) return { expiry: e, dte };
  }
  return null;
}

export interface Trade14 {
  /** Signal day (the file used). */
  T: string;
  /** Entry session E. */
  day: string;
  exitDay: string;
  side: OptType;
  net: number;
  gross: number;
  charges: number;
  /** ₹ per lot paid at the entry fill. */
  premium: number;
  entryMin: number;
  exitMin: number;
  stale: number;
  dte: number;
  k: number;
  lot: number;
  /** Index level used for the strike, at the exit, and the move between, signed for the side bought (+ for a call when the index rose). */
  level: number;
  levelExit: number;
  move: number;
}

/** The call and the put of one entry session, bought at the same minute and strike. */
interface PairDay {
  day: string;
  exitDay: string;
  ce: Trade14 | null;
  pe: Trade14 | null;
  skip?: string;
}

const noPair = (day: string, skip: string): PairDay => ({ day, exitDay: "", ce: null, pe: null, skip });

/** D1: buy the ATM call and the ATM put of the nearest expiry with ≥ 2 sessions left at `entry` on E, sell at `exit` the same session. */
function d1Pair(c: OptCtx, E: string, entry: number, exit: number, mode: Mode): PairDay {
  if (!c.daySet.has(E)) return noPair(E, "not a valid 1-minute session");
  const ex = expiryWithDte(c.data, E, MIN_DTE.D1);
  if (!ex) return noPair(E, "no expiry with ≥ 2 sessions");
  const chain = chainOf(c, E, ex.expiry);
  if (!chain) return noPair(E, "contract missing from the dataset");
  const lot = lotOf(c.data, "NIFTY", E, ex.expiry);
  if (lot === null) return noPair(E, "no lot in the bhavcopy");
  const idx = idxOf(c, E);
  const level = idx.lastUpTo(entry - 1)?.c ?? null;
  if (level === null) return noPair(E, "no index level");
  const k = nearestListed(bothListed(chain), level);
  if (k === null) return noPair(E, "no ATM strike");
  const out: PairDay = { day: E, exitDay: E, ce: null, pe: null };
  for (const t of ["CE", "PE"] as const) {
    const series = chain.series.get(key(k, t))!;
    const res = runPosition({ legs: [{ series, side: "long" }], entryMin: entry, entryWait: ENTRY_WAIT, exitMin: exit, exitWait: EXIT_WAIT, stopFrac: null, mode });
    if (!res) continue;
    const l = res.legs[0];
    const p = structurePnl([{ side: "long", entry: l.entry, exit: l.exit, settled: false }], { lot, exchange: "NSE", entryDate: E, exitDate: E, spread: () => 0 });
    const levelExit = idx.lastUpTo(res.exitMin)?.c ?? NaN;
    const tr: Trade14 = { T: "", day: E, exitDay: E, side: t, net: p.net, gross: p.gross, charges: p.charges, premium: l.entry * lot, entryMin: res.entryMin, exitMin: res.exitMin, stale: l.staleExit ? 1 : 0, dte: ex.dte, k, lot, level, levelExit, move: (t === "CE" ? 1 : -1) * (levelExit / level - 1) };
    if (t === "CE") out.ce = tr;
    else out.pe = tr;
  }
  if (!out.ce || !out.pe) return noPair(E, "a leg has no bar in the entry window");
  return out;
}

/** W1 (descriptive): buy at E 09:30, sell at E+4 15:20 (regular sessions), nearest expiry with ≥ 6 sessions left at entry. */
function w1Pair(w: World, c: OptCtx, E: string, mode: Mode): PairDay {
  const X = regFrom(w, E, HOLD.W1 - 1);
  if (!X) return noPair(E, "after the end of the calendar");
  if (!c.daySet.has(E) || !c.daySet.has(X)) return noPair(E, "entry or exit not a valid 1-minute session");
  const ex = expiryWithDte(c.data, E, MIN_DTE.W1);
  if (!ex) return noPair(E, "no expiry with ≥ 6 sessions");
  const chain = chainOf(c, E, ex.expiry);
  const chainX = chainOf(c, X, ex.expiry);
  if (!chain || !chainX) return noPair(E, "contract missing from the dataset");
  const lot = lotOf(c.data, "NIFTY", E, ex.expiry);
  if (lot === null) return noPair(E, "no lot in the bhavcopy");
  const level = idxOf(c, E).lastUpTo(ENTRY - 1)?.c ?? null;
  if (level === null) return noPair(E, "no index level");
  const k = nearestListed(bothListed(chain), level);
  if (k === null) return noPair(E, "no ATM strike");
  const out: PairDay = { day: E, exitDay: X, ce: null, pe: null };
  for (const t of ["CE", "PE"] as const) {
    const res = runOvernight({ legs: [{ entry: chain.series.get(key(k, t))!, exit: chainX.series.get(key(k, t)) ?? null, side: "long" }], entryMin: ENTRY, entryWait: ENTRY_WAIT, exitMin: EXIT, exitWait: EXIT_WAIT, mode });
    if ("skip" in res) continue;
    const l = res.legs[0];
    const p = structurePnl([{ side: "long", entry: l.entry, exit: l.exit, settled: false }], { lot, exchange: "NSE", entryDate: E, exitDate: X, spread: () => 0 });
    const levelExit = idxOf(c, X).lastUpTo(EXIT)?.c ?? NaN;
    const tr: Trade14 = { T: "", day: E, exitDay: X, side: t, net: p.net, gross: p.gross, charges: p.charges, premium: l.entry * lot, entryMin: res.entryMin, exitMin: res.exitMin, stale: l.staleExit ? 1 : 0, dte: ex.dte, k, lot, level, levelExit, move: (t === "CE" ? 1 : -1) * (levelExit / level - 1) };
    if (t === "CE") out.ce = tr;
    else out.pe = tr;
  }
  if (!out.ce || !out.pe) return noPair(E, "a leg has no entry bar or no exit price");
  return out;
}

/** M1 (descriptive, end-of-day bhavcopy): buy at E's closing price, sell at E+19's (regular sessions), nearest expiry with ≥ 21 sessions left. */
function m1Pair(w: World, data: ResearchData, E: string, mode: EodMode): PairDay {
  const X = regFrom(w, E, HOLD.M1 - 1);
  if (!X) return noPair(E, "after the end of the calendar");
  const book = new Set(data.book.dates("NIFTY"));
  if (!book.has(E) || !book.has(X)) return noPair(E, "no bhavcopy on the entry or exit session");
  const ex = expiryWithDte(data, E, MIN_DTE.M1);
  if (!ex) return noPair(E, "no expiry with ≥ 21 sessions in the cache");
  const level = spotClose(data, RESEARCH_INDICES[0], E);
  if (level === null) return noPair(E, "no index close");
  const traded = (t: OptType, d: string, k: number) => {
    const r = data.book.option("NIFTY", d, ex.expiry, k, t);
    return r && r.contracts > 0 && r.close !== null && r.close > 0 ? r : null;
  };
  const strikes = data.book.strikes("NIFTY", E, ex.expiry).filter((k) => traded("CE", E, k) && traded("PE", E, k));
  const k = nearestListed(strikes, level);
  if (k === null) return noPair(E, "no traded ATM strike");
  const lot = modeLot(data.book.rows("NIFTY", E).filter((r) => r.kind === "OPT" && r.expiry === ex.expiry).map((r) => r.lot));
  if (lot === null) return noPair(E, "no lot in the bhavcopy");
  const spread: SpreadFn = mode === "close" ? () => 0 : engineSpread;
  const levelExit = spotClose(data, RESEARCH_INDICES[0], X) ?? NaN;
  const out: PairDay = { day: E, exitDay: X, ce: null, pe: null };
  for (const t of ["CE", "PE"] as const) {
    const a = traded(t, E, k)!;
    const b = traded(t, X, k);
    if (!b) continue;
    const p = structurePnl([{ side: "long", entry: a.close!, exit: b.close!, settled: false }], { lot, exchange: "NSE", entryDate: E, exitDate: X, spread });
    const tr: Trade14 = { T: "", day: E, exitDay: X, side: t, net: p.net, gross: p.gross, charges: p.charges, premium: a.close! * lot, entryMin: CLOSE_MIN, exitMin: CLOSE_MIN, stale: 0, dte: ex.dte, k, lot, level, levelExit, move: (t === "CE" ? 1 : -1) * (levelExit / level - 1) };
    if (t === "CE") out.ce = tr;
    else out.pe = tr;
  }
  if (!out.ce || !out.pe) return noPair(E, "a leg did not trade on the exit session");
  return out;
}

// ---------------------------------------------------------------------------
// Option variants and their statistics
// ---------------------------------------------------------------------------

type OptFamily = "D1" | "W1" | "M1";

interface OptRun {
  name: string;
  family: OptFamily;
  signal: SignalId;
  sign: Sign;
  mode: Mode | EodMode;
  def: SignalDef;
  entry: number;
  exit: number;
  kind: "strategy" | "perturbation";
  base?: string;
  label?: string;
  /** Entry sessions the variant was evaluated on (a signal and both legs priced), traded or not. */
  slots: string[];
  trades: Trade14[];
  /** Both sides' net on each traded session, for the placebo. */
  pairs: { day: string; ce: number; pe: number }[];
  skips: Record<string, number>;
}

interface OptSub {
  label: string;
  n: number;
  sessions: number;
  net: number;
  mean: number;
  lo: number;
  hi: number;
  sessLo: number;
  sessHi: number;
  pf: number;
  hit: number;
  boot: BlockBootstrap;
  /** Strategy minus a random side drawn at the strategy's own share of calls (exact expectation), paired by session. */
  gap: ReturnType<typeof pairedGap>;
  pCe: number;
  rets: number[];
}

function optSub(r: OptRun, label: string, f: (day: string) => boolean, resamples: number): OptSub {
  const slots = r.slots.filter(f);
  const ts = r.trades.filter((t) => f(t.day));
  const blocks = blocksOf(ts.map((t) => ({ block: t.day, net: t.net })), slots);
  const boot = dayBlockBootstrap(blocks, { resamples, seed: SEED });
  const nets = ts.map((t) => t.net);
  const pCe = ts.length ? ts.filter((t) => t.side === "CE").length / ts.length : NaN;
  const pairBy = new Map(r.pairs.map((p) => [p.day, p]));
  const gap = pairedGap(ts.map((t) => ({ n: 1, s: t.net, p: pCe * pairBy.get(t.day)!.ce + (1 - pCe) * pairBy.get(t.day)!.pe })));
  return {
    label,
    n: ts.length,
    sessions: blocks.length,
    net: sum(nets),
    mean: avg(nets),
    lo: boot.perTrade.lo,
    hi: boot.perTrade.hi,
    sessLo: boot.perSession.lo,
    sessHi: boot.perSession.hi,
    pf: profitFactor(nets),
    hit: ts.length ? ts.filter((t) => t.net > 0).length / ts.length : NaN,
    boot,
    gap,
    pCe,
    rets: blocks.map((b) => sum(b.pnls) / CAPITAL),
  };
}

interface OptStats {
  full: OptSub;
  is: OptSub;
  oos: OptSub;
  era1: OptSub;
  era2: OptSub;
  oosEra1: OptSub;
  oosEra2: OptSub;
  years: { year: string; n: number; net: number; mean: number }[];
  sr: number;
  tail: { worst: number; worstDay: string; best: number; bestDay: string; worst10: number; best10Share: number; withoutBest5: number; withoutBest10: number; maxDD: number; worst5Multiple: number; longestLosing: number };
  premium: number;
  charges: number;
  move: number;
  moveHit: number;
}

function optStats(r: OptRun, cut: string | null, light = false): OptStats {
  const c = cut ?? "9999-12-31";
  const sub = (label: string, f: (d: string) => boolean, n: number) => optSub(r, label, f, light ? BOOT_LIGHT : n);
  const full = sub("all", () => true, BOOT);
  let oos = sub("last 40%", (d) => d > c, BOOT);
  if (!light && oos.lo > 0 && oos.sessLo > 0) oos = optSub(r, "last 40%", (d) => d > c, BOOT_FINAL);
  const years = [...new Set(r.trades.map((t) => t.day.slice(0, 4)))].sort().map((year) => {
    const ts = r.trades.filter((t) => t.day.startsWith(year));
    return { year, n: ts.length, net: sum(ts.map((t) => t.net)), mean: avg(ts.map((t) => t.net)) };
  });
  const nets = r.trades.map((t) => t.net);
  const sorted = [...r.trades].sort((a, b) => a.net - b.net);
  const total = sum(nets);
  const best = [...nets].sort((a, b) => b - a);
  let run = 0;
  let longest = 0;
  for (const t of r.trades) {
    run = t.net <= 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    full,
    is: sub("first 60%", (d) => d <= c, BOOT_SUB),
    oos,
    era1: sub("complete bars (to Dec 2024)", (d) => d <= ERA_END, BOOT_SUB),
    era2: sub("sampled bars (from Jan 2025)", (d) => d > ERA_END, BOOT_SUB),
    oosEra1: sub("last 40%, to Dec 2024", (d) => d > c && d <= ERA_END, BOOT_SUB),
    oosEra2: sub("last 40%, from Jan 2025", (d) => d > c && d > ERA_END, BOOT_SUB),
    years,
    sr: sharpe(full.rets),
    tail: {
      worst: sorted[0]?.net ?? NaN,
      worstDay: sorted[0]?.day ?? "",
      best: sorted.at(-1)?.net ?? NaN,
      bestDay: sorted.at(-1)?.day ?? "",
      worst10: sum(sorted.slice(0, 10).map((t) => t.net)),
      best10Share: total > 0 ? sum(best.slice(0, 10)) / total : NaN,
      withoutBest5: total - sum(best.slice(0, 5)),
      withoutBest10: total - sum(best.slice(0, 10)),
      maxDD: maxDrawdown(nets).depth,
      worst5Multiple: tailShare(nets, 0.05).multiple,
      longestLosing: longest,
    },
    premium: avg(r.trades.map((t) => t.premium)),
    charges: avg(r.trades.map((t) => t.charges)),
    move: avg(r.trades.map((t) => t.move)),
    moveHit: r.trades.length ? r.trades.filter((t) => t.move > 0).length / r.trades.length : NaN,
  };
}

// ---------------------------------------------------------------------------
// The bar (report §1.7)
// ---------------------------------------------------------------------------

interface Criterion {
  name: string;
  verdict: CriterionVerdict;
  detail: string;
}

interface Judged {
  name: string;
  criteria: Criterion[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT";
  p: number;
  dsr: number;
  dsrNull: number;
}

/** Criteria 2–4 out of sample: the condition for running the ±20% perturbations. */
const dirCore = (s: DirStats) => s.oos.n > 0 && s.oos.boot.perTrade.lo > 0 && s.oos.boot.perSession.lo > 0 && s.oos.pf >= 1.3 && s.oos.gap >= 2 * s.oos.gapSe;
const optCore = (s: OptStats) => s.oos.n > 0 && s.oos.lo > 0 && s.oos.sessLo > 0 && s.oos.pf >= 1.3 && s.oos.gap.gap >= 2 * s.oos.gap.se;

function multipleTesting(rets: readonly number[], pTrade: number, pSession: number, ledgerN: number, srVar: number | null): { c: Criterion; p: number; dsr: number; dsrNull: number } {
  const p = Math.max(pTrade, pSession);
  const dsr = deflatedSharpe(rets, ledgerN, srVar);
  const dsrNull = deflatedSharpe(rets, ledgerN, null);
  const alpha = 0.05 / ledgerN;
  return {
    c: { name: "Bonferroni and deflated Sharpe", verdict: p < alpha && dsr.dsr >= 0.95 ? "PASS" : "FAIL", detail: `p ${p.toExponential(1)} vs 0.05/${ledgerN} = ${alpha.toExponential(1)}; DSR ${fx(dsr.dsr, 3)} (SR ${fx(dsr.sr, 3)}/session, SR₀ ${fx(dsr.sr0, 3)}); with V = 1/(T−1): ${fx(dsrNull.dsr, 3)}` },
    p,
    dsr: dsr.dsr,
    dsrNull: dsrNull.dsr,
  };
}

function judgeDir(r: DirRun, s: DirStats, perts: { label: string; oosNet: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS} independent trades out of sample`, verdict: o.nEff >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} signal days in the last 40% ÷ ${HOLD[r.horizon]} sessions held = ${fx(o.nEff, 0)}` });
  c.push({ name: "placebo gap ≥ 2 SE (a random side at the same share of longs)", verdict: o.gap >= 2 * o.gapSe ? "PASS" : "FAIL", detail: `gap ${bp(o.gap)} per trade, SE ${bp(o.gapSe)} (${fx(o.gap / o.gapSe)} SE); hit ${pct(o.hit)} vs base ${pct(o.base)}; longs ${pct(o.pLong, 0)}` });
  c.push({ name: `block-bootstrap 95% CI > 0 per trade and per session (blocks of ${BLOCK[r.horizon]})`, verdict: o.boot.perTrade.lo > 0 && o.boot.perSession.lo > 0 ? "PASS" : "FAIL", detail: `${bp(o.mean)} per trade (${bp(o.boot.perTrade.lo)} … ${bp(o.boot.perTrade.hi)}); per session ${bp(o.boot.perSession.estimate)} (${bp(o.boot.perSession.lo)} … ${bp(o.boot.perSession.hi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for picks that pass the placebo, the CI and the PF out of sample" });
  else {
    const base = sum(o.rets);
    const rb = robustness(base, perts.map((p) => p.oosNet));
    c.push({ name: "±20% robustness", verdict: rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; ${perts.map((p) => `${p.label} ${bp(p.oosNet, 0)}`).join(", ")} vs base ${bp(base, 0)} (summed)` });
  }
  const mt = multipleTesting(o.rets, o.boot.perTrade.p, o.boot.perSession.p, ledgerN, srVar);
  c.push(mt.c);
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

function judgeOpt(r: OptRun, s: OptStats, perts: { label: string; oosNet: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS} trades out of sample`, verdict: o.n >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} trades in the last 40% (${o.sessions} sessions)` });
  c.push({ name: "placebo gap ≥ 2 SE (a random side at the same share of calls)", verdict: o.gap.gap >= 2 * o.gap.se ? "PASS" : "FAIL", detail: `gap ${rs(o.gap.gap)} per trade, SE ${rs(o.gap.se)} (${fx(o.gap.t)} SE); calls ${pct(o.pCe, 0)}` });
  c.push({ name: "day-block 95% CI > 0 per trade and per session", verdict: o.lo > 0 && o.sessLo > 0 ? "PASS" : "FAIL", detail: `${rs(o.mean)}/trade (${rs(o.lo)} … ${rs(o.hi)}); per session ${rs(o.boot.perSession.estimate)} (${rs(o.sessLo)} … ${rs(o.sessHi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for picks that pass the placebo, the CI and the PF out of sample" });
  else {
    const rb = robustness(o.net, perts.map((p) => p.oosNet));
    c.push({ name: "±20% robustness", verdict: rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; ${perts.map((p) => `${p.label} ${rs(p.oosNet)}`).join(", ")} vs base ${rs(o.net)}` });
  }
  const mt = multipleTesting(o.rets, o.boot.perTrade.p, o.boot.perSession.p, ledgerN, srVar);
  c.push(mt.c);
  const e1 = s.era1;
  c.push({ name: "complete-bar era (to Dec 2024, all days): mean > 0, CI > 0", verdict: e1.n > 0 && e1.lo > 0 ? "PASS" : "FAIL", detail: `${e1.n} trades, ${rs(e1.mean)}/trade (${rs(e1.lo)} … ${rs(e1.hi)}); sampled era ${s.era2.n} trades, ${rs(s.era2.mean)}` });
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

// ---------------------------------------------------------------------------
// Building the variants
// ---------------------------------------------------------------------------

const defLabel = (d: SignalDef) => (d.window === BASE.window && d.q === BASE.q ? "" : ` [${d.q === 3 ? "terciles" : d.q === 4 ? "quartiles" : "quintiles"}, trailing ${d.window}]`);
const dirName = (s: SignalId, h: HorizonId, sign: Sign, d: SignalDef) => `NIFTY index ${s} ${h} ${sign}${defLabel(d)}`;
const optName = (f: OptFamily, s: SignalId, sign: Sign, mode: string, d: SignalDef, entry: number, exit: number) =>
  `NIFTY ${f} option ${s} ${sign} ${f === "M1" ? "E close→E+19 close" : f === "W1" ? `${minToHhmm(entry)}→E+4 ${minToHhmm(exit)}` : `${minToHhmm(entry)}→${minToHhmm(exit)}`} ${mode}${defLabel(d)}`;

/** The call and put of one entry session (cached per timing and fill). */
type PairSource = (E: string) => PairDay;

/** A variant over every regular entry session with a signal; W1 and M1 hold one position at a time. */
function buildOptRun(w: World, f: OptFamily, s: SignalId, sign: Sign, mode: Mode | EodMode, def: SignalDef, entry: number, exit: number, src: PairSource, inRange: (E: string) => boolean, smoke: boolean, kind: OptRun["kind"] = "strategy", base?: string, label?: string): OptRun {
  const bs = buckets(w, s, def, smoke);
  const name = optName(f, s, sign, mode, def, entry, exit) + (label && !defLabel(def) ? ` [${label}]` : "");
  const r: OptRun = { name, family: f, signal: s, sign, mode, def, entry, exit, kind, base, label, slots: [], trades: [], pairs: [], skips: {} };
  const sg = sign === "follow" ? 1 : -1;
  let busyUntil = "";
  for (const E of w.reg) {
    if (!inRange(E)) continue;
    if (f !== "D1" && E <= busyUntil) continue; // one position at a time for the multi-session holds
    const sig = signalAt(w, E, bs);
    if ("skip" in sig) {
      if (sig.skip !== "no rank yet") bump(r.skips, sig.skip);
      continue;
    }
    const pd = src(E);
    if (pd.skip || !pd.ce || !pd.pe) {
      bump(r.skips, pd.skip ?? "?");
      continue;
    }
    r.slots.push(E);
    if (sig.b === 0) continue;
    const t = { ...(sg * sig.b > 0 ? pd.ce : pd.pe), T: sig.T };
    r.trades.push(t);
    r.pairs.push({ day: E, ce: pd.ce.net, pe: pd.pe.net });
    if (f !== "D1") busyUntil = pd.exitDay;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Published rules (report §1.8) and replications (§1.9): descriptive
// ---------------------------------------------------------------------------

interface Desc {
  name: string;
  n: number;
  /** Independent episodes (runs of consecutive signal days, or the count of non-overlapping events). */
  episodes: number;
  mean: number;
  lo: number;
  hi: number;
  up: number;
  upLo: number;
  upHi: number;
  extra?: string;
  rows?: string[];
}

/** Mean with a block-bootstrap CI (block = the holding period, ≥ 1) and the share up with its Wilson interval. */
function describe(name: string, xs: readonly number[], block: number, episodes: number, extra?: string, rows?: string[]): Desc {
  const n = xs.length;
  const boot = n ? blockBootstrap(xs, xs.map(() => true), { block: Math.max(1, block), resamples: BOOT_SUB, seed: SEED }) : null;
  const up = xs.filter((v) => v > 0).length;
  const wl = wilson(up, n);
  return { name, n, episodes, mean: avg(xs), lo: boot ? boot.perTrade.lo : NaN, hi: boot ? boot.perTrade.hi : NaN, up: n ? up / n : NaN, upLo: wl.lo, upHi: wl.hi, extra, rows };
}

/** NIFTY from the open of the regular session after `day` to the close `hold` sessions later (entry session included). */
function fwd(w: World, day: string, hold: number): { E: string; X: string; r: number } | null {
  const E = regAfter(w, day);
  const X = E ? regFrom(w, E, hold - 1) : null;
  const a = E ? w.yahoo.get(E) : null;
  const b = X ? w.yahoo.get(X) : null;
  return E && X && a && b ? { E, X, r: b.c / a.o - 1 } : null;
}

/** The latest session before `day` with a complete Yahoo bar. */
function prevBar(w: World, day: string): string | null {
  for (let i = (w.calIx.get(day) ?? w.cal.findIndex((d) => d >= day)) - 1; i >= 0; i--) if (w.yahoo.get(w.cal[i])) return w.cal[i];
  return null;
}

function closeToClose(w: World, from: string | null, to: string | null): number | null {
  const a = from ? w.yahoo.get(from) : null;
  const b = to ? w.yahoo.get(to) : null;
  return a && b ? b.c / a.c - 1 : null;
}

/** Consecutive-session runs of a per-file condition (a missing file ends a run). */
function sessionRuns(w: World, flag: (d: OiDay) => boolean): { start: number; end: number; length: number }[] {
  const days = w.oi.days;
  const out: { start: number; end: number; length: number }[] = [];
  let start = -1;
  for (let i = 0; i < days.length; i++) {
    const contiguous = i > 0 && w.fileIx.get(days[i].day)! - w.fileIx.get(days[i - 1].day)! === 1;
    if (start >= 0 && (!flag(days[i]) || !contiguous)) {
      out.push({ start, end: i - 1, length: i - start });
      start = -1;
    }
    if (start < 0 && flag(days[i])) start = i;
  }
  if (start >= 0) out.push({ start, end: days.length - 1, length: days.length - start });
  return out;
}

function publishedRules(w: World, data: ResearchData): { rows: Desc[]; hdfc: (string | number)[][] } {
  const rows: Desc[] = [];
  const days = w.oi.days;
  // P1 (HDFC Securities, BS 7 Aug 2025): FII L/S < 0.15 at the start of a monthly series → NIFTY higher by the series' end.
  const monthly = [...new Set(data.book.dates("NIFTY").flatMap((d) => data.book.futures("NIFTY", d).map((r) => r.expiry)))].sort();
  const lastBar = [...w.yahoo.entries()].filter(([, b]) => b).map(([d]) => d).sort().at(-1)!;
  const hdfc: (string | number)[][] = [["series start (monthly expiry)", "FII L/S", "next monthly expiry", "E open → series-end close", "expiry close → series-end close", "claimed by HDFC"]];
  const tr: number[] = [];
  const pub: number[] = [];
  const after: number[] = [];
  for (let i = 0; i + 1 < monthly.length; i++) {
    const M = monthly[i];
    const next = monthly[i + 1];
    const oi = w.oiIx.get(M);
    if (oi === undefined || next > lastBar) continue;
    const d = days[oi];
    const ls = d.fii.futIdxShort > 0 ? d.fii.futIdxLong / d.fii.futIdxShort : Infinity;
    if (!(ls < HDFC_LS)) continue;
    const E = regAfter(w, M);
    const a = E ? w.yahoo.get(E) : null;
    const b = w.yahoo.get(next);
    const r = a && b ? b.c / a.o - 1 : null;
    const r2 = closeToClose(w, M, next);
    if (r !== null) tr.push(r);
    if (r2 !== null) pub.push(r2);
    if (r !== null && M > HDFC_PUBLISHED) after.push(r);
    hdfc.push([M, fx(ls, 3), next, pp(r ?? NaN), pp(r2 ?? NaN), HDFC_EPISODES.includes(M) ? "yes" : "–"]);
  }
  const claimed = HDFC_EPISODES.map((e) => `${e}: ${monthly.includes(e) ? (w.oiIx.has(e) ? `L/S ${fx(days[w.oiIx.get(e)!].fii.futIdxLong / days[w.oiIx.get(e)!].fii.futIdxShort, 3)}` : "no file") : "not a monthly expiry in the cache"}`).join("; ");
  rows.push(describe("P1 HDFC: FII L/S < 0.15 on a monthly expiry → E open to the next monthly expiry's close", tr, 1, tr.length, `claimed episodes: ${claimed}`));
  rows.push(describe("P1 HDFC, as published: that expiry's close → the next expiry's close", pub, 1, pub.length));
  rows.push(describe(`P1 HDFC, after its publication (${HDFC_PUBLISHED}): E open → series end`, after, 1, after.length));
  // P2 (Marketcalls, R5 H5): flip from net short to net long, confirmed for 3 sessions → the next 30 sessions.
  const netLong = (d: OiDay) => d.fii.futIdxLong > d.fii.futIdxShort;
  const longRuns = sessionRuns(w, netLong);
  const flips: number[] = [];
  const flipRows: string[] = [];
  for (const z of longRuns) {
    if (z.length < FLIP_CONFIRM || z.start === 0) continue;
    const before = days[z.start - 1];
    if (netLong(before) || w.fileIx.get(days[z.start].day)! - w.fileIx.get(before.day)! !== 1) continue;
    const C = days[z.start + FLIP_CONFIRM - 1].day;
    const f = fwd(w, C, FLIP_HOLD);
    if (!f) continue;
    flips.push(f.r);
    flipRows.push(`${days[z.start].day} (confirmed ${C}) → ${pp(f.r)}`);
  }
  rows.push(describe(`P2 Marketcalls: flip to FII net long confirmed for ${FLIP_CONFIRM} sessions → next ${FLIP_HOLD} sessions (E open → close)`, flips, 1, flips.length, undefined, flipRows));
  // P3 (R5 H3): 5-session mean of FII long % in the bottom decile of its trailing 250 → long NIFTY for 20 / 30 sessions (contrarian).
  const L = w.raw.S1;
  const L5 = L.map((_, i) => {
    if (i < DECILE_MEAN - 1) return null;
    const xs = L.slice(i - DECILE_MEAN + 1, i + 1);
    return xs.every((v) => v !== null) ? avg(xs as number[]) : null;
  });
  const r5 = trailingRank(L5, BASE.window);
  for (const hold of DECILE_HOLDS) {
    const xs: number[] = [];
    const all: number[] = [];
    let episodes = 0;
    let prevSig = false;
    for (const E of w.reg) {
      const T = prevSession(w, E);
      const i = T ? w.oiIx.get(T) : undefined;
      if (i === undefined || r5[i] === null) {
        prevSig = false;
        continue;
      }
      const X = regFrom(w, E, hold - 1);
      const a = w.yahoo.get(E);
      const b = X ? w.yahoo.get(X) : null;
      if (!a || !b) continue;
      const r = b.c / a.o - 1;
      all.push(r);
      const sig = r5[i]! < DECILE;
      if (sig) {
        xs.push(r);
        if (!prevSig) episodes++;
      }
      prevSig = sig;
    }
    rows.push(describe(`P3 bottom decile of the ${DECILE_MEAN}-session mean of FII long % (trailing 250) → long, E open → E+${hold - 1} close`, xs, 2 * hold, episodes, `all entry days: ${all.length}, mean ${pp(avg(all))}, up ${pct(all.filter((v) => v > 0).length / Math.max(1, all.length))}`));
  }
  return { rows, hdfc };
}

function replications(w: World, fpi: { report: string; net: number }[], nseFii: { day: string; net: number }[]): { rows: Desc[]; streaks: (string | number)[][]; notes: string[] } {
  const rows: Desc[] = [];
  const notes: string[] = [];
  const days = w.oi.days;
  const netShort = (d: OiDay) => d.fii.futIdxLong < d.fii.futIdxShort;
  // (a) Next-session NIFTY return after FII net-short vs net-long readings, annualised, by window.
  const windows: [string, string, string][] = [
    [MC_FROM, MC_TO, "Sep 2016 – Sep 2026 (Marketcalls' window)"],
    ["2012-01-01", "2026-12-31", "all files"],
    ["2012-01-01", REGIME_SPLIT, "2012–2019"],
    [`${Number(REGIME_SPLIT.slice(0, 4)) + 1}-01-01`, "2026-12-31", "2020–2026"],
  ];
  for (const [from, to, label] of windows)
    for (const st of [true, false]) {
      const ccs: number[] = [];
      const ocs: number[] = [];
      // Entry-centric, as §1.2: each regular session E with the reading of the file before it.
      for (const E of w.reg) {
        const T = prevSession(w, E);
        const i = T ? w.oiIx.get(T) : undefined;
        if (!T || i === undefined || T < from || T > to || netShort(days[i]) !== st) continue;
        const b = w.yahoo.get(E);
        if (!b) continue;
        const c = closeToClose(w, prevBar(w, E), E);
        if (c !== null) ccs.push(c);
        ocs.push(b.c / b.o - 1);
      }
      const ann = (xs: number[]) => `${pp(avg(xs) * 252, 1)} a year arithmetic, ${pp(Math.exp((sum(xs.map((x) => Math.log1p(x))) * 252) / Math.max(1, xs.length)) - 1, 1)} compounded`;
      rows.push(describe(`(a) ${label}: FII net ${st ? "short" : "long"} on T → the previous close to E close`, ccs, 1, ccs.length, ann(ccs)));
      rows.push(describe(`(a) ${label}: FII net ${st ? "short" : "long"} on T → E open to close`, ocs, 1, ocs.length, ann(ocs)));
    }
  // (b) Net-short streaks of 20+ sessions: the move during the streak and what followed the flip.
  const streaks: (string | number)[][] = [["net-short streak", "sessions", "NIFTY during the streak (close before → last close)", "flip day", "flip → 20 sessions (E open → close)", "flip → 30 sessions"]];
  const during: number[] = [];
  const after20: number[] = [];
  const after30: number[] = [];
  for (const z of sessionRuns(w, netShort).filter((r) => r.length >= 20)) {
    const startDay = days[z.start].day;
    const endDay = days[z.end].day;
    const dur = closeToClose(w, prevBar(w, startDay), endDay);
    const flip = z.end + 1 < days.length && !netShort(days[z.end + 1]) ? days[z.end + 1].day : null;
    const f20 = flip ? fwd(w, flip, 20) : null;
    const f30 = flip ? fwd(w, flip, 30) : null;
    if (dur !== null) during.push(dur);
    if (f20) after20.push(f20.r);
    if (f30) after30.push(f30.r);
    streaks.push([`${startDay} … ${endDay}`, z.length, pp(dur ?? NaN), flip ?? (z.end + 1 < days.length ? "a missing file ended the run" : "still short"), pp(f20?.r ?? NaN), pp(f30?.r ?? NaN)]);
  }
  rows.push(describe("(b) NIFTY during each FII net-short streak of ≥ 20 sessions", during, 1, during.length));
  rows.push(describe("(b) after such a streak's flip to net long: E open → 20 sessions", after20, 1, after20.length));
  rows.push(describe("(b) after such a streak's flip to net long: E open → 30 sessions", after30, 1, after30.length));
  // (c) Every flip from net short to net long: NIFTY over the next 30 sessions ("> 90% up").
  for (const minRun of [1, 20]) {
    const xs: number[] = [];
    const cs: number[] = [];
    for (const z of sessionRuns(w, netShort).filter((r) => r.length >= minRun)) {
      if (z.end + 1 >= days.length || netShort(days[z.end + 1])) continue;
      const flip = days[z.end + 1].day;
      const f = fwd(w, flip, 30);
      if (!f) continue;
      xs.push(f.r);
      const c = closeToClose(w, flip, f.X);
      if (c !== null) cs.push(c);
    }
    rows.push(describe(`(c) flip to FII net long after ≥ ${minRun} net-short session${minRun > 1 ? "s" : ""}: E open → 30 sessions`, xs, 1, xs.length));
    rows.push(describe(`(c) the same flips: flip day's close → 30 sessions later`, cs, 1, cs.length));
  }
  // The owner's example: FII cash net selling worse than −₹10,000 crore (NSDL, assigned to the session before its report date).
  const owner: number[] = [];
  const ownerDays: string[] = [];
  for (const f of fpi) {
    if (f.net >= OWNER_THRESHOLD) continue;
    const i = w.cal.findIndex((d) => d >= f.report);
    const T = i > 0 ? w.cal[i - 1] : null;
    const r = T ? fwd(w, T, 1) : null;
    if (!T || !r) continue;
    owner.push(r.r);
    ownerDays.push(`${T} (${f.net.toLocaleString("en-IN")} cr) → ${r.E} ${pp(r.r)}`);
  }
  const od = describe("Owner's example: FII cash net selling < −₹10,000 crore on T → E open to close", owner, 1, owner.length);
  rows.push(od);
  notes.push(`Owner's example, day by day: ${ownerDays.join("; ") || "none"}. Next day down (a put buyer's direction): ${owner.filter((v) => v < 0).length} of ${owner.length} (${pct(owner.filter((v) => v < 0).length / Math.max(1, owner.length))}, Wilson ${pct(wilson(owner.filter((v) => v < 0).length, owner.length).lo)} … ${pct(wilson(owner.filter((v) => v < 0).length, owner.length).hi)}).`);
  // The NSE provisional figures (a short window only), listed beside it.
  if (nseFii.length) {
    const lines = nseFii
      .filter((f) => f.net < OWNER_THRESHOLD)
      .map((f) => {
        const r = fwd(w, f.day, 1);
        return `${f.day} (${f.net.toLocaleString("en-IN")} cr, NSE provisional) → ${r ? `${r.E} ${pp(r.r)}` : "no index bar for the next session"}`;
      });
    notes.push(`NSE provisional series (${nseFii[0].day} … ${nseFii.at(-1)!.day}, ${nseFii.length} sessions): ${lines.join("; ") || "no day below −₹10,000 crore"}.`);
  }
  return { rows, streaks, notes };
}

/** NSE's provisional FII/DII figures (Moneycontrol's trailing window): day → FII net ₹ crore. */
function loadNseFii(path: string | undefined): { day: string; net: number }[] {
  if (!path || !existsSync(path)) return [];
  const rows = JSON.parse(readFileSync(path, "utf8")) as { date: string; fiiNet: string }[];
  return rows.map((r) => ({ day: r.date, net: Number(String(r.fiiNet).replace(/,/g, "")) })).filter((r) => Number.isFinite(r.net)).sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");
const DATA_OI = "NSE participant-wise OI (archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv, 2012-01..2026-10) + Yahoo ^NSEI daily";
const DATA_1M =
  "NSE participant-wise OI files + TradeMarkk 1-minute NIFTY options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract, NIFTY 2021-05..2026-07; lots and expiries from the bhavcopy cache";
const DATA_EOD = "NSE participant-wise OI files + NSE F&O bhavcopy closing prices (WP6 compact cache, 2019-02..2026-10)";

function dirTrial(r: DirRun, s: DirStats): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: r.name,
    params: { family: "index direction", signal: r.signal, signalLabel: SIGNAL_LABEL[r.signal], horizon: r.horizon, sign: r.sign, window: r.def.window, buckets: r.def.q, entry: "E (the regular session after T) official open", exit: `E+${HOLD[r.horizon] - 1} official close`, unit: "index basis points, not rupees", ...(r.label ? { perturbation: r.label } : {}) },
    data: DATA_OI,
    trades: s.full.n,
    net: Math.round(sum(s.full.rets) * 1e4 * 100) / 100,
    notes: `index direction ${r.kind}; net and mean in index basis points (not ₹); per trade ${bp(s.full.mean, 2)} (block-${BLOCK[r.horizon]} 95% CI ${bp(s.full.boot.perTrade.lo, 2)}..${bp(s.full.boot.perTrade.hi, 2)}), hit ${pct(s.full.hit)} vs base ${pct(s.full.base)}, PF ${fx(s.full.pf)}; first 60% ${bp(s.is.mean, 2)} (${s.is.n}), last 40% ${bp(s.oos.mean, 2)} (${s.oos.n})`,
    kind: r.kind,
    account: "main",
    sessions: s.full.sessions,
    meanPerTrade: Math.round(s.full.mean * 1e4 * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

function optTrial(r: OptRun, s: OptStats): TrialRecord {
  const fill = r.family === "M1" ? (r.mode === "close" ? "bhavcopy closing prices, no spread" : "bhavcopy closing prices with the engine spread (max(1 tick, 0.4%))") : r.mode === "conservative" ? "conservative (buy at the 1-min high, sell at the low)" : "mid (the 1-min close)";
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: r.name,
    params: { family: `option ${r.family}`, signal: r.signal, signalLabel: SIGNAL_LABEL[r.signal], sign: r.sign, window: r.def.window, buckets: r.def.q, structure: "long ATM call (bullish) or put (bearish), one lot", entry: r.family === "M1" ? "E close" : `E ${minToHhmm(r.entry)}`, exit: r.family === "D1" ? `E ${minToHhmm(r.exit)}` : r.family === "W1" ? `E+4 ${minToHhmm(r.exit)}` : "E+19 close", minDte: MIN_DTE[r.family], fill: r.mode, index: "NIFTY", ...(r.label ? { perturbation: r.label } : {}) },
    data: r.family === "M1" ? DATA_EOD : DATA_1M,
    trades: s.full.n,
    net: Math.round(s.full.net * 100) / 100,
    notes: `option ${r.family} ${r.kind}; ${fill}; ₹/lot per trade ${fx(s.full.mean)} (day-block 95% CI ${fx(s.full.lo)}..${fx(s.full.hi)}), PF ${fx(s.full.pf)}; first 60% ${fx(s.is.mean)} (${s.is.n}), last 40% ${fx(s.oos.mean)} (${s.oos.n}); placebo gap ${fx(s.full.gap.gap)} (${fx(s.full.gap.t)} SE); one lot at the lot in force; dated charges${r.family === "D1" ? "" : "; one position at a time (descriptive)"}`,
    kind: r.kind,
    account: "main",
    sessions: s.full.sessions,
    meanPerTrade: Math.round(s.full.mean * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

function descTrial(d: Desc, family: string): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: `NIFTY ${family}: ${d.name}`,
    params: { family, unit: "index return, basis points summed (not rupees)" },
    data: d.name.startsWith("Owner") ? "NSDL FPI daily (custodian-confirmed, stock-exchange route) + Yahoo ^NSEI daily" : family === "published rule" && d.name.startsWith("P1") ? `${DATA_OI}; monthly expiries from the bhavcopy cache` : DATA_OI,
    trades: d.n,
    net: Number.isFinite(d.mean) ? Math.round(d.mean * d.n * 1e4 * 100) / 100 : 0,
    notes: `descriptive ${family}; mean ${bp(d.mean, 2)} (95% CI ${bp(d.lo, 2)}..${bp(d.hi, 2)}), up ${pct(d.up)} (Wilson ${pct(d.upLo)}..${pct(d.upHi)}), n ${d.n}, episodes ${d.episodes}${d.extra ? `; ${d.extra}` : ""}`,
    kind: "strategy",
    account: "main",
    meanPerTrade: Number.isFinite(d.mean) ? Math.round(d.mean * 1e4 * 100) / 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

interface Inputs {
  oiDir: string;
  fetchLog: string;
  daily: string;
  x: string;
  dir: string;
  fpi: string;
  /** Optional: NSE provisional FII/DII figures (Moneycontrol window), listed beside the owner's example. */
  nseFii?: string;
  outDir: string;
}

function inputs(args: ReturnType<typeof parseArgs>): Inputs {
  return {
    oiDir: str(args, "oi") ?? fail("--oi <participant OI dir> is required"),
    fetchLog: str(args, "fetchlog") ?? fail("--fetchlog <fetch log jsonl> is required"),
    daily: str(args, "daily") ?? fail("--daily <Yahoo ^NSEI daily json> is required"),
    x: str(args, "x") ?? fail("--x <WP13 extract dir> is required"),
    dir: str(args, "dir") ?? fail("--dir <bhavcopy cache> is required"),
    fpi: str(args, "fpi") ?? fail("--fpi <NSDL FPI csv> is required"),
    nseFii: str(args, "nsefii"),
    outDir: resolve(ROOT, str(args, "out", "reports/wp14")!),
  };
}

const loadData = (I: Inputs) => loadResearchData({ from: "2019-02-01", to: "2026-10-09", dir: I.dir });

/** Index cut (report §1.6): the last entry session of the first 60% of the base variant's D1 signal days. */
function indexCut(w: World, s: SignalId, smoke: boolean): string | null {
  const { obs } = indexObs(w, s, BASE, "D1", smoke, false);
  return cutDate(obs.filter((o) => o.b !== 0).map((o) => o.entry), IS_FRAC);
}

const istOf = (lastModified: string | null): { day: string; min: number } | null => {
  if (!lastModified) return null;
  const t = Date.parse(lastModified);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 330 * 60_000);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

// ---------------------------------------------------------------------------
// coverage: data, samples and cut dates (no returns, no P&L)
// ---------------------------------------------------------------------------

async function coverage(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const data = await loadData(I);
  const w = buildWorld(I, data);
  const out: string[] = ["# WP14 coverage (generated; files, bars and signal readings only: no returns, no P&L)\n"];
  const summary: Record<string, unknown> = {};

  // 1. The participant OI files.
  const files = w.oi.files;
  const first = files[0]?.day;
  const last = files.at(-1)?.day;
  const fetched = [...w.fetch.values()];
  const notFound = fetched.filter((r) => r.status === 404).map((r) => r.date).sort();
  const failed = fetched.filter((r) => r.status !== 200 && r.status !== 404);
  const fileSet = new Set(files.map((f) => f.day));
  // Trading days without a file: a session (Yahoo bar or bhavcopy) between the first and last file, no file.
  const missing = w.cal.filter((d) => first && last && d >= first && d <= last && !fileSet.has(d));
  const byYear = new Map<string, { files: number; usable: number; warn: number }>();
  for (const f of files) {
    const y = byYear.get(f.day.slice(0, 4)) ?? { files: 0, usable: 0, warn: 0 };
    y.files++;
    if (f.problems.length === 0) y.usable++;
    if (f.warnings.length) y.warn++;
    byYear.set(f.day.slice(0, 4), y);
  }
  const variants = new Map<string, { first: string; last: string; n: number }>();
  for (const f of files) {
    const k = `${f.firstHeader} | ${f.order}`;
    const v = variants.get(k) ?? { first: f.day, last: f.day, n: 0 };
    v.last = f.day;
    v.n++;
    variants.set(k, v);
  }
  const problems = files.filter((f) => f.problems.length);
  const warned = files.filter((f) => f.warnings.length);
  const pub = files.map((f) => ({ day: f.day, ist: istOf(w.fetch.get(f.day)?.lastModified ?? null) })).filter((p) => p.ist);
  const sameDay = pub.filter((p) => p.ist!.day === p.day);
  const minutes = sameDay.map((p) => p.ist!.min);
  const later = pub.filter((p) => p.ist!.day > p.day);
  // Usable before the next regular session's 09:15 (the entry this file feeds)?
  const ready = pub.filter((p) => {
    const E = regAfter(w, p.day);
    return E !== null && (p.ist!.day < E || (p.ist!.day === E && p.ist!.min < OPEN_MIN));
  });
  const yr: (string | number)[][] = [["year", "files", "usable", "rounding or title warnings", "sessions without a file"]];
  for (const [y, v] of [...byYear].sort()) yr.push([y, v.files, v.usable, v.warn, missing.filter((d) => d.startsWith(y)).length]);
  const specials = w.cal.filter((d) => w.special.has(d) && first && d >= first);
  // The Muhurat list against the data: a file that day, and the day's high–low range against the median of the 20 sessions around it.
  const rangeOf = (d: string) => {
    const b = w.yahoo.get(d);
    return b ? b.h / b.l - 1 : NaN;
  };
  const muhuratRows: (string | number)[][] = [["Muhurat date", "weekday", "participant file", "Yahoo bar", "high/low − 1", "median of the 20 sessions around it", "short by the bhavcopy's volume"]];
  for (const d of MUHURAT) {
    const i = w.calIx.get(d);
    const around = i === undefined ? [] : [...w.cal.slice(Math.max(0, i - 10), i), ...w.cal.slice(i + 1, i + 11)].map(rangeOf).filter(Number.isFinite);
    muhuratRows.push([d, ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekdayOf(d)], fileSet.has(d) ? "yes" : "no", w.yahoo.get(d) ? "yes" : w.yahoo.has(d) ? "row with a missing field" : "no", pct(rangeOf(d), 2), pct(median(around), 2), data.special.has(d) ? "yes" : d < data.book.dates("NIFTY")[0] ? "before the cache" : "no"]);
  }
  out.push(
    `## 1. Participant-wise OI files\n\n- Requests logged: ${fetched.length} dates (every weekday from 26 Dec 2011 to 9 Oct 2026, plus known weekend sessions); 200: ${fetched.filter((r) => r.status === 200).length}; 404: ${notFound.length}; other: ${failed.length}${failed.length ? ` (${failed.map((r) => `${r.date} ${r.status}`).join(", ")})` : ""}.\n- Files: ${files.length}, ${first} … ${last}; usable ${w.oi.days.length}; excluded ${problems.length}${problems.length ? `: ${problems.map((f) => `${f.day} (${f.problems.join("; ")})`).join("; ")}` : ""}.\n- Rounding or title warnings (a column's categories miss TOTAL by ≤ 0.01% or ≤ 10 contracts; a title without its year): ${warned.length} files (${[...new Set(warned.flatMap((f) => f.warnings.map((x) => x.replace(/[0-9]+/g, "#"))))].slice(0, 6).join("; ")}).\n- Sessions (a Yahoo bar or a bhavcopy) without a file: ${missing.length}${missing.length ? `: ${missing.slice(0, 80).join(", ")}${missing.length > 80 ? ", …" : ""}` : ""}.\n- Special sessions (weekend, Muhurat, or short by the bhavcopy's volume): ${specials.length}: ${specials.map((d) => `${d}${fileSet.has(d) ? "" : " (no file)"}`).join(", ")}.\n\n${md(yr)}\n\n**The Muhurat list against the data:**\n\n${md(muhuratRows)}\n\n**Layouts** (first header cell | row order):\n\n${md([["files", "from", "to", "layout"], ...[...variants].map(([k, v]) => [v.n, v.first, v.last, k])])}\n\n**Publication time** (the archive's Last-Modified header, IST): ${pub.length} files carry one; ${sameDay.length} were last modified on their own date, at a median ${minToHhmm(Math.round(median(minutes)))} (10th–90th percentile ${minToHhmm(Math.round(quantile(minutes, 0.1)))}–${minToHhmm(Math.round(quantile(minutes, 0.9)))}, earliest ${minToHhmm(Math.min(...minutes))}, latest ${minToHhmm(Math.max(...minutes))}); ${later.length} were last modified on a later date${later.length ? ` (${later.slice(0, 10).map((p) => `${p.day} → ${p.ist!.day}`).join(", ")}${later.length > 10 ? ", …" : ""})` : ""}; ${ready.length} of ${pub.length} carry a time before 09:15 IST of the session they feed.\n`,
  );
  summary.files = { n: files.length, first, last, usable: w.oi.days.length, notFound: notFound.length, missing, specials, problems: problems.map((f) => ({ day: f.day, problems: f.problems })), publication: { n: pub.length, sameDay: sameDay.length, median: median(minutes), later: later.map((p) => [p.day, p.ist!.day]), ready: ready.length } };

  // 2. The NIFTY daily series.
  const ys = [...w.yahoo.entries()].filter(([d]) => d >= "2011-12-01").sort(([a], [b]) => a.localeCompare(b));
  const yNull = ys.filter(([, b]) => !b).map(([d]) => d);
  const staleDays: string[] = [];
  let prevC: number | null = null;
  for (const [d, b] of ys) {
    if (!b) continue;
    if (prevC !== null && Math.abs(b.o - prevC) < 1e-9) staleDays.push(d);
    prevC = b.c;
  }
  const regNoBar = w.reg.filter((d) => first && d >= first && d <= "2026-10-08" && !w.yahoo.get(d));
  const cachePath = resolve(I.dir, "index-daily.json");
  const cache = existsSync(cachePath) ? ((JSON.parse(readFileSync(cachePath, "utf8")) as { series: Record<string, { t: number; o: number; c: number }[]> }).series["^NSEI"] ?? []) : [];
  let cmp = 0;
  let cmpDiff = 0;
  for (const cb of cache) {
    const day = new Date(cb.t + 330 * 60_000).toISOString().slice(0, 10);
    const b = w.yahoo.get(day);
    if (!b) continue;
    cmp++;
    if (Math.abs(b.o - cb.o) > 0.5 || Math.abs(b.c - cb.c) > 0.5) cmpDiff++;
  }
  const man = loadManifest(I.x).NIFTY;
  const index1m = loadIndex(I.x, "NIFTY");
  const openDiffs: number[] = [];
  const closeDiffs: number[] = [];
  for (const day of man.sessions) {
    const b = w.yahoo.get(day);
    const bars = (index1m.get(day) ?? []).filter((z) => z.m >= OPEN_MIN && z.m < CLOSE_MIN);
    if (!b || bars[0]?.m !== OPEN_MIN) continue;
    openDiffs.push(Math.abs(bars[0].o / b.o - 1));
    closeDiffs.push(Math.abs(bars.at(-1)!.c / b.c - 1));
  }
  out.push(
    `\n## 2. NIFTY daily index (Yahoo ^NSEI, daily since 2007)\n\n- Rows from Dec 2011: ${ys.length} (to ${ys.at(-1)?.[0]}); rows with a missing field: ${yNull.length} (${yNull.join(", ")}).\n- Regular sessions from the first file to 8 Oct 2026 without a complete Yahoo bar: ${regNoBar.length}${regNoBar.length ? ` (${regNoBar.join(", ")})` : ""}: a trade entering or exiting on one is skipped.\n- Opens equal to the previous close (stale): ${staleDays.length}${staleDays.length ? ` (${staleDays.join(", ")})` : ""}.\n- Against the bhavcopy cache's own Yahoo download (Oct 2016 – Oct 2026): ${cmp} common days, ${cmpDiff} differ by more than 0.5 point in the open or close.\n- Against the 1-minute index bars (TradeMarkk, ${man.sessions[0]} … ${man.sessions.at(-1)}): ${openDiffs.length} days; |Yahoo open ÷ the 09:15 bar's open − 1| median ${(median(openDiffs) * 1e4).toFixed(2)} bp, 99th percentile ${(quantile(openDiffs, 0.99) * 1e4).toFixed(1)} bp, max ${(Math.max(...openDiffs) * 1e4).toFixed(1)} bp; |Yahoo close ÷ the last 1-minute close − 1| median ${(median(closeDiffs) * 1e4).toFixed(2)} bp (the official close is the closing price of the constituents, not the last index print).\n`,
  );
  summary.index = { rows: ys.length, nulls: yNull, regNoBar, staleOpens: staleDays, cacheCompared: cmp, cacheDiffer: cmpDiff, openDiffMedianBp: median(openDiffs) * 1e4, openDiffP99Bp: quantile(openDiffs, 0.99) * 1e4 };

  // 3. Signals: readings, buckets and the cut dates (no returns).
  const sigRows: (string | number)[][] = [["signal", "readings", "ranked (trailing 250)", "first ranked", "bottom / middle / top tercile", "D1 signal days with an index bar (cut after)", "first 60% / last 40% D1 signal days", "W1 / M1 last-40% signal days (÷ 5 / ÷ 20)"]];
  const cuts: Record<string, Record<string, string | null>> = {};
  for (const s of SIGNALS) {
    const r = ranks(w, s, BASE.window);
    const b = buckets(w, s, BASE, false);
    const firstRanked = w.oi.days[r.findIndex((v) => v !== null)]?.day ?? "–";
    const cut = indexCut(w, s, false);
    const d1 = indexObs(w, s, BASE, "D1", false, false).obs.filter((o) => o.b !== 0);
    const w1 = indexObs(w, s, BASE, "W1", false, false).obs.filter((o) => o.b !== 0 && o.entry > (cut ?? ""));
    const m1 = indexObs(w, s, BASE, "M1", false, false).obs.filter((o) => o.b !== 0 && o.entry > (cut ?? ""));
    const isN = d1.filter((o) => o.entry <= (cut ?? "")).length;
    sigRows.push([`${s} ${SIGNAL_LABEL[s]}`, w.raw[s].filter((v) => v !== null).length, r.filter((v) => v !== null).length, firstRanked, `${b.filter((v) => v === -1).length} / ${b.filter((v) => v === 0).length} / ${b.filter((v) => v === 1).length}`, `${d1.length} (${cut})`, `${isN} / ${d1.length - isN}`, `${w1.length} (${fx(w1.length / 5, 0)}) / ${m1.length} (${fx(m1.length / 20, 0)})`]);
    cuts[s] = { index: cut };
  }
  out.push(`\n## 3. Signals and the index samples\n\n${md(sigRows)}\n`);
  const regimeRows: (string | number)[][] = [["period", "files", "FII long share L: median (10th–90th pct)", "Client long share: median", "L − L(Client): median", "S4 options net direction: median", "FII net short in index futures (share of days)"]];
  for (const [from, to, label] of [
    ["2012-01-01", "2016-12-31", "2012–2016"],
    ["2017-01-01", REGIME_SPLIT, "2017–2019"],
    ["2020-01-01", "2022-12-31", "2020–2022"],
    ["2023-01-01", "2024-12-31", "2023–2024"],
    ["2025-01-01", "2026-12-31", "2025–2026"],
  ] as const) {
    const ix = w.oi.days.map((d, i) => [d, i] as const).filter(([d]) => d.day >= from && d.day <= to).map(([, i]) => i);
    const val = (s: SignalId) => ix.map((i) => w.raw[s][i]).filter((v): v is number => v !== null);
    const lc = ix.map((i) => longShare(w.oi.days[i].client.futIdxLong, w.oi.days[i].client.futIdxShort)).filter((v): v is number => v !== null);
    regimeRows.push([label, ix.length, `${pct(median(val("S1")))} (${pct(quantile(val("S1"), 0.1))}–${pct(quantile(val("S1"), 0.9))})`, pct(median(lc)), fx(median(val("S3")), 3), fx(median(val("S4")), 3), pct(ix.filter((i) => w.oi.days[i].fii.futIdxLong < w.oi.days[i].fii.futIdxShort).length / Math.max(1, ix.length))]);
  }
  out.push(`\n**Positioning by period** (levels only; the regime inversion of R5 §3.3):\n\n${md(regimeRows)}\n`);
  const lastRows: (string | number)[][] = [["day", "FII index futures long / short", "L (FII)", "L (Client)", ...SIGNALS.map((s) => `${s} rank (bucket)`)]];
  for (const d of w.oi.days.slice(-5)) {
    const i = w.oiIx.get(d.day)!;
    lastRows.push([d.day, `${d.fii.futIdxLong.toLocaleString("en-IN")} / ${d.fii.futIdxShort.toLocaleString("en-IN")}`, pct(w.raw.S1[i] ?? NaN), pct(longShare(d.client.futIdxLong, d.client.futIdxShort) ?? NaN), ...SIGNALS.map((s) => {
      const rk = ranks(w, s, BASE.window)[i];
      return rk === null ? "–" : `${pct(rk, 0)} (${extremeBucket(rk, BASE.q)})`;
    })]);
  }
  out.push(`\n**Latest readings** (rank within the trailing 250; bucket −1 bottom, +1 top):\n\n${md(lastRows)}\n`);
  const shortRuns = sessionRuns(w, (d) => d.fii.futIdxLong < d.fii.futIdxShort);
  const streaks = shortRuns.filter((z) => z.length >= 20);
  const flips = sessionRuns(w, (d) => d.fii.futIdxLong > d.fii.futIdxShort).filter((z) => z.start > 0 && w.oi.days[z.start - 1].fii.futIdxLong < w.oi.days[z.start - 1].fii.futIdxShort && w.fileIx.get(w.oi.days[z.start].day)! - w.fileIx.get(w.oi.days[z.start - 1].day)! === 1);
  out.push(`\n**FII net short in index futures** (Marketcalls' framing): ${w.oi.days.filter((d) => d.fii.futIdxLong < d.fii.futIdxShort).length} of ${w.oi.days.length} usable days; runs of ≥ 20 consecutive sessions: ${streaks.length} (${streaks.map((z) => `${w.oi.days[z.start].day} … ${w.oi.days[z.end].day} (${z.length})`).join("; ")}); flips from net short to net long: ${flips.length}, of which confirmed for ${FLIP_CONFIRM} sessions: ${flips.filter((z) => z.length >= FLIP_CONFIRM).length}.\n`);

  // 4. The option samples (bar presence only, no prices).
  const c = optCtx(data, I.x);
  const optRows: (string | number)[][] = [["signal", "regular entry sessions in the 1-minute data with a signal", "of those: contract with ≥ 2 sessions in the dataset, lot, ATM call and put bars at 09:30 (2 min)", "exit bars at 15:20 (5 min), both legs", "D1 trade days (cut after): first 60% / last 40%", "last 40% to Dec 2024 / from 2025"]];
  const dteDist = new Map<number, number>();
  const inOpt = (E: string) => E >= man.sessions[0] && E <= man.sessions.at(-1)!;
  for (const s of SIGNALS) {
    const b = buckets(w, s, BASE, false);
    let inData = 0;
    let ok = 0;
    let exitOk = 0;
    const tradeDays: string[] = [];
    for (const E of w.reg) {
      if (!inOpt(E) || !c.daySet.has(E)) continue;
      const sig = signalAt(w, E, b);
      if ("skip" in sig) continue;
      inData++;
      const ex = expiryWithDte(data, E, MIN_DTE.D1);
      const chain = ex ? chainOf(c, E, ex.expiry) : null;
      if (!ex || !chain || lotOf(data, "NIFTY", E, ex.expiry) === null) continue;
      const level = idxOf(c, E).lastUpTo(ENTRY - 1)?.c;
      const k = level === undefined ? null : nearestListed(bothListed(chain), level);
      if (k === null) continue;
      const ce = chain.series.get(key(k, "CE"))!;
      const pe = chain.series.get(key(k, "PE"))!;
      if (!ce.firstFrom(ENTRY, ENTRY_WAIT) || !pe.firstFrom(ENTRY, ENTRY_WAIT)) continue;
      ok++;
      if (ce.firstFrom(EXIT, EXIT_WAIT) && pe.firstFrom(EXIT, EXIT_WAIT)) exitOk++;
      if (s === "S1") dteDist.set(ex.dte, (dteDist.get(ex.dte) ?? 0) + 1);
      if (sig.b !== 0) tradeDays.push(E);
    }
    const cut = cutDate(tradeDays, IS_FRAC);
    const oos = tradeDays.filter((d) => d > (cut ?? ""));
    optRows.push([s, inData, ok, exitOk, `${tradeDays.length} (${cut}): ${tradeDays.length - oos.length} / ${oos.length}`, `${oos.filter((d) => d <= ERA_END).length} / ${oos.filter((d) => d > ERA_END).length}`]);
    cuts[s].optionD1 = cut;
  }
  out.push(`\n## 4. The option samples (NIFTY, 1-minute bars; bar presence only)\n\n${md(optRows)}\n\nSessions to expiry of the D1 contract (S1's entry sessions): ${[...dteDist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(", ")}.\n`);
  // W1 and M1: how many one-at-a-time holds the data allows (every entry session, signal or not).
  let w1Possible = 0;
  let busy = "";
  for (const E of w.reg) {
    if (!inOpt(E) || E <= busy) continue;
    const X = regFrom(w, E, HOLD.W1 - 1);
    const ex = expiryWithDte(data, E, MIN_DTE.W1);
    if (X && ex && c.daySet.has(E) && c.daySet.has(X) && c.man.pairs[`${E}_${ex.expiry}`] && c.man.pairs[`${X}_${ex.expiry}`]) {
      w1Possible++;
      busy = X;
    }
  }
  const bookDays = data.book.dates("NIFTY");
  out.push(`\nW1 (1-minute): one position at a time, at most ${w1Possible} holds in the whole option sample even if every session were a signal, so at most about ${fx(w1Possible * 0.4, 0)} in a last 40%: fewer than ${MIN_OOS}, **descriptive only**. M1 (bhavcopy closing prices, ${bookDays[0]} … ${bookDays.at(-1)}): at most about ${fx(bookDays.length / HOLD.M1, 0)} non-overlapping 20-session holds in all: **descriptive only**.\n`);

  // 5. Published rules: the monthly expiries the HDFC rule reads (no returns).
  const monthly = [...new Set(bookDays.flatMap((d) => data.book.futures("NIFTY", d).map((r) => r.expiry)))].sort();
  const qual = monthly.filter((M) => {
    const i = w.oiIx.get(M);
    return i !== undefined && w.oi.days[i].fii.futIdxLong / Math.max(1, w.oi.days[i].fii.futIdxShort) < HDFC_LS;
  });
  out.push(`\n## 5. Published rules (R5) and the owner's example: event counts only\n\n- P1 HDFC: ${monthly.length} monthly NIFTY expiries in the bhavcopy cache (${monthly[0]} … ${monthly.at(-1)}); with a file and FII L/S < ${HDFC_LS}: ${qual.length} (${qual.join(", ")}). Claimed episodes ${HDFC_EPISODES.join(", ")}: ${HDFC_EPISODES.map((e) => (qual.includes(e) ? "qualifies" : monthly.includes(e) ? "does not qualify" : "not a monthly expiry")).join(", ")}.\n`);
  const fpi = loadFpi(I.fpi);
  const big = fpi.filter((f) => f.net < OWNER_THRESHOLD);
  out.push(`- Owner's example (NSDL, custodian-confirmed, stock-exchange route): ${fpi.length} report dates, ${fpi[0]?.report} … ${fpi.at(-1)?.report}; with net selling worse than −₹10,000 crore: ${big.length} (${big.map((f) => f.report).join(", ")}).\n`);
  summary.cuts = cuts;
  mkdirSync(I.outDir, { recursive: true });
  writeFileSync(resolve(I.outDir, "coverage.md"), out.join("\n"));
  writeFileSync(resolve(I.outDir, "coverage.json"), JSON.stringify(summary, null, 1));
  console.log(out.join("\n"));
  console.log(`Wrote ${resolve(I.outDir, "coverage.md")}`);
}

// ---------------------------------------------------------------------------
// run: every variant, the walk-forward picks, the bar, the ledger and the tables
// ---------------------------------------------------------------------------

async function runAll(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const smoke = args.smoke === true;
  const t0 = Date.now();
  const log = (s: string) => console.log(`${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const data = await loadData(I);
  log(`Loaded ${data.loaded.NSE.length} NSE bhavcopies`);
  const w = buildWorld(I, data);
  // --smoke: the calendar stays real, the index bars become flat (no real index return is computed).
  if (smoke) for (const [d, b] of w.yahoo) if (b) w.yahoo.set(d, { o: 1, h: 1, l: 1, c: 1 });
  log(`Participant files: ${w.oi.days.length} usable days, ${w.oi.days[0]?.day} … ${w.oi.days.at(-1)?.day}; ${w.reg.length} regular sessions`);

  // ---- 1. Direction tests on the index ----
  const dirRuns: DirRun[] = [];
  const cuts = new Map<SignalId, string>();
  for (const s of SIGNALS) {
    cuts.set(s, indexCut(w, s, smoke) ?? "9999-12-31");
    for (const h of HORIZONS) {
      const { obs, skips } = indexObs(w, s, BASE, h, smoke);
      for (const sign of SIGNS) dirRuns.push({ name: dirName(s, h, sign, BASE), signal: s, horizon: h, sign, def: BASE, kind: "strategy", obs, skips });
    }
  }
  const dStats = new Map<string, DirStats>(dirRuns.map((r) => [r.name, dirStats(r, cuts.get(r.signal)!)]));
  log(`Index direction: ${dirRuns.length} variants`);
  const dirPicks: DirRun[] = [];
  for (const s of SIGNALS)
    for (const h of HORIZONS) {
      const p = pickBest(dirRuns.filter((r) => r.signal === s && r.horizon === h), (r) => dStats.get(r.name)!.is.mean, (r) => r.name);
      if (p) dirPicks.push(p);
    }
  const dirPerts: DirRun[] = [];
  for (const p of dirPicks)
    if (dirCore(dStats.get(p.name)!))
      for (const { label, def } of DEF_PERTURBATIONS) {
        const { obs, skips } = indexObs(w, p.signal, def, p.horizon, smoke);
        dirPerts.push({ name: dirName(p.signal, p.horizon, p.sign, def), signal: p.signal, horizon: p.horizon, sign: p.sign, def, kind: "perturbation", base: p.name, label, obs, skips });
      }
  const dPertStats = new Map<string, DirStats>(dirPerts.map((r) => [r.name, dirStats(r, cuts.get(r.signal)!, true)]));

  // ---- 2. The option buyer (D1 on 1-minute bars; W1 and M1 descriptive) ----
  const c = optCtx(data, I.x);
  const man = c.man;
  const inOpt = (E: string) => E >= man.sessions[0] && E <= man.sessions.at(-1)!;
  const bookDays = data.book.dates("NIFTY");
  const inEod = (E: string) => E >= bookDays[0] && E <= bookDays.at(-1)!;
  const caches = new Map<string, Map<string, PairDay>>();
  const cached = (k: string, f: (E: string) => PairDay): PairSource => {
    let m = caches.get(k);
    if (!m) caches.set(k, (m = new Map()));
    const mm = m;
    return (E) => {
      let p = mm.get(E);
      if (!p) mm.set(E, (p = f(E)));
      return p;
    };
  };
  const d1Source = (entry: number, exit: number, mode: Mode) => cached(`D1|${entry}|${exit}|${mode}`, (E) => d1Pair(c, E, entry, exit, mode));
  const w1Source = (mode: Mode) => cached(`W1|${mode}`, (E) => w1Pair(w, c, E, mode));
  const m1Source = (mode: EodMode) => cached(`M1|${mode}`, (E) => m1Pair(w, data, E, mode));
  const optRuns: OptRun[] = [];
  for (const s of SIGNALS)
    for (const sign of SIGNS) {
      for (const mode of MODES) optRuns.push(buildOptRun(w, "D1", s, sign, mode, BASE, ENTRY, EXIT, d1Source(ENTRY, EXIT, mode), inOpt, smoke));
      for (const mode of MODES) optRuns.push(buildOptRun(w, "W1", s, sign, mode, BASE, ENTRY, EXIT, w1Source(mode), inOpt, smoke));
      for (const mode of EOD_MODES) optRuns.push(buildOptRun(w, "M1", s, sign, mode, BASE, CLOSE_MIN, CLOSE_MIN, m1Source(mode), inEod, smoke));
    }
  log(`Options: ${optRuns.length} variants`);
  // Cut per family and signal: the first 60% of the trade days (every sign and fill of a family trades the same days).
  const optCuts = new Map<string, string | null>();
  for (const f of ["D1", "W1", "M1"] as OptFamily[])
    for (const s of SIGNALS) {
      const r0 = optRuns.find((r) => r.family === f && r.signal === s && (r.mode === "conservative" || r.mode === "close"));
      optCuts.set(`${f}|${s}`, r0 ? cutDate(r0.trades.map((t) => t.day), IS_FRAC) : null);
    }
  const oStats = new Map<string, OptStats>(optRuns.map((r) => [r.name, optStats(r, optCuts.get(`${r.family}|${r.signal}`)!)]));
  log("Option statistics done");
  const optPicks: OptRun[] = [];
  for (const f of ["D1", "W1", "M1"] as OptFamily[])
    for (const s of SIGNALS)
      for (const mode of f === "M1" ? EOD_MODES : MODES) {
        const p = pickBest(optRuns.filter((r) => r.family === f && r.signal === s && r.mode === mode), (r) => oStats.get(r.name)!.is.mean, (r) => r.name);
        if (p) optPicks.push(p);
      }
  const optPerts: OptRun[] = [];
  for (const p of optPicks.filter((z) => z.family === "D1"))
    if (optCore(oStats.get(p.name)!)) {
      const mode = p.mode as Mode;
      for (const { label, def } of DEF_PERTURBATIONS) optPerts.push(buildOptRun(w, "D1", p.signal, p.sign, mode, def, ENTRY, EXIT, d1Source(ENTRY, EXIT, mode), inOpt, smoke, "perturbation", p.name, label));
      optPerts.push(buildOptRun(w, "D1", p.signal, p.sign, mode, BASE, ENTRY_ALT, EXIT, d1Source(ENTRY_ALT, EXIT, mode), inOpt, smoke, "perturbation", p.name, "entry 09:45"));
      optPerts.push(buildOptRun(w, "D1", p.signal, p.sign, mode, BASE, ENTRY, EXIT_ALT, d1Source(ENTRY, EXIT_ALT, mode), inOpt, smoke, "perturbation", p.name, "exit 15:05"));
    }
  const oPertStats = new Map<string, OptStats>(optPerts.map((r) => [r.name, optStats(r, optCuts.get(`D1|${r.signal}`)!, true)]));

  // ---- 3. Published rules and replications (descriptive) ----
  const pubRules = publishedRules(w, data);
  const rep = replications(w, loadFpi(I.fpi), loadNseFii(I.nseFii));

  if (smoke) {
    // Structure only: counts, skips and finiteness. No return or P&L is printed.
    const finite = (xs: number[]) => xs.every(Number.isFinite);
    for (const r of dirRuns.filter((z) => z.sign === "follow")) console.log(`smoke ${r.name}: obs ${r.obs.length}, trades ${r.obs.filter((o) => o.b !== 0).length}, skips ${JSON.stringify(r.skips)}, finite ${finite(r.obs.map((o) => o.r))}`);
    for (const r of optRuns.filter((z) => z.sign === "follow")) console.log(`smoke ${r.name}: slots ${r.slots.length}, trades ${r.trades.length}, calls ${r.trades.filter((t) => t.side === "CE").length}, skips ${JSON.stringify(r.skips)}, finite ${finite(r.trades.map((t) => t.net))}, cut ${optCuts.get(`${r.family}|${r.signal}`)}`);
    console.log(`smoke picks: index ${dirPicks.length}, options ${optPicks.length}; perturbations ${dirPerts.length + optPerts.length}; cuts ${JSON.stringify(Object.fromEntries(cuts))}`);
    console.log(`smoke published rules: ${pubRules.rows.map((z) => `${z.n}/${z.episodes}`).join(", ")}; HDFC series ${pubRules.hdfc.length - 1}; replications: ${rep.rows.map((z) => `${z.n}`).join(", ")}; streak rows ${rep.streaks.length - 1}`);
    return;
  }

  // ---- 4. Ledger ----
  const lines = [...dirRuns.map((r) => dirTrial(r, dStats.get(r.name)!)), ...dirPerts.map((r) => dirTrial(r, dPertStats.get(r.name)!)), ...optRuns.map((r) => optTrial(r, oStats.get(r.name)!)), ...optPerts.map((r) => optTrial(r, oPertStats.get(r.name)!))];
  const descLines = [...pubRules.rows.map((d) => descTrial(d, "published rule")), ...rep.rows.map((d) => descTrial(d, "replication"))];
  const allLines = [...lines, ...descLines];
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === WP).map((r) => r.variant));
  const fresh = allLines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVarDir = sharpeVariance(lines.filter((l) => (l.params as { family?: string }).family === "index direction")).variance;
  const srVarOpt = sharpeVariance(lines.filter((l) => (l.params as { family?: string }).family === "option D1")).variance;
  log(`Ledger: ${ledgerBefore} lines before, ${fresh.length} new (${args.ledger === true ? "appended" : "NOT appended: no --ledger"}), N = ${ledgerN}; V[SR] index ${srVarDir?.toExponential(2)}, option D1 ${srVarOpt?.toExponential(2)}`);

  // ---- 5. The bar ----
  const dirJudged = dirPicks.map((p) => {
    const perts = dirCore(dStats.get(p.name)!) ? dirPerts.filter((z) => z.base === p.name).map((z) => ({ label: z.label!, oosNet: sum(dPertStats.get(z.name)!.oos.rets) })) : null;
    return { run: p, stats: dStats.get(p.name)!, j: judgeDir(p, dStats.get(p.name)!, perts, ledgerN, srVarDir) };
  });
  const optJudged = optPicks
    .filter((p) => p.family === "D1")
    .map((p) => {
      const perts = optCore(oStats.get(p.name)!) ? optPerts.filter((z) => z.base === p.name).map((z) => ({ label: z.label!, oosNet: oPertStats.get(z.name)!.oos.net })) : null;
      return { run: p, stats: oStats.get(p.name)!, j: judgeOpt(p, oStats.get(p.name)!, perts, ledgerN, srVarOpt) };
    });

  // ---- 6. Tables ----
  const S: string[] = [
    `# WP14 tables (generated)\n\nLedger: ${ledgerBefore} → ${ledgerN} lines (${fresh.length} new); Bonferroni 0.05/${ledgerN} = ${(0.05 / ledgerN).toExponential(2)}; V[SR] of this study's index lines ${srVarDir?.toExponential(2)}, of its D1 option lines ${srVarOpt?.toExponential(2)}.\n\nIndex cuts (last entry session of the first 60% of the base D1 signal days): ${SIGNALS.map((s) => `${s} ${cuts.get(s)}`).join(", ")}. Option cuts: ${[...optCuts].map(([k, v]) => `${k} ${v}`).join(", ")}.\n`,
  ];
  const dv: (string | number)[][] = [["signal", "horizon", "pick (first 60%, purged)", "first 60% per trade (n)", "last 40% signal days (÷ hold)", "last 40% per trade (95% CI)", "hit vs base", "placebo gap (SE)", "PF", "verdict"]];
  for (const { run, stats: s, j } of dirJudged) dv.push([run.signal, run.horizon, run.sign, `${bp(s.is.mean)} (${s.is.n})`, `${s.oos.n} (${fx(s.oos.nEff, 0)})`, `${bp(s.oos.mean)} (${bp(s.oos.boot.perTrade.lo)} … ${bp(s.oos.boot.perTrade.hi)})`, `${pct(s.oos.hit)} vs ${pct(s.oos.base)}`, `${bp(s.oos.gap)} (${fx(s.oos.gap / s.oos.gapSe)} SE)`, fx(s.oos.pf), j.verdict]);
  S.push(`\n## Verdicts: index direction picks\n\n${md(dv)}\n`);
  const ov: (string | number)[][] = [["signal", "fill", "pick (first 60%)", "first 60% ₹/trade (n)", "last 40% trades", "last 40% ₹/trade (95% CI)", "PF", "placebo gap (SE)", "per session (CI)", "to Dec 2024 / from 2025", "worst / best day", "verdict"]];
  for (const { run, stats: s, j } of optJudged) ov.push([run.signal, run.mode, run.sign, `${rs(s.is.mean)} (${s.is.n})`, s.oos.n, `${rs(s.oos.mean)} (${rs(s.oos.lo)} … ${rs(s.oos.hi)})`, fx(s.oos.pf), `${rs(s.oos.gap.gap)} (${fx(s.oos.gap.t)} SE)`, `${rs(s.oos.boot.perSession.estimate)} (${rs(s.oos.sessLo)} … ${rs(s.oos.sessHi)})`, `${rs(s.oosEra1.mean)} (${s.oosEra1.n}) / ${rs(s.oosEra2.mean)} (${s.oosEra2.n})`, `${rs(s.tail.worst)} (${s.tail.worstDay}) / ${rs(s.tail.best)} (${s.tail.bestDay})`, j.verdict]);
  S.push(`\n## Verdicts: D1 option picks (NIFTY, real 1-minute prices)\n\n${md(ov)}\n`);
  for (const { run, stats: s, j } of dirJudged) {
    S.push(`\n### ${run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "sessions", "signal days", "per trade", "95% CI", "hit", "base", "PF", "placebo gap (SE)"], ...[s.full, s.is, s.oos, s.regime1, s.regime2].map((z) => [z.label, z.sessions, z.n, bp(z.mean), `${bp(z.boot.perTrade.lo)} … ${bp(z.boot.perTrade.hi)}`, pct(z.hit), pct(z.base), fx(z.pf), `${bp(z.gap)} (${fx(z.gap / z.gapSe)})`])])}\n\nBy year (signal days, mean, hit): ${s.years.map((y) => `${y.year} ${y.n} ${bp(y.mean, 0)} ${pct(y.hit, 0)}`).join(" · ")}\n`);
    const perts = dirPerts.filter((z) => z.base === run.name);
    if (perts.length) S.push(`Perturbations (last 40%): ${perts.map((z) => `${z.label}: ${dPertStats.get(z.name)!.oos.n} days, ${bp(dPertStats.get(z.name)!.oos.mean)}`).join(" · ")}\n`);
  }
  for (const { run, stats: s, j } of optJudged) {
    S.push(`\n### ${run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "trades", "₹/trade", "95% CI", "PF", "hit", "net ₹", "placebo gap (SE)"], ...[s.full, s.is, s.oos, s.era1, s.era2, s.oosEra1, s.oosEra2].map((z) => [z.label, z.n, rs(z.mean), `${rs(z.lo)} … ${rs(z.hi)}`, fx(z.pf), pct(z.hit), rs(z.net), `${rs(z.gap.gap)} (${fx(z.gap.t)})`])])}\n\nBy year: ${s.years.map((y) => `${y.year} ${y.n} ${rs(y.mean)}`).join(" · ")}\n`);
    const perts = optPerts.filter((z) => z.base === run.name);
    if (perts.length) S.push(`Perturbations (last 40% net ₹ / trades): ${perts.map((z) => `${z.label}: ${rs(oPertStats.get(z.name)!.oos.net)} / ${oPertStats.get(z.name)!.oos.n}`).join(" · ")}\n`);
  }
  const dall: (string | number)[][] = [["variant", "signal days", "per trade (95% CI)", "hit vs base (up)", "PF", "placebo gap (SE)", "first 60% per trade (n)", "last 40% per trade [CI] (n)", "to 2019 / from 2020 per trade (n)", "skips"]];
  for (const r of dirRuns) {
    const s = dStats.get(r.name)!;
    dall.push([r.name.replace("NIFTY index ", ""), s.full.n, `${bp(s.full.mean)} (${bp(s.full.boot.perTrade.lo)} … ${bp(s.full.boot.perTrade.hi)})`, `${pct(s.full.hit)} vs ${pct(s.full.base)} (${pct(s.full.up)})`, fx(s.full.pf), `${bp(s.full.gap)} (${fx(s.full.gap / s.full.gapSe)})`, `${bp(s.is.mean)} (${s.is.n})`, `${bp(s.oos.mean)} [${bp(s.oos.boot.perTrade.lo)} … ${bp(s.oos.boot.perTrade.hi)}] (${s.oos.n})`, `${bp(s.regime1.mean)} (${s.regime1.n}) / ${bp(s.regime2.mean)} (${s.regime2.n})`, Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–"]);
  }
  S.push(`\n## Every index variant (${dirRuns.length})\n\n${md(dall)}\n`);
  const oall: (string | number)[][] = [["variant", "trades", "₹/trade (95% CI)", "hit", "PF", "placebo gap (SE)", "first 60% ₹/trade (n)", "last 40% ₹/trade [CI] (n)", "to Dec 2024 / from 2025", "premium ₹", "index move for the side (share right)", "skips"]];
  for (const r of optRuns) {
    const s = oStats.get(r.name)!;
    oall.push([r.name.replace("NIFTY ", ""), s.full.n, `${rs(s.full.mean)} (${rs(s.full.lo)} … ${rs(s.full.hi)})`, pct(s.full.hit, 0), fx(s.full.pf), `${rs(s.full.gap.gap)} (${fx(s.full.gap.t)})`, `${rs(s.is.mean)} (${s.is.n})`, `${rs(s.oos.mean)} [${rs(s.oos.lo)} … ${rs(s.oos.hi)}] (${s.oos.n})`, `${rs(s.era1.mean)} / ${rs(s.era2.mean)}`, rs(s.premium), `${pp(s.move)} (${pct(s.moveHit, 0)})`, Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–"]);
  }
  S.push(`\n## Every option variant (${optRuns.length})\n\n${md(oall)}\n`);
  const desc: (string | number)[][] = [["family", "signal", "fill", "pick (first 60%)", "first 60% ₹/trade (n)", "last 40% ₹/trade [CI] (n)", "PF last 40%", "placebo gap last 40% (SE)"]];
  for (const p of optPicks.filter((z) => z.family !== "D1")) {
    const s = oStats.get(p.name)!;
    desc.push([p.family, p.signal, p.mode, p.sign, `${rs(s.is.mean)} (${s.is.n})`, `${rs(s.oos.mean)} [${rs(s.oos.lo)} … ${rs(s.oos.hi)}] (${s.oos.n})`, fx(s.oos.pf), `${rs(s.oos.gap.gap)} (${fx(s.oos.gap.t)})`]);
  }
  S.push(`\n## W1 and M1 option holds (descriptive: fewer than ${MIN_OOS} out-of-sample trades by construction)\n\n${md(desc)}\n`);
  const tail: (string | number)[][] = [["variant", "trades", "net ₹", "worst trade", "best trade", "10 worst", "10 best as a share of net", "net without the best 5 / 10", "max drawdown (% of ₹5 lakh)", "longest losing run", "premium ₹/trade", "charges ₹/trade"]];
  for (const r of optRuns.filter((z) => z.family === "D1")) {
    const s = oStats.get(r.name)!;
    tail.push([r.name.replace("NIFTY D1 option ", ""), s.full.n, rs(s.full.net), `${rs(s.tail.worst)} (${s.tail.worstDay})`, `${rs(s.tail.best)} (${s.tail.bestDay})`, rs(s.tail.worst10), pct(s.tail.best10Share, 0), `${rs(s.tail.withoutBest5)} / ${rs(s.tail.withoutBest10)}`, `${rs(s.tail.maxDD)} (${pct(s.tail.maxDD / CAPITAL)})`, s.tail.longestLosing, rs(s.premium), rs(s.charges)]);
  }
  S.push(`\n## Tails of the D1 option variants (one lot)\n\n${md(tail)}\n`);
  for (const { run } of dirJudged) {
    const sg = run.sign === "follow" ? 1 : -1;
    const xs = run.obs.filter((o) => o.b !== 0).map((o) => ({ E: o.entry, x: sg * o.b * o.r }));
    const sorted = [...xs].sort((a, b) => a.x - b.x);
    S.push(`\n${run.name}: worst ${sorted.slice(0, 5).map((z) => `${z.E} ${pp(z.x)}`).join(", ")}; best ${sorted.slice(-5).reverse().map((z) => `${z.E} ${pp(z.x)}`).join(", ")}\n`);
  }
  const descRows = (rows: Desc[]) => md([["rule or claim", "n", "episodes", "mean (95% CI)", "share up (Wilson 95%)", "note"], ...rows.map((d) => [d.name, d.n, d.episodes, `${pp(d.mean)} (${pp(d.lo)} … ${pp(d.hi)})`, `${pct(d.up)} (${pct(d.upLo)} … ${pct(d.upHi)})`, d.extra ?? ""])]);
  S.push(`\n## Published rules (R5, untuned; descriptive)\n\n${descRows(pubRules.rows)}\n\n**P1 HDFC, every qualifying series:**\n\n${md(pubRules.hdfc)}\n\n**P2 flips:** ${pubRules.rows.find((z) => z.name.startsWith("P2"))?.rows?.join("; ") ?? "–"}\n`);
  S.push(`\n## Replications (descriptive)\n\n${descRows(rep.rows)}\n\n${md(rep.streaks)}\n\n${rep.notes.join("\n\n")}\n`);
  mkdirSync(I.outDir, { recursive: true });
  writeFileSync(resolve(I.outDir, "tables.md"), S.join("\n"));
  const pickD = (s: DirStats) => {
    const z = (u: DirSub) => ({ n: u.n, nEff: u.nEff, mean: u.mean, lo: u.boot.perTrade.lo, hi: u.boot.perTrade.hi, sessLo: u.boot.perSession.lo, hit: u.hit, base: u.base, up: u.up, pf: u.pf, gap: u.gap, gapSe: u.gapSe, p: Math.max(u.boot.perTrade.p, u.boot.perSession.p) });
    return { full: z(s.full), is: z(s.is), oos: z(s.oos), regime1: z(s.regime1), regime2: z(s.regime2), years: s.years, sr: s.sr };
  };
  const pickO = (s: OptStats) => {
    const z = (u: OptSub) => ({ n: u.n, mean: u.mean, lo: u.lo, hi: u.hi, sessLo: u.sessLo, pf: u.pf, hit: u.hit, net: u.net, gap: u.gap.gap, gapSe: u.gap.se, pCe: u.pCe, p: Math.max(u.boot.perTrade.p, u.boot.perSession.p) });
    return { full: z(s.full), is: z(s.is), oos: z(s.oos), era1: z(s.era1), era2: z(s.era2), oosEra1: z(s.oosEra1), oosEra2: z(s.oosEra2), years: s.years, tail: s.tail, premium: s.premium, charges: s.charges, move: s.move, moveHit: s.moveHit, sr: s.sr };
  };
  writeFileSync(
    resolve(I.outDir, "summary.json"),
    JSON.stringify(
      {
        ledgerBefore,
        ledgerN,
        srVarDir,
        srVarOpt,
        cuts: Object.fromEntries(cuts),
        optCuts: Object.fromEntries(optCuts),
        index: dirRuns.map((r) => ({ name: r.name, signal: r.signal, horizon: r.horizon, sign: r.sign, skips: r.skips, ...pickD(dStats.get(r.name)!) })),
        indexJudged: dirJudged.map((z) => ({ name: z.run.name, verdict: z.j.verdict, criteria: z.j.criteria, p: z.j.p, dsr: z.j.dsr, dsrNull: z.j.dsrNull })),
        options: optRuns.map((r) => ({ name: r.name, family: r.family, signal: r.signal, sign: r.sign, mode: r.mode, skips: r.skips, ...pickO(oStats.get(r.name)!) })),
        optionPicks: optPicks.map((p) => p.name),
        optionJudged: optJudged.map((z) => ({ name: z.run.name, verdict: z.j.verdict, criteria: z.j.criteria, p: z.j.p, dsr: z.j.dsr, dsrNull: z.j.dsrNull })),
        perturbations: [...dirPerts.map((r) => ({ name: r.name, base: r.base, oosMean: dPertStats.get(r.name)!.oos.mean, oosN: dPertStats.get(r.name)!.oos.n })), ...optPerts.map((r) => ({ name: r.name, base: r.base, oosNet: oPertStats.get(r.name)!.oos.net, oosN: oPertStats.get(r.name)!.oos.n }))],
        published: pubRules,
        replications: rep,
      },
      null,
      1,
    ),
  );
  log(`Wrote ${resolve(I.outDir, "tables.md")}; index verdicts: ${dirJudged.map((z) => `${z.run.signal} ${z.run.horizon} ${z.run.sign} ${z.j.verdict}`).join("; ")}; option verdicts: ${optJudged.map((z) => `${z.run.signal} ${z.run.mode} ${z.run.sign} ${z.j.verdict}`).join("; ")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2];
  if (cmd === "coverage") return coverage(args);
  if (cmd === "run") return runAll(args);
  if (cmd === "debug") {
    // One entry session by hand: the readings of the file it trades on and its D1 fills, to check against the raw bars.
    const I = inputs(args);
    const E = str(args, "day") ?? fail("--day YYYY-MM-DD (an entry session E) is required");
    const data = await loadData(I);
    const w = buildWorld(I, data);
    const T = prevSession(w, E);
    const i = T ? w.oiIx.get(T) : undefined;
    console.log(`E ${E} (${w.special.has(E) ? "special" : w.regIx.has(E) ? "regular" : "not a session"}); T ${T}${i === undefined ? " (no usable file)" : ""}; index bar on E ${JSON.stringify(w.yahoo.get(E) ?? null)}`);
    if (i !== undefined) {
      const d = w.oi.days[i];
      console.log(`  T file: FII index futures ${d.fii.futIdxLong} long / ${d.fii.futIdxShort} short; Client ${d.client.futIdxLong} / ${d.client.futIdxShort}; FII index options CL ${d.fii.optIdxCallLong} CS ${d.fii.optIdxCallShort} PL ${d.fii.optIdxPutLong} PS ${d.fii.optIdxPutShort}`);
      for (const s of SIGNALS) console.log(`  ${s} ${SIGNAL_LABEL[s]}: ${w.raw[s][i]?.toFixed(5) ?? "–"}, rank ${ranks(w, s, BASE.window)[i]?.toFixed(4) ?? "–"}, bucket ${buckets(w, s, BASE, false)[i] ?? "–"}`);
    }
    const c = optCtx(data, I.x);
    for (const mode of MODES) {
      const p = d1Pair(c, E, ENTRY, EXIT, mode);
      const show = (t: Trade14 | null) => (t ? `${t.side} k ${t.k} lot ${t.lot} DTE ${t.dte} premium ${fx(t.premium)} gross ${fx(t.gross)} charges ${fx(t.charges)} net ${fx(t.net)} ${minToHhmm(t.entryMin)}→${minToHhmm(t.exitMin)} stale ${t.stale}` : "–");
      console.log(`  D1 ${mode}: ${p.skip ?? "ok"}; ${show(p.ce)}; ${show(p.pe)}`);
    }
    const ex = expiryWithDte(data, E, MIN_DTE.D1);
    const chain = ex ? chainOf(c, E, ex.expiry) : null;
    const level = idxOf(c, E).lastUpTo(ENTRY - 1)?.c;
    const k = chain && level !== undefined ? nearestListed(bothListed(chain), level) : null;
    console.log(`  contract ${ex?.expiry} (DTE ${ex?.dte}); index at the 09:29 close ${level}; ATM ${k}`);
    if (chain && k !== null)
      for (const t of ["CE", "PE"] as const) {
        const ser = chain.series.get(key(k, t))!;
        for (const m of [ENTRY, ENTRY + 1, EXIT, EXIT + 1]) {
          const b = ser.at(m);
          console.log(`  ${ex!.expiry} ${k}${t} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
        }
      }
    return;
  }
  fail(`unknown command ${cmd ?? ""}: coverage | run | debug`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
