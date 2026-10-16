/** The agent account's risk snapshot and its drawdown halt (SPEC §5.5). */
import type { RiskState } from "../types";
import type { AgentRiskSnapshot } from "./types";
import { notImplemented } from "./notImplemented";

export function riskSnapshotFrom(
  r: RiskState,
  prevPeak: number | null,
  flags: { killSwitch: boolean; killReason: string | null; mainKillSwitch: boolean; ddHalt: boolean; nowMs: number },
): AgentRiskSnapshot {
  return notImplemented(r, prevPeak, flags);
}

/** True when the drawdown from peak equity reached AGENT_LIMITS.maxDrawdownPct. */
export function drawdownBreached(s: AgentRiskSnapshot): boolean {
  return notImplemented(s);
}
