/**
 * Trading-time clock for option pricing: only minutes inside the 09:15-15:30 IST session on
 * trading days count, so weekends and holidays carry no theta (NSE/BSE options decay by session).
 */
import type { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, SESSION, addDays, istAt, istDate } from "../clock";
import type { EngineConfig } from "../config";

/** Trading minutes (fractional) between two instants; 0 when toMs <= fromMs. */
export function tradingMinutesBetween(fromMs: number, toMs: number, calendar: TradingCalendar): number {
  if (!(toMs > fromMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  const lastDate = istDate(toMs);
  let date = istDate(fromMs);
  let total = 0;
  // Bounded loop: one iteration per calendar day in the range.
  for (let guard = 0; date <= lastDate && guard < 10_000; guard++) {
    if (calendar.isTradingDay(date)) {
      const open = istAt(date, SESSION.open);
      const close = istAt(date, SESSION.close);
      const a = Math.max(fromMs, open);
      const b = Math.min(toMs, close);
      if (b > a) total += (b - a) / MINUTE_MS;
    }
    date = addDays(date, 1);
  }
  return total;
}

/** Epoch ms of an expiry's last trading moment (15:30 IST on the expiry date). */
export function expiryCloseMs(expiry: string): number {
  return istAt(expiry, SESSION.close);
}

/**
 * Years of trading time from `nowMs` to the expiry's 15:30 IST close:
 * tradingMinutes / (tradingMinutesPerDay * tradingDaysPerYear), floored at one minute's worth
 * (so pricing on or after the expiry close still returns a small positive time).
 */
export function yearsToExpiry(nowMs: number, expiry: string, calendar: TradingCalendar, cfg: EngineConfig): number {
  const minutesPerYear = cfg.pricing.tradingMinutesPerDay * cfg.pricing.tradingDaysPerYear;
  const minutes = tradingMinutesBetween(nowMs, expiryCloseMs(expiry), calendar);
  return Math.max(minutes, 1) / minutesPerYear;
}
