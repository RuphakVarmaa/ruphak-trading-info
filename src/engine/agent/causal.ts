/**
 * Causal views of the market at a bar close T (SPEC §3.1): only data timestamped at or before T. The snapshot is
 * built from these, so nothing after the close can reach the reflex model (snapshot.leak.test.ts).
 */
import type { TradingCalendar } from "../calendar/calendar";
import { SESSION, formatHHMM, istAt, istDate, istMinutes } from "../clock";
import { BAR_5M_MS, lastIndexAtOrBefore } from "../market/candles";
import { MARKET_SYMBOLS, type Candle, type IndexId, type MarketSnapshot, type ScoredEvent } from "../types";

/** Live data: a bar is complete once the index's own bars were observed at least this long after its close. */
export const LIVE_COMPLETE_AFTER_MS = 5_000;
/**
 * Replays, and live snapshots without the index's own data age: a bar counts as complete this long after its
 * close, about when live bars are (Upstox 1-minute candles refresh every 60 s; TE ticks every 30 s).
 */
export const REPLAY_COMPLETE_AFTER_MS = 90_000;

/**
 * The market as it stood at T: 5-minute bars that closed by T (c.t + 5 min ≤ T; Candle.t is the bar's open), daily
 * bars of earlier IST dates only (today's running daily bar may hold later prices), no live LTP (the spot is the
 * last closed bar's close), t = T and no data age (features then compute "now" as T). A new object: the input is
 * not changed, and computeFeatures, which caches per snapshot object, computes afresh.
 */
export function causalMarketSnapshot(snap: MarketSnapshot, barCloseMs: number): MarketSnapshot {
  const today = istDate(barCloseMs);
  const candles: MarketSnapshot["candles"] = {};
  for (const [sym, arr] of Object.entries(snap.candles)) candles[sym] = (arr ?? []).filter((c) => c.t + BAR_5M_MS <= barCloseMs);
  const daily: MarketSnapshot["daily"] = {};
  for (const [sym, arr] of Object.entries(snap.daily)) daily[sym] = (arr ?? []).filter((c) => istDate(c.t) < today);
  return { t: barCloseMs, candles, daily, ltp: {}, dataAgeSec: 0, dataAgeSecByIndex: {} };
}

/** Events scored and first seen at or before T (a re-score replaces a row, so a row scored after T is left out). */
export function causalEvents(events: readonly ScoredEvent[], barCloseMs: number): ScoredEvent[] {
  return events.filter((e) => e.scoredAtMs <= barCloseMs && e.firstSeenMs <= barCloseMs);
}

/** "HH:MM" IST of a bar close. */
export function barCloseIst(barCloseMs: number): string {
  return formatHHMM(istMinutes(barCloseMs));
}

/** The index's 5-minute bar that closes at T (opens at T − 5 min), or null. */
export function barClosingAt(snap: Pick<MarketSnapshot, "candles">, index: IndexId, barCloseMs: number): Candle | null {
  const bars = snap.candles[MARKET_SYMBOLS[index]] ?? [];
  const i = lastIndexAtOrBefore(bars, barCloseMs - BAR_5M_MS);
  return i >= 0 && bars[i].t === barCloseMs - BAR_5M_MS ? bars[i] : null;
}

/**
 * Whether the index's bar closing at T is complete in this snapshot (SPEC-REVIEW #5): the bar is there, and
 * - live data (the snapshot carries asOfMs): the index's bars were observed at least LIVE_COMPLETE_AFTER_MS after
 *   T, read as snap.t − dataAgeSecByIndex[index]. The live sources set that age from the bars alone (the Upstox
 *   overlay from when its 1-minute candles were seen, Yahoo from its bar and trade times); a spot quote refreshed
 *   after T moves asOfMs but never this age, so a bucket still holding a mid-minute close is not complete;
 * - replays (no asOfMs; types.ts) and live data without the index's own age: snap.t ≥ T + REPLAY_COMPLETE_AFTER_MS.
 */
export function barComplete(snap: MarketSnapshot, index: IndexId, barCloseMs: number): boolean {
  if (!barClosingAt(snap, index, barCloseMs)) return false;
  const age = snap.asOfMs === undefined ? undefined : snap.dataAgeSecByIndex?.[index];
  if (typeof age !== "number" || !Number.isFinite(age)) return snap.t >= barCloseMs + REPLAY_COMPLETE_AFTER_MS;
  return snap.t - age * 1000 >= barCloseMs + LIVE_COMPLETE_AFTER_MS;
}

/**
 * The newest 5-minute bar close at or before nowMs inside the session (09:20 to 15:30 IST on a trading day; after
 * the close, the session's last bar), and the indices whose bar ending there is complete (barComplete). Null on a
 * day without a session and before the first bar closes.
 */
export function latestClosedBarMs(snap: MarketSnapshot, indices: readonly IndexId[], nowMs: number, calendar: TradingCalendar): { barCloseMs: number; complete: IndexId[] } | null {
  const date = istDate(nowMs);
  if (!calendar.isTradingDay(date)) return null;
  const openMs = istAt(date, SESSION.open);
  if (nowMs < openMs + BAR_5M_MS) return null;
  const barCloseMs = Math.min(istAt(date, SESSION.close), openMs + Math.floor((nowMs - openMs) / BAR_5M_MS) * BAR_5M_MS);
  return { barCloseMs, complete: indices.filter((index) => barComplete(snap, index, barCloseMs)) };
}
