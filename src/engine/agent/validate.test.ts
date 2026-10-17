import { describe, expect, it } from "vitest";
import type { Finalist, ReflexDecision } from "./types";
import { MAX_ESCALATION_REASON_CHARS, MAX_REASON_CHARS, cleanText, validateBatch, validateEscalation } from "./validate";

const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({
  id: `gen:${index}`,
  kind: "GENERIC",
  index,
  label: `${index}: best long or short now`,
  side: null,
  contract: null,
  entryHigh: null,
  condition: null,
  wrongIf: null,
  bearCase: null,
  why: [],
  horizon: null,
  briefId: null,
});
const idea: Finalist = {
  ...generic("NIFTY"),
  id: "idea:adv-1:adv-1-1",
  kind: "IDEA",
  label: "NIFTY 25100 CE",
  side: "LONG",
  contract: { expiry: "2026-10-20", strike: 25100, type: "CE", tradingSymbol: "NIFTY26O2025100CE", lotSize: 65 },
  entryHigh: 110,
  condition: "Only if NIFTY holds above 25,050.",
  wrongIf: "NIFTY closes below 24,980.",
  briefId: "adv-1",
};
const finalists = [generic("NIFTY"), generic("SENSEX"), idea];

const d = (p: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId: "gen:NIFTY",
  regime: "TRENDING",
  direction: "LONG",
  directionConfidence: 0.84,
  toxicFlow: false,
  setupQuality: 3,
  riskState: "SAFE",
  reason: "r5 +14 bps, above VWAP, call short covering.",
  ...p,
});

describe("validateBatch", () => {
  it("keeps a valid batch as it came", () => {
    const decisions = [d(), d({ finalistId: "gen:SENSEX", direction: "NEUTRAL", directionConfidence: 0.5, setupQuality: 0 }), d({ finalistId: idea.id })];
    expect(validateBatch({ decisions }, finalists)).toEqual({ ok: true, decisions, dropped: [] });
  });

  it("fails the whole batch when the answer does not match the schema", () => {
    const bad = validateBatch({ decisions: [d(), { ...d({ finalistId: "gen:SENSEX" }), setupQuality: 4 }] }, finalists);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/did not match the schema \(decisions\.1\.setupQuality/);
    for (const raw of [null, "{}", [], { decisions: "none" }, { answers: [d()] }]) expect(validateBatch(raw, finalists).ok).toBe(false);
  });

  it("drops a confidence outside 0..1 and keeps the rest", () => {
    const r = validateBatch({ decisions: [d({ directionConfidence: 1.2 }), d({ finalistId: "gen:SENSEX", directionConfidence: -0.01 }), d({ finalistId: idea.id, directionConfidence: 1 })] }, finalists);
    expect(r).toEqual({ ok: true, decisions: [d({ finalistId: idea.id, directionConfidence: 1 })], dropped: ["gen:NIFTY: confidence 1.2 is outside 0..1", "gen:SENSEX: confidence -0.01 is outside 0..1"] });
    const edges = validateBatch({ decisions: [d({ directionConfidence: 0 }), d({ finalistId: "gen:SENSEX", directionConfidence: 1 })] }, finalists);
    expect(edges.ok && edges.decisions.length).toBe(2);
  });

  it("drops an unknown finalist id and both copies of a repeated one", () => {
    const r = validateBatch({ decisions: [d({ finalistId: "gen:BANKNIFTY" }), d({ finalistId: "gen:SENSEX" }), d({ finalistId: "gen:SENSEX", direction: "SHORT" }), d()] }, finalists);
    expect(r).toEqual({ ok: true, decisions: [d()], dropped: ["gen:BANKNIFTY: not a finalist", "gen:SENSEX: answered more than once"] });
    // An id is matched exactly: a near miss is a different finalist.
    expect(validateBatch({ decisions: [d({ finalistId: " gen:NIFTY" })] }, finalists).ok).toBe(false);
  });

  it("fails when nothing survives, also for an empty answer", () => {
    expect(validateBatch({ decisions: [] }, finalists)).toEqual({ ok: false, error: "no valid decisions" });
    expect(validateBatch({ decisions: [d({ finalistId: "x" })] }, finalists)).toEqual({ ok: false, error: "no valid decisions (x: not a finalist)" });
    expect(validateBatch({ decisions: [d()] }, [])).toEqual({ ok: false, error: "no valid decisions (gen:NIFTY: not a finalist)" });
  });

  it("keeps an IDEA called against its side, for the code gate to reject on the record", () => {
    const r = validateBatch({ decisions: [d({ finalistId: idea.id, direction: "SHORT" })] }, finalists);
    expect(r.ok && r.decisions[0].direction).toBe("SHORT");
  });

  it("cleans the reason: control characters out, at most 200 characters", () => {
    const r = validateBatch({ decisions: [d({ reason: `Line one\nline\ttwo\u0007 ${"x".repeat(400)}` })] }, finalists);
    if (!r.ok) throw new Error(r.error);
    expect(r.decisions[0].reason.startsWith("Line one line two x")).toBe(true);
    expect(r.decisions[0].reason).toHaveLength(MAX_REASON_CHARS);
    // A dropped id is quoted back cleaned too.
    const odd = validateBatch({ decisions: [d({ finalistId: "bad\nid" }), d()] }, finalists);
    expect(odd.ok && odd.dropped).toEqual(["bad id: not a finalist"]);
  });
});

describe("validateEscalation", () => {
  it("accepts a well-formed answer about the escalated finalist, with the reasons cleaned", () => {
    const r = validateEscalation({ decision: d({ reason: "Flow\nagrees." }), reason: `  Calls covered;\tbelow VWAP would change my mind. ${"x".repeat(900)}` }, generic("NIFTY"));
    if (!r.ok) throw new Error(r.error);
    expect(r.decision).toEqual(d({ reason: "Flow agrees." }));
    expect(r.reason.startsWith("Calls covered; below VWAP would change my mind. x")).toBe(true);
    expect(r.reason).toHaveLength(MAX_ESCALATION_REASON_CHARS);
  });

  it("fails closed on a schema mismatch, another finalist or a confidence outside 0..1", () => {
    expect(validateEscalation({ decision: d(), reason: 5 }, generic("NIFTY"))).toEqual({ ok: false, error: "the escalation did not match the schema" });
    expect(validateEscalation({ decision: d({ finalistId: "gen:SENSEX" }), reason: "x" }, generic("NIFTY"))).toEqual({ ok: false, error: "no valid decision (gen:SENSEX: not a finalist)" });
    expect(validateEscalation({ decision: d({ directionConfidence: 1.5 }), reason: "x" }, generic("NIFTY"))).toEqual({ ok: false, error: "no valid decision (gen:NIFTY: confidence 1.5 is outside 0..1)" });
  });
});

describe("cleanText", () => {
  it("collapses whitespace, strips control characters and clips", () => {
    expect(cleanText("  a\u0000b \r\n c  ", 10)).toBe("a b c");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("\u0085\u009f", 5)).toBe("");
  });
});
