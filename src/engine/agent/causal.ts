/** Causal views of the market at a bar close: only data timestamped at or before the close (SPEC §3.1). */
import type { TradingCalendar } from "../calendar/calendar";
import type { IndexId, MarketSnapshot } from "../types";
import { notImplemented } from "./notImplemented";

/**
 * The newest 5-minute bar close at or before nowMs inside the session, and the indices whose bar ending there is
 * complete; null outside the session or before the first bar.
 */
export function latestClosedBarMs(snap: MarketSnapshot, indices: readonly IndexId[], nowMs: number, calendar: TradingCalendar): { barCloseMs: number; complete: IndexId[] } | null {
  return notImplemented(snap, indices, nowMs, calendar);
}
