/**
 * The models' output schemas (SPEC §4.4), fixed so the API compiles each one once and caches it. Every property is
 * required (an optional value is nullable). The schemas carry no numeric ranges: validate.ts checks each decision's
 * confidence and drops a bad one instead of failing the whole batch.
 *
 * outputFormat() sends zod's own JSON schema, enums and allowed values included, so the API holds every answer to
 * them. (The SDK's zodOutputFormat helper moves `enum` and `const` into the field descriptions, which would leave a
 * regime or a setup quality unconstrained.) It refuses any keyword structured outputs do not support, so a schema
 * the API would reject fails in the tests, not on the first call of a session.
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
  directionConfidence: z.number().describe("Your probability from 0 to 1, as the instructions define it."),
  toxicFlow: z.boolean(),
  setupQuality: z.literal([0, 1, 2, 3]),
  riskState: RiskState,
  reason: z.string().describe("One sentence of at most 25 words naming the numbers that decided it."),
});

export const ReflexBatchSchema = z.object({ decisions: z.array(ReflexDecisionSchema) });

export const EscalationSchema = z.object({
  decision: ReflexDecisionSchema,
  reason: z.string().describe("At most 60 words: the decisive numbers and what would change your mind."),
});

export const ReviewSchema = z.object({
  summary: z.string().describe("At most 80 words."),
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

export type EscalationOut = z.infer<typeof EscalationSchema>;

// The schemas and the shared types must stay the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const decisionMatches: Same<z.infer<typeof ReflexDecisionSchema>, ReflexDecision> = true;
const reviewMatches: Same<z.infer<typeof ReviewSchema>, ReviewOut> = true;
void decisionMatches;
void reviewMatches;

/** The `output_config.format` value of a structured-output request. */
export interface JsonOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/** JSON Schema keywords structured outputs take (claude-api skill, shared/tool-use-concepts.md: JSON Schema Limitations). */
const SUPPORTED_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "description", "title", "$ref", "$defs"]);

function checkNode(node: unknown, path: string): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`output schema: ${path} is not a schema object`);
  const o = node as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`output schema: "${key}" at ${path} is not supported by structured outputs`);
  }
  if (o.type === "object" && o.additionalProperties !== false) throw new Error(`output schema: the object at ${path} must set additionalProperties: false`);
  if (o.additionalProperties !== undefined && o.additionalProperties !== false) throw new Error(`output schema: additionalProperties at ${path} must be false`);
  for (const [name, child] of Object.entries((o.properties ?? {}) as Record<string, unknown>)) checkNode(child, `${path}.${name}`);
  for (const [name, child] of Object.entries((o.$defs ?? {}) as Record<string, unknown>)) checkNode(child, `${path}.$defs.${name}`);
  if (o.items !== undefined) checkNode(o.items, `${path}[]`);
  for (const key of ["anyOf", "allOf"] as const) {
    const list = o[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`output schema: ${key} at ${path} must be a list`);
    list.forEach((child, i) => checkNode(child, `${path}.${key}[${i}]`));
  }
}

/** The structured-output format for a zod schema; throws when the schema uses a keyword the API does not take. */
export function outputFormat(schema: z.ZodType): JsonOutputFormat {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  checkNode(json, "$");
  return { type: "json_schema", schema: json };
}

/** The reflex call's format, built once so every call sends the same schema (the API caches it for 24 hours). */
export const REFLEX_OUTPUT_FORMAT: JsonOutputFormat = outputFormat(ReflexBatchSchema);
