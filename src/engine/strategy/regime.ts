/** Rule-based regime classifier. The first matching rule wins. */
import type { EngineConfig } from "../config";
import type { EventPressure, MarketFeatures, Regime } from "../types";

export interface RegimeExplanation {
  regime: Regime;
  reason: string;
}

export function classifyRegime(f: MarketFeatures, p: EventPressure | null, cfg: EngineConfig["regime"]): RegimeExplanation {
  const next = f.nextScheduledEvent;
  const recent = f.recentScheduledEvent;
  if (next && next.impact === "HIGH" && next.minutesAway <= cfg.eventWindowBeforeMin && f.minutesToClose > 0 && next.minutesAway <= f.minutesToClose) {
    return { regime: "EVENT", reason: `${next.name} in ${next.minutesAway} min` };
  }
  if (recent && recent.impact === "HIGH" && recent.minutesAgo <= cfg.eventWindowAfterMin) {
    return { regime: "EVENT", reason: `${recent.name} ${recent.minutesAgo} min ago` };
  }
  if (p && p.absPressure >= cfg.eventAbsPressure && p.freshestEventAgeMin !== null && p.freshestEventAgeMin <= cfg.eventFreshMin) {
    return { regime: "EVENT", reason: `event pressure ${p.absPressure.toFixed(2)} with a story ${p.freshestEventAgeMin} min old` };
  }
  if (f.vixChangePct >= cfg.eventVixJumpPct) {
    return { regime: "EVENT", reason: `India VIX up ${f.vixChangePct.toFixed(1)}% today` };
  }
  if (f.vix >= cfg.highVolVix) return { regime: "HIGH_VOL", reason: `India VIX ${f.vix.toFixed(1)}` };
  if (f.rvIvRatio >= cfg.highVolRvIv) return { regime: "HIGH_VOL", reason: `realized/implied vol ${f.rvIvRatio.toFixed(2)}` };
  if (f.atrPctile20d >= cfg.highVolAtrPctile) return { regime: "HIGH_VOL", reason: `ATR at ${f.atrPctile20d.toFixed(0)}th percentile` };
  const trendUp = f.ret60m >= cfg.trendRet60mPct && f.efficiencyRatio60m >= cfg.trendEfficiency && f.barsSameSideOfVwap >= cfg.trendVwapBars;
  const trendDown = f.ret60m <= -cfg.trendRet60mPct && f.efficiencyRatio60m >= cfg.trendEfficiency && f.barsSameSideOfVwap <= -cfg.trendVwapBars;
  if (trendUp) return { regime: "TREND_UP", reason: `60m +${f.ret60m.toFixed(2)}%, efficiency ${f.efficiencyRatio60m.toFixed(2)}` };
  if (trendDown) return { regime: "TREND_DOWN", reason: `60m ${f.ret60m.toFixed(2)}%, efficiency ${f.efficiencyRatio60m.toFixed(2)}` };
  return { regime: "RANGE", reason: "no trend, volatility or event condition" };
}
