/** The dashboard's AgentView, built from the AgentDO's records. */
import type { AccountView, AgentView } from "../api-types";
import type { EngineSettings } from "../types";
import type { AgentSettings } from "./types";
import { notImplemented } from "./notImplemented";

/** The view before anything ran (or when the agent account is not enabled). */
export function emptyAgentView(nowMs: number, settings: AgentSettings, enabled: boolean, account: AccountView | null): AgentView {
  return notImplemented(nowMs, settings, enabled, account);
}

/** Overlays the live kill switches (the agent account's and main's) on a view. */
export function withAccountSettings(v: AgentView, agent: Pick<EngineSettings, "killSwitch" | "killReason">, main: Pick<EngineSettings, "killSwitch">): AgentView {
  return notImplemented(v, agent, main);
}
