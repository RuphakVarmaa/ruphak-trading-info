import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EscalationSchema, REFLEX_OUTPUT_FORMAT, ReflexBatchSchema, ReflexDecisionSchema, ReviewSchema, outputFormat } from "./schema";
import type { ReflexDecision, ReviewOut } from "./types";

const decision: ReflexDecision = {
  finalistId: "gen:NIFTY",
  regime: "TRENDING",
  direction: "LONG",
  directionConfidence: 0.62,
  toxicFlow: false,
  setupQuality: 2,
  riskState: "SAFE",
  reason: "r5 and r15 up, above VWAP, call short covering.",
};

type Json = Record<string, unknown>;
const props = (node: unknown) => (node as { properties: Record<string, Json> }).properties;

/** Every node of a JSON schema, depth first. */
function nodes(node: unknown, out: Json[] = []): Json[] {
  const o = node as Json;
  out.push(o);
  for (const child of Object.values((o.properties ?? {}) as Record<string, unknown>)) nodes(child, out);
  if (o.items) nodes(o.items, out);
  for (const child of (o.anyOf ?? []) as unknown[]) nodes(child, out);
  return out;
}

describe("the reflex decision schema", () => {
  it("accepts a well-formed decision and a batch of them", () => {
    expect(ReflexDecisionSchema.parse(decision)).toEqual(decision);
    expect(ReflexBatchSchema.parse({ decisions: [decision, { ...decision, finalistId: "gen:SENSEX", direction: "NEUTRAL", setupQuality: 0 }] }).decisions).toHaveLength(2);
    expect(ReflexBatchSchema.parse({ decisions: [] })).toEqual({ decisions: [] });
  });

  it("rejects values outside the fixed sets", () => {
    expect(ReflexDecisionSchema.safeParse({ ...decision, setupQuality: 4 }).success).toBe(false);
    expect(ReflexDecisionSchema.safeParse({ ...decision, setupQuality: 2.5 }).success).toBe(false);
    expect(ReflexDecisionSchema.safeParse({ ...decision, regime: "BULLISH" }).success).toBe(false);
    expect(ReflexDecisionSchema.safeParse({ ...decision, direction: "long" }).success).toBe(false);
    expect(ReflexDecisionSchema.safeParse({ ...decision, riskState: "UNSAFE" }).success).toBe(false);
    expect(ReflexDecisionSchema.safeParse({ ...decision, toxicFlow: "no" }).success).toBe(false);
    const { reason: _reason, ...noReason } = decision;
    void _reason;
    expect(ReflexDecisionSchema.safeParse(noReason).success).toBe(false);
    expect(ReflexBatchSchema.safeParse({ decision: [decision] }).success).toBe(false);
  });

  it("leaves the confidence range to validate.ts, so one bad number cannot fail the batch here", () => {
    expect(ReflexDecisionSchema.safeParse({ ...decision, directionConfidence: 1.4 }).success).toBe(true);
    expect(ReflexDecisionSchema.safeParse({ ...decision, directionConfidence: -0.2 }).success).toBe(true);
  });

  it("drops keys the schema does not name", () => {
    expect(ReflexDecisionSchema.parse({ ...decision, size: 5 })).toEqual(decision);
  });
});

describe("the escalation and review schemas", () => {
  it("parse the deep model's answers", () => {
    expect(EscalationSchema.parse({ decision, reason: "Momentum and flow agree." })).toEqual({ decision, reason: "Momentum and flow agree." });
    const review: ReviewOut = { summary: "Quiet day.", fills: [], misses: ["10:40 NIFTY drop"], mistakes: [], lessons: ["Stay neutral in ranges."], candidate: null };
    expect(ReviewSchema.parse(review)).toEqual(review);
    const withCandidate: ReviewOut = { ...review, candidate: { guidance: "- Prefer NEUTRAL.", rationale: "Few clean moves.", wouldBeWrongIf: "Brier rises over 5 sessions." } };
    expect(ReviewSchema.parse(withCandidate)).toEqual(withCandidate);
    expect(ReviewSchema.safeParse({ ...review, candidate: undefined }).success).toBe(false);
  });
});

describe("the structured-output format", () => {
  it("keeps the allowed values in the schema the API receives", () => {
    const d = props(props(REFLEX_OUTPUT_FORMAT.schema).decisions.items);
    expect(REFLEX_OUTPUT_FORMAT.type).toBe("json_schema");
    expect(d.regime.enum).toEqual(["TRENDING", "MEAN_REVERTING", "HIGH_VOL", "CRISIS"]);
    expect(d.direction.enum).toEqual(["LONG", "SHORT", "NEUTRAL"]);
    expect(d.riskState.enum).toEqual(["SAFE", "NEAR_LIMIT", "REDUCE"]);
    expect(d.setupQuality.enum).toEqual([0, 1, 2, 3]);
    expect(d.directionConfidence).toEqual({ type: "number", description: "Your probability from 0 to 1, as the instructions define it." });
  });

  it("closes every object, requires every property and carries no numeric or length limits", () => {
    for (const format of [REFLEX_OUTPUT_FORMAT, outputFormat(EscalationSchema), outputFormat(ReviewSchema)]) {
      expect(format.schema.$schema).toBeUndefined();
      for (const n of nodes(format.schema)) {
        for (const banned of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format"]) expect(n[banned]).toBeUndefined();
        if (n.type === "object") {
          expect(n.additionalProperties).toBe(false);
          expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as Json).sort());
        }
      }
    }
  });

  it("is the same on every call, so the API's schema cache holds", () => {
    expect(outputFormat(ReflexBatchSchema)).toEqual(REFLEX_OUTPUT_FORMAT);
    expect(JSON.stringify(outputFormat(ReflexBatchSchema))).toBe(JSON.stringify(REFLEX_OUTPUT_FORMAT));
  });

  it("refuses a schema with keywords structured outputs do not take", () => {
    expect(() => outputFormat(z.object({ p: z.number().min(0).max(1) }))).toThrow(/not supported/);
    expect(() => outputFormat(z.object({ s: z.string().max(25) }))).toThrow(/not supported/);
    expect(() => outputFormat(z.object({ e: z.string().email() }))).toThrow(/not supported/);
    expect(() => outputFormat(z.object({ m: z.record(z.string(), z.number()) }))).toThrow(/not supported/);
    expect(() => outputFormat(z.looseObject({ a: z.string() }))).toThrow(/additionalProperties/);
  });
});
