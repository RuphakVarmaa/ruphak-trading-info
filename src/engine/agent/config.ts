/** The agent's Worker settings (the AGENT_* vars), with defaults and bounds (SPEC §7.1). */
import { isPricedModel } from "./cost";
import type { AgentMode, AgentSettings } from "./types";

/** What the Worker vars override: the reflex model, the deep model for escalations and for the review, the cap. */
export const AGENT_DEFAULTS: AgentSettings = {
  mode: "off",
  reflexModel: "claude-haiku-5-5",
  escalationModel: "claude-opus-5-5",
  reviewModel: "claude-opus-5-5",
  dailyUsdCap: 3,
  escalationsPerDay: 8,
};

export const AGENT_MODES: readonly AgentMode[] = ["off", "shadow", "paper"];

/** The USD cap a day and the escalations a day may be set only inside these bounds. */
export const AGENT_SETTING_BOUNDS = { dailyUsdCap: { min: 0, max: 20 }, escalationsPerDay: { min: 0, max: 24 } } as const;

/** The Worker vars parseAgentSettings reads. */
export interface AgentSettingsEnv {
  AGENT_MODE?: string;
  AGENT_MODEL?: string;
  AGENT_ESCALATION_MODEL?: string;
  AGENT_REVIEW_MODEL?: string;
  AGENT_DAILY_USD_CAP?: string;
  AGENT_ESCALATIONS_PER_DAY?: string;
}

/** Told about a var that was set but not used as given: its name, its value and why. */
export type IgnoredVar = (varName: string, value: string, reason: string) => void;

function bounded(name: string, raw: string | undefined, fallback: number, min: number, max: number, integer: boolean, onIgnored?: IgnoredVar): number {
  const text = (raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) {
    if (text !== "") onIgnored?.(name, text, `not a number; using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, n));
  const v = integer ? Math.floor(clamped) : clamped;
  if (v !== n) onIgnored?.(name, text, `outside ${min}..${max}${integer ? " or not a whole number" : ""}; using ${v}`);
  return v;
}

/**
 * A model id as the API takes it that has its own row in the price table (cost.ts), else the default: an empty or
 * garbled var never reaches the API, and a model the table cannot price could be billed above the daily cap.
 */
function modelId(name: string, raw: string | undefined, fallback: string, onIgnored?: IgnoredVar): string {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  if (!/^[A-Za-z0-9._:@/-]{1,100}$/.test(text)) {
    onIgnored?.(name, text, `not a model id; using ${fallback}`);
    return fallback;
  }
  if (!isPricedModel(text)) {
    onIgnored?.(name, text, `no row in the agent's price table, so the daily cost cap could not hold; using ${fallback}`);
    return fallback;
  }
  return text;
}

/**
 * Unknown modes read as "off". The USD cap is clamped to 0..20 (non-numeric: 3) and the escalations to 0..24 a day
 * (non-numeric: 8). onIgnored hears of every var that was set but not used as given.
 */
export function parseAgentSettings(env: AgentSettingsEnv, onIgnored?: IgnoredVar): AgentSettings {
  const mode = (env.AGENT_MODE ?? "").trim().toLowerCase();
  const { dailyUsdCap: cap, escalationsPerDay: esc } = AGENT_SETTING_BOUNDS;
  const knownMode = (AGENT_MODES as readonly string[]).includes(mode);
  if (!knownMode && mode !== "") onIgnored?.("AGENT_MODE", (env.AGENT_MODE ?? "").trim(), `not one of ${AGENT_MODES.join(", ")}; using off`);
  return {
    mode: knownMode ? (mode as AgentMode) : "off",
    reflexModel: modelId("AGENT_MODEL", env.AGENT_MODEL, AGENT_DEFAULTS.reflexModel, onIgnored),
    escalationModel: modelId("AGENT_ESCALATION_MODEL", env.AGENT_ESCALATION_MODEL, AGENT_DEFAULTS.escalationModel, onIgnored),
    reviewModel: modelId("AGENT_REVIEW_MODEL", env.AGENT_REVIEW_MODEL, AGENT_DEFAULTS.reviewModel, onIgnored),
    dailyUsdCap: bounded("AGENT_DAILY_USD_CAP", env.AGENT_DAILY_USD_CAP, AGENT_DEFAULTS.dailyUsdCap, cap.min, cap.max, false, onIgnored),
    escalationsPerDay: bounded("AGENT_ESCALATIONS_PER_DAY", env.AGENT_ESCALATIONS_PER_DAY, AGENT_DEFAULTS.escalationsPerDay, esc.min, esc.max, true, onIgnored),
  };
}
