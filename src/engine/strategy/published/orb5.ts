/**
 * Five-minute opening-range breakout, as published in
 *   Zarattini, C. & Aziz, A. (2023, rev. Sep 2025), "Can Day Trading Really Be Profitable? Evidence of
 *   Sustainable Long-term Profits from Opening Range Breakout (ORB) Day Trading Strategy vs. Benchmark
 *   in the US Stock Market", SSRN 4416622.
 *
 * The rule: the direction of the first 5-minute candle sets the side (up candle: long, down candle:
 * short, doji: no trade); enter at the open of the second candle; stop at the opposite extreme of the
 * first candle (its low for a long, its high for a short); target 10R, R being the distance from the
 * entry to the stop; otherwise exit at the close. One trade per day.
 *
 * Our adaptations (reports/wp3-wp4-published.md): long = buy the ATM call, short = buy the ATM put;
 * the entry level is the first candle's close (the second candle's open in a continuous market); the
 * stop and target are index levels, touched when a later closed 5-minute bar's low/high reaches them
 * (seen 90 s after the bar closes, so a stop is honoured late, as a copier would honour it); "the
 * close" is the 15:05 square-off. Two entry timings:
 * - PUBLISHED: on the bar right after the range (needs gates.noEntryBeforeIst at or before 09:20);
 * - ENGINE_WINDOW: at the first bar inside the engine's entry window (09:25 by default), skipping the
 *   day when the stop already traded in between (the published trade would be closed by then), with R
 *   and the target measured from that later entry level.
 * A doji is a first candle whose close equals its open to the paisa.
 */
import { MINUTE_MS, parseHHMM } from "../../clock";
import type { EngineConfig, StrategyConfig } from "../../config";
import { istMinuteOfDay } from "../../market/candles";
import type { Candle, TradeSide } from "../../types";
import type { ExitVerdict, PublishedSignal } from "./index";

export interface Orb5Params {
  rangeMin: number;
  targetR: number;
  entry: StrategyConfig["orb5"]["entry"];
  /** IST minute of day at which the engine's entry window opens (gates.noEntryBeforeIst). */
  windowStartMin: number;
}

export function orb5Params(cfg: EngineConfig): Orb5Params {
  return { ...cfg.strategy.orb5, windowStartMin: parseHHMM(cfg.gates.noEntryBeforeIst) };
}

/** The day's ORB trade as far as it is known from today's closed bars. */
export interface OrbPlan {
  side: TradeSide | null;
  /** Why there is no trade (yet), or a description of the trade. */
  reason: string;
  /** True when the trade is known but its entry bar has not closed yet. */
  pending: boolean;
  /** True when the day's trade was skipped (doji, stop traded before the entry window, no room to the stop). */
  skipped: boolean;
  rangeHigh: number | null;
  rangeLow: number | null;
  /** Open time of the bar whose close is the entry level. */
  entryBarT: number | null;
  entryLevel: number | null;
  stop: number | null;
  target: number | null;
  r: number | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function noTrade(reason: string, skipped: boolean, extra: Partial<OrbPlan> = {}): OrbPlan {
  return { side: null, reason, pending: false, skipped, rangeHigh: null, rangeLow: null, entryBarT: null, entryLevel: null, stop: null, target: null, r: null, ...extra };
}

/** The day's trade from today's closed bars (ascending) of length `barMs`, session open at `openMs`. */
export function orb5Plan(bars: Candle[], openMs: number, p: Orb5Params, barMs: number): OrbPlan {
  const rangeEnd = openMs + p.rangeMin * MINUTE_MS;
  const need = Math.round((p.rangeMin * MINUTE_MS) / barMs);
  const rangeBars = bars.filter((b) => b.t >= openMs && b.t < rangeEnd);
  if (rangeBars.length < need || rangeBars[0].t !== openMs) return noTrade("opening range not complete", false);
  const open = rangeBars[0].o;
  const close = rangeBars[rangeBars.length - 1].c;
  const rangeHigh = Math.max(...rangeBars.map((b) => b.h));
  const rangeLow = Math.min(...rangeBars.map((b) => b.l));
  if (round2(open) === round2(close)) return noTrade(`doji first candle (open = close = ${fmt(close)})`, true, { rangeHigh, rangeLow });
  const side: TradeSide = close > open ? "BULL" : "BEAR";
  const stop = side === "BULL" ? rangeLow : rangeHigh;
  const lastRangeBar = rangeBars[rangeBars.length - 1];
  const rangeEndMin = istMinuteOfDay(rangeEnd);
  const entryEndMin = p.entry === "PUBLISHED" ? rangeEndMin : Math.max(rangeEndMin, p.windowStartMin);
  const entryBar = bars.find((b) => b.t >= lastRangeBar.t && istMinuteOfDay(b.t + barMs) >= entryEndMin);
  const base = { side, rangeHigh, rangeLow, stop };
  if (!entryBar) return { ...base, reason: "waiting for the entry bar", pending: true, skipped: false, entryBarT: null, entryLevel: null, target: null, r: null };
  const touched = bars.filter((b) => b.t > lastRangeBar.t && b.t <= entryBar.t).some((b) => (side === "BULL" ? b.l <= stop : b.h >= stop));
  if (touched) return noTrade(`stop ${fmt(stop)} traded before the entry window`, true, { rangeHigh, rangeLow });
  const entryLevel = entryBar.c;
  const r = side === "BULL" ? entryLevel - stop : stop - entryLevel;
  if (!(r > 0)) return noTrade(`entry ${fmt(entryLevel)} at or beyond the stop ${fmt(stop)}`, true, { rangeHigh, rangeLow });
  const target = side === "BULL" ? entryLevel + p.targetR * r : entryLevel - p.targetR * r;
  return {
    ...base,
    reason: `first candle ${side === "BULL" ? "up" : "down"}: entry ${fmt(entryLevel)}, stop ${fmt(stop)}, target ${fmt(target)} (${p.targetR}R, R ${fmt(r)})`,
    pending: false,
    skipped: false,
    entryBarT: entryBar.t,
    entryLevel,
    target,
    r,
  };
}

/** The ORB signal at the latest of today's closed bars: the entry on the entry bar, then stop/target exits. */
export function orb5State(bars: Candle[], openMs: number, p: Orb5Params, barMs: number): PublishedSignal {
  const plan = orb5Plan(bars, openMs, p, barMs);
  const last = bars[bars.length - 1];
  const levels: Record<string, number> = {};
  for (const k of ["rangeHigh", "rangeLow", "entryLevel", "stop", "target", "r"] as const) {
    const v = plan[k];
    if (v !== null) levels[k] = v;
  }
  const sig: PublishedSignal = {
    strategy: "ORB5",
    variant: p.entry,
    decisionBarEndMs: null,
    level: last ? last.c : null,
    entry: null,
    exitBull: null,
    exitBear: null,
    sizeMult: 1,
    levels,
    note: plan.reason,
  };
  if (!plan.side || plan.pending || plan.entryBarT === null || plan.stop === null || plan.target === null || !last) return sig;
  if (last.t === plan.entryBarT) return { ...sig, decisionBarEndMs: last.t + barMs, entry: plan.side };
  // After the entry bar: the first bar to reach the stop or the target decides (the stop first when one bar reaches both).
  for (const b of bars) {
    if (b.t <= plan.entryBarT) continue;
    const hitStop = plan.side === "BULL" ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTarget = plan.side === "BULL" ? b.h >= plan.target : b.l <= plan.target;
    if (!hitStop && !hitTarget) continue;
    const at = istMinuteOfDay(b.t);
    const when = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    const v: ExitVerdict = hitStop
      ? { reason: "STOP", detail: `ORB: index reached the stop ${fmt(plan.stop)} (first candle ${plan.side === "BULL" ? "low" : "high"}) in the ${when} bar` }
      : { reason: "TARGET", detail: `ORB: index reached the ${p.targetR}R target ${fmt(plan.target)} in the ${when} bar` };
    return { ...sig, decisionBarEndMs: b.t + barMs, exitBull: plan.side === "BULL" ? v : null, exitBear: plan.side === "BEAR" ? v : null, note: v.detail };
  }
  return sig;
}
