/**
 * The model's output schemas (SPEC §4.4), fixed so the API compiles each once and caches it. Every property is
 * required (optional values are nullable). The API does not enforce numeric ranges, so the schemas carry none:
 * validate.ts checks each decision's confidence and drops the bad ones instead of failing the whole batch.
 */
import { z } from "zod";
import type { ReflexDecision, ReviewOut } from "./types";

const Regime = z.enum(["TRENDING", "MEAN_REVERTING", "HIGH_VOL", "CRISIS"]);
const Direction = z.enum(["LONG", "SHORT", "NEUTRAL"]);
const RiskState = z.enum(["SAFE", "NEAR_LIMIT", "REDUCE"]);

export const ReflexDecisionSchema = z.object({
  finalistId: z.string().describe("The finalist id exactly as given."),
  regime: Regime,
  direction: Direction,
  directionConfidence: z.number().describe("Your probability from 0 to 1 (see the instructions)."),
  toxicFlow: z.boolean(),
  setupQuality: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  riskState: RiskState,
  reason: z.string().describe("One sentence, at most 25 words, naming the numbers that decided it."),
});

export const ReflexBatchSchema = z.object({ decisions: z.array(ReflexDecisionSchema) });

export const EscalationSchema = z.object({
  decision: ReflexDecisionSchema,
  reason: z.string().describe("At most 60 words: the decisive numbers and what would change your mind."),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  fills: z.array(z.string()),
  misses: z.array(z.string()),
  mistakes: z.array(z.string()),
  lessons: z.array(z.string()),
  candidate: z
    .object({
      guidance: z.string().describe("The revised judgement guidance: plain bullet points, at most 2,500 characters."),
      rationale: z.string(),
      wouldBeWrongIf: z.string(),
    })
    .nullable(),
});

// The schemas and the shared types must stay the same shape.
const decisionMatches: z.infer<typeof ReflexDecisionSchema> extends ReflexDecision ? (ReflexDecision extends z.infer<typeof ReflexDecisionSchema> ? true : false) : false = true;
const reviewMatches: z.infer<typeof ReviewSchema> extends ReviewOut ? (ReviewOut extends z.infer<typeof ReviewSchema> ? true : false) : false = true;
void decisionMatches;
void reviewMatches;

export type EscalationOut = z.infer<typeof EscalationSchema>;
