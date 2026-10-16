/**
 * Checks the reflex model's answer before anything uses it (SPEC §4.5), failing closed: a batch that does not
 * match the schema is FAILED; a decision with an unknown or repeated finalist id, or a confidence outside 0..1,
 * is dropped, so that finalist simply has no decision (no entry). An IDEA called against its fixed side is kept:
 * the code gate's idea_side line rejects it and the record shows why.
 */
import { ReflexBatchSchema } from "./schema";
import type { Finalist, ReflexDecision } from "./types";

export const MAX_REASON_CHARS = 200;

/** Control characters and runs of whitespace out, at most `max` characters. */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validateBatch(raw: unknown, finalists: Finalist[]): { ok: true; decisions: ReflexDecision[]; dropped: string[] } | { ok: false; error: string } {
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
  const seenDup = new Set<string>();
  for (const d of parsed.data.decisions) {
    const id = cleanText(d.finalistId, 120);
    if (!known.has(d.finalistId)) {
      dropped.push(`${id || "(empty id)"}: not a finalist`);
      continue;
    }
    if ((counts.get(d.finalistId) ?? 0) > 1) {
      if (!seenDup.has(d.finalistId)) dropped.push(`${id}: answered more than once`);
      seenDup.add(d.finalistId);
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
