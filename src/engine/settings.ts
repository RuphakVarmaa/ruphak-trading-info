import type { EngineConfig } from "./config";
import type { EngineSettings } from "./types";

/** Initial engine settings: PAPER mode, disarmed, kill switch off, caps derived from config. */
export function defaultSettings(cfg: EngineConfig, nowMs: number): EngineSettings {
  return {
    mode: "PAPER",
    armedUntil: null,
    killSwitch: false,
    killReason: null,
    maxOpenPositions: cfg.sizing.maxOpenPerIndex * cfg.indices.length,
    maxOrdersPerDay: Math.max(8, cfg.sizing.maxTradesPerDay * 2 + 2),
    maxLotsPerOrder: 1,
    dailyLossCapInr: Math.round((cfg.capitalRupees * cfg.risk.dailyLossCapPct) / 100),
    maxPremiumPerTradeInr: Math.round((cfg.capitalRupees * cfg.sizing.maxPremiumPctPerTrade) / 100),
    holidayOverrides: [],
    updatedMs: nowMs,
    updatedBy: "system",
  };
}
