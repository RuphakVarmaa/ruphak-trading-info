/**
 * IngestDO: single-threaded news ingestion so overlapping crons never double-fetch.
 * Fetch (Google News RSS, GNews, GDELT with persisted spacing) -> relevance filter -> normalize
 * -> dedupe -> cluster -> D1, then clusters that need (re)scoring go to the scoring queue.
 */
import { DurableObject } from "cloudflare:workers";
import { systemClock } from "../../../../src/engine/clock";
import { buildFetchers } from "../../../../src/engine/events/sources";
import { runIngestCycle, type IngestReport } from "../../../../src/engine/pipeline/ingestCycle";
import { errorMessage, makeRuntime, type Runtime } from "../runtime";

export interface ScoreMessage {
  clusterId: string;
  enqueuedMs: number;
}

export interface IngestSummary {
  ok: boolean;
  skipped?: boolean;
  reason: string;
  fetched?: Record<string, number>;
  errors?: Record<string, string>;
  newArticles?: number;
  clustersCreated?: number;
  clustersUpdated?: number;
  enqueued?: number;
  error?: string;
}

export class IngestDO extends DurableObject<Env> {
  private readonly rt: Runtime;
  private running: Promise<IngestSummary> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rt = makeRuntime(env, "ingest-do");
  }

  /** Runs one ingest cycle unless one is already running. */
  runCycle(reason: string): Promise<IngestSummary> {
    if (this.running) return Promise.resolve({ ok: true, skipped: true, reason: `${reason}: a cycle is already running` });
    this.running = this.cycle(reason).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(reason: string): Promise<IngestSummary> {
    const { cfg, repo, logger, env } = this.rt;
    try {
      const fetchers = buildFetchers({
        cfg,
        clock: systemClock,
        state: repo.state,
        gnewsApiKey: env.GNEWS_API_KEY,
        // Google News RSS answers Cloudflare Workers with HTTP 503; publisher feeds and Bing News do not.
        googleNews: false,
        gdelt: true,
        boost: reason === "boost",
        // Each GDELT query costs >= 5.5 s of spacing: one per boost cycle, two on base cycles.
        gdeltQueriesPerCycle: reason === "boost" ? 1 : 2,
      });
      const report: IngestReport = await runIngestCycle({ cfg, clock: systemClock, repo, logger, fetchers });
      const ids = [...new Set(report.needingScore)];
      const now = Date.now();
      for (let i = 0; i < ids.length; i += 100) {
        await env.SCORE_QUEUE.sendBatch(ids.slice(i, i + 100).map((clusterId) => ({ body: { clusterId, enqueuedMs: now } satisfies ScoreMessage })));
      }
      logger.info("ingest", { reason, fetched: report.fetched, errors: report.errors, newArticles: report.newArticles, enqueued: ids.length });
      return {
        ok: true,
        reason,
        fetched: report.fetched,
        errors: report.errors,
        newArticles: report.newArticles,
        clustersCreated: report.clustersCreated,
        clustersUpdated: report.clustersUpdated,
        enqueued: ids.length,
      };
    } catch (err) {
      logger.error("ingest failed", { reason, error: errorMessage(err) });
      return { ok: false, reason, error: errorMessage(err) };
    }
  }
}
