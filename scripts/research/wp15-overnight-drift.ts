/**
 * WP15: does NIFTY's (and SENSEX's) overnight drift give a retail option buyer an edge?
 * (reports/wp15-overnight-drift.md; every definition is frozen in its §1, committed before any
 * overnight mean, conditional return or P&L was computed). Research only: nothing here changes the
 * engine.
 *
 *   A. Index direction (Yahoo daily ^NSEI and ^BSESN, nights from 2011): long from the official close
 *      of a regular session D to the official open of the next regular session E, on six night
 *      subsets (all; weekday; weekend and holiday; after a down day; after an up day; after a
 *      sell-off of 1% or more), each judged on its last 40% against the plan's §12 bar, with two
 *      placebos: E's own open → close on the same nights, and a fair-coin side.
 *   B. The retail option buyer (real 1-minute prices): buy the call at 15:20 or 15:25 on D (ATM or one
 *      strike in the money, at least 2 sessions to expiry) and sell it at 09:15, 09:16 or 09:20 on
 *      E, on all, weekday, down-day or sell-off nights. Per index, filter and fill, the timing and
 *      strike are picked on the first 60% of nights and judged untouched on the last 40%; the
 *      placebo is a fair coin between that call and the mirrored put at the same minutes.
 *   C. Three published variants from note R6 (untuned): C1 the synthetic long (long call + short put
 *      at the strike nearest the forward) 15:25 → 09:30, C1-B the single long call at the same
 *      strike and minutes, and C2 the synthetic only after a weak 09:30 → 15:25 session (threshold
 *      picked on the first 60% from R6's three).
 *   D. Descriptive: the bridge from the official close → open to the minutes a buyer can trade,
 *      near-month futures and the ATM call close → open (bhavcopy), the overnight straddle, R6's
 *      breakdowns, the tails and what a stop cannot do overnight.
 *
 * Data: Yahoo ^NSEI / ^BSESN / ^INDIAVIX daily bars (Q2's download); the Hugging Face dataset "India
 * Index & Options - 1-minute OHLC" by TradeMarkk (thetrademarkk/india-index-options-1m, revision
 * 0f4800e4, licence CC-BY-NC-4.0, research only) as reduced by WP13's wp13_extract.py; the compact
 * NSE/BSE bhavcopy cache (lots, expiries, holidays, short sessions, futures and end-of-day option
 * prices); the file names of NSE's participant-OI archive (WP14's download) as a list of NSE sessions
 * from 2012. Raw data is never committed.
 *
 *   npx tsx scripts/research/wp15-overnight-drift.ts coverage --nsei <^NSEI 1d json> --bsesn <^BSESN 1d json> --vix <^INDIAVIX 1d json> --x <x13 extract> --dir <bhavcopy cache> [--oi <participant OI dir>] [--out reports/wp15]
 *   npx tsx scripts/research/wp15-overnight-drift.ts run      (same inputs) [--out reports/wp15] [--ledger] [--smoke]
 *   npx tsx scripts/research/wp15-overnight-drift.ts debug    (same inputs) --index NIFTY --day YYYY-MM-DD   (D: the session whose close starts the night)
 *
 *   --smoke  every price-derived value (index returns, option fills and P&L, futures, end-of-day
 *            calls) is replaced by a deterministic synthetic number and the night conditions by a
 *            fixed cycle; the whole pipeline runs (statistics, verdicts, tables) without touching the
 *            ledger: a test of the code paths that reveals nothing about the data
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blocksOf, cutDate, overallVerdict, pickBest, robustness, runOvernight, type CriterionVerdict } from "../../src/engine/backtest/expiryCalendar";
import { hhmmToMin, itmStrike, minToHhmm, MinuteSeries, nearestListed, OPEN_MIN, pairedGap, runPosition, type MinuteBar } from "../../src/engine/backtest/intraday1m";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, seededRandom, type BlockBootstrap } from "../../src/engine/backtest/metrics";
import { fairCoinDays, gapThroughStop, halves, needsChange, nightsBetween, passesFilter, tailRisk, type Night, type NightFilter, type NightKind } from "../../src/engine/backtest/overnight";
import { blockBootstrap, trailingRank, wilson, type SeriesBootstrap } from "../../src/engine/backtest/positioning";
import { maxDrawdown, structurePnl } from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { weekdayOf } from "../../src/engine/clock";
import { quantile } from "../../src/engine/util/math";
import { ROOT, fail, parseArgs, str } from "../lib/node";
import { badPrint, loadResearchData, md, RESEARCH_INDICES, spotClose, type ResearchData, type ResearchIndex } from "./real_prices";
import { bothListed, CAPITAL, fx, key, loadChainDay, loadIndex, loadManifest, lotOf, pct, rs, type ChainDay, type Manifest, type OptType } from "./wp11-real-intraday";

// ---------------------------------------------------------------------------
// Frozen constants (report §1)
// ---------------------------------------------------------------------------

const WP = "WP15";
type Sym = "NIFTY" | "SENSEX";
const SYMS: readonly Sym[] = ["NIFTY", "SENSEX"];
const DEF: Record<Sym, ResearchIndex> = { NIFTY: RESEARCH_INDICES[0], SENSEX: RESEARCH_INDICES[1] };
/** Index nights start on or after this date (the pre-open call auction sets the official open from Oct 2010). */
const FIRST_NIGHT = "2011-01-01";
const IS_FRAC = 0.6;
const MIN_OOS = 180;
const BOOT = 20_000;
const BOOT_SUB = 10_000;
const BOOT_LIGHT = 2_000;
const BOOT_FINAL = 100_000;
const SEED = 7;
/** Circular block bootstrap of the index nights: blocks of 5 sessions (a week). */
const INDEX_BLOCK = 5;
/** A sell-off: the index at least 1% below the previous session's close. */
const SELLOFF = -0.01;
const SELLOFF_PERTS = [-0.008, -0.012];
/** Last session whose option bars hold every trade (WP11 §2); later bars are built from sampled prices. */
const ERA_END = "2024-12-31";
const REGIME_SPLIT = "2019-12-31";
/** Option STT on sales rose from 0.1% to 0.15% of premium (futures: 0.02% → 0.05% of notional) on this date. */
const STT_2026 = "2026-04-01";
/** The BSE derivatives bhavcopy is daily from the SENSEX relaunch (earlier BSE files are isolated special sessions). */
const BSE_DAILY_FROM = "2023-05-15";
const bhavFrom = (data: ResearchData, sym: Sym) => (sym === "SENSEX" ? BSE_DAILY_FROM : data.book.dates(sym)[0]);
const IDX_SUBSETS: readonly NightFilter[] = ["all", "weekday", "weekend", "down", "up", "selloff"];
const OPT_FILTERS: readonly NightFilter[] = ["all", "weekday", "down", "selloff"];
const FILTER_LABEL: Record<NightFilter, string> = {
  all: "all nights",
  weekday: "weekday nights",
  weekend: "weekend and holiday nights",
  down: "after a down day",
  up: "after an up day",
  selloff: "after a sell-off",
};
/** Family B: the call buyer's own values (entry on D, exit on E, strikes in the money). */
const ENTRIES = ["15:20", "15:25"].map(hhmmToMin);
const EXITS = ["09:15", "09:16", "09:20"].map(hhmmToMin);
const STEPS = [0, 1];
/** Family B: values reached only by the ±20% perturbations. */
const ENTRY_SET = ["15:15", "15:20", "15:25"].map(hhmmToMin);
const EXIT_LATE = hhmmToMin("09:30");
const B_EXITS = [...EXITS, EXIT_LATE];
const B_STEPS = [-1, 0, 1, 2];
const BASE_ENTRY = hhmmToMin("15:20");
const BASE_EXIT = hhmmToMin("09:15");
/** Family C (R6 §6): entry 15:25, exit 09:30; perturbations entry 15:20 / 15:28, exit 09:20 / 09:45, strike ±1. */
const C_ENTRY = hhmmToMin("15:25");
const C_EXIT = hhmmToMin("09:30");
const C_ENTRIES = ["15:20", "15:25", "15:28"].map(hhmmToMin);
const C_EXITS = ["09:15", "09:20", "09:30", "09:45"].map(hhmmToMin);
const C_STEPS = [-1, 0, 1];
/** C1's intraday placebo: the same synthetic over E's session. */
const C_DAY_IN = hhmmToMin("09:30");
const C_DAY_OUT = hhmmToMin("15:25");
/** C2's weak-session thresholds (R6 §6): the 09:30 → 15:25 return in the bottom 20% or 33% of its trailing 250 sessions, or below −0.5%. */
const C2_CHOICES: readonly C2Threshold[] = [
  { label: "bottom 20%", rank: 0.2 },
  { label: "bottom 33%", rank: 1 / 3 },
  { label: "below −0.5%", ret: -0.005 },
];
const C2_WINDOW = 250;
const C2_DRAWS = 10_000;
const ENTRY_WAIT = 2;
const EXIT_WAIT = 5;
/** Sessions to expiry at entry (plan rule N4): never a contract expiring the next session. */
const MIN_DTE = 2;
const MIN_INDEX_BARS = 370;
const CLOSE_MIN = 930;
const LAST_BAR = hhmmToMin("15:29");
type Mode = "conservative" | "mid";
const MODES: readonly Mode[] = ["conservative", "mid"];
const ACCOUNTS = [500_000, 10_000];
const STOP_FRACS = [0.3, 0.5];
const INDEX_STOPS = [0.01, 0.02];
const VIX_WINDOW = 250;
/** Nights reported by name in the tails (D dates): two COVID-crash gaps (into 13 and 23 Mar 2020) and the 2024 election result (into 4 and 5 Jun 2024). */
const NAMED_NIGHTS = ["2020-03-12", "2020-03-20", "2024-06-03", "2024-06-04"];
/**
 * NSE's Diwali Muhurat sessions (about one hour each), Lakshmi Puja days 2011–2025: special sessions
 * whatever the weekday (WP14's list, with 26 Oct 2011). A calendar, not market data.
 */
const MUHURAT = ["2011-10-26", "2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11", "2016-10-30", "2017-10-19", "2018-11-07", "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"];
/**
 * Futures STT on sales, % of notional, by the Finance Act dates the option schedule already encodes
 * (WP10's RESEARCH_CHARGE_SCHEDULES: options 0.05 → 0.0625 → 0.1 → 0.15) and R6 §1.4 [K1]. Used only
 * to state the futures route's tax hurdle (descriptive); other futures charges are not modelled.
 */
const FUT_STT: readonly { from: string; pct: number }[] = [
  { from: "2016-06-01", pct: 0.01 },
  { from: "2023-04-01", pct: 0.0125 },
  { from: "2024-10-01", pct: 0.02 },
  { from: "2026-04-01", pct: 0.05 },
];

interface C2Threshold {
  label: string;
  rank?: number;
  ret?: number;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs: readonly number[]) => quantile(xs, 0.5);
const bp = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 1e4).toFixed(d)} bp` : "–");
const pp = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%` : "–");
const bump = (o: Record<string, number>, k: string) => void (o[k] = (o[k] ?? 0) + 1);
const stepLabel = (s: number) => (s === 0 ? "ATM" : s > 0 ? `${s} ITM` : `${-s} OTM`);
const fstepLabel = (s: number) => (s === 0 ? "K(fwd)" : s > 0 ? `K(fwd)+${s} strike` : `K(fwd)−${-s} strike`);
const futStt = (date: string) => [...FUT_STT].reverse().find((s) => s.from <= date)?.pct ?? FUT_STT[0].pct;
const sharpe = (rets: readonly number[]) => {
  const m = avg(rets);
  const sd = Math.sqrt(sum(rets.map((x) => (x - m) ** 2)) / Math.max(1, rets.length - 1));
  return sd > 0 ? m / sd : 0;
};
const tercileOf = (r: number | null): 0 | 1 | 2 | null => (r === null ? null : r < 1 / 3 ? 0 : r > 2 / 3 ? 2 : 1);
const TERCILE = ["low", "middle", "high"];
/** --smoke: replace every price-derived value by a deterministic number in [−1, 1] (FNV-1a of a key). */
let SMOKE = false;
function fake(k: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

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

/** The dates of NSE's participant-OI archive files (fao_participant_oi_DDMMYYYY.csv): file names only. */
function loadOiDates(dir: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^fao_participant_oi_(\d{2})(\d{2})(\d{4})\.csv$/.exec(f);
    if (m) out.add(`${m[3]}-${m[2]}-${m[1]}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sessions and nights (report §1.2)
// ---------------------------------------------------------------------------

interface World {
  data: ResearchData;
  bars: Record<Sym, Map<string, DailyBar | null>>;
  /** Every session: a complete Yahoo bar of either index, an NSE or BSE bhavcopy, or a participant-OI file. */
  cal: string[];
  /** Weekend sessions, Muhurat sessions and the bhavcopy's short sessions: never the start or end of a night. */
  special: Set<string>;
  isSpecial: (d: string) => boolean;
  reg: string[];
  regIx: Map<string, number>;
  nights: Night[];
  oiDates: Set<string>;
  /** India VIX close of the regular session before each day, and its tercile within the trailing 250 closes (null before 250). */
  vixPrev: (day: string) => { vix: number | null; tercile: 0 | 1 | 2 | null };
}

function buildWorld(I: Inputs, data: ResearchData): World {
  const bars: Record<Sym, Map<string, DailyBar | null>> = { NIFTY: loadYahooDaily(I.nsei), SENSEX: loadYahooDaily(I.bsesn) };
  const oiDates = loadOiDates(I.oi);
  const calSet = new Set<string>();
  for (const s of SYMS) for (const [d, b] of bars[s]) if (b && d >= "2010-12-01") calSet.add(d);
  for (const d of data.book.dates("NIFTY")) calSet.add(d);
  for (const d of data.book.dates("SENSEX")) calSet.add(d);
  for (const d of oiDates) calSet.add(d);
  // Muhurat sessions are sessions by definition, even where no file or complete bar records them (26 Oct 2011).
  for (const d of MUHURAT) calSet.add(d);
  const cal = [...calSet].sort();
  const special = new Set<string>([...cal.filter((d) => weekdayOf(d) >= 6 || MUHURAT.includes(d)), ...data.special]);
  const isSpecial = (d: string) => special.has(d);
  const reg = cal.filter((d) => !special.has(d));
  // India VIX: closes by date, the trailing-250 rank of each close.
  const vixBars = [...loadYahooDaily(I.vix)].filter(([, b]) => b).sort(([a], [b]) => a.localeCompare(b));
  const vixDays = vixBars.map(([d]) => d);
  const vixClose = vixBars.map(([, b]) => b!.c);
  const vixRank = trailingRank(vixClose, VIX_WINDOW);
  const vixPrev = (day: string) => {
    let lo = 0;
    let hi = vixDays.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vixDays[mid] < day) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? { vix: vixClose[lo - 1], tercile: tercileOf(vixRank[lo - 1]) } : { vix: null, tercile: null };
  };
  return { data, bars, cal, special, isSpecial, reg, regIx: new Map(reg.map((d, i) => [d, i])), nights: nightsBetween(cal, isSpecial), oiDates, vixPrev };
}

/** One index night: the official close of D to the official open of E. */
interface IdxNight {
  d: string;
  e: string;
  kind: NightKind;
  /** E's open ÷ D's close − 1. */
  r: number;
  /** E's close ÷ E's open − 1 (the intraday placebo). */
  p: number;
  /** D's close ÷ the previous regular session's close − 1; null without a complete bar there. */
  change: number | null;
  vixTercile: 0 | 1 | 2 | null;
}

/** The valid nights of an index from 2011 (report §1.2); `smoke`: synthetic returns and a fixed cycle of changes. */
function indexNights(w: World, sym: Sym, smoke: boolean): { nights: IdxNight[]; skips: Record<string, number>; candidates: number } {
  const bars = w.bars[sym];
  const nights: IdxNight[] = [];
  const skips: Record<string, number> = {};
  let candidates = 0;
  for (const n of w.nights) {
    if (n.d < FIRST_NIGHT) continue;
    candidates++;
    if (n.spans.length) {
      bump(skips, "spans a special session");
      continue;
    }
    const a = bars.get(n.d);
    const b = bars.get(n.e);
    if (!a || !b) {
      bump(skips, "no complete index bar on D or E");
      continue;
    }
    if (Math.abs(b.o - a.c) < 1e-9) {
      bump(skips, "E's open equals D's close (a stale open)");
      continue;
    }
    const i = w.regIx.get(n.d)!;
    const prev = i > 0 ? bars.get(w.reg[i - 1]) : null;
    const change = smoke ? [-0.02, 0.005, -0.004][nights.length % 3] : prev ? a.c / prev.c - 1 : null;
    const vt = w.vixPrev(n.d).tercile;
    nights.push(smoke ? { d: n.d, e: n.e, kind: n.kind, r: 0.004 * fake(`${sym}|${n.d}|r`), p: 0.004 * fake(`${sym}|${n.d}|p`), change, vixTercile: vt } : { d: n.d, e: n.e, kind: n.kind, r: b.o / a.c - 1, p: b.c / b.o - 1, change, vixTercile: vt });
  }
  return { nights, skips, candidates };
}

/** Yahoo's close of the regular session before `day` (the "previous close" of the night filters); null when incomplete. */
function prevClose(w: World, sym: Sym, day: string): number | null {
  let lo = 0;
  let hi = w.reg.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (w.reg[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  const p = lo > 0 ? w.reg[lo - 1] : null;
  return p ? (w.bars[sym].get(p)?.c ?? null) : null;
}

// ---------------------------------------------------------------------------
// A. Index direction (report §1.3)
// ---------------------------------------------------------------------------

interface IdxRun {
  name: string;
  sym: Sym;
  subset: NightFilter;
  threshold: number;
  kind: "strategy" | "perturbation";
  base?: string;
  label?: string;
  obs: IdxNight[];
}

const idxName = (sym: Sym, subset: NightFilter, threshold: number) => `${sym} index night [${FILTER_LABEL[subset]}${subset === "selloff" ? ` ≤ ${pp(threshold, 1)}` : ""}] long D close→E open`;

interface IdxSub {
  label: string;
  /** Nights in the sample (the per-session denominator). */
  sessions: number;
  n: number;
  mean: number;
  boot: SeriesBootstrap;
  pf: number;
  hit: number;
  hitLo: number;
  hitHi: number;
  /** Mean of E's open → close over the same nights. */
  dayMean: number;
  /** Placebo (a): the night minus E's open → close, per trade night, with its block-bootstrap SE. */
  dayGap: number;
  dayGapSe: number;
  /** Placebo (b): a fair-coin side has expectation 0, so the gap is the mean, with its block-bootstrap SE. */
  coinGap: number;
  coinGapSe: number;
  /** Per-session return (0 outside the subset), for the DSR. */
  rets: number[];
}

function idxSub(label: string, obs: readonly IdxNight[], inSub: (o: IdxNight) => boolean, resamples: number): IdxSub {
  const trade = obs.map(inSub);
  const x = obs.map((o, i) => (trade[i] ? o.r : 0));
  const tx = x.filter((_, i) => trade[i]);
  const g = obs.map((o, i) => (trade[i] ? o.r - o.p : 0));
  const n = tx.length;
  const boot = blockBootstrap(x, trade, { block: INDEX_BLOCK, resamples, seed: SEED });
  const gb = n ? blockBootstrap(g, trade, { block: INDEX_BLOCK, resamples: Math.min(resamples, BOOT_SUB), seed: SEED }) : null;
  const up = tx.filter((v) => v > 0).length;
  const wl = wilson(up, n);
  const mean = n ? sum(tx) / n : NaN;
  return {
    label,
    sessions: obs.length,
    n,
    mean,
    boot,
    pf: profitFactor(tx),
    hit: n ? up / n : NaN,
    hitLo: wl.lo,
    hitHi: wl.hi,
    dayMean: n ? avg(obs.filter((_, i) => trade[i]).map((o) => o.p)) : NaN,
    dayGap: gb ? gb.perTrade.estimate : NaN,
    dayGapSe: gb ? gb.perTrade.se : NaN,
    coinGap: mean,
    coinGapSe: boot.perTrade.se,
    rets: x,
  };
}

interface IdxStats {
  full: IdxSub;
  is: IdxSub;
  oos: IdxSub;
  regime1: IdxSub;
  regime2: IdxSub;
  half1: IdxSub;
  half2: IdxSub;
  years: { year: string; n: number; mean: number; hit: number }[];
  /** R6's breakdowns of the same nights: night kind and the India VIX tercile (previous close in its trailing 250). */
  byKind: { key: string; n: number; mean: number; lo: number; hi: number }[];
  byVix: { key: string; n: number; mean: number; lo: number; hi: number }[];
  sr: number;
}

function breakdown(xs: readonly { key: string; x: number }[], keys: readonly string[], block: number): { key: string; n: number; mean: number; lo: number; hi: number }[] {
  return keys.map((k) => {
    const v = xs.filter((z) => z.key === k).map((z) => z.x);
    const b = v.length ? blockBootstrap(v, v.map(() => true), { block, resamples: BOOT_LIGHT, seed: SEED }) : null;
    return { key: k, n: v.length, mean: avg(v), lo: b ? b.perTrade.lo : NaN, hi: b ? b.perTrade.hi : NaN };
  });
}

/** In sample = nights whose E is on or before the cut (purged); out of sample = nights whose D is after it. */
function idxStats(r: IdxRun, cut: string, light = false): IdxStats {
  const inSub = (o: IdxNight) => passesFilter(r.subset, o, r.threshold);
  const nb = (k: number) => (light ? BOOT_LIGHT : k);
  const full = idxSub("all", r.obs, inSub, nb(BOOT));
  const oosObs = r.obs.filter((o) => o.d > cut);
  let oos = idxSub("last 40%", oosObs, inSub, nb(BOOT));
  if (!light && oos.boot.perTrade.lo > 0 && oos.boot.perSession.lo > 0) oos = idxSub("last 40%", oosObs, inSub, BOOT_FINAL);
  const mid = cutDate(r.obs.filter(inSub).map((o) => o.d), 0.5) ?? "";
  const years = [...new Set(r.obs.map((o) => o.d.slice(0, 4)))].sort().map((year) => {
    const xs = r.obs.filter((o) => o.d.startsWith(year) && inSub(o)).map((o) => o.r);
    return { year, n: xs.length, mean: avg(xs), hit: xs.length ? xs.filter((v) => v > 0).length / xs.length : NaN };
  });
  const traded = r.obs.filter(inSub);
  return {
    full,
    is: idxSub("first 60% (purged)", r.obs.filter((o) => o.e <= cut), inSub, nb(BOOT_SUB)),
    oos,
    regime1: idxSub(`to ${REGIME_SPLIT.slice(0, 4)}`, r.obs.filter((o) => o.d <= REGIME_SPLIT), inSub, BOOT_LIGHT),
    regime2: idxSub(`from ${Number(REGIME_SPLIT.slice(0, 4)) + 1}`, r.obs.filter((o) => o.d > REGIME_SPLIT), inSub, BOOT_LIGHT),
    half1: idxSub("first half", r.obs.filter((o) => o.d <= mid), inSub, BOOT_LIGHT),
    half2: idxSub("second half", r.obs.filter((o) => o.d > mid), inSub, BOOT_LIGHT),
    years,
    byKind: light ? [] : breakdown(traded.map((o) => ({ key: o.kind, x: o.r })), ["weekday", "weekend", "holiday"], 1),
    byVix: light ? [] : breakdown(traded.filter((o) => o.vixTercile !== null).map((o) => ({ key: TERCILE[o.vixTercile!], x: o.r })), TERCILE, 1),
    sr: sharpe(full.rets),
  };
}

// ---------------------------------------------------------------------------
// The 1-minute sample (report §1.4)
// ---------------------------------------------------------------------------

interface OptCtx {
  sym: Sym;
  def: ResearchIndex;
  x: string;
  man: Manifest[string];
  index: Map<string, MinuteBar[]>;
  /** Valid 1-minute sessions (WP11 §1.1, special sessions excluded), ascending. */
  days: string[];
  daySet: Set<string>;
  /** First and last session with an option file in the extract. */
  first: string;
  last: string;
  /** Nights between consecutive regular sessions of the full calendar, D in [first, last]. */
  nights: Night[];
  /** C2: each valid session's 09:30 → (entry − 1) index return, and its rank within the trailing 250 sessions, by entry minute. */
  sess: Map<number, Map<string, { ret: number; rank: number | null }>>;
  chains: Map<string, ChainDay | null>;
  idx: Map<string, MinuteSeries>;
}

function optCtx(w: World, sym: Sym, x: string, smoke: boolean): OptCtx {
  const man = loadManifest(x)[sym];
  const index = loadIndex(x, sym);
  const bookDays = new Set(w.data.book.dates(sym));
  const days = man.sessions.filter((day) => {
    const session = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m < CLOSE_MIN);
    return bookDays.has(day) && !w.isSpecial(day) && session.length >= MIN_INDEX_BARS && session[0]?.m === OPEN_MIN;
  });
  const optDays = Object.keys(man.pairs).map((k) => k.slice(0, 10)).sort();
  const first = optDays[0];
  const last = man.sessions.at(-1)!;
  const c: OptCtx = { sym, def: DEF[sym], x, man, index, days, daySet: new Set(days), first, last, nights: nightsBetween(w.cal.filter((d) => d >= first && d <= last), w.isSpecial), sess: new Map(), chains: new Map(), idx: new Map() };
  for (const entry of C_ENTRIES) {
    const rets: (number | null)[] = days.map((d) => {
      const s = idxOf(c, d);
      const a = s.lastUpTo(C_DAY_IN - 1)?.c;
      const b = s.lastUpTo(entry - 1)?.c;
      return a !== undefined && b !== undefined ? b / a - 1 : null;
    });
    const rk = trailingRank(rets, C2_WINDOW);
    const m = new Map<string, { ret: number; rank: number | null }>();
    days.forEach((d, i) => {
      if (rets[i] !== null) m.set(d, smoke ? { ret: [-0.01, 0.002, -0.003][i % 3], rank: rk[i] === null ? null : [0.1, 0.5, 0.25][i % 3] } : { ret: rets[i]!, rank: rk[i] });
    });
    c.sess.set(entry, m);
  }
  c.idx.clear();
  return c;
}

/** A contract's bars on a day, cached (the oldest of more than 64 cached days is dropped: nights are visited in date order). */
function chainOf(c: OptCtx, day: string, expiry: string): ChainDay | null {
  const k = `${day}_${expiry}`;
  if (!c.chains.has(k)) {
    const info = c.man.pairs[k];
    c.chains.set(k, info ? loadChainDay(c.x, c.sym, day, expiry, info.role) : null);
    if (c.chains.size > 64) c.chains.delete(c.chains.keys().next().value!);
  }
  return c.chains.get(k)!;
}

function idxOf(c: OptCtx, day: string): MinuteSeries {
  let s = c.idx.get(day);
  if (!s) {
    s = new MinuteSeries((c.index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= CLOSE_MIN));
    c.idx.set(day, s);
    if (c.idx.size > 64) c.idx.delete(c.idx.keys().next().value!);
  }
  return s;
}

/** The nearest listed expiry (the index's own bhavcopy) with at least `minDte` NSE sessions after `day` up to and including it. */
function expiryWithDte(data: ResearchData, sym: Sym, day: string, minDte: number): { expiry: string; dte: number } | null {
  for (const e of data.book.expiries(sym, day)) {
    const dte = data.book.sessionsToExpiry("NIFTY", day, e);
    if (dte >= minDte) return { expiry: e, dte };
  }
  return null;
}

/**
 * The synthetic forward known at an order at `entry`: the median over the three listed strikes nearest
 * the index level of K + C − P, each leg at its last close at or before entry − 1 that started within
 * the 5 minutes before the order; null when no strike has both.
 */
function forwardAt(chain: ChainDay, strikes: readonly number[], level: number, entry: number): number | null {
  const near = [...strikes].sort((a, b) => Math.abs(a - level) - Math.abs(b - level) || a - b).slice(0, 3);
  const est: number[] = [];
  for (const k of near) {
    const cb = chain.series.get(key(k, "CE"))?.lastUpTo(entry - 1);
    const pb = chain.series.get(key(k, "PE"))?.lastUpTo(entry - 1);
    if (cb && pb && cb.m >= entry - 5 && pb.m >= entry - 5) est.push(k + cb.c - pb.c);
  }
  return est.length ? median(est) : null;
}

interface LegRes {
  k: number;
  net: number;
  gross: number;
  charges: number;
  /** Per-unit entry and exit fills. */
  entryPx: number;
  exitPx: number;
  entryMin: number;
  exitMin: number;
  stale: boolean;
}

/** Every timing, strike and fill of one night, computed while the night's two chains are loaded. */
interface NightRec {
  d: string;
  e: string;
  kind: NightKind;
  skip?: string;
  expiry: string;
  dte: number;
  lot: number;
  prev: number | null;
  vixTercile: 0 | 1 | 2 | null;
  /** Per entry minute: the index level known at the order (the close of the bar before), the change from the previous close, the spot ATM and the forward's strike. */
  at: Map<number, { level: number; change: number | null; atm: number | null; fwd: number | null; kf: number | null }>;
  /** The index close at or before each exit minute on E. */
  levelExit: Map<number, number>;
  /** Family B legs (spot ATM): `${entry}|${exit}|${steps}|${mode}|${type}`, long. */
  legs: Map<string, LegRes | null>;
  /** Family C legs (the forward's strike ± steps): `${entry}|${exit}|${fsteps}|${mode}|${type}|${side}`. */
  fwdLegs: Map<string, LegRes | null>;
  /** C1's first-print exit (the 09:15 bar's open, to Dec 2024 only), entry 15:25, base strike: `${mode}|${type}|${side}`. */
  print: Map<string, LegRes | null>;
  /** C1's intraday placebo: the synthetic long over E's session 09:30 → 15:25, base strike, net ₹ by mode. */
  eSession: Map<Mode, number | null>;
}

const legKey = (entry: number, exit: number, steps: number, mode: Mode, t: OptType) => `${entry}|${exit}|${steps}|${mode}|${t}`;
const fwdKey = (entry: number, exit: number, fsteps: number, mode: Mode, t: OptType, side: "long" | "short") => `${entry}|${exit}|${fsteps}|${mode}|${t}|${side}`;

function legOf(rec: { lot: number }, c: OptCtx, d: string, e: string, strike: number, t: OptType, l: { entry: number; exit: number; entryMin: number; exitMin: number; staleExit: boolean }, side: "long" | "short", tag = ""): LegRes {
  const p = structurePnl([{ side, entry: l.entry, exit: l.exit, settled: false }], { lot: rec.lot, exchange: c.def.exchange, entryDate: d, exitDate: e, spread: () => 0 });
  if (SMOKE) {
    const z = `${c.sym}|${d}|${strike}|${t}|${side}|${l.entryMin}|${l.exitMin}|${tag}`;
    const entryPx = 100 + 20 * fake(`${z}|in`);
    return { k: strike, net: 800 * fake(z), gross: 800 * fake(z) + 60, charges: 60, entryPx, exitPx: entryPx * (1 + 0.4 * fake(`${z}|out`)), entryMin: l.entryMin, exitMin: l.exitMin, stale: l.staleExit };
  }
  return { k: strike, net: p.net, gross: p.gross, charges: p.charges, entryPx: l.entry, exitPx: l.exit, entryMin: l.entryMin, exitMin: l.exitMin, stale: l.staleExit };
}

function nightRec(w: World, c: OptCtx, n: Night, smoke: boolean): NightRec {
  const data = w.data;
  const rec: NightRec = { d: n.d, e: n.e, kind: n.kind, expiry: "", dte: NaN, lot: NaN, prev: null, vixTercile: w.vixPrev(n.d).tercile, at: new Map(), levelExit: new Map(), legs: new Map(), fwdLegs: new Map(), print: new Map(), eSession: new Map() };
  const skip = (s: string): NightRec => ({ ...rec, skip: s });
  if (n.spans.length) return skip("spans a special session");
  if (!c.daySet.has(n.d) || !c.daySet.has(n.e)) return skip("D or E not a valid 1-minute session");
  const ex = expiryWithDte(data, c.sym, n.d, MIN_DTE);
  if (!ex) return skip("no listed expiry with ≥ 2 sessions");
  const chainD = chainOf(c, n.d, ex.expiry);
  const chainE = chainOf(c, n.e, ex.expiry);
  if (!chainD || !chainE) return skip("contract missing from the dataset on D or E");
  const lot = lotOf(data, c.sym, n.d, ex.expiry);
  if (lot === null) return skip("no lot in the bhavcopy");
  rec.expiry = ex.expiry;
  rec.dte = ex.dte;
  rec.lot = lot;
  rec.prev = prevClose(w, c.sym, n.d);
  const idxD = idxOf(c, n.d);
  const idxE = idxOf(c, n.e);
  for (const m of [...new Set([...B_EXITS, ...C_EXITS])]) rec.levelExit.set(m, idxE.lastUpTo(m)?.c ?? NaN);
  const strikes = bothListed(chainD);
  const sorted = [...strikes].sort((a, b) => a - b);
  const shifted = (k: number, s: number) => {
    const i = sorted.indexOf(k);
    return i < 0 || i + s < 0 || i + s >= sorted.length ? null : sorted[i + s];
  };
  let cyc = 0;
  const run = (strike: number, t: OptType, side: "long" | "short", entry: number, exit: number, mode: Mode): LegRes | null => {
    const sD = chainD.series.get(key(strike, t));
    if (!sD) return null;
    const res = runOvernight({ legs: [{ entry: sD, exit: chainE.series.get(key(strike, t)) ?? null, side }], entryMin: entry, entryWait: ENTRY_WAIT, exitMin: exit, exitWait: EXIT_WAIT, mode });
    return "skip" in res ? null : legOf(rec, c, n.d, n.e, strike, t, res.legs[0], side);
  };
  for (const entry of [...new Set([...ENTRY_SET, ...C_ENTRIES])].sort((a, b) => a - b)) {
    const level = idxD.lastUpTo(entry - 1)?.c;
    if (level === undefined) continue;
    const atm = nearestListed(strikes, level);
    const fwd = forwardAt(chainD, strikes, level, entry);
    const kf = fwd === null ? null : nearestListed(strikes, fwd);
    const change = smoke ? [-0.02, 0.005, -0.004][cyc++ % 3] : rec.prev !== null ? level / rec.prev - 1 : null;
    rec.at.set(entry, { level, change, atm, fwd, kf });
    // Family B: long calls and the mirrored long puts, spot ATM ± steps.
    if (atm !== null && ENTRY_SET.includes(entry))
      for (const steps of B_STEPS)
        for (const t of ["CE", "PE"] as const) {
          const strike = itmStrike(strikes, atm, t, steps);
          for (const exit of B_EXITS) for (const mode of MODES) rec.legs.set(legKey(entry, exit, steps, mode, t), strike === null ? null : run(strike, t, "long", entry, exit, mode));
        }
    // Family C: both sides of the call and the put at the forward's strike ± 1.
    if (kf !== null && C_ENTRIES.includes(entry))
      for (const fs of C_STEPS) {
        const strike = shifted(kf, fs);
        for (const t of ["CE", "PE"] as const)
          for (const side of ["long", "short"] as const)
            for (const exit of C_EXITS) for (const mode of MODES) rec.fwdLegs.set(fwdKey(entry, exit, fs, mode, t, side), strike === null ? null : run(strike, t, side, entry, exit, mode));
      }
  }
  // C1's first-print exit and intraday placebo (base entry, base strike).
  const base = rec.at.get(C_ENTRY);
  if (base?.kf !== null && base?.kf !== undefined) {
    const k = base.kf;
    for (const mode of MODES)
      for (const t of ["CE", "PE"] as const)
        for (const side of ["long", "short"] as const) {
          const pk = `${mode}|${t}|${side}`;
          const sD = chainD.series.get(key(k, t));
          const first = chainE.series.get(key(k, t))?.at(OPEN_MIN);
          const eb = sD?.firstFrom(C_ENTRY, ENTRY_WAIT);
          if (n.e > ERA_END || !sD || !first || !eb) {
            rec.print.set(pk, null);
            continue;
          }
          const entryPx = mode === "mid" ? eb.c : side === "long" ? eb.h : eb.l;
          rec.print.set(pk, legOf(rec, c, n.d, n.e, k, t, { entry: entryPx, exit: first.o, entryMin: eb.m, exitMin: OPEN_MIN, staleExit: false }, side, "print"));
        }
    for (const mode of MODES) {
      let net: number | null = 0;
      for (const [t, side] of [["CE", "long"], ["PE", "short"]] as const) {
        const s = chainE.series.get(key(k, t));
        const res = s ? runPosition({ legs: [{ series: s, side }], entryMin: C_DAY_IN, entryWait: ENTRY_WAIT, exitMin: C_DAY_OUT, exitWait: EXIT_WAIT, stopFrac: null, mode }) : null;
        if (!res || net === null) {
          net = null;
          continue;
        }
        const l = res.legs[0];
        net += SMOKE ? 500 * fake(`${c.sym}|${n.e}|${t}|${mode}|session`) : structurePnl([{ side, entry: l.entry, exit: l.exit, settled: false }], { lot, exchange: c.def.exchange, entryDate: n.e, exitDate: n.e, spread: () => 0 }).net;
      }
      rec.eSession.set(mode, net);
    }
  }
  return rec;
}

/** Every night of an index's option sample, with every timing, strike and fill (cached chains; date order). */
function nightRecs(w: World, c: OptCtx, smoke: boolean): NightRec[] {
  return c.nights.filter((n) => n.d >= c.first && n.e <= c.last).map((n) => nightRec(w, c, n, smoke));
}

// ---------------------------------------------------------------------------
// B and C. Option runs (report §1.4–§1.5)
// ---------------------------------------------------------------------------

export interface Trade15 {
  /** D (the session whose close starts the night) and E. */
  day: string;
  exitDay: string;
  kind: NightKind;
  vixTercile: 0 | 1 | 2 | null;
  change: number | null;
  dte: number;
  lot: number;
  k: number;
  net: number;
  gross: number;
  charges: number;
  /** ₹ per lot paid (or, for a synthetic, the call's premium) at the entry fill. */
  premium: number;
  /** Per-unit entry and exit fills of the long call (the stop analysis). */
  entryPx: number;
  exitPx: number;
  entryMin: number;
  exitMin: number;
  stale: number;
  /** Index level used for the strike, at the exit, and the move between (+ when the index rose). */
  level: number;
  levelExit: number;
  move: number;
}

type OptFamily = "B" | "C1" | "C1B" | "C2";

interface OptRun {
  name: string;
  family: OptFamily;
  sym: Sym;
  filter: NightFilter;
  entry: number;
  exit: number;
  /** B: strikes in the money from the spot ATM; C: strikes from the forward's strike. */
  steps: number;
  mode: Mode;
  threshold: number;
  c2?: C2Threshold;
  kind: "strategy" | "perturbation";
  base?: string;
  label?: string;
  /** Nights the variant was evaluated on (both sides priced, the filter's inputs known), traded or not. */
  slots: string[];
  /** Every slot's net (traded or not), for C2's comparison with C1 on the same nights. */
  slotNet: Map<string, number>;
  trades: Trade15[];
  /** The opposite side on each traded night (the mirrored put for a call; the short synthetic for a synthetic), and C1's E-session placebo. */
  pairs: { day: string; s: number; o: number; session: number | null }[];
  skips: Record<string, number>;
}

const optName = (sym: Sym, f: NightFilter, entry: number, exit: number, steps: number, mode: Mode, threshold: number) =>
  `${sym} option night [${FILTER_LABEL[f]}${f === "selloff" && threshold !== SELLOFF ? ` ≤ ${pp(threshold, 1)}` : ""}] call ${stepLabel(steps)} D ${minToHhmm(entry)}→E ${minToHhmm(exit)} ${mode}`;
const cName = (fam: OptFamily, sym: Sym, entry: number, exit: number, fsteps: number, mode: Mode, c2?: C2Threshold) =>
  `${sym} R6 ${fam === "C1" ? "C1 synthetic long" : fam === "C1B" ? "C1-B long call" : `C2 synthetic long after a weak session [${c2!.label}]`} ${fstepLabel(fsteps)} D ${minToHhmm(entry)}→E ${minToHhmm(exit)} ${mode}`;

function emptyRun(o: Omit<OptRun, "slots" | "slotNet" | "trades" | "pairs" | "skips">): OptRun {
  return { ...o, slots: [], slotNet: new Map(), trades: [], pairs: [], skips: {} };
}

function tradeOf(rec: NightRec, a: { level: number; change: number | null }, leg: LegRes, net: number, gross: number, charges: number, exit: number): Trade15 {
  const levelExit = SMOKE ? a.level * (1 + 0.004 * fake(`${rec.d}|${exit}|move`)) : (rec.levelExit.get(exit) ?? NaN);
  return { day: rec.d, exitDay: rec.e, kind: rec.kind, vixTercile: rec.vixTercile, change: a.change, dte: rec.dte, lot: rec.lot, k: leg.k, net, gross, charges, premium: leg.entryPx * rec.lot, entryPx: leg.entryPx, exitPx: leg.exitPx, entryMin: leg.entryMin, exitMin: leg.exitMin, stale: leg.stale ? 1 : 0, level: a.level, levelExit, move: levelExit / a.level - 1 };
}

/** Family B: the long call (spot ATM ± steps) and the mirrored long put, on the nights a filter selects. */
function buildB(recs: readonly NightRec[], sym: Sym, filter: NightFilter, entry: number, exit: number, steps: number, mode: Mode, threshold = SELLOFF, kind: OptRun["kind"] = "strategy", base?: string, label?: string): OptRun {
  const r = emptyRun({ name: optName(sym, filter, entry, exit, steps, mode, threshold) + (label ? ` [${label}]` : ""), family: "B", sym, filter, entry, exit, steps, mode, threshold, kind, base, label });
  for (const rec of recs) {
    if (rec.skip) {
      bump(r.skips, rec.skip);
      continue;
    }
    const a = rec.at.get(entry);
    const ce = rec.legs.get(legKey(entry, exit, steps, mode, "CE"));
    const pe = rec.legs.get(legKey(entry, exit, steps, mode, "PE"));
    if (!a) {
      bump(r.skips, "no index level at the entry");
      continue;
    }
    if (!ce || !pe) {
      bump(r.skips, "a leg not listed, without an entry bar or without an exit price");
      continue;
    }
    if (needsChange(filter) && a.change === null) {
      bump(r.skips, "no previous close for the filter");
      continue;
    }
    r.slots.push(rec.d);
    if (!passesFilter(filter, { kind: rec.kind, change: a.change }, threshold)) continue;
    r.slotNet.set(rec.d, ce.net);
    r.trades.push(tradeOf(rec, a, ce, ce.net, ce.gross, ce.charges, exit));
    r.pairs.push({ day: rec.d, s: ce.net, o: pe.net, session: null });
  }
  return r;
}

/** C2's weak-session condition on D at an entry minute (null when the session return or its rank is unknown). */
function weak(c: OptCtx, d: string, entry: number, t: C2Threshold): boolean | null {
  const s = c.sess.get(entry)?.get(d);
  if (!s || s.rank === null) return null;
  return t.rank !== undefined ? s.rank < t.rank : s.ret < t.ret!;
}

/** Family C: R6's synthetic long (C1, C2) or single long call (C1-B) at the forward's strike ± fsteps. */
function buildC(c: OptCtx, recs: readonly NightRec[], fam: Exclude<OptFamily, "B">, entry: number, exit: number, fsteps: number, mode: Mode, c2?: C2Threshold, kind: OptRun["kind"] = "strategy", base?: string, label?: string): OptRun {
  const r = emptyRun({ name: cName(fam, c.sym, entry, exit, fsteps, mode, c2) + (label ? ` [${label}]` : ""), family: fam, sym: c.sym, filter: "all", entry, exit, steps: fsteps, mode, threshold: SELLOFF, c2, kind, base, label });
  for (const rec of recs) {
    if (rec.skip) {
      bump(r.skips, rec.skip);
      continue;
    }
    const a = rec.at.get(entry);
    if (!a || a.kf === null) {
      bump(r.skips, "no index level or no forward at the entry");
      continue;
    }
    const cl = rec.fwdLegs.get(fwdKey(entry, exit, fsteps, mode, "CE", "long"));
    const ps = rec.fwdLegs.get(fwdKey(entry, exit, fsteps, mode, "PE", "short"));
    const cs = rec.fwdLegs.get(fwdKey(entry, exit, fsteps, mode, "CE", "short"));
    const pl = rec.fwdLegs.get(fwdKey(entry, exit, fsteps, mode, "PE", "long"));
    if (!cl || !ps || !cs || !pl) {
      bump(r.skips, "a leg not listed, without an entry bar or without an exit price");
      continue;
    }
    let on = true;
    if (fam === "C2") {
      const wk = weak(c, rec.d, entry, c2!);
      if (wk === null) {
        bump(r.skips, "no session return rank yet (trailing 250)");
        continue;
      }
      on = wk;
    }
    const s = fam === "C1B" ? cl.net : cl.net + ps.net;
    const o = fam === "C1B" ? pl.net : cs.net + pl.net;
    r.slots.push(rec.d);
    r.slotNet.set(rec.d, s);
    if (!on) continue;
    const session = fam === "C1B" || entry !== C_ENTRY || exit !== C_EXIT || fsteps !== 0 ? null : (rec.eSession.get(mode) ?? null);
    r.trades.push(tradeOf(rec, a, cl, s, fam === "C1B" ? cl.gross : cl.gross + ps.gross, fam === "C1B" ? cl.charges : cl.charges + ps.charges, exit));
    r.pairs.push({ day: rec.d, s, o, session });
  }
  return r;
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
  /** The strategy minus a fair coin between it and the opposite side at the same minutes, paired by night. */
  gap: ReturnType<typeof pairedGap>;
  /** C1 only: the night minus the same synthetic over E's session (09:30 → 15:25), paired by night. */
  dayGap: ReturnType<typeof pairedGap> | null;
  /** Mean of the strategy + the opposite side (for a call: the straddle) over the same nights. */
  both: number;
  rets: number[];
}

function optSub(r: OptRun, label: string, f: (day: string) => boolean, resamples: number): OptSub {
  const slots = r.slots.filter(f);
  const ts = r.trades.filter((t) => f(t.day));
  const blocks = blocksOf(ts.map((t) => ({ block: t.day, net: t.net })), slots);
  const boot = dayBlockBootstrap(blocks, { resamples, seed: SEED });
  const nets = ts.map((t) => t.net);
  const pairBy = new Map(r.pairs.map((p) => [p.day, p]));
  const ps = ts.map((t) => pairBy.get(t.day)!);
  const gap = pairedGap(fairCoinDays(ps.map((p) => ({ s: p.s, o: p.o }))));
  const withSession = ps.filter((p) => p.session !== null);
  const dayGap = r.family === "C1" || r.family === "C2" ? pairedGap(withSession.map((p) => ({ n: 1, s: p.s, p: p.session! }))) : null;
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
    dayGap,
    both: avg(ps.map((p) => p.s + p.o)),
    rets: blocks.map((b) => sum(b.pnls) / CAPITAL),
  };
}

interface OptTail {
  worst: number;
  worstDay: string;
  best: number;
  bestDay: string;
  worst10: { day: string; net: number }[];
  var5: number;
  es5: number;
  var1: number;
  es1: number;
  withoutBest5: number;
  withoutBest10: number;
  maxDD: number;
  longestLosing: number;
  /** Share of nights whose one-lot premium exceeds ₹10,000 (the small account cannot buy it). */
  over10k: number;
  /** A stop at 30% / 50% below the call's entry fill: nights already below it at the exit fill, and the mean ₹/lot beyond the stop. */
  stops: { frac: number; gapped: number; share: number; beyond: number; meanLoss: number }[];
}

interface OptStats {
  full: OptSub;
  is: OptSub;
  oos: OptSub;
  era1: OptSub;
  era2: OptSub;
  oosEra1: OptSub;
  oosEra2: OptSub;
  half1: OptSub;
  half2: OptSub;
  /** Before and from the 1 Apr 2026 STT rise. */
  pre2026: OptSub;
  post2026: OptSub;
  years: { year: string; n: number; net: number; mean: number }[];
  byKind: { key: string; n: number; mean: number; lo: number; hi: number }[];
  byVix: { key: string; n: number; mean: number; lo: number; hi: number }[];
  sr: number;
  tail: OptTail;
  premium: number;
  charges: number;
  move: number;
  moveHit: number;
  stale: number;
}

function optTail(trades: readonly Trade15[]): OptTail {
  const nets = trades.map((t) => t.net);
  const sorted = [...trades].sort((a, b) => a.net - b.net);
  const total = sum(nets);
  const best = [...nets].sort((a, b) => b - a);
  let run = 0;
  let longest = 0;
  for (const t of trades) {
    run = t.net <= 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const t5 = tailRisk(nets, 0.05);
  const t1 = tailRisk(nets, 0.01);
  return {
    worst: sorted[0]?.net ?? NaN,
    worstDay: sorted[0]?.day ?? "",
    best: sorted.at(-1)?.net ?? NaN,
    bestDay: sorted.at(-1)?.day ?? "",
    worst10: sorted.slice(0, 10).map((t) => ({ day: t.day, net: t.net })),
    var5: t5.var,
    es5: t5.es,
    var1: t1.var,
    es1: t1.es,
    withoutBest5: total - sum(best.slice(0, 5)),
    withoutBest10: total - sum(best.slice(0, 10)),
    maxDD: maxDrawdown(nets).depth,
    longestLosing: longest,
    over10k: trades.length ? trades.filter((t) => t.premium > 10_000).length / trades.length : NaN,
    stops: STOP_FRACS.map((frac) => {
      const g = trades.map((t) => ({ t, s: gapThroughStop(t.entryPx, t.exitPx, frac) })).filter((z) => z.s.gapped);
      return { frac, gapped: g.length, share: trades.length ? g.length / trades.length : NaN, beyond: avg(g.map((z) => z.s.beyondStop * z.t.lot)), meanLoss: avg(g.map((z) => z.t.net)) };
    }),
  };
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
  const [h1] = halves(r.trades);
  const mid = h1.at(-1)?.day ?? "";
  return {
    full,
    is: sub("first 60%", (d) => d <= c, BOOT_SUB),
    oos,
    era1: sub("complete bars (to Dec 2024)", (d) => d <= ERA_END, BOOT_SUB),
    era2: sub("sampled bars (from Jan 2025)", (d) => d > ERA_END, BOOT_SUB),
    oosEra1: sub("last 40%, to Dec 2024", (d) => d > c && d <= ERA_END, BOOT_SUB),
    oosEra2: sub("last 40%, from Jan 2025", (d) => d > c && d > ERA_END, BOOT_SUB),
    half1: sub("first half", (d) => d <= mid, BOOT_LIGHT),
    half2: sub("second half", (d) => d > mid, BOOT_LIGHT),
    pre2026: sub("before 1 Apr 2026", (d) => d < STT_2026, BOOT_LIGHT),
    post2026: sub("from 1 Apr 2026", (d) => d >= STT_2026, BOOT_LIGHT),
    years,
    byKind: light ? [] : breakdown(r.trades.map((t) => ({ key: t.kind, x: t.net })), ["weekday", "weekend", "holiday"], 1),
    byVix: light ? [] : breakdown(r.trades.filter((t) => t.vixTercile !== null).map((t) => ({ key: TERCILE[t.vixTercile!], x: t.net })), TERCILE, 1),
    sr: sharpe(full.rets),
    tail: optTail(r.trades),
    premium: avg(r.trades.map((t) => t.premium)),
    charges: avg(r.trades.map((t) => t.charges)),
    move: avg(r.trades.map((t) => t.move)),
    moveHit: r.trades.length ? r.trades.filter((t) => t.move > 0).length / r.trades.length : NaN,
    stale: r.trades.length ? r.trades.filter((t) => t.stale).length / r.trades.length : NaN,
  };
}

/** C2 against C1 on the same out-of-sample nights: the CI of (C2's mean − the mean of every slot), and a random draw of C2's count from the slots. */
function c2Checks(r: OptRun, cut: string): { diff: number; lo: number; hi: number; pRandom: number; n: number; slots: number } {
  const slots = r.slots.filter((d) => d > cut);
  const traded = new Set(r.trades.filter((t) => t.day > cut).map((t) => t.day));
  const xs = slots.map((d) => r.slotNet.get(d)!);
  const on = slots.map((d) => traded.has(d));
  const k = on.filter(Boolean).length;
  const meanOn = avg(xs.filter((_, i) => on[i]));
  const diff = meanOn - avg(xs);
  const rnd = seededRandom(SEED);
  const diffs: number[] = [];
  for (let b = 0; b < BOOT_SUB && slots.length; b++) {
    let s = 0;
    let sOn = 0;
    let nOn = 0;
    for (let j = 0; j < slots.length; j++) {
      const i = Math.floor(rnd() * slots.length);
      s += xs[i];
      if (on[i]) {
        sOn += xs[i];
        nOn++;
      }
    }
    if (nOn) diffs.push(sOn / nOn - s / slots.length);
  }
  // A random draw of k slots without replacement (partial Fisher–Yates), C2_DRAWS times.
  let atLeast = 0;
  const idx = xs.map((_, i) => i);
  for (let b = 0; b < C2_DRAWS && k > 0; b++) {
    let s = 0;
    for (let j = 0; j < k; j++) {
      const z = j + Math.floor(rnd() * (idx.length - j));
      [idx[j], idx[z]] = [idx[z], idx[j]];
      s += xs[idx[j]];
    }
    if (s / k >= meanOn) atLeast++;
  }
  return { diff, lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975), pRandom: (1 + atLeast) / (1 + C2_DRAWS), n: k, slots: slots.length };
}

// ---------------------------------------------------------------------------
// The bar (report §1.6)
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
/** A placebo gap of at least 2 SE, with a positive, finite SE (a degenerate 0 ≥ 2 × 0 never passes). */
const gapOk = (gap: number, se: number) => se > 0 && gap >= 2 * se;
const idxPlaceboOk = (o: IdxSub) => gapOk(o.dayGap, o.dayGapSe) && gapOk(o.coinGap, o.coinGapSe);
const idxCore = (s: IdxStats) => s.oos.n > 0 && idxPlaceboOk(s.oos) && s.oos.boot.perTrade.lo > 0 && s.oos.boot.perSession.lo > 0 && s.oos.pf >= 1.3;
const placeboOk = (r: OptRun, o: OptSub) => gapOk(o.gap.gap, o.gap.se) && (o.dayGap === null || gapOk(o.dayGap.gap, o.dayGap.se));
const optCore = (r: OptRun, s: OptStats) => s.oos.n > 0 && s.oos.lo > 0 && s.oos.sessLo > 0 && s.oos.pf >= 1.3 && placeboOk(r, s.oos);

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

function judgeIdx(r: IdxRun, s: IdxStats, perts: { label: string; oosNet: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS} nights out of sample`, verdict: o.n >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} nights in the last 40% (${o.sessions} nights in its window)` });
  c.push({ name: "placebo gaps ≥ 2 SE: (a) E's open → close on the same nights, (b) a fair-coin side", verdict: idxPlaceboOk(o) ? "PASS" : "FAIL", detail: `(a) ${bp(o.dayGap)} per night, SE ${bp(o.dayGapSe)} (${fx(o.dayGap / o.dayGapSe)} SE; E's open → close ${bp(o.dayMean)}); (b) ${bp(o.coinGap)}, SE ${bp(o.coinGapSe)} (${fx(o.coinGap / o.coinGapSe)} SE); hit ${pct(o.hit)} (Wilson ${pct(o.hitLo)} … ${pct(o.hitHi)})` });
  c.push({ name: `block-bootstrap 95% CI > 0 per night and per session (blocks of ${INDEX_BLOCK})`, verdict: o.boot.perTrade.lo > 0 && o.boot.perSession.lo > 0 ? "PASS" : "FAIL", detail: `${bp(o.mean)} per night (${bp(o.boot.perTrade.lo)} … ${bp(o.boot.perTrade.hi)}); per session ${bp(o.boot.perSession.estimate)} (${bp(o.boot.perSession.lo)} … ${bp(o.boot.perSession.hi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (r.subset !== "selloff") c.push({ name: "±20% robustness", verdict: "N/A", detail: "the subset has no parameter to perturb" });
  else if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for variants that pass the placebos, the CI and the PF out of sample" });
  else {
    const base = sum(o.rets);
    const rb = robustness(base, perts.map((p) => p.oosNet));
    c.push({ name: "±20% robustness (sell-off threshold −0.8% / −1.2%)", verdict: rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; ${perts.map((p) => `${p.label} ${bp(p.oosNet, 0)}`).join(", ")} vs base ${bp(base, 0)} (summed)` });
  }
  const mt = multipleTesting(o.rets, o.boot.perTrade.p, o.boot.perSession.p, ledgerN, srVar);
  c.push(mt.c);
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

function judgeOpt(r: OptRun, s: OptStats, perts: { label: string; oosNet: number }[] | null, ledgerN: number, srVar: number | null, c2: ReturnType<typeof c2Checks> | null, r6: Criterion[] | null = null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  const opposite = r.family === "B" || r.family === "C1B" ? "the mirrored put" : "the short synthetic";
  c.push({ name: `≥ ${MIN_OOS} trades out of sample`, verdict: o.n >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} trades in the last 40% (${o.sessions} nights)` });
  c.push({
    name: `placebo gap ≥ 2 SE (a fair coin between the position and ${opposite}, same minutes${o.dayGap ? "; and the same synthetic over E's session 09:30 → 15:25" : ""})`,
    verdict: placeboOk(r, o) ? "PASS" : "FAIL",
    detail: `gap ${rs(o.gap.gap)} per trade, SE ${rs(o.gap.se)} (${fx(o.gap.t)} SE); position + opposite ${rs(o.both)} a night${o.dayGap ? `; vs E's session ${rs(o.dayGap.gap)}, SE ${rs(o.dayGap.se)} (${fx(o.dayGap.t)} SE, ${o.dayGap.trades} nights)` : ""}`,
  });
  c.push({ name: "night-clustered 95% CI > 0 per trade and per session", verdict: o.lo > 0 && o.sessLo > 0 ? "PASS" : "FAIL", detail: `${rs(o.mean)}/trade (${rs(o.lo)} … ${rs(o.hi)}); per session ${rs(o.boot.perSession.estimate)} (${rs(o.sessLo)} … ${rs(o.sessHi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for variants that pass the placebo, the CI and the PF out of sample" });
  else {
    const rb = robustness(o.net, perts.map((p) => p.oosNet));
    c.push({ name: "±20% robustness", verdict: rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; ${perts.map((p) => `${p.label} ${rs(p.oosNet)}`).join(", ")} vs base ${rs(o.net)}` });
  }
  const mt = multipleTesting(o.rets, o.boot.perTrade.p, o.boot.perSession.p, ledgerN, srVar);
  c.push(mt.c);
  const e1 = s.era1;
  c.push({ name: "complete-bar era (to Dec 2024, all nights): mean > 0, CI > 0", verdict: e1.n > 0 && e1.lo > 0 ? "PASS" : "FAIL", detail: `${e1.n} trades, ${rs(e1.mean)}/trade (${rs(e1.lo)} … ${rs(e1.hi)}); sampled era ${s.era2.n} trades, ${rs(s.era2.mean)}` });
  if (c2) c.push({ name: "C2 beats C1 on the same nights (CI of the difference > 0) and a random draw of the same count (p < 0.05)", verdict: c2.lo > 0 && c2.pRandom < 0.05 ? "PASS" : "FAIL", detail: `C2 − C1 ${rs(c2.diff)} a night (${rs(c2.lo)} … ${rs(c2.hi)}), ${c2.n} of ${c2.slots} nights; random draw p ${fx(c2.pRandom, 3)}` });
  if (r6) c.push(...r6);
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

/**
 * R6's own pass and kill rules for its variants (report §1.5): the same sign on the other index (last
 * 40% mean > 0 at the same fill); a net above zero on the nights from 1 Apr 2026 (the STT rise); and not
 * an opening-print artefact: on the complete-bar nights (to Dec 2024), a gain at the first print that
 * is gone by R6's 09:30 exit kills the variant.
 */
function r6Extras(p: OptRun, s: OptStats, picks: readonly OptRun[], stats: ReadonlyMap<string, OptStats>, recs: readonly NightRec[]): Criterion[] {
  const out: Criterion[] = [];
  const other = picks.find((z) => z.family === p.family && z.sym !== p.sym && z.mode === p.mode);
  const os = other ? stats.get(other.name) : undefined;
  out.push({ name: `R6: the same sign on ${other?.sym ?? "the other index"} (last 40% mean > 0)`, verdict: os && os.oos.mean > 0 ? "PASS" : "FAIL", detail: os ? `${other!.sym} ${other!.family}${other!.c2 ? ` (${other!.c2.label})` : ""}, ${other!.mode}: last 40% ${rs(os.oos.mean)} (${os.oos.n})` : "no such variant" });
  out.push({ name: "R6 kill check 1: net > 0 on the nights from 1 Apr 2026", verdict: s.post2026.n > 0 && s.post2026.mean > 0 ? "PASS" : "FAIL", detail: `${s.post2026.n} nights, ${rs(s.post2026.mean)} a night` });
  if (p.entry === C_ENTRY && p.exit === C_EXIT && p.steps === 0) {
    const days = new Set(p.trades.filter((t) => t.day <= ERA_END && t.exitDay <= ERA_END).map((t) => t.day));
    const legs = (r: NightRec, f: (t: OptType, side: "long" | "short") => LegRes | null | undefined) => (p.family === "C1B" ? f("CE", "long")?.net : sumOrU(f("CE", "long")?.net, f("PE", "short")?.net));
    const rows = recs
      .filter((r) => days.has(r.d))
      .map((r) => [legs(r, (t, side) => r.print.get(`${p.mode}|${t}|${side}`)), legs(r, (t, side) => r.fwdLegs.get(fwdKey(C_ENTRY, C_EXIT, 0, p.mode, t, side)))])
      .filter((z): z is [number, number] => z[0] !== undefined && z[1] !== undefined);
    const atPrint = avg(rows.map((z) => z[0]));
    const at0930 = avg(rows.map((z) => z[1]));
    out.push({ name: "R6 kill check 2: not an opening-print artefact (complete-bar nights)", verdict: rows.length > 0 && !(atPrint > 0 && !(at0930 > 0)) ? "PASS" : "FAIL", detail: `${rows.length} nights: exit at the first print (09:15 open) ${rs(atPrint)}, at 09:30 ${rs(at0930)} a night` });
  }
  return out;
}

/** Family B's ±20% perturbations (report §1.6): entry, exit and strike step (and the sell-off threshold). */
function bPerturbations(p: OptRun): { label: string; entry: number; exit: number; steps: number; threshold: number }[] {
  const out: { label: string; entry: number; exit: number; steps: number; threshold: number }[] = [];
  for (const e of ENTRY_SET.filter((m) => m !== p.entry)) out.push({ label: `entry ${minToHhmm(e)}`, entry: e, exit: p.exit, steps: p.steps, threshold: p.threshold });
  const others = EXITS.filter((m) => m !== p.exit);
  const nearest = others.reduce((a, b) => (Math.abs(b - p.exit) < Math.abs(a - p.exit) ? b : a));
  for (const x of [nearest, EXIT_LATE]) out.push({ label: `exit ${minToHhmm(x)}`, entry: p.entry, exit: x, steps: p.steps, threshold: p.threshold });
  for (const s of [p.steps - 1, p.steps + 1]) out.push({ label: `strike ${stepLabel(s)}`, entry: p.entry, exit: p.exit, steps: s, threshold: p.threshold });
  if (p.filter === "selloff") for (const t of SELLOFF_PERTS) out.push({ label: `sell-off ≤ ${pp(t, 1)}`, entry: p.entry, exit: p.exit, steps: p.steps, threshold: t });
  return out;
}

/** Family C's perturbations (R6 §6): entry 15:20 / 15:28, exit 09:20 / 09:45, strike ±1; C2 also its threshold × 0.8 / × 1.2. */
function cPerturbations(p: OptRun): { label: string; entry: number; exit: number; fsteps: number; c2?: C2Threshold }[] {
  const out: { label: string; entry: number; exit: number; fsteps: number; c2?: C2Threshold }[] = [];
  for (const e of C_ENTRIES.filter((m) => m !== p.entry)) out.push({ label: `entry ${minToHhmm(e)}`, entry: e, exit: p.exit, fsteps: p.steps, c2: p.c2 });
  for (const x of ["09:20", "09:45"].map(hhmmToMin)) out.push({ label: `exit ${minToHhmm(x)}`, entry: p.entry, exit: x, fsteps: p.steps, c2: p.c2 });
  for (const s of [p.steps - 1, p.steps + 1]) out.push({ label: `strike ${fstepLabel(s)}`, entry: p.entry, exit: p.exit, fsteps: s, c2: p.c2 });
  if (p.c2)
    for (const f of [0.8, 1.2]) {
      const t: C2Threshold = p.c2.rank !== undefined ? { label: `bottom ${(p.c2.rank * f * 100).toFixed(1)}%`, rank: p.c2.rank * f } : { label: `below ${pp(p.c2.ret! * f, 2)}`, ret: p.c2.ret! * f };
      out.push({ label: `threshold ${t.label}`, entry: p.entry, exit: p.exit, fsteps: p.steps, c2: t });
    }
  return out;
}

// ---------------------------------------------------------------------------
// D. Descriptive series (report §1.7)
// ---------------------------------------------------------------------------

interface Desc {
  name: string;
  unit: "return" | "rupees";
  n: number;
  mean: number;
  lo: number;
  hi: number;
  up: number;
  upLo: number;
  upHi: number;
  extra?: string;
}

/** Mean with a block-bootstrap CI (blocks of `block` observations) and the share above zero with its Wilson interval. */
function describe(name: string, unit: Desc["unit"], xs: readonly number[], block: number, extra?: string): Desc {
  const n = xs.length;
  const boot = n ? blockBootstrap(xs, xs.map(() => true), { block, resamples: BOOT_SUB, seed: SEED }) : null;
  const up = xs.filter((v) => v > 0).length;
  const wl = wilson(up, n);
  return { name, unit, n, mean: avg(xs), lo: boot ? boot.perTrade.lo : NaN, hi: boot ? boot.perTrade.hi : NaN, up: n ? up / n : NaN, upLo: wl.lo, upHi: wl.hi, extra };
}

interface FutNight {
  d: string;
  e: string;
  expiry: string;
  /** E's open ÷ D's closing price − 1 (and ÷ D's last trade − 1, NSE UDiFF only). */
  r: number;
  rLast: number | null;
  lot: number;
  /** ₹ per lot of a long futures position from D's closing price to E's open, and the sell-side STT at E's open. */
  rupees: number;
  stt: number;
}

/** Near-month futures (the nearest expiry after D that traded on D and on E), from the index's own bhavcopy. */
function futuresNights(w: World, sym: Sym): { nights: FutNight[]; skips: Record<string, number> } {
  const book = w.data.book;
  const skips: Record<string, number> = {};
  const nights: FutNight[] = [];
  const own = new Set(book.dates(sym));
  for (const n of nightsBetween(w.cal.filter((d) => d >= bhavFrom(w.data, sym)), w.isSpecial)) {
    if (n.spans.length) {
      bump(skips, "spans a special session");
      continue;
    }
    if (!own.has(n.d) || !own.has(n.e)) {
      bump(skips, "no bhavcopy of the index's exchange on D or E");
      continue;
    }
    const a = book.futures(sym, n.d).find((r) => r.expiry > n.d && r.contracts > 0 && r.close !== null && r.close > 0);
    if (!a) {
      bump(skips, "no traded futures contract on D");
      continue;
    }
    const b = book.futures(sym, n.e).find((r) => r.expiry === a.expiry);
    if (!b || !(b.contracts > 0) || b.open === null || !(b.open > 0)) {
      bump(skips, "the contract did not trade on E");
      continue;
    }
    const lot = a.lot ?? NaN;
    if (SMOKE) {
      const r = 0.004 * fake(`${sym}|${n.d}|fut`);
      nights.push({ d: n.d, e: n.e, expiry: a.expiry, r, rLast: a.last !== null ? r : null, lot, rupees: r * 1e6, stt: 50 });
      continue;
    }
    nights.push({ d: n.d, e: n.e, expiry: a.expiry, r: b.open / a.close! - 1, rLast: a.last !== null && a.last > 0 ? b.open / a.last - 1 : null, lot, rupees: (b.open - a.close!) * lot, stt: (b.open * lot * futStt(n.e)) / 100 });
  }
  return { nights, skips };
}

interface EodCall {
  d: string;
  e: string;
  k: number;
  lot: number;
  premium: number;
  net: number;
}

/** The ATM call at the exchange's closing price on D, sold at E's first trade (bhavcopy; WP6's night leg with N4's contract). */
function eodCalls(w: World, sym: Sym): { calls: EodCall[]; skips: Record<string, number> } {
  const book = w.data.book;
  const skips: Record<string, number> = {};
  const calls: EodCall[] = [];
  const own = new Set(book.dates(sym));
  for (const n of nightsBetween(w.cal.filter((d) => d >= bhavFrom(w.data, sym)), w.isSpecial)) {
    if (n.spans.length) {
      bump(skips, "spans a special session");
      continue;
    }
    if (!own.has(n.d) || !own.has(n.e)) {
      bump(skips, "no bhavcopy of the index's exchange on D or E");
      continue;
    }
    const ex = expiryWithDte(w.data, sym, n.d, MIN_DTE);
    const level = spotClose(w.data, DEF[sym], n.d);
    const lev2 = spotClose(w.data, DEF[sym], n.e);
    if (!ex || level === null || lev2 === null) {
      bump(skips, "no contract with ≥ 2 sessions or no index close");
      continue;
    }
    const strikes = book.strikes(sym, n.d, ex.expiry).filter((k) => {
      const r = book.option(sym, n.d, ex.expiry, k, "CE");
      return r !== undefined && r.contracts > 0 && r.close !== null && r.close > 0;
    });
    const k = nearestListed(strikes, level);
    const a = k === null ? undefined : book.option(sym, n.d, ex.expiry, k, "CE");
    const b = k === null ? undefined : book.option(sym, n.e, ex.expiry, k, "CE");
    if (k === null || !a || !b || !(b.contracts > 0) || b.open === null || !(b.open > 0)) {
      bump(skips, "the ATM call did not trade on D or E");
      continue;
    }
    if (badPrint(b.open, a.close, lev2 / level - 1)) {
      bump(skips, "a bad opening print (WP6's filter)");
      continue;
    }
    const lot = a.lot ?? lotOf(w.data, sym, n.d, ex.expiry) ?? NaN;
    const p = structurePnl([{ side: "long", entry: a.close!, exit: b.open, settled: false }], { lot, exchange: DEF[sym].exchange, entryDate: n.d, exitDate: n.e, spread: () => 0 });
    calls.push({ d: n.d, e: n.e, k, lot, premium: SMOKE ? 8000 : a.close! * lot, net: SMOKE ? 600 * fake(`${sym}|${n.d}|eod`) : p.net });
  }
  return { calls, skips };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");
const DATA_IDX: Record<Sym, string> = { NIFTY: "Yahoo ^NSEI daily (official open and close), nights 2011-01..2026-10", SENSEX: "Yahoo ^BSESN daily (official open and close), nights 2011-01..2026-10" };
const DATA_1M: Record<Sym, string> = {
  NIFTY: "TradeMarkk 1-minute NIFTY options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract, nights 2021-05..2026-07; lots, expiries and holidays from the NSE bhavcopy cache",
  SENSEX: "TradeMarkk 1-minute SENSEX options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract, nights 2023-08..2026-07; lots and expiries from the BSE bhavcopy cache",
};

function idxTrial(r: IdxRun, s: IdxStats): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: r.name,
    params: { family: "index overnight", index: r.sym, subset: r.subset, ...(r.subset === "selloff" ? { selloff: r.threshold } : {}), entry: "D official close", exit: "E (the next regular session) official open", side: "long", unit: "index basis points, not rupees", ...(r.label ? { perturbation: r.label } : {}) },
    data: DATA_IDX[r.sym],
    trades: s.full.n,
    net: Math.round(sum(s.full.rets) * 1e4 * 100) / 100,
    notes: `index overnight ${r.kind}; net and mean in index basis points (not ₹); per night ${bp(s.full.mean, 2)} (block-${INDEX_BLOCK} 95% CI ${bp(s.full.boot.perTrade.lo, 2)}..${bp(s.full.boot.perTrade.hi, 2)}), hit ${pct(s.full.hit)}, PF ${fx(s.full.pf)}; E's open→close ${bp(s.full.dayMean, 2)}; first 60% ${bp(s.is.mean, 2)} (${s.is.n}), last 40% ${bp(s.oos.mean, 2)} (${s.oos.n})`,
    kind: r.kind,
    account: "main",
    sessions: s.full.sessions,
    meanPerTrade: Math.round(s.full.mean * 1e4 * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

function optTrial(r: OptRun, s: OptStats): TrialRecord {
  const structure = r.family === "B" ? `long call, ${stepLabel(r.steps)} (spot), one lot` : r.family === "C1B" ? `long call at ${fstepLabel(r.steps)}, one lot (R6 C1-B)` : `synthetic long (long call + short put) at ${fstepLabel(r.steps)}, one lot (R6 ${r.family}${r.c2 ? `, ${r.c2.label}` : ""}; ₹5 lakh account only: margin)`;
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: r.name,
    params: { family: r.family === "B" ? "option overnight" : `option overnight R6 ${r.family}`, index: r.sym, filter: r.family === "C2" ? `weak session: ${r.c2!.label}` : r.filter, ...(r.filter === "selloff" ? { selloff: r.threshold } : {}), structure, entry: `D ${minToHhmm(r.entry)}`, exit: `E ${minToHhmm(r.exit)}`, minDte: MIN_DTE, fill: r.mode, ...(r.label ? { perturbation: r.label } : {}) },
    data: DATA_1M[r.sym],
    trades: s.full.n,
    net: Math.round(s.full.net * 100) / 100,
    notes: `${r.family === "B" ? "option overnight" : `R6 ${r.family}`} ${r.kind}; ${r.mode === "conservative" ? "conservative (buy at the 1-min high, sell at the low)" : "mid (the 1-min close)"}; ₹/lot per trade ${fx(s.full.mean)} (night-block 95% CI ${fx(s.full.lo)}..${fx(s.full.hi)}), PF ${fx(s.full.pf)}; first 60% ${fx(s.is.mean)} (${s.is.n}), last 40% ${fx(s.oos.mean)} (${s.oos.n}); fair-coin placebo gap ${fx(s.full.gap.gap)} (${fx(s.full.gap.t)} SE); one lot at the lot in force; dated charges`,
    kind: r.kind,
    account: "main",
    sessions: s.full.sessions,
    meanPerTrade: Math.round(s.full.mean * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

function descTrial(d: Desc, family: string, data: string): TrialRecord {
  const k = d.unit === "return" ? 1e4 : 1;
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: `${family}: ${d.name}`,
    params: { family, unit: d.unit === "return" ? "index or futures return, basis points summed (not rupees)" : "₹ per lot" },
    data,
    trades: d.n,
    net: Number.isFinite(d.mean) ? Math.round(d.mean * d.n * k * 100) / 100 : 0,
    notes: `descriptive ${family}; mean ${d.unit === "return" ? bp(d.mean, 2) : rs(d.mean)} (95% CI ${d.unit === "return" ? `${bp(d.lo, 2)}..${bp(d.hi, 2)}` : `${rs(d.lo)}..${rs(d.hi)}`}), above zero ${pct(d.up)} (Wilson ${pct(d.upLo)}..${pct(d.upHi)}), n ${d.n}${d.extra ? `; ${d.extra}` : ""}`,
    kind: "strategy",
    account: "main",
    meanPerTrade: Number.isFinite(d.mean) ? Math.round(d.mean * k * 100) / 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

interface Inputs {
  nsei: string;
  bsesn: string;
  vix: string;
  x: string;
  dir: string;
  oi?: string;
  outDir: string;
}

function inputs(args: ReturnType<typeof parseArgs>): Inputs {
  return {
    nsei: str(args, "nsei") ?? fail("--nsei <Yahoo ^NSEI daily json> is required"),
    bsesn: str(args, "bsesn") ?? fail("--bsesn <Yahoo ^BSESN daily json> is required"),
    vix: str(args, "vix") ?? fail("--vix <Yahoo ^INDIAVIX daily json> is required"),
    x: str(args, "x") ?? fail("--x <WP13 extract dir> is required"),
    dir: str(args, "dir") ?? fail("--dir <bhavcopy cache> is required"),
    oi: str(args, "oi"),
    outDir: resolve(ROOT, str(args, "out", "reports/wp15")!),
  };
}

const loadData = (I: Inputs) => loadResearchData({ from: "2019-02-01", to: "2026-10-09", dir: I.dir });

// ---------------------------------------------------------------------------
// coverage: data, samples and cut dates (no returns, no P&L)
// ---------------------------------------------------------------------------

async function coverage(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const data = await loadData(I);
  const w = buildWorld(I, data);
  const out: string[] = ["# WP15 coverage (generated; bars, sessions and counts only: no overnight mean, no conditional return, no P&L)\n"];
  const summary: Record<string, unknown> = {};

  // 1. The daily index series (data quality only).
  const cache = existsSync(resolve(I.dir, "index-daily.json")) ? (JSON.parse(readFileSync(resolve(I.dir, "index-daily.json"), "utf8")) as { series: Record<string, { t: number; o: number; c: number }[]> }).series : {};
  const dq: (string | number)[][] = [["index", "rows from Dec 2010", "rows with a missing field (from 2011)", "regular sessions from 2011 without a complete bar", "opens equal to the previous close (from 2011)", "open or close outside the high–low", "vs the bhavcopy cache's Yahoo download (Oct 2016–): days, differing > 0.5 pt", "vs the official close in NSE's UDiFF bhavcopy (2024-01-08–): days, differing > 0.5 pt"]];
  const dqNotes: string[] = [];
  for (const sym of SYMS) {
    const ys = [...w.bars[sym]].filter(([d]) => d >= "2010-12-01").sort(([a], [b]) => a.localeCompare(b));
    const nulls = ys.filter(([d, b]) => !b && d >= FIRST_NIGHT).map(([d]) => d);
    const regNo = w.reg.filter((d) => d >= FIRST_NIGHT && d <= "2026-10-08" && !w.bars[sym].get(d));
    const stale: string[] = [];
    const outside: string[] = [];
    let prevC: number | null = null;
    for (const [d, b] of ys) {
      if (!b) continue;
      if (d >= FIRST_NIGHT && prevC !== null && Math.abs(b.o - prevC) < 1e-9) stale.push(d);
      if (b.o > b.h + 1e-6 || b.o < b.l - 1e-6 || b.c > b.h + 1e-6 || b.c < b.l - 1e-6) outside.push(d);
      prevC = b.c;
    }
    let cmp = 0;
    let cmpDiff = 0;
    for (const cb of cache[DEF[sym].yahoo] ?? []) {
      const b = w.bars[sym].get(new Date(cb.t + 330 * 60_000).toISOString().slice(0, 10));
      if (!b) continue;
      cmp++;
      if (Math.abs(b.o - cb.o) > 0.5 || Math.abs(b.c - cb.c) > 0.5) cmpDiff++;
    }
    let off = 0;
    let offDiff = 0;
    const offList: string[] = [];
    if (sym === "NIFTY")
      for (const d of data.book.dates("NIFTY")) {
        const u = data.book.rows("NIFTY", d).find((r) => r.underlying !== null && r.underlying > 0)?.underlying;
        const b = w.bars.NIFTY.get(d);
        if (!u || !b) continue;
        off++;
        if (Math.abs(b.c - u) > 0.5) {
          offDiff++;
          offList.push(`${d} (${fx(b.c)} vs ${fx(u)})`);
        }
      }
    dq.push([sym, ys.length, `${nulls.length}${nulls.length ? ` (${nulls.join(", ")})` : ""}`, `${regNo.length}${regNo.length ? ` (${regNo.join(", ")})` : ""}`, `${stale.length}${stale.length ? ` (${stale.join(", ")})` : ""}`, outside.length, `${cmp}, ${cmpDiff}`, sym === "NIFTY" ? `${off}, ${offDiff}` : "– (BSE's file has no index close)"]);
    if (offList.length) dqNotes.push(`${sym} closes differing from the UDiFF underlying close by more than 0.5 point: ${offList.slice(0, 20).join(", ")}${offList.length > 20 ? ", …" : ""}.`);
  }
  // Yahoo against the 1-minute index bars, and the two indices' gaps against each other (bad opens show as disagreements).
  const minuteRows: (string | number)[][] = [["index", "1-minute sessions compared", "|Yahoo open ÷ 09:15 bar open − 1|: median, p99, max", "|Yahoo close ÷ last 1-minute close − 1|: median"]];
  const ctxs = new Map<Sym, OptCtx>();
  for (const sym of SYMS) {
    const c = optCtx(w, sym, I.x, false);
    ctxs.set(sym, c);
    const od: number[] = [];
    const cd: number[] = [];
    for (const d of c.days) {
      const b = w.bars[sym].get(d);
      const s = idxOf(c, d);
      const f = s.at(OPEN_MIN);
      const l = s.lastUpTo(LAST_BAR);
      if (!b || !f || !l) continue;
      od.push(Math.abs(f.o / b.o - 1));
      cd.push(Math.abs(l.c / b.c - 1));
    }
    minuteRows.push([sym, od.length, `${(median(od) * 1e4).toFixed(2)} bp, ${(quantile(od, 0.99) * 1e4).toFixed(1)} bp, ${(Math.max(...od) * 1e4).toFixed(1)} bp`, `${(median(cd) * 1e4).toFixed(2)} bp`]);
  }
  const gapAgree: (string | number)[][] = [["years", "nights with both indices", "correlation of the two close → open gaps", "nights where the gaps differ by > 0.5 pp", "by > 1 pp"]];
  const both = new Map<string, { n: number; s: number }>();
  const nN = indexNights(w, "NIFTY", false).nights;
  const sN = new Map(indexNights(w, "SENSEX", false).nights.map((o) => [o.d, o]));
  const pairsByYear = new Map<string, [number, number][]>();
  for (const o of nN) {
    const s = sN.get(o.d);
    if (!s || s.e !== o.e) continue;
    const y = o.d.slice(0, 4);
    if (!pairsByYear.has(y)) pairsByYear.set(y, []);
    pairsByYear.get(y)!.push([o.r, s.r]);
  }
  const corr = (xy: [number, number][]) => {
    const mx = avg(xy.map((z) => z[0]));
    const my = avg(xy.map((z) => z[1]));
    const cov = sum(xy.map((z) => (z[0] - mx) * (z[1] - my)));
    const vx = sum(xy.map((z) => (z[0] - mx) ** 2));
    const vy = sum(xy.map((z) => (z[1] - my) ** 2));
    return cov / Math.sqrt(vx * vy);
  };
  for (const [y, xy] of [...pairsByYear].sort(([a], [b]) => a.localeCompare(b))) {
    gapAgree.push([y, xy.length, fx(corr(xy), 3), xy.filter((z) => Math.abs(z[0] - z[1]) > 0.005).length, xy.filter((z) => Math.abs(z[0] - z[1]) > 0.01).length]);
    both.set(y, { n: xy.length, s: 0 });
  }
  const bigDisagree = nN.filter((o) => sN.get(o.d)?.e === o.e && Math.abs(o.r - sN.get(o.d)!.r) > 0.01).map((o) => o.d);
  out.push(`## 1. The daily index series (Yahoo; data quality only)\n\n${md(dq)}\n\n${dqNotes.join("\n\n")}\n\n**Yahoo against the 1-minute index bars** (TradeMarkk):\n\n${md(minuteRows)}\n\n**The two indices' close → open gaps against each other** (a bad open on one index shows as a disagreement; no mean is computed):\n\n${md(gapAgree)}\n\nNights whose NIFTY and SENSEX gaps differ by more than 1 pp: ${bigDisagree.join(", ") || "none"}.\n`);
  summary.dataQuality = { dq, minuteRows, gapAgree, bigDisagree };

  // 2. Calendar and nights.
  const yearsRows: (string | number)[][] = [["year", "regular sessions", "special sessions", "weekday holidays (no session)"]];
  for (let y = 2011; y <= 2026; y++) {
    const ys = String(y);
    const regY = w.reg.filter((d) => d.startsWith(ys)).length;
    const spY = [...w.special].filter((d) => d.startsWith(ys)).length;
    let hol = 0;
    const calSet = new Set(w.cal);
    for (let t = Date.parse(`${ys}-01-01T00:00:00Z`); t <= Date.parse(`${ys}-12-31T00:00:00Z`) && new Date(t).toISOString().slice(0, 10) <= "2026-10-08"; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (weekdayOf(d) <= 5 && !calSet.has(d)) hol++;
    }
    yearsRows.push([ys, regY, spY, hol]);
  }
  const specials = [...w.special].filter((d) => d >= FIRST_NIGHT).sort();
  const nightRows: (string | number)[][] = [["index", "candidate nights (D from 2011)", "skipped (by reason)", "valid nights", "weekday / weekend / holiday", "after a down day / an up day / a sell-off ≤ −1% (counts)", "change unknown", "**cut after** (the last D of the first 60%)", "last 40% nights: all / weekday / weekend and holiday / down / up / sell-off"]];
  const cuts: Record<string, string | null> = {};
  for (const sym of SYMS) {
    const { nights, skips, candidates } = indexNights(w, sym, false);
    const cut = cutDate(nights.map((o) => o.d), IS_FRAC);
    cuts[sym] = cut;
    const cnt = (f: NightFilter, xs: IdxNight[]) => xs.filter((o) => passesFilter(f, o, SELLOFF)).length;
    const oos = nights.filter((o) => o.d > (cut ?? ""));
    nightRows.push([sym, candidates, Object.entries(skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–", nights.length, `${cnt("weekday", nights)} / ${nights.filter((o) => o.kind === "weekend").length} / ${nights.filter((o) => o.kind === "holiday").length}`, `${cnt("down", nights)} / ${cnt("up", nights)} / ${cnt("selloff", nights)}`, nights.filter((o) => o.change === null).length, cut ?? "–", IDX_SUBSETS.map((f) => cnt(f, oos)).join(" / ")]);
  }
  const vixCov = nN.filter((o) => o.vixTercile !== null);
  out.push(`\n## 2. Sessions and nights\n\n- Calendar: ${w.cal.length} sessions (${w.cal[0]} … ${w.cal.at(-1)}), from complete Yahoo bars of either index (from Dec 2010), the NSE bhavcopy (${data.book.dates("NIFTY")[0]} …), the BSE bhavcopy (${data.book.dates("SENSEX")[0]} …) and ${w.oiDates.size} NSE participant-OI file dates (${[...w.oiDates].sort()[0] ?? "–"} …).\n- Special sessions from 2011 (weekend, Muhurat, or short by the bhavcopy's volume): ${specials.length}: ${specials.join(", ")}.\n- India VIX tercile (the previous close within its trailing ${VIX_WINDOW}) known on ${vixCov.length} of ${nN.length} NIFTY nights.\n\n${md(yearsRows)}\n\n${md(nightRows)}\n`);
  summary.cuts = { index: cuts };

  // 3. The exchange calendars against each other (the option nights use their union).
  const nse = new Set(data.book.dates("NIFTY"));
  const bseDays = data.book.dates("SENSEX").filter((d) => d >= BSE_DAILY_FROM);
  const onlyBse = bseDays.filter((d) => !nse.has(d));
  const onlyNse = [...nse].filter((d) => d >= BSE_DAILY_FROM && !new Set(bseDays).has(d));
  const regNoNse = w.reg.filter((d) => d >= bhavFrom(data, "NIFTY") && d <= "2026-10-08" && !nse.has(d));
  const regNoBse = w.reg.filter((d) => d >= BSE_DAILY_FROM && d <= "2026-10-08" && !new Set(bseDays).has(d));
  out.push(`\n## 3. NSE and BSE bhavcopy calendars\n\n- Regular sessions of the calendar without an NSE bhavcopy (from ${bhavFrom(data, "NIFTY")}): ${regNoNse.length}${regNoNse.length ? ` (${regNoNse.join(", ")})` : ""}.\n- Regular sessions without a BSE bhavcopy (from ${BSE_DAILY_FROM}): ${regNoBse.length}${regNoBse.length ? ` (${regNoBse.join(", ")})` : ""}.\n- BSE files without an NSE file (from ${BSE_DAILY_FROM}): ${onlyBse.length}${onlyBse.length ? ` (${onlyBse.join(", ")})` : ""}.\n- NSE files without a BSE file (from ${BSE_DAILY_FROM}): ${onlyNse.length}${onlyNse.length ? ` (${onlyNse.join(", ")})` : ""}.\n- Short sessions by NIFTY's option volume (WP6): ${[...data.special].sort().join(", ")}.\n`);

  // 4. The option samples (bar presence only, no prices used).
  const optRows: (string | number)[][] = [["index", "nights in the option range", "skipped before the bars (by reason)", "base B (call ATM, 15:20 → 09:15): both legs priced", "**cut after**", "first 60% / last 40%", "last 40% to Dec 2024 / from 2025 / from 1 Apr 2026", "last 40% by filter at 15:20: all / weekday / down / sell-off", "C1 base (synthetic, 15:25 → 09:30): nights", "C2 nights with a rank (15:25)", "DTE at entry"]];
  const optCuts: Record<string, string | null> = {};
  for (const sym of SYMS) {
    const c = ctxs.get(sym)!;
    const skips: Record<string, number> = {};
    const days: { d: string; kind: NightKind; change: number | null }[] = [];
    let cNights = 0;
    let c2Nights = 0;
    const dte = new Map<number, number>();
    for (const n of c.nights.filter((z) => z.d >= c.first && z.e <= c.last)) {
      if (n.spans.length) {
        bump(skips, "spans a special session");
        continue;
      }
      if (!c.daySet.has(n.d) || !c.daySet.has(n.e)) {
        bump(skips, "D or E not a valid 1-minute session");
        continue;
      }
      const ex = expiryWithDte(data, sym, n.d, MIN_DTE);
      const chainD = ex ? chainOf(c, n.d, ex.expiry) : null;
      const chainE = ex ? chainOf(c, n.e, ex.expiry) : null;
      if (!ex || !chainD || !chainE) {
        bump(skips, ex ? "contract missing from the dataset on D or E" : "no listed expiry with ≥ 2 sessions");
        continue;
      }
      if (lotOf(data, sym, n.d, ex.expiry) === null) {
        bump(skips, "no lot in the bhavcopy");
        continue;
      }
      dte.set(ex.dte, (dte.get(ex.dte) ?? 0) + 1);
      const strikes = bothListed(chainD);
      const idxD = idxOf(c, n.d);
      const level = idxD.lastUpTo(BASE_ENTRY - 1)?.c;
      const k = level === undefined ? null : nearestListed(strikes, level);
      const has = (strike: number | null, t: OptType, entry: number, exit: number) => strike !== null && !!chainD.series.get(key(strike, t))?.firstFrom(entry, ENTRY_WAIT) && !!chainE.series.get(key(strike, t))?.firstFrom(exit, EXIT_WAIT);
      if (has(k, "CE", BASE_ENTRY, BASE_EXIT) && has(k, "PE", BASE_ENTRY, BASE_EXIT)) {
        const prev = prevClose(w, sym, n.d);
        days.push({ d: n.d, kind: n.kind, change: prev !== null && level !== undefined ? level / prev - 1 : null });
      }
      const lc = idxD.lastUpTo(C_ENTRY - 1)?.c;
      const f = lc === undefined ? null : forwardAt(chainD, strikes, lc, C_ENTRY);
      const kf = f === null ? null : nearestListed(strikes, f);
      // A synthetic's exit may also be a stale last close before 09:30 (runOvernight), so presence of any bar on E up to the window's end counts.
      const hasC = (t: OptType) => kf !== null && !!chainD.series.get(key(kf, t))?.firstFrom(C_ENTRY, ENTRY_WAIT) && !!chainE.series.get(key(kf, t))?.lastUpTo(C_EXIT + EXIT_WAIT);
      if (hasC("CE") && hasC("PE")) {
        cNights++;
        if (c.sess.get(C_ENTRY)?.get(n.d)?.rank != null) c2Nights++;
      }
    }
    const cut = cutDate(days.map((z) => z.d), IS_FRAC);
    optCuts[sym] = cut;
    const oos = days.filter((z) => z.d > (cut ?? ""));
    const fc = (f: NightFilter) => oos.filter((z) => (needsChange(f) ? z.change !== null : true) && passesFilter(f, z, SELLOFF)).length;
    optRows.push([sym, c.nights.filter((z) => z.d >= c.first && z.e <= c.last).length, Object.entries(skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–", days.length, cut ?? "–", `${days.length - oos.length} / ${oos.length}`, `${oos.filter((z) => z.d <= ERA_END).length} / ${oos.filter((z) => z.d > ERA_END).length} / ${oos.filter((z) => z.d >= STT_2026).length}`, OPT_FILTERS.map(fc).join(" / "), cNights, c2Nights, [...dte].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(", ")]);
  }
  out.push(`\n## 4. The option samples (1-minute bars; bar presence only)\n\n${md(optRows)}\n`);
  summary.cuts = { index: cuts, option: optCuts };

  // 5. Futures and end-of-day calls (bhavcopy): coverage only.
  const fRows: (string | number)[][] = [["index", "nights with the near-month futures traded on D and E", "first / last D", "skipped", "nights from 1 Apr 2026", "ATM call close → open nights (bhavcopy)", "skipped"]];
  for (const sym of SYMS) {
    const f = futuresNights(w, sym);
    const e = eodCalls(w, sym);
    fRows.push([sym, f.nights.length, `${f.nights[0]?.d ?? "–"} / ${f.nights.at(-1)?.d ?? "–"}`, Object.entries(f.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–", f.nights.filter((z) => z.d >= STT_2026).length, e.calls.length, Object.entries(e.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–"]);
  }
  out.push(`\n## 5. Futures and end-of-day calls (bhavcopy; counts only)\n\n${md(fRows)}\n`);
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
  SMOKE = smoke;
  const t0 = Date.now();
  const log = (s: string) => console.log(`${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const data = await loadData(I);
  log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE bhavcopies`);
  const w = buildWorld(I, data);

  // ---- A. Index direction ----
  const idxRuns: IdxRun[] = [];
  const idxCuts = new Map<Sym, string>();
  const idxNightsBy = new Map<Sym, IdxNight[]>();
  for (const sym of SYMS) {
    const { nights } = indexNights(w, sym, smoke);
    idxNightsBy.set(sym, nights);
    idxCuts.set(sym, cutDate(nights.map((o) => o.d), IS_FRAC) ?? "9999-12-31");
    for (const subset of IDX_SUBSETS) idxRuns.push({ name: idxName(sym, subset, SELLOFF), sym, subset, threshold: SELLOFF, kind: "strategy", obs: nights });
  }
  const iStats = new Map(idxRuns.map((r) => [r.name, idxStats(r, idxCuts.get(r.sym)!)]));
  const idxPerts: IdxRun[] = [];
  for (const r of idxRuns) if (r.subset === "selloff" && idxCore(iStats.get(r.name)!)) for (const t of SELLOFF_PERTS) idxPerts.push({ name: idxName(r.sym, "selloff", t), sym: r.sym, subset: "selloff", threshold: t, kind: "perturbation", base: r.name, label: `sell-off ≤ ${pp(t, 1)}`, obs: r.obs });
  const iPertStats = new Map(idxPerts.map((r) => [r.name, idxStats(r, idxCuts.get(r.sym)!, true)]));
  log(`Index: ${idxRuns.length} variants, ${idxPerts.length} perturbations; cuts ${[...idxCuts].map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ---- B and C. Options ----
  const optRuns: OptRun[] = [];
  const optCuts = new Map<Sym, string>();
  const ctxs = new Map<Sym, OptCtx>();
  const recsBy = new Map<Sym, NightRec[]>();
  for (const sym of SYMS) {
    const c = optCtx(w, sym, I.x, smoke);
    ctxs.set(sym, c);
    const recs = nightRecs(w, c, smoke);
    recsBy.set(sym, recs);
    log(`${sym}: ${recs.length} night records (${recs.filter((r) => !r.skip).length} priced)`);
    for (const filter of OPT_FILTERS) for (const entry of ENTRIES) for (const exit of EXITS) for (const steps of STEPS) for (const mode of MODES) optRuns.push(buildB(recs, sym, filter, entry, exit, steps, mode));
    for (const mode of MODES) {
      optRuns.push(buildC(c, recs, "C1", C_ENTRY, C_EXIT, 0, mode));
      optRuns.push(buildC(c, recs, "C1B", C_ENTRY, C_EXIT, 0, mode));
      for (const t of C2_CHOICES) optRuns.push(buildC(c, recs, "C2", C_ENTRY, C_EXIT, 0, mode, t));
    }
    const base = optRuns.find((r) => r.family === "B" && r.sym === sym && r.filter === "all" && r.entry === BASE_ENTRY && r.exit === BASE_EXIT && r.steps === 0 && r.mode === "conservative")!;
    optCuts.set(sym, cutDate(base.trades.map((t) => t.day), IS_FRAC) ?? "9999-12-31");
  }
  const oStats = new Map(optRuns.map((r) => [r.name, optStats(r, optCuts.get(r.sym)!)]));
  log(`Options: ${optRuns.length} variants; cuts ${[...optCuts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  // Picks: family B per index, filter and fill (12 timings and strikes); C2 per index and fill (R6's three thresholds); C1 and C1-B are fixed.
  const picks: OptRun[] = [];
  for (const sym of SYMS)
    for (const mode of MODES) {
      for (const filter of OPT_FILTERS) {
        const p = pickBest(optRuns.filter((r) => r.family === "B" && r.sym === sym && r.filter === filter && r.mode === mode), (r) => oStats.get(r.name)!.is.mean, (r) => r.name);
        if (p) picks.push(p);
      }
      for (const fam of ["C1", "C1B"] as const) picks.push(optRuns.find((r) => r.family === fam && r.sym === sym && r.mode === mode)!);
      const p2 = pickBest(optRuns.filter((r) => r.family === "C2" && r.sym === sym && r.mode === mode), (r) => oStats.get(r.name)!.is.mean, (r) => r.name);
      if (p2) picks.push(p2);
    }
  const optPerts: OptRun[] = [];
  for (const p of picks) {
    if (!optCore(p, oStats.get(p.name)!)) continue;
    const recs = recsBy.get(p.sym)!;
    if (p.family === "B") for (const q of bPerturbations(p)) optPerts.push(buildB(recs, p.sym, p.filter, q.entry, q.exit, q.steps, p.mode, q.threshold, "perturbation", p.name, q.label));
    else for (const q of cPerturbations(p)) optPerts.push(buildC(ctxs.get(p.sym)!, recs, p.family, q.entry, q.exit, q.fsteps, p.mode, q.c2, "perturbation", p.name, q.label));
  }
  const oPertStats = new Map(optPerts.map((r) => [r.name, optStats(r, optCuts.get(r.sym)!, true)]));
  const c2By = new Map(picks.filter((p) => p.family === "C2").map((p) => [p.name, c2Checks(p, optCuts.get(p.sym)!)]));

  // ---- D. Descriptive ----
  const descs: { d: Desc; family: string; data: string }[] = [];
  const bridgeRows: (string | number)[][] = [["index", "nights", "official close → open", "D 15:29 close → E 09:15 open (1-minute)", ...C_BRIDGE.map((z) => `${minToHhmm(z[0])} → ${minToHhmm(z[1])}`)]];
  for (const sym of SYMS) {
    const c = ctxs.get(sym)!;
    const nights = idxNightsBy.get(sym)!.filter((o) => c.daySet.has(o.d) && c.daySet.has(o.e) && o.d >= c.first);
    const off = nights.map((o) => o.r);
    const mm = nights.map((o) => {
      const a = idxOf(c, o.d).lastUpTo(LAST_BAR)?.c;
      const b = idxOf(c, o.e).at(OPEN_MIN)?.o;
      return a !== undefined && b !== undefined ? (smoke ? 0.004 * fake(`${sym}|${o.d}|mm`) : b / a - 1) : NaN;
    });
    const series = C_BRIDGE.map(([e, x]) =>
      nights.map((o) => {
        const a = idxOf(c, o.d).lastUpTo(e)?.c;
        const b = idxOf(c, o.e).lastUpTo(x)?.c;
        return a !== undefined && b !== undefined ? (smoke ? 0.004 * fake(`${sym}|${o.d}|${e}|${x}`) : b / a - 1) : NaN;
      }),
    );
    const dOff = describe(`${sym} official close → open on the 1-minute nights`, "return", off, INDEX_BLOCK);
    const dMm = describe(`${sym} 15:29 bar close → 09:15 bar open`, "return", mm.filter(Number.isFinite), INDEX_BLOCK);
    const dS = series.map((xs, i) => describe(`${sym} index ${minToHhmm(C_BRIDGE[i][0])} bar close → ${minToHhmm(C_BRIDGE[i][1])} bar close`, "return", xs.filter(Number.isFinite), INDEX_BLOCK));
    for (const d of [dOff, dMm, ...dS]) descs.push({ d, family: "bridge", data: DATA_1M[sym] });
    bridgeRows.push([sym, nights.length, `${bp(dOff.mean)} (${bp(dOff.lo)} … ${bp(dOff.hi)})`, `${bp(dMm.mean)} (${bp(dMm.lo)} … ${bp(dMm.hi)})`, ...dS.map((d) => `${bp(d.mean)} (${bp(d.lo)} … ${bp(d.hi)})`)]);
  }
  const futRows: (string | number)[][] = [["index", "nights", "close → open per night (95% CI)", "up", "₹ per lot per night", "sell-side STT ₹ per lot (dated)", "last trade → open (NSE, 2024–)", "from 1 Apr 2026: nights, close → open, STT"]];
  const futBy = new Map<Sym, FutNight[]>();
  for (const sym of SYMS) {
    const f = futuresNights(w, sym).nights;
    futBy.set(sym, f);
    const d1 = describe(`${sym} near-month futures close → open`, "return", f.map((z) => z.r), INDEX_BLOCK);
    const d2 = describe(`${sym} near-month futures ₹ per lot close → open`, "rupees", f.map((z) => z.rupees), 1);
    const lastOnes = f.filter((z) => z.rLast !== null).map((z) => z.rLast!);
    const d3 = describe(`${sym} near-month futures last trade → open`, "return", lastOnes, INDEX_BLOCK);
    const post = f.filter((z) => z.d >= STT_2026);
    descs.push({ d: d1, family: "futures", data: `${sym === "NIFTY" ? "NSE" : "BSE"} F&O bhavcopy cache (near-month futures)` }, { d: d2, family: "futures", data: `${sym === "NIFTY" ? "NSE" : "BSE"} F&O bhavcopy cache (near-month futures)` });
    if (lastOnes.length) descs.push({ d: d3, family: "futures", data: "NSE UDiFF F&O bhavcopy (last traded price)" });
    futRows.push([sym, f.length, `${bp(d1.mean)} (${bp(d1.lo)} … ${bp(d1.hi)})`, pct(d1.up), `${rs(d2.mean)} (${rs(d2.lo)} … ${rs(d2.hi)})`, rs(avg(f.map((z) => z.stt))), lastOnes.length ? `${bp(d3.mean)} (${bp(d3.lo)} … ${bp(d3.hi)}), ${lastOnes.length}` : "–", `${post.length}, ${bp(avg(post.map((z) => z.r)))}, ${rs(avg(post.map((z) => z.stt)))}`]);
  }
  const eodRows: (string | number)[][] = [["index", "nights", "₹ per lot per night (95% CI)", "profitable", "premium ₹", "worst nights (₹ per lot)"]];
  const eodBy = new Map<Sym, EodCall[]>();
  for (const sym of SYMS) {
    const e = eodCalls(w, sym).calls;
    eodBy.set(sym, e);
    const d = describe(`${sym} ATM call close → open (bhavcopy prints, N4 contract)`, "rupees", e.map((z) => z.net), 1);
    descs.push({ d, family: "EOD call", data: `${sym === "NIFTY" ? "NSE" : "BSE"} F&O bhavcopy cache (closing price → first trade)` });
    eodRows.push([sym, e.length, `${rs(d.mean)} (${rs(d.lo)} … ${rs(d.hi)})`, pct(d.up), rs(avg(e.map((z) => z.premium))), [...e].sort((a, b) => a.net - b.net).slice(0, 6).map((z) => `${z.d} ${rs(z.net)}`).join(", ")]);
  }
  for (const sym of SYMS)
    for (const mode of MODES) {
      const b = optRuns.find((r) => r.family === "B" && r.sym === sym && r.filter === "all" && r.entry === BASE_ENTRY && r.exit === BASE_EXIT && r.steps === 0 && r.mode === mode)!;
      descs.push({ d: describe(`${sym} ATM straddle (call + put) 15:20 → 09:15 ${mode}`, "rupees", b.pairs.map((p) => p.s + p.o), 1), family: "straddle", data: DATA_1M[sym] });
    }

  if (smoke) {
    // Structure: counts, skips and finiteness; every value is synthetic, and the pipeline continues without the ledger.
    const finite = (xs: number[]) => xs.every(Number.isFinite);
    for (const r of idxRuns) console.log(`smoke ${r.name}: nights ${r.obs.length}, in subset ${r.obs.filter((o) => passesFilter(r.subset, o, r.threshold)).length}, finite ${finite(r.obs.map((o) => o.r))}`);
    for (const r of optRuns.filter((z) => z.mode === "mid")) console.log(`smoke ${r.name}: slots ${r.slots.length}, trades ${r.trades.length}, skips ${JSON.stringify(r.skips)}, finite ${finite(r.trades.map((t) => t.net))}`);
    console.log(`smoke picks ${picks.length}; perturbations ${idxPerts.length + optPerts.length}; C2 checks ${c2By.size}; descriptive lines ${descs.length} (finite ${finite(descs.map((z) => z.d.n))}); index cuts ${JSON.stringify(Object.fromEntries(idxCuts))}; option cuts ${JSON.stringify(Object.fromEntries(optCuts))}`);
    for (const sym of SYMS) console.log(`smoke ${sym}: futures ${futBy.get(sym)!.length}, EOD calls ${eodBy.get(sym)!.length}, priced nights ${recsBy.get(sym)!.filter((z) => !z.skip).length}, print exits ${recsBy.get(sym)!.filter((z) => z.print.get("mid|CE|long")).length}, E-session placebos ${recsBy.get(sym)!.filter((z) => z.eSession.get("mid") !== null && z.eSession.get("mid") !== undefined).length}`);
  }

  // ---- Ledger ----
  const lines = [...idxRuns.map((r) => idxTrial(r, iStats.get(r.name)!)), ...idxPerts.map((r) => idxTrial(r, iPertStats.get(r.name)!)), ...optRuns.map((r) => optTrial(r, oStats.get(r.name)!)), ...optPerts.map((r) => optTrial(r, oPertStats.get(r.name)!))];
  const descLines = descs.map((z) => descTrial(z.d, z.family, z.data));
  const allLines = [...lines, ...descLines];
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === WP).map((r) => r.variant));
  const fresh = allLines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && !smoke && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVarIdx = sharpeVariance(lines.filter((l) => (l.params as { family?: string }).family === "index overnight")).variance;
  const srVarOpt = sharpeVariance(lines.filter((l) => String((l.params as { family?: string }).family).startsWith("option overnight"))).variance;
  log(`Ledger: ${ledgerBefore} lines before, ${fresh.length} new (${args.ledger === true && !smoke ? "appended" : smoke ? "NOT appended: --smoke" : "NOT appended: no --ledger"}), N = ${ledgerN}; V[SR] index ${srVarIdx?.toExponential(2)}, options ${srVarOpt?.toExponential(2)}`);

  // ---- The bar ----
  const idxJudged = idxRuns.map((r) => {
    const perts = r.subset === "selloff" && idxCore(iStats.get(r.name)!) ? idxPerts.filter((z) => z.base === r.name).map((z) => ({ label: z.label!, oosNet: sum(iPertStats.get(z.name)!.oos.rets) })) : null;
    return { run: r, stats: iStats.get(r.name)!, j: judgeIdx(r, iStats.get(r.name)!, perts, ledgerN, srVarIdx) };
  });
  const optJudged = picks.map((p) => {
    const perts = optCore(p, oStats.get(p.name)!) ? optPerts.filter((z) => z.base === p.name).map((z) => ({ label: z.label!, oosNet: oPertStats.get(z.name)!.oos.net })) : null;
    const r6 = p.family === "B" ? null : r6Extras(p, oStats.get(p.name)!, picks, oStats, recsBy.get(p.sym)!);
    return { run: p, stats: oStats.get(p.name)!, j: judgeOpt(p, oStats.get(p.name)!, perts, ledgerN, srVarOpt, c2By.get(p.name) ?? null, r6) };
  });

  // ---- Tables ----
  const S: string[] = [`# WP15 tables (generated)${smoke ? "\n\n**SMOKE RUN: every price-derived value below is synthetic. Nothing here describes the data.**" : ""}\n\nLedger: ${ledgerBefore} → ${ledgerN} lines (${fresh.length} new); Bonferroni 0.05/${ledgerN} = ${(0.05 / ledgerN).toExponential(2)}; V[SR] of this study's index lines ${srVarIdx?.toExponential(2)}, of its option lines ${srVarOpt?.toExponential(2)}.\n\nIndex cuts (the last D of the first 60% of valid nights): ${[...idxCuts].map(([k, v]) => `${k} ${v}`).join(", ")}. Option cuts (the base call's first 60% of trade nights): ${[...optCuts].map(([k, v]) => `${k} ${v}`).join(", ")}.\n`];
  const iv: (string | number)[][] = [["index", "nights", "first 60% per night (n)", "last 40% nights", "last 40% per night (95% CI)", "hit (Wilson)", "placebo (a) vs E's open → close (SE)", "placebo (b) fair coin (SE)", "PF", "verdict"]];
  for (const { run, stats: s, j } of idxJudged) iv.push([run.sym, FILTER_LABEL[run.subset], `${bp(s.is.mean)} (${s.is.n})`, s.oos.n, `${bp(s.oos.mean)} (${bp(s.oos.boot.perTrade.lo)} … ${bp(s.oos.boot.perTrade.hi)})`, `${pct(s.oos.hit)} (${pct(s.oos.hitLo)} … ${pct(s.oos.hitHi)})`, `${bp(s.oos.dayGap)} (${fx(s.oos.dayGap / s.oos.dayGapSe)})`, `${bp(s.oos.coinGap)} (${fx(s.oos.coinGap / s.oos.coinGapSe)})`, fx(s.oos.pf), j.verdict]);
  S.push(`\n## Verdicts: A. index nights\n\n${md(iv)}\n`);
  const ov: (string | number)[][] = [["index", "family", "fill", "pick (first 60%)", "first 60% ₹/trade (n)", "last 40% trades", "last 40% ₹/trade (95% CI)", "PF", "placebo gap (SE)", "per session (CI)", "to Dec 2024 / from 2025", "worst / best night", "verdict"]];
  const famLabel = (r: OptRun) => (r.family === "B" ? `B ${FILTER_LABEL[r.filter]}` : r.family === "C1" ? "R6 C1 synthetic" : r.family === "C1B" ? "R6 C1-B call" : `R6 C2 weak session`);
  const pickLabel = (r: OptRun) => (r.family === "B" ? `call ${stepLabel(r.steps)} ${minToHhmm(r.entry)}→${minToHhmm(r.exit)}` : r.family === "C2" ? r.c2!.label : `${minToHhmm(r.entry)}→${minToHhmm(r.exit)}`);
  for (const { run, stats: s, j } of optJudged) ov.push([run.sym, famLabel(run), run.mode, pickLabel(run), `${rs(s.is.mean)} (${s.is.n})`, s.oos.n, `${rs(s.oos.mean)} (${rs(s.oos.lo)} … ${rs(s.oos.hi)})`, fx(s.oos.pf), `${rs(s.oos.gap.gap)} (${fx(s.oos.gap.t)} SE)${s.oos.dayGap ? `; vs E's session ${rs(s.oos.dayGap.gap)} (${fx(s.oos.dayGap.t)})` : ""}`, `${rs(s.oos.boot.perSession.estimate)} (${rs(s.oos.sessLo)} … ${rs(s.oos.sessHi)})`, `${rs(s.oosEra1.mean)} (${s.oosEra1.n}) / ${rs(s.oosEra2.mean)} (${s.oosEra2.n})`, `${rs(s.tail.worst)} (${s.tail.worstDay}) / ${rs(s.tail.best)} (${s.tail.bestDay})`, j.verdict]);
  S.push(`\n## Verdicts: B. the call buyer's picks and C. R6's variants\n\n${md(ov)}\n`);
  for (const { run, stats: s, j } of idxJudged) {
    S.push(`\n### ${run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "nights in window", "nights", "per night", "95% CI", "hit", "PF", "E's open → close", "placebo (a) (SE)"], ...[s.full, s.is, s.oos, s.regime1, s.regime2, s.half1, s.half2].map((z) => [z.label, z.sessions, z.n, bp(z.mean), `${bp(z.boot.perTrade.lo)} … ${bp(z.boot.perTrade.hi)}`, pct(z.hit), fx(z.pf), bp(z.dayMean), `${bp(z.dayGap)} (${fx(z.dayGap / z.dayGapSe)})`])])}\n\nBy year (nights, mean, hit): ${s.years.map((y) => `${y.year} ${y.n} ${bp(y.mean, 1)} ${pct(y.hit, 0)}`).join(" · ")}\n\nBy night kind: ${s.byKind.map((z) => `${z.key} ${z.n} ${bp(z.mean)} (${bp(z.lo)} … ${bp(z.hi)})`).join(" · ")}. By India VIX tercile (previous close, trailing 250): ${s.byVix.map((z) => `${z.key} ${z.n} ${bp(z.mean)} (${bp(z.lo)} … ${bp(z.hi)})`).join(" · ")}\n`);
    const perts = idxPerts.filter((z) => z.base === run.name);
    if (perts.length) S.push(`Perturbations (last 40%): ${perts.map((z) => `${z.label}: ${iPertStats.get(z.name)!.oos.n} nights, ${bp(iPertStats.get(z.name)!.oos.mean)}`).join(" · ")}\n`);
  }
  for (const { run, stats: s, j } of optJudged) {
    S.push(`\n### ${run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "trades", "₹/trade", "95% CI", "PF", "hit", "net ₹", "placebo gap (SE)"], ...[s.full, s.is, s.oos, s.era1, s.era2, s.oosEra1, s.oosEra2, s.half1, s.half2, s.pre2026, s.post2026].map((z) => [z.label, z.n, rs(z.mean), `${rs(z.lo)} … ${rs(z.hi)}`, fx(z.pf), pct(z.hit), rs(z.net), `${rs(z.gap.gap)} (${fx(z.gap.t)})`])])}\n\nBy year: ${s.years.map((y) => `${y.year} ${y.n} ${rs(y.mean)}`).join(" · ")}. By night kind: ${s.byKind.map((z) => `${z.key} ${z.n} ${rs(z.mean)} (${rs(z.lo)} … ${rs(z.hi)})`).join(" · ")}. By VIX tercile: ${s.byVix.map((z) => `${z.key} ${z.n} ${rs(z.mean)}`).join(" · ")}\n`);
    const perts = optPerts.filter((z) => z.base === run.name);
    if (perts.length) S.push(`Perturbations (last 40% net ₹ / trades): ${perts.map((z) => `${z.label}: ${rs(oPertStats.get(z.name)!.oos.net)} / ${oPertStats.get(z.name)!.oos.n}`).join(" · ")}\n`);
  }
  // Every variant.
  const iall: (string | number)[][] = [["variant", "nights", "per night (95% CI)", "hit", "PF", "E's open → close", "first 60% (n)", "last 40% [CI] (n)", "2011–2019 / 2020–2026", "halves"]];
  for (const r of idxRuns) {
    const s = iStats.get(r.name)!;
    iall.push([r.name, s.full.n, `${bp(s.full.mean)} (${bp(s.full.boot.perTrade.lo)} … ${bp(s.full.boot.perTrade.hi)})`, pct(s.full.hit), fx(s.full.pf), bp(s.full.dayMean), `${bp(s.is.mean)} (${s.is.n})`, `${bp(s.oos.mean)} [${bp(s.oos.boot.perTrade.lo)} … ${bp(s.oos.boot.perTrade.hi)}] (${s.oos.n})`, `${bp(s.regime1.mean)} (${s.regime1.n}) / ${bp(s.regime2.mean)} (${s.regime2.n})`, `${bp(s.half1.mean)} / ${bp(s.half2.mean)}`]);
  }
  S.push(`\n## Every index variant (${idxRuns.length})\n\n${md(iall)}\n`);
  const oall: (string | number)[][] = [["variant", "trades", "₹/trade (95% CI)", "hit", "PF", "placebo gap (SE)", "first 60% ₹/trade (n)", "last 40% ₹/trade [CI] (n)", "to Dec 2024 / from 2025", "before / from 1 Apr 2026", "premium ₹", "index move (share up)", "skips"]];
  for (const r of optRuns) {
    const s = oStats.get(r.name)!;
    oall.push([r.name, s.full.n, `${rs(s.full.mean)} (${rs(s.full.lo)} … ${rs(s.full.hi)})`, pct(s.full.hit, 0), fx(s.full.pf), `${rs(s.full.gap.gap)} (${fx(s.full.gap.t)})`, `${rs(s.is.mean)} (${s.is.n})`, `${rs(s.oos.mean)} [${rs(s.oos.lo)} … ${rs(s.oos.hi)}] (${s.oos.n})`, `${rs(s.era1.mean)} / ${rs(s.era2.mean)}`, `${rs(s.pre2026.mean)} (${s.pre2026.n}) / ${rs(s.post2026.mean)} (${s.post2026.n})`, rs(s.premium), `${pp(s.move)} (${pct(s.moveHit, 0)})`, Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–"]);
  }
  S.push(`\n## Every option variant (${optRuns.length})\n\n${md(oall)}\n`);
  // R6's kill check and decomposition.
  const kill: (string | number)[][] = [["index", "fill", "structure", "nights (to Dec 2024, all three exits priced)", "exit at the first print (09:15 open)", "09:15 bar", "09:30 (R6's exit)"]];
  const decomp: (string | number)[][] = [["index", "nights", "C1-B call gross ₹/lot (mid)", "½ × synthetic (call − put)", "½ × straddle (call + put)", "0.5 × the index move × lot", "the rest (theta, vega, the opening print)"]];
  for (const sym of SYMS) {
    const recs = recsBy.get(sym)!.filter((r) => !r.skip && r.e <= ERA_END);
    for (const mode of MODES)
      for (const fam of ["synthetic", "call"] as const) {
        const rows = recs
          .map((r) => {
            const g = (exit: number, t: OptType, side: "long" | "short") => r.fwdLegs.get(fwdKey(C_ENTRY, exit, 0, mode, t, side))?.net;
            const pr = (t: OptType, side: "long" | "short") => r.print.get(`${mode}|${t}|${side}`)?.net;
            const v = fam === "call" ? [pr("CE", "long"), g(hhmmToMin("09:15"), "CE", "long"), g(C_EXIT, "CE", "long")] : [sumOrU(pr("CE", "long"), pr("PE", "short")), sumOrU(g(hhmmToMin("09:15"), "CE", "long"), g(hhmmToMin("09:15"), "PE", "short")), sumOrU(g(C_EXIT, "CE", "long"), g(C_EXIT, "PE", "short"))];
            return v.every((z) => z !== undefined) ? (v as number[]) : null;
          })
          .filter((z): z is number[] => z !== null);
        kill.push([sym, mode, fam, rows.length, rs(avg(rows.map((z) => z[0]))), rs(avg(rows.map((z) => z[1]))), rs(avg(rows.map((z) => z[2])))]);
      }
    const all = recsBy.get(sym)!.filter((r) => !r.skip);
    const dz = all
      .map((r) => {
        const cl = r.fwdLegs.get(fwdKey(C_ENTRY, C_EXIT, 0, "mid", "CE", "long"));
        const pl = r.fwdLegs.get(fwdKey(C_ENTRY, C_EXIT, 0, "mid", "PE", "long"));
        const a = r.at.get(C_ENTRY);
        const lx = r.levelExit.get(C_EXIT);
        return cl && pl && a && lx !== undefined && Number.isFinite(lx) ? { call: cl.gross, syn: cl.gross - pl.gross, str: cl.gross + pl.gross, move: smoke ? 300 * fake(`${r.d}|decomp`) : 0.5 * (lx - a.level) * r.lot } : null;
      })
      .filter((z): z is { call: number; syn: number; str: number; move: number } => z !== null);
    decomp.push([sym, dz.length, rs(avg(dz.map((z) => z.call))), rs(avg(dz.map((z) => z.syn / 2))), rs(avg(dz.map((z) => z.str / 2))), rs(avg(dz.map((z) => z.move))), rs(avg(dz.map((z) => z.call - z.move)))]);
  }
  S.push(`\n## R6's kill check: the first print against 09:30 (to Dec 2024, where the 09:15 bar's open is the exchange's first trade)\n\n${md(kill)}\n\n## R6's decomposition of the C1-B call (mid fills, gross, every priced night)\n\n${md(decomp)}\n`);
  // Tails.
  const tailRows: (string | number)[][] = [["variant", "trades", "net ₹", "worst / best night", "5% VaR / ES ₹", "1% VaR / ES ₹", "net without the best 5 / 10", "max drawdown ₹ (% of ₹5 lakh / of ₹10,000)", "longest losing run", "premium ₹ (share > ₹10,000)", "stop −30%: gapped nights, ₹/lot beyond the stop", "stop −50%: gapped nights, ₹/lot beyond"]];
  for (const { run, stats: s } of optJudged) {
    const t = s.tail;
    tailRows.push([run.name, s.full.n, rs(s.full.net), `${rs(t.worst)} (${t.worstDay}) / ${rs(t.best)} (${t.bestDay})`, `${rs(t.var5)} / ${rs(t.es5)}`, `${rs(t.var1)} / ${rs(t.es1)}`, `${rs(t.withoutBest5)} / ${rs(t.withoutBest10)}`, `${rs(t.maxDD)} (${pct(t.maxDD / ACCOUNTS[0])} / ${pct(t.maxDD / ACCOUNTS[1], 0)})`, t.longestLosing, `${rs(s.premium)} (${pct(t.over10k, 0)})`, ...t.stops.map((z) => `${z.gapped} (${pct(z.share)}), ${rs(z.beyond)}`)]);
  }
  S.push(`\n## Tails of the picks (one lot; night-clustered)\n\n${md(tailRows)}\n\nThe ten worst nights of each pick: ${optJudged.map(({ run, stats: s }) => `**${run.name}**: ${s.tail.worst10.map((z) => `${z.day} ${rs(z.net)}`).join(", ")}`).join("\n\n")}\n`);
  const idxTail: (string | number)[][] = [["index", "nights", "5% VaR / ES", "1% VaR / ES", "nights ≤ −1% / ≤ −2% / ≤ −3%", "a 1% / 2% stop gapped through: nights, mean bp beyond the stop", "the 10 worst nights"]];
  for (const sym of SYMS) {
    const xs = idxNightsBy.get(sym)!;
    const r = xs.map((o) => o.r);
    const t5 = tailRisk(r, 0.05);
    const t1 = tailRisk(r, 0.01);
    const st = INDEX_STOPS.map((f) => {
      const g = r.map((x) => gapThroughStop(1, 1 + x, f)).filter((z) => z.gapped);
      return `${g.length}, ${bp(avg(g.map((z) => z.beyondStop)))}`;
    });
    idxTail.push([sym, xs.length, `${bp(t5.var)} / ${bp(t5.es)}`, `${bp(t1.var)} / ${bp(t1.es)}`, `${r.filter((x) => x <= -0.01).length} / ${r.filter((x) => x <= -0.02).length} / ${r.filter((x) => x <= -0.03).length}`, st.join("; "), [...xs].sort((a, b) => a.r - b.r).slice(0, 10).map((o) => `${o.d}→${o.e} ${pp(o.r)}`).join(", ")]);
  }
  const futTail: (string | number)[][] = [["index", "futures nights", "5% VaR / ES ₹ per lot", "1% VaR / ES ₹ per lot", "the 8 worst nights (₹ per lot)"]];
  for (const sym of SYMS) {
    const f = futBy.get(sym)!;
    const t5 = tailRisk(f.map((z) => z.rupees), 0.05);
    const t1 = tailRisk(f.map((z) => z.rupees), 0.01);
    futTail.push([sym, f.length, `${rs(t5.var)} / ${rs(t5.es)}`, `${rs(t1.var)} / ${rs(t1.es)}`, [...f].sort((a, b) => a.rupees - b.rupees).slice(0, 8).map((z) => `${z.d} ${rs(z.rupees)} (${pp(z.r)}, lot ${z.lot})`).join(", ")]);
  }
  S.push(`\n## Tails of the index and of a futures lot\n\n${md(idxTail)}\n\n${md(futTail)}\n`);
  // Named nights (one lot each; "–" outside a series' range).
  const named: (string | number)[][] = [["night (D → E)", "index", "official close → open", "near-month future ₹/lot", "ATM call close → open (bhavcopy) ₹/lot", "B call ATM 15:20 → 09:15: conservative / mid ₹/lot", "C1 synthetic / C1-B call 15:25 → 09:30 (mid) ₹/lot"]];
  for (const D of NAMED_NIGHTS)
    for (const sym of SYMS) {
      const io = idxNightsBy.get(sym)!.find((o) => o.d === D);
      const fu = futBy.get(sym)!.find((z) => z.d === D);
      const eo = eodBy.get(sym)!.find((z) => z.d === D);
      const bn = (mode: Mode) => optRuns.find((r) => r.family === "B" && r.sym === sym && r.filter === "all" && r.entry === BASE_ENTRY && r.exit === BASE_EXIT && r.steps === 0 && r.mode === mode)!.trades.find((t) => t.day === D)?.net;
      const cn = (fam: OptFamily) => optRuns.find((r) => r.family === fam && r.sym === sym && r.mode === "mid")!.trades.find((t) => t.day === D)?.net;
      const f = (x: number | undefined) => (x === undefined ? "–" : rs(x));
      named.push([`${D} → ${io?.e ?? fu?.e ?? "–"}`, sym, io ? pp(io.r) : "–", fu ? `${f(fu.rupees)} (${pp(fu.r)})` : "–", f(eo?.net), `${f(bn("conservative"))} / ${f(bn("mid"))}`, `${f(cn("C1"))} / ${f(cn("C1B"))}`]);
    }
  S.push(`\n## Named nights\n\n${md(named)}\n`);
  S.push(`\n## The bridge: what part of the official close → open a 15:20–15:29 buyer can hold (index, 1-minute nights)\n\n${md(bridgeRows)}\n\n## Near-month futures close → open (bhavcopy; robustness only)\n\n${md(futRows)}\n\n## The ATM call close → open on end-of-day prints (bhavcopy; tails before the 1-minute data)\n\n${md(eodRows)}\n\n## Descriptive lines\n\n${md([["family", "line", "n", "mean (95% CI)", "above zero (Wilson)"], ...descs.map(({ d, family }) => [family, d.name, d.n, d.unit === "return" ? `${bp(d.mean)} (${bp(d.lo)} … ${bp(d.hi)})` : `${rs(d.mean)} (${rs(d.lo)} … ${rs(d.hi)})`, `${pct(d.up)} (${pct(d.upLo)} … ${pct(d.upHi)})`])])}\n`);
  mkdirSync(I.outDir, { recursive: true });
  writeFileSync(resolve(I.outDir, "tables.md"), S.join("\n"));
  const pickO = (s: OptStats) => {
    const z = (u: OptSub) => ({ n: u.n, mean: u.mean, lo: u.lo, hi: u.hi, sessLo: u.sessLo, pf: u.pf, hit: u.hit, net: u.net, gap: u.gap.gap, gapSe: u.gap.se, dayGap: u.dayGap?.gap ?? null, dayGapSe: u.dayGap?.se ?? null, both: u.both, p: Math.max(u.boot.perTrade.p, u.boot.perSession.p) });
    return { full: z(s.full), is: z(s.is), oos: z(s.oos), era1: z(s.era1), era2: z(s.era2), oosEra1: z(s.oosEra1), oosEra2: z(s.oosEra2), half1: z(s.half1), half2: z(s.half2), pre2026: z(s.pre2026), post2026: z(s.post2026), years: s.years, byKind: s.byKind, byVix: s.byVix, tail: s.tail, premium: s.premium, charges: s.charges, move: s.move, moveHit: s.moveHit, stale: s.stale, sr: s.sr };
  };
  const pickI = (s: IdxStats) => {
    const z = (u: IdxSub) => ({ n: u.n, sessions: u.sessions, mean: u.mean, lo: u.boot.perTrade.lo, hi: u.boot.perTrade.hi, sessLo: u.boot.perSession.lo, hit: u.hit, pf: u.pf, dayMean: u.dayMean, dayGap: u.dayGap, dayGapSe: u.dayGapSe, coinGapSe: u.coinGapSe, p: Math.max(u.boot.perTrade.p, u.boot.perSession.p) });
    return { full: z(s.full), is: z(s.is), oos: z(s.oos), regime1: z(s.regime1), regime2: z(s.regime2), half1: z(s.half1), half2: z(s.half2), years: s.years, byKind: s.byKind, byVix: s.byVix, sr: s.sr };
  };
  writeFileSync(
    resolve(I.outDir, "summary.json"),
    JSON.stringify(
      {
        ledgerBefore,
        ledgerN,
        srVarIdx,
        srVarOpt,
        idxCuts: Object.fromEntries(idxCuts),
        optCuts: Object.fromEntries(optCuts),
        index: idxRuns.map((r) => ({ name: r.name, sym: r.sym, subset: r.subset, ...pickI(iStats.get(r.name)!) })),
        indexJudged: idxJudged.map((z) => ({ name: z.run.name, verdict: z.j.verdict, criteria: z.j.criteria, p: z.j.p, dsr: z.j.dsr, dsrNull: z.j.dsrNull })),
        options: optRuns.map((r) => ({ name: r.name, family: r.family, sym: r.sym, filter: r.filter, entry: minToHhmm(r.entry), exit: minToHhmm(r.exit), steps: r.steps, mode: r.mode, c2: r.c2?.label ?? null, skips: r.skips, ...pickO(oStats.get(r.name)!) })),
        picks: picks.map((p) => p.name),
        optionJudged: optJudged.map((z) => ({ name: z.run.name, verdict: z.j.verdict, criteria: z.j.criteria, p: z.j.p, dsr: z.j.dsr, dsrNull: z.j.dsrNull })),
        c2Checks: Object.fromEntries(c2By),
        perturbations: [...idxPerts.map((r) => ({ name: r.name, base: r.base, oosMean: iPertStats.get(r.name)!.oos.mean, oosN: iPertStats.get(r.name)!.oos.n })), ...optPerts.map((r) => ({ name: r.name, base: r.base, oosNet: oPertStats.get(r.name)!.oos.net, oosN: oPertStats.get(r.name)!.oos.n }))],
        descriptive: descs.map(({ d, family }) => ({ family, ...d })),
        kill,
        decomp,
      },
      null,
      1,
    ),
  );
  log(`Wrote ${resolve(I.outDir, "tables.md")}; index verdicts: ${idxJudged.map((z) => `${z.run.sym} ${z.run.subset} ${z.j.verdict}`).join("; ")}; option verdicts: ${optJudged.map((z) => `${z.run.sym} ${famLabel(z.run)} ${z.run.mode} ${z.j.verdict}`).join("; ")}`);
}

/** The bridge's minute pairs (D's entry bar close → E's exit bar close). */
const C_BRIDGE: readonly [number, number][] = [
  [hhmmToMin("15:20"), hhmmToMin("09:15")],
  [hhmmToMin("15:20"), hhmmToMin("09:16")],
  [hhmmToMin("15:20"), hhmmToMin("09:20")],
  [hhmmToMin("15:25"), hhmmToMin("09:15")],
  [hhmmToMin("15:25"), hhmmToMin("09:16")],
  [hhmmToMin("15:25"), hhmmToMin("09:20")],
  [hhmmToMin("15:25"), hhmmToMin("09:30")],
];

const sumOrU = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a + b);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2];
  if (cmd === "coverage") return coverage(args);
  if (cmd === "run") return runAll(args);
  if (cmd === "debug") {
    // One night by hand: the index night, the contract, the strikes, the fills and the raw bars.
    const I = inputs(args);
    const sym = (str(args, "index") ?? "NIFTY") as Sym;
    if (!SYMS.includes(sym)) fail("--index NIFTY | SENSEX");
    const D = str(args, "day") ?? fail("--day YYYY-MM-DD (D, the session whose close starts the night) is required");
    const data = await loadData(I);
    const w = buildWorld(I, data);
    const n = w.nights.find((z) => z.d === D);
    if (!n) fail(`${D} does not start a night (special session or not a session)`);
    const io = indexNights(w, sym, false).nights.find((z) => z.d === D);
    console.log(`night ${n.d} → ${n.e} (${n.kind}, spans ${n.spans.join(", ") || "nothing"}); Yahoo D ${JSON.stringify(w.bars[sym].get(n.d) ?? null)} E ${JSON.stringify(w.bars[sym].get(n.e) ?? null)}; index night ${io ? `${pp(io.r, 3)}, E's open → close ${pp(io.p, 3)}, change ${io.change === null ? "–" : pp(io.change, 3)}` : "not valid"}; previous close ${prevClose(w, sym, n.d)}; VIX ${JSON.stringify(w.vixPrev(n.d))}`);
    const c = optCtx(w, sym, I.x, false);
    const rec = nightRec(w, c, n, false);
    console.log(`  option night: ${rec.skip ?? "ok"}; contract ${rec.expiry} (DTE ${rec.dte}), lot ${rec.lot}`);
    for (const [m, a] of rec.at) console.log(`  entry ${minToHhmm(m)}: index ${a.level}, change ${a.change === null ? "–" : pp(a.change, 3)}, spot ATM ${a.atm}, forward ${a.fwd === null ? "–" : fx(a.fwd)}, K(fwd) ${a.kf}; C2 session return ${JSON.stringify(c.sess.get(m)?.get(n.d) ?? null)}`);
    for (const entry of ENTRY_SET)
      for (const exit of B_EXITS)
        for (const steps of [0, 1])
          for (const mode of MODES) {
            const ce = rec.legs.get(legKey(entry, exit, steps, mode, "CE"));
            const pe = rec.legs.get(legKey(entry, exit, steps, mode, "PE"));
            const show = (l: LegRes | null | undefined) => (l ? `k ${l.k} ${fx(l.entryPx)}→${fx(l.exitPx)} (${minToHhmm(l.entryMin)}→${minToHhmm(l.exitMin)}${l.stale ? " stale" : ""}) gross ${fx(l.gross)} charges ${fx(l.charges)} net ${fx(l.net)}` : "–");
            console.log(`  B ${minToHhmm(entry)}→${minToHhmm(exit)} ${stepLabel(steps)} ${mode}: CE ${show(ce)} | PE ${show(pe)}`);
          }
    for (const mode of MODES) {
      const g = (t: OptType, side: "long" | "short") => rec.fwdLegs.get(fwdKey(C_ENTRY, C_EXIT, 0, mode, t, side));
      console.log(`  C ${mode}: call long ${fx(g("CE", "long")?.net ?? NaN)}, put short ${fx(g("PE", "short")?.net ?? NaN)}, put long ${fx(g("PE", "long")?.net ?? NaN)}, call short ${fx(g("CE", "short")?.net ?? NaN)}; first print call ${fx(rec.print.get(`${mode}|CE|long`)?.net ?? NaN)}; E session synthetic ${fx(rec.eSession.get(mode) ?? NaN)}`);
    }
    const ch = rec.expiry ? chainOf(c, n.d, rec.expiry) : null;
    const chE = rec.expiry ? chainOf(c, n.e, rec.expiry) : null;
    const a = rec.at.get(BASE_ENTRY);
    if (ch && chE && a?.atm)
      for (const t of ["CE", "PE"] as const) {
        for (const m of [hhmmToMin("15:19"), BASE_ENTRY, BASE_ENTRY + 1, C_ENTRY]) {
          const b = ch.series.get(key(a.atm, t))?.at(m);
          console.log(`  D ${a.atm}${t} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
        }
        for (const m of [OPEN_MIN, OPEN_MIN + 1, hhmmToMin("09:20"), C_EXIT]) {
          const b = chE.series.get(key(a.atm, t))?.at(m);
          console.log(`  E ${a.atm}${t} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
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
