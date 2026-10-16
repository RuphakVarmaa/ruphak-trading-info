/** The agent's Worker settings (AGENT_* vars), with defaults and bounds (SPEC §7.1). */
import type { AgentMode, AgentSettings } from "./types";

/** The defaults the Worker vars override: the reflex model, the deep model for escalations and the review. */
export const AGENT_DEFAULTS: AgentSettings = {
  mode: "off",
  reflexModel: "claude-haiku-5-5",
  escalationModel: "claude-opus-5-5",
  reviewModel: "claude-opus-5-5",
  dailyUsdCap: 3,
  escalationsPerDay: 8,
};

const MODES: readonly AgentMode[] = ["off", "shadow", "paper"];

function bounded(raw: string | undefined, fallback: number, min: number, max: number, integer: boolean): number {
  const text = (raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(v) : v;
}

const model = (raw: string | undefined, fallback: string) => {
  const text = (raw ?? "").trim();
  return /^[A-Za-z0-9._:@/-]{1,100}$/.test(text) ? text : fallback;
};

/** Unknown modes read as "off"; the USD cap is clamped to 0..20 and the escalations to 0..24 a day. */
export function parseAgentSettings(env: {
  AGENT_MODE?: string;
  AGENT_MODEL?: string;
  AGENT_ESCALATION_MODEL?: string;
  AGENT_REVIEW_MODEL?: string;
  AGENT_DAILY_USD_CAP?: string;
  AGENT_ESCALATIONS_PER_DAY?: string;
}): AgentSettings {
  const mode = (env.AGENT_MODE ?? "").trim().toLowerCase();
  return {
    mode: (MODES as readonly string[]).includes(mode) ? (mode as AgentMode) : "off",
    reflexModel: model(env.AGENT_MODEL, AGENT_DEFAULTS.reflexModel),
    escalationModel: model(env.AGENT_ESCALATION_MODEL, AGENT_DEFAULTS.escalationModel),
    reviewModel: model(env.AGENT_REVIEW_MODEL, AGENT_DEFAULTS.reviewModel),
    dailyUsdCap: bounded(env.AGENT_DAILY_USD_CAP, AGENT_DEFAULTS.dailyUsdCap, 0, 20, false),
    escalationsPerDay: bounded(env.AGENT_ESCALATIONS_PER_DAY, AGENT_DEFAULTS.escalationsPerDay, 0, 24, true),
  };
}
