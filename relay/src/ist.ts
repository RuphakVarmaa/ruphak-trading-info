// India Standard Time helpers. IST is a fixed UTC+05:30 offset (India has no DST), so
// plain arithmetic is exact and no timezone database is needed.

export const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  /** YYYY-MM-DD in IST */
  date: string;
  /** Seconds since 00:00 IST */
  secondOfDay: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function istParts(ms: number): IstParts {
  const d = new Date(ms + IST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: d.getUTCDay(),
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    secondOfDay: hour * 3600 + minute * 60 + second,
  };
}

export function istDate(ms: number): string {
  return istParts(ms).date;
}

/** Epoch ms of 00:00 IST on the IST calendar day that contains `ms`. */
export function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** Epoch ms of `minuteOfDay` (minutes after 00:00 IST) on the IST day that contains `ms`. */
export function istTimeOnDay(ms: number, minuteOfDay: number): number {
  return istDayStartMs(ms) + minuteOfDay * 60_000;
}

/** Next epoch ms strictly after `ms` at which the IST wall clock reads `minuteOfDay`. */
export function nextIstTime(ms: number, minuteOfDay: number): number {
  const today = istTimeOnDay(ms, minuteOfDay);
  return today > ms ? today : today + DAY_MS;
}

/** "09:16" -> 556 (minutes after midnight). Throws on malformed input. */
export function parseHhMm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`expected HH:MM, got "${value}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time "${value}"`);
  return h * 60 + min;
}

export function formatHhMm(minuteOfDay: number): string {
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

export interface TimeWindow {
  /** Minutes after 00:00 IST, inclusive. */
  startMin: number;
  /** Minutes after 00:00 IST, exclusive. */
  endMin: number;
}

/** "09:16-15:12" -> { startMin: 556, endMin: 912 }. */
export function parseWindow(value: string): TimeWindow {
  const parts = value.split("-");
  if (parts.length !== 2) throw new Error(`expected HH:MM-HH:MM, got "${value}"`);
  const startMin = parseHhMm(parts[0] ?? "");
  const endMin = parseHhMm(parts[1] ?? "");
  if (endMin <= startMin) throw new Error(`window end must be after start in "${value}"`);
  return { startMin, endMin };
}

export function formatWindow(w: TimeWindow): string {
  return `${formatHhMm(w.startMin)}-${formatHhMm(w.endMin)}`;
}

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? "?";
}

/** "Tue 2026-10-06 15:13:05 IST", for log lines and rejection reasons. */
export function describeIst(ms: number): string {
  const p = istParts(ms);
  return `${weekdayName(p.weekday)} ${p.date} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} IST`;
}

/**
 * Parses a timestamp from an API response. Numbers are epoch seconds or milliseconds;
 * ISO strings without an offset (Groww returns e.g. "2024-07-01T12:34:56") are read as IST.
 * Returns null when the value cannot be interpreted.
 */
export function parseIstTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseIstTimestamp(Number(s));
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const ms = Date.parse(hasZone ? iso : `${iso}+05:30`);
  return Number.isFinite(ms) ? ms : null;
}
