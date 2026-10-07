/** Scores clusters in batches with the LLM, falling back to the lexicon scorer per cluster. */
import type { EngineConfig } from "../../config";
import type { LlmClient, LlmUsage, Logger } from "../../ports";
import type { ArticleCluster, Direction, IndexImpact, NiftySector, ScoredEvent } from "../../types";
import { scoreFallback } from "../fallbackScorer";
import { clampHalfLife, toNumeric } from "../taxonomy";
import { buildDigest, type ScoringContext } from "./digest";
import { RUBRIC_SYSTEM_PROMPT } from "./rubric";
import { EventScoreBatchS, type EventScoreOut } from "./schema";

export interface ScoreRunResult {
  events: ScoredEvent[];
  usage: LlmUsage;
  llmScored: number;
  fallbackScored: number;
  /** Clusters whose LLM attempt failed (refusal, error, missing from output). */
  failedClusterIds: string[];
  errors: string[];
}

const SLUG = /[^a-z0-9-]+/g;

export function normalizeKey(key: string, fallback: string): string {
  const k = key.toLowerCase().trim().replace(/\s+/g, "-").replace(SLUG, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return k.length >= 3 ? k.slice(0, 80) : fallback;
}

export function fromLlmScore(out: EventScoreOut, cluster: ArticleCluster, cfg: EngineConfig, model: string, nowMs: number): ScoredEvent {
  const impact = (x: EventScoreOut["nifty"]): IndexImpact => ({ direction: x.direction, magnitude: x.magnitude, confidence: x.confidence });
  const taxonomy = out.taxonomy as ScoredEvent["taxonomy"];
  const base: Omit<ScoredEvent, "numeric"> = {
    clusterId: cluster.id,
    clusterKey: normalizeKey(out.cluster_key, cluster.id),
    scoredAtMs: nowMs,
    scorer: "llm",
    model,
    version: cfg.rubricVersion,
    taxonomy,
    indiaRelevance: out.india_relevance,
    isScheduledData: out.is_scheduled_data,
    surprise: out.surprise,
    novelty: out.novelty,
    pricedIn: out.priced_in,
    horizon: out.horizon,
    halfLifeHours: clampHalfLife(out.half_life_hours, { taxonomy, isScheduledData: out.is_scheduled_data }, cfg),
    impact: { NIFTY: impact(out.nifty), SENSEX: impact(out.sensex) },
    sectors: out.sectors.map((s) => ({ sector: s.sector as NiftySector, direction: s.direction as Direction, weight: s.weight })),
    rationale: out.rationale.slice(0, 240),
    firstSeenMs: cluster.firstSeenMs,
    articleCount: cluster.articleCount,
    toneMean: cluster.toneMean,
    title: cluster.representativeTitle,
  };
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") } };
}

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export async function scoreClusters(
  clusters: ArticleCluster[],
  ctx: ScoringContext,
  llm: LlmClient | null,
  cfg: EngineConfig,
  logger?: Logger,
): Promise<ScoreRunResult> {
  const result: ScoreRunResult = { events: [], usage: { ...ZERO_USAGE }, llmScored: 0, fallbackScored: 0, failedClusterIds: [], errors: [] };
  const useLlm = llm !== null && cfg.llm.enabled;
  for (let i = 0; i < clusters.length; i += cfg.llm.batchSize) {
    const batch = clusters.slice(i, i + cfg.llm.batchSize);
    const scored = new Map<string, ScoredEvent>();
    if (useLlm) {
      try {
        const resp = await llm.structured({
          system: RUBRIC_SYSTEM_PROMPT,
          user: buildDigest(batch, ctx),
          model: cfg.llm.model,
          effort: cfg.llm.effort,
          maxTokens: 16_000,
          schema: EventScoreBatchS,
        });
        result.usage.inputTokens += resp.usage.inputTokens;
        result.usage.outputTokens += resp.usage.outputTokens;
        result.usage.cacheReadTokens += resp.usage.cacheReadTokens;
        result.usage.cacheCreationTokens += resp.usage.cacheCreationTokens;
        if (resp.stopReason === "refusal") result.errors.push("LLM refused the batch");
        const byId = new Map(batch.map((c) => [c.id, c]));
        for (const out of resp.parsed?.scores ?? []) {
          const cluster = byId.get(out.cluster_id);
          if (!cluster || scored.has(cluster.id)) continue;
          scored.set(cluster.id, fromLlmScore(out, cluster, cfg, resp.model, ctx.nowMs));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(msg);
        logger?.warn("LLM scoring batch failed; using lexicon scores", { error: msg, size: batch.length });
      }
    }
    for (const c of batch) {
      const e = scored.get(c.id);
      if (e) {
        result.events.push(e);
        result.llmScored++;
      } else {
        result.events.push(scoreFallback(c, cfg, ctx.nowMs));
        result.fallbackScored++;
        if (useLlm) result.failedClusterIds.push(c.id);
      }
    }
  }
  return result;
}
