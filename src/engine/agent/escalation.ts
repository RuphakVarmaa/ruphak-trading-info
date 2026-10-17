/**
 * Escalation to the deep model (SPEC §4.6 as amended): which reflex decisions ask for a second opinion, whether one
 * may be requested now, and how a finished one becomes the next candle's decision. An escalation never blocks a
 * tick; its answer applies to the next candle only, through the same code gate as the reflex's.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { istAt, istDate } from "../clock";
import { BAR_5M_MS } from "../market/candles";
import { INDEX_IDS, type IndexId } from "../types";
import { AGENT_POLICY, ESCALATION } from "./constants";
import { stricterRisk } from "./policy";
import type { AgentDirection, DecisionRecord, EscalationRecord, Finalist } from "./types";

export type EscalationTrigger = EscalationRecord["trigger"];

/** The reason an effective decision carries when the reflex and the escalation call opposite directions. */
export const DISAGREE_REASON = "reflex and escalation disagree";

const directional = (d: AgentDirection) => d === "LONG" || d === "SHORT";

/**
 * Among bar B's reflex decisions, the ones to escalate, at most one per index:
 * - CRISIS_FLIP: the regime is CRISIS and no decision of the previous bar for the same finalist was CRISIS;
 * - LOW_CONFIDENCE: a directional call (LONG or SHORT) with setupQuality ≥ ESCALATION.minSetupQuality and confidence
 *   below ESCALATION.belowConfidence. A NEUTRAL call's confidence is the chance the index stays put (#23), not a
 *   directional probability, so it never counts as low confidence.
 * On one index CRISIS_FLIP comes first, then the highest setup quality, then the lowest confidence.
 */
export function escalationTriggers(current: readonly DecisionRecord[], previous: readonly DecisionRecord[]): { decision: DecisionRecord; trigger: EscalationTrigger }[] {
  const wasCrisis = new Set(previous.filter((d) => d.regime === "CRISIS").map((d) => d.finalistId));
  const best = new Map<IndexId, { decision: DecisionRecord; trigger: EscalationTrigger }>();
  const better = (a: { decision: DecisionRecord; trigger: EscalationTrigger }, b: { decision: DecisionRecord; trigger: EscalationTrigger }) => {
    if (a.trigger !== b.trigger) return a.trigger === "CRISIS_FLIP";
    if (a.decision.setupQuality !== b.decision.setupQuality) return a.decision.setupQuality > b.decision.setupQuality;
    if (a.decision.directionConfidence !== b.decision.directionConfidence) return a.decision.directionConfidence < b.decision.directionConfidence;
    return a.decision.finalistId < b.decision.finalistId;
  };
  for (const d of current) {
    if (d.source !== "REFLEX") continue;
    let trigger: EscalationTrigger | null = null;
    if (d.regime === "CRISIS" && !wasCrisis.has(d.finalistId)) trigger = "CRISIS_FLIP";
    else if (directional(d.direction) && d.setupQuality >= ESCALATION.minSetupQuality && Number.isFinite(d.directionConfidence) && d.directionConfidence < ESCALATION.belowConfidence) trigger = "LOW_CONFIDENCE";
    if (trigger === null) continue;
    const candidate = { decision: d, trigger };
    const held = best.get(d.index);
    if (!held || better(candidate, held)) best.set(d.index, candidate);
  }
  return INDEX_IDS.flatMap((index) => {
    const t = best.get(index);
    return t ? [t] : [];
  });
}

/** The cost side of an escalation request (all USD for the IST day). */
export interface EscalationBudget {
  spentUsd: number;
  /** This escalation's worst case (cost.ts worstCaseUsd). */
  worstUsd: number;
  /** The rest of the day's reflex calls at their worst case: kept back so an escalation never starves the reflex. */
  reflexReserveUsd: number;
  /** Tonight's review at its worst case, kept back so escalations never skip it; 0 once today's review has run. */
  reviewReserveUsd: number;
  capUsd: number;
}

/** Whether the escalation fits: spent + both reserves + its worst case within the cap (float noise allowed; not a number fails). */
export function escalationFits(b: EscalationBudget): boolean {
  return b.spentUsd + b.reflexReserveUsd + b.reviewReserveUsd + b.worstUsd <= b.capUsd + 1e-9;
}

/** Why an escalation does not fit the day's cap, in numbers. */
export function costCapReason(b: EscalationBudget): string {
  const review = b.reviewReserveUsd > 0 ? ` + $${b.reviewReserveUsd.toFixed(3)} kept for tonight's review` : "";
  return `cost cap: $${b.spentUsd.toFixed(3)} spent + $${b.reflexReserveUsd.toFixed(3)} kept for the reflex${review} + $${b.worstUsd.toFixed(3)} worst case is over $${b.capUsd.toFixed(2)}`;
}

/** Reflex calls still to come on the bar's day after it (bars closing up to AGENT_POLICY.reflexLastBarIst). */
export function reflexCallsLeft(barCloseMs: number): number {
  const last = istAt(istDate(barCloseMs), AGENT_POLICY.reflexLastBarIst);
  return last > barCloseMs ? Math.floor((last - barCloseMs) / BAR_5M_MS) : 0;
}

/**
 * Whether bar B's escalation on an index may be requested now. All must hold, checked in this order:
 * - the bar closed on a trading day at or before ESCALATION.lastBarIst;
 * - no escalation for the index was requested in the last ESCALATION.perIndexGapMs;
 * - today's escalations are below perDayCap;
 * - with a budget: spent + the reflex reserve + the review reserve + this worst case fit under the cap (without one,
 *   the caller checks the cost cap itself);
 * - the job can start within ESCALATION.startWithinMs of the bar close.
 * Skipped requests made no call, so they count toward neither the gap nor the cap.
 */
export function escalationAllowed(
  index: IndexId,
  barCloseMs: number,
  nowMs: number,
  today: readonly EscalationRecord[],
  perDayCap: number,
  calendar: TradingCalendar,
  budget?: EscalationBudget,
): { ok: boolean; reason: string | null } {
  const no = (reason: string) => ({ ok: false, reason });
  const date = istDate(barCloseMs);
  if (!calendar.isTradingDay(date)) return no(`${date} is not a trading day`);
  if (barCloseMs > istAt(date, ESCALATION.lastBarIst)) return no(`the candle closed after ${ESCALATION.lastBarIst}`);
  const asked = today.filter((e) => e.date === date && e.status !== "SKIPPED");
  const last = asked.filter((e) => e.index === index).reduce<EscalationRecord | null>((a, e) => (!a || e.requestedMs > a.requestedMs ? e : a), null);
  if (last && nowMs - last.requestedMs < ESCALATION.perIndexGapMs) {
    return no(`${index} was escalated ${Math.round((nowMs - last.requestedMs) / 60_000)} min ago (at most one per ${ESCALATION.perIndexGapMs / 60_000} min)`);
  }
  if (!(asked.length < perDayCap)) return no(`today's cap of ${perDayCap} escalations is used`);
  if (budget && !escalationFits(budget)) return no(costCapReason(budget));
  if (nowMs - barCloseMs > ESCALATION.startWithinMs) return no(`too late to start: ${Math.round((nowMs - barCloseMs) / 1000)} s after the close (limit ${ESCALATION.startWithinMs / 1000} s)`);
  return { ok: true, reason: null };
}

/** The candle an escalation of bar B applies to: B + 5 min. */
export function escalationTargetBarMs(esc: Pick<EscalationRecord, "barCloseMs">): number {
  return esc.barCloseMs + BAR_5M_MS;
}

/**
 * True when a finishing escalation is LATE: the candle it applies to already has its batch, so its reflex job ran
 * before the answer arrived. A late answer is stored as LATE and never applied.
 */
export function escalationLate(esc: Pick<EscalationRecord, "barCloseMs">, targetBatch: { barCloseMs: number } | null): boolean {
  return targetBatch !== null && targetBatch.barCloseMs === escalationTargetBarMs(esc);
}

/** An escalation that may be merged: DONE, with a usable decision for its own finalist, not applied to another bar. */
function usable(esc: EscalationRecord | undefined): esc is EscalationRecord & { decision: NonNullable<EscalationRecord["decision"]> } {
  if (!esc || esc.status !== "DONE" || !esc.decision) return false;
  const c = esc.decision.directionConfidence;
  if (esc.decision.finalistId !== esc.finalistId || !(Number.isFinite(c) && c >= 0 && c <= 1)) return false;
  return esc.appliedBarMs === null || esc.appliedBarMs === escalationTargetBarMs(esc);
}

const trimReason = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);

/**
 * The decision in force for a finalist at bar B + 1, given its reflex decision and the finished escalation of bar B
 * (SPEC §4.6):
 * - no usable escalation (not DONE, LATE, for another bar or finalist): the reflex decision unchanged;
 * - a NEUTRAL reflex call on B + 1 and a directional escalation: the reflex decision unchanged. The reflex's call is
 *   five minutes fresher, so an older directional view never turns it into a trade; the caller then turns the
 *   escalation into an exit-only record (it can close a position, never open one);
 * - otherwise a new record with source ESCALATION and effective true, taking the escalation's judgement except that
 *   the stricter value wins on risk (stricterRisk), on a CRISIS regime and on toxic flow;
 * - when the reflex and the escalation call opposite directions, the direction is NEUTRAL (confidence 0.5: no view)
 *   with the reason "reflex and escalation disagree", and the row is marked codeMade: code set that call, not a
 *   model, so it is never scored;
 * - when the reflex failed on B + 1 (no reflex decision), the escalation becomes an exit-only record (effective
 *   false): it can trigger exits but never an entry. `o.finalist` and `o.instructionVersion` fill in its record.
 * The caller marks the reflex row superseded (effective false) and sets the escalation's appliedBarMs.
 */
export function mergeEscalation(
  reflex: DecisionRecord | undefined,
  esc: EscalationRecord | undefined,
  ids: () => string,
  o: { finalist?: Finalist; instructionVersion?: string } = {},
): DecisionRecord | undefined {
  if (!usable(esc)) return reflex;
  const target = escalationTargetBarMs(esc);
  const e = esc.decision;
  if (reflex) {
    if (reflex.finalistId !== esc.finalistId || reflex.index !== esc.index || reflex.barCloseMs !== target) return reflex;
    if (reflex.direction === "NEUTRAL" && directional(e.direction)) return reflex;
    const disagree = directional(e.direction) && directional(reflex.direction) && e.direction !== reflex.direction;
    return {
      ...reflex,
      id: ids(),
      source: "ESCALATION",
      callId: esc.callId ?? reflex.callId,
      effective: true,
      regime: reflex.regime === "CRISIS" || e.regime === "CRISIS" ? "CRISIS" : e.regime,
      direction: disagree ? "NEUTRAL" : e.direction,
      directionConfidence: disagree ? 0.5 : e.directionConfidence,
      toxicFlow: e.toxicFlow || reflex.toxicFlow,
      setupQuality: e.setupQuality,
      riskState: stricterRisk(e.riskState, reflex.riskState),
      reason: disagree ? DISAGREE_REASON : trimReason(e.reason),
      sizing: null,
      execution: null,
      outcome: null,
      ...(disagree ? { codeMade: true } : {}),
    };
  }
  return {
    ...e,
    finalistId: esc.finalistId,
    reason: trimReason(e.reason),
    id: ids(),
    date: istDate(target),
    barCloseMs: target,
    index: esc.index,
    finalistKind: o.finalist?.kind ?? (esc.finalistId.startsWith("idea:") ? "IDEA" : "GENERIC"),
    source: "ESCALATION",
    callId: esc.callId ?? "",
    instructionVersion: o.instructionVersion ?? "",
    effective: false,
    sizing: null,
    execution: null,
    outcome: null,
  };
}
