/** Structured-output schema for Claude's event scores. Enums instead of free numbers on purpose. */
import { z } from "zod";
import { EVENT_TAXONOMIES, NIFTY_SECTORS } from "../../types";

const DirectionE = z.enum(["STRONG_BEAR", "BEAR", "NEUTRAL", "BULL", "STRONG_BULL"]);

const IndexImpactS = z.object({
  direction: DirectionE,
  magnitude: z.enum(["NONE", "SMALL", "MODERATE", "LARGE", "EXTREME"]),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export const EventScoreS = z.object({
  cluster_id: z.string(),
  cluster_key: z.string(),
  taxonomy: z.enum(EVENT_TAXONOMIES as unknown as [string, ...string[]]),
  india_relevance: z.enum(["NONE", "INDIRECT", "DIRECT"]),
  is_scheduled_data: z.boolean(),
  surprise: z.enum(["POSITIVE", "NEGATIVE", "INLINE", "NA"]),
  novelty: z.enum(["NEW", "DEVELOPMENT", "REPEAT"]),
  priced_in: z.enum(["LOW", "PARTIAL", "MOSTLY"]),
  horizon: z.enum(["INTRADAY", "DAYS_1_2", "WEEK", "MONTH_PLUS"]),
  half_life_hours: z.number(),
  nifty: IndexImpactS,
  sensex: IndexImpactS,
  sectors: z.array(
    z.object({
      sector: z.enum(NIFTY_SECTORS as unknown as [string, ...string[]]),
      direction: DirectionE,
      weight: z.enum(["LOW", "MEDIUM", "HIGH"]),
    }),
  ),
  rationale: z.string(),
});

export const EventScoreBatchS = z.object({ scores: z.array(EventScoreS) });

export type EventScoreOut = z.infer<typeof EventScoreS>;
export type EventScoreBatchOut = z.infer<typeof EventScoreBatchS>;
