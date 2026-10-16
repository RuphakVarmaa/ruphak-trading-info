/** The agent's Worker settings (the AGENT_* vars), with defaults and bounds (SPEC §7.1). */
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

function bounded(raw: string | undefined, fallback: number, min: number, max: number, integer: boolean): number {
  const text = (raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(v) : v;
}

/** A model id as the API takes it, else the default (an empty or garbled var never reaches the API). */
function modelId(raw: string | undefined, fallback: string): string {
  const text = (raw ?? "").trim();
  return /^[A-Za-z0-9._:@/-]{1,100}$/.test(text) ? text : fallback;
}

/** Unknown modes read as "off". The USD cap is clamped to 0..20 (non-numeric: 3) and the escalations to 0..24 a day (non-numeric: 8). */
export function parseAgentSettings(env: {
  AGENT_MODE?: string;
  AGENT_MODEL?: string;
  AGENT_ESCALATION_MODEL?: string;
  AGENT_REVIEW_MODEL?: string;
  AGENT_DAILY_USD_CAP?: string;
  AGENT_ESCALATIONS_PER_DAY?: string;
}): AgentSettings {
  const mode = (env.AGENT_MODE ?? "").trim().toLowerCase();
  const { dailyUsdCap: cap, escalationsPerDay: esc } = AGENT_SETTING_BOUNDS;
  return {
    mode: (AGENT_MODES as readonly string[]).includes(mode) ? (mode as AgentMode) : "off",
    reflexModel: modelId(env.AGENT_MODEL, AGENT_DEFAULTS.reflexModel),
    escalationModel: modelId(env.AGENT_ESCALATION_MODEL, AGENT_DEFAULTS.escalationModel),
    reviewModel: modelId(env.AGENT_REVIEW_MODEL, AGENT_DEFAULTS.reviewModel),
    dailyUsdCap: bounded(env.AGENT_DAILY_USD_CAP, AGENT_DEFAULTS.dailyUsdCap, cap.min, cap.max, false),
    escalationsPerDay: bounded(env.AGENT_ESCALATIONS_PER_DAY, AGENT_DEFAULTS.escalationsPerDay, esc.min, esc.max, true),
  };
}
