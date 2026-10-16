import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt, MINUTE_MS } from "../clock";
import {
  applyEscalations,
  DISAGREE_REASON,
  escalationAllowed,
  escalationLate,
  escalationTargetBarMs,
  escalationTriggers,
  mergeEscalation,
  reflexCallsLeft,
} from "./escalation";
import type { DecisionRecord, EscalationRecord, Finalist, ReflexDecision } from "./types";

const B = istAt("2026-10-19", "10:35");
const B1 = B + 5 * MINUTE_MS;
const cal = defaultCalendar;

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d", date: "2026-10-19", barCloseMs: B, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", callId: "c1", instructionVersion: "core-1/v",
    effective: true, sizing: null, execution: null, outcome: null,
    finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.85, toxicFlow: false, setupQuality: 2, riskState: "SAFE", reason: "reflex",
    ...over,
  };
}

function esc(over: Partial<EscalationRecord> = {}, d: Partial<ReflexDecision> = {}): EscalationRecord {
  return {
    id: "e1", date: "2026-10-19", barCloseMs: B, index: "NIFTY", finalistId: "gen:NIFTY", trigger: "LOW_CONFIDENCE", status: "DONE",
    requestedMs: B + 40_000, doneMs: B + 100_000, reflexDecisionId: "d0", callId: "deep1", appliedBarMs: null, reason: "the longer reason",
    decision: { finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.83, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "deep model: trend intact", ...d },
    ...over,
  };
}

const finalist = (id: string, index: "NIFTY" | "SENSEX" = "NIFTY"): Finalist => ({
  id, kind: id.startsWith("idea:") ? "IDEA" : "GENERIC", index, label: id, side: id.startsWith("idea:") ? "LONG" : null, contract: null, entryHigh: null,
  condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
});

let seq = 0;
const ids = () => `m${++seq}`;

describe("escalationTriggers", () => {
  it("escalates a decent setup with confidence below 0.60, not at 0.60 or on a weak setup", () => {
    expect(escalationTriggers([decision({ directionConfidence: 0.59 })], [])).toEqual([{ decision: expect.objectContaining({ directionConfidence: 0.59 }), trigger: "LOW_CONFIDENCE" }]);
    expect(escalationTriggers([decision({ directionConfidence: 0.6 })], [])).toEqual([]);
    expect(escalationTriggers([decision({ directionConfidence: 0.3, setupQuality: 1 })], [])).toEqual([]);
  });

  it("escalates a flip to CRISIS, not a CRISIS that was already there", () => {
    expect(escalationTriggers([decision({ regime: "CRISIS" })], [])[0].trigger).toBe("CRISIS_FLIP");
    expect(escalationTriggers([decision({ regime: "CRISIS" })], [decision({ barCloseMs: B - 5 * MINUTE_MS })])[0].trigger).toBe("CRISIS_FLIP");
    expect(escalationTriggers([decision({ regime: "CRISIS", setupQuality: 0 })], [decision({ regime: "CRISIS" })])).toEqual([]);
  });

  it("picks one per index: CRISIS_FLIP first, then the best setup, then the lowest confidence", () => {
    const rows = [
      decision({ id: "low", finalistId: "idea:b:1", directionConfidence: 0.4, setupQuality: 2 }),
      decision({ id: "setup3", finalistId: "idea:b:2", directionConfidence: 0.5, setupQuality: 3 }),
      decision({ id: "sx", index: "SENSEX", finalistId: "gen:SENSEX", directionConfidence: 0.55 }),
    ];
    expect(escalationTriggers(rows, []).map((t) => t.decision.id)).toEqual(["setup3", "sx"]);
    expect(escalationTriggers([...rows, decision({ id: "lower", finalistId: "idea:b:3", directionConfidence: 0.2, setupQuality: 3 })], []).map((t) => t.decision.id)).toEqual(["lower", "sx"]);
    expect(escalationTriggers([...rows, decision({ id: "crisis", regime: "CRISIS", setupQuality: 0 })], []).map((t) => [t.decision.id, t.trigger])).toEqual([
      ["crisis", "CRISIS_FLIP"],
      ["sx", "LOW_CONFIDENCE"],
    ]);
  });

  it("looks only at the reflex's own decisions", () => {
    expect(escalationTriggers([decision({ source: "ESCALATION", directionConfidence: 0.3 })], [])).toEqual([]);
    // A superseded reflex row still shows what the reflex said.
    expect(escalationTriggers([decision({ effective: false, directionConfidence: 0.3 })], [])).toHaveLength(1);
  });
});

describe("escalationAllowed", () => {
  const now = B + 60_000;
  const allowed = (o: { bar?: number; now?: number; today?: EscalationRecord[]; cap?: number; budget?: Parameters<typeof escalationAllowed>[6]; index?: "NIFTY" | "SENSEX" } = {}) =>
    escalationAllowed(o.index ?? "NIFTY", o.bar ?? B, o.now ?? now, o.today ?? [], o.cap ?? 8, cal, o.budget);

  it("allows a fresh request", () => {
    expect(allowed()).toEqual({ ok: true, reason: null });
  });

  it("only for candles up to 15:00 on a trading day", () => {
    const at15 = istAt("2026-10-19", "15:00");
    expect(allowed({ bar: at15, now: at15 + 30_000 }).ok).toBe(true);
    expect(allowed({ bar: at15 + 5 * MINUTE_MS, now: at15 + 5 * MINUTE_MS + 30_000 })).toEqual({ ok: false, reason: "the candle closed after 15:00" });
    const holiday = istAt("2026-10-20", "10:35");
    expect(allowed({ bar: holiday, now: holiday + 30_000 })).toEqual({ ok: false, reason: "2026-10-20 is not a trading day" });
  });

  it("at most once per index per 30 minutes; skipped requests do not count", () => {
    const before = (minutes: number, over: Partial<EscalationRecord> = {}) => esc({ id: `e${minutes}`, requestedMs: now - minutes * MINUTE_MS, ...over });
    expect(allowed({ today: [before(29)] })).toEqual({ ok: false, reason: "NIFTY was escalated 29 min ago (at most one per 30 min)" });
    expect(allowed({ today: [before(30)] }).ok).toBe(true);
    expect(allowed({ today: [before(5, { index: "SENSEX" })] }).ok).toBe(true);
    expect(allowed({ today: [before(5, { status: "SKIPPED" })] }).ok).toBe(true);
    expect(allowed({ today: [before(5, { status: "FAILED" })] }).ok).toBe(false);
  });

  it("stops at the daily cap", () => {
    const earlier = Array.from({ length: 8 }, (_, i) => esc({ id: `e${i}`, index: "SENSEX", requestedMs: istAt("2026-10-19", "09:30") + i * 31 * MINUTE_MS }));
    expect(allowed({ today: earlier.slice(0, 7) }).ok).toBe(true);
    expect(allowed({ today: earlier })).toEqual({ ok: false, reason: "today's cap of 8 escalations is used" });
    expect(allowed({ cap: 0 }).ok).toBe(false);
    // Yesterday's do not count.
    expect(allowed({ today: earlier.map((e) => ({ ...e, date: "2026-10-16" })) }).ok).toBe(true);
  });

  it("keeps the rest of the day's reflex budget back", () => {
    expect(allowed({ budget: { spentUsd: 1, worstUsd: 0.19, reflexReserveUsd: 0.5, capUsd: 3 } }).ok).toBe(true);
    const tight = allowed({ budget: { spentUsd: 2.5, worstUsd: 0.19, reflexReserveUsd: 0.4, capUsd: 3 } });
    expect(tight.ok).toBe(false);
    expect(tight.reason).toBe("cost cap: $2.500 spent + $0.400 kept for the reflex + $0.190 worst case is over $3.00");
    expect(allowed({ budget: { spentUsd: 2.41, worstUsd: 0.19, reflexReserveUsd: 0.4, capUsd: 3 } }).ok).toBe(true);
  });

  it("must start within 170 seconds of the close", () => {
    expect(allowed({ now: B + 170_000 }).ok).toBe(true);
    expect(allowed({ now: B + 171_000 })).toEqual({ ok: false, reason: "too late to start: 171 s after the close (limit 170 s)" });
  });

  it("counts the reflex calls still to come for the reserve", () => {
    expect(reflexCallsLeft(istAt("2026-10-19", "09:20"))).toBe(69);
    expect(reflexCallsLeft(istAt("2026-10-19", "15:00"))).toBe(1);
    expect(reflexCallsLeft(istAt("2026-10-19", "15:05"))).toBe(0);
    expect(reflexCallsLeft(istAt("2026-10-19", "15:30"))).toBe(0);
  });
});

describe("mergeEscalation", () => {
  const reflex = (over: Partial<DecisionRecord> = {}) => decision({ id: "r1", barCloseMs: B1, directionConfidence: 0.55, reason: "reflex at B+1", ...over });

  it("adopts a finished escalation of the previous candle as the decision in force", () => {
    const m = mergeEscalation(reflex(), esc(), ids)!;
    expect(m).toMatchObject({
      source: "ESCALATION", effective: true, callId: "deep1", barCloseMs: B1, finalistId: "gen:NIFTY", index: "NIFTY", instructionVersion: "core-1/v",
      direction: "LONG", directionConfidence: 0.83, setupQuality: 3, riskState: "SAFE", regime: "TRENDING", reason: "deep model: trend intact",
      sizing: null, execution: null, outcome: null,
    });
    expect(m.id).not.toBe("r1");
  });

  it("keeps the stricter risk, a CRISIS regime and a toxic flag from the newer reflex call", () => {
    expect(mergeEscalation(reflex({ riskState: "REDUCE" }), esc(), ids)!.riskState).toBe("REDUCE");
    expect(mergeEscalation(reflex({ riskState: "NEAR_LIMIT" }), esc(), ids)!.riskState).toBe("NEAR_LIMIT");
    expect(mergeEscalation(reflex(), esc({}, { riskState: "REDUCE" }), ids)!.riskState).toBe("REDUCE");
    expect(mergeEscalation(reflex({ regime: "CRISIS" }), esc(), ids)!.regime).toBe("CRISIS");
    expect(mergeEscalation(reflex(), esc({}, { regime: "CRISIS" }), ids)!.regime).toBe("CRISIS");
    expect(mergeEscalation(reflex({ toxicFlow: true }), esc(), ids)!.toxicFlow).toBe(true);
  });

  it("calls NEUTRAL when the reflex and the escalation call opposite directions", () => {
    const m = mergeEscalation(reflex({ direction: "SHORT", directionConfidence: 0.9 }), esc(), ids)!;
    expect(m).toMatchObject({ source: "ESCALATION", effective: true, direction: "NEUTRAL", directionConfidence: 0.5, reason: DISAGREE_REASON });
    expect(DISAGREE_REASON).toBe("reflex and escalation disagree");
    // A NEUTRAL reflex is not a disagreement.
    expect(mergeEscalation(reflex({ direction: "NEUTRAL" }), esc(), ids)!.direction).toBe("LONG");
  });

  it("turns the escalation into an exit-only record when the reflex failed on the next candle", () => {
    const m = mergeEscalation(undefined, esc({ finalistId: "idea:b:1" }, { finalistId: "idea:b:1", riskState: "REDUCE" }), ids, { instructionVersion: "core-1/v" })!;
    expect(m).toMatchObject({
      source: "ESCALATION", effective: false, barCloseMs: B1, date: "2026-10-19", index: "NIFTY", finalistId: "idea:b:1", finalistKind: "IDEA",
      riskState: "REDUCE", callId: "deep1", instructionVersion: "core-1/v",
    });
    expect(mergeEscalation(undefined, esc(), ids, { finalist: finalist("gen:NIFTY") })!.finalistKind).toBe("GENERIC");
  });

  it("never applies a LATE, failed, mismatched or already-used escalation", () => {
    const r = reflex();
    expect(mergeEscalation(r, esc({ status: "LATE" }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({ status: "FAILED", decision: null }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({ barCloseMs: B - 5 * MINUTE_MS }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({ finalistId: "gen:SENSEX", index: "SENSEX" }, { finalistId: "gen:SENSEX" }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({}, { finalistId: "gen:SENSEX" }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({}, { directionConfidence: 1.2 }), ids)).toBe(r);
    expect(mergeEscalation(r, esc({ appliedBarMs: B1 + 5 * MINUTE_MS }), ids)).toBe(r);
    expect(mergeEscalation(r, undefined, ids)).toBe(r);
    expect(mergeEscalation(undefined, esc({ status: "LATE" }), ids)).toBeUndefined();
  });

  it("marks an answer LATE when the candle it applies to already has its batch", () => {
    expect(escalationTargetBarMs(esc())).toBe(B1);
    expect(escalationLate(esc(), { barCloseMs: B1 })).toBe(true);
    expect(escalationLate(esc(), null)).toBe(false);
  });
});

describe("applyEscalations", () => {
  const finalists = [finalist("gen:NIFTY"), finalist("gen:SENSEX", "SENSEX"), finalist("idea:b:1")];
  const reflexRows = [
    decision({ id: "rN", barCloseMs: B1, directionConfidence: 0.55 }),
    decision({ id: "rS", barCloseMs: B1, index: "SENSEX", finalistId: "gen:SENSEX" }),
  ];

  it("merges each finalist's escalation, supersedes its reflex row and records where it was applied", () => {
    const out = applyEscalations({ barCloseMs: B1, finalists, reflex: reflexRows, reflexOk: true, escalations: [esc()], instructionVersion: "core-1/v", ids });
    expect(out.decisions.map((d) => [d.finalistId, d.source, d.effective])).toEqual([
      ["gen:NIFTY", "ESCALATION", true],
      ["gen:SENSEX", "REFLEX", true],
    ]);
    expect(out.superseded).toEqual([{ ...reflexRows[0], effective: false }]);
    expect(out.exitOnly).toEqual([]);
    expect(out.applied).toEqual([{ ...esc(), appliedBarMs: B1 }]);
  });

  it("uses an escalation for exits only when the reflex call failed or gave no decision for that finalist", () => {
    const failed = applyEscalations({ barCloseMs: B1, finalists, reflex: [], reflexOk: false, escalations: [esc()], instructionVersion: "core-1/v", ids });
    expect(failed.decisions).toEqual([]);
    expect(failed.exitOnly).toEqual([expect.objectContaining({ finalistId: "gen:NIFTY", effective: false, source: "ESCALATION", barCloseMs: B1 })]);
    expect(failed.applied).toHaveLength(1);
    const idea = esc({ id: "e2", finalistId: "idea:b:1" }, { finalistId: "idea:b:1" });
    const dropped = applyEscalations({ barCloseMs: B1, finalists, reflex: reflexRows, reflexOk: true, escalations: [idea], instructionVersion: "core-1/v", ids });
    expect(dropped.decisions.map((d) => d.id)).toEqual(["rN", "rS"]);
    expect(dropped.exitOnly.map((d) => [d.finalistId, d.finalistKind, d.effective])).toEqual([["idea:b:1", "IDEA", false]]);
  });

  it("ignores escalations for other candles, finalists no longer in the batch, and late ones", () => {
    const gone = esc({ id: "e3", finalistId: "idea:old:9" }, { finalistId: "idea:old:9" });
    const old = esc({ id: "e4", barCloseMs: B - 5 * MINUTE_MS });
    const late = esc({ id: "e5", status: "LATE" });
    const out = applyEscalations({ barCloseMs: B1, finalists, reflex: reflexRows, reflexOk: true, escalations: [gone, old, late], instructionVersion: "core-1/v", ids });
    expect(out.decisions).toEqual(reflexRows);
    expect(out).toMatchObject({ superseded: [], exitOnly: [], applied: [] });
  });
});
