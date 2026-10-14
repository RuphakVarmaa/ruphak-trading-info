/**
 * Trade setups: the chart read an experienced NIFTY/SENSEX option buyer writes down when price nears a
 * level worth trading. Key levels (previous day, opening range, session extremes, VWAP and its bands,
 * floor pivots, Supertrend, round numbers) are merged into zones; four detectors (opening-range
 * breakout, previous-day high/low breakout, VWAP pullback in a trend, support bounce / resistance
 * rejection in a range) each give a trigger, a candle condition, a stop, two targets, the invalidation
 * and the indicator evidence for and against. The option to buy and its premium levels come from
 * delta, gamma and theta.
 *
 * Decision support only: nothing here places an order or touches the engine's gates, stops or caps.
 * Pure (no I/O); the engine tick quotes the contracts and stores the result (pipeline/setupsCycle.ts).
 */
import { istDate, istIso, istMinutes, MINUTE_MS, parseHHMM } from "../clock";
import { rsi, vwapBands } from "../market/indicators";
import type {
  KeyLevelView,
  SetupEvidenceView,
  SetupOptionView,
  TradeSetupKind,
  TradeSetupStatus,
  TradeSetupView,
} from "../api-types";
import type { Candle, IndexId, Indicators, OpeningRange, OptionContract, Regime, TradeSide } from "../types";
import { roundToTick } from "../util/math";

const BAR_MS = 5 * MINUTE_MS;
const OR_END_MIN = 9 * 60 + 30;
/** Levels closer than this (fraction of price) merge into one zone. */
export const ZONE_MERGE_FRAC = 0.0005;
export const ROUND_STEP: Record<IndexId, number> = { NIFTY: 100, SENSEX: 500 };
/** A setup stays on the board this long after it ends (MISSED, INVALID), so a person sees what happened. */
export const ENDED_KEEP_MS = 15 * MINUTE_MS;
export const SETUPS_REFRESH_MS = 60_000;
export const SETUPS_MAX_AGE_MS = 3 * MINUTE_MS;
export const MIN_RR1 = 1.2;

export const setupsKey = (index: IndexId) => `setups:latest:${index}`;

export const SETUP_NAMES: Record<TradeSetupKind, Record<TradeSide, string>> = {
  ORB: { BULL: "Opening-range breakout", BEAR: "Opening-range breakdown" },
  PDH_PDL: { BULL: "Previous-day high breakout", BEAR: "Previous-day low breakdown" },
  VWAP_PULLBACK: { BULL: "VWAP pullback in an uptrend", BEAR: "VWAP pullback in a downtrend" },
  RANGE_REVERSAL: { BULL: "Support bounce", BEAR: "Resistance rejection" },
};

// ---------------------------------------------------------------------------
// Key levels
// ---------------------------------------------------------------------------

export interface RawLevel {
  price: number;
  kind: string;
  weight: number;
}

export interface FloorPivots {
  p: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}

/** Classic floor pivots from the previous session's high, low and close. */
export function floorPivots(h: number, l: number, c: number): FloorPivots {
  const p = (h + l + c) / 3;
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) };
}

export interface LevelInputs {
  index: IndexId;
  spot: number;
  /** IST minutes of day now. */
  minutes: number;
  ind: Pick<Indicators, "prevDayHigh" | "prevDayLow" | "prevDayClose" | "vwap" | "supertrendLine" | "supertrendDir">;
  or: Pick<OpeningRange, "high" | "low">;
  sessionHigh: number;
  sessionLow: number;
  vwapSigma: number;
}

/** Every key level near the price, unmerged. */
export function rawLevels(x: LevelInputs): RawLevel[] {
  const out: RawLevel[] = [];
  const add = (price: number, kind: string, weight: number) => {
    if (Number.isFinite(price) && price > 0) out.push({ price, kind, weight });
  };
  const { ind } = x;
  if (ind.prevDayHigh > 0 && ind.prevDayLow > 0 && ind.prevDayClose > 0) {
    add(ind.prevDayHigh, "PDH", 3);
    add(ind.prevDayLow, "PDL", 3);
    add(ind.prevDayClose, "PDC", 2);
    const pv = floorPivots(ind.prevDayHigh, ind.prevDayLow, ind.prevDayClose);
    add(pv.p, "P", 2);
    add(pv.r1, "R1", 2);
    add(pv.s1, "S1", 2);
    add(pv.r2, "R2", 1);
    add(pv.s2, "S2", 1);
  }
  if (x.minutes >= OR_END_MIN && x.or.high > 0 && x.or.low > 0) {
    add(x.or.high, "ORH", 2);
    add(x.or.low, "ORL", 2);
  }
  if (x.sessionHigh > 0) add(x.sessionHigh, "HOD", 2);
  if (x.sessionLow > 0) add(x.sessionLow, "LOD", 2);
  if (ind.vwap > 0) {
    add(ind.vwap, "VWAP", 2);
    if (x.vwapSigma > 0) {
      add(ind.vwap + x.vwapSigma, "VWAP+1σ", 1);
      add(ind.vwap - x.vwapSigma, "VWAP−1σ", 1);
      add(ind.vwap + 2 * x.vwapSigma, "VWAP+2σ", 1);
      add(ind.vwap - 2 * x.vwapSigma, "VWAP−2σ", 1);
    }
  }
  if (ind.supertrendDir !== 0 && ind.supertrendLine > 0) add(ind.supertrendLine, "ST", 1);
  const step = ROUND_STEP[x.index];
  if (x.spot > 0) {
    const below = Math.floor(x.spot / step) * step;
    for (const r of [below - step, below, below + step, below + 2 * step]) add(r, `${r}`, r % (step * 5) === 0 ? 2 : 1);
  }
  return out;
}

/** Merges levels within `frac` of each other (chained from the zone's first level) into labelled zones. */
export function mergeZones(levels: RawLevel[], frac = ZONE_MERGE_FRAC): KeyLevelView[] {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const zones: RawLevel[][] = [];
  for (const l of sorted) {
    const z = zones[zones.length - 1];
    if (z && l.price - z[0].price <= z[0].price * frac) z.push(l);
    else zones.push([l]);
  }
  return zones.map((z) => {
    const strength = z.reduce((s, l) => s + l.weight, 0);
    const price = z.reduce((s, l) => s + l.price * l.weight, 0) / strength;
    const kinds = [...z].sort((a, b) => b.weight - a.weight).map((l) => l.kind);
    return { price: Math.round(price * 100) / 100, label: kinds.join(" + "), kinds, strength };
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface SetupContext {
  index: IndexId;
  t: number;
  spot: number;
  /** 5-minute ATR in index points. */
  atr: number;
  ind: Indicators;
  or: OpeningRange;
  regime: Regime;
  /** Today's closed 5-minute bars, oldest first. */
  bars: Candle[];
  /** The bar still forming, if any. */
  forming: Candle | null;
  zones: KeyLevelView[];
  vwapSigma: number;
  /** RSI(14) one closed bar ago, for "turning up / down". */
  rsiPrev: number;
  minutes: number;
  isExpiryDay: boolean;
  cautions: string[];
}

export interface ContextInputs {
  index: IndexId;
  t: number;
  spot: number;
  atrPct5m: number;
  ind: Indicators;
  or: OpeningRange;
  regime: Regime;
  /** All 5-minute bars for the index (crossing sessions), oldest first. */
  candles: Candle[];
  isExpiryDay: boolean;
  cautions?: string[];
}

/** Splits the bars into today's closed ones and the forming one, and reads the levels off them. */
export function buildSetupContext(x: ContextInputs): SetupContext {
  const today = istDate(x.t);
  const closedAll = x.candles.filter((b) => b.t + BAR_MS <= x.t);
  const bars = closedAll.filter((b) => istDate(b.t) === today);
  const formingBar = x.candles.find((b) => b.t + BAR_MS > x.t && b.t <= x.t && istDate(b.t) === today) ?? null;
  const all = formingBar ? [...bars, formingBar] : bars;
  const sessionHigh = all.length ? Math.max(...all.map((b) => b.h), x.spot) : 0;
  const sessionLow = all.length ? Math.min(...all.map((b) => b.l), x.spot) : 0;
  const vb = bars.length ? vwapBands(bars, x.spot) : { sigma: 0 };
  const closes = closedAll.slice(-121).map((b) => b.c);
  const rsiPrev = closes.length > 15 ? rsi(closes.slice(0, -1), 14) : x.ind.rsi14;
  const minutes = istMinutes(x.t);
  const levels = rawLevels({ index: x.index, spot: x.spot, minutes, ind: x.ind, or: x.or, sessionHigh, sessionLow, vwapSigma: vb.sigma });
  return {
    index: x.index,
    t: x.t,
    spot: x.spot,
    atr: Math.max((x.atrPct5m / 100) * x.spot, x.spot * 0.0005),
    ind: x.ind,
    or: x.or,
    regime: x.regime,
    bars,
    forming: formingBar,
    zones: mergeZones(levels),
    vwapSigma: vb.sigma,
    rsiPrev,
    minutes,
    isExpiryDay: x.isExpiryDay,
    cautions: x.cautions ?? [],
  };
}

/** The key zones nearest the price for display: `n` above and `n` below. */
export function nearestZones(zones: KeyLevelView[], spot: number, n = 4): KeyLevelView[] {
  const above = zones.filter((z) => z.price >= spot).slice(0, n);
  const below = zones.filter((z) => z.price < spot).slice(-n);
  return [...below, ...above];
}

// ---------------------------------------------------------------------------
// Session rules
// ---------------------------------------------------------------------------

/** Why no new setup may start now, or null: 09:25–14:30 IST, and not after 13:00 on the index's expiry day. */
export function sessionBlock(minutes: number, isExpiryDay: boolean): string | null {
  if (minutes < parseHHMM("09:25")) return "Setups start at 09:25 IST, after the first 10 minutes settle.";
  if (minutes > parseHHMM("14:30")) return "No new setups after 14:30 IST: too little time left for a trade to work.";
  if (isExpiryDay && minutes > parseHHMM("13:00")) return "Expiry day: no new setups after 13:00 IST.";
  return null;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export type TriggerStyle = "BREAKOUT" | "REVERSAL";

export interface SetupCandidate {
  kind: TradeSetupKind;
  side: TradeSide;
  style: TriggerStyle;
  /** The zone the setup is built on. */
  level: { price: number; label: string };
  trigger: number;
  condition: string;
  /** All the must-have conditions hold. */
  ok: boolean;
  score: number;
  evidence: SetupEvidenceView[];
  invalidation: string;
}

const f0 = (x: number) => Math.round(x).toLocaleString("en-IN");
const f1 = (x: number) => x.toFixed(1);
const sgn = (side: TradeSide) => (side === "BULL" ? 1 : -1);

function ev(out: SetupEvidenceView[], supports: boolean, text: string, weight: number): number {
  out.push({ text, supports });
  return supports ? weight : -weight;
}

/** Trend filters shared by the breakout detectors (a, b). Returns the score change and whether the musts hold. */
function trendChecks(ctx: SetupContext, side: TradeSide, evidence: SetupEvidenceView[]): { delta: number; ok: boolean } {
  const s = sgn(side);
  const i = ctx.ind;
  let d = 0;
  const vwapOk = i.vwap > 0 && s * (ctx.spot - i.vwap) > 0;
  d += ev(evidence, vwapOk, `Price ${f0(ctx.spot)} ${ctx.spot >= i.vwap ? "above" : "below"} VWAP ${f0(i.vwap)}`, 12);
  const emaKnown = i.ema21 > 0;
  const emaOk = emaKnown && s * (i.ema9 - i.ema21) > 0;
  if (emaKnown) d += ev(evidence, emaOk, `EMA9 ${f0(i.ema9)} ${i.ema9 >= i.ema21 ? "above" : "below"} EMA21 ${f0(i.ema21)}`, 10);
  const diOk = s * (i.plusDi14 - i.minusDi14) > 0;
  const adxOk = i.adx14 >= 20;
  d += ev(evidence, adxOk && diOk, `ADX ${f1(i.adx14)}${adxOk ? " (≥ 20, trending)" : " (< 20, no trend yet)"}, +DI ${f1(i.plusDi14)} / −DI ${f1(i.minusDi14)}`, adxOk && diOk ? 12 : 6);
  if (i.supertrendDir !== 0) d += ev(evidence, i.supertrendDir === s, `Supertrend ${i.supertrendDir > 0 ? "up" : "down"} at ${f0(i.supertrendLine)}`, 6);
  const r = i.rsi14;
  const rsiGood = side === "BULL" ? r >= 50 && r <= 72 : r <= 50 && r >= 28;
  const stretched = side === "BULL" ? r > 75 : r < 25;
  d += ev(evidence, rsiGood, `RSI ${f1(r)}${stretched ? " (stretched: chasing risk)" : rsiGood ? " (momentum with the trade)" : " (momentum against the trade)"}`, stretched ? 8 : 5);
  if (i.dailyBias !== 0) d += ev(evidence, i.dailyBias === s, `Daily trend ${i.dailyBias > 0 ? "up" : "down"} (EMA20 vs EMA50)`, 5);
  return { delta: d, ok: vwapOk && (!emaKnown || emaOk) };
}

function breakout(ctx: SetupContext, kind: TradeSetupKind, side: TradeSide, price: number, label: string): SetupCandidate {
  const evidence: SetupEvidenceView[] = [];
  const s = sgn(side);
  let score = 50;
  const tc = trendChecks(ctx, side, evidence);
  score += tc.delta;
  if (ctx.regime === "TREND_UP" || ctx.regime === "TREND_DOWN") score += ev(evidence, (ctx.regime === "TREND_UP") === (side === "BULL"), `Regime ${ctx.regime.replace("_", " ").toLowerCase()}`, 6);
  else if (ctx.regime === "RANGE") score += ev(evidence, false, "Regime range: breakouts fail more often", 6);
  const zone = ctx.zones.find((z) => Math.abs(z.price - price) <= price * ZONE_MERGE_FRAC);
  if (zone && zone.strength >= 4) score += ev(evidence, true, `${zone.label}: a stacked level, a clean break carries`, 4);
  const word = side === "BULL" ? "above" : "below";
  return {
    kind,
    side,
    style: "BREAKOUT",
    level: { price, label: zone?.label ?? label },
    trigger: price,
    condition: `a 5-min candle closes ${word} ${f0(price)}`,
    ok: tc.ok,
    score: Math.max(0, Math.min(100, Math.round(score))),
    evidence,
    invalidation: `a 5-min close back ${s > 0 ? "below" : "above"} ${f0(price)} (${label}) after the break, or price back ${s > 0 ? "under" : "over"} VWAP`,
  };
}

/** a. Opening-range breakout / breakdown (after 09:30). */
export function detectOrb(ctx: SetupContext): SetupCandidate[] {
  if (ctx.minutes < OR_END_MIN || !(ctx.or.high > 0 && ctx.or.low > 0) || ctx.or.state === "FORMING") return [];
  return [breakout(ctx, "ORB", "BULL", ctx.or.high, "ORH"), breakout(ctx, "ORB", "BEAR", ctx.or.low, "ORL")];
}

/** b. Previous-day high breakout / low breakdown. */
export function detectPrevDay(ctx: SetupContext): SetupCandidate[] {
  const i = ctx.ind;
  if (!(i.prevDayHigh > 0 && i.prevDayLow > 0)) return [];
  return [breakout(ctx, "PDH_PDL", "BULL", i.prevDayHigh, "PDH"), breakout(ctx, "PDH_PDL", "BEAR", i.prevDayLow, "PDL")];
}

/** c. VWAP pullback in a trend: price back at VWAP (or the ±1σ band) with RSI cooling and turning. */
export function detectVwapPullback(ctx: SetupContext): SetupCandidate[] {
  const i = ctx.ind;
  if (!(i.vwap > 0)) return [];
  const out: SetupCandidate[] = [];
  const near = Math.max(0.5 * ctx.atr, ctx.spot * 0.0012);
  for (const side of ["BULL", "BEAR"] as TradeSide[]) {
    const s = sgn(side);
    const trendRegime = side === "BULL" ? ctx.regime === "TREND_UP" : ctx.regime === "TREND_DOWN";
    const stAligned = i.supertrendDir === s;
    if (!trendRegime && !stAligned) continue;
    const bands = ctx.vwapSigma > 0 ? [{ p: i.vwap, l: "VWAP" }, { p: i.vwap + s * ctx.vwapSigma, l: s > 0 ? "VWAP+1σ" : "VWAP−1σ" }] : [{ p: i.vwap, l: "VWAP" }];
    const band = bands.sort((a, b) => Math.abs(ctx.spot - a.p) - Math.abs(ctx.spot - b.p))[0];
    if (Math.abs(ctx.spot - band.p) > 2 * near) continue;
    const evidence: SetupEvidenceView[] = [];
    let score = 50;
    score += ev(evidence, trendRegime, `Regime ${ctx.regime.replace("_", " ").toLowerCase()}`, 10);
    score += ev(evidence, stAligned, `Supertrend ${i.supertrendDir > 0 ? "up" : i.supertrendDir < 0 ? "down" : "warming up"}${i.supertrendLine > 0 ? ` at ${f0(i.supertrendLine)}` : ""}`, 8);
    const r = i.rsi14;
    const inBand = side === "BULL" ? r >= 40 && r <= 55 : r >= 45 && r <= 60;
    const turning = s * (r - ctx.rsiPrev) > 0;
    score += ev(evidence, inBand, `RSI ${f1(r)} (${side === "BULL" ? "40–55" : "45–60"} is a cooled-off pullback)`, 10);
    score += ev(evidence, turning, `RSI ${turning ? "turning " + (s > 0 ? "up" : "down") : "still " + (s > 0 ? "falling" : "rising")} (${f1(ctx.rsiPrev)} → ${f1(r)})`, 8);
    if (i.ema21 > 0) score += ev(evidence, s * (i.ema9 - i.ema21) > 0, `EMA9 ${f0(i.ema9)} vs EMA21 ${f0(i.ema21)}`, 6);
    if (i.adx14 > 0) score += ev(evidence, i.adx14 >= 20, `ADX ${f1(i.adx14)}`, 5);
    if (i.dailyBias !== 0) score += ev(evidence, i.dailyBias === s, `Daily trend ${i.dailyBias > 0 ? "up" : "down"}`, 4);
    const trigger = band.p + s * 0.2 * ctx.atr;
    const word = s > 0 ? "above" : "below";
    out.push({
      kind: "VWAP_PULLBACK",
      side,
      style: "REVERSAL",
      level: { price: band.p, label: band.l },
      trigger,
      condition: `a 5-min candle ${s > 0 ? "dips to" : "rises to"} ${band.l} ${f0(band.p)} and closes ${word} ${f0(trigger)}`,
      ok: inBand || turning,
      score: Math.max(0, Math.min(100, Math.round(score))),
      evidence,
      invalidation: `a 5-min close ${s > 0 ? "below" : "above"} ${band.l} by more than a quarter ATR, or Supertrend flips ${s > 0 ? "down" : "up"}`,
    });
  }
  return out;
}

/** d. Support bounce / resistance rejection at a strong zone in a range. */
export function detectRangeReversal(ctx: SetupContext): SetupCandidate[] {
  if (ctx.regime !== "RANGE") return [];
  const i = ctx.ind;
  const near = Math.max(0.5 * ctx.atr, ctx.spot * 0.0012);
  const out: SetupCandidate[] = [];
  for (const side of ["BULL", "BEAR"] as TradeSide[]) {
    const s = sgn(side);
    const strong = ctx.zones.filter((z) => z.strength >= 3 && (s > 0 ? z.price <= ctx.spot + near * 0.25 : z.price >= ctx.spot - near * 0.25));
    const zone = s > 0 ? strong[strong.length - 1] : strong[0];
    if (!zone || Math.abs(ctx.spot - zone.price) > 2 * near) continue;
    const r = i.rsi14;
    const rsiOk = s > 0 ? r < 35 : r > 65;
    const evidence: SetupEvidenceView[] = [];
    let score = 50;
    score += ev(evidence, true, `Regime range (ADX ${f1(i.adx14)}): levels tend to hold`, 6);
    score += ev(evidence, zone.strength >= 5, `${zone.label} at ${f0(zone.price)}: strength ${zone.strength}`, zone.strength >= 5 ? 10 : 3);
    score += ev(evidence, rsiOk, `RSI ${f1(r)} (${s > 0 ? "< 35 oversold" : "> 65 overbought"} wanted)`, 12);
    const bbOk = s > 0 ? i.bbPctB <= 0.1 : i.bbPctB >= 0.9;
    score += ev(evidence, bbOk, `Bollinger %B ${i.bbPctB.toFixed(2)} (${s > 0 ? "≤ 0.10 at the lower band" : "≥ 0.90 at the upper band"})`, 8);
    score += ev(evidence, s * (r - ctx.rsiPrev) > 0, `RSI ${f1(ctx.rsiPrev)} → ${f1(r)}`, 5);
    if (i.vwap > 0) score += ev(evidence, s * (i.vwap - ctx.spot) > 0, `VWAP ${f0(i.vwap)} ${s > 0 ? "above" : "below"}: room to revert`, 5);
    const trigger = zone.price + s * 0.2 * ctx.atr;
    out.push({
      kind: "RANGE_REVERSAL",
      side,
      style: "REVERSAL",
      level: { price: zone.price, label: zone.label },
      trigger,
      condition: `a 5-min candle tests ${zone.label} ${f0(zone.price)} and closes back ${s > 0 ? "above" : "below"} ${f0(trigger)}`,
      ok: rsiOk,
      score: Math.max(0, Math.min(100, Math.round(score))),
      evidence,
      invalidation: `a 5-min close ${s > 0 ? "below" : "above"} ${f0(zone.price)} by more than a quarter ATR (the level broke)`,
    });
  }
  return out;
}

export function detectAll(ctx: SetupContext): SetupCandidate[] {
  return [...detectOrb(ctx), ...detectPrevDay(ctx), ...detectVwapPullback(ctx), ...detectRangeReversal(ctx)];
}

// ---------------------------------------------------------------------------
// Stop, targets, R:R
// ---------------------------------------------------------------------------

export interface SetupLevels {
  stop: number;
  t1: number;
  t2: number;
  t1Label: string;
  t2Label: string;
  rr1: number;
  rr2: number;
}

/**
 * Stop beyond the level by 0.25 ATR or the last swing, whichever is closer to the entry, but at least
 * 0.15% away. T1 the next zone in the trade's direction, at least 1R; T2 the zone after it, else 2R.
 */
export function stopAndTargets(side: TradeSide, entry: number, level: number, atr: number, swing: number | null, zones: KeyLevelView[]): SetupLevels {
  const s = sgn(side);
  let stop = level - s * 0.25 * atr;
  if (swing !== null && s * (entry - swing) > 0 && s * (swing - stop) > 0) stop = swing;
  const minRisk = entry * 0.0015;
  if (s * (entry - stop) < minRisk) stop = entry - s * minRisk;
  const risk = s * (entry - stop);
  const ahead = zones
    .filter((z) => s * (z.price - entry) > 0.1 * risk)
    .sort((a, b) => s * (a.price - b.price));
  let t1: number;
  let t1Label: string;
  let rest: KeyLevelView[];
  if (ahead.length > 0) {
    const z = ahead[0];
    t1 = s * (z.price - entry) >= risk ? z.price : entry + s * risk;
    t1Label = s * (z.price - entry) >= risk ? z.label : "1R";
    rest = ahead.slice(1).filter((x) => s * (x.price - t1) > 0.25 * risk);
  } else {
    t1 = entry + s * 1.5 * risk;
    t1Label = "1.5R";
    rest = [];
  }
  let t2: number;
  let t2Label: string;
  if (rest.length > 0) {
    t2 = rest[0].price;
    t2Label = rest[0].label;
  } else {
    t2 = Math.abs(entry + s * 2 * risk - entry) > Math.abs(t1 - entry) ? entry + s * 2 * risk : t1 + s * risk;
    t2Label = Math.abs(t2 - entry - s * 2 * risk) < 1e-9 ? "2R" : `${((s * (t2 - entry)) / risk).toFixed(1)}R`;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { stop: r2(stop), t1: r2(t1), t2: r2(t2), t1Label, t2Label, rr1: r2((s * (t1 - entry)) / risk), rr2: r2((s * (t2 - entry)) / risk) };
}

/** The last swing against the trade from the recent bars: the lowest low (BULL) or highest high (BEAR) of the last 6. */
export function lastSwing(bars: Candle[], side: TradeSide, n = 6): number | null {
  const recent = bars.slice(-n);
  if (recent.length === 0) return null;
  return side === "BULL" ? Math.min(...recent.map((b) => b.l)) : Math.max(...recent.map((b) => b.h));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusInput {
  side: TradeSide;
  style: TriggerStyle;
  level: number;
  trigger: number;
  stop: number;
  atr: number;
  spot: number;
  bars: Candle[];
  forming: Candle | null;
  prev: TradeSetupStatus | null;
  ok: boolean;
}

/** How many closed bars back a confirming candle still counts. */
const CONFIRM_LOOKBACK = 6;

/**
 * WATCHING: within max(0.5 ATR, 0.12%) of the trigger and moving toward it. READY: crossed intrabar,
 * not yet confirmed. TRIGGERED: a closed 5-minute candle confirmed it; valid until price runs 0.5 ATR
 * past the trigger (MISSED). INVALID: the stop traded, or the conditions failed. Null: not near.
 */
export function setupStatus(x: StatusInput): TradeSetupStatus | null {
  const s = sgn(x.side);
  const past = (p: number, lvl: number) => s * (p - lvl) > 0;
  const chase = 0.5 * x.atr;
  const stopHit = !past(x.spot, x.stop) || (x.forming !== null && !past(s > 0 ? x.forming.l : x.forming.h, x.stop));
  if (x.prev === "INVALID") return "INVALID";
  if (x.prev === "TRIGGERED" || x.prev === "MISSED") {
    if (stopHit) return "INVALID";
    if (x.prev === "MISSED" || s * (x.spot - x.trigger) > chase) return "MISSED";
    return "TRIGGERED";
  }
  const recent = x.bars.slice(-CONFIRM_LOOKBACK);
  const touch = 0.15 * x.atr;
  const confirms = (b: Candle, i: number, arr: Candle[]): boolean => {
    if (!past(b.c, x.trigger)) return false;
    if (x.style === "BREAKOUT") {
      const prevClose = i > 0 ? arr[i - 1].c : (x.bars[x.bars.length - arr.length - 1]?.c ?? b.o);
      return !past(prevClose, x.trigger);
    }
    return s > 0 ? b.l <= x.level + touch : b.h >= x.level - touch;
  };
  const confirmed = recent.some((b, i) => confirms(b, i, recent));
  const last = x.bars[x.bars.length - 1];
  if (confirmed && last) {
    // Confirmed, then a close back through the trigger: the break failed.
    if (!past(last.c, x.trigger) || !x.ok || stopHit) return x.prev ? "INVALID" : null;
    return s * (x.spot - x.trigger) > chase ? "MISSED" : "TRIGGERED";
  }
  if (!x.ok) return x.prev ? "INVALID" : null;
  if (x.style === "BREAKOUT" && last && past(last.c, x.trigger)) {
    // An older break still holding: a retest near the trigger is still an entry.
    return s * (x.spot - x.trigger) <= chase ? "TRIGGERED" : null;
  }
  const crossed = past(x.spot, x.trigger) || (x.forming !== null && past(s > 0 ? x.forming.h : x.forming.l, x.trigger));
  const touched = x.style === "BREAKOUT" || (x.forming !== null && (s > 0 ? x.forming.l <= x.level + touch : x.forming.h >= x.level - touch)) || (last !== undefined && (s > 0 ? last.l <= x.level + touch : last.h >= x.level - touch));
  if (crossed && touched) return "READY";
  const near = Math.max(0.5 * x.atr, x.spot * 0.0012);
  if (x.style === "BREAKOUT") {
    const dist = s * (x.trigger - x.spot);
    const prevClose = last?.c ?? x.spot;
    const toward = s * (x.spot - prevClose) >= 0;
    return dist >= 0 && dist <= near && toward ? "WATCHING" : null;
  }
  // Reversal: price is coming back to the level from the trade's side.
  const dist = Math.abs(x.spot - x.level);
  const prevClose = last?.c ?? x.spot;
  const toward = s * (prevClose - x.spot) >= 0;
  if (x.prev === "WATCHING" || x.prev === "READY") return dist <= 2 * near ? "WATCHING" : null;
  return dist <= near && toward ? "WATCHING" : null;
}

// ---------------------------------------------------------------------------
// The option
// ---------------------------------------------------------------------------

/** ATM, or one strike in the money (delta near 0.6) when the score is 75 or more. */
export function setupStrike(spot: number, step: number, side: TradeSide, score: number): number {
  const atm = Math.round(spot / step) * step;
  if (score < 75) return atm;
  return side === "BULL" ? atm - step : atm + step;
}

export interface PremiumGreeks {
  delta: number;
  gamma: number;
  /** Premium change per minute from time decay (negative for a long option). */
  thetaPerMin: number;
}

/** premium + Δ·move + ½Γ·move² + θ·minutes, on the tick, never below one tick. */
export function premiumAt(p0: number, g: PremiumGreeks, move: number, minutes: number, tick = 0.05): number {
  const p = p0 + g.delta * move + 0.5 * g.gamma * move * move + g.thetaPerMin * minutes;
  return Math.max(tick, roundToTick(p, tick));
}

export const HOLD_MIN = { stop: 30, t1: 45, t2: 90 } as const;

export interface OptionPlanInput {
  contract: OptionContract;
  /** Premium at the current spot (the ask), and where it came from. */
  premiumNow: number;
  priceSource: "broker" | "model";
  iv: number | null;
  spot: number;
  /** Greeks at the trigger. */
  greeks: PremiumGreeks;
  trigger: number;
  stop: number;
  t1: number;
  t2: number;
  /** The engine's premium stop, percent (negative, e.g. −30). */
  maxStopPct: number;
  /** Minutes left before the square-off; holding times are capped to it. */
  minutesLeft: number;
}

/** Index stop and targets mapped to premiums with delta, gamma and the decay over the holding time. */
export function optionPlan(x: OptionPlanInput): SetupOptionView {
  const tick = x.contract.tickSize || 0.05;
  const g = x.greeks;
  const hold = (m: number) => Math.max(0, Math.min(m, x.minutesLeft));
  const entry = premiumAt(x.premiumNow, g, x.trigger - x.spot, 0, tick);
  let stop = premiumAt(entry, g, x.stop - x.trigger, hold(HOLD_MIN.stop), tick);
  const floor = roundToTick(entry * (1 + x.maxStopPct / 100), tick, "up");
  const stopCapped = stop < floor;
  if (stopCapped) stop = floor;
  stop = Math.min(stop, Math.max(tick, entry - tick));
  const t1 = Math.max(entry + tick, premiumAt(entry, g, x.t1 - x.trigger, hold(HOLD_MIN.t1), tick));
  const t2 = Math.max(t1 + tick, premiumAt(entry, g, x.t2 - x.trigger, hold(HOLD_MIN.t2), tick));
  const lot = x.contract.lotSize;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const c = x.contract;
  return {
    contract: {
      index: c.index,
      expiry: c.expiry,
      strike: c.strike,
      optionType: c.type,
      tradingSymbol: c.tradingSymbol,
      lotSize: lot,
      label: `${c.index} ${c.strike} ${c.type} ${c.expiry}`,
    },
    premiumNow: r2(x.premiumNow),
    priceSource: x.priceSource,
    iv: x.iv,
    delta: Math.round(g.delta * 1000) / 1000,
    gamma: Math.round(g.gamma * 1e6) / 1e6,
    decayPerMin: r2(-g.thetaPerMin),
    entry,
    stop: r2(stop),
    t1: r2(t1),
    t2: r2(t2),
    stopPct: Math.round((stop / entry - 1) * 1000) / 10,
    stopCapped,
    riskPerLot: Math.round((entry - stop) * lot),
    rewardT1PerLot: Math.round((t1 - entry) * lot),
    rewardT2PerLot: Math.round((t2 - entry) * lot),
    holdMin: hold(HOLD_MIN.t1),
  };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export interface SetupsRecord {
  t: number;
  index: IndexId;
  session: string;
  spot: number;
  setups: TradeSetupView[];
  levels: KeyLevelView[];
  note: string | null;
}

/**
 * The setups for one tick, with their status carried from the previous record: ranked by score, the
 * top 2 live ones (WATCHING, READY) plus every TRIGGERED one, plus those that ended in the last
 * 15 minutes. The option is attached later (it needs quotes).
 */
export function evaluateSetups(ctx: SetupContext, prev: SetupsRecord | null): { setups: TradeSetupView[]; note: string | null } {
  const session = istDate(ctx.t);
  const prior = prev && prev.session === session ? prev.setups : [];
  const block = sessionBlock(ctx.minutes, ctx.isExpiryDay);
  const out: TradeSetupView[] = [];
  const seen = new Set<string>();
  // The session's own high and low move with the price: no target on them alone.
  const targetZones = ctx.zones.filter((z) => z.kinds.some((k) => k !== "HOD" && k !== "LOD"));
  for (const c of detectAll(ctx)) {
    const id = `${session}:${ctx.index}:${c.kind}:${c.side}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const old = prior.find((p) => p.id === id) ?? null;
    // A setup already triggered keeps the trigger and stop it fired on.
    const keep = old && (old.status === "TRIGGERED" || old.status === "MISSED");
    const trigger = keep ? old.trigger : c.trigger;
    const lv = keep
      ? { stop: old.stop, t1: old.t1, t2: old.t2, t1Label: old.t1Label, t2Label: old.t2Label, rr1: old.rr1, rr2: old.rr2 }
      : stopAndTargets(c.side, trigger, c.level.price, ctx.atr, lastSwing(ctx.bars, c.side), targetZones);
    let status = setupStatus({ side: c.side, style: c.style, level: c.level.price, trigger, stop: lv.stop, atr: ctx.atr, spot: ctx.spot, bars: ctx.bars, forming: ctx.forming, prev: old?.status ?? null, ok: c.ok });
    if (status === null) continue;
    if (!old && (status === "MISSED" || status === "INVALID")) continue;
    if (block && !old) continue;
    if (lv.rr1 < MIN_RR1 && !keep) {
      if (!old) continue;
      status = "INVALID";
    }
    const iso = istIso(ctx.t);
    const statusSince = old && old.status === status ? old.statusSince : iso;
    if ((status === "MISSED" || status === "INVALID") && old && old.status === status && ctx.t - Date.parse(old.statusSince) > ENDED_KEEP_MS) continue;
    const s = sgn(c.side);
    out.push({
      id,
      index: ctx.index,
      kind: c.kind,
      name: SETUP_NAMES[c.kind][c.side],
      side: c.side,
      status,
      statusSince,
      firstSeen: old?.firstSeen ?? iso,
      score: c.score,
      spot: ctx.spot,
      trigger: Math.round(trigger * 100) / 100,
      condition: keep ? old.condition : c.condition,
      chaseLimit: Math.round((trigger + s * 0.5 * ctx.atr) * 100) / 100,
      distance: Math.round(s * (trigger - ctx.spot) * 100) / 100,
      level: keep ? old.level : c.level,
      ...lv,
      invalidation: c.invalidation,
      evidence: c.evidence,
      cautions: ctx.cautions,
      atr: Math.round(ctx.atr * 100) / 100,
      option: old?.option ?? null,
    });
  }
  // Setups seen before that the detectors no longer produce (the regime changed, the price left).
  for (const old of prior) {
    if (seen.has(old.id)) continue;
    if (old.status === "WATCHING") continue;
    const ended = old.status === "MISSED" || old.status === "INVALID";
    if (ended && ctx.t - Date.parse(old.statusSince) > ENDED_KEEP_MS) continue;
    out.push(ended ? old : { ...old, status: "INVALID", statusSince: istIso(ctx.t), spot: ctx.spot });
  }
  return { setups: rankSetups(out), note: out.length === 0 ? block : null };
}

const LIVE: ReadonlySet<TradeSetupStatus> = new Set(["WATCHING", "READY"]);

/** Top 2 live setups by score, every TRIGGERED one, then the recently ended ones; at most 4. */
export function rankSetups(list: TradeSetupView[]): TradeSetupView[] {
  const byScore = [...list].sort((a, b) => b.score - a.score);
  const trig = byScore.filter((x) => x.status === "TRIGGERED");
  const live = byScore.filter((x) => LIVE.has(x.status)).slice(0, 2);
  const ended = byScore.filter((x) => x.status === "MISSED" || x.status === "INVALID");
  const order: Record<TradeSetupStatus, number> = { TRIGGERED: 0, READY: 1, WATCHING: 2, MISSED: 3, INVALID: 4 };
  return [...trig, ...live, ...ended].slice(0, 4).sort((a, b) => order[a.status] - order[b.status] || b.score - a.score);
}

/** True when the board changed in a way a person would act on (status, trigger, contract, premium by a tick). */
export function setupsChanged(a: SetupsRecord | null, b: SetupsRecord): boolean {
  if (!a || a.session !== b.session) return true;
  if (b.t - a.t >= SETUPS_REFRESH_MS) return true;
  if (a.setups.length !== b.setups.length || a.note !== b.note) return true;
  return b.setups.some((x, i) => {
    const y = a.setups[i];
    return (
      y.id !== x.id ||
      y.status !== x.status ||
      Math.abs(y.trigger - x.trigger) >= 1 ||
      y.option?.contract.tradingSymbol !== x.option?.contract.tradingSymbol ||
      Math.abs((y.option?.entry ?? 0) - (x.option?.entry ?? 0)) >= 0.5
    );
  });
}

/** Minutes from `t` to an IST "HH:MM" today (0 once past). */
export function minutesUntil(t: number, hhmm: string): number {
  return Math.max(0, parseHHMM(hhmm) - istMinutes(t));
}
