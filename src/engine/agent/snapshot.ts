/**
 * The per-index snapshot the reflex model reads (SPEC §3 as amended, #12): computed in code from data timestamped
 * at or before the bar close, and under SNAPSHOT_TOKEN_LIMIT estimated tokens.
 *
 * Units, the same on IndexSnapshot and on the wire: returns and distances are integer basis points (r5: 12 means
 * +0.12%; a distance is level / c − 1, positive when the level is above the close). Everything else keeps the
 * unit of SPEC §3.2: the ATR in % of price, the option spreads in % of mid, the VIX change and the book in
 * percent, volatilities in vol points, premiums in rupees. null means unknown, never 0. fitSnapshot rounds and
 * clamps every number, so worstCaseSnapshot bounds the token budget.
 *
 * The wire form (encodeSnapshot) leaves out three fields the model reads off others (ors from orh/orl and the bar
 * time, pv from pn, ew from the bar time) and sends the book as an array; SNAPSHOT_LEGEND describes exactly that.
 * The three stay on IndexSnapshot for the code and the dashboard.
 */
import type { FlowBuildup, IndexPlanView, OptionFlowView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { SESSION, formatHHMM, istDate, istIso, istMinutes, parseHHMM } from "../clock";
import { DEFAULT_CONFIG, type EngineConfig } from "../config";
import { computePressure } from "../events/pressure";
import { computeFeatures } from "../market/features";
import { combineConviction } from "../strategy/conviction";
import { classifyRegime } from "../strategy/regime";
import { minSessionsLeft, n2DailyByIndex } from "../strategy/rules";
import { rawComponents } from "../strategy/signals";
import { buildTodayPlan } from "../strategy/todayPlan";
import type { IndexId, MarketFeatures, MarketSnapshot, Regime, ScoredEvent, SignalPerformance } from "../types";
import { barCloseIst, barClosingAt, causalEvents, causalMarketSnapshot } from "./causal";
import { CHARS_PER_TOKEN_BOUND, PROSE_CHARS_PER_TOKEN } from "./constants";
import type { AgentBookState, BookBlock, IndexSnapshot, OptionBlock } from "./types";

export interface SnapshotInput {
  index: IndexId;
  barCloseMs: number;
  /**
   * The market at or after the bar close: report.snapshot, or causalMarketSnapshot of it. buildIndexSnapshot reads
   * it as of the close itself (causalMarketSnapshot), so later bars, the live LTP and today's daily bar are ignored.
   */
  market: MarketSnapshot;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  /** Events scored and first seen after the close are ignored (causalEvents). */
  events: readonly ScoredEvent[];
  perf: SignalPerformance[];
  /** flowViewAsOf(samples, index, barCloseMs); a view sampled after the close is ignored. */
  flow: OptionFlowView | null;
  /** The book recorded at or before the close (bookAsOf). */
  book: AgentBookState;
}

/** The bounds every field is clamped to; worstCaseSnapshot sits on them. */
export const SNAPSHOT_CLAMPS = {
  /** Index level and strike, index points. */
  level: 999_999,
  /** Returns and distances, basis points either way. */
  bp: 999,
  vz: 9.9,
  /** Realized volatility, annualized %. */
  rv: 999,
  /** 5-minute ATR, % of price. */
  atrPct: 9.99,
  vix: 99.9,
  vixcLow: -99.9,
  vixcHigh: 999.9,
  /** Option mid, rupees. */
  premium: 9999,
  /** Bid-ask spread, % of mid. */
  spreadPct: 99.99,
  iv: 999,
  ivx: 99.9,
  pcr: 9.99,
  /** Build-up counts cover the strikes within this many steps of ATM. */
  buildupStrikes: 5,
  /** Option data age at the close, seconds. */
  oaSec: 999,
  dte: 99,
  lots: 99,
  pnlLow: -100,
  pnlHigh: 999.9,
  /** Drawdown and loss used, % of equity. */
  bookPct: 100,
} as const;

const L = SNAPSHOT_CLAMPS;
const MAX_BUILDUPS = 2 * L.buildupStrikes + 1;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** x rounded to dp decimals; -0 becomes 0. */
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp + 0;
/** A field that is never null: clamped and rounded, a non-finite value read as 0. */
const num = (x: number, lo: number, hi: number, dp: number) => round(clamp(finite(x) ? x : 0, lo, hi), dp);
/** A field that may be unknown: null stays null. */
const opt = (x: number | null | undefined, lo: number, hi: number, dp: number) => (finite(x) ? round(clamp(x, lo, hi), dp) : null);
const bp = (x: number) => num(x, -L.bp, L.bp, 0);
const bpOpt = (x: number | null | undefined) => opt(x, -L.bp, L.bp, 0);
/** Rupees to three significant figures: two decimals under ₹10, one under ₹100, none above. */
function rupees(x: number | null | undefined): number | null {
  if (!finite(x) || x < 0) return null;
  const v = clamp(x, 0, L.premium);
  return round(v, v >= 99.95 ? 0 : v >= 9.995 ? 1 : 2);
}
/** A level's distance from the close in basis points; null when either is unknown (0 or missing). */
const distBp = (level: number | null | undefined, close: number): number | null => (finite(level) && level > 0 && close > 0 ? (level / close - 1) * 10_000 : null);

const counts = (a: readonly number[]): [number, number, number, number] => [0, 1, 2, 3].map((i) => num(a[i] ?? 0, 0, MAX_BUILDUPS, 0)) as [number, number, number, number];

function fitOptionBlock(o: OptionBlock): OptionBlock {
  return {
    k: num(o.k, 0, L.level, 0),
    cm: rupees(o.cm),
    cs: opt(o.cs, 0, L.spreadPct, 2),
    pm: rupees(o.pm),
    ps: opt(o.ps, 0, L.spreadPct, 2),
    iv: opt(o.iv, 0, L.iv, 0),
    ivx: opt(o.ivx, -L.ivx, L.ivx, 1),
    pcr: opt(o.pcr, 0, L.pcr, 2),
    mp: bpOpt(o.mp),
    cw: bpOpt(o.cw),
    pw: bpOpt(o.pw),
    bc: counts(o.bc),
    bp: counts(o.bp),
    oa: num(o.oa, 0, L.oaSec, 0),
  };
}

function fitBook(b: BookBlock): BookBlock {
  return {
    pos: b.pos,
    lots: num(b.lots, 0, L.lots, 0),
    pnl: opt(b.pnl, L.pnlLow, L.pnlHigh, 1),
    dd: num(b.dd, 0, L.bookPct, 1),
    dl: num(b.dl, 0, L.bookPct, 1),
  };
}

/**
 * Every field rounded and clamped to the snapshot's units and bounds (idempotent). buildIndexSnapshot, optionBlock
 * and bookBlock return fitted values; worstCaseSnapshot is a fixed point.
 */
export function fitSnapshot(s: IndexSnapshot): IndexSnapshot {
  return {
    c: num(s.c, 0, L.level, 0),
    r5: bp(s.r5),
    r15: bp(s.r15),
    r60: bp(s.r60),
    ro: bp(s.ro),
    vw: bp(s.vw),
    vz: num(s.vz, -L.vz, L.vz, 1),
    orh: bpOpt(s.orh),
    orl: bpOpt(s.orl),
    ors: s.ors,
    pdh: bpOpt(s.pdh),
    pdl: bpOpt(s.pdl),
    pdc: bpOpt(s.pdc),
    rsi: num(s.rsi, 0, 100, 0),
    adx: num(s.adx, 0, 100, 0),
    di: num(s.di, -100, 100, 0),
    st: s.st > 0 ? 1 : s.st < 0 ? -1 : 0,
    rv: num(s.rv, 0, L.rv, 0),
    atr: num(s.atr, 0, L.atrPct, 2),
    vix: opt(s.vix, 0, L.vix, 1),
    vixc: num(s.vixc, L.vixcLow, L.vixcHigh, 1),
    o: s.o ? fitOptionBlock(s.o) : null,
    cv: num(s.cv, -1, 1, 2),
    rg: s.rg,
    pv: s.pv,
    pn: /^[kcbu]{5}$/.test(s.pn) ? s.pn : "uuuuu",
    ew: s.ew ? 1 : 0,
    dte: num(s.dte, 0, L.dte, 0),
    xd: s.xd ? 1 : 0,
    bk: fitBook(s.bk),
  };
}

const REGIME_CODE: Record<Regime, IndexSnapshot["rg"]> = { TREND_UP: "TU", TREND_DOWN: "TD", RANGE: "RG", HIGH_VOL: "HV", EVENT: "EV" };
const OR_CODE = { FORMING: "F", INSIDE: "I", BROKE_UP: "U", BROKE_DOWN: "D" } as const;
const PLAN_CODE = { clear: "C", caution: "A", no_trade: "X" } as const;
const CHECK_CODE = { clear: "k", caution: "c", block: "b", unknown: "u" } as const;
/** The plan rules pn reports, in this order. */
export const PLAN_RULES = ["N1", "N2", "N4", "N7", "N9"] as const;

/**
 * The expiry the agent would buy on this index at T, from the calendar: the nearest weekly that does not expire
 * today and, with rules.n4 on, has at least its minimum sessions left (chooseExpiryFor's rule).
 */
export function buyExpiry(index: IndexId, t: number, calendar: TradingCalendar, cfg: EngineConfig): string {
  const today = istDate(t);
  const min = Math.max(1, minSessionsLeft(cfg));
  let e = calendar.nextExpiry(index, t);
  for (let i = 0; i < 8 && (e <= today || calendar.tradingDaysBetween(today, e) < min); i++) e = calendar.followingExpiry(index, e);
  return e;
}

/** Today's plan for the index as of T (at the 15:30 bar, a moment before the close, so it is still today's plan). */
function planAt(index: IndexId, t: number, market: MarketSnapshot, f: MarketFeatures, calendar: TradingCalendar, cfg: EngineConfig): IndexPlanView | null {
  const plan = buildTodayPlan({
    nowMs: Math.min(t, calendar.closeMs(istDate(t)) - 1),
    calendar,
    cfg: { ...cfg, indices: [index] },
    snapshot: { t, features: { [index]: f }, daily: n2DailyByIndex(market, [index], t, cfg) },
  });
  return plan.indices.find((v) => v.index === index) ?? null;
}

/**
 * The snapshot of one index at the bar close T. Throws when the inputs cannot describe that bar: market data older
 * than T, no bar of the index closing at T, or a book recorded after T (a caller's leak, never silently used).
 */
export function buildIndexSnapshot(i: SnapshotInput): IndexSnapshot {
  const { index, barCloseMs: t, calendar, cfg } = i;
  if (!(i.market.t >= t)) throw new Error(`snapshot: the market data (${istIso(i.market.t)}) is older than the ${index} bar closing at ${barCloseIst(t)}`);
  if (!(i.book.t <= t)) throw new Error(`snapshot: the book was recorded at ${istIso(i.book.t)}, after the bar close ${istIso(t)}`);
  const market = causalMarketSnapshot(i.market, t);
  const bar = barClosingAt(market, index, t);
  if (!bar || !(bar.c > 0)) throw new Error(`snapshot: no ${index} bar closes at ${barCloseIst(t)}`);
  // The bar's own close. The features follow the engine's data cleaning, whose closing-auction cutoff
  // (features.indicatorCutoffIst) leaves bars from 15:15 out: the bars after 15:05 are stored for grading only.
  const c = bar.c;
  const f = computeFeatures(index, market, calendar, cfg);
  const p = computePressure(causalEvents(i.events, t), index, t, cfg.events);
  const conviction = combineConviction(index, t, rawComponents(f, p, cfg), classifyRegime(f, p, cfg.regime).regime, i.perf, cfg);
  const plan = planAt(index, t, market, f, calendar, cfg);
  const ind = f.indicators;
  const vix = f.vix > 0 ? f.vix : null;
  const m = istMinutes(t);
  const date = istDate(t);
  return fitSnapshot({
    c,
    r5: f.ret5m * 100,
    r15: f.ret15m * 100,
    r60: f.ret60m * 100,
    ro: f.retFromOpen * 100,
    vw: distBp(ind.vwap, c) ?? 0,
    vz: ind.vwapZ,
    orh: distBp(f.openingRange.high, c),
    orl: distBp(f.openingRange.low, c),
    ors: OR_CODE[f.openingRange.state],
    pdh: distBp(ind.prevDayHigh, c),
    pdl: distBp(ind.prevDayLow, c),
    pdc: distBp(ind.prevDayClose, c),
    rsi: ind.rsi14,
    adx: ind.adx14,
    di: ind.plusDi14 - ind.minusDi14,
    st: ind.supertrendDir > 0 ? 1 : ind.supertrendDir < 0 ? -1 : 0,
    rv: f.realizedVol2h,
    atr: f.atrPct5m,
    vix,
    vixc: f.vixChangePct,
    o: optionBlock(i.flow, c, vix, t),
    cv: conviction.score,
    rg: REGIME_CODE[conviction.regime],
    pv: plan ? PLAN_CODE[plan.verdict] : "A",
    pn: PLAN_RULES.map((rule) => {
      const check = plan?.checks.find((x) => x.rule === rule);
      return check ? CHECK_CODE[check.status] : "u";
    }).join(""),
    ew: m >= parseHHMM(cfg.gates.noEntryBeforeIst) && m <= parseHHMM(cfg.gates.noEntryAfterIst) ? 1 : 0,
    dte: calendar.tradingDaysBetween(date, buyExpiry(index, t, calendar, cfg)),
    xd: calendar.isExpiryDay(index, date) ? 1 : 0,
    bk: bookBlock(i.book, index),
  });
}

const COUNTED: readonly FlowBuildup[] = ["LONG_BUILDUP", "SHORT_BUILDUP", "SHORT_COVERING", "LONG_UNWINDING"];

function midAndSpread(bid: number | null | undefined, ask: number | null | undefined): { mid: number | null; spread: number | null } {
  if (!(finite(bid) && finite(ask) && bid > 0 && ask >= bid)) return { mid: null, spread: null };
  const mid = (bid + ask) / 2;
  return { mid, spread: ((ask - bid) / mid) * 100 };
}

/**
 * The ATM option block at the close T from a flow view built as of T (flowViewAsOf). Null without a usable view,
 * and for a view sampled after T or on another day, so a later or older sample never stands for this bar.
 * - k, cm cs, pm ps, iv: the ATM row of the 1-minute window (the latest quote of each side), mid = (bid + ask) / 2;
 *   a side without both bid and ask has a null mid and spread;
 * - mp: max pain over the monitored strikes (ATM ±15); cw, pw: the most call and put OI strikes;
 * - bc, bp: call and put strikes within SNAPSHOT_CLAMPS.buildupStrikes of ATM by their 5-minute build-up, as
 *   [long build-up, short build-up, short covering, long unwinding];
 * - oa: seconds from the sample to T.
 */
export function optionBlock(flow: OptionFlowView | null, close: number, vix: number | null, barCloseMs: number): OptionBlock | null {
  if (!flow || flow.atm === null || !(close > 0) || !flow.asOf) return null;
  const sampleMs = Date.parse(flow.asOf);
  if (!Number.isFinite(sampleMs) || sampleMs > barCloseMs || istDate(sampleMs) !== istDate(barCloseMs)) return null;
  const rows = flow.windows?.["1m"]?.rows ?? [];
  if (rows.length === 0) return null;
  const k = flow.atm;
  const atm = rows.find((r) => r.strike === k) ?? null;
  const ce = midAndSpread(atm?.ce?.bid, atm?.ce?.ask);
  const pe = midAndSpread(atm?.pe?.bid, atm?.pe?.ask);
  const ivs = [atm?.ce?.iv, atm?.pe?.iv].filter((x): x is number => finite(x) && x > 0);
  const iv = ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const step = flow.step ?? 0;
  const near = (strike: number) => (step > 0 ? Math.abs(strike - k) <= L.buildupStrikes * step + 1e-6 : strike === k);
  const bc = [0, 0, 0, 0];
  const bpc = [0, 0, 0, 0];
  for (const r of flow.windows?.["5m"]?.rows ?? []) {
    if (!near(r.strike)) continue;
    const ci = r.ce ? COUNTED.indexOf(r.ce.buildup) : -1;
    const pi = r.pe ? COUNTED.indexOf(r.pe.buildup) : -1;
    if (ci >= 0) bc[ci]++;
    if (pi >= 0) bpc[pi]++;
  }
  const pcr = flow.summary?.pcr;
  return fitOptionBlock({
    k,
    cm: ce.mid,
    cs: ce.spread,
    pm: pe.mid,
    ps: pe.spread,
    iv,
    ivx: iv !== null && vix !== null && vix > 0 ? iv - vix : null,
    pcr: finite(pcr) ? pcr : null,
    mp: distBp(maxPain(rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? null, peOi: r.pe?.oi ?? null }))), close),
    cw: distBp(flow.summary?.resistance?.strike, close),
    pw: distBp(flow.summary?.support?.strike, close),
    bc: bc as [number, number, number, number],
    bp: bpc as [number, number, number, number],
    oa: (barCloseMs - sampleMs) / 1000,
  });
}

/**
 * The agent's own book on this index: L call held, S put held, - none; the lots; the open P&L in % of premium at the
 * recorded marks (null when flat, or when a mark is missing or later than the book); the account's drawdown from
 * its peak and today's loss used, % of equity.
 */
export function bookBlock(book: AgentBookState, index: IndexId): BookBlock {
  const here = book.positions.filter((p) => p.index === index && p.lots > 0);
  let lots = 0;
  let cost = 0;
  let value = 0;
  let marked = here.length > 0;
  for (const p of here) {
    lots += p.lots;
    cost += p.avgEntry * p.lots;
    value += p.markPremium * p.lots;
    if (!(finite(p.avgEntry) && p.avgEntry > 0 && finite(p.markPremium) && p.markPremium >= 0 && p.markMs <= book.t)) marked = false;
  }
  return fitBook({
    pos: here.length === 0 ? "-" : here[0].side === "BULL" ? "L" : "S",
    lots,
    pnl: marked && cost > 0 ? (value / cost - 1) * 100 : null,
    dd: book.ddPct,
    dl: book.dayLossPct,
  });
}

/**
 * The strike where option holders' total intrinsic payout at expiry is smallest (OI-weighted; the lowest strike on
 * a tie), over the rows given: the formula of maxPainStrike in market/upstoxChain.ts. Null without OI.
 */
export function maxPain(rows: readonly { strike: number; ceOi: number | null; peOi: number | null }[]): number | null {
  const oi = (x: number | null) => (finite(x) && x > 0 ? x : 0);
  if (!rows.some((r) => oi(r.ceOi) > 0 || oi(r.peOi) > 0)) return null;
  let best: number | null = null;
  let bestPayout = Infinity;
  for (const settle of rows) {
    let payout = 0;
    for (const r of rows) {
      payout += oi(r.ceOi) * Math.max(0, settle.strike - r.strike);
      payout += oi(r.peOi) * Math.max(0, r.strike - settle.strike);
    }
    if (payout < bestPayout) [best, bestPayout] = [settle.strike, payout];
  }
  return best;
}

/** The wire form's keys, in order: the top level, the option block and the book array. */
export const SNAPSHOT_WIRE_KEYS = {
  top: ["c", "r5", "r15", "r60", "ro", "vw", "vz", "orh", "orl", "pdh", "pdl", "pdc", "rsi", "adx", "di", "st", "rv", "atr", "vix", "vixc", "o", "cv", "rg", "pn", "dte", "xd", "bk"],
  o: ["k", "cm", "cs", "pm", "ps", "iv", "ivx", "pcr", "mp", "cw", "pw", "bc", "bp", "oa"],
  bk: ["pos", "lots", "pnl", "dd", "dl"],
} as const;

/**
 * The snapshot as the model reads it: JSON in SNAPSHOT_WIRE_KEYS order. ors, pv and ew are left out (SNAPSHOT_LEGEND
 * says how to read them off orh/orl, pn and the bar time) and the book is [pos, lots, pnl, dd, dl]. The input is
 * fitted first (a no-op for buildIndexSnapshot's output), so no snapshot encodes longer than the worst case.
 */
export function encodeSnapshot(snapshot: IndexSnapshot): string {
  const s = fitSnapshot(snapshot);
  const o = s.o;
  return JSON.stringify({
    c: s.c,
    r5: s.r5,
    r15: s.r15,
    r60: s.r60,
    ro: s.ro,
    vw: s.vw,
    vz: s.vz,
    orh: s.orh,
    orl: s.orl,
    pdh: s.pdh,
    pdl: s.pdl,
    pdc: s.pdc,
    rsi: s.rsi,
    adx: s.adx,
    di: s.di,
    st: s.st,
    rv: s.rv,
    atr: s.atr,
    vix: s.vix,
    vixc: s.vixc,
    o: o ? { k: o.k, cm: o.cm, cs: o.cs, pm: o.pm, ps: o.ps, iv: o.iv, ivx: o.ivx, pcr: o.pcr, mp: o.mp, cw: o.cw, pw: o.pw, bc: o.bc, bp: o.bp, oa: o.oa } : null,
    cv: s.cv,
    rg: s.rg,
    pn: s.pn,
    dte: s.dte,
    xd: s.xd,
    bk: [s.bk.pos, s.bk.lots, s.bk.pnl, s.bk.dd, s.bk.dl],
  });
}

const OR_START = formatHHMM(SESSION.open);
const OR_END = formatHHMM(SESSION.open + DEFAULT_CONFIG.features.openingRangeMin);

/**
 * The snapshot legend for the reflex model's instructions: every key encodeSnapshot sends, in its units. The
 * prompt's legend must say exactly this (snapshot.test.ts checks it names every key).
 */
export const SNAPSHOT_LEGEND = [
  "Snapshot legend (one per index). Returns and distances are in basis points: 12 means +0.12%. A distance runs from the close c to a level and is positive when the level is above the close. null means unknown.",
  `c close; r5 r15 r60 log return over the last 5, 15 and 60 minutes; ro return since today's open; vw distance to VWAP; vz z-score of the close against VWAP (positive: close above VWAP); orh orl distance to today's opening-range high and low (the range is ${OR_START}-${OR_END}: before ${OR_END} it is still forming; the close is above the range when orh is negative, below it when orl is positive); pdh pdl pdc distance to the previous session's high, low and close; rsi RSI(14); adx ADX(14); di +DI minus -DI; st Supertrend direction (1 up, -1 down, 0 none); rv realized volatility over 2 hours (annualized %); atr 5-minute ATR (% of price); vix India VIX; vixc its change today (%).`,
  "o the at-the-money option block, null when there was no option data: k ATM strike; cm cs call mid (rupees) and bid-ask spread (% of mid); pm ps the same for the put; iv ATM implied volatility (%); ivx iv minus VIX; pcr put-call ratio on open interest; mp distance to max pain within the ±15 monitored strikes; cw pw distance to the strikes with the most call and the most put open interest; bc bp how many call and put strikes within 5 strikes of ATM showed each 5-minute build-up, as [long build-up, short build-up, short covering, long unwinding]; oa age of the option data at the close (seconds).",
  `cv the engine's conviction (-1 to 1; it has no measured edge); rg its regime (TU trend up, TD trend down, RG range, HV high volatility, EV event); pn today's plan rules N1 N2 N4 N7 N9 (k clear, c caution, b block, u unknown); the plan's verdict pv is X (no new trade today) when any rule is b, C when all are k, else A; new entries are allowed only from ${DEFAULT_CONFIG.gates.noEntryBeforeIst} to ${DEFAULT_CONFIG.gates.noEntryAfterIst} IST; dte trading sessions to the expiry the account would buy; xd 1 on the index's expiry day.`,
  "bk the account's own book on this index as [position (L call held, S put held, - none), lots, open P&L (% of premium), account drawdown from its peak (%), today's loss used (% of equity)].",
].join("\n");

/** A conservative token estimate for dense numeric JSON: Math.ceil(text.length / CHARS_PER_TOKEN_BOUND). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_BOUND);
}

/** Prose (finalist text, the brief) at its own rate: Math.ceil(text.length / PROSE_CHARS_PER_TOKEN). */
export function estimateProseTokens(text: string): number {
  return Math.ceil(text.length / PROSE_CHARS_PER_TOKEN);
}

/**
 * A synthetic snapshot with every field at its widest encoding (null where null is wider than any number the
 * field can hold): the token budget's worst case. A fixed point of fitSnapshot.
 */
export function worstCaseSnapshot(): IndexSnapshot {
  const d = -L.bp;
  const n = MAX_BUILDUPS;
  return {
    c: L.level,
    r5: d,
    r15: d,
    r60: d,
    ro: d,
    vw: d,
    vz: -L.vz,
    orh: d,
    orl: d,
    ors: "D",
    pdh: d,
    pdl: d,
    pdc: d,
    rsi: 100,
    adx: 100,
    di: -100,
    st: -1,
    rv: L.rv,
    atr: L.atrPct,
    vix: L.vix,
    vixc: L.vixcHigh,
    o: { k: L.level, cm: L.premium, cs: L.spreadPct, pm: L.premium, ps: L.spreadPct, iv: null, ivx: -L.ivx, pcr: L.pcr, mp: d, cw: d, pw: d, bc: [n, n, n, n], bp: [n, n, n, n], oa: L.oaSec },
    cv: -0.99,
    rg: "EV",
    pv: "X",
    pn: "bbbbb",
    ew: 0,
    dte: L.dte,
    xd: 1,
    bk: { pos: "S", lots: L.lots, pnl: L.pnlHigh, dd: 99.9, dl: 99.9 },
  };
}
