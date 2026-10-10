/**
 * WP13: three option-selling hypotheses on real 1-minute NIFTY/SENSEX option prices
 * (reports/wp13-expiry-calendar-events.md; every definition is frozen in its §1, committed before any
 * P&L was computed). Research only: nothing here changes the engine.
 *
 *   H1  expiry-day afternoon short premium: a naked ATM straddle (H1a) or an iron fly (H1b) sold at
 *       13:30 / 14:00 / 14:30 on the index's own expiry day, bought back at 15:00 / 15:20
 *   H2  weekly calendar: with 1 or 2 sessions left, the current week's ATM straddle sold and the next
 *       week's bought at the same strike, closed at 15:20 the same day or on the current expiry day
 *   H3  event volatility crush (descriptive): the ATM straddle sold at 15:20 on the session before a
 *       Budget, RBI policy or election-result day, bought back at 09:30 / 15:20 on the day
 *
 * Data: Hugging Face dataset "India Index & Options - 1-minute OHLC" by TradeMarkk
 * (thetrademarkk/india-index-options-1m, revision 0f4800e4), licence CC-BY-NC-4.0, non-commercial
 * research use only; downloaded by wp13_fetch.py and reduced by wp13_extract.py. Raw data is never
 * committed.
 *
 *   npx tsx scripts/research/wp13-expiry-calendar-events.ts coverage --x <extract dir> --dir <bhavcopy cache> [--out reports/wp13]
 *   npx tsx scripts/research/wp13-expiry-calendar-events.ts run      --x <extract dir> --dir <bhavcopy cache> [--out reports/wp13] [--ledger]
 *   npx tsx scripts/research/wp13-expiry-calendar-events.ts debug    --x <extract dir> --dir <bhavcopy cache> --index NIFTY --day 2024-06-06
 *
 *   --x    the WP13 extract (index/<SYM>.csv.gz, opt/<SYM>/<day>_<expiry>.csv.gz, manifest.json)
 *   --dir  the compact bhavcopy cache of scripts/fetch-bhavcopy.ts with index-daily.json (expiries, lots, VIX)
 *   --out  where tables and summary JSON go (reports/ is gitignored; raw data is never written there)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  blocksOf,
  calendarNoArbitrage,
  cutDate,
  overallVerdict,
  pickBest,
  remainingSessionEm,
  robustness,
  runOvernight,
  sessionBefore,
  syncMinute,
  worstBlocks,
  type CriterionVerdict,
  type OvernightLeg,
} from "../../src/engine/backtest/expiryCalendar";
import { hhmmToMin, minToHhmm, MinuteSeries, nearestListed, OPEN_MIN, perturbDistance, runPosition, type LegFill, type MinuteBar, type PositionLeg } from "../../src/engine/backtest/intraday1m";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, type BlockBootstrap } from "../../src/engine/backtest/metrics";
import { black76Iv, flyNoArbitrage, intrinsic, maxDrawdown, SCHEDULED_EVENTS, strikeBeyond, structurePnl, tailShare, type EventKind, type LegSpec } from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { bsGreeks } from "../../src/engine/pricing/blackScholes";
import type { Exchange } from "../../src/engine/types";
import { quantile } from "../../src/engine/util/math";
import { ROOT, fail, parseArgs, str } from "../lib/node";
import { loadResearchData, md, RESEARCH_INDICES, tYears, type ResearchData, type ResearchIndex } from "./real_prices";
import { bothListed, CAPITAL, fx, key, loadChainDay, loadIndex, loadManifest, lotOf, pct, rs, vixBefore, type ChainDay, type IndexId, type Manifest, type OptType } from "./wp11-real-intraday";

// ---------------------------------------------------------------------------
// Frozen constants (report §1)
// ---------------------------------------------------------------------------

/** Last session whose option bars hold every trade (WP11 §2); later bars are built from sampled prices. */
const ERA_END = "2024-12-31";
const ENTRY_WAIT = 2;
const EXIT_WAIT = 5;
const MIN_INDEX_BARS = 370;
const IS_FRAC = 0.6;
const MIN_OOS_TRADES = 180;
const BOOT = 20_000;
const BOOT_SUB = 10_000;
const BOOT_FINAL = 100_000;
const H1_ENTRIES = ["13:30", "14:00", "14:30"];
const H1_EXITS = ["15:00", "15:20"];
const H1_STOPS: (number | null)[] = [null, 0.3, 0.5];
const H1_WINGS = [1, 2];
const H2_ENTRIES = ["09:30", "11:15"];
const H2_EXIT = "15:20";
const H3_ENTRY = "15:20";
const H3_EXITS = ["09:30", "15:20"];
const CLOSE = 930;

type Mode = "conservative" | "mid";
const MODES: readonly Mode[] = ["conservative", "mid"];
type Family = "H1a" | "H1b" | "H2" | "H3";
const median = (xs: readonly number[]) => quantile(xs, 0.5);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);

// ---------------------------------------------------------------------------
// Sessions and contracts
// ---------------------------------------------------------------------------

interface IndexCtx {
  sym: IndexId;
  def: ResearchIndex;
  man: Manifest[string];
  index: Map<string, MinuteBar[]>;
  /** Valid sessions (WP11 §1.1): a bhavcopy, not a special session, ≥ 370 index bars from 09:15 with a 09:15 bar. */
  days: string[];
  daySet: Set<string>;
}

function indexCtx(data: ResearchData, x: string, man: Manifest[string], def: ResearchIndex): IndexCtx {
  const index = loadIndex(x, def.id);
  const bookDays = new Set(data.book.dates(def.id));
  const days = man.sessions.filter((day) => {
    const session = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m < CLOSE);
    return bookDays.has(day) && !data.special.has(day) && session.length >= MIN_INDEX_BARS && session[0]?.m === OPEN_MIN;
  });
  return { sym: def.id, def, man, index, days, daySet: new Set(days) };
}

interface Sess {
  sym: IndexId;
  day: string;
  exchange: Exchange;
  idx: MinuteSeries;
  open: number;
  vixPrev: number | null;
  /** The exchange's nearest listed expiry on or after the day (A) and the next one after it (N). */
  expA: string | null;
  expN: string | null;
  /** Sessions to A (NSE calendar, WP10's convention); 0 on A's expiry day. */
  dteA: number;
  has: (expiry: string) => boolean;
  chain: (expiry: string) => ChainDay | null;
  lot: (expiry: string) => number | null;
}

function buildSess(data: ResearchData, x: string, ctx: IndexCtx, day: string): Sess {
  const bars = (ctx.index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= CLOSE);
  const ex = data.book.expiries(ctx.sym, day);
  const chains = new Map<string, ChainDay | null>();
  const pair = (e: string) => ctx.man.pairs[`${day}_${e}`];
  return {
    sym: ctx.sym,
    day,
    exchange: ctx.def.exchange,
    idx: new MinuteSeries(bars),
    open: bars[0]?.o ?? NaN,
    vixPrev: vixBefore(data, day),
    expA: ex[0] ?? null,
    expN: ex[1] ?? null,
    dteA: ex[0] ? data.book.sessionsToExpiry("NIFTY", day, ex[0]) : NaN,
    has: (e) => pair(e) !== undefined,
    chain: (e) => {
      if (!chains.has(e)) chains.set(e, pair(e) ? loadChainDay(x, ctx.sym, day, e, pair(e).role) : null);
      return chains.get(e)!;
    },
    lot: (e) => lotOf(data, ctx.sym, day, e),
  };
}

/** The index's last known level when an order goes in at minute m: the 09:15 open for a 09:15 order, else the close of the bar before m. */
function levelAt(s: Sess, m: number): number | null {
  if (m <= OPEN_MIN) return s.open;
  return s.idx.lastUpTo(m - 1)?.c ?? null;
}

const legOf = (chain: ChainDay | null, k: number, t: OptType, side: "short" | "long"): PositionLeg | null => {
  const s = chain?.series.get(key(k, t));
  return s ? { series: s, side } : null;
};

/** Expiry strictly after the day (WP11's convention B): never the contract expiring that day. */
const expiryAfter = (s: Sess): string | null => (s.expA !== null && s.expA > s.day ? s.expA : s.expN);

// ---------------------------------------------------------------------------
// Eligible samples (no prices)
// ---------------------------------------------------------------------------

interface Eligible {
  days: string[];
  drops: Record<string, number>;
  /** Last in-sample day: the first ⌈60%⌉ of the eligible days (report §1.5). */
  cut: string | null;
}

function bump(o: Record<string, number> | Map<string, number>, k: string): void {
  if (o instanceof Map) o.set(k, (o.get(k) ?? 0) + 1);
  else o[k] = (o[k] ?? 0) + 1;
}

/** H1: the index's own expiry days (contract A expires that day) with the contract in the extract and a lot. */
function h1Eligible(data: ResearchData, ctx: IndexCtx): Eligible {
  const days: string[] = [];
  const drops: Record<string, number> = {};
  for (const d of ctx.days) {
    const a = data.book.expiries(ctx.sym, d)[0];
    if (a !== d) continue;
    if (!ctx.man.pairs[`${d}_${a}`]) bump(drops, "expiring contract missing from the dataset");
    else if (lotOf(data, ctx.sym, d, a) === null) bump(drops, "no lot in the bhavcopy");
    else days.push(d);
  }
  return { days, drops, cut: cutDate(days, IS_FRAC) };
}

/** H2: sessions with 1 or 2 sessions to A, with A and N in the extract and the same lot. */
function h2Eligible(data: ResearchData, ctx: IndexCtx): Eligible {
  const days: string[] = [];
  const drops: Record<string, number> = {};
  for (const d of ctx.days) {
    const [a, n] = data.book.expiries(ctx.sym, d);
    if (!a) continue;
    const dte = data.book.sessionsToExpiry("NIFTY", d, a);
    if (dte !== 1 && dte !== 2) continue;
    if (!n) bump(drops, "no next expiry listed");
    else if (!ctx.man.pairs[`${d}_${a}`]) bump(drops, "current week missing from the dataset");
    else if (!ctx.man.pairs[`${d}_${n}`]) bump(drops, "next week missing from the dataset");
    else {
      const la = lotOf(data, ctx.sym, d, a);
      const ln = lotOf(data, ctx.sym, d, n);
      if (la === null || ln === null) bump(drops, "no lot in the bhavcopy");
      else if (la !== ln) bump(drops, "the two weeks' lots differ");
      else days.push(d);
    }
  }
  return { days, drops, cut: cutDate(days, IS_FRAC) };
}

interface EventSlot {
  date: string;
  kind: EventKind;
  /** The session before the event (NSE calendar). */
  pre: string | null;
  expiry: string | null;
  status: string;
}

/** H3: the scheduled events inside the index's data, each with the session before and the contract sold there. */
function h3Events(data: ResearchData, ctx: IndexCtx): EventSlot[] {
  const nse = data.book.dates("NIFTY");
  const out: EventSlot[] = [];
  for (const ev of SCHEDULED_EVENTS) {
    if (ev.date < ctx.days[0] || ev.date > ctx.days[ctx.days.length - 1]) continue;
    const pre = sessionBefore(nse, ev.date);
    const slot: EventSlot = { date: ev.date, kind: ev.kind, pre, expiry: null, status: "ok" };
    if (!ctx.daySet.has(ev.date)) slot.status = "event day not a valid session";
    else if (!pre || !ctx.daySet.has(pre)) slot.status = "session before not valid";
    else {
      const ex = data.book.expiries(ctx.sym, pre).filter((e) => e > pre);
      slot.expiry = ex[0] ?? null;
      if (!slot.expiry) slot.status = "no expiry";
      else if (!ctx.man.pairs[`${pre}_${slot.expiry}`] || !ctx.man.pairs[`${ev.date}_${slot.expiry}`]) slot.status = "contract missing from the dataset";
      else if (lotOf(data, ctx.sym, pre, slot.expiry) === null) slot.status = "no lot in the bhavcopy";
    }
    out.push(slot);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

interface H1Spec {
  kind: "H1";
  entry: number;
  exit: number;
  stop: number | null;
  /** 0 for the straddle, else the wings' distance in expected moves for the rest of the session. */
  wings: number;
  mode: Mode;
}
interface H2Spec {
  kind: "H2";
  entry: number;
  exit: number;
  /** false: exit the same day; true: exit on A's expiry day. */
  hold: boolean;
  mode: Mode;
}
interface H3Spec {
  kind: "H3";
  entry: number;
  exit: number;
  mode: Mode;
}
type Spec = H1Spec | H2Spec | H3Spec;

export interface Trade13 {
  /** Entry session. */
  day: string;
  exitDay: string;
  /** Bootstrap block: the exit session (one block per expiry week for H2 holds, per event for H3). */
  block: string;
  net: number;
  gross: number;
  charges: number;
  /** ₹ per lot received for the short legs at the entry fills. */
  premium: number;
  /** ₹ per lot paid for the long legs minus received for the short legs (a calendar's debit; negative for a credit). */
  debit: number;
  entryMin: number;
  exitMin: number;
  reason: string;
  stale: number;
  dte: number;
  k: number;
  lot: number;
  /** Index level used for the strike, at the exit, their % change, and the largest excursion in between (same-day trades). */
  level: number;
  levelExit: number;
  move: number;
  maxExc: number;
  /** Calendar greeks at the entry minute from the bar closes (H2 only): net gamma ₹ for a 1% index move, net vega ₹ per vol point, net theta ₹ per session. */
  greeks?: { gamma1pct: number; vega1: number; theta: number };
}

type Outcome = { trade: Trade13 } | { skip: string };

function book(s: Sess, exitSess: Sess, lot: number, legs: LegFill[], o: { k: number; level: number; entryMin: number; exitMin: number; reason: string; dte: number }): Trade13 {
  const specs: LegSpec[] = legs.map((l) => ({ side: l.side, entry: l.entry, exit: l.exit, settled: false }));
  const p = structurePnl(specs, { lot, exchange: s.exchange, entryDate: s.day, exitDate: exitSess.day, spread: () => 0 });
  const short = sum(legs.filter((l) => l.side === "short").map((l) => l.entry)) * lot;
  const long = sum(legs.filter((l) => l.side === "long").map((l) => l.entry)) * lot;
  const levelExit = exitSess.idx.lastUpTo(o.exitMin)?.c ?? NaN;
  let maxExc = NaN;
  if (exitSess === s) {
    const bars = s.idx.between(o.entryMin, o.exitMin + 1);
    if (bars.length) maxExc = Math.max(...bars.map((b) => Math.max(b.h / o.level - 1, 1 - b.l / o.level)));
  }
  return {
    day: s.day,
    exitDay: exitSess.day,
    block: exitSess.day,
    net: p.net,
    gross: p.gross,
    charges: p.charges,
    premium: short,
    debit: long - short,
    entryMin: o.entryMin,
    exitMin: o.exitMin,
    reason: o.reason,
    stale: legs.filter((l) => l.staleExit).length,
    dte: o.dte,
    k: o.k,
    lot,
    level: o.level,
    levelExit,
    move: levelExit / o.level - 1,
    maxExc,
  };
}

/** H1: a short ATM straddle (or iron fly) of the expiring contract, sold and bought back at clock times on its expiry day. */
function evalH1(s: Sess, sp: H1Spec): Outcome {
  const e = s.expA;
  const chain = e ? s.chain(e) : null;
  const lot = e ? s.lot(e) : null;
  if (!e || !chain || lot === null) return { skip: "no contract" };
  const level = levelAt(s, sp.entry);
  if (level === null) return { skip: "no index level" };
  const k = nearestListed(bothListed(chain), level);
  if (k === null) return { skip: "no ATM strike" };
  const c = legOf(chain, k, "CE", "short");
  const p = legOf(chain, k, "PE", "short");
  if (!c || !p) return { skip: "no ATM strike" };
  let legs: PositionLeg[] = [c, p];
  let entryMin = sp.entry;
  let entryWait = ENTRY_WAIT;
  if (sp.wings > 0) {
    if (s.vixPrev === null) return { skip: "no VIX" };
    const em = remainingSessionEm(level, s.vixPrev, sp.entry);
    const kc = strikeBeyond(chain.strikes.CE, k, k + sp.wings * em, "above");
    const kp = strikeBeyond(chain.strikes.PE, k, k - sp.wings * em, "below");
    if (kc === null || kp === null) return { skip: "no wing strike" };
    const wc = legOf(chain, kc, "CE", "long")!;
    const wp = legOf(chain, kp, "PE", "long")!;
    legs = [c, p, wc, wp];
    const t = syncMinute(legs.map((l) => l.series), sp.entry, ENTRY_WAIT);
    if (t === null) return { skip: "legs not synchronous" };
    const at = (l: PositionLeg) => l.series.at(t)!.c;
    if (flyNoArbitrage({ k, kc, kp, c: at(c), p: at(p), wc: at(wc), wp: at(wp) }) !== "ok") return { skip: "no-arbitrage check" };
    entryMin = t;
    entryWait = 0;
  }
  const res = runPosition({ legs, entryMin, entryWait, exitMin: sp.exit, exitWait: EXIT_WAIT, stopFrac: sp.stop, mode: sp.mode });
  if (!res) return { skip: "no bar in the entry window" };
  return { trade: book(s, s, lot, res.legs, { k, level, entryMin: res.entryMin, exitMin: res.exitMin, reason: res.exitReason, dte: 0 }) };
}

/** Calendar greeks at the entry minute from the four closes (Black-76 on each expiry's parity forward, the engine's trading-time clock). */
function calendarGreeks(data: ResearchData, s: Sess, k: number, px: number[], t: number, lot: number): Trade13["greeks"] | undefined {
  const hhmm = minToHhmm(t);
  const g = (expiry: string, call: number, put: number) => {
    const fwd = k + call - put;
    const ty = tYears(data, s.day, hhmm, expiry);
    const out = { gamma: 0, vega: 0, theta: 0 };
    for (const [type, price] of [["CE", call], ["PE", put]] as const) {
      const iv = black76Iv(price, fwd, k, ty, type);
      if (iv === null) return null;
      const gr = bsGreeks({ spot: fwd, strike: k, tYears: ty, vol: iv, r: 0, type });
      out.gamma += gr.gamma;
      out.vega += gr.vega;
      out.theta += gr.thetaPerDay;
    }
    return { ...out, fwd };
  };
  const near = g(s.expA!, px[0], px[1]);
  const far = g(s.expN!, px[2], px[3]);
  if (!near || !far) return undefined;
  const move = 0.01 * near.fwd;
  return {
    gamma1pct: 0.5 * (far.gamma - near.gamma) * move * move * lot,
    vega1: ((far.vega - near.vega) / 100) * lot,
    theta: (far.theta - near.theta) * lot,
  };
}

/** H2: short the current week's ATM straddle, long the next week's at the same strike. */
function evalH2(data: ResearchData, s: Sess, sE: Sess | null, sp: H2Spec): Outcome {
  const a = s.expA;
  const n = s.expN;
  if (!a || !n) return { skip: "no contract" };
  const ca = s.chain(a);
  const cn = s.chain(n);
  const la = s.lot(a);
  const ln = s.lot(n);
  if (!ca || !cn || la === null || ln === null) return { skip: "no contract" };
  if (la !== ln) return { skip: "lots differ" };
  const level = levelAt(s, sp.entry);
  if (level === null) return { skip: "no index level" };
  const far = new Set(bothListed(cn));
  const k = nearestListed(bothListed(ca).filter((z) => far.has(z)), level);
  if (k === null) return { skip: "no common ATM strike" };
  const legs: PositionLeg[] = [legOf(ca, k, "CE", "short")!, legOf(ca, k, "PE", "short")!, legOf(cn, k, "CE", "long")!, legOf(cn, k, "PE", "long")!];
  const t = syncMinute(legs.map((l) => l.series), sp.entry, ENTRY_WAIT);
  if (t === null) return { skip: "legs not synchronous" };
  const px = legs.map((l) => l.series.at(t)!.c);
  if (!calendarNoArbitrage({ nearCall: px[0], nearPut: px[1], farCall: px[2], farPut: px[3] })) return { skip: "no-arbitrage check" };
  const greeks = sp.mode === "mid" ? calendarGreeks(data, s, k, px, t, la) : undefined;
  if (!sp.hold) {
    const res = runPosition({ legs, entryMin: t, entryWait: 0, exitMin: sp.exit, exitWait: EXIT_WAIT, stopFrac: null, mode: sp.mode });
    if (!res) return { skip: "no bar in the entry window" };
    return { trade: { ...book(s, s, la, res.legs, { k, level, entryMin: res.entryMin, exitMin: res.exitMin, reason: res.exitReason, dte: s.dteA }), greeks } };
  }
  if (!sE) return { skip: "expiry session missing" };
  const ser = (c: ChainDay | null, type: OptType) => c?.series.get(key(k, type)) ?? null;
  const ea = sE.chain(a);
  const en = sE.chain(n);
  // A's legs expire on sE's day: without any bar there they exit at intrinsic value (§1.2).
  const lvE = levelAt(sE, sp.exit);
  const fb = (type: OptType) => (lvE === null ? null : intrinsic(type, k, lvE));
  const ol: OvernightLeg[] = [
    { entry: legs[0].series, exit: ser(ea, "CE"), side: "short", exitFallback: fb("CE") },
    { entry: legs[1].series, exit: ser(ea, "PE"), side: "short", exitFallback: fb("PE") },
    { entry: legs[2].series, exit: ser(en, "CE"), side: "long" },
    { entry: legs[3].series, exit: ser(en, "PE"), side: "long" },
  ];
  const r = runOvernight({ legs: ol, entryMin: t, entryWait: 0, exitMin: sp.exit, exitWait: EXIT_WAIT, mode: sp.mode });
  if ("skip" in r) return { skip: r.skip };
  return { trade: { ...book(s, sE, la, r.legs, { k, level, entryMin: r.entryMin, exitMin: r.exitMin, reason: "time", dte: s.dteA }), greeks } };
}

/** H3: short the ATM straddle of the contract after the pre-event session, held over the night into the event day. */
function evalH3(data: ResearchData, pre: Sess, ev: Sess, sp: H3Spec): Outcome {
  const e = expiryAfter(pre);
  if (!e) return { skip: "no contract" };
  const cp = pre.chain(e);
  const cv = ev.chain(e);
  const lot = pre.lot(e);
  if (!cp || lot === null) return { skip: "no contract" };
  if (!cv) return { skip: "no contract on the event day" };
  const level = levelAt(pre, sp.entry);
  if (level === null) return { skip: "no index level" };
  const k = nearestListed(bothListed(cp), level);
  if (k === null) return { skip: "no ATM strike" };
  // A contract expiring on the event day exits a leg without any bar that day at intrinsic value (§1.2).
  const lvX = e === ev.day ? levelAt(ev, sp.exit) : null;
  const fb = (type: OptType) => (lvX === null ? null : intrinsic(type, k, lvX));
  const ol: OvernightLeg[] = [
    { entry: cp.series.get(key(k, "CE"))!, exit: cv.series.get(key(k, "CE")) ?? null, side: "short", exitFallback: fb("CE") },
    { entry: cp.series.get(key(k, "PE"))!, exit: cv.series.get(key(k, "PE")) ?? null, side: "short", exitFallback: fb("PE") },
  ];
  const r = runOvernight({ legs: ol, entryMin: sp.entry, entryWait: ENTRY_WAIT, exitMin: sp.exit, exitWait: EXIT_WAIT, mode: sp.mode });
  if ("skip" in r) return { skip: r.skip };
  return { trade: book(pre, ev, lot, r.legs, { k, level, entryMin: r.entryMin, exitMin: r.exitMin, reason: "time", dte: data.book.sessionsToExpiry("NIFTY", ev.day, e) }) };
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface Run {
  name: string;
  family: Family;
  index: IndexId;
  mode: Mode;
  kind: "strategy" | "perturbation";
  base?: string;
  params: Record<string, unknown>;
  spec: Spec;
  trades: Trade13[];
  /** Every eligible session the variant was evaluated on, with its bootstrap block. */
  slots: { day: string; block: string }[];
  skips: Record<string, number>;
}

const stopLabel = (s: number | null) => (s === null ? "no stop" : `stop +${Math.round(s * 100)}%`);

function h1Name(sym: IndexId, sp: H1Spec): string {
  return `${sym} ${sp.wings > 0 ? `H1b fly ${sp.wings}EM` : "H1a straddle"} ${minToHhmm(sp.entry)}→${minToHhmm(sp.exit)} ${stopLabel(sp.stop)} ${sp.mode}`;
}
function h2Name(sym: IndexId, sp: H2Spec): string {
  return `${sym} H2 calendar ${minToHhmm(sp.entry)}→${sp.hold ? "expiry " : ""}${minToHhmm(sp.exit)} ${sp.mode}`;
}
function h3Name(sym: IndexId, sp: H3Spec): string {
  return `${sym} H3 event straddle ${minToHhmm(sp.entry)}→event day ${minToHhmm(sp.exit)} ${sp.mode}`;
}

function paramsOf(sym: IndexId, sp: Spec): Record<string, unknown> {
  if (sp.kind === "H1")
    return { hypothesis: "H1", family: sp.wings > 0 ? "H1b" : "H1a", structure: sp.wings > 0 ? "short iron fly" : "short straddle", contract: "A on its own expiry day (DTE 0)", entry: minToHhmm(sp.entry), exit: minToHhmm(sp.exit), stopPct: sp.stop, wingsEmRemaining: sp.wings, fill: sp.mode, index: sym };
  if (sp.kind === "H2")
    return { hypothesis: "H2", family: "H2", structure: "calendar: short A ATM straddle, long N straddle at the same strike", days: "1-2 sessions to A", entry: minToHhmm(sp.entry), exit: `${minToHhmm(sp.exit)} ${sp.hold ? "on A's expiry day" : "same day"}`, fill: sp.mode, index: sym };
  return { hypothesis: "H3", family: "H3", structure: "short ATM straddle", contract: "nearest expiry after the pre-event session", entry: `${minToHhmm(sp.entry)} on the session before`, exit: `${minToHhmm(sp.exit)} on the event day`, fill: sp.mode, index: sym };
}

function newRun(sym: IndexId, sp: Spec, kind: Run["kind"] = "strategy", base?: Run, label?: string): Run {
  const family: Family = sp.kind === "H1" ? (sp.wings > 0 ? "H1b" : "H1a") : sp.kind;
  const baseName = sp.kind === "H1" ? h1Name(sym, sp) : sp.kind === "H2" ? h2Name(sym, sp) : h3Name(sym, sp);
  const name = base && label ? `${base.name} [${label}]` : baseName;
  const params = base && label ? { ...base.params, perturbation: label } : paramsOf(sym, sp);
  return { name, family, index: sym, mode: sp.mode, kind, base: base?.name, params, spec: sp, trades: [], slots: [], skips: {} };
}

function strategyRuns(sym: IndexId): Run[] {
  const out: Run[] = [];
  for (const mode of MODES) {
    for (const wings of [0, ...H1_WINGS])
      for (const e of H1_ENTRIES)
        for (const x of H1_EXITS) for (const stop of H1_STOPS) out.push(newRun(sym, { kind: "H1", entry: hhmmToMin(e), exit: hhmmToMin(x), stop, wings, mode }));
    for (const e of H2_ENTRIES) for (const hold of [false, true]) out.push(newRun(sym, { kind: "H2", entry: hhmmToMin(e), exit: hhmmToMin(H2_EXIT), hold, mode }));
    for (const x of H3_EXITS) out.push(newRun(sym, { kind: "H3", entry: hhmmToMin(H3_ENTRY), exit: hhmmToMin(x), mode }));
  }
  return out;
}

/** The ±20% perturbations of a picked variant (report §1.6). */
function perturbationsOf(r: Run): Run[] {
  const sp = r.spec;
  const out: Run[] = [];
  if (sp.kind === "H1") {
    for (const d of perturbDistance(CLOSE - sp.entry, 1)) out.push(newRun(r.index, { ...sp, entry: CLOSE - d }, "perturbation", r, `entry ${minToHhmm(CLOSE - d)}`));
    for (const d of perturbDistance(CLOSE - sp.exit, 1)) out.push(newRun(r.index, { ...sp, exit: CLOSE - d }, "perturbation", r, `exit ${minToHhmm(CLOSE - d)}`));
    if (sp.stop !== null) for (const f of [0.8, 1.2]) out.push(newRun(r.index, { ...sp, stop: sp.stop * f }, "perturbation", r, `stop ×${f}`));
    if (sp.wings > 0) for (const f of [0.8, 1.2]) out.push(newRun(r.index, { ...sp, wings: sp.wings * f }, "perturbation", r, `wings ×${f}`));
  } else if (sp.kind === "H2") {
    for (const d of perturbDistance(sp.entry - OPEN_MIN)) out.push(newRun(r.index, { ...sp, entry: OPEN_MIN + d }, "perturbation", r, `entry ${minToHhmm(OPEN_MIN + d)}`));
    for (const d of perturbDistance(CLOSE - sp.exit, 1)) out.push(newRun(r.index, { ...sp, exit: CLOSE - d }, "perturbation", r, `exit ${minToHhmm(CLOSE - d)}`));
  }
  return out.filter((p) => p.spec.kind === "H3" || p.spec.entry < p.spec.exit || (p.spec.kind === "H2" && p.spec.hold));
}

function record(r: Run, slot: { day: string; block: string }, o: Outcome): void {
  r.slots.push(slot);
  if ("skip" in o) r.skips[o.skip] = (r.skips[o.skip] ?? 0) + 1;
  else r.trades.push(o.trade);
}

/** Evaluates runs over one index's eligible sessions, hypothesis by hypothesis, loading each session once. */
function evaluate(data: ResearchData, x: string, ctx: IndexCtx, el: { h1: Eligible; h2: Eligible; h3: EventSlot[] }, runs: Run[], log: (s: string) => void): void {
  const h1 = runs.filter((r) => r.spec.kind === "H1");
  const h2 = runs.filter((r) => r.spec.kind === "H2");
  const h3 = runs.filter((r) => r.spec.kind === "H3");
  if (h1.length) {
    for (const d of el.h1.days) {
      const s = buildSess(data, x, ctx, d);
      for (const r of h1) record(r, { day: d, block: d }, evalH1(s, r.spec as H1Spec));
    }
    log(`  ${ctx.sym} H1: ${el.h1.days.length} expiry days × ${h1.length} variants`);
  }
  if (h2.length) {
    let cacheE: Sess | null = null;
    for (const d of el.h2.days) {
      const s = buildSess(data, x, ctx, d);
      const E = s.expA!;
      if (!cacheE || cacheE.day !== E) cacheE = ctx.daySet.has(E) ? buildSess(data, x, ctx, E) : null;
      for (const r of h2) {
        const sp = r.spec as H2Spec;
        record(r, { day: d, block: sp.hold ? E : d }, evalH2(data, s, cacheE, sp));
      }
    }
    log(`  ${ctx.sym} H2: ${el.h2.days.length} sessions × ${h2.length} variants`);
  }
  if (h3.length) {
    for (const ev of el.h3) {
      if (ev.status !== "ok") continue;
      const pre = buildSess(data, x, ctx, ev.pre!);
      const day = buildSess(data, x, ctx, ev.date);
      for (const r of h3) record(r, { day: ev.pre!, block: ev.date }, evalH3(data, pre, day, r.spec as H3Spec));
    }
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Sub {
  label: string;
  n: number;
  blocks: number;
  net: number;
  mean: number;
  lo: number;
  hi: number;
  sessLo: number;
  sessHi: number;
  pf: number;
  hit: number;
  boot: BlockBootstrap;
  /** Per-block net ÷ ₹5 lakh, in date order (sessions without a trade are 0). */
  rets: number[];
}

function subStats(r: Run, label: string, f: (day: string) => boolean, resamples: number): Sub {
  const slots = r.slots.filter((s) => f(s.day));
  const keys = [...new Set(slots.map((s) => s.block))];
  const ts = r.trades.filter((t) => f(t.day));
  const blocks = blocksOf(ts, keys);
  const boot = dayBlockBootstrap(blocks, { resamples, seed: 7 });
  const nets = ts.map((t) => t.net);
  return {
    label,
    n: ts.length,
    blocks: blocks.length,
    net: sum(nets),
    mean: avg(nets),
    lo: boot.perTrade.lo,
    hi: boot.perTrade.hi,
    sessLo: boot.perSession.lo,
    sessHi: boot.perSession.hi,
    pf: profitFactor(nets),
    hit: ts.length ? ts.filter((t) => t.net > 0).length / ts.length : NaN,
    boot,
    rets: blocks.map((b) => sum(b.pnls) / CAPITAL),
  };
}

interface Stats {
  full: Sub;
  is: Sub;
  oos: Sub;
  era1: Sub;
  era2: Sub;
  oosEra1: Sub;
  oosEra2: Sub;
  years: { year: string; n: number; net: number; mean: number }[];
  dte: { dte: number; n: number; mean: number }[];
  meanPct: number;
  sr: number;
  tail: { worstDay: number; worstDayDate: string; worst10: number; maxDD: number; worst5Sum: number; worst5Multiple: number };
  charges: number;
  premium: number;
  debit: number;
}

function sharpe(rets: readonly number[]): number {
  const m = avg(rets);
  const sd = Math.sqrt(sum(rets.map((x) => (x - m) ** 2)) / Math.max(1, rets.length - 1));
  return sd > 0 ? m / sd : 0;
}

function statsOf(r: Run, cut: string | null, light = false): Stats {
  const c = cut ?? "9999-12-31";
  const all = () => true;
  const sub = (label: string, f: (d: string) => boolean, n: number) => subStats(r, label, f, light ? 2_000 : n);
  const full = sub("all", all, BOOT);
  let oos = sub("last 40%", (d) => d > c, BOOT);
  if (!light && oos.lo > 0 && oos.sessLo > 0) oos = subStats(r, "last 40%", (d) => d > c, BOOT_FINAL);
  const years = [...new Set(r.trades.map((t) => t.day.slice(0, 4)))].sort().map((year) => {
    const ts = r.trades.filter((t) => t.day.startsWith(year));
    return { year, n: ts.length, net: sum(ts.map((t) => t.net)), mean: avg(ts.map((t) => t.net)) };
  });
  const dte = [...new Set(r.trades.map((t) => t.dte))].sort((a, b) => a - b).map((d) => {
    const ts = r.trades.filter((t) => t.dte === d);
    return { dte: d, n: ts.length, mean: avg(ts.map((t) => t.net)) };
  });
  const blocks = blocksOf(r.trades, [...new Set(r.slots.map((s) => s.block))]);
  const blockNet = blocks.map((b) => sum(b.pnls));
  const traded = blocks.filter((b) => b.pnls.length > 0).map((b) => sum(b.pnls));
  const wi = blockNet.reduce((bi, v, i) => (v < blockNet[bi] ? i : bi), 0);
  const ts = tailShare(traded, 0.05);
  const isCalendar = r.spec.kind === "H2";
  return {
    full,
    is: sub("first 60%", (d) => d <= c, BOOT_SUB),
    oos,
    era1: sub("complete bars (to Dec 2024)", (d) => d <= ERA_END, BOOT_SUB),
    era2: sub("sampled bars (from Jan 2025)", (d) => d > ERA_END, BOOT_SUB),
    oosEra1: sub("last 40%, to Dec 2024", (d) => d > c && d <= ERA_END, BOOT_SUB),
    oosEra2: sub("last 40%, from Jan 2025", (d) => d > c && d > ERA_END, BOOT_SUB),
    years,
    dte,
    meanPct: sum(r.trades.map((t) => t.net)) / Math.max(1e-9, Math.abs(sum(r.trades.map((t) => (isCalendar ? t.debit : t.premium))))),
    sr: sharpe(full.rets),
    tail: {
      worstDay: blockNet.length ? blockNet[wi] : NaN,
      worstDayDate: blocks[wi]?.day ?? "",
      worst10: sum(worstBlocks(r.trades, 10).map((b) => b.net)),
      maxDD: maxDrawdown(blockNet).depth,
      worst5Sum: ts.worstSum,
      worst5Multiple: ts.multiple,
    },
    charges: avg(r.trades.map((t) => t.charges)),
    premium: avg(r.trades.map((t) => t.premium)),
    debit: avg(r.trades.map((t) => t.debit)),
  };
}

// ---------------------------------------------------------------------------
// The bar (report §1.7), on the walk-forward pick of each family, index and fill
// ---------------------------------------------------------------------------

interface Criterion {
  name: string;
  verdict: CriterionVerdict;
  detail: string;
}

interface Judged {
  run: Run;
  stats: Stats;
  criteria: Criterion[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT";
  p: number;
  dsr: number;
  dsrNull: number;
  perts: { name: string; oosNet: number; oosN: number; fullNet: number }[] | null;
}

/** Criteria 2 and 3 on the last 40%: the condition for running the perturbations. */
const passesCore = (s: Stats) => s.oos.n > 0 && s.oos.lo > 0 && s.oos.sessLo > 0 && s.oos.pf >= 1.3;

function judge(r: Run, s: Stats, perts: Judged["perts"], ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  const o = s.oos;
  c.push({ name: `≥ ${MIN_OOS_TRADES} trades out of sample`, verdict: o.n >= MIN_OOS_TRADES ? "PASS" : "INSUFFICIENT", detail: `${o.n} trades in the last 40% (${o.blocks} ${r.spec.kind === "H2" && (r.spec as H2Spec).hold ? "expiry weeks" : "sessions"})` });
  c.push({ name: "out of sample: 95% CI > 0 per trade and per session (day blocks)", verdict: o.lo > 0 && o.sessLo > 0 ? "PASS" : "FAIL", detail: `${rs(o.mean)}/trade (${rs(o.lo)} … ${rs(o.hi)}); per session ${rs(o.boot.perSession.estimate)} (${rs(o.sessLo)} … ${rs(o.sessHi)}); ${o.boot.resamples.toLocaleString("en-IN")} resamples` });
  c.push({ name: "out of sample: PF ≥ 1.3", verdict: o.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(o.pf) });
  if (perts === null) c.push({ name: "±20% robustness (out of sample)", verdict: "NOT RUN", detail: "run only for picks that pass the out-of-sample CI and PF" });
  else {
    const rb = robustness(o.net, perts.map((p) => p.oosNet));
    const worst = perts.find((p) => p.oosNet === rb.worst);
    c.push({ name: "±20% robustness (out of sample)", verdict: rb.pass ? "PASS" : "FAIL", detail: `${rb.positive}/${rb.total} positive; worst ${worst ? `${worst.name.replace(`${r.name} `, "")} ${rs(worst.oosNet)}` : "–"} vs base ${rs(o.net)}` });
  }
  const p = Math.max(o.boot.perTrade.p, o.boot.perSession.p);
  const dsr = deflatedSharpe(o.rets, ledgerN, srVar);
  const dsrNull = deflatedSharpe(o.rets, ledgerN, null);
  const alpha = 0.05 / ledgerN;
  c.push({ name: "Bonferroni and deflated Sharpe (out of sample)", verdict: p < alpha && dsr.dsr >= 0.95 ? "PASS" : "FAIL", detail: `p ${p.toExponential(1)} vs 0.05/${ledgerN} = ${alpha.toExponential(1)}; DSR ${fx(dsr.dsr, 3)} (SR ${fx(dsr.sr, 3)}/session, SR₀ ${fx(dsr.sr0, 3)}); with V = 1/(T−1): DSR ${fx(dsrNull.dsr, 3)}` });
  const e1 = s.era1;
  c.push({ name: "complete-bar era (to Dec 2024, all days): mean > 0, CI > 0", verdict: e1.n > 0 && e1.lo > 0 ? "PASS" : "FAIL", detail: `${e1.n} trades, ${rs(e1.mean)}/trade (${rs(e1.lo)} … ${rs(e1.hi)}), PF ${fx(e1.pf)}; sampled era ${s.era2.n} trades, ${rs(s.era2.mean)} (${rs(s.era2.lo)} … ${rs(s.era2.hi)})` });
  return { run: r, stats: s, criteria: c, verdict: overallVerdict(c.map((z) => z.verdict)), p, dsr: dsr.dsr, dsrNull: dsrNull.dsr, perts };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");
const DATA_TAG =
  "TradeMarkk 1-minute NIFTY/SENSEX options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), WP13 extract (A and next-week contracts), NIFTY 2021-05..2026-07, SENSEX 2023-08..2026-07; lots and expiries from the bhavcopy cache";

function trialOf(r: Run, s: Stats): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: "WP13",
    variant: r.name,
    params: r.params,
    data: DATA_TAG,
    trades: s.full.n,
    net: Math.round(s.full.net * 100) / 100,
    notes: `${r.family} ${r.kind}; ${r.mode} fills (sell at the 1-min low / buy at the high, or the close); ₹/lot per trade ${fx(s.full.mean)} (day-block 95% CI ${fx(s.full.lo)}..${fx(s.full.hi)}), PF ${fx(s.full.pf)}; first 60% ${fx(s.is.mean)} (${s.is.n}), last 40% ${fx(s.oos.mean)} (${s.oos.n}); one lot at the lot in force; dated charges`,
    kind: r.kind,
    account: "main",
    sessions: s.full.blocks,
    meanPerTrade: Math.round(s.full.mean * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const VHEAD = ["variant", "trades", "₹/trade (95% CI)", "% of premium (H2: of the debit)", "hit", "PF", "first 60% ₹/trade (n)", "last 40% ₹/trade [CI] (n, PF)", "to Dec 2024 / from 2025 ₹/trade", "years +", "stopped", "skips"];

function vrow(r: Run, s: Stats, prefix: string): (string | number)[] {
  const yrs = s.years.filter((y) => y.n >= 20);
  const skips = Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join("; ") || "–";
  return [
    r.name.replace(prefix, ""),
    s.full.n,
    `${rs(s.full.mean)} (${rs(s.full.lo)} … ${rs(s.full.hi)})`,
    pct(s.meanPct),
    pct(s.full.hit, 0),
    fx(s.full.pf),
    `${rs(s.is.mean)} (${s.is.n})`,
    `${rs(s.oos.mean)} [${rs(s.oos.lo)} … ${rs(s.oos.hi)}] (${s.oos.n}, ${fx(s.oos.pf)})`,
    `${rs(s.era1.mean)} / ${rs(s.era2.mean)}`,
    `${yrs.filter((y) => y.net > 0).length}/${yrs.length}`,
    s.full.n ? pct(r.trades.filter((t) => t.reason === "stop").length / s.full.n, 0) : "–",
    skips,
  ];
}

const THEAD = ["variant", "trades", "net ₹ total", "worst day (date)", "10 worst days", "max drawdown (% of ₹5 lakh)", "worst 5% of days (× the total net they lost)", "charges ₹/trade", "premium ₹/trade (H2: net debit)"];

function trow(r: Run, s: Stats, prefix: string): (string | number)[] {
  return [
    r.name.replace(prefix, ""),
    s.full.n,
    rs(s.full.net),
    `${rs(s.tail.worstDay)} (${s.tail.worstDayDate})`,
    rs(s.tail.worst10),
    `${rs(s.tail.maxDD)} (${pct(s.tail.maxDD / CAPITAL)})`,
    s.full.net > 0 ? `${rs(s.tail.worst5Sum)} (${fx(-s.tail.worst5Multiple)}×)` : `${rs(s.tail.worst5Sum)} (net < 0)`,
    rs(s.charges),
    rs(r.spec.kind === "H2" ? s.debit : s.premium),
  ];
}

function worstList(r: Run, k: number): string {
  const rows: (string | number)[][] = [["exit day", "entry day", "₹ per lot", "exit", "strike", "index at entry → exit", "move", "largest excursion", "premium ₹/lot"]];
  for (const w of worstBlocks(r.trades, k)) {
    for (const t of r.trades.filter((z) => z.block === w.block)) {
      rows.push([t.exitDay, t.day, rs(t.net), `${t.reason} ${minToHhmm(t.exitMin)}`, t.k, `${fx(t.level, 1)} → ${fx(t.levelExit, 1)}`, pct(t.move, 2), Number.isFinite(t.maxExc) ? pct(t.maxExc, 2) : "–", rs(r.spec.kind === "H2" ? t.debit : t.premium)]);
    }
  }
  return md(rows);
}

function lateMoves(r: Run, k: number): string {
  const rows: (string | number)[][] = [["day", "index entry → exit", "move", "largest excursion", "₹ per lot", "exit"]];
  for (const t of [...r.trades].sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, k)) rows.push([t.day, `${fx(t.level, 1)} → ${fx(t.levelExit, 1)}`, pct(t.move, 2), pct(t.maxExc, 2), rs(t.net), `${t.reason} ${minToHhmm(t.exitMin)}`]);
  return md(rows);
}

function yearTable(s: Stats): string {
  return md([["year", "trades", "net ₹", "₹/trade"], ...s.years.map((y) => [y.year, y.n, rs(y.net), rs(y.mean)])]);
}

function subRow(x: Sub): (string | number)[] {
  return [x.label, x.n, rs(x.mean), `${rs(x.lo)} … ${rs(x.hi)}`, fx(x.pf), pct(x.hit, 0), rs(x.net)];
}

// ---------------------------------------------------------------------------
// coverage: the samples and bar presence at the order minutes (no prices; before the freeze)
// ---------------------------------------------------------------------------

async function coverage(args: ReturnType<typeof parseArgs>): Promise<void> {
  const x = str(args, "x") ?? fail("--x <extract dir> is required");
  const dir = str(args, "dir") ?? fail("--dir <bhavcopy cache> is required");
  const outDir = resolve(ROOT, str(args, "out", "reports/wp13")!);
  const manifest = loadManifest(x);
  const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir });
  const out: string[] = ["# WP13 coverage (generated; bar presence only, no prices)\n"];
  const summary: Record<string, unknown> = {};
  for (const def of RESEARCH_INDICES) {
    const ctx = indexCtx(data, x, manifest[def.id], def);
    const h1 = h1Eligible(data, ctx);
    const h2 = h2Eligible(data, ctx);
    const h3 = h3Events(data, ctx);
    const split = (el: Eligible) => {
      const c = el.cut ?? "";
      const is = el.days.filter((d) => d <= c);
      const oos = el.days.filter((d) => d > c);
      const era = (xs: string[]) => `${xs.filter((d) => d <= ERA_END).length} to Dec 2024 / ${xs.filter((d) => d > ERA_END).length} from 2025`;
      return `${el.days.length} sessions (${el.days[0]} … ${el.days.at(-1)}); cut after ${c}: first 60% ${is.length} (${era(is)}), last 40% ${oos.length} (${era(oos)}); dropped: ${Object.entries(el.drops).map(([k, v]) => `${k} ${v}`).join("; ") || "none"}`;
    };
    out.push(`\n## ${def.id}\n\nValid sessions ${ctx.days.length} (${ctx.days[0]} … ${ctx.days.at(-1)}).\n\n- **H1** expiry days: ${split(h1)}\n- **H2** sessions with 1–2 sessions to A: ${split(h2)}; DTE 1: ${h2.days.filter((d) => data.book.sessionsToExpiry("NIFTY", d, data.book.expiries(def.id, d)[0]) === 1).length}, DTE 2: ${h2.days.filter((d) => data.book.sessionsToExpiry("NIFTY", d, data.book.expiries(def.id, d)[0]) === 2).length}\n- **H3** events in range: ${h3.length}; usable ${h3.filter((e) => e.status === "ok").length}\n`);
    // H1: bar presence at the order minutes.
    const h1c = new Map<string, number>();
    for (const d of h1.days) {
      const s = buildSess(data, x, ctx, d);
      const chain = s.chain(d)!;
      for (const T of H1_ENTRIES) {
        const m = hhmmToMin(T);
        const level = levelAt(s, m);
        const k = level === null ? null : nearestListed(bothListed(chain), level);
        if (k === null) continue;
        const c = chain.series.get(key(k, "CE"))!;
        const p = chain.series.get(key(k, "PE"))!;
        if (c.firstFrom(m, ENTRY_WAIT) && p.firstFrom(m, ENTRY_WAIT)) bump(h1c, `straddle ${T}`);
        for (const X of H1_EXITS) if (c.firstFrom(hhmmToMin(X), EXIT_WAIT) && p.firstFrom(hhmmToMin(X), EXIT_WAIT)) bump(h1c, `exit ${T}→${X}`);
        if (s.vixPrev === null) continue;
        for (const w of H1_WINGS) {
          const em = remainingSessionEm(level!, s.vixPrev, m);
          const kc = strikeBeyond(chain.strikes.CE, k, k + w * em, "above");
          const kp = strikeBeyond(chain.strikes.PE, k, k - w * em, "below");
          if (kc === null || kp === null) continue;
          bump(h1c, `wings ${w}EM ${T} listed`);
          const t = syncMinute([c, p, chain.series.get(key(kc, "CE"))!, chain.series.get(key(kp, "PE"))!], m, ENTRY_WAIT);
          if (t !== null) bump(h1c, `fly ${w}EM ${T}`);
          h1c.set(`wing distance ${w}EM ${T}`, (h1c.get(`wing distance ${w}EM ${T}`) ?? 0) + (kc - k + (k - kp)) / 2);
        }
      }
    }
    const n1 = Math.max(1, h1.days.length);
    const r1: (string | number)[][] = [["order", "ATM call and put both have a bar within 2 min", "both have a bar in the exit window (15:00 / 15:20, 5 min)", "fly 1 EM: all four legs in one minute within 2 min (median wing distance)", "fly 2 EM: same"]];
    for (const T of H1_ENTRIES) {
      const wd = (w: number) => fx((h1c.get(`wing distance ${w}EM ${T}`) ?? 0) / Math.max(1, h1c.get(`wings ${w}EM ${T} listed`) ?? 0), 0);
      r1.push([T, pct((h1c.get(`straddle ${T}`) ?? 0) / n1), `${pct((h1c.get(`exit ${T}→15:00`) ?? 0) / n1)} / ${pct((h1c.get(`exit ${T}→15:20`) ?? 0) / n1)}`, `${pct((h1c.get(`fly 1EM ${T}`) ?? 0) / n1)} (mean ${wd(1)} pts)`, `${pct((h1c.get(`fly 2EM ${T}`) ?? 0) / n1)} (mean ${wd(2)} pts)`]);
    }
    out.push(`\n### ${def.id} H1 coverage (${h1.days.length} expiry days)\n\n${md(r1)}\n`);
    // H2: four legs in one minute at the entries; exit bars the same day and on the expiry day.
    const h2c = new Map<string, number>();
    let cacheE: Sess | null = null;
    for (const d of h2.days) {
      const s = buildSess(data, x, ctx, d);
      const a = s.expA!;
      const n = s.expN!;
      const ca = s.chain(a)!;
      const cn = s.chain(n)!;
      if (!cacheE || cacheE.day !== a) cacheE = ctx.daySet.has(a) ? buildSess(data, x, ctx, a) : null;
      if (!cacheE) bump(h2c, "expiry session not valid");
      for (const T of H2_ENTRIES) {
        const m = hhmmToMin(T);
        const level = levelAt(s, m);
        const far = new Set(bothListed(cn));
        const k = level === null ? null : nearestListed(bothListed(ca).filter((z) => far.has(z)), level);
        if (k === null) continue;
        const ser = [ca.series.get(key(k, "CE"))!, ca.series.get(key(k, "PE"))!, cn.series.get(key(k, "CE"))!, cn.series.get(key(k, "PE"))!];
        if (syncMinute(ser, m, ENTRY_WAIT) !== null) bump(h2c, `sync ${T}`);
        if (ser.every((z) => z.firstFrom(hhmmToMin(H2_EXIT), EXIT_WAIT))) bump(h2c, `exit same day ${T}`);
        if (cacheE) {
          const ea = cacheE.chain(a);
          const en = cacheE.chain(n);
          const ex = [ea?.series.get(key(k, "CE")), ea?.series.get(key(k, "PE")), en?.series.get(key(k, "CE")), en?.series.get(key(k, "PE"))];
          if (ex.every((z) => z?.firstFrom(hhmmToMin(H2_EXIT), EXIT_WAIT))) bump(h2c, `exit expiry ${T}`);
          const none = (z: MinuteSeries | undefined) => !z?.lastUpTo(hhmmToMin(H2_EXIT) + EXIT_WAIT);
          if (none(ex[0]) || none(ex[1])) bump(h2c, `A leg without a bar ${T}`);
          if (none(ex[2]) || none(ex[3])) bump(h2c, `N leg without a bar ${T}`);
        }
      }
    }
    const n2 = Math.max(1, h2.days.length);
    const r2: (string | number)[][] = [["order", "all four legs (A and N call and put) in one minute within 2 min", "all four have a bar at 15:20–15:25 the same day", "all four have a bar at 15:20–15:25 on A's expiry day", "an A leg with no bar at all on its expiry day by 15:25 (exits at intrinsic)", "an N leg with no bar at all that day by 15:25 (no exit price)"]];
    for (const T of H2_ENTRIES) r2.push([T, pct((h2c.get(`sync ${T}`) ?? 0) / n2), pct((h2c.get(`exit same day ${T}`) ?? 0) / n2), pct((h2c.get(`exit expiry ${T}`) ?? 0) / n2), h2c.get(`A leg without a bar ${T}`) ?? 0, h2c.get(`N leg without a bar ${T}`) ?? 0]);
    out.push(`\n### ${def.id} H2 coverage (${h2.days.length} sessions; expiry session not valid on ${h2c.get("expiry session not valid") ?? 0})\n\n${md(r2)}\n`);
    // H3: per event, the contract and bar presence.
    const r3: (string | number)[][] = [["event day", "kind", "session before", "contract", "status", "ATM legs at 15:20 (2 min)", "exit bars at 09:30 / 15:20 on the day (5 min)"]];
    for (const ev of h3) {
      let entry = "–";
      let exits = "–";
      if (ev.status === "ok") {
        const pre = buildSess(data, x, ctx, ev.pre!);
        const day = buildSess(data, x, ctx, ev.date);
        const cp = pre.chain(ev.expiry!)!;
        const cv = day.chain(ev.expiry!)!;
        const level = levelAt(pre, hhmmToMin(H3_ENTRY));
        const k = level === null ? null : nearestListed(bothListed(cp), level);
        if (k !== null) {
          const c = cp.series.get(key(k, "CE"))!;
          const p = cp.series.get(key(k, "PE"))!;
          entry = c.firstFrom(hhmmToMin(H3_ENTRY), ENTRY_WAIT) && p.firstFrom(hhmmToMin(H3_ENTRY), ENTRY_WAIT) ? "yes" : "no";
          const xc = cv.series.get(key(k, "CE"));
          const xp = cv.series.get(key(k, "PE"));
          exits = H3_EXITS.map((X) => (xc?.firstFrom(hhmmToMin(X), EXIT_WAIT) && xp?.firstFrom(hhmmToMin(X), EXIT_WAIT) ? "yes" : "no")).join(" / ");
        }
      }
      r3.push([ev.date, ev.kind, ev.pre ?? "–", ev.expiry ?? "–", ev.status, entry, exits]);
    }
    out.push(`\n### ${def.id} H3 events\n\n${md(r3)}\n`);
    summary[def.id] = { sessions: ctx.days.length, h1: { n: h1.days.length, cut: h1.cut, drops: h1.drops }, h2: { n: h2.days.length, cut: h2.cut, drops: h2.drops }, h3: h3.map((e) => ({ ...e })) };
    console.log(out.slice(-4).join("\n"));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "coverage.md"), out.join("\n"));
  writeFileSync(resolve(outDir, "coverage.json"), JSON.stringify(summary, null, 1));
  console.log(`Wrote ${resolve(outDir, "coverage.md")}`);
}

// ---------------------------------------------------------------------------
// run: every variant, the walk-forward picks, the bar, the ledger and the tables
// ---------------------------------------------------------------------------

async function runAll(args: ReturnType<typeof parseArgs>): Promise<void> {
  const x = str(args, "x") ?? fail("--x <extract dir> is required");
  const dir = str(args, "dir") ?? fail("--dir <bhavcopy cache> is required");
  const outDir = resolve(ROOT, str(args, "out", "reports/wp13")!);
  const t0 = Date.now();
  const log = (s: string) => console.log(`${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const manifest = loadManifest(x);
  const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir });
  log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE bhavcopies`);
  const ctxs = new Map<IndexId, IndexCtx>();
  const elig = new Map<IndexId, { h1: Eligible; h2: Eligible; h3: EventSlot[] }>();
  const runs: Run[] = [];
  for (const def of RESEARCH_INDICES) {
    const ctx = indexCtx(data, x, manifest[def.id], def);
    ctxs.set(def.id, ctx);
    const el = { h1: h1Eligible(data, ctx), h2: h2Eligible(data, ctx), h3: h3Events(data, ctx) };
    elig.set(def.id, el);
    const mine = strategyRuns(def.id);
    evaluate(data, x, ctx, el, mine, log);
    runs.push(...mine);
    log(`${def.id}: H1 cut after ${el.h1.cut} (${el.h1.days.length} days), H2 cut after ${el.h2.cut} (${el.h2.days.length} days), H3 ${el.h3.filter((e) => e.status === "ok").length} events`);
  }
  const cutOf = (r: Run) => (r.spec.kind === "H1" ? elig.get(r.index)!.h1.cut : r.spec.kind === "H2" ? elig.get(r.index)!.h2.cut : null);
  const stats = new Map<string, Stats>();
  for (const r of runs) stats.set(r.name, statsOf(r, cutOf(r)));
  log(`Statistics of ${runs.length} strategy variants`);

  // Walk-forward picks: per family, index and fill, the best mean on the first 60%.
  const picks: Run[] = [];
  for (const sym of ctxs.keys())
    for (const fam of ["H1a", "H1b", "H2"] as Family[])
      for (const mode of MODES) {
        const pool = runs.filter((r) => r.index === sym && r.family === fam && r.mode === mode);
        const p = pickBest(pool, (r) => stats.get(r.name)!.is.mean, (r) => r.name);
        if (p) picks.push(p);
      }

  // ±20% perturbations of the picks that pass the out-of-sample CI and PF (a second pass over the data).
  const pertRuns: Run[] = [];
  for (const p of picks) if (passesCore(stats.get(p.name)!)) pertRuns.push(...perturbationsOf(p));
  if (pertRuns.length) {
    log(`Perturbing ${new Set(pertRuns.map((r) => r.base)).size} pick(s): ${pertRuns.length} runs`);
    for (const [sym, ctx] of ctxs) evaluate(data, x, ctx, elig.get(sym)!, pertRuns.filter((r) => r.index === sym), log);
  }
  const pertStats = new Map<string, Stats>(pertRuns.map((r) => [r.name, statsOf(r, cutOf(r), true)]));

  // Ledger: one line per strategy variant and perturbation not logged yet; N and V[SR] after the append.
  const lines = [...runs.map((r) => trialOf(r, stats.get(r.name)!)), ...pertRuns.map((r) => trialOf(r, pertStats.get(r.name)!))];
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === "WP13").map((r) => r.variant));
  const fresh = lines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVar = sharpeVariance(lines.filter((l) => (l.params as { hypothesis?: string }).hypothesis !== "H3")).variance;
  log(`Ledger: ${ledgerBefore} lines before, ${fresh.length} new (${args.ledger === true ? "appended" : "NOT appended: no --ledger"}), N = ${ledgerN}; V[SR] of this study's H1/H2 lines ${srVar?.toExponential(2)}`);

  const judged = picks.map((p) => {
    const perts = passesCore(stats.get(p.name)!)
      ? pertRuns.filter((z) => z.base === p.name).map((z) => ({ name: z.name, oosNet: pertStats.get(z.name)!.oos.net, oosN: pertStats.get(z.name)!.oos.n, fullNet: pertStats.get(z.name)!.full.net }))
      : null;
    return judge(p, stats.get(p.name)!, perts, ledgerN, srVar);
  });

  // ---- tables ----
  const S: string[] = [`# WP13 tables (generated)\n\nLedger: ${ledgerBefore} → ${ledgerN} lines (${fresh.length} new); Bonferroni 0.05/${ledgerN} = ${(0.05 / ledgerN).toExponential(2)}; V[SR] of this study's H1/H2 strategy and perturbation lines ${srVar?.toExponential(2)}.\n`];
  const vh = ["family", "index", "fill", "picked on the first 60%", "first 60% ₹/trade (n)", "last 40% trades", "last 40% ₹/trade (95% CI)", "last 40% PF", "last 40% per session (CI)", "last 40% to Dec 2024 / from 2025", "worst day", "verdict"];
  const vrows: (string | number)[][] = [vh];
  for (const j of judged) {
    const s = j.stats;
    vrows.push([j.run.family, j.run.index, j.run.mode, j.run.name.replace(`${j.run.index} `, "").replace(` ${j.run.mode}`, ""), `${rs(s.is.mean)} (${s.is.n})`, s.oos.n, `${rs(s.oos.mean)} (${rs(s.oos.lo)} … ${rs(s.oos.hi)})`, fx(s.oos.pf), `${rs(s.oos.boot.perSession.estimate)} (${rs(s.oos.sessLo)} … ${rs(s.oos.sessHi)})`, `${rs(s.oosEra1.mean)} (${s.oosEra1.n}) / ${rs(s.oosEra2.mean)} (${s.oosEra2.n})`, `${rs(s.tail.worstDay)} (${s.tail.worstDayDate})`, j.verdict]);
  }
  S.push(`\n## Verdicts: the walk-forward pick of each family, index and fill\n\n${md(vrows)}\n`);
  for (const j of judged) {
    const s = j.stats;
    S.push(`\n### ${j.run.name}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((c) => [c.name, c.verdict, c.detail])])}\n\n${md([["sample", "trades", "₹/trade", "95% CI", "PF", "hit", "net ₹"], ...[s.full, s.is, s.oos, s.era1, s.era2, s.oosEra1, s.oosEra2].map(subRow)])}\n\nBy year:\n\n${yearTable(s)}\n`);
    if (j.perts) S.push(`Perturbations (last 40% net ₹ / trades; all days net ₹): ${j.perts.map((p) => `${p.name.replace(`${j.run.name} `, "")} ${rs(p.oosNet)} / ${p.oosN}; ${rs(p.fullNet)}`).join(" · ")}\n`);
  }
  for (const sym of ctxs.keys()) {
    const el = elig.get(sym)!;
    S.push(`\n## ${sym}\n\nH1 cut after ${el.h1.cut}; H2 cut after ${el.h2.cut}.\n`);
    for (const fam of ["H1a", "H1b", "H2", "H3"] as Family[]) {
      const fr = runs.filter((r) => r.index === sym && r.family === fam);
      S.push(`\n### ${sym} ${fam}: ${fr.length} variants\n\n${md([VHEAD, ...fr.map((r) => vrow(r, stats.get(r.name)!, `${sym} `))])}\n`);
      S.push(`\n#### ${sym} ${fam}: tails (one lot; ₹5 lakh account)\n\n${md([THEAD, ...fr.map((r) => trow(r, stats.get(r.name)!, `${sym} `))])}\n`);
      if (fam === "H2") {
        const g = (r: Run) => r.trades.filter((t) => t.greeks).map((t) => t.greeks!);
        const grow: (string | number)[][] = [["variant", "trades", "DTE 1 ₹/trade (n)", "DTE 2 ₹/trade (n)", "net gamma ₹ for a 1% move (median)", "net vega ₹ per vol point (median)", "net theta ₹ per session (median)"]];
        for (const r of fr) {
          const s = stats.get(r.name)!;
          const gs = g(r);
          const dd = (d: number) => s.dte.find((z) => z.dte === d);
          grow.push([r.name.replace(`${sym} `, ""), s.full.n, `${rs(dd(1)?.mean ?? NaN)} (${dd(1)?.n ?? 0})`, `${rs(dd(2)?.mean ?? NaN)} (${dd(2)?.n ?? 0})`, gs.length ? rs(median(gs.map((z) => z.gamma1pct))) : "–", gs.length ? rs(median(gs.map((z) => z.vega1))) : "–", gs.length ? rs(median(gs.map((z) => z.theta))) : "–"]);
        }
        S.push(`\n#### ${sym} H2: by sessions to expiry, and the calendar's greeks at entry (Black-76 on the bar closes)\n\n${md(grow)}\n`);
      }
    }
    // Worst days of the picks and of the most exposed naked straddle, and the largest late moves.
    const ref = runs.filter((r) => r.index === sym && r.family === "H1a" && r.spec.kind === "H1" && r.spec.entry === hhmmToMin("13:30") && r.spec.exit === hhmmToMin("15:20") && r.spec.stop === null);
    for (const r of new Set([...ref, ...judged.filter((j) => j.run.index === sym).map((j) => j.run)])) S.push(`\n#### ${r.name}: the 10 worst ${r.spec.kind === "H2" && (r.spec as H2Spec).hold ? "expiry weeks" : "days"}\n\n${worstList(r, 10)}\n`);
    for (const r of ref) S.push(`\n#### ${r.name}: the 10 largest index moves between entry and exit\n\n${lateMoves(r, 10)}\n`);
    // H3: every event.
    const h3 = runs.filter((r) => r.index === sym && r.family === "H3");
    const evRows: (string | number)[][] = [["event day", "kind", "session before", "contract (DTE on the day)", "strike", "premium ₹/lot (mid)", ...h3.map((r) => r.name.replace(`${sym} H3 event straddle 15:20→event day `, "")), "index 15:20 before → 09:30 / 15:20 on the day"]];
    for (const ev of el.h3) {
      const ts = h3.map((r) => r.trades.find((t) => t.exitDay === ev.date));
      const mid = h3.find((r) => r.mode === "mid" && r.spec.exit === hhmmToMin("15:20"))?.trades.find((t) => t.exitDay === ev.date);
      const mid930 = h3.find((r) => r.mode === "mid" && r.spec.exit === hhmmToMin("09:30"))?.trades.find((t) => t.exitDay === ev.date);
      evRows.push([ev.date, ev.kind, ev.pre ?? "–", ev.status === "ok" ? `${ev.expiry} (${mid?.dte ?? "–"})` : ev.status, mid?.k ?? "–", mid ? rs(mid.premium) : "–", ...ts.map((t) => (t ? rs(t.net) : "–")), mid ? `${fx(mid.level, 1)} → ${mid930 ? pct(mid930.move, 2) : "–"} / ${pct(mid.move, 2)}` : "–"]);
    }
    S.push(`\n### ${sym} H3: every event\n\n${md(evRows)}\n`);
    const kinds: (EventKind | "all")[] = ["all", "budget", "rbi", "election"];
    const kr: (string | number)[][] = [["variant", ...kinds.map((k) => `${k}: n, ₹/trade, hit`)]];
    for (const r of h3) kr.push([r.name.replace(`${sym} `, ""), ...kinds.map((k) => {
      const ts = r.trades.filter((t) => k === "all" || el.h3.find((e) => e.date === t.exitDay)?.kind === k);
      return ts.length ? `${ts.length}, ${rs(avg(ts.map((t) => t.net)))}, ${pct(ts.filter((t) => t.net > 0).length / ts.length, 0)}` : "–";
    })]);
    S.push(`\n${md(kr)}\n`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "tables.md"), S.join("\n"));
  const summary = {
    ledgerBefore,
    ledgerN,
    srVar,
    cuts: Object.fromEntries([...elig].map(([k, v]) => [k, { h1: v.h1.cut, h2: v.h2.cut }])),
    variants: runs.map((r) => ({ name: r.name, family: r.family, index: r.index, mode: r.mode, params: r.params, skips: r.skips, ...pick(stats.get(r.name)!) })),
    judged: judged.map((j) => ({ name: j.run.name, family: j.run.family, index: j.run.index, mode: j.run.mode, verdict: j.verdict, p: j.p, dsr: j.dsr, dsrNull: j.dsrNull, criteria: j.criteria, perts: j.perts, ...pick(j.stats), worst10: worstBlocks(j.run.trades, 10) })),
    perturbations: pertRuns.map((r) => ({ name: r.name, base: r.base, ...pick(pertStats.get(r.name)!) })),
    h3: [...elig].map(([sym, v]) => ({ sym, events: v.h3, trades: runs.filter((r) => r.index === sym && r.family === "H3").map((r) => ({ name: r.name, trades: r.trades })) })),
  };
  writeFileSync(resolve(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  log(`Wrote ${resolve(outDir, "tables.md")}; verdicts: ${judged.map((j) => `${j.run.index} ${j.run.family} ${j.run.mode} ${j.verdict}`).join("; ")}`);
}

/** The compact statistics kept in summary.json. */
function pick(s: Stats) {
  const sub = (z: Sub) => ({ label: z.label, n: z.n, blocks: z.blocks, mean: z.mean, lo: z.lo, hi: z.hi, sessLo: z.sessLo, sessHi: z.sessHi, pf: z.pf, hit: z.hit, net: z.net, p: Math.max(z.boot.perTrade.p, z.boot.perSession.p) });
  return { full: sub(s.full), is: sub(s.is), oos: sub(s.oos), era1: sub(s.era1), era2: sub(s.era2), oosEra1: sub(s.oosEra1), oosEra2: sub(s.oosEra2), years: s.years, dte: s.dte, meanPct: s.meanPct, sr: s.sr, tail: s.tail, charges: s.charges, premium: s.premium, debit: s.debit };
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
    // One session by hand: the inputs and every H1 / H2 fill, to check against the raw bars.
    const x = str(args, "x") ?? fail("--x <extract dir> is required");
    const sym = (str(args, "index") ?? "NIFTY") as IndexId;
    const day = str(args, "day") ?? fail("--day YYYY-MM-DD is required");
    const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir: str(args, "dir") ?? fail("--dir is required") });
    const ctx = indexCtx(data, x, loadManifest(x)[sym], RESEARCH_INDICES.find((i) => i.id === sym)!);
    const s = buildSess(data, x, ctx, day);
    console.log(`${sym} ${day}: open ${s.open}, VIX ${s.vixPrev}, A ${s.expA} (DTE ${s.dteA}, lot ${s.expA ? s.lot(s.expA) : "–"}), N ${s.expN} (lot ${s.expN ? s.lot(s.expN) : "–"})`);
    const show = (o: Outcome) => ("skip" in o ? `skip: ${o.skip}` : `k ${o.trade.k} lot ${o.trade.lot} net ${fx(o.trade.net)} gross ${fx(o.trade.gross)} charges ${fx(o.trade.charges)} premium ${fx(o.trade.premium)} debit ${fx(o.trade.debit)} ${minToHhmm(o.trade.entryMin)}→${o.trade.exitDay} ${minToHhmm(o.trade.exitMin)} ${o.trade.reason}`);
    if (s.dteA === 0)
      for (const mode of MODES)
        for (const wings of [0, 1, 2]) console.log(`  H1 wings ${wings} 14:00→15:20 no stop ${mode}: ${show(evalH1(s, { kind: "H1", entry: 840, exit: 920, stop: null, wings, mode }))}`);
    if (s.dteA === 1 || s.dteA === 2) {
      const sE = ctx.daySet.has(s.expA!) ? buildSess(data, x, ctx, s.expA!) : null;
      for (const mode of MODES) for (const hold of [false, true]) console.log(`  H2 09:30 hold ${hold} ${mode}: ${show(evalH2(data, s, sE, { kind: "H2", entry: 570, exit: 920, hold, mode }))}`);
    }
    for (const e of [s.expA, s.expN]) {
      if (!e) continue;
      const chain = s.chain(e);
      const lv = levelAt(s, 840);
      const k = chain && lv !== null ? nearestListed(bothListed(chain), lv) : null;
      if (!chain || k === null) continue;
      for (const t of ["CE", "PE"] as const) {
        const ser = chain.series.get(key(k, t))!;
        for (const m of [570, 571, 840, 841, 900, 920]) {
          const b = ser.at(m);
          console.log(`  ${e} ${k}${t} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
        }
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
