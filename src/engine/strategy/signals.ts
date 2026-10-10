/**
 * The signal components. Each maps features (and event pressure) to a directional view in [-1, 1]
 * with a natural horizon, or abstains when it has nothing to say (not applicable right now):
 * abstainers are left out of the weighted mean, so a silent source never dilutes the others.
 * VOL_REGIME only modifies thresholds and size.
 *
 * - EVENT: news, as the Event Pressure Index.
 * - TREND: EMA 9/21, Supertrend(10, 3) and +DI/−DI agreement, scaled by ADX(14), discounted
 *   against the daily EMA20/50 trend.
 * - ORB: break of the 09:15–09:30 opening range by at least 0.1 ATR, confirmed by the VWAP side;
 *   full strength until 12:30, fading out by 14:00; a failed break votes the other way.
 * - MEAN_REVERSION: fade a stretch of 1.5σ or more from VWAP when RSI(14) or Bollinger %B agree
 *   and ADX says there is no trend (votes in the RANGE regime only, see conviction.regimeMask).
 * - MOMENTUM, GAP, GLOBAL_BETA, RELATIVE_VALUE: return z-scores, the opening gap, the
 *   global-implied residual (fading out by 11:45) and index divergence.
 */
import type { EngineConfig } from "../config";
import type { EventPressure, GlobalKey, MarketFeatures, SignalComponent, SignalSource } from "../types";
import { clamp } from "../util/math";

export type RawComponent = Omit<SignalComponent, "weight" | "enabled">;

/** A component with no view: excluded from the weighted mean. */
export function abstain(source: SignalSource, horizonMin: number, notes: string): RawComponent {
  return { source, value: 0, horizonMin, abstain: true, notes };
}

/** Standard deviation of an index move over `minutes`, in percent, from an annualized vol in percent. */
export function sigmaPct(annualVolPct: number, minutes: number, cfg: EngineConfig): number {
  return annualVolPct * Math.sqrt(minutes / (cfg.pricing.tradingMinutesPerDay * cfg.pricing.tradingDaysPerYear));
}

/** Annualized vol used to normalize returns: realized when available, floored by a fraction of VIX. */
export function normVol(f: MarketFeatures): number {
  return Math.max(f.realizedVol2h, f.vix * 0.6, 5);
}

const fmt = (x: number, d = 2) => x.toFixed(d);

/** News below this |EPI| is too balanced or too weak to vote. */
const EVENT_MIN_ABS_EPI = 0.1;

export function eventSignal(p: EventPressure | null): RawComponent {
  if (!p || p.activeClusters === 0) return abstain("EVENT", 120, "no live events");
  if (Math.abs(p.epi) < EVENT_MIN_ABS_EPI) return abstain("EVENT", 120, `${p.activeClusters} live stories, no net direction (EPI ${fmt(p.epi)})`);
  const top = p.topContributors[0];
  return {
    source: "EVENT",
    value: clamp(p.epi, -1, 1),
    horizonMin: 180,
    notes: top ? `${p.activeClusters} live stories; top: ${top.title.slice(0, 80)}` : `${p.activeClusters} live stories`,
  };
}

const TREND_WARMUP_MIN = 20;
const TREND_MIN_ADX = 15;
const TREND_AGAINST_DAILY = 0.6;

/** EMA 9/21, Supertrend and DI agreement, scaled by trend strength (ADX). */
export function trendSignal(f: MarketFeatures): RawComponent {
  const h = 120;
  const ind = f.indicators;
  if (f.minutesSinceOpen < TREND_WARMUP_MIN) return abstain("TREND", h, "first 20 minutes: waiting for the session to set a direction");
  if (!(ind.ema21 > 0) || ind.supertrendDir === 0) return abstain("TREND", h, "not enough bars yet");
  if (ind.adx14 < TREND_MIN_ADX) return abstain("TREND", h, `ADX ${fmt(ind.adx14, 0)}: no trend`);
  const emaDir = Math.sign(ind.ema9 - ind.ema21);
  const diDir = Math.sign(ind.plusDi14 - ind.minusDi14);
  const direction = (emaDir + ind.supertrendDir + diDir) / 3;
  const strength = clamp((ind.adx14 - TREND_MIN_ADX) / 15, 0.2, 1);
  let value = direction * strength;
  const againstDaily = ind.dailyBias !== 0 && value !== 0 && Math.sign(value) === -ind.dailyBias;
  if (againstDaily) value *= TREND_AGAINST_DAILY;
  const word = (d: number) => (d > 0 ? "up" : d < 0 ? "down" : "flat");
  return {
    source: "TREND",
    value: clamp(value, -1, 1),
    horizonMin: h,
    notes: `ADX ${fmt(ind.adx14, 0)} (+DI ${fmt(ind.plusDi14, 0)} / −DI ${fmt(ind.minusDi14, 0)}), EMA9 ${emaDir > 0 ? ">" : emaDir < 0 ? "<" : "="} EMA21, Supertrend ${word(ind.supertrendDir)}${againstDaily ? ", against the daily trend" : ""}`,
  };
}

/** Minutes after the open: ORB is at full strength until 12:30 and gone by 14:00. */
const ORB_FULL_UNTIL_MIN = 195;
const ORB_END_MIN = 285;
const ORB_MIN_BREAK_ATR = 0.1;
const ORB_FAILED_BREAK_BARS = 3;

/** Breakout of the first 15 minutes' range. */
export function orbSignal(f: MarketFeatures): RawComponent {
  const h = 90;
  const or = f.openingRange;
  const m = f.minutesSinceOpen;
  if (or.state === "FORMING") return abstain("ORB", h, "opening range still forming");
  if (m >= ORB_END_MIN) return abstain("ORB", h, "after 14:00: breakouts are stale");
  const decay = m <= ORB_FULL_UNTIL_MIN ? 1 : clamp((ORB_END_MIN - m) / (ORB_END_MIN - ORB_FULL_UNTIL_MIN), 0, 1);
  const range = `${fmt(or.low, 0)}–${fmt(or.high, 0)}`;
  if (or.state === "INSIDE") {
    if (or.lastBreak && or.barsSinceReentry >= 1 && or.barsSinceReentry <= ORB_FAILED_BREAK_BARS) {
      const s = or.lastBreak === "UP" ? 1 : -1;
      return {
        source: "ORB",
        value: clamp(-s * 0.5 * decay, -1, 1),
        horizonMin: h,
        notes: `failed ${or.lastBreak === "UP" ? "upside" : "downside"} break: back inside ${range}`,
      };
    }
    return abstain("ORB", h, `inside the opening range ${range}`);
  }
  const s = or.state === "BROKE_UP" ? 1 : -1;
  if (or.strengthAtr < ORB_MIN_BREAK_ATR) return abstain("ORB", h, `break of ${range} under 0.1 ATR`);
  let value = s * clamp(0.4 + 0.3 * or.strengthAtr, 0.4, 1) * (or.barsOutside >= 2 ? 1 : 0.8) * decay;
  const vwapAligned = Math.sign(f.vwapDistPct) === s;
  if (!vwapAligned) value *= 0.3;
  return {
    source: "ORB",
    value: clamp(value, -1, 1),
    horizonMin: h,
    notes: `${s > 0 ? "above" : "below"} ${range} by ${fmt(or.strengthAtr)} ATR, ${or.barsOutside} bar${or.barsOutside === 1 ? "" : "s"} outside${vwapAligned ? "" : ", but on the wrong side of VWAP"}`,
  };
}

const MR_MIN_Z = 1.5;
const MR_MAX_ADX = 20;

/** Fade a stretch from VWAP when the oscillators agree and there is no trend. */
export function meanReversionSignal(f: MarketFeatures): RawComponent {
  const h = 60;
  const ind = f.indicators;
  const z = ind.vwapZ;
  if (Math.abs(z) < MR_MIN_Z) return abstain("MEAN_REVERSION", h, `${fmt(z, 1)}σ from VWAP: not stretched`);
  if (ind.adx14 >= MR_MAX_ADX) return abstain("MEAN_REVERSION", h, `ADX ${fmt(ind.adx14, 0)}: trending, no fade`);
  const s = Math.sign(z);
  const rsiConfirms = s > 0 ? ind.rsi14 >= 70 : ind.rsi14 <= 30;
  const bbConfirms = s > 0 ? ind.bbPctB >= 1 : ind.bbPctB <= 0;
  if (!rsiConfirms && !bbConfirms) return abstain("MEAN_REVERSION", h, `${fmt(z, 1)}σ from VWAP but RSI ${fmt(ind.rsi14, 0)} and %B ${fmt(ind.bbPctB)} not extreme`);
  let value = -s * clamp(0.4 + 0.3 * (Math.abs(z) - MR_MIN_Z), 0.4, 1);
  if (!rsiConfirms) value *= 0.8;
  return {
    source: "MEAN_REVERSION",
    value: clamp(value, -1, 1),
    horizonMin: h,
    notes: `${fmt(Math.abs(z), 1)}σ ${s > 0 ? "above" : "below"} VWAP, RSI ${fmt(ind.rsi14, 0)}, %B ${fmt(ind.bbPctB)}: fade toward VWAP`,
  };
}

export function momentumSignal(f: MarketFeatures, cfg: EngineConfig): RawComponent {
  if (f.minutesSinceOpen < 5) return abstain("MOMENTUM", 60, "session just opened");
  const vol = normVol(f);
  const z15 = f.ret15m / Math.max(1e-6, sigmaPct(vol, 15, cfg));
  const z60 = f.ret60m / Math.max(1e-6, sigmaPct(vol, 60, cfg));
  const trend = 0.4 * Math.tanh(z15 / 2) + 0.6 * Math.tanh(z60 / 2);
  const vwapTerm = clamp(f.barsSameSideOfVwap / 6, -1, 1) * 0.3;
  let value = clamp(trend + vwapTerm, -1, 1);
  if (f.minutesSinceOpen < 15) value *= 0.5; // the first 15 minutes are noisy
  return { source: "MOMENTUM", value, horizonMin: 60, notes: `z15 ${fmt(z15)}, z60 ${fmt(z60)}, VWAP bars ${f.barsSameSideOfVwap}` };
}

/** Opening-gap behaviour in the first 90 minutes: continuation when price extends the gap, fade when it fills. */
export function gapSignal(f: MarketFeatures): RawComponent {
  const horizonMin = 60;
  if (f.minutesSinceOpen > 90 || Math.abs(f.gapPct) < 0.25) return abstain("GAP", horizonMin, "no material gap");
  const fade = 1 - f.minutesSinceOpen / 90;
  const sameWay = Math.sign(f.retFromOpen) === Math.sign(f.gapPct) && Math.abs(f.retFromOpen) >= 0.1;
  const filling = Math.sign(f.retFromOpen) === -Math.sign(f.gapPct) && Math.abs(f.retFromOpen) >= 0.1;
  const notes = `gap ${fmt(f.gapPct)}%, since open ${fmt(f.retFromOpen)}%`;
  if (sameWay) {
    const value = Math.sign(f.gapPct) * Math.min(1, Math.abs(f.gapPct) / 0.8) * 0.7;
    return { source: "GAP", value: clamp(value * fade, -1, 1), horizonMin, notes: `${notes} (extending)` };
  }
  if (filling) {
    const value = -Math.sign(f.gapPct) * Math.min(1, Math.abs(f.retFromOpen) / 0.4) * 0.5;
    return { source: "GAP", value: clamp(value * fade, -1, 1), horizonMin, notes: `${notes} (filling)` };
  }
  return abstain("GAP", horizonMin, `${notes} (undecided)`);
}

/** Minutes after the open over which the global-implied residual fades out (full until 10:45, gone by 11:45). */
const GLOBAL_BETA_FADE_END_MIN = 150;
const GLOBAL_BETA_FADE_LEN_MIN = 60;

/**
 * Cross-asset residual: what overnight and intraday global moves (S&P futures, crude, rupee,
 * yields, Asia) imply India "should" have done since the prior close, minus what it did.
 * A positive residual means India lags good global news: expect catch-up. It is a morning
 * signal: once India has traded for a couple of hours the residual is mostly India's own news.
 */
export function globalBetaSignal(f: MarketFeatures, cfg: EngineConfig): RawComponent {
  const fade = clamp((GLOBAL_BETA_FADE_END_MIN - f.minutesSinceOpen) / GLOBAL_BETA_FADE_LEN_MIN, 0, 1);
  if (fade <= 0) return abstain("GLOBAL_BETA", 90, "after 11:45: global cues are priced in");
  let expected = 0;
  let used = 0;
  for (const [k, beta] of Object.entries(cfg.features.gapBetas)) {
    const mv = f.global[k as GlobalKey];
    if (mv === null || mv === undefined || !Number.isFinite(mv)) continue;
    expected += beta * mv;
    used++;
  }
  if (used < 3) return abstain("GLOBAL_BETA", 90, "insufficient global data");
  const actual = f.gapPct + f.retFromOpen;
  const residual = expected - actual;
  if (Math.abs(residual) < 0.15) return abstain("GLOBAL_BETA", 90, `residual ${fmt(residual)}% (small)`);
  return {
    source: "GLOBAL_BETA",
    value: clamp(Math.tanh(residual / 0.5) * 0.8 * fade, -1, 1),
    horizonMin: 90,
    notes: `globals imply ${fmt(expected)}%, India ${fmt(actual)}%`,
  };
}

/** Nifty-Sensex spread mean reversion plus Bank Nifty leading Nifty. */
export function relativeValueSignal(f: MarketFeatures): RawComponent {
  const z = f.divergence.vsOtherIndexZ;
  const catchUp = Math.abs(z) >= 2 ? -Math.tanh(z / 3) * 0.6 : 0;
  const bz = f.index === "NIFTY" ? f.divergence.vsBankNiftyZ : 0;
  const bankLead = Math.abs(bz) >= 1.5 ? Math.tanh(bz / 2.5) * 0.5 : 0;
  const notes = `spread z ${fmt(z)}${f.index === "NIFTY" ? `, BankNifty lead z ${fmt(bz)}` : ""}`;
  if (catchUp === 0 && bankLead === 0) return abstain("RELATIVE_VALUE", 30, `${notes}: no divergence`);
  return { source: "RELATIVE_VALUE", value: clamp(catchUp + bankLead, -1, 1), horizonMin: 30, notes };
}

/** Options are cheap when realized vol runs above implied: lower the bar and size up, and vice versa. */
export function volRegimeSignal(f: MarketFeatures): RawComponent {
  const r = f.rvIvRatio;
  if (r >= 1.2) return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: -0.05, sizeMult: 1.25 }, notes: `RV/IV ${fmt(r)}: options cheap` };
  if (r > 0 && r <= 0.7) return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: 0.1, sizeMult: 0.5 }, notes: `RV/IV ${fmt(r)}: options rich` };
  return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: 0, sizeMult: 1 }, notes: `RV/IV ${fmt(r)}` };
}

export function rawComponents(f: MarketFeatures, p: EventPressure | null, cfg: EngineConfig, opts: { noEvents?: boolean } = {}): RawComponent[] {
  return [
    opts.noEvents ? abstain("EVENT", 120, "event layer disabled") : eventSignal(p),
    trendSignal(f),
    orbSignal(f),
    momentumSignal(f, cfg),
    gapSignal(f),
    globalBetaSignal(f, cfg),
    meanReversionSignal(f),
    relativeValueSignal(f),
    volRegimeSignal(f),
  ];
}
