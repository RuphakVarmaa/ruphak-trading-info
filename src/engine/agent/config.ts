/** The agent's Worker settings (AGENT_* vars), with defaults and bounds (SPEC §7.1). */
import type { AgentSettings } from "./types";
import { notImplemented } from "./notImplemented";

export function parseAgentSettings(env: {
  AGENT_MODE?: string;
  AGENT_MODEL?: string;
  AGENT_ESCALATION_MODEL?: string;
  AGENT_REVIEW_MODEL?: string;
  AGENT_DAILY_USD_CAP?: string;
  AGENT_ESCALATIONS_PER_DAY?: string;
}): AgentSettings {
  return notImplemented(env);
}
