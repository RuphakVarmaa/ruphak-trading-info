/** Deterministic LLM fakes for tests and offline backtests. */
import type { LlmClient, LlmRequest, LlmResponse } from "../ports";

export interface DigestCluster {
  cluster_id: string;
  headlines: string[];
  first_seen_ist: string;
}

export type FakeScorer = (cluster: DigestCluster) => Record<string, unknown> | null;

/**
 * Parses the digest JSON from the request and asks `scoreOne` for each cluster's score object
 * (return null to omit a cluster, simulating a partial response). Validates the batch with the
 * request's Zod schema, like the real structured-output path.
 */
export class FakeLlmClient implements LlmClient {
  calls = 0;
  lastUser: string | null = null;
  constructor(
    private readonly scoreOne: FakeScorer,
    private readonly opts: { fail?: boolean | ((call: number) => boolean); refuse?: boolean } = {},
  ) {}

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls++;
    this.lastUser = req.user;
    const fail = typeof this.opts.fail === "function" ? this.opts.fail(this.calls) : this.opts.fail;
    if (fail) throw new Error("fake LLM failure");
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheCreationTokens: 0 };
    if (this.opts.refuse) return { parsed: null, usage, model: req.model, stopReason: "refusal" };
    const digest = JSON.parse(req.user) as { clusters: DigestCluster[] };
    const scores = digest.clusters.map((c) => this.scoreOne(c)).filter((s): s is Record<string, unknown> => s !== null);
    const parsed = req.schema.parse({ scores });
    return { parsed, usage, model: req.model, stopReason: "end_turn" };
  }
}

/** A plausible score object; override fields per test. */
export function fakeScore(clusterId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cluster_id: clusterId,
    cluster_key: `story-${clusterId}`,
    taxonomy: "MACRO_POLICY",
    india_relevance: "DIRECT",
    is_scheduled_data: false,
    surprise: "NA",
    novelty: "NEW",
    priced_in: "LOW",
    horizon: "DAYS_1_2",
    half_life_hours: 24,
    nifty: { direction: "BEAR", magnitude: "MODERATE", confidence: "MEDIUM" },
    sensex: { direction: "BEAR", magnitude: "MODERATE", confidence: "MEDIUM" },
    sectors: [{ sector: "FINANCIALS", direction: "BEAR", weight: "HIGH" }],
    rationale: "Test rationale.",
    ...over,
  };
}
