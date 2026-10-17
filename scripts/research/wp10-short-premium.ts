/**
 * WP10: the seller's side of NIFTY and SENSEX weekly options on real exchange prices
 * (reports/wp10-short-premium.md; every definition is frozen in its §1, committed before any P&L was
 * computed). Research only: nothing here changes the engine.
 *
 *   npx tsx scripts/research/wp10-short-premium.ts --dir <bhavcopy cache> [--out reports/wp10] [--bootstrap 100000] [--ledger]
 *
 *   --dir        the compact bhavcopy cache written by scripts/fetch-bhavcopy.ts (with index-daily.json)
 *   --out        where the markdown tables and summary.json go (reports/ is gitignored; raw data never written)
 *   --bootstrap  day-block resamples for the headline and candidate variants (breakdown cells use 10,000)
 *   --ledger     append one line per variant not yet in reports/trials.jsonl (a rerun of a logged variant is
 *                not a new trial, so reruns are idempotent; N for Bonferroni and the DSR counts the same way)
 *
 * Per index (NIFTY on NSE 2019-02 .. 2026-10, SENSEX on BSE 2023-05 .. 2026-10):
 *   Q1  intraday short ATM straddle, open -> close (or settlement on the contract's expiry day),
 *       convention A (current weekly, 0DTE on expiry day) and B (never the expiring contract);
 *   Q2  the same with long wings at 1 and 2 daily expected moves (iron fly), only on days whose opening
 *       prints pass the synchronicity screen S1-S4;
 *   Q3  short strangle at 1 expected move to expiry, entered at the close N = 1, 2, 4 sessions before each
 *       weekly expiry and held to settlement, plus the defined-risk iron condor (wings at 2 EM_N);
 *   measurement checks (entry at the day's VWAP, close -> close, 2x spread, ATM-synchronous days) and the
 *   pre-registered candidates C1-C3 with their robustness sets, judged against the plan's §12 bar.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, type BlockBootstrap, type SessionPnl } from "../../src/engine/backtest/metrics";
import { nearestStrike, parityForward, type BhavRow } from "../../src/engine/backtest/realPrices";
import {
  black76Iv,
  black76StraddleIv,
  dteBucket,
  engineSpread,
  eventOn,
  expectedMove,
  flyNoArbitrage,
  gapBucket,
  intrinsic,
  maxDrawdown,
  modeLot,
  scaledSpread,
  strikeBeyond,
  structurePnl,
  tailShare,
  tercile,
  withinFactor,
  worstRun,
  type EventKind,
  type LegSpec,
  type SpreadFn,
} from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { percentileRank } from "../../src/engine/util/math";
import { ROOT, fail, num, parseArgs, str } from "../lib/node";
import { badPrint, loadResearchData, md, RESEARCH_INDICES, spotClose, spotOpen, tYears, type ResearchData, type ResearchIndex } from "./real_prices";

type IndexId = ResearchIndex["id"];
type OptType = "CE" | "PE";

export const CAPITAL = 500_000;
const WING_MIN_CONTRACTS = 500;
const IV_FACTOR = 2;
const ATM_SYNC_MAX = 0.005;

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

interface Ctx {
  idx: ResearchIndex;
  date: string;
  /** Previous regular session (special sessions skipped). */
  prev: string | null;
  next: string | null;
  sOpen: number | null;
  sClose: number | null;
  sPrevClose: number | null;
  /** Last India VIX close before the session, and its point-in-time percentile rank among the 252 closes before it. */
  vixPrev: number | null;
  vixRank: number | null;
  event: EventKind | null;
  /** The next regular session is a scheduled event. */
  eve: EventKind | null;
}

interface Vix {
  dates: string[];
  closes: number[];
}

function vixSeries(data: ResearchData): Vix {
  const m = data.daily.get("^INDIAVIX");
  const rows = [...(m ?? new Map())].filter(([, c]) => c.c > 0).sort(([a], [b]) => a.localeCompare(b));
  return { dates: rows.map(([d]) => d), closes: rows.map(([, c]) => c.c) };
}

/** Index of the last VIX close strictly before `date` (or on it when `inclusive`); -1 when none. */
function vixIndex(v: Vix, date: string, inclusive: boolean): number {
  let lo = 0;
  let hi = v.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? v.dates[mid] <= date : v.dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function vixClose(v: Vix, date: string, inclusive: boolean): number | null {
  const i = vixIndex(v, date, inclusive);
  return i >= 0 ? v.closes[i] : null;
}

function vixRank(v: Vix, date: string): number | null {
  const i = vixIndex(v, date, false);
  if (i < 60) return null;
  return percentileRank(v.closes.slice(Math.max(0, i - 252), i), v.closes[i]);
}

function regularSessions(data: ResearchData, idx: ResearchIndex): string[] {
  return data.book.dates(idx.id).filter((d) => !data.special.has(d));
}

function contexts(data: ResearchData, idx: ResearchIndex, vix: Vix): Map<string, Ctx> {
  const ds = regularSessions(data, idx);
  const out = new Map<string, Ctx>();
  ds.forEach((date, i) => {
    const prev = i > 0 ? ds[i - 1] : null;
    const next = i + 1 < ds.length ? ds[i + 1] : null;
    out.set(date, {
      idx,
      date,
      prev,
      next,
      sOpen: spotOpen(data, idx, date),
      sClose: spotClose(data, idx, date),
      sPrevClose: prev ? spotClose(data, idx, prev) : null,
      vixPrev: vixClose(vix, date, false),
      vixRank: vixRank(vix, date),
      event: eventOn(date),
      eve: next ? eventOn(next) : null,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface Trade {
  index: IndexId;
  /** Session the trade belongs to: the day for day trades, the expiry for hold-to-expiry trades. */
  session: string;
  entryDate: string;
  exitDate: string;
  expiry: string;
  dte: number;
  lot: number;
  strikes: string;
  premium: number;
  gross: number;
  spread: number;
  charges: number;
  net: number;
  pct: number;
  /** Index move over the holding period (fraction). */
  move: number;
  gap: number | null;
  vixPrev: number | null;
  vixTercile: 0 | 1 | 2 | null;
  event: EventKind | null;
  eve: EventKind | null;
  /** Defined-risk structures: the largest possible loss per lot at entry (wider width − credit, plus entry costs). */
  maxLoss: number | null;
  /** Day trades at the open (diagnostics only): ATM parity forward of the opening prints ÷ (index open + previous basis) − 1. */
  atmDev: number | null;
  /** Day trades (diagnostics only): ATM straddle at the opening prints ÷ the same straddle at the day's VWAPs − 1. */
  openRich: number | null;
  /** Hold-to-expiry trades: the worst mark-to-market (₹ per lot, before costs) at a close between entry and settlement. */
  worstMtm: number | null;
}

function lotOf(data: ResearchData, sym: string, date: string, expiry: string): number | null {
  return modeLot(data.book.rows(sym, date).filter((r) => r.kind === "OPT" && r.expiry === expiry).map((r) => r.lot));
}

/**
 * Final settlement level of an expiry: the median settle printed on the expiring options that day.
 * NSE's legacy files of Feb 2019 - Jan 2020 print 0 there; the final settlement price of an index
 * option is by rule the index's official close on expiry day (the two agree within 0.2% on every
 * other expiry), so the official close is used for those days.
 */
const settleCache = new Map<string, number | null>();
export const settleFallbacks: string[] = [];
function settlementLevel(data: ResearchData, idx: ResearchIndex, expiry: string): number | null {
  const sym = idx.id;
  const key = `${sym}|${expiry}`;
  if (settleCache.has(key)) return settleCache.get(key)!;
  const xs = data.book
    .rows(sym, expiry)
    .filter((r) => r.kind === "OPT" && r.expiry === expiry && r.settle !== null && r.settle > 0.5 * r.strike)
    .map((r) => r.settle!)
    .sort((a, b) => a - b);
  let v = xs.length ? xs[Math.floor((xs.length - 1) / 2)] : null;
  if (v === null && data.book.rows(sym, expiry).length > 0) {
    v = spotClose(data, idx, expiry);
    if (v !== null) settleFallbacks.push(`${sym} ${expiry}`);
  }
  settleCache.set(key, v);
  return v;
}

/** Sessions after `date` up to and including `expiry`, on NSE's session calendar (BSE's archive misses five days). */
function dteOf(data: ResearchData, date: string, expiry: string): number {
  return data.book.sessionsToExpiry("NIFTY", date, expiry);
}

const traded = (r: BhavRow | undefined): r is BhavRow => !!r && r.contracts > 0;

type Conv = "A" | "B";
type EntryMode = "open" | "vwap" | "prevclose";

export interface DaySpec {
  name: string;
  structure: "straddle" | "fly";
  conv: Conv;
  /** Wing distance in daily expected moves (fly only). */
  wingM: number;
  entry: EntryMode;
  spread: SpreadFn;
  /** full = S1-S4; s1s3 = S1 and S3 only; none = S1 on the ATM legs only. */
  screen: "full" | "s1s3" | "none";
  /** Keep only days whose ATM opening prints imply a forward within 0.5% of the index open plus the previous basis. */
  atmSync: boolean;
  skipEvents: boolean;
}

export interface DayResult {
  trades: Trade[];
  /** Sessions where the rule could have traded (regular sessions with the inputs it needs at entry). */
  sessions: string[];
  drops: Map<string, string[]>;
  /** Straddle-free diagnostics by date: the ATM parity deviation at the open. */
  atmDev: Map<string, number>;
}

function chooseExpiry(data: ResearchData, sym: string, date: string, conv: Conv): string | undefined {
  const ex = data.book.expiries(sym, date);
  return conv === "A" ? ex[0] : ex.find((e) => e > date);
}

/** Exit value of a leg on `date`: intrinsic at final settlement on its expiry day, else its close. */
function exitValue(data: ResearchData, idx: ResearchIndex, row: BhavRow | undefined, type: OptType, strike: number, expiry: string, date: string): number | null {
  if (expiry === date) {
    const s = settlementLevel(data, idx, expiry);
    return s === null ? null : intrinsic(type, strike, s);
  }
  // A close is a price only when the contract traded that day (otherwise NSE prints a theoretical one).
  if (!traded(row) || row.close === null || !(row.close >= 0)) return null;
  return row.close;
}

function buildDay(data: ResearchData, ctxs: Map<string, Ctx>, spec: DaySpec): DayResult {
  const out: DayResult = { trades: [], sessions: [], drops: new Map(), atmDev: new Map() };
  const drop = (reason: string, date: string) => {
    const l = out.drops.get(reason);
    if (l) l.push(date);
    else out.drops.set(reason, [date]);
  };
  const r = data.cfg.pricing.r;
  for (const ctx of ctxs.values()) {
    const { idx, date } = ctx;
    const sym = idx.id;
    const book = data.book;
    // Entry session and reference level.
    const prevClose = spec.entry === "prevclose";
    const entryDate = prevClose ? ctx.prev : date;
    if (!entryDate) continue;
    const ref = prevClose ? null : ctx.sOpen;
    if (!prevClose && !ref) continue;
    const expiry = chooseExpiry(data, sym, entryDate, prevClose ? "B" : spec.conv);
    if (!expiry) continue;
    out.sessions.push(date);
    const settledToday = expiry === date;
    const strikes = book.strikes(sym, entryDate, expiry);
    let level = ref ?? 0;
    if (prevClose) {
      const fwd = parityForward(book, sym, entryDate, expiry, "close", { r, tYears: tYears(data, entryDate, "15:15", expiry) });
      level = fwd?.forward ?? ctx.sPrevClose ?? 0;
      if (!(level > 0)) {
        drop("no reference level", date);
        continue;
      }
    }
    const k = nearestStrike(strikes, level);
    if (k === null) {
      drop("no strikes", date);
      continue;
    }
    const gap = ctx.sOpen && ctx.sPrevClose ? ctx.sOpen / ctx.sPrevClose - 1 : null;
    const row = (d: string, strike: number, type: OptType) => book.option(sym, d, expiry, strike, type);
    const entryOf = (x: BhavRow | undefined): number | null => {
      if (!traded(x)) return null;
      const v = spec.entry === "open" ? x.open : spec.entry === "vwap" ? x.vwap : x.close;
      return v !== null && v > 0 ? v : null;
    };
    // ATM legs.
    const c = row(entryDate, k, "CE");
    const p = row(entryDate, k, "PE");
    const cIn = entryOf(c);
    const pIn = entryOf(p);
    const cOut = exitValue(data, idx, row(date, k, "CE"), "CE", k, expiry, date);
    const pOut = exitValue(data, idx, row(date, k, "PE"), "PE", k, expiry, date);
    if (spec.entry === "vwap" && (!traded(c) || !traded(p) || !c.open || !p.open)) {
      drop("ATM leg did not trade at the open", date);
      continue;
    }
    if (cIn === null || pIn === null) {
      drop(spec.entry === "vwap" ? "no VWAP" : "ATM leg did not trade", date);
      continue;
    }
    if (cOut === null || pOut === null) {
      drop("no exit price", date);
      continue;
    }
    // Bad opening prints (WP6) against the previous close of the same contract.
    if (!prevClose && ctx.prev) {
      const bad = [c!, p!].some((x) => x.open !== null && badPrint(x.open, row(ctx.prev!, k, x.type!)?.close, gap));
      if (bad) {
        drop("bad print", date);
        continue;
      }
    }
    // ATM synchronicity diagnostic: parity forward of the opening prints vs the index open plus the previous basis.
    if (!prevClose && c?.open && p?.open && ctx.prev && ctx.sOpen && ctx.sPrevClose) {
      const fpc = parityForward(book, sym, ctx.prev, expiry, "close", { r, tYears: tYears(data, ctx.prev, "15:15", expiry) });
      if (fpc) out.atmDev.set(date, (k + c.open - p.open) / (ctx.sOpen + (fpc.forward - ctx.sPrevClose)) - 1);
    }
    if (spec.atmSync) {
      const dev = out.atmDev.get(date);
      if (dev === undefined || Math.abs(dev) > ATM_SYNC_MAX) {
        drop("ATM prints off the index open", date);
        continue;
      }
    }
    const legs: LegSpec[] = [
      { side: "short", entry: cIn, exit: cOut, settled: settledToday },
      { side: "short", entry: pIn, exit: pOut, settled: settledToday },
    ];
    let strikesText = `${k}`;
    let width = 0;
    if (spec.structure === "fly") {
      // The VIX known at entry: the last close before the session (open entry), or the entry session's close.
      const vixE = prevClose ? vixClose(VIX, entryDate, true) : ctx.vixPrev;
      if (!vixE) {
        drop("no VIX", date);
        continue;
      }
      const em = expectedMove(level, vixE);
      const kc = strikeBeyond(strikes, k, k + spec.wingM * em, "above");
      const kp = strikeBeyond(strikes, k, k - spec.wingM * em, "below");
      if (kc === null || kp === null) {
        drop("wing not listed", date);
        continue;
      }
      const wc = row(entryDate, kc, "CE");
      const wp = row(entryDate, kp, "PE");
      const wcIn = entryOf(wc);
      const wpIn = entryOf(wp);
      const wcOut = exitValue(data, idx, row(date, kc, "CE"), "CE", kc, expiry, date);
      const wpOut = exitValue(data, idx, row(date, kp, "PE"), "PE", kp, expiry, date);
      // S1: every leg traded and has an entry and an exit price.
      if (spec.entry === "vwap" && (!wc?.open || !wp?.open)) {
        drop("S1 wing did not trade", date);
        continue;
      }
      if (wcIn === null || wpIn === null || wcOut === null || wpOut === null) {
        drop(spec.entry === "vwap" && traded(wc) && traded(wp) ? "no VWAP" : "S1 wing did not trade", date);
        continue;
      }
      if (!prevClose && ctx.prev) {
        const bad = [wc!, wp!].some((x) => x.open !== null && badPrint(x.open, row(ctx.prev!, x.strike, x.type!)?.close, gap));
        if (bad) {
          drop("bad print", date);
          continue;
        }
      }
      // S2: liquid wings.
      if (spec.screen === "full" && (wc!.contracts < WING_MIN_CONTRACTS || wp!.contracts < WING_MIN_CONTRACTS)) {
        drop("S2 thin wing", date);
        continue;
      }
      // S3: no arbitrage among the four entry prints (opening prints, or closes for close -> close).
      if (spec.screen !== "none") {
        const px = (x: BhavRow) => (prevClose ? x.close! : x.open!);
        const arb = flyNoArbitrage({ k, kc, kp, c: px(c!), p: px(p!), wc: px(wc!), wp: px(wp!) });
        if (arb !== "ok") {
          drop(`S3 no-arbitrage (${arb})`, date);
          continue;
        }
      }
      // S4: each wing's opening IV within a factor of 2 of its previous-close IV moved with the ATM's.
      if (spec.screen === "full" && !prevClose && ctx.prev) {
        const s4 = wingIvCheck(data, sym, ctx.prev, date, expiry, { k, c: c!, p: p! }, [
          { strike: kc, type: "CE", open: wc!.open! },
          { strike: kp, type: "PE", open: wp!.open! },
        ]);
        if (s4 === "fail") {
          drop("S4 wing IV inconsistent with the ATM", date);
          continue;
        }
      }
      legs.push({ side: "long", entry: wcIn, exit: wcOut, settled: settledToday }, { side: "long", entry: wpIn, exit: wpOut, settled: settledToday });
      strikesText = `${kp}/${k}/${kc}`;
      width = Math.max(kc - k, k - kp);
    }
    if (spec.skipEvents && ctx.event) continue; // a no-trade session, not a dropped one
    const lot = lotOf(data, sym, entryDate, expiry) ?? c?.lot ?? 1;
    const pnl = structurePnl(legs, { lot, exchange: idx.exchange, entryDate, exitDate: date, spread: spec.spread });
    const credit = legs.reduce((s, l) => s + (l.side === "short" ? l.entry : -l.entry), 0);
    const entryCosts = pnl.charges / 2 + pnl.spread / 2;
    const sEnd = settledToday ? settlementLevel(data, idx, expiry) ?? ctx.sClose : ctx.sClose;
    const sStart = prevClose ? level : ctx.sOpen;
    out.trades.push({
      index: idx.id,
      session: date,
      entryDate,
      exitDate: date,
      expiry,
      dte: dteOf(data, entryDate, expiry),
      lot,
      strikes: strikesText,
      premium: pnl.premium,
      gross: pnl.gross,
      spread: pnl.spread,
      charges: pnl.charges,
      net: pnl.net,
      pct: pnl.net / pnl.premium,
      move: sEnd && sStart ? sEnd / sStart - 1 : NaN,
      gap: prevClose ? null : gap,
      vixPrev: ctx.vixPrev,
      vixTercile: ctx.vixRank === null ? null : tercile(ctx.vixRank),
      event: ctx.event,
      eve: ctx.eve,
      maxLoss: spec.structure === "fly" ? (width - credit) * lot + entryCosts : null,
      atmDev: out.atmDev.get(date) ?? null,
      openRich: !prevClose && c?.open && p?.open && c.vwap && p.vwap ? (c.open + p.open) / (c.vwap + p.vwap) - 1 : null,
      worstMtm: null,
    });
  }
  return out;
}

let VIX: Vix = { dates: [], closes: [] };

/**
 * S4: for each wing, its opening Black-76 IV (on the ATM opening parity forward) must lie within a
 * factor of 2 of its previous-close IV × (ATM straddle IV at the open ÷ at the previous close).
 * "skip" when a reference is missing (the wing did not trade the previous session, or an IV is not reachable).
 */
function wingIvCheck(
  data: ResearchData,
  sym: string,
  prev: string,
  date: string,
  expiry: string,
  atm: { k: number; c: BhavRow; p: BhavRow },
  wings: { strike: number; type: OptType; open: number }[],
): "ok" | "fail" | "skip" {
  const book = data.book;
  const r = data.cfg.pricing.r;
  const tO = tYears(data, date, "09:15", expiry);
  const tP = tYears(data, prev, "15:15", expiry);
  const fO = atm.k + atm.c.open! - atm.p.open!;
  const ivAtmO = black76StraddleIv(atm.c.open! + atm.p.open!, fO, atm.k, tO);
  const fpc = parityForward(book, sym, prev, expiry, "close", { r, tYears: tP });
  if (!ivAtmO || !fpc) return "skip";
  const kP = nearestStrike(book.strikes(sym, prev, expiry), fpc.forward);
  const cP = kP === null ? undefined : book.option(sym, prev, expiry, kP, "CE");
  const pP = kP === null ? undefined : book.option(sym, prev, expiry, kP, "PE");
  if (kP === null || !cP?.close || !pP?.close) return "skip";
  const ivAtmP = black76StraddleIv(cP.close + pP.close, fpc.forward, kP, tP);
  if (!ivAtmP) return "skip";
  let checked = false;
  for (const w of wings) {
    const wp = book.option(sym, prev, expiry, w.strike, w.type);
    if (!traded(wp) || !wp.close) continue;
    const ivP = black76Iv(wp.close, fpc.forward, w.strike, tP, w.type);
    const ivO = black76Iv(w.open, fO, w.strike, tO, w.type);
    if (!ivP || !ivO) continue;
    checked = true;
    if (!withinFactor(ivO, ivP * (ivAtmO / ivAtmP), IV_FACTOR)) return "fail";
  }
  return checked ? "ok" : "skip";
}

// ---------------------------------------------------------------------------
// Hold to expiry
// ---------------------------------------------------------------------------

export interface HoldSpec {
  name: string;
  n: number;
  shortM: number;
  /** Long wings at this many EM_N (null = naked strangle). */
  wingM: number | null;
  spread: SpreadFn;
  skipEvents: boolean;
}

/** Weekly expiries of an index: the expiries that are the current weekly on some regular session. */
function weeklyExpiries(data: ResearchData, idx: ResearchIndex): string[] {
  const s = new Set<string>();
  for (const d of regularSessions(data, idx)) {
    const e = data.book.expiries(idx.id, d)[0];
    if (e) s.add(e);
  }
  const last = data.book.dates(idx.id).at(-1) ?? "";
  return [...s].filter((e) => e <= last).sort();
}

function buildHold(data: ResearchData, idx: ResearchIndex, ctxs: Map<string, Ctx>, spec: HoldSpec): DayResult {
  const out: DayResult = { trades: [], sessions: [], drops: new Map(), atmDev: new Map() };
  const drop = (reason: string, date: string) => {
    const l = out.drops.get(reason);
    if (l) l.push(date);
    else out.drops.set(reason, [date]);
  };
  const sym = idx.id;
  const book = data.book;
  // N counts regular sessions (special Muhurat/DR sessions are neither entry days nor counted).
  const all = regularSessions(data, idx);
  const r = data.cfg.pricing.r;
  for (const x of weeklyExpiries(data, idx)) {
    const i = all.indexOf(x);
    if (i < 0) continue;
    const e = all[i - spec.n];
    if (!e) continue;
    out.sessions.push(x);
    const s = settlementLevel(data, idx, x);
    if (s === null) {
      drop("no settlement price", x);
      continue;
    }
    const fwd = parityForward(book, sym, e, x, "close", { r, tYears: tYears(data, e, "15:15", x) });
    const level = fwd?.forward ?? spotClose(data, idx, e);
    const vix = vixClose(VIX, e, true);
    if (!level || !vix) {
      drop("no reference level or VIX", x);
      continue;
    }
    const em = expectedMove(level, vix, spec.n);
    const strikes = book.strikes(sym, e, x);
    const katm = nearestStrike(strikes, level);
    if (katm === null) continue;
    const sc = strikeBeyond(strikes, katm, level + spec.shortM * em, "above");
    const sp = strikeBeyond(strikes, katm, level - spec.shortM * em, "below");
    const lc = spec.wingM !== null && sc !== null ? strikeBeyond(strikes, sc, level + spec.wingM * em, "above") : null;
    const lp = spec.wingM !== null && sp !== null ? strikeBeyond(strikes, sp, level - spec.wingM * em, "below") : null;
    if (sc === null || sp === null || (spec.wingM !== null && (lc === null || lp === null))) {
      drop("strike not listed", x);
      continue;
    }
    const want: { strike: number; type: OptType; side: "short" | "long" }[] = [
      { strike: sc, type: "CE", side: "short" },
      { strike: sp, type: "PE", side: "short" },
    ];
    if (lc !== null && lp !== null) want.push({ strike: lc, type: "CE", side: "long" }, { strike: lp, type: "PE", side: "long" });
    const rows = want.map((w) => book.option(sym, e, x, w.strike, w.type));
    if (rows.some((row) => !traded(row) || !(row.close! > 0))) {
      drop("leg not traded on the entry day", x);
      continue;
    }
    const skipped = spec.skipEvents && [...ctxs.keys()].some((d) => d > e && d <= x && eventOn(d) !== null);
    if (skipped) continue;
    const legs: LegSpec[] = want.map((w, j) => ({ side: w.side, entry: rows[j]!.close!, exit: intrinsic(w.type, w.strike, s), settled: true }));
    const lot = lotOf(data, sym, e, x) ?? rows[0]!.lot ?? 1;
    const pnl = structurePnl(legs, { lot, exchange: idx.exchange, entryDate: e, exitDate: x, spread: spec.spread });
    const credit = legs.reduce((acc, l) => acc + (l.side === "short" ? l.entry : -l.entry), 0);
    const width = lc !== null && lp !== null ? Math.max(lc - sc, sp - lp) : null;
    const ctx = ctxs.get(e);
    // Mark-to-market at each close between entry and expiry (every leg must have a close that day).
    let worstMtm: number | null = null;
    for (let j = i - spec.n + 1; j < i; j++) {
      const d = all[j];
      const marks = want.map((w) => book.option(sym, d, x, w.strike, w.type)?.close ?? null);
      if (marks.some((m) => m === null)) continue;
      const mtm = want.reduce((acc, w, k) => acc + (w.side === "short" ? legs[k].entry - marks[k]! : marks[k]! - legs[k].entry), 0) * lot;
      worstMtm = worstMtm === null ? mtm : Math.min(worstMtm, mtm);
    }
    out.trades.push({
      index: idx.id,
      session: x,
      entryDate: e,
      exitDate: x,
      expiry: x,
      dte: spec.n,
      lot,
      strikes: lc !== null ? `${lp}/${sp}/${sc}/${lc}` : `${sp}/${sc}`,
      premium: pnl.premium,
      gross: pnl.gross,
      spread: pnl.spread,
      charges: pnl.charges,
      net: pnl.net,
      pct: pnl.net / pnl.premium,
      move: s / level - 1,
      gap: null,
      vixPrev: vix,
      vixTercile: ctx?.vixRank != null ? tercile(ctx.vixRank) : null,
      event: [...ctxs.keys()].filter((d) => d > e && d <= x).map(eventOn).find((k) => k !== null) ?? null,
      eve: null,
      maxLoss: width !== null ? (width - credit) * lot + pnl.charges + pnl.spread : null,
      atmDev: null,
      openRich: null,
      worstMtm,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface VariantStats {
  n: number;
  sessions: number;
  net: number;
  meanRs: number;
  medianRs: number;
  meanPct: number;
  pctLo: number;
  pctHi: number;
  hit: number;
  pf: number;
  worst: { rs: number; pct: number; date: string; move: number } | null;
  best: { rs: number; date: string } | null;
  run5: { sum: number; from: string; to: string };
  run20: { sum: number; from: string; to: string };
  dd: { depth: number; from: string; to: string };
  tail: { count: number; worstSum: number; total: number; multiple: number };
  boot: BlockBootstrap;
  srSession: number;
  years: { year: string; n: number; net: number; meanRs: number; meanPct: number; lo: number; hi: number; pf: number; worstRs: number; worstDate: string }[];
  chargesPerTrade: number;
  spreadPerTrade: number;
  premiumPerTrade: number;
  maxLossWorst: number | null;
  /** Hold to expiry: the worst interim mark-to-market at a close (₹ per lot) and the trade's expiry. */
  worstMtm: { rs: number; session: string } | null;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const meanOf = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const medianOf = (xs: readonly number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : NaN;
};

function sessionsOf(trades: readonly Trade[], sessions: readonly string[], value: (t: Trade) => number = (t) => t.net): SessionPnl[] {
  const by = new Map<string, number[]>(sessions.map((d) => [d, []]));
  for (const t of trades) {
    const l = by.get(t.session);
    if (l) l.push(value(t));
    else by.set(t.session, [value(t)]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnls]) => ({ day, pnls }));
}

export function variantStats(trades: readonly Trade[], sessions: readonly string[], o: { resamples: number; runs: [number, number] }): VariantStats {
  const ts = [...trades].sort((a, b) => a.session.localeCompare(b.session));
  const nets = ts.map((t) => t.net);
  const ses = sessionsOf(ts, sessions);
  const daily = ses.map((s) => sum(s.pnls));
  const days = ses.map((s) => s.day);
  const boot = dayBlockBootstrap(ses, { resamples: o.resamples, seed: 7 });
  const bootPct = dayBlockBootstrap(sessionsOf(ts, [], (t) => t.pct), { resamples: Math.min(o.resamples, 20_000), seed: 7 });
  const w = ts.reduce<Trade | null>((m, t) => (m === null || t.net < m.net ? t : m), null);
  const b = ts.reduce<Trade | null>((m, t) => (m === null || t.net > m.net ? t : m), null);
  const run = (k: number) => {
    const r = worstRun(daily, k);
    return { sum: r.sum, from: days[r.start] ?? "", to: days[Math.min(days.length - 1, r.start + k - 1)] ?? "" };
  };
  const dd = maxDrawdown(daily);
  const sd = Math.sqrt(daily.reduce((s, x) => s + (x - meanOf(daily)) ** 2, 0) / Math.max(1, daily.length - 1));
  const years = [...new Set(ts.map((t) => t.session.slice(0, 4)))].sort().map((year) => {
    const yt = ts.filter((t) => t.session.startsWith(year));
    const ys = sessionsOf(yt, sessions.filter((d) => d.startsWith(year)));
    const yb = dayBlockBootstrap(ys, { resamples: 10_000, seed: 7 });
    const yw = yt.reduce((m, t) => (t.net < m.net ? t : m), yt[0]);
    return {
      year,
      n: yt.length,
      net: sum(yt.map((t) => t.net)),
      meanRs: meanOf(yt.map((t) => t.net)),
      meanPct: meanOf(yt.map((t) => t.pct)),
      lo: yb.perTrade.lo,
      hi: yb.perTrade.hi,
      pf: profitFactor(yt.map((t) => t.net)),
      worstRs: yw.net,
      worstDate: yw.session,
    };
  });
  const ml = ts.map((t) => t.maxLoss).filter((x): x is number => x !== null);
  return {
    n: ts.length,
    sessions: ses.length,
    net: sum(nets),
    meanRs: meanOf(nets),
    medianRs: medianOf(nets),
    meanPct: meanOf(ts.map((t) => t.pct)),
    pctLo: bootPct.perTrade.lo,
    pctHi: bootPct.perTrade.hi,
    hit: ts.length ? ts.filter((t) => t.net > 0).length / ts.length : NaN,
    pf: profitFactor(nets),
    worst: w ? { rs: w.net, pct: w.pct, date: w.session, move: w.move } : null,
    best: b ? { rs: b.net, date: b.session } : null,
    run5: run(o.runs[0]),
    run20: run(o.runs[1]),
    dd: { depth: dd.depth, from: days[dd.peak] ?? "start", to: days[dd.trough] ?? "" },
    tail: tailShare(nets, 0.05),
    boot,
    srSession: sd > 0 ? meanOf(daily) / sd : 0,
    years,
    chargesPerTrade: meanOf(ts.map((t) => t.charges)),
    spreadPerTrade: meanOf(ts.map((t) => t.spread)),
    premiumPerTrade: meanOf(ts.map((t) => t.premium)),
    maxLossWorst: ml.length ? Math.max(...ml) : null,
    worstMtm: ts.reduce<{ rs: number; session: string } | null>((m, t) => (t.worstMtm !== null && (m === null || t.worstMtm < m.rs) ? { rs: t.worstMtm, session: t.session } : m), null),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const rs = (x: number) => (Number.isFinite(x) ? `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}` : "–");
const pc = (x: number, d = 1) => (Number.isFinite(x) ? `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d)}%` : "–");
const fx = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const pv = (p: number) => (p < 0.001 ? p.toExponential(1) : p.toFixed(3));

function headlineRow(label: string, s: VariantStats): (string | number)[] {
  return [
    label,
    s.n,
    rs(s.meanRs),
    `${rs(s.boot.perTrade.lo)} … ${rs(s.boot.perTrade.hi)}`,
    pc(s.meanPct),
    `${pc(s.pctLo)} … ${pc(s.pctHi)}`,
    pc(s.hit, 0),
    fx(s.pf),
    s.worst ? `${rs(s.worst.rs)} (${pc(s.worst.pct, 0)}) ${s.worst.date}` : "–",
    rs(s.net),
  ];
}
const HEADLINE_HEAD = ["variant", "trades", "₹/lot per trade", "95% CI ₹ (day blocks)", "% of premium", "95% CI %", "hit", "PF", "worst trade (₹, % prem, date)", "net ₹ (sum of lots)"];

function tailRow(label: string, s: VariantStats): (string | number)[] {
  return [
    label,
    s.worst ? `${rs(s.worst.rs)} ${s.worst.date} (index ${pc(s.worst.move, 2)})` : "–",
    `${rs(s.run5.sum)} (${s.run5.from}…${s.run5.to})`,
    `${rs(s.run20.sum)} (${s.run20.from}…${s.run20.to})`,
    `${rs(s.dd.depth)} (${s.dd.from}…${s.dd.to})`,
    `${rs(s.tail.worstSum)} = ${fx(s.tail.multiple, 2)}× net`,
    s.maxLossWorst !== null ? rs(s.maxLossWorst) : "–",
    s.worstMtm !== null ? `${rs(s.worstMtm.rs)} (expiry ${s.worstMtm.session})` : "–",
  ];
}
const TAIL_HEAD = ["variant", "worst trade", "worst 5-run", "worst 20-run", "max drawdown (peak…trough)", "worst 5% of trades (sum, × total net)", "largest defined max loss", "worst interim mark at a close (hold to expiry)"];

function yearTable(s: VariantStats): string {
  return md([
    ["year", "trades", "₹/trade", "95% CI ₹", "% prem", "PF", "net ₹", "worst"],
    ...s.years.map((y) => [y.year, y.n, rs(y.meanRs), `${rs(y.lo)} … ${rs(y.hi)}`, pc(y.meanPct), fx(y.pf), rs(y.net), `${rs(y.worstRs)} ${y.worstDate}`]),
  ]);
}

type Key = (t: Trade) => string | null;
function breakdown(title: string, trades: readonly Trade[], key: Key, order: readonly string[]): string {
  const rows: (string | number)[][] = [["subset", "trades", "₹/trade", "95% CI ₹", "% prem", "hit", "PF", "worst ₹ (date)"]];
  for (const k of order) {
    const ts = trades.filter((t) => key(t) === k);
    if (ts.length === 0) continue;
    const b = dayBlockBootstrap(sessionsOf(ts, []), { resamples: 10_000, seed: 7 });
    const w = ts.reduce((m, t) => (t.net < m.net ? t : m), ts[0]);
    rows.push([k, ts.length, rs(meanOf(ts.map((t) => t.net))), `${rs(b.perTrade.lo)} … ${rs(b.perTrade.hi)}`, pc(meanOf(ts.map((t) => t.pct))), pc(ts.filter((t) => t.net > 0).length / ts.length, 0), fx(profitFactor(ts.map((t) => t.net))), `${rs(w.net)} (${w.session})`]);
  }
  return `\n${title}\n\n${md(rows)}\n`;
}

function breakdowns(label: string, trades: readonly Trade[]): string {
  const years = [...new Set(trades.map((t) => t.session.slice(0, 4)))].sort();
  return [
    `\n#### ${label}: breakdowns`,
    breakdown("By sessions to expiry (0 = the contract's expiry day):", trades, (t) => dteBucket(t.dte), ["0", "1", "2-5", "6+"]),
    breakdown("By India VIX tercile (point in time: rank of the last close among the previous 252):", trades, (t) => (t.vixTercile === null ? null : ["low third", "middle third", "top third"][t.vixTercile]), ["low third", "middle third", "top third"]),
    breakdown("By scheduled event:", trades, (t) => (t.event ? `${t.event} day` : t.eve ? `session before ${t.eve}` : "other"), ["budget day", "rbi day", "election day", "session before budget", "session before rbi", "session before election", "other"]),
    breakdown("By opening gap |open ÷ previous close − 1|:", trades, (t) => (t.gap === null ? null : gapBucket(t.gap)), ["<0.25%", "0.25-0.5%", "0.5-1%", ">=1%"]),
    breakdown("By year:", trades, (t) => t.session.slice(0, 4), years),
  ].join("\n");
}

function worstList(trades: readonly Trade[], k: number): string {
  const ws = [...trades].sort((a, b) => a.net - b.net).slice(0, k);
  return md([
    ["entry", "exit", "strikes", "lot", "premium ₹/lot", "net ₹/lot", "% prem", "index move", "VIX", "event", "worst interim mark"],
    ...ws.map((t) => [t.entryDate, t.exitDate, t.strikes, t.lot, rs(t.premium), rs(t.net), pc(t.pct, 0), pc(t.move, 2), fx(t.vixPrev ?? NaN, 1), t.event ?? "", t.worstMtm !== null ? rs(t.worstMtm) : "–"]),
  ]);
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

interface BarResult {
  label: string;
  index: IndexId;
  criteria: { name: string; verdict: "PASS" | "FAIL" | "INSUFFICIENT" | "N/A"; detail: string }[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT";
}

function judge(label: string, index: IndexId, s: VariantStats, perts: { name: string; s: VariantStats }[], ledgerN: number, srVar: number | null, dailyReturns: number[]): BarResult {
  const c: BarResult["criteria"] = [];
  c.push({ name: "≥ 180 trades", verdict: s.n >= 180 ? "PASS" : "INSUFFICIENT", detail: `${s.n}` });
  const ciOk = s.boot.perTrade.lo > 0 && s.boot.perSession.lo > 0;
  c.push({ name: "95% CI > 0 per trade and per session", verdict: ciOk ? "PASS" : "FAIL", detail: `per trade ${rs(s.boot.perTrade.lo)} … ${rs(s.boot.perTrade.hi)}; per session ${rs(s.boot.perSession.lo)} … ${rs(s.boot.perSession.hi)}` });
  c.push({ name: "PF ≥ 1.3", verdict: s.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(s.pf) });
  const yrs = s.years.filter((y) => y.n >= 20);
  const badYears = yrs.filter((y) => !(y.net > 0));
  c.push({ name: "net > 0 in every year (≥ 20 trades)", verdict: badYears.length === 0 && yrs.length > 0 ? "PASS" : "FAIL", detail: badYears.length ? `negative: ${badYears.map((y) => `${y.year} ${rs(y.net)}`).join(", ")}` : `${yrs.length} years positive` });
  const base = s.net;
  const pos = perts.filter((p) => p.s.net > 0).length;
  const worst = perts.reduce<{ name: string; s: VariantStats } | null>((m, p) => (m === null || p.s.net < m.s.net ? p : m), null);
  const floorOk = worst === null || worst.s.net >= base - 0.5 * Math.abs(base);
  const robOk = perts.length > 0 && pos / perts.length >= 0.8 && floorOk;
  c.push({ name: "±20% robustness (≥ 80% net > 0; worst ≥ base − 50%)", verdict: robOk ? "PASS" : "FAIL", detail: `${pos}/${perts.length} positive; worst ${worst ? `${worst.name} ${rs(worst.s.net)}` : "–"} vs base ${rs(base)}` });
  const alpha = 0.05 / ledgerN;
  const p = Math.max(s.boot.perTrade.p, s.boot.perSession.p);
  const dsr = deflatedSharpe(dailyReturns, ledgerN, srVar);
  const dsrNull = deflatedSharpe(dailyReturns, ledgerN, null);
  const mtOk = p < alpha && dsr.dsr >= 0.95;
  c.push({ name: "Bonferroni and deflated Sharpe", verdict: mtOk ? "PASS" : "FAIL", detail: `p ${pv(p)} vs 0.05/${ledgerN} = ${pv(alpha)}; DSR ${fx(dsr.dsr, 3)} (SR ${fx(dsr.sr, 3)}/session, SR₀ ${fx(dsr.sr0, 3)} from V[SR] ${srVar === null ? "null" : srVar.toExponential(2)}); with V = 1/(T−1): DSR ${fx(dsrNull.dsr, 3)} (SR₀ ${fx(dsrNull.sr0, 3)})` });
  c.push({ name: "placebo, copy delay, intraday timing, look-ahead review", verdict: "N/A", detail: "not testable on end-of-day data (see §7)" });
  const vs = c.map((x) => x.verdict);
  const verdict = vs.includes("FAIL") ? "FAIL" : vs.includes("INSUFFICIENT") ? "INSUFFICIENT" : "PASS";
  return { label, index, criteria: c, verdict };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");

function trialLine(name: string, kind: "strategy" | "perturbation", params: Record<string, unknown>, s: VariantStats, notes: string): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: "WP10",
    variant: name,
    params,
    data: "bhavcopy NSE 2019-02-11..2026-10-08 / BSE 2023-05-15..2026-10-08 (WP6 compact cache) + Yahoo daily ^NSEI ^BSESN ^INDIAVIX",
    trades: s.n,
    net: Math.round(s.net * 100) / 100,
    notes,
    kind,
    account: "main",
    sessions: s.sessions,
    meanPerTrade: Math.round(s.meanRs * 100) / 100,
    srSession: s.srSession,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  index: IndexId;
  kind: "strategy" | "perturbation";
  group: string;
  params: Record<string, unknown>;
  res: DayResult;
  stats: VariantStats;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = str(args, "dir") ?? fail("--dir <bhavcopy cache> is required");
  const outDir = resolve(ROOT, str(args, "out", "reports/wp10")!);
  const resamples = num(args, "bootstrap", 100_000);
  const t0 = Date.now();
  const data = await loadResearchData({ from: "2019-01-01", to: "2026-10-08", dir });
  VIX = vixSeries(data);
  console.log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE sessions in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);

  const variants: Variant[] = [];
  const run = (idx: ResearchIndex, ctxs: Map<string, Ctx>, kind: Variant["kind"], group: string, spec: DaySpec | HoldSpec, isHold: boolean, bootN = resamples) => {
    const res = isHold ? buildHold(data, idx, ctxs, spec as HoldSpec) : buildDay(data, ctxs, spec as DaySpec);
    const stats = variantStats(res.trades, res.sessions, { resamples: bootN, runs: isHold ? [4, 12] : [5, 20] });
    const { spread, ...rest } = spec as DaySpec & HoldSpec;
    const params = { ...rest, spread: spread === engineSpread ? "engine" : "2x engine", index: idx.id };
    const v: Variant = { name: `${idx.id} ${spec.name}`, index: idx.id, kind, group, params, res, stats };
    variants.push(v);
    console.log(`${v.name}: ${stats.n} trades, ${rs(stats.meanRs)}/trade [${rs(stats.boot.perTrade.lo)}, ${rs(stats.boot.perTrade.hi)}], ${pc(stats.meanPct)} of premium, PF ${fx(stats.pf)}`);
    return v;
  };
  const x2 = scaledSpread(2);

  for (const idx of RESEARCH_INDICES) {
    const ctxs = contexts(data, idx, VIX);
    const day = (name: string, o: Partial<DaySpec>): DaySpec => ({ name, structure: "straddle", conv: "A", wingM: 1, entry: "open", spread: engineSpread, screen: "full", atmSync: false, skipEvents: false, ...o });
    // Q1 straddle.
    run(idx, ctxs, "strategy", "Q1", day("straddle A open→close", { conv: "A" }), false);
    run(idx, ctxs, "strategy", "Q1", day("straddle B open→close", { conv: "B" }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle A 2x spread", { conv: "A", spread: x2 }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle B 2x spread", { conv: "B", spread: x2 }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle A VWAP→close", { conv: "A", entry: "vwap" }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle B VWAP→close", { conv: "B", entry: "vwap" }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle close→close", { conv: "B", entry: "prevclose" }), false);
    run(idx, ctxs, "perturbation", "Q1", day("straddle B ATM-synchronous days", { conv: "B", atmSync: true }), false);
    // Q2 iron fly and candidates C1, C2.
    for (const m of [1, 2]) {
      const fly = (name: string, o: Partial<DaySpec>) => day(`fly ${m}EM ${name}`, { structure: "fly", wingM: m, ...o });
      run(idx, ctxs, "strategy", "Q2", fly("A open→close", { conv: "A" }), false);
      run(idx, ctxs, "strategy", "Q2", fly("B open→close", { conv: "B" }), false);
      run(idx, ctxs, "perturbation", "Q2", fly("B screen S1+S3 only", { conv: "B", screen: "s1s3" }), false);
      run(idx, ctxs, "perturbation", "Q2", fly("close→close", { conv: "B", entry: "prevclose" }), false);
      const cand = `C${m}`;
      run(idx, ctxs, "strategy", cand, fly(`${cand} (B, no event days)`, { conv: "B", skipEvents: true }), false);
      run(idx, ctxs, "perturbation", cand, fly(`${cand} wings x0.8`, { conv: "B", skipEvents: true, wingM: m * 0.8 }), false);
      run(idx, ctxs, "perturbation", cand, fly(`${cand} wings x1.2`, { conv: "B", skipEvents: true, wingM: m * 1.2 }), false);
      run(idx, ctxs, "perturbation", cand, fly(`${cand} VWAP entry`, { conv: "B", skipEvents: true, entry: "vwap" }), false);
      run(idx, ctxs, "perturbation", cand, fly(`${cand} 2x spread`, { conv: "B", skipEvents: true, spread: x2 }), false);
      run(idx, ctxs, "perturbation", cand, fly(`${cand} convention A`, { conv: "A", skipEvents: true }), false);
    }
    // Q3 hold to expiry and candidate C3.
    const hold = (name: string, o: Partial<HoldSpec>): HoldSpec => ({ name, n: 2, shortM: 1, wingM: null, spread: engineSpread, skipEvents: false, ...o });
    for (const n of [1, 2, 4]) run(idx, ctxs, "strategy", "Q3", hold(`strangle N=${n}`, { n }), true);
    run(idx, ctxs, "perturbation", "Q3", hold("strangle N=2 strikes x0.8", { shortM: 0.8 }), true);
    run(idx, ctxs, "perturbation", "Q3", hold("strangle N=2 strikes x1.2", { shortM: 1.2 }), true);
    run(idx, ctxs, "perturbation", "Q3", hold("strangle N=2 2x spread", { spread: x2 }), true);
    for (const n of [1, 2, 4]) run(idx, ctxs, "strategy", "Q3", hold(`condor N=${n}`, { n, wingM: 2 }), true);
    run(idx, ctxs, "strategy", "C3", hold("C3 (condor N=2, no event weeks)", { wingM: 2, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 N=1", { n: 1, wingM: 2, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 N=4", { n: 4, wingM: 2, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 short x0.8", { shortM: 0.8, wingM: 2, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 short x1.2", { shortM: 1.2, wingM: 2, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 wings x0.8", { wingM: 1.6, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 wings x1.2", { wingM: 2.4, skipEvents: true }), true);
    run(idx, ctxs, "perturbation", "C3", hold("C3 2x spread", { wingM: 2, skipEvents: true, spread: x2 }), true);
  }

  // Ledger: one line per variant, then the bar with N and V[SR] after the append.
  const lines = variants.map((v) => {
    const prices = v.group === "Q3" || v.group === "C3" ? "entry at closes, exit at final settlement" : "entry at opening prints (or VWAP / previous close where named), exit at the close or settlement";
    return trialLine(
      v.name,
      v.kind,
      v.params,
      v.stats,
      `${v.group}; ₹/lot per trade ${fx(v.stats.meanRs)}, ${pc(v.stats.meanPct, 2)} of premium, PF ${fx(v.stats.pf)}, day-block 95% CI ${fx(v.stats.boot.perTrade.lo)}..${fx(v.stats.boot.perTrade.hi)}; real bhavcopy prices, ${prices}; one lot at the lot in force; dated charges; engine spread unless stated`,
    );
  });
  // A rerun of an identical variant is not a new trial: only variants not yet in the ledger count (and are appended).
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === "WP10").map((r) => r.variant));
  const fresh = lines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVar = sharpeVariance(lines).variance;

  // Report sections.
  mkdirSync(outDir, { recursive: true });
  const sections: string[] = [];
  const byName = (name: string) => variants.find((v) => v.name === name)!;
  for (const idx of RESEARCH_INDICES) {
    const mine = variants.filter((v) => v.index === idx.id);
    sections.push(`\n## ${idx.id}\n\n### Headline (every variant)\n\n${md([HEADLINE_HEAD, ...mine.map((v) => headlineRow(v.name.replace(`${idx.id} `, ""), v.stats))])}\n`);
    sections.push(`\n### Tails\n\n${md([TAIL_HEAD, ...mine.map((v) => tailRow(v.name.replace(`${idx.id} `, ""), v.stats))])}\n`);
    sections.push(`\n### Costs per trade (₹/lot): premium, charges, spread\n\n${md([["variant", "premium sold", "charges", "spread", "sessions", "SR/session"], ...mine.map((v) => [v.name.replace(`${idx.id} `, ""), rs(v.stats.premiumPerTrade), rs(v.stats.chargesPerTrade), rs(v.stats.spreadPerTrade), v.stats.sessions, fx(v.stats.srSession, 3)])])}\n`);
    for (const name of ["straddle A open→close", "straddle B open→close", "fly 1EM B open→close", "fly 2EM B open→close", "strangle N=1", "strangle N=2", "condor N=1", "condor N=2"]) {
      const v = byName(`${idx.id} ${name}`);
      sections.push(breakdowns(`${idx.id} ${name}`, v.res.trades));
      sections.push(`\nBy year (day-block CIs):\n\n${yearTable(v.stats)}\n`);
    }
    // Year tables of every other strategy-kind variant.
    for (const v of mine.filter((x) => x.kind === "strategy")) sections.push(`\n#### ${v.name}: by year\n\n${yearTable(v.stats)}\n`);
    // Measurement diagnostics of the opening prints (not rules: both use information from later in the day).
    for (const name of ["straddle A open→close", "straddle B open→close"]) {
      const ts = byName(`${idx.id} ${name}`).res.trades;
      const devRows: (string | number)[][] = [["|ATM parity forward ÷ (index open + previous basis) − 1|", "trades", "₹/trade", "95% CI ₹", "% prem", "PF"]];
      for (const [label, lo, hi] of [["< 0.1%", 0, 0.001], ["0.1–0.25%", 0.001, 0.0025], ["0.25–0.5%", 0.0025, 0.005], ["≥ 0.5%", 0.005, Infinity]] as const) {
        const sub = ts.filter((t) => t.atmDev !== null && Math.abs(t.atmDev) >= lo && Math.abs(t.atmDev) < hi);
        if (!sub.length) continue;
        const b = dayBlockBootstrap(sessionsOf(sub, []), { resamples: 10_000, seed: 7 });
        devRows.push([label, sub.length, rs(meanOf(sub.map((t) => t.net))), `${rs(b.perTrade.lo)} … ${rs(b.perTrade.hi)}`, pc(meanOf(sub.map((t) => t.pct))), fx(profitFactor(sub.map((t) => t.net)))]);
      }
      const rich = ts.map((t) => t.openRich).filter((x): x is number => x !== null).sort((a, b) => a - b);
      const rq = (p: number) => rich[Math.floor(p * (rich.length - 1))];
      const cut = [rq(1 / 3), rq(2 / 3)];
      const richRows: (string | number)[][] = [["opening straddle ÷ the day's VWAP straddle − 1", "trades", "₹/trade", "% prem", "PF"]];
      for (const [label, f] of [
        [`low third (< ${pc(cut[0])})`, (x: number) => x < cut[0]],
        ["middle third", (x: number) => x >= cut[0] && x < cut[1]],
        [`top third (≥ ${pc(cut[1])})`, (x: number) => x >= cut[1]],
      ] as const) {
        const sub = ts.filter((t) => t.openRich !== null && f(t.openRich));
        richRows.push([label, sub.length, rs(meanOf(sub.map((t) => t.net))), pc(meanOf(sub.map((t) => t.pct))), fx(profitFactor(sub.map((t) => t.net)))]);
      }
      sections.push(
        `\n#### ${idx.id} ${name}: how the opening prints drive the result (diagnostics, not rules)\n\nBy the consistency of the ATM opening prints with the index open:\n\n${md(devRows)}\n\n` +
          `Opening straddle vs the same straddle at the day's VWAPs: median ${pc(rq(0.5))}, mean ${pc(meanOf(rich))}, share above 0: ${pc(rich.filter((x) => x > 0).length / rich.length, 0)} (${rich.length} days).\n\n${md(richRows)}\n`,
      );
    }
    // Fly usability.
    const usable: (string | number)[][] = [["variant", "sessions", "usable", "dropped: reason (count)"]];
    for (const v of mine.filter((x) => x.group === "Q2" || x.group.startsWith("C1") || x.group.startsWith("C2"))) {
      const dropped = [...v.res.drops].map(([k, l]) => `${k} ${l.length}`).join("; ");
      usable.push([v.name.replace(`${idx.id} `, ""), v.stats.sessions, v.stats.n, dropped || "none"]);
    }
    sections.push(`\n### Iron fly: usable sessions and why the others were dropped\n\n${md(usable)}\n`);
    // Straddle P&L on days the fly screen dropped vs kept.
    const straddleB = byName(`${idx.id} straddle B open→close`).res.trades;
    for (const m of [1, 2]) {
      const fly = byName(`${idx.id} fly ${m}EM B open→close`);
      const kept = new Set(fly.res.trades.map((t) => t.session));
      const dropped = new Set([...fly.res.drops.values()].flat());
      const sk = straddleB.filter((t) => kept.has(t.session));
      const sd = straddleB.filter((t) => dropped.has(t.session));
      const row = (label: string, ts: Trade[]) => [label, ts.length, rs(meanOf(ts.map((t) => t.net))), pc(meanOf(ts.map((t) => t.pct))), pc(meanOf(ts.map((t) => Math.abs(t.move))), 2), ts.length ? rs(Math.min(...ts.map((t) => t.net))) : "–"];
      sections.push(`\nStraddle (B) on the days the ${m}EM fly kept vs dropped:\n\n${md([["days", "n", "straddle ₹/trade", "% prem", "mean |open→close|", "worst"], row("kept", sk), row("dropped", sd)])}\n`);
    }
    // ATM synchronicity diagnostic.
    const dev = [...byName(`${idx.id} straddle B open→close`).res.atmDev.values()].map(Math.abs).sort((a, b) => a - b);
    const q = (p: number) => dev[Math.floor(p * (dev.length - 1))];
    sections.push(`\nATM opening prints: |parity forward ÷ (index open + previous basis) − 1| over ${dev.length} days: median ${pc(q(0.5), 3)}, p90 ${pc(q(0.9), 3)}, p99 ${pc(q(0.99), 3)}; above 0.5% on ${dev.filter((x) => x > ATM_SYNC_MAX).length} days.\n`);
    // Worst trades.
    for (const name of ["straddle A open→close", "straddle B open→close", "fly 1EM B open→close", "fly 2EM B open→close", "strangle N=1", "strangle N=2", "strangle N=4", "condor N=1", "condor N=2", "condor N=4"]) {
      sections.push(`\n#### ${idx.id} ${name}: the 12 worst trades\n\n${worstList(byName(`${idx.id} ${name}`).res.trades, 12)}\n`);
    }
    // Named stress weeks for hold-to-expiry: the first weekly expiry on or after each date.
    const stress = ["2020-03-12", "2020-03-23", "2021-02-01", "2022-02-24", "2024-06-04", "2025-04-07", "2025-05-12", "2026-02-01", "2026-03-30"];
    const holdNames = ["strangle N=1", "strangle N=2", "strangle N=4", "condor N=1", "condor N=2", "condor N=4"];
    const stressRows: (string | number)[][] = [["stress date", "expiry", ...holdNames]];
    for (const d of stress) {
      if (d < (regularSessions(data, idx)[0] ?? "")) continue;
      const x = weeklyExpiries(data, idx).find((e) => e >= d);
      if (!x) continue;
      stressRows.push([
        d,
        x,
        ...holdNames.map((n) => {
          const t = byName(`${idx.id} ${n}`).res.trades.find((tr) => tr.session === x);
          return t ? `${rs(t.net)} (${t.entryDate}, index ${pc(t.move, 1)}${t.worstMtm !== null && t.worstMtm < 0 ? `; worst interim mark ${rs(t.worstMtm)}` : ""})` : "–";
        }),
      ]);
    }
    sections.push(`\n#### ${idx.id} hold to expiry in named stress weeks (₹ per lot; entry date and index move from entry to settlement)\n\n${md(stressRows)}\n`);
  }

  // A compact bar for every strategy-kind variant (robustness is defined only for the candidates).
  const lite: (string | number)[][] = [["variant", "trades", "₹/trade", "95% CI per trade", "95% CI per session", "PF", "years net > 0", "bootstrap p", "Bonferroni", "DSR (V[SR] of variants / 1/(T−1))"]];
  for (const v of variants.filter((x) => x.kind === "strategy")) {
    const yrs = v.stats.years.filter((y) => y.n >= 20);
    const p = Math.max(v.stats.boot.perTrade.p, v.stats.boot.perSession.p);
    const rets = sessionsOf(v.res.trades, v.res.sessions).map((x) => sum(x.pnls) / CAPITAL);
    const d1 = deflatedSharpe(rets, ledgerN, srVar);
    const d0 = deflatedSharpe(rets, ledgerN, null);
    lite.push([
      v.name,
      v.stats.n,
      rs(v.stats.meanRs),
      `${rs(v.stats.boot.perTrade.lo)} … ${rs(v.stats.boot.perTrade.hi)}`,
      `${rs(v.stats.boot.perSession.lo)} … ${rs(v.stats.boot.perSession.hi)}`,
      fx(v.stats.pf),
      `${yrs.filter((y) => y.net > 0).length}/${yrs.length}`,
      pv(p),
      p < 0.05 / ledgerN ? "pass" : "fail",
      `${fx(d1.dsr, 2)} / ${fx(d0.dsr, 2)} (SR ${fx(d1.sr, 3)}, SR₀ ${fx(d1.sr0, 3)} / ${fx(d0.sr0, 3)})`,
    ]);
  }
  sections.unshift(`\n## Every strategy-kind variant against the testable parts of the bar\n\n${md(lite)}\n\nSettlement levels taken from the official index close (legacy files print none): ${settleFallbacks.length} expiries (${settleFallbacks.slice(0, 3).join(", ")} … ${settleFallbacks.slice(-2).join(", ")}).\n`);
  // The current lot-size regime (NIFTY 75 then 65, SENSEX 20) for return on margin: 2025-01-01 .. last session.
  const recentFrom = "2025-01-01";
  const recentRows: (string | number)[][] = [["variant", "trades", "net ₹ per lot", "₹ per lot per year", "trades per year", "worst trade", "worst interim mark"]];
  for (const v of variants.filter((x) => x.kind === "strategy")) {
    const ts = v.res.trades.filter((t) => t.session >= recentFrom);
    if (!ts.length) continue;
    const last = v.res.sessions.at(-1) ?? recentFrom;
    const years = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${recentFrom}T00:00:00Z`)) / (365.25 * 86_400_000);
    const w = ts.reduce((m, t) => (t.net < m.net ? t : m), ts[0]);
    const wm = ts.filter((t) => t.worstMtm !== null).reduce<number | null>((m, t) => (m === null || t.worstMtm! < m ? t.worstMtm : m), null);
    recentRows.push([v.name, ts.length, rs(sum(ts.map((t) => t.net))), rs(sum(ts.map((t) => t.net)) / years), fx(ts.length / years, 0), `${rs(w.net)} (${w.session})`, wm !== null ? rs(wm) : "–"]);
  }
  sections.push(`\n## Since ${recentFrom} (today's lot sizes): net per lot per year, for return on margin\n\n${md(recentRows)}\n`);

  // The bar for the candidates.
  const bars: BarResult[] = [];
  for (const idx of RESEARCH_INDICES) {
    for (const cand of ["C1", "C2", "C3"]) {
      const base = variants.find((v) => v.index === idx.id && v.group === cand && v.kind === "strategy")!;
      const perts = variants.filter((v) => v.index === idx.id && v.group === cand && v.kind === "perturbation").map((v) => ({ name: v.name.replace(`${idx.id} `, ""), s: v.stats }));
      const ses = sessionsOf(base.res.trades, base.res.sessions);
      const returns = ses.map((s) => sum(s.pnls) / CAPITAL);
      bars.push(judge(base.name, idx.id, base.stats, perts, ledgerN, srVar, returns));
    }
  }
  const barText = bars
    .map((b) => `\n#### ${b.label}: ${b.verdict}\n\n${md([["criterion", "verdict", "detail"], ...b.criteria.map((c) => [c.name, c.verdict, c.detail])])}\n`)
    .join("\n");
  sections.unshift(`\n## The bar (N = ${ledgerN} ledger lines, ${lines.length} of them this study's; V[SR] of this study's variants ${srVar === null ? "n/a" : srVar.toExponential(2)})\n${barText}`);

  const text = `# WP10 tables (generated by scripts/research/wp10-short-premium.ts, ${new Date().toISOString()})\n${sections.join("\n")}`;
  writeFileSync(resolve(outDir, "tables.md"), text);
  const summary = variants.map((v) => ({ name: v.name, group: v.group, kind: v.kind, ...v.stats, boot: { perTrade: v.stats.boot.perTrade, perSession: v.stats.boot.perSession } }));
  writeFileSync(resolve(outDir, "summary.json"), JSON.stringify({ ledgerBefore, ledgerN, srVar, bars, variants: summary }, null, 1));
  // Per-trade CSVs for the report's own checks (derived P&L only, no raw prices beyond the entry premium).
  for (const v of variants.filter((x) => x.kind === "strategy")) {
    const p = resolve(outDir, "trades", `${v.name.replace(/[^A-Za-z0-9=]+/g, "_")}.csv`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, ["session,entry,exit,expiry,dte,lot,strikes,premium,net,pct,move,gap,vix,event"].concat(v.res.trades.map((t) => [t.session, t.entryDate, t.exitDate, t.expiry, t.dte, t.lot, t.strikes, t.premium.toFixed(2), t.net.toFixed(2), t.pct.toFixed(5), t.move.toFixed(5), t.gap?.toFixed(5) ?? "", t.vixPrev ?? "", t.event ?? ""].join(","))).join("\n") + "\n");
  }
  console.log(`\nWrote ${resolve(outDir, "tables.md")} (${variants.length} variants; ledger ${ledgerBefore} -> ${ledgerN}: ${args.ledger === true ? `${fresh.length} new line(s) appended` : `${fresh.length} new variant(s) NOT appended (no --ledger)`}).`);
  for (const b of bars) console.log(`${b.label}: ${b.verdict}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
