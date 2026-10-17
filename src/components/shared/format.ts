/**
 * Formatting helpers shared by the dashboard. Numbers use en-IN grouping (1,00,000);
 * times are IST via Intl.DateTimeFormat(timeZone: 'Asia/Kolkata') built from parts, so
 * server and browser render identical strings.
 */
export { formatExpiry as fmtExpiry } from "@/engine/api-types";

const MINUS = "−";

/** Relative age of an ISO date ("NOW", "12m ago", "3h ago", "2d ago"). */
export function timeAgo(dateStr: string, now: number = Date.now()): string {
  const diffMs = now - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "NOW";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function getPriceColor(dir: "up" | "down"): string {
  return dir === "up" ? "#4caf50" : "#f44336";
}

export function getArrow(dir: "up" | "down"): string {
  return dir === "up" ? "▲" : "▼";
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-IN", { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormats.set(key, f);
  }
  return f;
}

/** en-IN grouped number: 22,646.35 / 1,00,000. */
export function fmtNum(n: number, decimals = 2): string {
  return nf(decimals, decimals).format(n);
}

/**
 * Rupees with en-IN grouping: ₹5,18,400 or −₹408. `sign` adds "+" to positives;
 * `compact` renders ₹5.18 L / ₹1.2 Cr for large amounts.
 */
export function fmtInr(n: number, opts: { decimals?: number; sign?: boolean; compact?: boolean } = {}): string {
  const { decimals = 0, sign = false, compact = false } = opts;
  const abs = Math.abs(n);
  let body: string;
  if (compact && abs >= 1e7) body = `${nf(2, 2).format(abs / 1e7)} Cr`;
  else if (compact && abs >= 1e5) body = `${nf(2, 2).format(abs / 1e5)} L`;
  else body = nf(decimals, decimals).format(abs);
  const rounded = Number(abs.toFixed(decimals));
  const prefix = n < 0 && rounded !== 0 ? MINUS : sign && rounded !== 0 ? "+" : "";
  return `${prefix}₹${body}`;
}

/** Signed number: +0.62 / −0.18 / 0.00. */
export function fmtSigned(n: number, decimals = 2): string {
  const s = Math.abs(n).toFixed(decimals);
  if (Number(s) === 0) return (0).toFixed(decimals);
  return `${n < 0 ? MINUS : "+"}${s}`;
}

/** Percent: +0.57% (sign on by default). */
export function fmtPct(n: number, decimals = 2, sign = true): string {
  if (sign) return `${fmtSigned(n, decimals)}%`;
  const s = Math.abs(n).toFixed(decimals);
  return `${n < 0 && Number(s) !== 0 ? MINUS : ""}${s}%`;
}

/** Compact age: 7s, 4m, 2h 5m, 3d. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Clock-style countdown: 3:47:12, 47:12, 0:05 (never negative). */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Human duration for longer horizons: 2d 4h, 3h 23m, 18m, 45s. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** 184,220 -> 184.2k */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------
// IST date/time
// ---------------------------------------------------------------------------

const istFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "short",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface IstFields {
  year: string;
  month: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
  second: string;
}

function istFields(t: number | string): IstFields | null {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const out: Record<string, string> = {};
  for (const p of istFormatter.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: out.year ?? "",
    month: out.month ?? "",
    day: out.day ?? "",
    weekday: out.weekday ?? "",
    hour: out.hour === "24" ? "00" : (out.hour ?? ""),
    minute: out.minute ?? "",
    second: out.second ?? "",
  };
}

/** 11:42:17 */
export function fmtIstTime(t: number | string): string {
  const f = istFields(t);
  return f ? `${f.hour}:${f.minute}:${f.second}` : "—";
}

/** 11:42 */
export function fmtIstHm(t: number | string): string {
  const f = istFields(t);
  return f ? `${f.hour}:${f.minute}` : "—";
}

/** 07 Oct */
export function fmtIstDate(t: number | string): string {
  const f = istFields(t);
  return f ? `${f.day} ${f.month}` : "—";
}

/** Wed 07 Oct */
export function fmtIstDay(t: number | string): string {
  const f = istFields(t);
  return f ? `${f.weekday} ${f.day} ${f.month}` : "—";
}

/** Wed 07 Oct, 10:00 IST */
export function fmtIstDateTime(t: number | string, withSeconds = false): string {
  const f = istFields(t);
  if (!f) return "—";
  return `${f.weekday} ${f.day} ${f.month}, ${f.hour}:${f.minute}${withSeconds ? `:${f.second}` : ""} IST`;
}

/** 07 Oct 2026 */
export function fmtIstFullDate(t: number | string): string {
  const f = istFields(t);
  return f ? `${f.day} ${f.month} ${f.year}` : "—";
}

/** "2026-10-07" -> "Wed 07 Oct" (calendar date, no time zone shift). */
export function fmtDateKey(date: string): string {
  return fmtIstDay(`${date}T12:00:00+05:30`);
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "MACRO_POLICY" -> "MACRO POLICY" */
export function enumLabel(s: string): string {
  return s.replace(/_/g, " ");
}
