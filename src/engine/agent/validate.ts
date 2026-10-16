/**
 * Checks the reflex model's answer before anything uses it (SPEC §4.5), failing closed. A batch that does not match
 * the schema is FAILED. A decision with an unknown or repeated finalist id, or a confidence outside 0..1, is dropped,
 * so that finalist simply has no decision (no entry). An IDEA called against its fixed side is kept: the code gate's
 * idea_side line rejects it and the record shows why.
 */
import { EscalationSchema, ReflexBatchSchema } from "./schema";
import type { Finalist, ReflexDecision } from "./types";

export const MAX_REASON_CHARS = 200;
/** The escalation's own reason (at most 60 words asked) is cut to this length. */
export const MAX_ESCALATION_REASON_CHARS = 600;
/** A finalist id quoted back in a drop note is cut to this length. */
const MAX_ID_CHARS = 120;

/** Control characters and runs of whitespace become single spaces; the result is trimmed to at most `max` characters. */
export function cleanText(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validateBatch(raw: unknown, finalists: readonly Finalist[]): { ok: true; decisions: ReflexDecision[]; dropped: string[] } | { ok: false; error: string } {
  const parsed = ReflexBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `the answer did not match the schema${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}` };
  }
  const known = new Set(finalists.map((f) => f.id));
  const counts = new Map<string, number>();
  for (const d of parsed.data.decisions) counts.set(d.finalistId, (counts.get(d.finalistId) ?? 0) + 1);
  const decisions: ReflexDecision[] = [];
  const dropped: string[] = [];
  const noted = new Set<string>();
  for (const d of parsed.data.decisions) {
    const id = cleanText(d.finalistId, MAX_ID_CHARS) || "(empty id)";
    if (!known.has(d.finalistId)) {
      dropped.push(`${id}: not a finalist`);
      continue;
    }
    // Two answers for one finalist: neither is trusted.
    if ((counts.get(d.finalistId) ?? 0) > 1) {
      if (!noted.has(d.finalistId)) dropped.push(`${id}: answered more than once`);
      noted.add(d.finalistId);
      continue;
    }
    const c = d.directionConfidence;
    if (!(Number.isFinite(c) && c >= 0 && c <= 1)) {
      dropped.push(`${id}: confidence ${String(c)} is outside 0..1`);
      continue;
    }
    decisions.push({ ...d, reason: cleanText(d.reason, MAX_REASON_CHARS) });
  }
  if (decisions.length === 0) return { ok: false, error: dropped.length ? `no valid decisions (${dropped.join("; ")})` : "no valid decisions" };
  return { ok: true, decisions, dropped };
}

/**
 * The deep model's escalation answer, checked like a reflex decision: it must match EscalationSchema, name the
 * escalated finalist and keep its confidence within 0..1 (the schema carries no ranges). Fails closed.
 */
export function validateEscalation(raw: unknown, finalist: Finalist): { ok: true; decision: ReflexDecision; reason: string } | { ok: false; error: string } {
  const parsed = EscalationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "the escalation did not match the schema" };
  const v = validateBatch({ decisions: [parsed.data.decision] }, [finalist]);
  if (!v.ok) return { ok: false, error: v.error.replace(/^no valid decisions/, "no valid decision") };
  return { ok: true, decision: v.decisions[0], reason: cleanText(parsed.data.reason, MAX_ESCALATION_REASON_CHARS) };
}
