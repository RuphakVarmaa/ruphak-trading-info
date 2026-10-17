/**
 * The finalists the reflex model judges on each bar (SPEC §2.1 as amended, #6): one generic finalist per index
 * (that index's best long or short now, or neutral), plus the ideas of the Advisor brief that existed at the bar
 * close: created at or before it, on the same IST date. A brief written after the close never reaches the bar,
 * its finalists or its context, so a decision never uses research the market did not have at the close.
 */
import type { AdvisorIdea, AdvisorReport } from "../api-types";
import { istDate } from "../clock";
import type { IndexId } from "../types";
import { AGENT_POLICY } from "./constants";
import type { BriefContext, Finalist } from "./types";

/** Text limits (characters) on the brief's words a finalist and the brief context carry. */
export const FINALIST_TEXT = {
  condition: 200,
  wrongIf: 200,
  bearCase: 200,
  whyItems: 2,
  why: 120,
  label: 80,
  headline: 160,
  factors: 4,
  factor: 100,
} as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One line of plain text: control characters and runs of whitespace become one space; cut to `max` with "…". */
export function clipText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const clipOrNull = (s: unknown, max: number): string | null => clipText(s, max) || null;

export function genericFinalist(index: IndexId): Finalist {
  return {
    id: `gen:${index}`,
    kind: "GENERIC",
    index,
    label: `${index}, either side (generic call)`,
    side: null,
    contract: null,
    entryHigh: null,
    condition: null,
    wrongIf: null,
    bearCase: null,
    why: [],
    horizon: null,
    briefId: null,
  };
}

/** The brief as it stood at nowMs (the bar close): itself when created at or before nowMs on the same IST date, else null. */
export function briefAsOf(brief: AdvisorReport | null | undefined, nowMs: number): AdvisorReport | null {
  if (!brief) return null;
  const created = Date.parse(brief.createdAt);
  if (!Number.isFinite(created) || created > nowMs || istDate(created) !== istDate(nowMs)) return null;
  return brief;
}

/** "NIFTY 25100 CE 23 Oct". */
function contractText(c: { expiry: string; strike: number; type: string }, index: IndexId): string {
  const [, m, d] = c.expiry.split("-").map(Number);
  return `${index} ${c.strike} ${c.type} ${d} ${MONTHS[m - 1] ?? "?"}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One idea as a finalist; null when it cannot be bought from this bar on (another index, expires today, malformed). */
function ideaFinalist(brief: AdvisorReport, idea: AdvisorIdea, indices: readonly IndexId[], today: string): Finalist | null {
  const c = idea.contract;
  if (!c || !indices.includes(c.index)) return null;
  if (typeof c.expiry !== "string" || !DATE.test(c.expiry) || c.expiry <= today) return null;
  if (c.optionType !== "CE" && c.optionType !== "PE") return null;
  if (!(Number.isFinite(c.strike) && c.strike > 0 && Number.isInteger(c.lotSize) && c.lotSize > 0)) return null;
  if (typeof c.tradingSymbol !== "string" || c.tradingSymbol.trim() === "") return null;
  const entryHigh = idea.entry?.high;
  if (!(typeof entryHigh === "number" && Number.isFinite(entryHigh) && entryHigh > 0)) return null;
  const contract = { expiry: c.expiry, strike: c.strike, type: c.optionType, tradingSymbol: c.tradingSymbol, lotSize: c.lotSize };
  return {
    id: `idea:${brief.id}:${idea.id}`,
    kind: "IDEA",
    index: c.index,
    label: clipText(c.label, FINALIST_TEXT.label) || contractText(contract, c.index),
    side: c.optionType === "CE" ? "LONG" : "SHORT",
    contract,
    entryHigh,
    condition: clipOrNull(idea.condition, FINALIST_TEXT.condition),
    wrongIf: clipOrNull(idea.wrongIf, FINALIST_TEXT.wrongIf),
    bearCase: clipOrNull(idea.bearCase, FINALIST_TEXT.bearCase),
    why: (Array.isArray(idea.why) ? idea.why : [])
      .map((w) => clipText(w, FINALIST_TEXT.why))
      .filter(Boolean)
      .slice(0, FINALIST_TEXT.whyItems),
    horizon: idea.horizon ?? null,
    briefId: brief.id,
  };
}

/**
 * The bar's finalists, nowMs being the bar close: one generic per index, in `indices` order, then at most
 * AGENT_POLICY.maxIdeas ideas from a brief that existed at nowMs (briefAsOf), in the brief's order with today's
 * idea (today.ideaId) first. An idea needs an index in `indices` and a contract expiring after today (a contract
 * that expires today is never bought), a CE or PE with a positive strike, lot size and buy-zone top; CE is LONG,
 * PE is SHORT. Ideas of every horizon qualify (every agent position is intraday). Texts are cut to FINALIST_TEXT.
 */
export function compileFinalists(a: { indices: readonly IndexId[]; nowMs: number; brief: AdvisorReport | null }): Finalist[] {
  const indices = [...new Set(a.indices)];
  const out = indices.map(genericFinalist);
  const brief = briefAsOf(a.brief, a.nowMs);
  if (!brief || !Array.isArray(brief.ideas)) return out;
  const today = istDate(a.nowMs);
  const first = brief.today?.ideaId ?? null;
  const ordered = [...brief.ideas.filter((x) => x.id === first), ...brief.ideas.filter((x) => x.id !== first)];
  const seen = new Set<string>();
  for (const idea of ordered) {
    if (seen.size >= AGENT_POLICY.maxIdeas) break;
    const f = ideaFinalist(brief, idea, indices, today);
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * The brief's headline and up to four factors ("label: reading — detail") for the bar at nowMs; null without a
 * brief that existed then (briefAsOf). Factors without data are left out. Context for the model, not data.
 */
export function briefContext(brief: AdvisorReport | null, nowMs: number): BriefContext | null {
  const b = briefAsOf(brief, nowMs);
  if (!b) return null;
  const factors = (Array.isArray(b.factors) ? b.factors : [])
    .filter((f) => f && f.reading !== "NO_DATA")
    .map((f) => clipText(`${clipText(f.label, FINALIST_TEXT.factor)}: ${f.reading} — ${clipText(f.detail, FINALIST_TEXT.factor)}`, FINALIST_TEXT.factor))
    .filter(Boolean)
    .slice(0, FINALIST_TEXT.factors);
  return { headline: clipText(b.headline, FINALIST_TEXT.headline), factors };
}
