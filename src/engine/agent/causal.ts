/**
 * Causal views of the market at a bar close T (SPEC §3.1): only data timestamped at or before T. The snapshot is
 * built from these, so nothing after the close can reach the reflex model (snapshot.leak.test.ts).
 */
import type { TradingCalendar } from "../calendar/calendar";
import { SESSION, formatHHMM, istAt, istDate, istMinutes } from "../clock";
import { BAR_5M_MS } from "../market/candles";
import { MARKET_SYMBOLS, type IndexId, type MarketSnapshot, type ScoredEvent } from "../types";

/** A live bar counts as complete once the index's bars were observed this long after its close. */
export const LIVE_COMPLETE_AFTER_MS = 5_000;
/** Without a live observation time (replays), a bar counts as complete this long after its close. */
export const REPLAY_COMPLETE_AFTER_MS = 90_000;

/**
 * The market as it stood at T: 5-minute bars that closed by T (c.t + 5 min ≤ T; Candle.t is the bar's open), daily
 * bars of earlier IST dates only (today's running daily bar may hold later prices), no live LTP (spot is the last
 * closed bar's close), t = T and no data age (features then compute "now" as T).
 */
export function causalMarketSnapshot(snap: MarketSnapshot, barCloseMs: number): MarketSnapshot {
  const today = istDate(barCloseMs);
  const candles: MarketSnapshot["candles"] = {};
  for (const [sym, arr] of Object.entries(snap.candles)) candles[sym] = (arr ?? []).filter((c) => c.t + BAR_5M_MS <= barCloseMs);
  const daily: MarketSnapshot["daily"] = {};
  for (const [sym, arr] of Object.entries(snap.daily)) daily[sym] = (arr ?? []).filter((c) => istDate(c.t) < today);
  return { t: barCloseMs, candles, daily, ltp: {}, dataAgeSec: 0, dataAgeSecByIndex: {} };
}

/** Events scored and first seen at or before T (a re-score replaces a row, so the score is the one known at T). */
export function causalEvents(events: ScoredEvent[], barCloseMs: number): ScoredEvent[] {
  return events.filter((e) => e.scoredAtMs <= barCloseMs && e.firstSeenMs <= barCloseMs);
}

/** "HH:MM" IST of a bar close. */
export function barCloseIst(barCloseMs: number): string {
  return formatHHMM(istMinutes(barCloseMs));
}

/**
 * When the index's bars were last observed (epoch ms): the snapshot time less the index's own data age, which the
 * live sources set from the bars (the Upstox overlay from when its 1-minute candles were seen, never from the spot
 * quote). Null when unknown.
 */
function observedMs(snap: MarketSnapshot, index: IndexId): number | null {
  const age = snap.dataAgeSecByIndex?.[index];
  if (typeof age === "number" && Number.isFinite(age)) return snap.t - age * 1000;
  return null;
}

/**
 * The newest 5-minute bar close at or before nowMs inside the session (09:20 to 15:30 IST on a trading day), and the
 * indices whose bar ending there is complete; null outside the session or before the first bar.
 *
 * Complete: the bar that opened at T − 5 min is in the snapshot, and
 * - live data (the snapshot carries asOfMs): the index's bars were observed at least 5 s after T, so the last
 *   bucket is not a partial one (a spot quote refreshed after T does not count);
 * - replays (no asOfMs; a replay only shows closed bars): the snapshot is at least 90 s after T, as live bars are.
 */
export function latestClosedBarMs(snap: MarketSnapshot, indices: readonly IndexId[], nowMs: number, calendar: TradingCalendar): { barCloseMs: number; complete: IndexId[] } | null {
  const date = istDate(nowMs);
  if (!calendar.isTradingDay(date)) return null;
  const openMs = istAt(date, SESSION.open);
  const closeMs = istAt(date, SESSION.close);
  if (nowMs < openMs + BAR_5M_MS) return null;
  const barCloseMs = Math.min(closeMs, openMs + Math.floor((nowMs - openMs) / BAR_5M_MS) * BAR_5M_MS);
  const live = snap.asOfMs !== undefined;
  const complete = indices.filter((index) => {
    const bars = snap.candles[MARKET_SYMBOLS[index]] ?? [];
    let has = false;
    for (let i = bars.length - 1; i >= 0 && bars[i].t >= barCloseMs - BAR_5M_MS; i--) {
      if (bars[i].t === barCloseMs - BAR_5M_MS) has = true;
    }
    if (!has) return false;
    if (!live) return snap.t >= barCloseMs + REPLAY_COMPLETE_AFTER_MS;
    const seen = observedMs(snap, index);
    return seen !== null && seen >= barCloseMs + LIVE_COMPLETE_AFTER_MS;
  });
  return { barCloseMs, complete };
}
