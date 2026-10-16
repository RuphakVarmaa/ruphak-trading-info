/**
 * Pure text helpers for the Advisor page: plain contract names, days to expiry, the one-line order,
 * "written 3 min ago", the rate-limit line, factor order and the past-brief check. No React, so the
 * wording is unit-tested (advisorText.test.ts).
 */
import type {
  AdvisorConfidence,
  AdvisorFactor,
  AdvisorFactorKey,
  AdvisorHorizon,
  AdvisorIdea,
  AdvisorLean,
  AdvisorView,
  IndexId,
  OptionType,
} from "@/engine/api-types";
import { fmtDateKey, fmtInr, fmtIstDay, fmtIstHm, fmtNum } from "@/components/shared/format";
import { istDate } from "@/lib/ist";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const HORIZONS: readonly AdvisorHorizon[] = ["TODAY", "WEEK", "MONTH"];
export const HORIZON_WORDS: Record<AdvisorHorizon, string> = { TODAY: "Today", WEEK: "This week", MONTH: "This month" };

export const LEAN_META: Record<AdvisorLean, { glyph: string; word: string }> = {
  UP: { glyph: "▲", word: "Up" },
  DOWN: { glyph: "▼", word: "Down" },
  SIDEWAYS: { glyph: "▬", word: "Sideways" },
};

export const CONFIDENCE_WORDS: Record<AdvisorConfidence, string> = { LOW: "Low confidence", MEDIUM: "Medium confidence", HIGH: "High confidence" };

export const READING_META: Record<AdvisorFactor["reading"], { glyph: string; word: string }> = {
  SUPPORTS_UP: { glyph: "▲", word: "Points up" },
  SUPPORTS_DOWN: { glyph: "▼", word: "Points down" },
  NEUTRAL: { glyph: "▬", word: "Neutral" },
  RISK: { glyph: "!", word: "Risk" },
  NO_DATA: { glyph: "?", word: "No data" },
};

export const PREMIUM_WORDS: Record<"CHEAP" | "NORMAL" | "EXPENSIVE" | "NO_DATA", string> = { CHEAP: "Cheap", NORMAL: "Normal", EXPENSIVE: "Expensive", NO_DATA: "No data" };

/** The order the page lists the factors in; anything else comes last. */
export const FACTOR_ORDER: readonly AdvisorFactorKey[] = [
  "FII_DII",
  "NEWS_UNCERTAINTY",
  "GLOBAL_CUES",
  "SHORT_COVERING",
  "OPTIONS_POSITIONING",
  "VOLATILITY_PREMIUM",
  "TREND",
  "EVENTS",
  "OTHER",
];

export function sortFactors(factors: readonly AdvisorFactor[]): AdvisorFactor[] {
  const rank = (k: AdvisorFactorKey) => {
    const i = FACTOR_ORDER.indexOf(k);
    return i < 0 ? FACTOR_ORDER.length : i;
  };
  return factors.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.key) - rank(b.f.key) || a.i - b.i).map((x) => x.f);
}

/** Ideas grouped Today / This week / This month, empty groups left out, the model's order kept within a group. */
export function groupIdeas(ideas: readonly AdvisorIdea[]): { horizon: AdvisorHorizon; ideas: AdvisorIdea[] }[] {
  return HORIZONS.map((horizon) => ({ horizon, ideas: ideas.filter((i) => i.horizon === horizon) })).filter((g) => g.ideas.length > 0);
}

// ---------------------------------------------------------------------------
// Dates and contracts
// ---------------------------------------------------------------------------

/** Calendar days from today (IST) to an expiry date YYYY-MM-DD: 0 today, 1 tomorrow, negative once past. */
export function daysToExpiry(expiry: string, nowMs: number): number {
  const a = Date.parse(`${istDate(nowMs)}T00:00:00Z`);
  const b = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / DAY_MS);
}

/** "today", "tomorrow", "7 days", "expired". */
export function daysWords(days: number): string {
  if (!Number.isFinite(days)) return "date unknown";
  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days} days`;
}

/** "2026-10-23" -> "23-Oct". */
export function shortExpiry(expiry: string): string {
  const [, m, d] = expiry.split("-");
  const month = MONTHS[Number(m) - 1];
  return month && d ? `${d}-${month}` : expiry;
}

/** "CE" -> "CALL" (gains when the index rises), "PE" -> "PUT" (gains when it falls). */
export function optionWord(t: OptionType): "CALL" | "PUT" {
  return t === "CE" ? "CALL" : "PUT";
}

/** "NIFTY 23200 CALL, expires Thu 23 Oct (7 days)". */
export function plainContract(c: { index: IndexId; expiry: string; strike: number; optionType: OptionType }, nowMs: number): string {
  const days = daysToExpiry(c.expiry, nowMs);
  const when = days === 0 ? "expires today" : days < 0 ? `expired ${fmtDateKey(c.expiry)}` : `expires ${fmtDateKey(c.expiry)} (${daysWords(days)})`;
  return `${c.index} ${c.strike} ${optionWord(c.optionType)}, ${when}`;
}

/** A premium in rupees: whole rupees without decimals, otherwise two ("₹142.50", "₹98"). */
export function premium(n: number): string {
  return fmtInr(n, { decimals: Number.isInteger(n) ? 0 : 2 });
}

/** Whole rupees ("₹9,263"). */
export function rupees(n: number): string {
  return fmtInr(Math.round(n));
}

/** The one-line order: "BUY NIFTY 23200 CE 23-Oct · 1 lot · buy between ₹X–Y · stop ₹S · target ₹T · max loss ₹L". */
export function ideaLine(idea: AdvisorIdea): string {
  const c = idea.contract;
  const lots = Math.max(1, idea.lots);
  return [
    `BUY ${c.index} ${c.strike} ${c.optionType} ${shortExpiry(c.expiry)}`,
    `${lots} lot${lots === 1 ? "" : "s"}`,
    `buy between ${premium(idea.entry.low)}–${premium(idea.entry.high).replace("₹", "")}`,
    `stop ${premium(idea.stop)}`,
    `target ${premium(idea.target)}`,
    `max loss ${rupees(idea.maxLossPerLot * lots)}`,
  ].join(" · ");
}

/** The options-page link for a contract's expiry. */
export function chainHref(c: { index: IndexId; expiry: string }): string {
  return `/options?index=${encodeURIComponent(c.index)}&expiry=${encodeURIComponent(c.expiry)}`;
}

/** "≈ 52%" from a 0..1 probability; null when unknown. */
export function chanceWords(p: number | null): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  const pct = Math.round(Math.min(1, Math.max(0, Math.abs(p))) * 100);
  return pct < 1 ? "under 1%" : `≈ ${pct}%`;
}

/** Index range "22,480 – 22,810"; null when either end is unknown. */
export function rangeWords(low: number | null, high: number | null): string | null {
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  return `${fmtNum(Math.min(low, high), 0)} – ${fmtNum(Math.max(low, high), 0)}`;
}

/** An IST date-time for people ("Tue 20 Oct, 14:30 IST"); the raw text when it is not a date. */
export function exitByWords(exitBy: string, nowMs: number | null): string {
  const ms = Date.parse(exitBy);
  if (!Number.isFinite(ms)) return exitBy;
  const sameDay = nowMs != null && istDate(ms) === istDate(nowMs);
  return sameDay ? `today, ${fmtIstHm(ms)} IST` : `${fmtIstDay(ms)}, ${fmtIstHm(ms)} IST`;
}

// ---------------------------------------------------------------------------
// The top bar: when it was written, the model, the cost, the rate limit
// ---------------------------------------------------------------------------

/** "just now", "3 min ago", "2 h 5 min ago", "yesterday", "3 days ago". */
export function agoWords(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min ago` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "Written 12:41 IST, 3 min ago"; the day is added when it was not written today; no age before the clock is known. */
export function writtenLine(createdAt: string, nowMs: number | null): string {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return "Written at an unknown time";
  const today = nowMs != null && istDate(ms) === istDate(nowMs);
  const when = today || nowMs == null ? `${fmtIstHm(ms)} IST` : `${fmtIstDay(ms)}, ${fmtIstHm(ms)} IST`;
  return nowMs == null ? `Written ${when}` : `Written ${when}, ${agoWords(nowMs - ms)}`;
}

/** "Claude Opus 5.5" for the model id; other ids are shown as they are. */
export function modelName(model: string): string {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(model.trim());
  if (!m) return model;
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}.${m[3]}`;
}

/** "$0.38", "under $0.01"; null when unknown. */
export function costWords(usd: number | null): string | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

export function isBusy(status: AdvisorView["status"]): boolean {
  return status === "queued" || status === "running";
}

/** "Next analysis possible at 12:45" while the rate limit holds; null once it has passed (or without one). */
export function nextAllowedLine(nextAllowedAt: string | null, nowMs: number | null): string | null {
  if (!nextAllowedAt) return null;
  const ms = Date.parse(nextAllowedAt);
  if (!Number.isFinite(ms)) return null;
  if (nowMs != null && ms <= nowMs) return null;
  const sameDay = nowMs == null || istDate(ms) === istDate(nowMs);
  return `Next analysis possible at ${sameDay ? "" : `${fmtIstDay(ms)}, `}${fmtIstHm(ms)} IST`;
}

/** The status line next to the button. */
export function statusWords(view: AdvisorView): string | null {
  if (view.status === "queued") return "Analyzing… about 1–2 minutes (waiting to start)";
  if (view.status === "running") return "Analyzing… about 1–2 minutes";
  return null;
}

// ---------------------------------------------------------------------------
// Past briefs: what a contract is worth now vs when the brief was written
// ---------------------------------------------------------------------------

export interface ParsedContract {
  index: IndexId;
  expiry: string;
  strike: number;
  optionType: OptionType;
}

const MONTH_INDEX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m.toUpperCase(), i + 1]));

/**
 * Reads index, expiry, strike and CE/PE out of a contract label such as "NIFTY 20-OCT-2026 22650 CE"
 * (the engine's contractLabel), "NIFTY 22650 CE 2026-10-20" or "SENSEX 20 Oct 2026 82000 PE"; null when any part is missing.
 */
export function parseContractLabel(label: string): ParsedContract | null {
  const text = label.toUpperCase();
  const idx = /\b(NIFTY|SENSEX)\b/.exec(text)?.[1] as IndexId | undefined;
  const type = /\b(CE|PE|CALL|PUT)\b/.exec(text)?.[1];
  let expiry: string | null = null;
  let rest = text;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const dmy = /\b(\d{1,2})[-\s]([A-Z]{3})[A-Z]*[-\s](\d{4})\b/.exec(text);
  if (iso) {
    expiry = `${iso[1]}-${iso[2]}-${iso[3]}`;
    rest = text.replace(iso[0], " ");
  } else if (dmy && MONTH_INDEX[dmy[2]]) {
    expiry = `${dmy[3]}-${String(MONTH_INDEX[dmy[2]]).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    rest = text.replace(dmy[0], " ");
  }
  const strike = /\b(\d{4,6})(?:\.\d+)?\b/.exec(rest)?.[1];
  if (!idx || !type || !expiry || !strike) return null;
  return { index: idx, expiry, strike: Number(strike), optionType: type === "CE" || type === "CALL" ? "CE" : "PE" };
}

/** "NIFTY|2026-10-20": one chain request per index and expiry. */
export function chainKey(c: { index: IndexId; expiry: string }): string {
  return `${c.index}|${c.expiry}`;
}

/** How a past idea is doing: the price now against the ask when the brief was written, and whether it passed the stop or the target. */
export function pastCheck(idea: { entryAsk: number; stop: number; target: number }, ltp: number): { changePct: number; words: string; tone: "up" | "down" | "flat" } {
  const changePct = idea.entryAsk > 0 ? ((ltp - idea.entryAsk) / idea.entryAsk) * 100 : 0;
  const pct = Math.abs(changePct).toFixed(0);
  const move = Math.abs(changePct) < 0.5 ? "about the same" : changePct > 0 ? `up ${pct}%` : `down ${pct}%`;
  const where = ltp >= idea.target ? ": at or above the target" : ltp <= idea.stop ? ": at or below the stop" : "";
  return {
    changePct,
    words: `Now ${premium(ltp)} vs ${premium(idea.entryAsk)} when written (${move})${where}`,
    tone: Math.abs(changePct) < 0.5 ? "flat" : changePct > 0 ? "up" : "down",
  };
}

// ---------------------------------------------------------------------------
// Sources: links the model wrote, so only http(s) and this site's own paths are ever rendered as links
// ---------------------------------------------------------------------------

/** The URL when it is http(s) or a path on this site; null otherwise (javascript:, data:, protocol-relative …). */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^\/(?![/\\])/.test(u)) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** "economictimes.indiatimes.com" for an external link, "this site" for a path. */
export function sourceHost(url: string): string {
  if (url.startsWith("/")) return "this site";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
