import type { EngineConfig } from "./config";
import type { EngineSettings, TradingMode } from "./types";

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

/**
 * True when every engine-side key for live orders is turned: the Worker var LIVE_TRADING,
 * settings.mode LIVE and an unexpired arm (the relay's RELAY_LIVE is the fourth, checked there).
 */
export function isLiveArmed(s: EngineSettings, liveTradingEnabled: boolean, nowMs: number): boolean {
  return liveTradingEnabled && s.mode === "LIVE" && s.armedUntil !== null && s.armedUntil > nowMs && !s.killSwitch;
}

/** Mode new entries are taken in right now: LIVE only when fully armed, otherwise PAPER. */
export function entryMode(s: EngineSettings, liveTradingEnabled: boolean, nowMs: number): Extract<TradingMode, "PAPER" | "LIVE"> {
  return isLiveArmed(s, liveTradingEnabled, nowMs) ? "LIVE" : "PAPER";
}

/** Mode whose ledger and performance the dashboard shows. */
export function displayMode(s: EngineSettings, liveTradingEnabled: boolean): Extract<TradingMode, "PAPER" | "LIVE"> {
  return liveTradingEnabled && s.mode === "LIVE" ? "LIVE" : "PAPER";
}
