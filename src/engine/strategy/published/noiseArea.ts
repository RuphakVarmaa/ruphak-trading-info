/**
 * Noise-area intraday momentum, as published in
 *   Zarattini, C., Aziz, A. & Barbon, A. (2024, rev. Feb 2025), "Beat the Market: An Effective
 *   Intraday Momentum Strategy for S&P500 ETF (SPY)", Swiss Finance Institute WP 24-97, SSRN 4824172.
 *
 * Section 3 of the paper, for day t and each time of day HH:MM:
 *   move(t-i, HH:MM) = |Close(t-i, HH:MM) / Open(t-i) - 1|,  i = 1..14
 *   sigma(t, HH:MM)  = mean of the 14 moves
 *   Upper = max(Open(t), Close(t-1)) * (1 + VM * sigma),  Lower = min(Open(t), Close(t-1)) * (1 - VM * sigma),  VM = 1
 * Decisions and stops only at HH:00 and HH:30: long when the price is above Upper, short when below
 * Lower; positions are closed at the close, or on a crossover to the opposite band, where the position
 * is reversed (base model, Table 1). Refinement (Table 2): trailing stop max(Upper, VWAP) for longs and
 * min(Lower, VWAP) for shorts. Refinement (Table 3): shares = AUM * min(4, 2% / sigma_daily(14)) / Open.
 *
 * Choices of ours, all fixed in advance and documented in reports/wp3-wp4-published.md:
 * - "Price" is the close of the 5-minute bar ending at HH:00/HH:30; Open is the 09:15 bar's open and
 *   Close(t-1) the previous session's official close.
 * - sigma at a time of day uses the sessions among the last `lookbackSessions` that have a bar ending
 *   then and needs at least lookbackSessions - 1 of them (one Yahoo gap tolerated); otherwise there is
 *   no decision at that time.
 * - VWAP is the engine's vwap(): Yahoo's NIFTY/SENSEX bars carry no volume, so it is the running mean
 *   of typical prices (H+L+C)/3 since 09:15, a time-weighted stand-in for the paper's VWAP.
 * - With the VWAP stop a long is kept only while the close is strictly above both the band and VWAP
 *   (a tie exits), and entered only then, so an entry is never stopped at the same decision time.
 */
import { SESSION } from "../../clock";
import type { EngineConfig, StrategyConfig } from "../../config";
import { istMinuteOfDay } from "../../market/candles";
import { vwap } from "../../market/indicators";
import type { TradeSide } from "../../types";
import type { ExitVerdict, PublishedSignal, SessionBars } from "./index";

export interface NoiseAreaParams {
  lookbackSessions: number;
  bandMult: number;
  decisionEveryMin: number;
  /** Decision grid offset in minutes of the day (0: HH:00/HH:30 on a 30-minute grid). */
  anchorMin: number;
  stop: StrategyConfig["noiseArea"]["stop"];
  sizing: StrategyConfig["noiseArea"]["sizing"];
  volTargetPct: number;
  maxLeverage: number;
}

export function noiseParams(cfg: EngineConfig): NoiseAreaParams {
  return { ...cfg.strategy.noiseArea, anchorMin: 0 };
}

/** True when a bar ending at IST minute `endMin` is a decision time (HH:00/HH:30 for the paper's grid). */
export function isDecisionMinute(endMin: number, p: Pick<NoiseAreaParams, "decisionEveryMin" | "anchorMin">): boolean {
  return endMin > SESSION.open && (((endMin - p.anchorMin) % p.decisionEveryMin) + p.decisionEveryMin) % p.decisionEveryMin === 0;
}

/**
 * Mean absolute move from the session open at the bar ending at IST minute `endMin`, over the last
 * `lookback` sessions of `history`; null when fewer than lookback - 1 of them have that bar and an open.
 */
export function noiseSigma(history: SessionBars[], endMin: number, barMs: number, lookback: number): number | null {
  let sum = 0;
  let n = 0;
  for (const s of history.slice(-lookback)) {
    if (s.open === null || !(s.open > 0)) continue;
    const bar = s.bars.find((b) => istMinuteOfDay(b.t + barMs) === endMin);
    if (!bar || !(bar.c > 0)) continue;
    sum += Math.abs(bar.c / s.open - 1);
    n++;
  }
  return n > 0 && n >= lookback - 1 ? sum / n : null;
}

/** The noise-area bands around max/min(Open, previous close). */
export function noiseBands(open: number, prevClose: number, sigma: number, bandMult: number): { upper: number; lower: number } {
  return { upper: Math.max(open, prevClose) * (1 + bandMult * sigma), lower: Math.min(open, prevClose) * (1 - bandMult * sigma) };
}

const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The paper's decision on the bar at `idx` of today's session (default: the latest closed bar), or
 * null when that bar does not end at a decision time, the open is unknown or sigma is undefined.
 * Only bars up to `idx` are read (VWAP included), so the decision is point in time.
 */
export function noiseAreaDecision(
  today: SessionBars,
  history: SessionBars[],
  prevClose: number,
  p: NoiseAreaParams,
  barMs: number,
  idx = today.bars.length - 1,
): PublishedSignal | null {
  const bar = today.bars[idx];
  if (!bar || today.open === null || !(today.open > 0) || !(prevClose > 0)) return null;
  const endMin = istMinuteOfDay(bar.t + barMs);
  if (!isDecisionMinute(endMin, p)) return null;
  const sigma = noiseSigma(history, endMin, barMs, p.lookbackSessions);
  if (sigma === null) return null;
  const { upper, lower } = noiseBands(today.open, prevClose, sigma, p.bandMult);
  const vw = vwap(today.bars.slice(0, idx + 1));
  const close = bar.c;
  const at = hhmm(endMin);
  let entry: TradeSide | null = null;
  let exitBull: ExitVerdict | null = null;
  let exitBear: ExitVerdict | null = null;
  let note: string;
  if (p.stop === "OPPOSITE_BAND") {
    if (close > upper) entry = "BULL";
    else if (close < lower) entry = "BEAR";
    if (close < lower) exitBull = { reason: "SIGNAL_FLIP", detail: `noise area: close ${fmt(close)} below the lower band ${fmt(lower)} at ${at} (crossover)` };
    if (close > upper) exitBear = { reason: "SIGNAL_FLIP", detail: `noise area: close ${fmt(close)} above the upper band ${fmt(upper)} at ${at} (crossover)` };
    note = entry ? `close ${fmt(close)} ${entry === "BULL" ? "above the upper" : "below the lower"} band at ${at}` : `close ${fmt(close)} inside the noise area ${fmt(lower)}–${fmt(upper)} at ${at}`;
  } else {
    const longStop = Math.max(upper, vw);
    const shortStop = Math.min(lower, vw);
    if (close > longStop) entry = "BULL";
    else if (close < shortStop) entry = "BEAR";
    if (close <= longStop) exitBull = { reason: "TRAIL", detail: `noise area: close ${fmt(close)} at or below the trailing stop ${fmt(longStop)} = max(upper ${fmt(upper)}, VWAP ${fmt(vw)}) at ${at}` };
    if (close >= shortStop) exitBear = { reason: "TRAIL", detail: `noise area: close ${fmt(close)} at or above the trailing stop ${fmt(shortStop)} = min(lower ${fmt(lower)}, VWAP ${fmt(vw)}) at ${at}` };
    note = entry
      ? `close ${fmt(close)} ${entry === "BULL" ? `above max(upper, VWAP) ${fmt(longStop)}` : `below min(lower, VWAP) ${fmt(shortStop)}`} at ${at}`
      : `close ${fmt(close)} between ${fmt(shortStop)} and ${fmt(longStop)} at ${at}`;
  }
  return {
    strategy: "NOISE_AREA",
    variant: p.stop,
    decisionBarEndMs: bar.t + barMs,
    level: close,
    entry,
    exitBull,
    exitBear,
    sizeMult: 1,
    levels: { sigmaPct: sigma * 100, upper, lower, vwap: vw, open: today.open, prevClose },
    note,
  };
}

/**
 * Vol-target size multiplier min(maxLeverage, targetPct / sigma), sigma = sample standard deviation
 * (percent) of the last `lookback` close-to-close daily returns (paper: 14 returns, target 2%, cap 4).
 * 1 when fewer than lookback + 1 closes are known.
 */
export function volTargetMultiplier(dailyCloses: number[], targetPct: number, maxLeverage: number, lookback = 14): number {
  if (dailyCloses.length < lookback + 1) return 1;
  const closes = dailyCloses.slice(-(lookback + 1));
  const rets = closes.slice(1).map((c, i) => (c / closes[i] - 1) * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  if (!(sd > 0)) return 1;
  return Math.min(maxLeverage, targetPct / sd);
}
