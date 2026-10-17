/**
 * Plan §6 E2(a), the first 15-minute candle (WP9b). docs/research/notes/r4-preopen-gaps.md §4.2 cites
 * a NIFTY 15-minute study (Jul 2017 - Mar 2026): the day closed in the first candle's direction 73% of
 * the time when its body exceeded 0.24%. That figure counts the candle's own move; the plan asks for
 * it to be measured from the moment a trader can enter. So:
 *
 * - the candle is 09:15 to 09:15 + rangeMin (15 minutes: three closed 5-minute bars); its body is the
 *   last bar's close over the 09:15 bar's open (Yahoo's 09:15 open is the official open), minus 1;
 * - |body| > minBodyPct (0.24%) enters in the body's direction (up: buy the call, down: buy the put)
 *   at the first decision on a bar ending at or after both the candle's end and the entry window's
 *   start (09:30 with the engine's 09:25 window; 09:31:30 with the 90 s data lag), at the price then;
 * - one entry per index a day, held to the square-off (or N3's morning exit) with the premium stop as
 *   a disaster stop; there is no index-level stop or target in the rule.
 *
 * A body of exactly the threshold, a missing 09:15 bar or an incomplete candle means no trade that day.
 */
import { MINUTE_MS, parseHHMM } from "../../clock";
import type { EngineConfig } from "../../config";
import { istMinuteOfDay } from "../../market/candles";
import type { Candle, TradeSide } from "../../types";
import { n3Enabled } from "../rules";
import type { PublishedSignal } from "./index";

export interface FirstCandleParams {
  rangeMin: number;
  /** Body threshold in percent (0.24 = 0.24%). */
  minBodyPct: number;
  /** IST minute of day from which entries are allowed (the entry window, or N3's start when later). */
  windowStartMin: number;
}

export function firstCandleParams(cfg: EngineConfig): FirstCandleParams {
  const window = parseHHMM(cfg.gates.noEntryBeforeIst);
  const n3 = n3Enabled(cfg) ? parseHHMM(cfg.rules.n3.entryFromIst) : 0;
  return { ...cfg.strategy.firstCandle, windowStartMin: Math.max(window, n3) };
}

/** The day's first-candle trade as far as today's closed bars tell. */
export interface FirstCandlePlan {
  side: TradeSide | null;
  reason: string;
  /** The candle is complete and large, but the entry bar has not closed yet. */
  pending: boolean;
  /** No trade today (small body, missing bars). */
  skipped: boolean;
  open: number | null;
  close: number | null;
  bodyPct: number | null;
  /** Open time of the bar whose close is the entry level. */
  entryBarT: number | null;
  entryLevel: number | null;
}

const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function none(reason: string, skipped: boolean, extra: Partial<FirstCandlePlan> = {}): FirstCandlePlan {
  return { side: null, reason, pending: false, skipped, open: null, close: null, bodyPct: null, entryBarT: null, entryLevel: null, ...extra };
}

/** The day's trade from today's closed bars (ascending) of length `barMs`; the session opens at `openMs`. */
export function firstCandlePlan(bars: Candle[], openMs: number, p: FirstCandleParams, barMs: number): FirstCandlePlan {
  const rangeEnd = openMs + p.rangeMin * MINUTE_MS;
  const need = Math.round((p.rangeMin * MINUTE_MS) / barMs);
  const range = bars.filter((b) => b.t >= openMs && b.t < rangeEnd);
  const lastBar = bars[bars.length - 1];
  if (range.length < need || range[0].t !== openMs) {
    const stillForming = lastBar === undefined || lastBar.t + barMs < rangeEnd;
    return none(stillForming ? "first candle not complete" : "first candle has missing bars", !stillForming);
  }
  const open = range[0].o;
  const close = range[range.length - 1].c;
  if (!(open > 0 && close > 0)) return none("first candle has no prices", true);
  const bodyPct = (close / open - 1) * 100;
  const base = { open, close, bodyPct };
  if (!(Math.abs(bodyPct) > p.minBodyPct)) return none(`first candle body ${bodyPct >= 0 ? "+" : ""}${bodyPct.toFixed(3)}% within ±${p.minBodyPct}%`, true, base);
  const side: TradeSide = bodyPct > 0 ? "BULL" : "BEAR";
  const entryEndMin = Math.max(istMinuteOfDay(rangeEnd), p.windowStartMin);
  const lastRangeBar = range[range.length - 1];
  const entryBar = bars.find((b) => b.t >= lastRangeBar.t && istMinuteOfDay(b.t + barMs) >= entryEndMin);
  const what = `first candle ${bodyPct >= 0 ? "+" : ""}${bodyPct.toFixed(3)}% (open ${fmt(open)}, close ${fmt(close)})`;
  if (!entryBar) return { ...base, side, reason: `${what}: waiting for the entry bar`, pending: true, skipped: false, entryBarT: null, entryLevel: null };
  return { ...base, side, reason: `${what}: ${side === "BULL" ? "buy the call" : "buy the put"} at ${fmt(entryBar.c)}`, pending: false, skipped: false, entryBarT: entryBar.t, entryLevel: entryBar.c };
}

/** The rule's signal at the latest of today's closed bars: the entry on the entry bar only; no index exits. */
export function firstCandleState(bars: Candle[], openMs: number, p: FirstCandleParams, barMs: number): PublishedSignal {
  const plan = firstCandlePlan(bars, openMs, p, barMs);
  const last = bars[bars.length - 1];
  const levels: Record<string, number> = {};
  for (const k of ["open", "close", "bodyPct", "entryLevel"] as const) {
    const v = plan[k];
    if (v !== null) levels[k] = v;
  }
  const sig: PublishedSignal = {
    strategy: "FIRST_CANDLE",
    variant: `${p.rangeMin}min>${p.minBodyPct}%`,
    decisionBarEndMs: null,
    level: last ? last.c : null,
    entry: null,
    exitBull: null,
    exitBear: null,
    sizeMult: 1,
    levels,
    note: plan.reason,
  };
  if (plan.side && plan.entryBarT !== null && last && last.t === plan.entryBarT) return { ...sig, decisionBarEndMs: last.t + barMs, entry: plan.side };
  return sig;
}
