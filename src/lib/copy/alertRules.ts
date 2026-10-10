/**
 * When a status change should chime and notify. Pure, so the rules are tested:
 * - nothing on the first look in a tab (it only records what is there);
 * - nothing for statuses that never alert (WAIT, DONE, LOADING, a PAUSED still waiting for its first price);
 * - an ENTER NOW is announced once per trade: after ENTER → PAUSED → ENTER the second ENTER is quiet;
 * - a PAUSED must last 3 s (a tab coming back to the front pauses for a moment while the feed catches up).
 */
import type { IndexAction } from "./action";

export const PAUSE_ALERT_DELAY_MS = 3_000;

export interface AlertMemory {
  /** The status last recorded for this account and index in this tab (null: never). */
  last: string | null;
  /** Trades already announced (or first seen) as ENTER NOW in this tab. */
  entered: ReadonlySet<string>;
}

export interface AlertDecision {
  fire: boolean;
  delayMs: number;
  /** The status to record (after the delay when firing). */
  record: string;
  /** A trade to remember as announced as ENTER NOW, if any. */
  enteredId: string | null;
}

type Status = Pick<IndexAction, "kind" | "statusKey" | "alert"> & { ticket: { id: string } | null };

export function decideAlert(a: Status, mem: AlertMemory): AlertDecision {
  const enteredId = a.kind === "ENTER_NOW" && a.ticket ? a.ticket.id : null;
  const quiet = (): AlertDecision => ({ fire: false, delayMs: 0, record: a.statusKey, enteredId });
  if (mem.last === a.statusKey) return { ...quiet(), enteredId: enteredId && !mem.entered.has(enteredId) ? enteredId : null };
  if (mem.last == null || !a.alert) return quiet();
  if (enteredId && mem.entered.has(enteredId)) return { ...quiet(), enteredId: null };
  return { fire: true, delayMs: a.kind === "PAUSED" ? PAUSE_ALERT_DELAY_MS : 0, record: a.statusKey, enteredId };
}
