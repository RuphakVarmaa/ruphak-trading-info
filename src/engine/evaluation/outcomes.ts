/** Grades every stored decision by the underlying's forward returns (traded or not). */
import type { TradingCalendar } from "../calendar/calendar";
import { istDate, MINUTE_MS } from "../clock";
import type { Candle, PlanDecision, SignalOutcome } from "../types";
import { logRetPct } from "../util/math";

function priceAt(candles: Candle[], t: number): number | null {
  // Close of the last bar that ended at or before t (bars are 5 minutes, t = bar open).
  let px: number | null = null;
  for (const c of candles) {
    if (c.t + 5 * MINUTE_MS <= t) px = c.c;
    else break;
  }
  return px;
}

export function gradeDecisions(decisions: PlanDecision[], candlesByIndex: Record<string, Candle[]>, calendar: TradingCalendar, nowMs: number): SignalOutcome[] {
  const out: SignalOutcome[] = [];
  for (const d of decisions) {
    const candles = candlesByIndex[d.index] ?? [];
    const p0 = priceAt(candles, d.t);
    if (p0 === null) continue;
    const at = (minutes: number) => {
      const t = d.t + minutes * MINUTE_MS;
      return t <= nowMs ? priceAt(candles, t) : null;
    };
    const closeT = calendar.closeMs(istDate(d.t));
    const p15 = at(15);
    const p60 = at(60);
    const pc = closeT <= nowMs ? priceAt(candles, closeT) : null;
    const ret60 = p60 === null ? null : logRetPct(p0, p60);
    out.push({
      decisionId: d.id,
      index: d.index,
      t: d.t,
      stance: d.conviction.stance,
      score: d.conviction.score,
      regime: d.conviction.regime,
      ret15m: p15 === null ? null : logRetPct(p0, p15),
      ret60m: ret60,
      retClose: pc === null ? null : logRetPct(p0, pc),
      hit: d.conviction.stance === "NEUTRAL" || ret60 === null ? null : (d.conviction.stance === "BULLISH") === ret60 > 0,
      evaluatedMs: nowMs,
    });
  }
  return out;
}
