/**
 * WP16: weekly bull put spreads held to expiry on NIFTY and SENSEX (H1), against their mirror bear call
 * spreads, and the turn of the month (H2) (reports/wp16-put-spreads.md; every definition is frozen in
 * its §1, committed before any premium-derived P&L, credit, win rate or conditional return was
 * computed). Research only: nothing here changes the engine.
 *
 *   H1. Sell the weekly put m expected moves below the index (m = 0.5, 1.0, 1.5; EM from India VIX) and
 *       buy the put half an expected move further down, N = 2, 3 or 4 sessions before the expiry; hold it
 *       to cash settlement ("hold"), or close it on the session before the expiry ("early").
 *       D: at the exchanges' daily closing prices (NSE 2019-2026, BSE 2023-2026);
 *       M: at 15:20 on real 1-minute bars (TradeMarkk, NIFTY 2021-2026, SENSEX 2023-2026).
 *       The placebo is a fair coin between the bull put spread and the mirror bear call spread at the same
 *       distance, width, entry, exit and fill. Per index, family, management and fill, (m, N) is picked
 *       on the first 60% of expiries and judged untouched on the last 40%.
 *   H2. The turn of the month: long the index from the close of the session before the month's last
 *       session to the close of the next month's third session (Yahoo daily 2007-2026), against the other
 *       days; and the near-month future over the same window, net of dated STT (descriptive).
 *
 * Data: the compact NSE/BSE F&O bhavcopy cache (closes, settlement prints, lots, expiries, futures); Yahoo
 * ^NSEI / ^BSESN / ^INDIAVIX daily (Q2's download); the Hugging Face dataset "India Index & Options -
 * 1-minute OHLC" by TradeMarkk (thetrademarkk/india-index-options-1m, revision 0f4800e4, CC-BY-NC-4.0,
 * research only) as reduced by WP13's wp13_extract.py; the file names of NSE's participant-OI archive
 * (WP14's download) as a list of NSE sessions. Raw data is never committed.
 *
 *   npx tsx scripts/research/wp16-put-spreads.ts coverage --nsei <^NSEI 1d json> --bsesn <^BSESN 1d json> --vix <^INDIAVIX 1d json> --x <x13 extract> --dir <bhavcopy cache> [--oi <participant OI dir>] [--out <dir>]
 *   npx tsx scripts/research/wp16-put-spreads.ts run      (same inputs) [--out <dir>] [--ledger] [--smoke]
 *   npx tsx scripts/research/wp16-put-spreads.ts debug    (same inputs) --index NIFTY --expiry YYYY-MM-DD
 *
 *   --smoke  every price-derived value (option prices and fills, settlement levels, index and futures
 *            returns) is replaced by a deterministic synthetic number; the whole pipeline runs (statistics,
 *            verdicts, tables) without touching the ledger, and stdout carries counts only
 *   --smoke-bias <x>  (with --smoke) tilts the synthetic numbers towards the put side and the TOM days, so
 *            the ±20% robustness paths run as well
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blocksOf, cutDate, overallVerdict, pickBest, robustness, type CriterionVerdict } from "../../src/engine/backtest/expiryCalendar";
import { hhmmToMin, minToHhmm, MinuteSeries, OPEN_MIN, pairedGap, type MinuteBar, type PairedDay } from "../../src/engine/backtest/intraday1m";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, type BlockBootstrap } from "../../src/engine/backtest/metrics";
import { tailRisk } from "../../src/engine/backtest/overnight";
import {
  futuresSttPct,
  meanGapBootstrap,
  nthSessionBefore,
  spreadEntry,
  spreadExit,
  spreadMargin,
  spreadStrikes,
  spreadValueAt,
  spreadWidth,
  tomWindows,
  weekKey,
  type MeanGap,
  type SpreadSide,
  type SpreadStrikes,
} from "../../src/engine/backtest/putSpreads";
import type { BhavRow } from "../../src/engine/backtest/realPrices";
import { eventOn, intrinsic, maxDrawdown, scaledSpread, structurePnl, type LegSpec, type SpreadFn } from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { weekdayOf } from "../../src/engine/clock";
import { quantile } from "../../src/engine/util/math";
import { ROOT, fail, parseArgs, str } from "../lib/node";
import { loadResearchData, md, RESEARCH_INDICES, type ResearchData, type ResearchIndex } from "./real_prices";
import { fx, key, loadChainDay, loadIndex, loadManifest, lotOf, pct, rs, type ChainDay, type Manifest, type OptType } from "./wp11-real-intraday";

// ---------------------------------------------------------------------------
// Frozen constants (report §1)
// ---------------------------------------------------------------------------

const WP = "WP16";
type Sym = "NIFTY" | "SENSEX";
const SYMS: readonly Sym[] = ["NIFTY", "SENSEX"];
const DEF: Record<Sym, ResearchIndex> = { NIFTY: RESEARCH_INDICES[0], SENSEX: RESEARCH_INDICES[1] };
type Family = "D" | "M";
type Mgmt = "hold" | "early";
type Mode = "conservative" | "mid";
const FAMILIES: readonly Family[] = ["D", "M"];
const MGMTS: readonly Mgmt[] = ["hold", "early"];
const MODES: readonly Mode[] = ["conservative", "mid"];
/** The short strike's distance below (put) or above (call) the index, in expected moves to expiry. */
const M_SET = [0.5, 1.0, 1.5];
/** Sessions to expiry at entry (the entry is the N-th regular session before the expiry). */
const N_SET = [2, 3, 4];
/** The long strike's distance beyond the short one, in expected moves to expiry. */
const WIDTH_EM = 0.5;
const IS_FRAC = 0.6;
const MIN_OOS = 180;
const BOOT = 20_000;
const BOOT_SUB = 10_000;
const BOOT_LIGHT = 2_000;
const BOOT_FINAL = 100_000;
const SEED = 7;
const CAPITAL = 500_000;
const SMALL_ACCOUNT = 10_000;
/** Family M: the order minutes and how long an order rests (WP11 / WP15). */
const ENTRY_MIN = hhmmToMin("15:20");
const ENTRY_WAIT = 2;
const EXIT_MIN = hhmmToMin("15:20");
const EXIT_WAIT = 5;
/** An M cell runs only when both spreads' legs share an entry minute on at least this share of its eligible expiries (bar presence). */
const M_COVERAGE_MIN = 0.9;
/** Last session whose 1-minute option bars hold every trade (WP11 §2); later bars are built from sampled prices. */
const ERA_END = "2024-12-31";
/** Option STT on sales rose from 0.1% to 0.15% of premium on this date. */
const STT_2026 = "2026-04-01";
/** The BSE derivatives bhavcopy is daily from the SENSEX relaunch. */
const BSE_DAILY_FROM = "2023-05-15";
const TICK = 0.05;
const MIN_INDEX_BARS = 370;
const CLOSE_MIN = 930;
/** Daily closes: the conservative fill pays the engine's full spread max(1 tick, 0.4% of premium) on every order (WP10's 2x spread); mid pays none. */
const SPREAD_OF: Record<Mode, SpreadFn> = { conservative: scaledSpread(2), mid: () => 0 };
/** Named stress dates: every expiry whose holding period contains one is reported by name. */
const NAMED_DATES: readonly { date: string; label: string }[] = [
  { date: "2020-03-09", label: "9 Mar 2020 (COVID crash)" },
  { date: "2020-03-12", label: "12 Mar 2020 (COVID crash)" },
  { date: "2020-03-16", label: "16 Mar 2020 (COVID crash)" },
  { date: "2020-03-23", label: "23 Mar 2020 (COVID crash low)" },
  { date: "2024-06-04", label: "4 Jun 2024 (election result)" },
  { date: "2025-04-07", label: "7 Apr 2025 (tariff gap)" },
];
/**
 * NSE's Diwali Muhurat sessions (about one hour each): Lakshmi Puja days 2007–2025 (WP15's list, which
 * was WP14's for 2012–2025 with 26 Oct 2011, extended back with 2007–2010). A calendar, not market data.
 */
const MUHURAT = ["2007-11-09", "2008-10-28", "2009-10-17", "2010-11-05", "2011-10-26", "2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11", "2016-10-30", "2017-10-19", "2018-11-07", "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"];
/** H2: the turn-of-the-month window [−1, +3] (R6 §2, [C10]); ±20% robustness windows [−1, +2] and [−2, +3]. */
const TOM_BEFORE = 1;
const TOM_AFTER = 3;
const TOM_PERTS: readonly [number, number][] = [
  [1, 2],
  [2, 3],
];
/** Circular block bootstrap of the daily series for the TOM-days-against-other-days gap: blocks of 21 sessions (about a month). */
const TOM_BLOCK = 21;
const FIRST_DAY = "2007-01-01";

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs: readonly number[]) => quantile(xs, 0.5);
const bp = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 1e4).toFixed(d)} bp` : "–");
const pp = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%` : "–");
const bump = (o: Record<string, number>, k: string) => void (o[k] = (o[k] ?? 0) + 1);
const sharpe = (rets: readonly number[]) => {
  const m = avg(rets);
  const sd = Math.sqrt(sum(rets.map((x) => (x - m) ** 2)) / Math.max(1, rets.length - 1));
  return sd > 0 ? m / sd : 0;
};
const skipList = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join("; ") || "–";
/** --smoke: replace every price-derived value by a deterministic number in [−1, 1] (FNV-1a of a key). */
let SMOKE = false;
/** --smoke-bias (smoke runs only): tilts the synthetic prices towards the put side, so the robustness paths run too. */
let SMOKE_BIAS = 0;
function fake(k: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Loaders and the session calendar (report §1.1)
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
    outDir: resolve(ROOT, str(args, "out", "reports/wp16")!),
  };
}

interface World {
  data: ResearchData;
  yahoo: Record<Sym, Map<string, DailyBar | null>>;
  /** Every session: a complete Yahoo bar of either index (from 2007), an NSE or BSE bhavcopy, a participant-OI file, or a Muhurat day. */
  cal: string[];
  /** Weekend sessions, Muhurat sessions and the bhavcopy's short sessions (WP6): never an entry, an exit or a TOM day. */
  special: Set<string>;
  /** The regular sessions, ascending. */
  sessions: string[];
  sessionSet: Set<string>;
  /** The index's own exchange bhavcopy dates (SENSEX: the daily BSE files from 15 May 2023). */
  book: Record<Sym, Set<string>>;
  vixDays: string[];
  vixClose: number[];
  oiDates: Set<string>;
}

function buildWorld(I: Inputs, data: ResearchData): World {
  const yahoo: Record<Sym, Map<string, DailyBar | null>> = { NIFTY: loadYahooDaily(I.nsei), SENSEX: loadYahooDaily(I.bsesn) };
  const oiDates = loadOiDates(I.oi);
  const calSet = new Set<string>();
  for (const s of SYMS) for (const [d, b] of yahoo[s]) if (b && d >= FIRST_DAY) calSet.add(d);
  for (const d of data.book.dates("NIFTY")) calSet.add(d);
  for (const d of data.book.dates("SENSEX")) calSet.add(d);
  for (const d of oiDates) calSet.add(d);
  for (const d of MUHURAT) calSet.add(d);
  const cal = [...calSet].sort();
  const special = new Set<string>([...cal.filter((d) => weekdayOf(d) >= 6 || MUHURAT.includes(d)), ...data.special]);
  const sessions = cal.filter((d) => !special.has(d));
  const vixBars = [...loadYahooDaily(I.vix)].filter(([, b]) => b).sort(([a], [b]) => a.localeCompare(b));
  return {
    data,
    yahoo,
    cal,
    special,
    sessions,
    sessionSet: new Set(sessions),
    book: { NIFTY: new Set(data.book.dates("NIFTY")), SENSEX: new Set(data.book.dates("SENSEX").filter((d) => d >= BSE_DAILY_FROM)) },
    vixDays: vixBars.map(([d]) => d),
    vixClose: vixBars.map(([, b]) => b!.c),
    oiDates,
  };
}

/** India VIX close of the last day strictly before `day` (Yahoo); null when there is none. */
function vixPrev(w: World, day: string): number | null {
  let lo = 0;
  let hi = w.vixDays.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (w.vixDays[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? w.vixClose[lo - 1] : null;
}

/** The index's official close: NSE's UndrlygPric in the UDiFF bhavcopy (NIFTY, from 8 Jan 2024), else Yahoo's close. */
function officialClose(w: World, sym: Sym, day: string): number | null {
  if (sym === "NIFTY") {
    const u = w.data.book.rows("NIFTY", day).find((r) => r.underlying !== null && r.underlying > 0)?.underlying;
    if (u) return u;
  }
  const b = w.yahoo[sym].get(day);
  return b ? b.c : null;
}

/**
 * The final settlement level of an expiry: the exchange's printed level (the median settle on that day's
 * expiring options: NSE SttlmPric, BSE's expiry-day Close; WP10's settlementLevel), else the index's
 * official close on the expiry day (NSE's legacy files of Feb 2019 – Jan 2020 print 0 there).
 */
function settlementLevel(w: World, sym: Sym, x: string): { level: number; printed: number | null; official: number | null } | null {
  const xs = w.data.book
    .rows(sym, x)
    .filter((r) => r.kind === "OPT" && r.expiry === x && r.settle !== null && r.settle > 0.5 * r.strike)
    .map((r) => r.settle!)
    .sort((a, b) => a - b);
  const printed = xs.length ? xs[Math.floor((xs.length - 1) / 2)] : null;
  const official = officialClose(w, sym, x);
  const level = printed ?? official;
  return level === null ? null : { level, printed, official };
}

/** Weekly expiries of an index: the nearest listed expiry on or after each regular session of its own bhavcopy (WP10). */
function weeklyExpiries(w: World, sym: Sym): string[] {
  const s = new Set<string>();
  const days = [...w.book[sym]].sort();
  for (const d of days) {
    if (w.special.has(d)) continue;
    const e = w.data.book.expiries(sym, d)[0];
    if (e) s.add(e);
  }
  const last = days.at(-1) ?? "";
  return [...s].filter((e) => e <= last).sort();
}

// ---------------------------------------------------------------------------
// Configurations, trades and runs (report §1.2–§1.4)
// ---------------------------------------------------------------------------

interface Cfg {
  family: Family;
  sym: Sym;
  mgmt: Mgmt;
  m: number;
  n: number;
  /** The long strike's distance beyond the short one, in EM. */
  width: number;
  /** Family M: the entry and the (early) exit minute. */
  entryMin: number;
  exitMin: number;
}

const baseCfg = (family: Family, sym: Sym, mgmt: Mgmt, m: number, n: number): Cfg => ({ family, sym, mgmt, m, n, width: WIDTH_EM, entryMin: ENTRY_MIN, exitMin: EXIT_MIN });
const fmtM = (m: number) => (Number.isInteger(m) ? m.toFixed(1) : String(Number(m.toFixed(2))));
const SIDE_LABEL: Record<SpreadSide, string> = { put: "bull put spread", call: "bear call spread (mirror)" };

function cfgName(c: Cfg, side: SpreadSide, mode: Mode): string {
  const entry = c.family === "D" ? `entry at the close ${c.n} sessions before expiry` : `entry ${minToHhmm(c.entryMin)} ${c.n} sessions before expiry`;
  const exit = c.mgmt === "hold" ? "hold to settlement" : c.family === "D" ? "exit at the close of the session before expiry" : `exit ${minToHhmm(c.exitMin)} on the session before expiry`;
  return `${c.sym} ${c.family} ${SIDE_LABEL[side]} ${fmtM(c.m)} EM out, width ${fmtM(c.width)} EM, ${entry}, ${exit}, ${mode}`;
}

/** One side (the bull put spread or its mirror) of one trade. */
interface SideRes {
  ks: number;
  kl: number;
  width: number;
  /** ₹ per lot received at the entry fills: (short fill − long fill) × lot. */
  credit: number;
  /** ₹ per lot of the short leg at its entry fill. */
  premium: number;
  /** Per unit: the spread's value at the exit (settlement intrinsic, or short exit price − long exit price). */
  value: number;
  gross: number;
  spread: number;
  charges: number;
  net: number;
  /** Gross ₹ per lot of each leg at its fills (the decomposition). */
  shortGross: number;
  longGross: number;
  /** width × lot − credit (₹ per lot). */
  maxLoss: number;
  /** The spread finished at its full width (the long strike breached). */
  fullLoss: boolean;
  /** The short strike finished in the money (at settlement, or the index beyond it at the exit). */
  breach: boolean;
  /** Exit legs that did not trade on the exit day (daily closes; their printed close was used). */
  untradedExit: number;
  /** Family M: the exit used each leg's last close before the exit minute. */
  stale: boolean;
}

interface Trade16 {
  expiry: string;
  week: string;
  entry: string;
  exit: string;
  n: number;
  lot: number;
  level: number;
  vix: number;
  em: number;
  /** The index at the exit (the settlement level when held, else the exit day's close or the index at the exit minute). */
  exitLevel: number;
  move: number;
  /** Margin approximation of the bull put spread at entry, and at its peak (with the expiry-day 2% when held into the expiry day). */
  marginEntry: number;
  marginPeak: number;
  /** Hold-to-settlement and early: the bull put spread's worst mark at a close between entry and exit (₹ per lot, before costs). */
  worstMark: number | null;
  put: SideRes;
  call: SideRes;
}

interface Run {
  name: string;
  cfg: Cfg;
  mode: Mode;
  kind: "strategy" | "perturbation";
  base?: string;
  label?: string;
  trades: Trade16[];
  skips: Record<string, number>;
  /** The expiry weeks of the family's eligible expiries for the index (the per-week slots). */
  weeks: string[];
}

function emptyRun(cfg: Cfg, mode: Mode, weeks: string[], kind: Run["kind"] = "strategy", base?: string, label?: string): Run {
  return { name: cfgName(cfg, "put", mode) + (label ? ` [${label}]` : ""), cfg, mode, kind, base, label, trades: [], skips: {}, weeks };
}

// ---------------------------------------------------------------------------
// Expiries and samples (report §1.3)
// ---------------------------------------------------------------------------

interface ExpiryCtx {
  sym: Sym;
  x: string;
  week: string;
  /** Settlement level (synthetic under --smoke). */
  settle: number;
  /** The four regular sessions before the expiry: x−1 (the early exit's day), x−2, x−3, x−4. */
  before: string[];
}

interface Sample {
  family: Family;
  sym: Sym;
  expiries: ExpiryCtx[];
  skips: Record<string, number>;
  /** The skipped expiries by reason. */
  skipped: Record<string, string[]>;
  candidates: number;
  cut: string;
  weeks: string[];
}

/** The eligible expiries of a family and index (report §1.3): data on every session from x−5 to x and a settlement level. */
function sample(w: World, sym: Sym, family: Family, mctx: MCtx | null, smoke: boolean): Sample {
  const counts: Record<string, number> = {};
  const skipped: Record<string, string[]> = {};
  const expiries: ExpiryCtx[] = [];
  const all = weeklyExpiries(w, sym);
  let candidates = 0;
  const skip = (why: string, x: string) => {
    bump(counts, why);
    (skipped[why] ??= []).push(x);
  };
  for (const x of all) {
    if (family === "M" && (!mctx || x > mctx.last || x < mctx.first)) continue;
    candidates++;
    if (!w.sessionSet.has(x)) {
      skip("expiry not a regular session", x);
      continue;
    }
    const before = [1, 2, 3, 4, 5].map((k) => nthSessionBefore(w.sessions, x, k));
    if (before.some((d) => d === null)) {
      skip("fewer than five sessions before the expiry in the calendar", x);
      continue;
    }
    const days = before as string[];
    if (days.slice(0, 4).some((d) => !w.book[sym].has(d)) || !w.book[sym].has(x)) {
      skip("no bhavcopy of the index's exchange on a session from x−4 to x", x);
      continue;
    }
    if (family === "M") {
      const c = mctx!;
      if (days.slice(0, 4).some((d) => !c.daySet.has(d))) {
        skip("a session from x−4 to x−1 is not a valid 1-minute session", x);
        continue;
      }
      if (days.slice(0, 4).some((d) => !c.man.pairs[`${d}_${x}`])) {
        skip("the contract is missing from the 1-minute extract on a session from x−4 to x−1", x);
        continue;
      }
    }
    const st = settlementLevel(w, sym, x);
    if (!st) {
      skip("no settlement level", x);
      continue;
    }
    const settle = smoke ? st.level * (1 + 0.03 * fake(`${sym}|${x}|settle`) + SMOKE_BIAS) : st.level;
    expiries.push({ sym, x, week: weekKey(x), settle, before: days.slice(0, 4) });
  }
  const cut = cutDate(expiries.map((e) => e.x), IS_FRAC) ?? "9999-12-31";
  return { family, sym, expiries, skips: counts, skipped, candidates, cut, weeks: [...new Set(expiries.map((e) => e.week))].sort() };
}

// ---------------------------------------------------------------------------
// Family D: the exchanges' daily closing prices (report §1.4)
// ---------------------------------------------------------------------------

const strikeCache = new Map<string, number[]>();
/** Strikes of an expiry with a traded contract of the type on a day (contracts > 0 and a closing price). */
function tradedStrikes(w: World, sym: Sym, day: string, x: string, t: OptType): number[] {
  const k = `${sym}|${day}|${x}|${t}`;
  let s = strikeCache.get(k);
  if (!s) {
    s = w.data.book.strikes(sym, day, x).filter((strike) => {
      const r = w.data.book.option(sym, day, x, strike, t);
      return r !== undefined && r.contracts > 0 && r.close !== null && r.close > 0;
    });
    strikeCache.set(k, s);
    if (strikeCache.size > 4096) strikeCache.delete(strikeCache.keys().next().value!);
  }
  return s;
}

const optType = (side: SpreadSide): OptType => (side === "put" ? "PE" : "CE");

interface EntryPlan {
  e: string;
  exitDay: string;
  lot: number;
  level: number;
  vix: number;
  em: number;
  put: SpreadStrikes;
  call: SpreadStrikes;
}

/** The entry session, the index level and EM, and both spreads' strikes (no prices). */
function planD(w: World, ex: ExpiryCtx, c: Cfg): EntryPlan | { skip: string } {
  const e = nthSessionBefore(w.sessions, ex.x, c.n);
  const exitDay = ex.before[0];
  if (!e) return { skip: "no entry session" };
  if (!w.book[c.sym].has(e)) return { skip: "no bhavcopy of the index's exchange on the entry session" };
  if (c.mgmt === "early" && !(exitDay > e)) return { skip: "the entry is the session before expiry (no early exit)" };
  const level = officialClose(w, c.sym, e);
  const vix = vixPrev(w, e);
  if (level === null || vix === null) return { skip: "no index close or India VIX" };
  const em = level * (vix / 100) * Math.sqrt(c.n / 252);
  const put = spreadStrikes(tradedStrikes(w, c.sym, e, ex.x, "PE"), level, em, c.m, { kind: "em", mult: c.width }, "put", DEF[c.sym].step);
  const call = spreadStrikes(tradedStrikes(w, c.sym, e, ex.x, "CE"), level, em, c.m, { kind: "em", mult: c.width }, "call", DEF[c.sym].step);
  if (!put || !call) return { skip: "no traded strike for a leg of either spread" };
  const lot = lotOf(w.data, c.sym, e, ex.x);
  if (lot === null) return { skip: "no lot in the bhavcopy" };
  return { e, exitDay, lot, level, vix, em, put, call };
}

/** The bull put spread's worst mark at a close strictly between two sessions (₹ per lot before costs, against its entry fills). */
function worstMarkOf(w: World, sym: Sym, x: string, s: SpreadStrikes, side: SpreadSide, from: string, to: string, unitCredit: number, lot: number): number | null {
  let worst: number | null = null;
  const t = optType(side);
  let lo = 0;
  let hi = w.sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (w.sessions[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < w.sessions.length; i++) {
    const d = w.sessions[i];
    if (d >= to) break;
    const a = w.data.book.option(sym, d, x, s.short, t)?.close;
    const b = w.data.book.option(sym, d, x, s.long, t)?.close;
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const mark = SMOKE ? 300 * fake(`${sym}|${x}|${d}|mark`) : (unitCredit - (a - b)) * lot;
    worst = worst === null ? mark : Math.min(worst, mark);
  }
  return worst;
}

function sideD(w: World, ex: ExpiryCtx, c: Cfg, p: EntryPlan, side: SpreadSide, mode: Mode): SideRes | { skip: string } {
  const sym = c.sym;
  const t = optType(side);
  const s = p[side];
  const rS = w.data.book.option(sym, p.e, ex.x, s.short, t)!;
  const rL = w.data.book.option(sym, p.e, ex.x, s.long, t)!;
  let sIn = rS.close!;
  let lIn = rL.close!;
  let sOut: number;
  let lOut: number;
  let untraded = 0;
  const z = `${sym}|${ex.x}|${p.e}|${side}|${s.short}|${s.long}`;
  if (SMOKE) {
    sIn = 40 + 20 * fake(`${z}|s`);
    lIn = sIn * (0.4 + 0.3 * Math.abs(fake(`${z}|l`)));
  }
  if (c.mgmt === "hold") {
    sOut = intrinsic(t, s.short, ex.settle);
    lOut = intrinsic(t, s.long, ex.settle);
  } else {
    const xS = w.data.book.option(sym, p.exitDay, ex.x, s.short, t);
    const xL = w.data.book.option(sym, p.exitDay, ex.x, s.long, t);
    const ok = (r: BhavRow | undefined): r is BhavRow => !!r && r.close !== null && r.close >= 0;
    if (!ok(xS) || !ok(xL)) return { skip: "no closing price for a leg on the exit day" };
    untraded = (xS.contracts > 0 ? 0 : 1) + (xL.contracts > 0 ? 0 : 1);
    const tilt = 1 + (side === "put" ? -8 : 8) * SMOKE_BIAS;
    sOut = SMOKE ? Math.max(0, sIn * (0.5 + 0.6 * fake(`${z}|xs`)) * tilt) : xS.close!;
    lOut = SMOKE ? Math.max(0, lIn * (0.5 + 0.6 * fake(`${z}|xl`)) * tilt) : xL.close!;
  }
  const spread = SPREAD_OF[mode];
  const settled = c.mgmt === "hold";
  const legs: LegSpec[] = [
    { side: "short", entry: sIn, exit: sOut, settled },
    { side: "long", entry: lIn, exit: lOut, settled },
  ];
  const pnl = structurePnl(legs, { lot: p.lot, exchange: DEF[sym].exchange, entryDate: p.e, exitDate: settled ? ex.x : p.exitDay, spread });
  const sellFill = Math.max(0, sIn - spread(sIn) / 2);
  const buyFill = lIn + spread(lIn) / 2;
  const width = spreadWidth(s);
  const value = settled ? spreadValueAt(side, s, ex.settle) : sOut - lOut;
  const exitLevel = settled ? ex.settle : (SMOKE ? p.level * (1 + 0.02 * fake(`${z}|lvl`)) : (officialClose(w, sym, p.exitDay) ?? NaN));
  return {
    ks: s.short,
    kl: s.long,
    width,
    credit: (sellFill - buyFill) * p.lot,
    premium: sellFill * p.lot,
    value,
    gross: pnl.gross,
    spread: pnl.spread,
    charges: pnl.charges,
    net: pnl.net,
    shortGross: (sIn - sOut) * p.lot,
    longGross: (lOut - lIn) * p.lot,
    maxLoss: width * p.lot - (sellFill - buyFill) * p.lot,
    fullLoss: value >= width - TICK / 2,
    breach: side === "put" ? exitLevel < s.short : exitLevel > s.short,
    untradedExit: untraded,
    stale: false,
  };
}

function tradeOf(w: World, ex: ExpiryCtx, c: Cfg, p: EntryPlan, put: SideRes, call: SideRes, exitLevel: number, worstMark: number | null): Trade16 {
  const width = spreadWidth(p.put);
  const mEntry = spreadMargin({ width, lot: p.lot, level: p.level, onExpiryDay: false, date: p.e }).total;
  const mPeak = c.mgmt === "hold" ? Math.max(mEntry, spreadMargin({ width, lot: p.lot, level: p.level, onExpiryDay: true, date: ex.x }).total) : mEntry;
  return {
    expiry: ex.x,
    week: ex.week,
    entry: p.e,
    exit: c.mgmt === "hold" ? ex.x : p.exitDay,
    n: c.n,
    lot: p.lot,
    level: p.level,
    vix: p.vix,
    em: p.em,
    exitLevel,
    move: exitLevel / p.level - 1,
    marginEntry: mEntry,
    marginPeak: mPeak,
    worstMark,
    put,
    call,
  };
}

function priceD(w: World, ex: ExpiryCtx, c: Cfg, mode: Mode): Trade16 | { skip: string } {
  const p = planD(w, ex, c);
  if ("skip" in p) return p;
  const put = sideD(w, ex, c, p, "put", mode);
  if ("skip" in put) return put;
  const call = sideD(w, ex, c, p, "call", mode);
  if ("skip" in call) return call;
  const exitLevel = c.mgmt === "hold" ? ex.settle : SMOKE ? p.level * (1 + 0.02 * fake(`${c.sym}|${ex.x}|${p.e}|lvl`)) : (officialClose(w, c.sym, p.exitDay) ?? NaN);
  const unitCredit = put.credit / p.lot;
  const wm = worstMarkOf(w, c.sym, ex.x, p.put, "put", p.e, c.mgmt === "hold" ? ex.x : p.exitDay, unitCredit, p.lot);
  return tradeOf(w, ex, c, p, put, call, exitLevel, wm);
}

// ---------------------------------------------------------------------------
// Family M: 15:20 on real 1-minute bars (report §1.4)
// ---------------------------------------------------------------------------

interface MCtx {
  sym: Sym;
  x: string;
  man: Manifest[string];
  index: Map<string, MinuteBar[]>;
  /** Valid 1-minute sessions (WP11 §1.1, special sessions excluded). */
  daySet: Set<string>;
  first: string;
  last: string;
  chains: Map<string, ChainDay | null>;
  idx: Map<string, MinuteSeries>;
}

function mCtx(w: World, sym: Sym, x: string): MCtx {
  const man = loadManifest(x)[sym];
  const index = loadIndex(x, sym);
  const days = man.sessions.filter((day) => {
    const session = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m < CLOSE_MIN);
    return w.book[sym].has(day) && !w.special.has(day) && session.length >= MIN_INDEX_BARS && session[0]?.m === OPEN_MIN;
  });
  const optDays = Object.keys(man.pairs).map((k) => k.slice(0, 10)).sort();
  return { sym, x, man, index, daySet: new Set(days), first: optDays[0], last: man.sessions.at(-1)!, chains: new Map(), idx: new Map() };
}

/** A contract's bars on a day, cached (expiries are visited in date order). */
function chainOf(c: MCtx, day: string, expiry: string): ChainDay | null {
  const k = `${day}_${expiry}`;
  if (!c.chains.has(k)) {
    const info = c.man.pairs[k];
    c.chains.set(k, info ? loadChainDay(c.x, c.sym, day, expiry, info.role) : null);
    if (c.chains.size > 24) c.chains.delete(c.chains.keys().next().value!);
  }
  return c.chains.get(k)!;
}

function idxOf(c: MCtx, day: string): MinuteSeries {
  let s = c.idx.get(day);
  if (!s) {
    s = new MinuteSeries((c.index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= CLOSE_MIN));
    c.idx.set(day, s);
    if (c.idx.size > 24) c.idx.delete(c.idx.keys().next().value!);
  }
  return s;
}

interface MPlan extends EntryPlan {
  chainE: ChainDay;
  chainX: ChainDay | null;
}

/** As planD at 15:20 on 1-minute bars: the index level is the close of the bar before the order. */
function planM(w: World, mc: MCtx, ex: ExpiryCtx, c: Cfg): MPlan | { skip: string } {
  const e = nthSessionBefore(w.sessions, ex.x, c.n);
  const exitDay = ex.before[0];
  if (!e) return { skip: "no entry session" };
  if (!mc.daySet.has(e)) return { skip: "the entry session is not a valid 1-minute session" };
  if (c.mgmt === "early" && !(exitDay > e)) return { skip: "the entry is the session before expiry (no early exit)" };
  const chainE = chainOf(mc, e, ex.x);
  if (!chainE) return { skip: "the contract is missing from the 1-minute extract on the entry session" };
  const level = idxOf(mc, e).lastUpTo(c.entryMin - 1)?.c;
  const vix = vixPrev(w, e);
  if (level === undefined || vix === null) return { skip: "no index level or India VIX" };
  const em = level * (vix / 100) * Math.sqrt(c.n / 252);
  const put = spreadStrikes(tradedStrikes(w, c.sym, e, ex.x, "PE"), level, em, c.m, { kind: "em", mult: c.width }, "put", DEF[c.sym].step);
  const call = spreadStrikes(tradedStrikes(w, c.sym, e, ex.x, "CE"), level, em, c.m, { kind: "em", mult: c.width }, "call", DEF[c.sym].step);
  if (!put || !call) return { skip: "no traded strike for a leg of either spread" };
  const lot = lotOf(w.data, c.sym, e, ex.x);
  if (lot === null) return { skip: "no lot in the bhavcopy" };
  const chainX = c.mgmt === "early" ? chainOf(mc, exitDay, ex.x) : null;
  if (c.mgmt === "early" && !chainX) return { skip: "the contract is missing from the 1-minute extract on the exit day" };
  return { e, exitDay, lot, level, vix, em, put, call, chainE, chainX };
}

/** Bar presence for the M coverage rule: both spreads' legs share an entry minute (no prices are read). */
function mEntryPresent(p: MPlan, c: Cfg): boolean {
  const ser = (s: SpreadStrikes, t: OptType) => [p.chainE.series.get(key(s.short, t)), p.chainE.series.get(key(s.long, t))];
  for (const [s, t] of [
    [p.put, "PE"],
    [p.call, "CE"],
  ] as const) {
    const [a, b] = ser(s, t);
    if (!a || !b) return false;
    let ok = false;
    for (let m = c.entryMin; m <= c.entryMin + ENTRY_WAIT && !ok; m++) ok = a.at(m) !== undefined && b.at(m) !== undefined;
    if (!ok) return false;
  }
  return true;
}

/**
 * The M coverage rule (report §1.4), by bar presence only: per base cell (m, N), the eligible expiries on
 * which both spreads' legs share an entry minute, and the cells that reach M_COVERAGE_MIN. Expiries are
 * the outer loop so each 1-minute file is read once.
 */
function mCoverage(w: World, mc: MCtx, smp: Sample): { ok: Map<string, number>; keep: Set<string>; skips: Map<string, Record<string, number>> } {
  const ok = new Map<string, number>();
  const skips = new Map<string, Record<string, number>>();
  const cells = M_SET.flatMap((m) => N_SET.map((n) => ({ m, n, k: `${m}|${n}` })));
  for (const z of cells) {
    ok.set(z.k, 0);
    skips.set(z.k, {});
  }
  for (const ex of smp.expiries)
    for (const z of cells) {
      const c = baseCfg("M", smp.sym, "hold", z.m, z.n);
      const p = planM(w, mc, ex, c);
      if ("skip" in p) bump(skips.get(z.k)!, p.skip);
      else if (!mEntryPresent(p, c)) bump(skips.get(z.k)!, "no common entry minute for a spread's legs");
      else ok.set(z.k, ok.get(z.k)! + 1);
    }
  const keep = new Set(cells.filter((z) => smp.expiries.length > 0 && ok.get(z.k)! / smp.expiries.length >= M_COVERAGE_MIN).map((z) => z.k));
  return { ok, keep, skips };
}

function sideM(w: World, mc: MCtx, ex: ExpiryCtx, c: Cfg, p: MPlan, side: SpreadSide, mode: Mode): SideRes | { skip: string } {
  const sym = c.sym;
  const t = optType(side);
  const s = p[side];
  const aS = p.chainE.series.get(key(s.short, t));
  const aL = p.chainE.series.get(key(s.long, t));
  if (!aS || !aL) return { skip: "a leg has no 1-minute bars on the entry session" };
  const en = spreadEntry(aS, aL, c.entryMin, ENTRY_WAIT, mode);
  if (!en) return { skip: "no minute in the entry window in which both legs of a spread traded" };
  let sIn = en.shortIn;
  let lIn = en.longIn;
  const z = `${sym}|${ex.x}|${p.e}|${side}|${s.short}|${s.long}|${c.entryMin}|${mode}`;
  if (SMOKE) {
    sIn = 40 + 20 * fake(`${z}|s`);
    lIn = sIn * (0.4 + 0.3 * Math.abs(fake(`${z}|l`)));
  }
  let sOut: number;
  let lOut: number;
  let stale = false;
  let exitLevel = ex.settle;
  if (c.mgmt === "hold") {
    sOut = intrinsic(t, s.short, ex.settle);
    lOut = intrinsic(t, s.long, ex.settle);
  } else {
    const xo = spreadExit(p.chainX!.series.get(key(s.short, t)) ?? null, p.chainX!.series.get(key(s.long, t)) ?? null, c.exitMin, EXIT_WAIT, mode);
    if (!xo) return { skip: "no exit price on the exit day" };
    stale = xo.stale;
    const tilt = 1 + (side === "put" ? -8 : 8) * SMOKE_BIAS;
    sOut = SMOKE ? Math.max(0, sIn * (0.5 + 0.6 * fake(`${z}|xs`)) * tilt) : xo.shortOut;
    lOut = SMOKE ? Math.max(0, lIn * (0.5 + 0.6 * fake(`${z}|xl`)) * tilt) : xo.longOut;
    const lv = idxOf(mc, p.exitDay).lastUpTo(c.exitMin)?.c;
    exitLevel = SMOKE ? p.level * (1 + 0.02 * fake(`${z}|lvl`)) : (lv ?? NaN);
  }
  const settled = c.mgmt === "hold";
  const legs: LegSpec[] = [
    { side: "short", entry: sIn, exit: sOut, settled },
    { side: "long", entry: lIn, exit: lOut, settled },
  ];
  const pnl = structurePnl(legs, { lot: p.lot, exchange: DEF[sym].exchange, entryDate: p.e, exitDate: settled ? ex.x : p.exitDay, spread: () => 0 });
  const width = spreadWidth(s);
  const value = settled ? spreadValueAt(side, s, ex.settle) : sOut - lOut;
  return {
    ks: s.short,
    kl: s.long,
    width,
    credit: (sIn - lIn) * p.lot,
    premium: sIn * p.lot,
    value,
    gross: pnl.gross,
    spread: pnl.spread,
    charges: pnl.charges,
    net: pnl.net,
    shortGross: (sIn - sOut) * p.lot,
    longGross: (lOut - lIn) * p.lot,
    maxLoss: width * p.lot - (sIn - lIn) * p.lot,
    fullLoss: value >= width - TICK / 2,
    breach: side === "put" ? exitLevel < s.short : exitLevel > s.short,
    untradedExit: 0,
    stale,
  };
}

function priceM(w: World, mc: MCtx, ex: ExpiryCtx, c: Cfg, mode: Mode): Trade16 | { skip: string } {
  const p = planM(w, mc, ex, c);
  if ("skip" in p) return p;
  const put = sideM(w, mc, ex, c, p, "put", mode);
  if ("skip" in put) return put;
  const call = sideM(w, mc, ex, c, p, "call", mode);
  if ("skip" in call) return call;
  let exitLevel = ex.settle;
  if (c.mgmt === "early") {
    const lv = idxOf(mc, p.exitDay).lastUpTo(c.exitMin)?.c;
    exitLevel = SMOKE ? p.level * (1 + 0.02 * fake(`${c.sym}|${ex.x}|${p.e}|mlvl`)) : (lv ?? NaN);
  }
  const wm = worstMarkOf(w, c.sym, ex.x, p.put, "put", p.e, c.mgmt === "hold" ? ex.x : p.exitDay, put.credit / p.lot, p.lot);
  return tradeOf(w, ex, c, p, put, call, exitLevel, wm);
}

/** Every configuration × fill of one family and index, in one pass over its eligible expiries. */
function buildRuns(w: World, smp: Sample, mc: MCtx | null, cfgs: readonly { cfg: Cfg; kind: Run["kind"]; base?: string; label?: string }[]): Run[] {
  const runs: Run[] = [];
  for (const z of cfgs) for (const mode of MODES) runs.push(emptyRun(z.cfg, mode, smp.weeks, z.kind, z.base ? `${z.base}` : undefined, z.label));
  for (const ex of smp.expiries) {
    for (const r of runs) {
      const res = r.cfg.family === "D" ? priceD(w, ex, r.cfg, r.mode) : priceM(w, mc!, ex, r.cfg, r.mode);
      if ("skip" in res) bump(r.skips, res.skip);
      else r.trades.push(res);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Statistics (report §1.5)
// ---------------------------------------------------------------------------

interface Sub {
  label: string;
  n: number;
  /** Eligible expiry weeks in the window (the per-week denominator). */
  weeks: number;
  net: number;
  mean: number;
  lo: number;
  hi: number;
  wLo: number;
  wHi: number;
  pf: number;
  hit: number;
  boot: BlockBootstrap;
  /** The bull put spread minus a fair coin between it and the mirror bear call spread, paired by expiry week. */
  gap: ReturnType<typeof pairedGap>;
  /** Per eligible week, net ÷ ₹5 lakh (weeks without a trade are 0): the DSR's series. */
  rets: number[];
}

const sideNet = (t: Trade16, side: SpreadSide) => t[side].net;

function subOf(r: Run, side: SpreadSide, label: string, f: (t: Trade16) => boolean, wf: (week: string) => boolean, resamples: number): Sub {
  const ts = r.trades.filter(f);
  const weeks = r.weeks.filter(wf);
  const blocks = blocksOf(ts.map((t) => ({ block: t.week, net: sideNet(t, side) })), weeks);
  const boot = dayBlockBootstrap(blocks, { resamples, seed: SEED });
  const nets = ts.map((t) => sideNet(t, side));
  // Placebo: per expiry week, the side taken against a fair coin between it and the other side.
  const byWeek = new Map<string, { s: number[]; o: number[] }>();
  for (const t of ts) {
    const e = byWeek.get(t.week) ?? { s: [], o: [] };
    e.s.push(sideNet(t, side));
    e.o.push(sideNet(t, side === "put" ? "call" : "put"));
    byWeek.set(t.week, e);
  }
  const days: PairedDay[] = [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([, e]) => ({ n: e.s.length, s: avg(e.s), p: (avg(e.s) + avg(e.o)) / 2 }));
  return {
    label,
    n: ts.length,
    weeks: blocks.length,
    net: sum(nets),
    mean: avg(nets),
    lo: boot.perTrade.lo,
    hi: boot.perTrade.hi,
    wLo: boot.perSession.lo,
    wHi: boot.perSession.hi,
    pf: profitFactor(nets),
    hit: ts.length ? nets.filter((x) => x > 0).length / ts.length : NaN,
    boot,
    gap: pairedGap(days),
    rets: blocks.map((b) => sum(b.pnls) / CAPITAL),
  };
}

interface Econ {
  credit: number;
  creditPerWidth: number;
  payoutPerWidth: number;
  premium: number;
  charges: number;
  spreadCost: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  breach: number;
  fullLoss: number;
  fullLossN: number;
  maxLoss: number;
  maxLossMax: number;
  marginEntry: number;
  marginPeakMax: number;
  marginMin: number;
  smallFits: number;
  shortGross: number;
  longGross: number;
  worstMark: number | null;
  worstMarkDay: string;
  untradedExit: number;
  stale: number;
}

function econOf(trades: readonly Trade16[], side: SpreadSide): Econ {
  const s = trades.map((t) => t[side]);
  const wins = s.filter((x) => x.net > 0).map((x) => x.net);
  const losses = s.filter((x) => x.net <= 0).map((x) => x.net);
  const wm = trades.filter((t) => t.worstMark !== null).reduce<{ v: number; d: string } | null>((a, t) => (a === null || t.worstMark! < a.v ? { v: t.worstMark!, d: t.expiry } : a), null);
  return {
    credit: avg(s.map((x) => x.credit)),
    creditPerWidth: avg(trades.map((t) => t[side].credit / t.lot / t[side].width)),
    payoutPerWidth: avg(s.map((x) => x.value / x.width)),
    premium: avg(s.map((x) => x.premium)),
    charges: avg(s.map((x) => x.charges)),
    spreadCost: avg(s.map((x) => x.spread)),
    winRate: s.length ? wins.length / s.length : NaN,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    breach: s.length ? s.filter((x) => x.breach).length / s.length : NaN,
    fullLoss: s.length ? s.filter((x) => x.fullLoss).length / s.length : NaN,
    fullLossN: s.filter((x) => x.fullLoss).length,
    maxLoss: avg(s.map((x) => x.maxLoss)),
    maxLossMax: s.length ? Math.max(...s.map((x) => x.maxLoss)) : NaN,
    marginEntry: avg(trades.map((t) => t.marginEntry)),
    marginPeakMax: trades.length ? Math.max(...trades.map((t) => t.marginPeak)) : NaN,
    marginMin: trades.length ? Math.min(...trades.map((t) => t.marginEntry)) : NaN,
    smallFits: trades.length ? trades.filter((t) => t.marginEntry <= SMALL_ACCOUNT).length / trades.length : NaN,
    shortGross: avg(s.map((x) => x.shortGross)),
    longGross: avg(s.map((x) => x.longGross)),
    worstMark: wm?.v ?? null,
    worstMarkDay: wm?.d ?? "",
    untradedExit: s.length ? s.filter((x) => x.untradedExit > 0).length / s.length : NaN,
    stale: s.length ? s.filter((x) => x.stale).length / s.length : NaN,
  };
}

interface Tail {
  worst: { expiry: string; entry: string; net: number; move: number; ks: number; kl: number; lot: number; credit: number }[];
  var5: number;
  es5: number;
  var1: number;
  es1: number;
  maxDD: number;
  ddFrom: string;
  ddTo: string;
  longestLosing: number;
  /** The worst 5% of trades summed, as a multiple of the variant's total net. */
  tailMultiple: number;
}

function tailOf(trades: readonly Trade16[], side: SpreadSide): Tail {
  const ts = [...trades].sort((a, b) => a.expiry.localeCompare(b.expiry));
  const nets = ts.map((t) => t[side].net);
  const dd = maxDrawdown(nets);
  let run = 0;
  let longest = 0;
  for (const x of nets) {
    run = x <= 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const t5 = tailRisk(nets, 0.05);
  const t1 = tailRisk(nets, 0.01);
  const total = sum(nets);
  const k5 = Math.max(1, Math.floor(0.05 * nets.length));
  const worst5 = sum([...nets].sort((a, b) => a - b).slice(0, k5));
  return {
    worst: [...ts]
      .sort((a, b) => a[side].net - b[side].net)
      .slice(0, 10)
      .map((t) => ({ expiry: t.expiry, entry: t.entry, net: t[side].net, move: t.move, ks: t[side].ks, kl: t[side].kl, lot: t.lot, credit: t[side].credit })),
    var5: t5.var,
    es5: t5.es,
    var1: t1.var,
    es1: t1.es,
    maxDD: dd.depth,
    ddFrom: dd.peak >= 0 ? ts[dd.peak].expiry : "start",
    ddTo: dd.trough >= 0 ? ts[dd.trough].expiry : "",
    longestLosing: longest,
    tailMultiple: total !== 0 ? worst5 / total : NaN,
  };
}

interface Stats {
  full: Sub;
  is: Sub;
  oos: Sub;
  half1: Sub;
  half2: Sub;
  era1: Sub;
  era2: Sub;
  oosEra1: Sub;
  oosEra2: Sub;
  pre2026: Sub;
  post2026: Sub;
  years: { year: string; n: number; net: number; mean: number; pctCapital: number }[];
  events: { key: string; n: number; mean: number }[];
  econ: Econ;
  tail: Tail;
  sr: number;
}

function statsOf(r: Run, side: SpreadSide, cut: string, light = false): Stats {
  const nb = (k: number) => (light ? BOOT_LIGHT : k);
  const sub = (label: string, f: (t: Trade16) => boolean, wf: (week: string) => boolean, k: number) => subOf(r, side, label, f, wf, nb(k));
  const cutWeek = weekKey(cut);
  const full = sub("all", () => true, () => true, BOOT);
  let oos = sub("last 40%", (t) => t.expiry > cut, (wk) => wk > cutWeek, BOOT);
  if (!light && oos.lo > 0 && oos.wLo > 0) oos = sub("last 40%", (t) => t.expiry > cut, (wk) => wk > cutWeek, BOOT_FINAL);
  const sorted = [...r.trades].sort((a, b) => a.expiry.localeCompare(b.expiry));
  const mid = sorted[Math.ceil(sorted.length / 2) - 1]?.expiry ?? "";
  const midWeek = mid ? weekKey(mid) : "";
  const eraWeek = weekKey(ERA_END);
  const sttWeek = weekKey(STT_2026);
  const years = [...new Set(r.trades.map((t) => t.expiry.slice(0, 4)))].sort().map((year) => {
    const xs = r.trades.filter((t) => t.expiry.startsWith(year)).map((t) => t[side].net);
    return { year, n: xs.length, net: sum(xs), mean: avg(xs), pctCapital: sum(xs) / CAPITAL };
  });
  // Scheduled events (WP10 §1.6) inside the holding period: from the session after the entry to the exit.
  const evKind = (t: Trade16): string => {
    let k: string | null = null;
    for (const e of EVENT_DATES) if (e.date > t.entry && e.date <= t.exit) k = k ?? e.kind;
    return k ? `${k} in the holding period` : "no scheduled event";
  };
  const events = ["budget in the holding period", "rbi in the holding period", "election in the holding period", "no scheduled event"].map((k) => {
    const xs = r.trades.filter((t) => evKind(t) === k).map((t) => t[side].net);
    return { key: k, n: xs.length, mean: avg(xs) };
  });
  return {
    full,
    is: sub("first 60%", (t) => t.expiry <= cut, (wk) => wk <= cutWeek, BOOT_SUB),
    oos,
    half1: sub("first half", (t) => t.expiry <= mid, (wk) => wk <= midWeek, BOOT_LIGHT),
    half2: sub("second half", (t) => t.expiry > mid, (wk) => wk > midWeek, BOOT_LIGHT),
    era1: sub("to Dec 2024", (t) => t.expiry <= ERA_END, (wk) => wk <= eraWeek, BOOT_SUB),
    era2: sub("from Jan 2025", (t) => t.expiry > ERA_END, (wk) => wk > eraWeek, BOOT_SUB),
    oosEra1: sub("last 40%, to Dec 2024", (t) => t.expiry > cut && t.expiry <= ERA_END, (wk) => wk > cutWeek && wk <= eraWeek, BOOT_LIGHT),
    oosEra2: sub("last 40%, from Jan 2025", (t) => t.expiry > cut && t.expiry > ERA_END, (wk) => wk > cutWeek && wk > eraWeek, BOOT_LIGHT),
    pre2026: sub("before 1 Apr 2026", (t) => t.entry < STT_2026, (wk) => wk < sttWeek, BOOT_LIGHT),
    post2026: sub("from 1 Apr 2026", (t) => t.entry >= STT_2026, (wk) => wk >= sttWeek, BOOT_LIGHT),
    years,
    events,
    econ: econOf(r.trades, side),
    tail: tailOf(r.trades, side),
    sr: sharpe(full.rets),
  };
}

const EVENT_DATES: readonly { date: string; kind: string }[] = (() => {
  const out: { date: string; kind: string }[] = [];
  for (let t = Date.parse("2019-01-01T00:00:00Z"); t <= Date.parse("2026-12-31T00:00:00Z"); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const k = eventOn(d);
    if (k) out.push({ date: d, kind: k });
  }
  return out;
})();

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

/** A placebo gap of at least 2 SE, with a positive, finite SE. */
const gapOk = (gap: number, se: number) => se > 0 && gap >= 2 * se;
const core = (s: Stats) => s.oos.n > 0 && gapOk(s.oos.gap.gap, s.oos.gap.se) && s.oos.lo > 0 && s.oos.wLo > 0 && s.oos.pf >= 1.3;

function multipleTesting(rets: readonly number[], pTrade: number, pWeek: number, ledgerN: number, srVar: number | null, per = "a week"): { c: Criterion; p: number; dsr: number; dsrNull: number } {
  const p = Math.max(pTrade, pWeek);
  const vNull = rets.length > 1 ? 1 / (rets.length - 1) : null;
  // The larger of this study's V[SR] and the null variance 1/(T − 1): never looser than WP15's rule.
  const v = srVar !== null && vNull !== null ? Math.max(srVar, vNull) : (srVar ?? vNull);
  const dsr = deflatedSharpe(rets, ledgerN, v);
  const dsrNull = deflatedSharpe(rets, ledgerN, null);
  const alpha = 0.05 / ledgerN;
  return {
    c: { name: "Bonferroni and deflated Sharpe", verdict: p < alpha && dsr.dsr >= 0.95 ? "PASS" : "FAIL", detail: `p ${p.toExponential(1)} vs 0.05/${ledgerN} = ${alpha.toExponential(1)}; DSR ${fx(dsr.dsr, 3)} (SR ${fx(dsr.sr, 3)} ${per}, SR₀ ${fx(dsr.sr0, 3)}, V ${v === null ? "–" : v.toExponential(2)}); with V = 1/(T−1): ${fx(dsrNull.dsr, 3)}` },
    p,
    dsr: dsr.dsr,
    dsrNull: dsrNull.dsr,
  };
}

function judge(r: Run, s: Stats, perts: { label: string; oosNet: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS} trades out of sample`, verdict: o.n >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} trades in the last 40% (${o.weeks} eligible expiry weeks)` });
  c.push({ name: "placebo gap ≥ 2 SE (a fair coin between the bull put spread and the mirror bear call spread, paired by expiry week)", verdict: gapOk(o.gap.gap, o.gap.se) ? "PASS" : "FAIL", detail: `gap ${rs(o.gap.gap)} a trade, SE ${rs(o.gap.se)} (${fx(o.gap.t)} SE, ${o.gap.sessions} weeks)` });
  c.push({ name: "expiry-week-clustered 95% CI > 0 per trade and per eligible week", verdict: o.lo > 0 && o.wLo > 0 ? "PASS" : "FAIL", detail: `${rs(o.mean)} a trade (${rs(o.lo)} … ${rs(o.hi)}); per week ${rs(o.boot.perSession.estimate)} (${rs(o.wLo)} … ${rs(o.wHi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for picks that pass the placebo, the CI and the PF out of sample" });
  else {
    const rb = robustness(o.net, perts.map((p) => p.oosNet));
    const allPos = perts.length > 0 && perts.every((p) => p.oosNet > 0);
    c.push({ name: "±20% robustness: every perturbation's last-40% net > 0, and ≥ 80% positive with the worst ≥ base − 50%", verdict: allPos && rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; ${perts.map((p) => `${p.label} ${rs(p.oosNet)}`).join(", ")} vs base ${rs(o.net)}` });
  }
  const mt = multipleTesting(o.rets, o.boot.perTrade.p, o.boot.perSession.p, ledgerN, srVar);
  c.push(mt.c);
  if (r.cfg.family === "M") {
    const e1 = s.era1;
    c.push({ name: "complete-bar era (to Dec 2024): mean > 0, CI > 0", verdict: e1.n > 0 && e1.lo > 0 ? "PASS" : "FAIL", detail: `${e1.n} trades, ${rs(e1.mean)} (${rs(e1.lo)} … ${rs(e1.hi)}); sampled era ${s.era2.n} trades, ${rs(s.era2.mean)}` });
  }
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

/** ±20% perturbations of a pick (report §1.6): m × 0.8 / × 1.2, N ∓ 1, width × 0.8 / × 1.2, and (M) the entry and exit minutes. */
function perturbations(c: Cfg): { label: string; cfg: Cfg }[] {
  const out: { label: string; cfg: Cfg }[] = [];
  for (const f of [0.8, 1.2]) out.push({ label: `m ${fmtM(c.m * f)}`, cfg: { ...c, m: Number((c.m * f).toFixed(4)) } });
  for (const n of [c.n - 1, c.n + 1]) if (n >= (c.mgmt === "early" ? 2 : 1)) out.push({ label: `N ${n}`, cfg: { ...c, n } });
  for (const f of [0.8, 1.2]) out.push({ label: `width ${fmtM(c.width * f)} EM`, cfg: { ...c, width: Number((c.width * f).toFixed(4)) } });
  if (c.family === "M") {
    for (const d of [8, 12]) out.push({ label: `entry ${minToHhmm(CLOSE_MIN - d)}`, cfg: { ...c, entryMin: CLOSE_MIN - d } });
    if (c.mgmt === "early") for (const d of [8, 12]) out.push({ label: `exit ${minToHhmm(CLOSE_MIN - d)}`, cfg: { ...c, exitMin: CLOSE_MIN - d } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// H2: the turn of the month (report §1.7)
// ---------------------------------------------------------------------------

interface TomObs {
  month: string;
  start: string;
  end: string;
  /** Close of the window's last session ÷ close of its start − 1. */
  r: number;
}

interface DayObs {
  day: string;
  r: number;
  tom: boolean;
}

function tomObs(w: World, sym: Sym, before: number, after: number, smoke: boolean): { obs: TomObs[]; skips: Record<string, number>; days: DayObs[]; candidates: number } {
  const bars = w.yahoo[sym];
  const first = [...bars].filter(([, b]) => b).map(([d]) => d).sort()[0] ?? FIRST_DAY;
  const sessions = w.sessions.filter((d) => d >= first);
  const wins = tomWindows(sessions, before, after).filter((x) => x.end <= "2026-10-08");
  const skips: Record<string, number> = {};
  const obs: TomObs[] = [];
  const tomDays = new Set<string>();
  for (const x of wins) {
    for (const d of x.days) tomDays.add(d);
    const a = bars.get(x.start);
    const b = bars.get(x.end);
    if (!a || !b) {
      bump(skips, "no complete index bar at the window's start or end");
      continue;
    }
    obs.push({ month: x.month, start: x.start, end: x.end, r: smoke ? 0.02 * fake(`${sym}|${x.month}|tom${before}${after}`) + 0.2 * SMOKE_BIAS : b.c / a.c - 1 });
  }
  const days: DayObs[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const a = bars.get(sessions[i - 1]);
    const b = bars.get(sessions[i]);
    if (!a || !b) continue;
    days.push({ day: sessions[i], r: smoke ? 0.01 * fake(`${sym}|${sessions[i]}|day`) + (tomDays.has(sessions[i]) ? 0.05 * SMOKE_BIAS : 0) : b.c / a.c - 1, tom: tomDays.has(sessions[i]) });
  }
  return { obs, skips, days, candidates: wins.length };
}

interface TomSub {
  label: string;
  n: number;
  mean: number;
  lo: number;
  hi: number;
  p: number;
  pf: number;
  hit: number;
  gap: MeanGap;
  /** The gap per window (× the window's days). */
  gapWin: number;
  gapWinSe: number;
  rets: number[];
  sr: number;
}

function tomSub(label: string, obs: readonly TomObs[], days: readonly DayObs[], len: number, resamples: number): TomSub {
  const blocks = obs.map((o) => ({ day: o.month, pnls: [o.r] }));
  const b = dayBlockBootstrap(blocks, { resamples, seed: SEED });
  const g = meanGapBootstrap(days.map((d) => d.r), days.map((d) => d.tom), { block: TOM_BLOCK, resamples: Math.min(resamples, BOOT_SUB), seed: SEED });
  const xs = obs.map((o) => o.r);
  return { label, n: obs.length, mean: avg(xs), lo: b.perTrade.lo, hi: b.perTrade.hi, p: b.perTrade.p, pf: profitFactor(xs), hit: xs.length ? xs.filter((x) => x > 0).length / xs.length : NaN, gap: g, gapWin: g.gap * len, gapWinSe: g.se * len, rets: xs, sr: sharpe(xs) };
}

interface TomRun {
  name: string;
  sym: Sym;
  before: number;
  after: number;
  kind: "strategy" | "perturbation";
  base?: string;
  obs: TomObs[];
  days: DayObs[];
  skips: Record<string, number>;
  candidates: number;
  cut: string;
}

interface TomStats {
  full: TomSub;
  is: TomSub;
  oos: TomSub;
  years: { year: string; n: number; mean: number }[];
  halves: [TomSub, TomSub];
}

function tomStats(r: TomRun, light = false): TomStats {
  const len = r.before + r.after;
  const nb = (k: number) => (light ? BOOT_LIGHT : k);
  const full = tomSub("all", r.obs, r.days, len, nb(BOOT));
  let oos = tomSub("last 40%", r.obs.filter((o) => o.end > r.cut), r.days.filter((d) => d.day > r.cut), len, nb(BOOT));
  if (!light && oos.lo > 0) oos = tomSub("last 40%", r.obs.filter((o) => o.end > r.cut), r.days.filter((d) => d.day > r.cut), len, BOOT_FINAL);
  const mid = r.obs[Math.ceil(r.obs.length / 2) - 1]?.end ?? "";
  return {
    full,
    is: tomSub("first 60%", r.obs.filter((o) => o.end <= r.cut), r.days.filter((d) => d.day <= r.cut), len, nb(BOOT_SUB)),
    oos,
    years: [...new Set(r.obs.map((o) => o.month.slice(0, 4)))].sort().map((year) => {
      const xs = r.obs.filter((o) => o.month.startsWith(year)).map((o) => o.r);
      return { year, n: xs.length, mean: avg(xs) };
    }),
    halves: [tomSub("first half", r.obs.filter((o) => o.end <= mid), r.days.filter((d) => d.day <= mid), len, BOOT_LIGHT), tomSub("second half", r.obs.filter((o) => o.end > mid), r.days.filter((d) => d.day > mid), len, BOOT_LIGHT)],
  };
}

const tomName = (sym: Sym, before: number, after: number) => `${sym} turn of the month [−${before}, +${after}] long the index, close of the session before the window → close of its last session`;

function judgeTom(r: TomRun, s: TomStats, perts: { label: string; oosMean: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS} windows out of sample`, verdict: o.n >= MIN_OOS ? "PASS" : "INSUFFICIENT", detail: `${o.n} windows in the last 40%` });
  c.push({ name: "placebo gap ≥ 2 SE (window days against the other days, circular blocks of 21 sessions)", verdict: gapOk(o.gapWin, o.gapWinSe) ? "PASS" : "FAIL", detail: `${bp(o.gapWin)} a window (${bp(o.gap.gap, 2)} a day × ${r.before + r.after}), SE ${bp(o.gapWinSe)} (${fx(o.gapWin / o.gapWinSe)} SE); ${o.gap.nIn} window days, ${o.gap.nOut} other days` });
  c.push({ name: "95% CI > 0 per window (each window a block)", verdict: o.lo > 0 ? "PASS" : "FAIL", detail: `${bp(o.mean)} a window (${bp(o.lo)} … ${bp(o.hi)})` });
  c.push({ name: "PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only when the placebo, the CI and the PF pass out of sample" });
  else {
    const rb = robustness(o.mean, perts.map((p) => p.oosMean));
    const allPos = perts.every((p) => p.oosMean > 0);
    c.push({ name: "±20% robustness (windows [−1, +2] and [−2, +3]): every last-40% mean > 0, and the program's rule", verdict: allPos && rb.pass ? "PASS" : "FAIL", detail: perts.map((p) => `${p.label} ${bp(p.oosMean)}`).join(", ") });
  }
  const mt = multipleTesting(o.rets, o.p, o.p, ledgerN, srVar, "a window");
  c.push(mt.c);
  return { name: r.name, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p: mt.p, dsr: mt.dsr, dsrNull: mt.dsrNull };
}

interface FutWin {
  month: string;
  start: string;
  end: string;
  expiry: string;
  lot: number;
  r: number;
  rupees: number;
  stt: number;
  net: number;
}

/** The near-month future over each TOM window (the nearest futures expiry on or after the window's end, traded on its start and end). */
function tomFutures(w: World, sym: Sym, smoke: boolean): { wins: FutWin[]; skips: Record<string, number>; candidates: number } {
  const book = w.data.book;
  const skips: Record<string, number> = {};
  const out: FutWin[] = [];
  const first = [...w.book[sym]].sort()[0];
  const wins = tomWindows(w.sessions.filter((d) => d >= first), TOM_BEFORE, TOM_AFTER).filter((x) => x.end <= "2026-10-08");
  for (const x of wins) {
    if (!w.book[sym].has(x.start) || !w.book[sym].has(x.end)) {
      bump(skips, "no bhavcopy of the index's exchange at the window's start or end");
      continue;
    }
    const a = book.futures(sym, x.start).find((r) => r.expiry >= x.end && r.contracts > 0 && r.close !== null && r.close > 0);
    if (!a) {
      bump(skips, "no traded future expiring on or after the window's end at its start");
      continue;
    }
    const b = book.futures(sym, x.end).find((r) => r.expiry === a.expiry);
    if (!b || !(b.contracts > 0) || b.close === null || !(b.close > 0)) {
      bump(skips, "the future did not trade at the window's end");
      continue;
    }
    const lot = a.lot ?? NaN;
    if (smoke) {
      const rr = 0.02 * fake(`${sym}|${x.month}|fut`);
      out.push({ month: x.month, start: x.start, end: x.end, expiry: a.expiry, lot, r: rr, rupees: rr * 1e6, stt: 100, net: rr * 1e6 - 100 });
      continue;
    }
    const rupees = (b.close - a.close!) * lot;
    const stt = (b.close * lot * futuresSttPct(x.end)) / 100;
    out.push({ month: x.month, start: x.start, end: x.end, expiry: a.expiry, lot, r: b.close / a.close! - 1, rupees, stt, net: rupees - stt });
  }
  return { wins: out, skips, candidates: wins.length };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");
const DATA_D: Record<Sym, string> = {
  NIFTY: "NSE F&O bhavcopy compact cache 2019-02-11..2026-10-08 (closing prices, settlement prints, lots, expiries) + Yahoo ^NSEI / ^INDIAVIX daily",
  SENSEX: "BSE F&O bhavcopy compact cache 2023-05-15..2026-10-08 (closing prices, settlement prints, lots, expiries) + Yahoo ^BSESN / ^INDIAVIX daily",
};
const DATA_M: Record<Sym, string> = {
  NIFTY: "TradeMarkk 1-minute NIFTY options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract, 2021-05..2026-07; strikes, lots, expiries and settlement from the NSE bhavcopy cache",
  SENSEX: "TradeMarkk 1-minute SENSEX options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract, 2023-08..2026-07; strikes, lots, expiries and settlement from the BSE bhavcopy cache",
};

function optTrial(r: Run, side: SpreadSide, s: Stats): TrialRecord {
  const c = r.cfg;
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: side === "put" ? r.name : cfgName(c, "call", r.mode) + (r.label ? ` [${r.label}]` : ""),
    params: {
      family: side === "put" ? `H1 ${c.family} bull put spread` : `H1 ${c.family} bear call spread (mirror placebo)`,
      index: c.sym,
      structure: side === "put" ? "short put m EM below the index, long put width EM further below" : "short call m EM above the index, long call width EM further above",
      m: c.m,
      widthEm: c.width,
      sessionsBeforeExpiry: c.n,
      entry: c.family === "D" ? "the exchange's closing price" : `1-minute ${minToHhmm(c.entryMin)}`,
      exit: c.mgmt === "hold" ? "cash settlement at the final settlement level" : c.family === "D" ? "closing price of the session before expiry" : `1-minute ${minToHhmm(c.exitMin)} on the session before expiry`,
      emSource: "India VIX close of the previous session",
      fill: r.mode,
      ...(r.label ? { perturbation: r.label } : {}),
    },
    data: c.family === "D" ? DATA_D[c.sym] : DATA_M[c.sym],
    trades: s.full.n,
    net: Math.round(s.full.net * 100) / 100,
    notes: `${side === "put" ? "H1 bull put spread" : "mirror bear call spread (the placebo's other side)"} ${r.kind}; ${r.mode === "conservative" ? (c.family === "D" ? "conservative (each order pays the engine's full spread)" : "conservative (sell at the 1-min low, buy at the high)") : "mid"}; ₹/lot per trade ${fx(s.full.mean)} (expiry-week 95% CI ${fx(s.full.lo)}..${fx(s.full.hi)}), PF ${fx(s.full.pf)}, win ${pct(s.full.hit)}; first 60% ${fx(s.is.mean)} (${s.is.n}), last 40% ${fx(s.oos.mean)} (${s.oos.n}); mean credit ₹${fx(s.econ.credit, 0)}/lot; one lot at the lot in force; dated charges`,
    kind: side === "put" ? r.kind : "placebo",
    account: "main",
    sessions: s.full.weeks,
    meanPerTrade: Math.round(s.full.mean * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

function tomTrial(r: TomRun, s: TomStats): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: r.name,
    params: { family: "H2 turn of the month (index)", index: r.sym, window: [-r.before, r.after], entry: "close of the session before the window", exit: "close of the window's last session", unit: "index basis points, not rupees", ...(r.kind === "perturbation" ? { perturbation: `[−${r.before}, +${r.after}]` } : {}) },
    data: r.sym === "NIFTY" ? "Yahoo ^NSEI daily closes 2007-09..2026-10" : "Yahoo ^BSESN daily closes 2007-01..2026-10",
    trades: s.full.n,
    net: Math.round(sum(s.full.rets) * 1e4 * 100) / 100,
    notes: `TOM ${r.kind}; net and mean in index basis points (not ₹); per window ${bp(s.full.mean, 2)} (95% CI ${bp(s.full.lo, 2)}..${bp(s.full.hi, 2)}), PF ${fx(s.full.pf)}; window days against other days ${bp(s.full.gap.gap, 2)} a day; first 60% ${bp(s.is.mean, 2)} (${s.is.n}), last 40% ${bp(s.oos.mean, 2)} (${s.oos.n})`,
    kind: r.kind,
    account: "main",
    sessions: s.full.n,
    meanPerTrade: Math.round(s.full.mean * 1e4 * 100) / 100,
    srSession: Math.round(s.full.sr * 1e6) / 1e6,
  };
}

function futTrial(sym: Sym, f: FutWin[], cut: string): TrialRecord {
  const nets = f.map((z) => z.net);
  const oos = f.filter((z) => z.end > cut).map((z) => z.net);
  return {
    ts: new Date().toISOString(),
    wp: WP,
    variant: `${sym} turn of the month [−1, +3] near-month future, net of dated STT (descriptive)`,
    params: { family: "H2 turn of the month (future, descriptive)", index: sym, window: [-1, 3], instrument: "the nearest future expiring on or after the window's end", costs: "dated STT on the sale only", unit: "₹ per lot" },
    data: sym === "NIFTY" ? "NSE F&O bhavcopy compact cache (futures closing prices) 2019-02..2026-10" : "BSE F&O bhavcopy compact cache (futures closing prices) 2023-05..2026-10",
    trades: f.length,
    net: Math.round(sum(nets) * 100) / 100,
    notes: `descriptive; ₹/lot per window ${fx(avg(nets))} net of STT (gross ${fx(avg(f.map((z) => z.rupees)))}, STT ${fx(avg(f.map((z) => z.stt)))}); ${bp(avg(f.map((z) => z.r)), 2)} a window; last 40% (windows ending after ${cut}) ${fx(avg(oos))} (${oos.length})`,
    kind: "strategy",
    account: "main",
    meanPerTrade: Math.round(avg(nets) * 100) / 100,
  };
}

const loadData = (I: Inputs) => loadResearchData({ from: "2019-02-01", to: "2026-10-09", dir: I.dir });

/** The base configurations of a family and index (report §1.4): 3 m × 3 N × 2 managements. */
function baseCfgs(family: Family, sym: Sym): Cfg[] {
  const out: Cfg[] = [];
  for (const mgmt of MGMTS) for (const m of M_SET) for (const n of N_SET) out.push(baseCfg(family, sym, mgmt, m, n));
  return out;
}

// ---------------------------------------------------------------------------
// coverage: data, samples and cut dates (no option price, no P&L, no index return)
// ---------------------------------------------------------------------------

async function coverage(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const data = await loadData(I);
  const w = buildWorld(I, data);
  const out: string[] = ["# WP16 coverage (generated; sessions, expiries, strikes, trades and bar presence only: no option price, no P&L, no index return)\n"];
  const summary: Record<string, unknown> = {};

  // 1. Calendars.
  const nse = data.book.dates("NIFTY");
  const bse = [...w.book.SENSEX].sort();
  const regNoNse = w.sessions.filter((d) => d >= nse[0] && d <= "2026-10-08" && !w.book.NIFTY.has(d));
  const regNoBse = w.sessions.filter((d) => d >= BSE_DAILY_FROM && d <= "2026-10-08" && !w.book.SENSEX.has(d));
  const specials = [...w.special].filter((d) => d >= FIRST_DAY).sort();
  out.push(`## 1. Calendars\n\n- Calendar: ${w.cal.length} sessions (${w.cal[0]} … ${w.cal.at(-1)}) from complete Yahoo bars of either index (from ${FIRST_DAY}), the NSE bhavcopy (${nse[0]} … ${nse.at(-1)}, ${nse.length} files), the BSE bhavcopy (${bse[0]} … ${bse.at(-1)}, ${bse.length} daily files), ${w.oiDates.size} NSE participant-OI file dates and the Muhurat days.\n- Regular sessions: ${w.sessions.length}. Special sessions (weekend, Muhurat, or short by the bhavcopy's volume): ${specials.length}: ${specials.join(", ")}.\n- Regular sessions without an NSE bhavcopy (from ${nse[0]}): ${regNoNse.length} (${regNoNse.join(", ") || "–"}).\n- Regular sessions without a BSE bhavcopy (from ${BSE_DAILY_FROM}): ${regNoBse.length} (${regNoBse.join(", ") || "–"}).\n- India VIX (Yahoo): ${w.vixDays.length} closes, ${w.vixDays[0]} … ${w.vixDays.at(-1)}.\n`);

  // 2. Weekly expiries.
  const WD = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (const sym of SYMS) {
    const xs = weeklyExpiries(w, sym);
    const rows: (string | number)[][] = [["year", "weekly expiries", "by weekday", "sessions between consecutive expiries (min / median / max)"]];
    const years = [...new Set(xs.map((x) => x.slice(0, 4)))].sort();
    for (const y of years) {
      const ys = xs.filter((x) => x.startsWith(y));
      const wd: Record<string, number> = {};
      for (const x of ys) bump(wd, WD[weekdayOf(x)]);
      const gaps: number[] = [];
      for (const x of ys) {
        const i = xs.indexOf(x);
        if (i > 0) gaps.push(w.sessions.filter((d) => d > xs[i - 1] && d <= x).length);
      }
      rows.push([y, ys.length, Object.entries(wd).map(([k, v]) => `${k} ${v}`).join(", "), gaps.length ? `${Math.min(...gaps)} / ${median(gaps)} / ${Math.max(...gaps)}` : "–"]);
    }
    // Settlement levels: the exchange's printed level against the official close.
    let printed = 0;
    let fallback = 0;
    let both = 0;
    let maxDiff = 0;
    let over = 0;
    const overList: string[] = [];
    for (const x of xs) {
      const st = settlementLevel(w, sym, x);
      if (!st) continue;
      if (st.printed !== null) printed++;
      else fallback++;
      if (st.printed !== null && st.official !== null) {
        both++;
        const d = Math.abs(st.printed - st.official);
        maxDiff = Math.max(maxDiff, d);
        if (d > 0.5) {
          over++;
          overList.push(`${x} (${fx(st.printed)} vs ${fx(st.official)})`);
        }
      }
    }
    out.push(`\n## 2. ${sym} weekly expiries (the exchange's listed expiries; every holiday shift and change of weekday is the exchange's own)\n\n${xs.length} expiries, ${xs[0]} … ${xs.at(-1)}.\n\n${md(rows)}\n\n- Settlement level: the exchange's printed level on ${printed} expiries; the official close (no printed level) on ${fallback}. Where both exist (${both}), the largest difference is ${fx(maxDiff)} points; ${over} differ by more than 0.5 point${overList.length ? `: ${overList.slice(0, 12).join(", ")}${overList.length > 12 ? ", …" : ""}` : ""}.\n`);
    summary[`expiries_${sym}`] = xs.length;
  }

  // 3. Samples, cuts and per-cell availability.
  const mctxs = new Map<Sym, MCtx>();
  const samples: Record<string, Sample> = {};
  for (const sym of SYMS) {
    mctxs.set(sym, mCtx(w, sym, I.x));
    for (const family of FAMILIES) samples[`${family}|${sym}`] = sample(w, sym, family, family === "M" ? mctxs.get(sym)! : null, false);
  }
  const sRows: (string | number)[][] = [["family", "index", "candidate expiries", "skipped (by reason)", "eligible expiries", "first / last", "**cut after** (the last expiry of the first 60%)", "first 60% / last 40%", "last 40% to Dec 2024 / from 2025", "last 40% by year"]];
  for (const family of FAMILIES)
    for (const sym of SYMS) {
      const s = samples[`${family}|${sym}`];
      const oos = s.expiries.filter((e) => e.x > s.cut);
      const by: Record<string, number> = {};
      for (const e of oos) bump(by, e.x.slice(0, 4));
      sRows.push([family, sym, s.candidates, skipList(s.skips), s.expiries.length, `${s.expiries[0]?.x ?? "–"} / ${s.expiries.at(-1)?.x ?? "–"}`, s.cut, `${s.expiries.length - oos.length} / ${oos.length}`, `${oos.filter((e) => e.x <= ERA_END).length} / ${oos.filter((e) => e.x > ERA_END).length}`, Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")]);
    }
  const skippedList = Object.entries(samples).flatMap(([k, s]) => Object.entries(s.skipped).map(([why, ds]) => `${k}: ${why}: ${ds.join(", ")}`));
  out.push(`\n## 3. Samples and the walk-forward cuts\n\n${md(sRows)}\n\nSkipped expiries:\n\n${skippedList.map((z) => `- ${z}`).join("\n")}\n`);
  summary.cuts = Object.fromEntries(Object.entries(samples).map(([k, s]) => [k, s.cut]));
  summary.eligible = Object.fromEntries(Object.entries(samples).map(([k, s]) => [k, s.expiries.length]));

  // Per cell: entries with both spreads' legs traded (D) or with bars in a common entry minute (M); strike placement; lots; margin.
  const cRows: (string | number)[][] = [["family", "index", "m", "N", "eligible", "both spreads priced at entry (hold)", "share", "early: exit legs untraded on the exit day (trades)", "skips (hold)", "|short strike − target| ÷ EM: median (share > 1 strike step)", "put width ÷ EM: median", "lots seen", "margin at entry ₹: median / max (≤ ₹10,000)"]];
  const mRun: Record<string, boolean> = {};
  for (const family of FAMILIES)
    for (const sym of SYMS) {
      const s = samples[`${family}|${sym}`];
      const mc = mctxs.get(sym)!;
      interface Acc {
        skips: Record<string, number>;
        ok: number;
        untraded: number;
        earlyOk: number;
        dev: number[];
        big: boolean[];
        wid: number[];
        lots: Set<number>;
        margins: number[];
      }
      const cells = M_SET.flatMap((m) => N_SET.map((n) => ({ m, n, acc: { skips: {}, ok: 0, untraded: 0, earlyOk: 0, dev: [], big: [], wid: [], lots: new Set(), margins: [] } as Acc })));
      // Expiries are the outer loop so each 1-minute file is read once.
      for (const ex of s.expiries)
        for (const { m, n, acc } of cells) {
          const c = baseCfg(family, sym, "hold", m, n);
          const ce = baseCfg(family, sym, "early", m, n);
          const p = family === "D" ? planD(w, ex, c) : planM(w, mc, ex, c);
          if ("skip" in p) {
            bump(acc.skips, p.skip);
            continue;
          }
          if (family === "M" && !mEntryPresent(p as MPlan, c)) {
            bump(acc.skips, "no common entry minute for a spread's legs");
            continue;
          }
          acc.ok++;
          acc.dev.push(Math.abs(p.put.short - p.put.shortTarget) / p.em, Math.abs(p.call.short - p.call.shortTarget) / p.em);
          acc.big.push(Math.abs(p.put.short - p.put.shortTarget) > DEF[sym].step, Math.abs(p.call.short - p.call.shortTarget) > DEF[sym].step);
          acc.wid.push(spreadWidth(p.put) / p.em);
          acc.lots.add(p.lot);
          acc.margins.push(spreadMargin({ width: spreadWidth(p.put), lot: p.lot, level: p.level, onExpiryDay: false, date: p.e }).total);
          // Early exit: presence of the exit day's rows (D) or bars (M).
          const pe = family === "D" ? planD(w, ex, ce) : planM(w, mc, ex, ce);
          if ("skip" in pe) continue;
          if (family === "D") {
            const legs: [number, OptType][] = [
              [pe.put.short, "PE"],
              [pe.put.long, "PE"],
              [pe.call.short, "CE"],
              [pe.call.long, "CE"],
            ];
            const rows = legs.map(([k, t]) => data.book.option(sym, pe.exitDay, ex.x, k, t));
            if (rows.every((r) => r && r.close !== null && r.close >= 0)) {
              acc.earlyOk++;
              if (rows.some((r) => !(r!.contracts > 0))) acc.untraded++;
            }
          } else {
            const mp = pe as MPlan;
            const has = (k: number, t: OptType) => !!mp.chainX?.series.get(key(k, t))?.lastUpTo(EXIT_MIN + EXIT_WAIT);
            if (has(mp.put.short, "PE") && has(mp.put.long, "PE") && has(mp.call.short, "CE") && has(mp.call.long, "CE")) acc.earlyOk++;
          }
        }
      for (const { m, n, acc } of cells) {
        const share = s.expiries.length ? acc.ok / s.expiries.length : NaN;
        if (family === "M") mRun[`${sym}|${m}|${n}`] = share >= M_COVERAGE_MIN;
        cRows.push([family, sym, fmtM(m), n, s.expiries.length, acc.ok, pct(share), family === "D" ? `${acc.earlyOk} priced (${acc.untraded} with an untraded leg)` : `${acc.earlyOk} with a bar by ${minToHhmm(EXIT_MIN + EXIT_WAIT)}`, skipList(acc.skips), `${fx(median(acc.dev), 3)} (${pct(acc.big.filter(Boolean).length / Math.max(1, acc.big.length))})`, fx(median(acc.wid), 3), [...acc.lots].sort((a, b) => a - b).join(", "), acc.margins.length ? `${rs(median(acc.margins))} / ${rs(Math.max(...acc.margins))} (${pct(acc.margins.filter((x) => x <= SMALL_ACCOUNT).length / acc.margins.length)})` : "–"]);
      }
    }
  const runCells = Object.entries(mRun).filter(([, v]) => v).map(([k]) => k);
  const dropCells = Object.entries(mRun).filter(([, v]) => !v).map(([k]) => k);
  out.push(`\n## 4. Per configuration: entries with every leg priced, strike placement, lots and margin\n\n${md(cRows)}\n\nM cells that meet the ${pct(M_COVERAGE_MIN, 0)} rule (run): ${runCells.join(", ") || "none"}. Cells below it (not run, not logged): ${dropCells.join(", ") || "none"}.\n`);
  summary.mCells = mRun;

  // 5. The turn of the month (counts only).
  const tRows: (string | number)[][] = [["index", "first complete Yahoo bar", "candidate windows [−1, +3]", "skipped", "windows", "first / last month", "**cut after** (the last window end of the first 60%)", "first 60% / last 40%", "daily returns (window days / other days)", "near-month future windows (skipped)"]];
  const tomCuts: Record<string, string> = {};
  for (const sym of SYMS) {
    const t = tomObs(w, sym, TOM_BEFORE, TOM_AFTER, true);
    const cut = cutDate(t.obs.map((o) => o.end), IS_FRAC) ?? "9999-12-31";
    tomCuts[sym] = cut;
    const oos = t.obs.filter((o) => o.end > cut);
    const f = tomFutures(w, sym, true);
    const first = [...w.yahoo[sym]].filter(([, b]) => b).map(([d]) => d).sort()[0];
    tRows.push([sym, first, t.candidates, skipList(t.skips), t.obs.length, `${t.obs[0]?.month ?? "–"} / ${t.obs.at(-1)?.month ?? "–"}`, cut, `${t.obs.length - oos.length} / ${oos.length}`, `${t.days.filter((d) => d.tom).length} / ${t.days.filter((d) => !d.tom).length}`, `${f.wins.length} (${skipList(f.skips)})`]);
  }
  out.push(`\n## 5. The turn of the month (windows and counts only)\n\n${md(tRows)}\n`);
  summary.tomCuts = tomCuts;
  mkdirSync(I.outDir, { recursive: true });
  writeFileSync(resolve(I.outDir, "coverage.md"), out.join("\n"));
  writeFileSync(resolve(I.outDir, "coverage.json"), JSON.stringify(summary, null, 1));
  console.log(out.join("\n"));
  console.log(`Wrote ${resolve(I.outDir, "coverage.md")}`);
}

// ---------------------------------------------------------------------------
// run: every configuration, the walk-forward picks, the bar, TOM, the ledger and the tables
// ---------------------------------------------------------------------------

interface Pick {
  family: Family;
  sym: Sym;
  mgmt: Mgmt;
  mode: Mode;
  run: Run;
}

async function runAll(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const smoke = args.smoke === true;
  SMOKE = smoke;
  SMOKE_BIAS = smoke ? Number(str(args, "smoke-bias") ?? 0) : 0;
  if (!Number.isFinite(SMOKE_BIAS)) fail("--smoke-bias <number>");
  const t0 = Date.now();
  const log = (s: string) => console.log(`${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const data = await loadData(I);
  log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE bhavcopies`);
  const w = buildWorld(I, data);

  // ---- H1: samples and every base configuration ----
  const samples = new Map<string, Sample>();
  const mctxs = new Map<Sym, MCtx>();
  const runs: Run[] = [];
  const mDropped: string[] = [];
  for (const sym of SYMS) {
    const mc = mCtx(w, sym, I.x);
    mctxs.set(sym, mc);
    for (const family of FAMILIES) {
      const smp = sample(w, sym, family, family === "M" ? mc : null, smoke);
      samples.set(`${family}|${sym}`, smp);
      let cfgs = baseCfgs(family, sym);
      if (family === "M") {
        // The coverage rule (report §1.4): bar presence only.
        const cov = mCoverage(w, mc, smp);
        for (const m of M_SET) for (const n of N_SET) if (!cov.keep.has(`${m}|${n}`)) mDropped.push(`${sym} m ${fmtM(m)} N ${n} (${pct(cov.ok.get(`${m}|${n}`)! / Math.max(1, smp.expiries.length))})`);
        cfgs = cfgs.filter((c) => cov.keep.has(`${c.m}|${c.n}`));
      }
      const rs0 = buildRuns(w, smp, family === "M" ? mc : null, cfgs.map((cfg) => ({ cfg, kind: "strategy" as const })));
      runs.push(...rs0);
      log(`${family} ${sym}: ${smp.expiries.length} eligible expiries, cut ${smp.cut}; ${rs0.length} runs, trades ${rs0.map((r) => r.trades.length).join("/")}`);
    }
  }
  const cutOf = (r: Run) => samples.get(`${r.cfg.family}|${r.cfg.sym}`)!.cut;
  const stats = new Map(runs.map((r) => [r.name, { put: statsOf(r, "put", cutOf(r)), call: statsOf(r, "call", cutOf(r)) }]));
  log(`H1: ${runs.length} runs (${mDropped.length} M cells below the coverage rule: ${mDropped.join("; ") || "none"})`);

  // Picks: per family, index, management and fill, the (m, N) with the best first-60% mean of the bull put spread.
  const picks: Pick[] = [];
  for (const family of FAMILIES)
    for (const sym of SYMS)
      for (const mgmt of MGMTS)
        for (const mode of MODES) {
          const p = pickBest(runs.filter((r) => r.cfg.family === family && r.cfg.sym === sym && r.cfg.mgmt === mgmt && r.mode === mode), (r) => stats.get(r.name)!.put.is.mean, (r) => r.name);
          if (p) picks.push({ family, sym, mgmt, mode, run: p });
        }
  // ±20% perturbations, only for picks that pass the placebo, the CI and the PF out of sample.
  const pertRuns: Run[] = [];
  for (const pk of picks) {
    if (!core(stats.get(pk.run.name)!.put)) continue;
    const smp = samples.get(`${pk.family}|${pk.sym}`)!;
    const list = perturbations(pk.run.cfg).map((z) => ({ cfg: z.cfg, kind: "perturbation" as const, base: pk.run.name, label: z.label }));
    const built = buildRuns(w, smp, pk.family === "M" ? mctxs.get(pk.sym)! : null, list).filter((r) => r.mode === pk.mode);
    pertRuns.push(...built);
  }
  const pertStats = new Map(pertRuns.map((r) => [r.name, { put: statsOf(r, "put", cutOf(r), true), call: statsOf(r, "call", cutOf(r), true) }]));
  log(`Picks ${picks.length}; perturbation runs ${pertRuns.length}`);

  // ---- H2: the turn of the month ----
  const tomRuns: TomRun[] = [];
  for (const sym of SYMS) {
    const t = tomObs(w, sym, TOM_BEFORE, TOM_AFTER, smoke);
    const cut = cutDate(t.obs.map((o) => o.end), IS_FRAC) ?? "9999-12-31";
    tomRuns.push({ name: tomName(sym, TOM_BEFORE, TOM_AFTER), sym, before: TOM_BEFORE, after: TOM_AFTER, kind: "strategy", obs: t.obs, days: t.days, skips: t.skips, candidates: t.candidates, cut });
  }
  const tStats = new Map(tomRuns.map((r) => [r.name, tomStats(r)]));
  const tomPerts: TomRun[] = [];
  for (const r of tomRuns) {
    const s = tStats.get(r.name)!;
    const ok = gapOk(s.oos.gapWin, s.oos.gapWinSe) && s.oos.lo > 0 && s.oos.pf >= 1.3;
    if (!ok) continue;
    for (const [b, a] of TOM_PERTS) {
      const t = tomObs(w, r.sym, b, a, smoke);
      tomPerts.push({ name: tomName(r.sym, b, a), sym: r.sym, before: b, after: a, kind: "perturbation", base: r.name, obs: t.obs, days: t.days, skips: t.skips, candidates: t.candidates, cut: r.cut });
    }
  }
  const tPertStats = new Map(tomPerts.map((r) => [r.name, tomStats(r, true)]));
  const futBy = new Map<Sym, FutWin[]>(SYMS.map((sym) => [sym, tomFutures(w, sym, smoke).wins]));
  log(`TOM: ${tomRuns.length} variants, ${tomPerts.length} perturbations; futures windows ${SYMS.map((s) => futBy.get(s)!.length).join("/")}`);

  if (smoke) {
    const finite = (xs: number[]) => xs.every(Number.isFinite);
    for (const r of runs.filter((z) => z.mode === "mid")) console.log(`smoke ${r.name}: trades ${r.trades.length}, skips ${JSON.stringify(r.skips)}, finite ${finite(r.trades.map((t) => t.put.net + t.call.net))}`);
    for (const r of tomRuns) console.log(`smoke ${r.name}: windows ${r.obs.length}, days ${r.days.length}, skips ${JSON.stringify(r.skips)}, finite ${finite(r.obs.map((o) => o.r))}`);
    console.log(`smoke picks ${picks.length}; perturbation runs ${pertRuns.length}; TOM perturbations ${tomPerts.length}; futures ${SYMS.map((s) => futBy.get(s)!.length).join("/")}`);
  }

  // ---- Ledger ----
  const putLines = [...runs.map((r) => optTrial(r, "put", stats.get(r.name)!.put)), ...pertRuns.map((r) => optTrial(r, "put", pertStats.get(r.name)!.put))];
  const callLines = [...runs.map((r) => optTrial(r, "call", stats.get(r.name)!.call)), ...pertRuns.map((r) => optTrial(r, "call", pertStats.get(r.name)!.call))];
  const tomLines = [...tomRuns.map((r) => tomTrial(r, tStats.get(r.name)!)), ...tomPerts.map((r) => tomTrial(r, tPertStats.get(r.name)!))];
  const futLines = SYMS.map((sym) => futTrial(sym, futBy.get(sym)!, tomRuns.find((r) => r.sym === sym)!.cut));
  const allLines = [...putLines, ...callLines, ...tomLines, ...futLines];
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === WP).map((r) => r.variant));
  const names = new Set<string>();
  for (const l of allLines) {
    if (names.has(l.variant)) throw new Error(`duplicate variant name ${l.variant}`);
    names.add(l.variant);
  }
  const fresh = allLines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && !smoke && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVarH1 = sharpeVariance(putLines).variance;
  const srVarTom = sharpeVariance(tomLines).variance;
  log(`Ledger: ${ledgerBefore} lines before, ${fresh.length} new (${args.ledger === true && !smoke ? "appended" : smoke ? "NOT appended: --smoke" : "NOT appended: no --ledger"}), N = ${ledgerN}; V[SR] H1 ${srVarH1?.toExponential(2)}, TOM ${srVarTom?.toExponential(2)}`);

  // ---- The bar ----
  const judged = picks.map((pk) => {
    const s = stats.get(pk.run.name)!.put;
    const perts = core(s) ? pertRuns.filter((z) => z.base === pk.run.name).map((z) => ({ label: z.label!, oosNet: pertStats.get(z.name)!.put.oos.net })) : null;
    return { pk, s, c: stats.get(pk.run.name)!.call, j: judge(pk.run, s, perts, ledgerN, srVarH1) };
  });
  const tomJudged = tomRuns.map((r) => {
    const s = tStats.get(r.name)!;
    const ok = gapOk(s.oos.gapWin, s.oos.gapWinSe) && s.oos.lo > 0 && s.oos.pf >= 1.3;
    const perts = ok ? tomPerts.filter((z) => z.base === r.name).map((z) => ({ label: `[−${z.before}, +${z.after}]`, oosMean: tPertStats.get(z.name)!.oos.mean })) : null;
    return { r, s, j: judgeTom(r, s, perts, ledgerN, srVarTom) };
  });

  // ---- Tables ----
  const S: string[] = [`# WP16 tables (generated)${smoke ? "\n\n**SMOKE RUN: every price-derived value below is synthetic. Nothing here describes the data.**" : ""}\n\nLedger: ${ledgerBefore} → ${ledgerN} lines (${fresh.length} new); Bonferroni 0.05/${ledgerN} = ${(0.05 / ledgerN).toExponential(2)}; V[SR] of this study's bull-put-spread lines ${srVarH1?.toExponential(2)}, of its TOM lines ${srVarTom?.toExponential(2) ?? "–"}.\n\nCuts (the last expiry of the first 60% of eligible expiries): ${[...samples].map(([k, s]) => `${k} ${s.cut}`).join(", ")}. TOM cuts: ${tomRuns.map((r) => `${r.sym} ${r.cut}`).join(", ")}. M cells below the coverage rule (not run): ${mDropped.join("; ") || "none"}.\n`];
  const fam = (f: Family) => (f === "D" ? "D daily closes" : "M 1-minute 15:20");
  const vt: (string | number)[][] = [["index", "family", "management", "fill", "pick (first 60%)", "first 60% ₹/trade (n)", "last 40% trades", "last 40% ₹/trade (95% CI)", "PF", "placebo gap (SE)", "per week (CI)", "mirror call spread last 40% ₹/trade", "worst trade (all)", "verdict: fails on"]];
  for (const { pk, s, c, j } of judged) {
    const fails = j.criteria.filter((z) => z.verdict === "FAIL" || z.verdict === "INSUFFICIENT" || z.verdict === "NOT RUN").map((z) => (z.name.startsWith("≥") ? "sample" : z.name.startsWith("placebo") ? "placebo" : z.name.startsWith("expiry-week") ? "CI" : z.name.startsWith("PF") ? "PF" : z.name.startsWith("±20%") ? (z.verdict === "NOT RUN" ? "robustness (not run)" : "robustness") : z.name.startsWith("Bonferroni") ? "multiple testing" : "complete-bar era"));
    vt.push([pk.sym, fam(pk.family), pk.mgmt === "hold" ? "hold to settlement" : "early exit", pk.mode, `m ${fmtM(pk.run.cfg.m)}, N ${pk.run.cfg.n}`, `${rs(s.is.mean)} (${s.is.n})`, s.oos.n, `${rs(s.oos.mean)} (${rs(s.oos.lo)} … ${rs(s.oos.hi)})`, fx(s.oos.pf), `${rs(s.oos.gap.gap)} (${fx(s.oos.gap.t)})`, `${rs(s.oos.boot.perSession.estimate)} (${rs(s.oos.wLo)} … ${rs(s.oos.wHi)})`, `${rs(c.oos.mean)} (${rs(c.oos.lo)} … ${rs(c.oos.hi)})`, `${rs(s.tail.worst[0]?.net ?? NaN)} (${s.tail.worst[0]?.expiry ?? "–"})`, `${j.verdict}${fails.length ? `: ${fails.join(", ")}` : ""}`]);
  }
  S.push(`\n## Verdicts: H1 picks (the bull put spread; verdict at the conservative fill)\n\n${md(vt)}\n`);
  const tv: (string | number)[][] = [["index", "windows", "first 60% per window (n)", "last 40% windows", "last 40% per window (95% CI)", "hit", "window days vs other days, last 40% (SE)", "PF", "verdict: fails on"]];
  for (const { r, s, j } of tomJudged) {
    const fails = j.criteria.filter((z) => z.verdict !== "PASS" && z.verdict !== "N/A").map((z) => `${z.name.split(" (")[0]}${z.verdict === "NOT RUN" ? " (not run)" : ""}`);
    tv.push([r.sym, s.full.n, `${bp(s.is.mean)} (${s.is.n})`, s.oos.n, `${bp(s.oos.mean)} (${bp(s.oos.lo)} … ${bp(s.oos.hi)})`, pct(s.oos.hit), `${bp(s.oos.gapWin)} (${fx(s.oos.gapWin / s.oos.gapWinSe)})`, fx(s.oos.pf), `${j.verdict}${fails.length ? `: ${fails.join("; ")}` : ""}`]);
  }
  S.push(`\n## Verdicts: H2 turn of the month (index, close to close)\n\n${md(tv)}\n`);
  // Criterion detail per pick.
  for (const { pk, s, c, j } of judged) {
    const e = s.econ;
    S.push(`\n### ${pk.run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "trades", "₹/trade", "95% CI", "per week CI", "PF", "win", "net ₹", "placebo gap (SE)"], ...[s.full, s.is, s.oos, s.half1, s.half2, s.era1, s.era2, s.oosEra1, s.oosEra2, s.pre2026, s.post2026].map((z) => [z.label, z.n, rs(z.mean), `${rs(z.lo)} … ${rs(z.hi)}`, `${rs(z.wLo)} … ${rs(z.wHi)}`, fx(z.pf), pct(z.hit), rs(z.net), `${rs(z.gap.gap)} (${fx(z.gap.t)})`])])}\n\nEconomics (all trades): credit ${rs(e.credit)}/lot (credit ÷ width ${pct(e.creditPerWidth)}; payout ÷ width ${pct(e.payoutPerWidth)}), win rate ${pct(e.winRate)}, average win ${rs(e.avgWin)}, average loss ${rs(e.avgLoss)}, short strike breached ${pct(e.breach)}, full width lost ${e.fullLossN} times (${pct(e.fullLoss)}), max loss ${rs(e.maxLoss)} (largest ${rs(e.maxLossMax)}), margin at entry ${rs(e.marginEntry)} (peak ${rs(e.marginPeakMax)}, smallest ${rs(e.marginMin)}; ≤ ₹10,000 on ${pct(e.smallFits)}), charges ${rs(e.charges)}, spread ${rs(e.spreadCost)}; legs: short ${rs(e.shortGross)}, long ${rs(e.longGross)} gross a trade; worst interim mark ${e.worstMark === null ? "–" : `${rs(e.worstMark)} (expiry ${e.worstMarkDay})`}${pk.family === "D" && pk.mgmt === "early" ? `; exits with an untraded leg ${pct(e.untradedExit)}` : ""}${pk.family === "M" && pk.mgmt === "early" ? `; stale exits ${pct(e.stale)}` : ""}.\n\nBy year (trades, net ₹, % of ₹5 lakh at one lot): ${s.years.map((y) => `${y.year} ${y.n} ${rs(y.net)} (${pp(y.pctCapital, 1)})`).join(" · ")}\n\nThe mirror call spread: ${rs(c.full.mean)}/trade (${rs(c.full.lo)} … ${rs(c.full.hi)}), PF ${fx(c.full.pf)}, win ${pct(c.full.hit)}; last 40% ${rs(c.oos.mean)} (${c.oos.n}); credit ${rs(c.econ.credit)}/lot.\n`);
    const perts = pertRuns.filter((z) => z.base === pk.run.name);
    if (perts.length) S.push(`Perturbations (last 40% net ₹ / trades): ${perts.map((z) => `${z.label}: ${rs(pertStats.get(z.name)!.put.oos.net)} / ${pertStats.get(z.name)!.put.oos.n}`).join(" · ")}\n`);
  }
  // Every configuration: both sides, both fills.
  for (const family of FAMILIES)
    for (const sym of SYMS) {
      const rows: (string | number)[][] = [["management", "m", "N", "fill", "trades", "put spread ₹/trade (95% CI)", "PF", "win", "first 60% / last 40%", "credit ₹/lot (÷ width)", "payout ÷ width", "breach / full width", "call spread ₹/trade (95% CI)", "call PF", "gap (SE)", "skips"]];
      for (const r of runs.filter((z) => z.cfg.family === family && z.cfg.sym === sym)) {
        const s = stats.get(r.name)!;
        rows.push([r.cfg.mgmt, fmtM(r.cfg.m), r.cfg.n, r.mode, s.put.full.n, `${rs(s.put.full.mean)} (${rs(s.put.full.lo)} … ${rs(s.put.full.hi)})`, fx(s.put.full.pf), pct(s.put.full.hit, 0), `${rs(s.put.is.mean)} / ${rs(s.put.oos.mean)}`, `${rs(s.put.econ.credit)} (${pct(s.put.econ.creditPerWidth, 0)})`, pct(s.put.econ.payoutPerWidth, 1), `${pct(s.put.econ.breach, 0)} / ${pct(s.put.econ.fullLoss, 1)}`, `${rs(s.call.full.mean)} (${rs(s.call.full.lo)} … ${rs(s.call.full.hi)})`, fx(s.call.full.pf), `${rs(s.put.full.gap.gap)} (${fx(s.put.full.gap.t)})`, skipList(r.skips)]);
      }
      S.push(`\n## Every configuration: ${fam(family)}, ${sym}\n\n${md(rows)}\n`);
    }
  // Years for every hold configuration at the conservative fill (the ₹5 lakh account at one lot).
  for (const family of FAMILIES)
    for (const sym of SYMS) {
      const rs1 = runs.filter((z) => z.cfg.family === family && z.cfg.sym === sym);
      const years = [...new Set(rs1.flatMap((r) => r.trades.map((t) => t.expiry.slice(0, 4))))].sort();
      const rows: (string | number)[][] = [["management", "m", "N", "fill", ...years]];
      for (const r of rs1) {
        const s = stats.get(r.name)!.put;
        rows.push([r.cfg.mgmt, fmtM(r.cfg.m), r.cfg.n, r.mode, ...years.map((y) => {
          const z = s.years.find((q) => q.year === y);
          return z ? `${rs(z.net)} (${pp(z.pctCapital, 1)})` : "–";
        })]);
      }
      S.push(`\n## By year, net ₹ at one lot a week (% of ₹5 lakh): ${fam(family)}, ${sym}\n\n${md(rows)}\n`);
    }
  // Tails of the picks and of every hold configuration at the conservative fill.
  const tailRows: (string | number)[][] = [["variant", "trades", "net ₹", "5% VaR / ES", "1% VaR / ES", "max drawdown ₹ (% of ₹5 lakh)", "peak → trough", "longest losing run", "worst 5% summed (× net)", "full width lost", "worst interim mark", "margin at entry (peak)", "₹10,000 enough"]];
  const tailOfRun = (r: Run) => {
    const s = stats.get(r.name)!.put;
    const t = s.tail;
    const e = s.econ;
    return [r.name, s.full.n, rs(s.full.net), `${rs(t.var5)} / ${rs(t.es5)}`, `${rs(t.var1)} / ${rs(t.es1)}`, `${rs(t.maxDD)} (${pct(t.maxDD / CAPITAL)})`, `${t.ddFrom} → ${t.ddTo}`, t.longestLosing, fx(t.tailMultiple), `${e.fullLossN} (${pct(e.fullLoss)})`, e.worstMark === null ? "–" : `${rs(e.worstMark)} (${e.worstMarkDay})`, `${rs(e.marginEntry)} (${rs(e.marginPeakMax)})`, pct(e.smallFits)];
  };
  for (const { pk } of judged) tailRows.push(tailOfRun(pk.run));
  S.push(`\n## Tails of the picks (one lot; trades in expiry order)\n\n${md(tailRows)}\n\nThe ten worst trades of each pick (expiry, entry, net ₹, index move, strikes, lot, credit ₹): ${judged.map(({ pk, s }) => `**${pk.run.name}**: ${s.tail.worst.map((z) => `${z.expiry} (in ${z.entry}) ${rs(z.net)} ${pp(z.move)} ${z.ks}/${z.kl} lot ${z.lot} credit ${rs(z.credit)}`).join("; ")}`).join("\n\n")}\n`);
  // Named stress dates.
  const named: (string | number)[][] = [["date", "variant", "expiry", "entry", "index entry → exit", "strikes", "lot", "credit ₹", "net ₹", "mirror call spread net ₹"]];
  const namedRuns = [...judged.map((z) => z.pk.run), ...runs.filter((r) => r.cfg.family === "D" && r.cfg.mgmt === "hold" && r.cfg.m === 1 && r.mode === "conservative")];
  const seen = new Set<string>();
  for (const nd of NAMED_DATES)
    for (const r of namedRuns) {
      if (seen.has(`${nd.date}|${r.name}`)) continue;
      seen.add(`${nd.date}|${r.name}`);
      for (const t of r.trades.filter((z) => z.entry < nd.date && z.exit >= nd.date)) named.push([nd.label, r.name, t.expiry, t.entry, pp(t.move), `${t.put.ks}/${t.put.kl}`, t.lot, rs(t.put.credit), rs(t.put.net), rs(t.call.net)]);
    }
  S.push(`\n## Named stress dates (every trade whose holding period contains the date)\n\n${md(named)}\n`);
  // Scheduled events in the holding period.
  const evRows: (string | number)[][] = [["variant", ...["budget in the holding period", "rbi in the holding period", "election in the holding period", "no scheduled event"].map((k) => `${k}: n, ₹/trade`)]];
  for (const { pk, s } of judged) evRows.push([pk.run.name, ...s.events.map((z) => `${z.n}, ${rs(z.mean)}`)]);
  S.push(`\n## Scheduled events in the holding period (descriptive)\n\n${md(evRows)}\n`);
  // TOM detail.
  for (const { r, s, j } of tomJudged) {
    S.push(`\n### ${r.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((z) => [z.name, z.verdict, z.detail])])}\n\n${md([["sample", "windows", "per window", "95% CI", "hit", "PF", "window days − other days, per window (SE)"], ...[s.full, s.is, s.oos, ...s.halves].map((z) => [z.label, z.n, bp(z.mean), `${bp(z.lo)} … ${bp(z.hi)}`, pct(z.hit), fx(z.pf), `${bp(z.gapWin)} (${bp(z.gapWinSe)})`])])}\n\nBy year (windows, mean): ${s.years.map((y) => `${y.year} ${y.n} ${bp(y.mean)}`).join(" · ")}. Skips: ${skipList(r.skips)}.\n`);
    const perts = tomPerts.filter((z) => z.base === r.name);
    if (perts.length) S.push(`Perturbations (last 40% mean per window): ${perts.map((z) => `[−${z.before}, +${z.after}] ${bp(tPertStats.get(z.name)!.oos.mean)} (${tPertStats.get(z.name)!.oos.n})`).join(" · ")}\n`);
  }
  const fr: (string | number)[][] = [["index", "windows", "per window (bp)", "₹ per lot gross", "dated STT ₹", "₹ per lot net (95% CI)", "profitable", "last 40% net ₹ (n)", "by year (net ₹)"]];
  for (const sym of SYMS) {
    const f = futBy.get(sym)!;
    const cut = tomRuns.find((r) => r.sym === sym)!.cut;
    const b = dayBlockBootstrap(f.map((z) => ({ day: z.month, pnls: [z.net] })), { resamples: BOOT_SUB, seed: SEED });
    const oos = f.filter((z) => z.end > cut);
    const years = [...new Set(f.map((z) => z.month.slice(0, 4)))].sort();
    fr.push([sym, f.length, bp(avg(f.map((z) => z.r))), rs(avg(f.map((z) => z.rupees))), rs(avg(f.map((z) => z.stt))), `${rs(avg(f.map((z) => z.net)))} (${rs(b.perTrade.lo)} … ${rs(b.perTrade.hi)})`, pct(f.filter((z) => z.net > 0).length / Math.max(1, f.length)), `${rs(avg(oos.map((z) => z.net)))} (${oos.length})`, years.map((y) => `${y} ${rs(sum(f.filter((z) => z.month.startsWith(y)).map((z) => z.net)))}`).join(" · ")]);
  }
  S.push(`\n## H2: the near-month future over the TOM window, net of dated STT (descriptive)\n\n${md(fr)}\n`);
  mkdirSync(I.outDir, { recursive: true });
  writeFileSync(resolve(I.outDir, "tables.md"), S.join("\n"));
  const subJ = (u: Sub) => ({ n: u.n, weeks: u.weeks, mean: u.mean, lo: u.lo, hi: u.hi, wLo: u.wLo, pf: u.pf, hit: u.hit, net: u.net, gap: u.gap.gap, gapSe: u.gap.se, p: Math.max(u.boot.perTrade.p, u.boot.perSession.p) });
  const statJ = (s: Stats) => ({ full: subJ(s.full), is: subJ(s.is), oos: subJ(s.oos), half1: subJ(s.half1), half2: subJ(s.half2), era1: subJ(s.era1), era2: subJ(s.era2), pre2026: subJ(s.pre2026), post2026: subJ(s.post2026), years: s.years, events: s.events, econ: s.econ, tail: s.tail, sr: s.sr });
  writeFileSync(
    resolve(I.outDir, "summary.json"),
    JSON.stringify(
      {
        ledgerBefore,
        ledgerN,
        srVarH1,
        srVarTom,
        cuts: Object.fromEntries([...samples].map(([k, s]) => [k, s.cut])),
        eligible: Object.fromEntries([...samples].map(([k, s]) => [k, s.expiries.length])),
        mDropped,
        runs: runs.map((r) => ({ name: r.name, family: r.cfg.family, sym: r.cfg.sym, mgmt: r.cfg.mgmt, m: r.cfg.m, n: r.cfg.n, width: r.cfg.width, mode: r.mode, skips: r.skips, put: statJ(stats.get(r.name)!.put), call: statJ(stats.get(r.name)!.call) })),
        picks: judged.map((z) => ({ name: z.pk.run.name, family: z.pk.family, sym: z.pk.sym, mgmt: z.pk.mgmt, mode: z.pk.mode, m: z.pk.run.cfg.m, n: z.pk.run.cfg.n, verdict: z.j.verdict, criteria: z.j.criteria, p: z.j.p, dsr: z.j.dsr, dsrNull: z.j.dsrNull })),
        perturbations: pertRuns.map((r) => ({ name: r.name, base: r.base, oosNet: pertStats.get(r.name)!.put.oos.net, oosN: pertStats.get(r.name)!.put.oos.n })),
        tom: tomJudged.map((z) => ({ name: z.r.name, sym: z.r.sym, cut: z.r.cut, skips: z.r.skips, full: { n: z.s.full.n, mean: z.s.full.mean, lo: z.s.full.lo, hi: z.s.full.hi, pf: z.s.full.pf, hit: z.s.full.hit, gap: z.s.full.gap.gap, gapSe: z.s.full.gap.se, nIn: z.s.full.gap.nIn, nOut: z.s.full.gap.nOut }, oos: { n: z.s.oos.n, mean: z.s.oos.mean, lo: z.s.oos.lo, hi: z.s.oos.hi, pf: z.s.oos.pf, hit: z.s.oos.hit, gap: z.s.oos.gap.gap, gapSe: z.s.oos.gap.se, nIn: z.s.oos.gap.nIn, nOut: z.s.oos.gap.nOut }, years: z.s.years, verdict: z.j.verdict, criteria: z.j.criteria })),
        tomPerturbations: tomPerts.map((r) => ({ name: r.name, oosMean: tPertStats.get(r.name)!.oos.mean, oosN: tPertStats.get(r.name)!.oos.n })),
        futures: Object.fromEntries(SYMS.map((sym) => [sym, { n: futBy.get(sym)!.length, meanNet: avg(futBy.get(sym)!.map((z) => z.net)), meanGross: avg(futBy.get(sym)!.map((z) => z.rupees)), meanStt: avg(futBy.get(sym)!.map((z) => z.stt)), meanR: avg(futBy.get(sym)!.map((z) => z.r)) }])),
      },
      null,
      1,
    ),
  );
  if (smoke) console.log(`smoke: wrote synthetic tables to ${resolve(I.outDir, "tables.md")}; verdict counts ${JSON.stringify(judged.reduce<Record<string, number>>((a, z) => ((a[z.j.verdict] = (a[z.j.verdict] ?? 0) + 1), a), {}))}`);
  else log(`Wrote ${resolve(I.outDir, "tables.md")}; verdicts: ${judged.map((z) => `${z.pk.sym} ${z.pk.family} ${z.pk.mgmt} ${z.pk.mode} ${z.j.verdict}`).join("; ")}; TOM: ${tomJudged.map((z) => `${z.r.sym} ${z.j.verdict}`).join("; ")}`);
}

// ---------------------------------------------------------------------------
// debug: one expiry by hand
// ---------------------------------------------------------------------------

async function debug(args: ReturnType<typeof parseArgs>): Promise<void> {
  const I = inputs(args);
  const sym = (str(args, "index") ?? "NIFTY") as Sym;
  if (!SYMS.includes(sym)) fail("--index NIFTY | SENSEX");
  const x = str(args, "expiry") ?? fail("--expiry YYYY-MM-DD is required");
  const data = await loadData(I);
  const w = buildWorld(I, data);
  const mc = mCtx(w, sym, I.x);
  for (const family of FAMILIES) {
    const smp = sample(w, sym, family, family === "M" ? mc : null, false);
    const ex = smp.expiries.find((e) => e.x === x);
    if (!ex) {
      console.log(`${family}: ${x} is not an eligible expiry (skips ${JSON.stringify(smp.skips)})`);
      continue;
    }
    const st = settlementLevel(w, sym, x)!;
    console.log(`${family} ${sym} expiry ${x} (week ${ex.week}); settlement ${ex.settle} (printed ${st.printed}, official close ${st.official}); sessions before ${ex.before.join(", ")}`);
    for (const c of baseCfgs(family, sym))
      for (const mode of MODES) {
        const p = family === "D" ? planD(w, ex, c) : planM(w, mc, ex, c);
        if ("skip" in p) {
          console.log(`  ${cfgName(c, "put", mode)}: skip (${p.skip})`);
          continue;
        }
        const res = family === "D" ? priceD(w, ex, c, mode) : priceM(w, mc, ex, c, mode);
        const show = (side: SpreadSide) => {
          if ("skip" in res) return res.skip;
          const s = res[side];
          return `${s.ks}/${s.kl} credit ${fx(s.credit)} value ${fx(s.value)} gross ${fx(s.gross)} spread ${fx(s.spread)} charges ${fx(s.charges)} net ${fx(s.net)}`;
        };
        console.log(`  ${c.mgmt} m ${fmtM(c.m)} N ${c.n} ${mode}: entry ${p.e} level ${fx(p.level)} VIX ${fx(p.vix)} EM ${fx(p.em)} lot ${p.lot}; put ${show("put")} | call ${show("call")}`);
        if (family === "D" && mode === "mid" && c.mgmt === "hold") {
          for (const side of ["put", "call"] as const)
            for (const k of [p[side].short, p[side].long]) {
              const r = data.book.option(sym, p.e, x, k, optType(side));
              console.log(`    bhav ${p.e} ${k}${optType(side)}: open ${r?.open} high ${r?.high} low ${r?.low} close ${r?.close} contracts ${r?.contracts} lot ${r?.lot}`);
            }
        }
        if (family === "M" && mode === "mid" && c.mgmt === "hold") {
          const mp = p as MPlan;
          for (const side of ["put", "call"] as const)
            for (const k of [p[side].short, p[side].long]) {
              const s = mp.chainE.series.get(key(k, optType(side)));
              for (const m of [c.entryMin - 1, c.entryMin, c.entryMin + 1, c.entryMin + 2]) {
                const b = s?.at(m);
                console.log(`    1-min ${p.e} ${k}${optType(side)} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
              }
            }
        }
      }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2];
  if (cmd === "coverage") return coverage(args);
  if (cmd === "run") return runAll(args);
  if (cmd === "debug") return debug(args);
  fail(`unknown command ${cmd ?? ""}: coverage | run | debug`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
