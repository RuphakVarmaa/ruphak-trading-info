/**
 * An advisor idea's entry condition, shared by the engine's checks (validate.ts) and the dashboard's idea card:
 * a placeholder the model wrote ("None", "N/A", "-") is no condition, and a brief that left the field empty can
 * still state its condition as the first reason ("Condition first: only if …").
 */

const PLACEHOLDER = /^(?:none(?: needed)?|n\/?a|null|nil|-+|no condition(?: needed)?|not applicable|buy now)\.?$/i;
const CONDITION_LEAD = /^(?:condition(?: first)?\s*[:–—-]\s*)?(?:only\s+(?:if|when|after|once)|if|once|wait\s+(?:for|until|till))\b/i;

/** The condition text, whitespace collapsed; null when blank or a placeholder. */
export function realCondition(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t !== "" && !PLACEHOLDER.test(t) ? t : null;
}

/** The first reason when it is written as an entry condition; null otherwise. */
export function conditionFromWhy(why: readonly string[] | undefined): string | null {
  const first = (why?.[0] ?? "").replace(/\s+/g, " ").trim();
  return first !== "" && CONDITION_LEAD.test(first) ? first : null;
}

/** The idea's own condition, else one its first reason states; null for an idea with neither. */
export function ideaCondition(idea: { condition?: string | null; why?: readonly string[] }): string | null {
  return realCondition(idea.condition) ?? conditionFromWhy(idea.why);
}
