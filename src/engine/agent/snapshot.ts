/**
 * The per-index snapshot the reflex model reads (SPEC §3 as amended, #12): built in code from data timestamped at
 * or before the bar close, and under SNAPSHOT_TOKEN_LIMIT estimated tokens. Returns and distances are integer
 * basis points (r5: 12 means +0.12%); a distance is level / c − 1, positive when the level is above the close;
 * null means unknown, never 0. Every number is clamped to a fixed width so the worst case stays inside the budget.
 *
 * The wire form (encodeSnapshot) is more compact than IndexSnapshot: it leaves out three fields the model can
 * read off others (ors from orh/orl and the bar time, pv from pn, ew from the bar time) and sends the book as an
 * array. Those three stay on IndexSnapshot for the dashboard.
 */
import type { FlowBuildup, OptionFlowView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { istDate, istMinutes, parseHHMM } from "../clock";
import type { EngineConfig } from "../config";
import { computePressure } from "../events/pressure";
import { computeFeatures } from "../market/features";
import { combineConviction } from "../strategy/conviction";
import { classifyRegime } from "../strategy/regime";
import { n2DailyByIndex } from "../strategy/rules";
import { rawComponents } from "../strategy/signals";
import { buildTodayPlan } from "../strategy/todayPlan";
import type { IndexId, MarketSnapshot, Regime, ScoredEvent, SignalPerformance } from "../types";
import { causalEvents } from "./causal";
import { CHARS_PER_TOKEN_BOUND, PROSE_CHARS_PER_TOKEN } from "./constants";
import type { AgentBookState, BookBlock, IndexSnapshot, OptionBlock } from "./types";

export interface SnapshotInput {
  index: IndexId;
  barCloseMs: number;
  /** Already causal (causalMarketSnapshot); buildIndexSnapshot asserts snap.t === barCloseMs. */
  market: MarketSnapshot;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  events: ScoredEvent[];
  perf: SignalPerformance[];
  flow: OptionFlowView | null;
  book: AgentBookState;
}

/** The widths every field is clamped to (the worst case of the token budget). */
export const SNAPSHOT_CLAMPS = {
  /** Returns and distances, basis points. */
  bp: 999,
  /** Option spreads (bp of the mid) and the 5-minute ATR (bp of the price). */
  spreadBp: 999,
  /** Account drawdown, bp. */
  ddBp: 9999,
  /** Today's loss used, bp of equity. */
  dlBp: 999,
  vz: 9.9,
  rv: 999,
  vix: 99.9,
  vixc: 99.9,
  premium: 9999.9,
  iv: 999,
  ivx: 99.9,
  pcr: 9.99,
  oaSec: 999,
  pnlLow: -100,
  pnlHigh: 999.9,
  dte: 99,
  lots: 9,
  /** Build-up counts cover ATM ±5 strikes. */
  buildupStrikes: 5,
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r0 = (x: number) => Math.round(x) + 0;
const r1 = (x: number) => Math.round(x * 10) / 10 + 0;
const r2 = (x: number) => Math.round(x * 100) / 100 + 0;
/** A percent as clamped integer basis points. */
const bp = (pct: number, max: number = SNAPSHOT_CLAMPS.bp) => (Number.isFinite(pct) ? r0(clamp(pct * 100, -max, max)) : 0);
/** A level's distance from the close, bp; null when the level is unknown (0 or missing). */
const dist = (level: number | null | undefined, close: number): number | null => (typeof level === "number" && level > 0 && close > 0 ? bp((level / close - 1) * 100) : null);

const REGIME_CODE: Record<Regime, IndexSnapshot["rg"]> = { TREND_UP: "TU", TREND_DOWN: "TD", RANGE: "RG", HIGH_VOL: "HV", EVENT: "EV" };
const OR_CODE = { FORMING: "F", INSIDE: "I", BROKE_UP: "U", BROKE_DOWN: "D" } as const;
const PLAN_CODE = { clear: "C", caution: "A", no_trade: "X" } as const;
const CHECK_CODE = { clear: "k", caution: "c", block: "b", unknown: "u" } as const;
const PLAN_RULES = ["N1", "N2", "N4", "N7", "N9"] as const;

/** The contract expiry the agent would buy on this index: the nearest weekly that does not expire today. */
export function buyExpiry(index: IndexId, date: string, calendar: TradingCalendar): string {
  const e = calendar.expiryOnOrAfter(index, date);
  return e <= date ? calendar.followingExpiry(index, e) : e;
}

export function buildIndexSnapshot(i: SnapshotInput): IndexSnapshot {
  const { index, barCloseMs: T, market, calendar, cfg } = i;
  if (market.t !== T) throw new Error(`snapshot: market data is at ${market.t}, not the bar close ${T} (pass causalMarketSnapshot)`);
  const date = istDate(T);
  const f = computeFeatures(index, market, calendar, cfg);
  const p = computePressure(causalEvents(i.events, T), index, T, cfg.events);
  const regime = classifyRegime(f, p, cfg.regime).regime;
  const conviction = combineConviction(index, T, rawComponents(f, p, cfg), regime, i.perf, cfg);
  const plan = buildTodayPlan({ nowMs: T, calendar, cfg: { ...cfg, indices: [index] }, snapshot: { t: T, features: { [index]: f }, daily: n2DailyByIndex(market, [index], T, cfg) } });
  const view = plan.indices.find((v) => v.index === index);
  const pn = PLAN_RULES.map((rule) => {
    const check = view?.checks.find((c) => c.rule === rule);
    return check ? CHECK_CODE[check.status] : "u";
  }).join("");
  const c = f.spot;
  const ind = f.indicators;
  const vix = f.vix > 0 ? r1(Math.min(f.vix, SNAPSHOT_CLAMPS.vix)) : null;
  const m = istMinutes(T);
  const expiry = buyExpiry(index, date, calendar);
  return {
    c: r0(c),
    r5: bp(f.ret5m),
    r15: bp(f.ret15m),
    r60: bp(f.ret60m),
    ro: bp(f.retFromOpen),
    vw: dist(ind.vwap, c) ?? 0,
    vz: r1(clamp(ind.vwapZ, -SNAPSHOT_CLAMPS.vz, SNAPSHOT_CLAMPS.vz)),
    orh: dist(f.openingRange.high, c),
    orl: dist(f.openingRange.low, c),
    ors: OR_CODE[f.openingRange.state],
    pdh: dist(ind.prevDayHigh, c),
    pdl: dist(ind.prevDayLow, c),
    pdc: dist(ind.prevDayClose, c),
    rsi: r0(clamp(ind.rsi14, 0, 100)),
    adx: r0(clamp(ind.adx14, 0, 100)),
    di: r0(clamp(ind.plusDi14 - ind.minusDi14, -100, 100)),
    st: ind.supertrendDir > 0 ? 1 : ind.supertrendDir < 0 ? -1 : 0,
    rv: r0(clamp(f.realizedVol2h, 0, SNAPSHOT_CLAMPS.rv)),
    atr: r0(clamp(f.atrPct5m * 100, 0, SNAPSHOT_CLAMPS.spreadBp)),
    vix,
    vixc: r1(clamp(f.vixChangePct, -SNAPSHOT_CLAMPS.vixc, SNAPSHOT_CLAMPS.vixc)),
    o: optionBlock(i.flow, c, f.vix > 0 ? f.vix : null, T),
    cv: r2(clamp(conviction.score, -1, 1)),
    rg: REGIME_CODE[conviction.regime],
    pv: view ? PLAN_CODE[view.verdict] : "A",
    pn,
    ew: m >= parseHHMM(cfg.gates.noEntryBeforeIst) && m <= parseHHMM(cfg.gates.noEntryAfterIst) ? 1 : 0,
    dte: r0(clamp(calendar.tradingDaysBetween(date, expiry), 0, SNAPSHOT_CLAMPS.dte)),
    xd: calendar.isExpiryDay(index, date) ? 1 : 0,
    bk: bookBlock(i.book, index),
  };
}

const COUNTED: readonly FlowBuildup[] = ["LONG_BUILDUP", "SHORT_BUILDUP", "SHORT_COVERING", "LONG_UNWINDING"];

function midAndSpread(bid: number | null | undefined, ask: number | null | undefined): { mid: number | null; spread: number | null } {
  if (!(typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0 && ask >= bid)) return { mid: null, spread: null };
  const mid = (bid + ask) / 2;
  return { mid: r1(Math.min(mid, SNAPSHOT_CLAMPS.premium)), spread: r0(clamp(((ask - bid) / mid) * 10_000, 0, SNAPSHOT_CLAMPS.spreadBp)) };
}

/**
 * The ATM option block from the flow view as of the bar close (flowViewAsOf); null without a usable sample or when
 * the sample is later than the bar close (never a future value).
 */
export function optionBlock(flow: OptionFlowView | null, close: number, vix: number | null, barCloseMs: number): OptionBlock | null {
  if (!flow || flow.atm === null || !(close > 0) || !flow.asOf) return null;
  const sampleMs = Date.parse(flow.asOf);
  if (!Number.isFinite(sampleMs) || sampleMs > barCloseMs) return null;
  const rows1 = flow.windows?.["1m"]?.rows ?? [];
  if (rows1.length === 0) return null;
  const k = flow.atm;
  const atm = rows1.find((r) => r.strike === k) ?? null;
  const ce = midAndSpread(atm?.ce?.bid, atm?.ce?.ask);
  const pe = midAndSpread(atm?.pe?.bid, atm?.pe?.ask);
  const ivs = [atm?.ce?.iv, atm?.pe?.iv].filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
  const ivRaw = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const step = flow.step ?? 0;
  const near = (strike: number) => step > 0 && Math.abs(strike - k) <= SNAPSHOT_CLAMPS.buildupStrikes * step + 1e-6;
  const bc: [number, number, number, number] = [0, 0, 0, 0];
  const bpc: [number, number, number, number] = [0, 0, 0, 0];
  for (const r of flow.windows?.["5m"]?.rows ?? []) {
    if (!near(r.strike)) continue;
    const ci = r.ce ? COUNTED.indexOf(r.ce.buildup) : -1;
    const pi = r.pe ? COUNTED.indexOf(r.pe.buildup) : -1;
    if (ci >= 0) bc[ci]++;
    if (pi >= 0) bpc[pi]++;
  }
  const mp = maxPain(rows1.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? null, peOi: r.pe?.oi ?? null })));
  const pcr = flow.summary?.pcr;
  return {
    k: r0(k),
    cm: ce.mid,
    cs: ce.spread,
    pm: pe.mid,
    ps: pe.spread,
    iv: ivRaw === null ? null : r0(Math.min(ivRaw, SNAPSHOT_CLAMPS.iv)),
    ivx: ivRaw !== null && vix !== null && vix > 0 ? r1(clamp(ivRaw - vix, -SNAPSHOT_CLAMPS.ivx, SNAPSHOT_CLAMPS.ivx)) : null,
    pcr: typeof pcr === "number" && Number.isFinite(pcr) ? r2(clamp(pcr, 0, SNAPSHOT_CLAMPS.pcr)) : null,
    mp: dist(mp, close),
    cw: dist(flow.summary?.resistance?.strike, close),
    pw: dist(flow.summary?.support?.strike, close),
    bc,
    bp: bpc,
    oa: r0(clamp((barCloseMs - sampleMs) / 1000, 0, SNAPSHOT_CLAMPS.oaSec)),
  };
}

/** The agent's own book on this index: L call held, S put held, - none; open P&L % of premium; drawdown and loss used in bp. */
export function bookBlock(book: AgentBookState, index: IndexId): BookBlock {
  const here = book.positions.filter((p) => p.index === index && p.lots > 0);
  const lots = here.reduce((s, p) => s + p.lots, 0);
  const cost = here.reduce((s, p) => s + p.avgEntry * p.lots, 0);
  const value = here.reduce((s, p) => s + p.markPremium * p.lots, 0);
  const side = here[0]?.side;
  return {
    pos: !side ? "-" : side === "BULL" ? "L" : "S",
    lots: r0(clamp(lots, 0, SNAPSHOT_CLAMPS.lots)),
    pnl: lots > 0 && cost > 0 ? r1(clamp((value / cost - 1) * 100, SNAPSHOT_CLAMPS.pnlLow, SNAPSHOT_CLAMPS.pnlHigh)) : null,
    dd: bp(Math.max(0, book.ddPct), SNAPSHOT_CLAMPS.ddBp),
    dl: bp(Math.max(0, book.dayLossPct), SNAPSHOT_CLAMPS.dlBp),
  };
}

/**
 * The strike where option holders' total intrinsic payout at expiry is smallest (OI-weighted; the lowest strike on
 * a tie), over the rows given: the formula of maxPainStrike in market/upstoxChain.ts. Null without OI.
 */
export function maxPain(rows: readonly { strike: number; ceOi: number | null; peOi: number | null }[]): number | null {
  if (!rows.some((r) => (r.ceOi ?? 0) > 0 || (r.peOi ?? 0) > 0)) return null;
  let best: number | null = null;
  let bestPayout = Infinity;
  for (const settle of rows) {
    let payout = 0;
    for (const r of rows) {
      payout += (r.ceOi ?? 0) * Math.max(0, settle.strike - r.strike);
      payout += (r.peOi ?? 0) * Math.max(0, r.strike - settle.strike);
    }
    if (payout < bestPayout) [best, bestPayout] = [settle.strike, payout];
  }
  return best;
}

/**
 * The snapshot as the model reads it: JSON with a fixed key order. ors, pv and ew are left out (the legend says how
 * to read them off orh/orl, pn and the bar time) and the book is [pos, lots, pnl, dd, dl].
 */
export function encodeSnapshot(s: IndexSnapshot): string {
  const o = s.o
    ? { k: s.o.k, cm: s.o.cm, cs: s.o.cs, pm: s.o.pm, ps: s.o.ps, iv: s.o.iv, ivx: s.o.ivx, pcr: s.o.pcr, mp: s.o.mp, cw: s.o.cw, pw: s.o.pw, bc: s.o.bc, bp: s.o.bp, oa: s.o.oa }
    : null;
  return JSON.stringify({
    c: s.c, r5: s.r5, r15: s.r15, r60: s.r60, ro: s.ro, vw: s.vw, vz: s.vz,
    orh: s.orh, orl: s.orl, pdh: s.pdh, pdl: s.pdl, pdc: s.pdc,
    rsi: s.rsi, adx: s.adx, di: s.di, st: s.st, rv: s.rv, atr: s.atr, vix: s.vix, vixc: s.vixc,
    o,
    cv: s.cv, rg: s.rg, pn: s.pn, dte: s.dte, xd: s.xd,
    bk: [s.bk.pos, s.bk.lots, s.bk.pnl, s.bk.dd, s.bk.dl],
  });
}

/** A conservative token estimate for dense numeric JSON: Math.ceil(text.length / CHARS_PER_TOKEN_BOUND). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_BOUND);
}

/** Prose (finalist text, the brief) at its own rate: Math.ceil(text.length / PROSE_CHARS_PER_TOKEN). */
export function estimateProseTokens(text: string): number {
  return Math.ceil(text.length / PROSE_CHARS_PER_TOKEN);
}

/** A synthetic snapshot with every field present at its widest value: the token budget's worst case. */
export function worstCaseSnapshot(): IndexSnapshot {
  const W = SNAPSHOT_CLAMPS;
  const n = -W.bp;
  return {
    c: 199_999,
    r5: n, r15: n, r60: n, ro: n, vw: n, vz: -W.vz,
    orh: n, orl: n, ors: "D",
    pdh: n, pdl: n, pdc: n,
    rsi: 100, adx: 100, di: -100, st: -1, rv: W.rv, atr: W.spreadBp,
    vix: W.vix, vixc: -W.vixc,
    o: {
      k: 199_900, cm: W.premium, cs: W.spreadBp, pm: W.premium, ps: W.spreadBp, iv: W.iv, ivx: -W.ivx, pcr: W.pcr,
      mp: n, cw: n, pw: n, bc: [11, 11, 11, 11], bp: [11, 11, 11, 11], oa: W.oaSec,
    },
    cv: -0.99, rg: "EV", pv: "X", pn: "uuuuu", ew: 0, dte: W.dte, xd: 1,
    bk: { pos: "S", lots: W.lots, pnl: W.pnlHigh, dd: W.ddBp, dl: W.dlBp },
  };
}
