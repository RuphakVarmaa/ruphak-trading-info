/**
 * Client fallbacks for market timing when the engine state is unavailable. Weekends only:
 * the engine provides holiday-aware values in EngineStateDTO.market.
 */
import type { IndexId, SessionPhase } from "@/engine/api-types";
import { nextSessionOpen, nextWeeklyExpiry, sessionPhaseAt } from "@/lib/ist";

export function fallbackPhase(now: number): SessionPhase {
  return sessionPhaseAt(now);
}

export function fallbackNextOpen(now: number): number {
  return nextSessionOpen(now);
}

/** NIFTY Tuesday / SENSEX Thursday, today until 15:30 IST. */
export function fallbackNextExpiry(index: IndexId, now: number): string {
  return nextWeeklyExpiry(index, now);
}

export const PHASE_LABEL: Record<SessionPhase, string> = {
  OPEN: "OPEN",
  PRE_OPEN: "PRE-OPEN",
  CLOSED: "CLOSED",
  HOLIDAY: "HOLIDAY",
};
