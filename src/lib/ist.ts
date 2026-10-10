/**
 * Pure IST (UTC+05:30, no daylight saving) helpers shared by the dashboard's server
 * code (mock engine) and client fallbacks. No runtime dependencies.
 */
import type { IndexId, SessionPhase } from "@/engine/api-types";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const IST_OFFSET_MS = 330 * MINUTE_MS;

/** Session boundaries in minutes since IST midnight. */
export const SESSION = {
  preOpen: 9 * 60,
  open: 9 * 60 + 15,
  close: 15 * 60 + 30,
} as const;

/** Weekly expiry weekday per index (ISO weekday: 2 = Tuesday, 4 = Thursday). */
export const EXPIRY_WEEKDAY: Record<IndexId, number> = { NIFTY: 2, SENSEX: 4 };

export interface IstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
  minutesOfDay: number;
  /** YYYY-MM-DD in IST. */
  date: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function istParts(ms: number): IstParts {
  const d = new Date(ms + IST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  const jsDay = d.getUTCDay();
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: jsDay === 0 ? 7 : jsDay,
    minutesOfDay: hour * 60 + minute,
    date: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

export function istDate(ms: number): string {
  return istParts(ms).date;
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Epoch ms of IST midnight for YYYY-MM-DD. */
export function istMidnight(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
}

/** Epoch ms for an IST date and wall-clock time ("HH:MM", "HH:MM:SS" or minutes since midnight). */
export function istAt(date: string, time: string | number): number {
  if (typeof time === "number") return istMidnight(date) + time * MINUTE_MS;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) throw new Error(`Invalid time: ${time}`);
  return istMidnight(date) + (Number(m[1]) * 60 + Number(m[2])) * MINUTE_MS + Number(m[3] ?? 0) * 1000;
}

export function addDays(date: string, days: number): string {
  return istDate(istMidnight(date) + days * DAY_MS + 12 * HOUR_MS);
}

export function weekdayOf(date: string): number {
  return istParts(istMidnight(date) + 12 * HOUR_MS).weekday;
}

export function isWeekend(date: string): boolean {
  return weekdayOf(date) >= 6;
}

export type HolidayCheck = (date: string) => boolean;
const noHolidays: HolidayCheck = () => false;

export function isTradingDay(date: string, isHoliday: HolidayCheck = noHolidays): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

/** "2026-10-07T11:42:17+05:30" (second precision). */
export function toIstIso(ms: number): string {
  const p = istParts(ms);
  return `${p.date}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+05:30`;
}

/** Most recent trading day on or before `date`. */
export function tradingDayOnOrBefore(date: string, isHoliday: HolidayCheck = noHolidays): string {
  let d = date;
  for (let i = 0; i < 14 && !isTradingDay(d, isHoliday); i++) d = addDays(d, -1);
  return d;
}

/** Next trading day strictly after `date`. */
export function nextTradingDay(date: string, isHoliday: HolidayCheck = noHolidays): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 14 && !isTradingDay(d, isHoliday); i++) d = addDays(d, 1);
  return d;
}

/** Previous trading day strictly before `date`. */
export function prevTradingDay(date: string, isHoliday: HolidayCheck = noHolidays): string {
  return tradingDayOnOrBefore(addDays(date, -1), isHoliday);
}

export function sessionPhaseAt(ms: number, isHoliday: HolidayCheck = noHolidays): SessionPhase {
  const p = istParts(ms);
  if (p.weekday >= 6) return "CLOSED";
  if (isHoliday(p.date)) return "HOLIDAY";
  if (p.minutesOfDay >= SESSION.open && p.minutesOfDay < SESSION.close) return "OPEN";
  if (p.minutesOfDay >= SESSION.preOpen && p.minutesOfDay < SESSION.open) return "PRE_OPEN";
  return "CLOSED";
}

/** Next session open at or after `ms` (the current session's open counts only if it is still ahead). */
export function nextSessionOpen(ms: number, isHoliday: HolidayCheck = noHolidays): number {
  const today = istDate(ms);
  if (isTradingDay(today, isHoliday)) {
    const open = istAt(today, SESSION.open);
    if (ms < open) return open;
  }
  return istAt(nextTradingDay(today, isHoliday), SESSION.open);
}

/** Close of the current session, or of the next session when the market is not open now. */
export function nextSessionClose(ms: number, isHoliday: HolidayCheck = noHolidays): number {
  const today = istDate(ms);
  if (isTradingDay(today, isHoliday)) {
    const close = istAt(today, SESSION.close);
    if (ms < close) return close;
  }
  return istAt(nextTradingDay(today, isHoliday), SESSION.close);
}

/**
 * Nearest weekly expiry date (YYYY-MM-DD) for an index: NIFTY Tuesday, SENSEX Thursday.
 * Today counts until 15:30 IST. A holiday on the expiry weekday moves it to the previous
 * trading day (only when a holiday check is supplied; the client fallback knows weekends only).
 */
export function nextWeeklyExpiry(index: IndexId, ms: number, isHoliday: HolidayCheck = noHolidays): string {
  const p = istParts(ms);
  const target = EXPIRY_WEEKDAY[index];
  let date = p.date;
  for (let i = 0; i < 21; i++) {
    if (weekdayOf(date) === target) {
      const actual = tradingDayOnOrBefore(date, isHoliday);
      const cutoff = istAt(actual, SESSION.close);
      if (ms < cutoff) return actual;
    }
    date = addDays(date, 1);
  }
  return date;
}

/** Today's IST calendar date (request-time helper for server components). */
export function todayIst(): string {
  return istDate(Date.now());
}
