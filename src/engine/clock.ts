/**
 * Time abstraction and IST (UTC+05:30, no daylight saving) helpers.
 * The engine never reads Date.now() directly: it asks a Clock, so backtests can replay time.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that only moves when told to. sleep() advances time instantly. */
export class FixedClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const IST_OFFSET_MS = 330 * MINUTE_MS;

/** Market session boundaries in minutes since IST midnight. */
export const SESSION = {
  preOpenStart: 9 * 60,
  open: 9 * 60 + 15,
  close: 15 * 60 + 30,
} as const;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
  /** Minutes since IST midnight. */
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
  const jsDay = d.getUTCDay(); // 0 = Sunday
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

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(ms: number): string {
  return istParts(ms).date;
}

/** Minutes since IST midnight (fractional seconds dropped). */
export function istMinutes(ms: number): number {
  return istParts(ms).minutesOfDay;
}

/** "09:15" -> 555. Throws on malformed input. */
export function parseHHMM(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid HH:MM time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid HH:MM time: ${hhmm}`);
  return h * 60 + min;
}

export function formatHHMM(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** Epoch ms of IST midnight for a YYYY-MM-DD date. */
export function istMidnight(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
}

/** Epoch ms for an IST date and wall-clock time ("HH:MM" or minutes since midnight). */
export function istAt(date: string, time: string | number): number {
  const minutes = typeof time === "number" ? time : parseHHMM(time);
  return istMidnight(date) + minutes * MINUTE_MS;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return istDate(istMidnight(date) + days * DAY_MS + 12 * HOUR_MS);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return istParts(istMidnight(date) + 12 * HOUR_MS).weekday;
}

/** Whole days from date a to date b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((istMidnight(b) - istMidnight(a)) / DAY_MS);
}

/** "2026-10-07 10:00:00 IST" style formatting for logs and messages. */
export function formatIst(ms: number): string {
  const p = istParts(ms);
  return `${p.date} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} IST`;
}

/** Monday (YYYY-MM-DD) of the IST week containing `ms`. */
export function istWeekStart(ms: number): string {
  const p = istParts(ms);
  return addDays(p.date, -(p.weekday - 1));
}
