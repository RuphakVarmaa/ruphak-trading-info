/** Ingest: fetch → relevance filter → normalize → dedupe → cluster → persist. */
import type { Clock } from "../clock";
import { HOUR_MS } from "../clock";
import type { EngineConfig } from "../config";
import { clusterArticles, type ClusterParams } from "../events/cluster";
import { extractLocation } from "../events/geo";
import { isMarketRelevant } from "../events/lexicon";
import { normalizeArticles } from "../events/normalize";
import type { ArticleFetcher } from "../events/sources";
import type { Logger, Repository } from "../ports";
import type { RawArticle, SourceHealth } from "../types";

export interface IngestDeps {
  cfg: EngineConfig;
  clock: Clock;
  repo: Repository;
  logger: Logger;
  fetchers: ArticleFetcher[];
}

export interface IngestReport {
  at: number;
  fetched: Record<string, number>;
  errors: Record<string, string>;
  relevant: number;
  newArticles: number;
  clustersCreated: number;
  clustersUpdated: number;
  /** Clusters that need (re)scoring after this cycle. */
  needingScore: string[];
}

export function clusterParams(cfg: EngineConfig): ClusterParams {
  return {
    windowHours: cfg.events.clusterWindowHours,
    jaccardThreshold: cfg.events.jaccardThreshold,
    entityOverlapThreshold: cfg.events.entityOverlapThreshold,
    entityJaccardFloor: cfg.events.entityJaccardFloor,
    rescoreAfterNewArticles: cfg.events.rescoreAfterNewArticles,
    rescoreToneShift: cfg.events.rescoreToneShift,
  };
}

export async function recordSourceHealth(repo: Repository, source: string, ok: boolean, nowMs: number, detail?: string): Promise<void> {
  const key = `health:${source}`;
  const prev = (await repo.state.get<SourceHealth>(key)) ?? { ok, lastOkMs: null, lastErrorMs: null };
  await repo.state.set<SourceHealth>(key, {
    ok,
    lastOkMs: ok ? nowMs : prev.lastOkMs,
    lastErrorMs: ok ? prev.lastErrorMs : nowMs,
    detail: detail?.slice(0, 200),
  });
}

export async function runIngestCycle(deps: IngestDeps): Promise<IngestReport> {
  const { cfg, clock, repo, logger } = deps;
  const now = clock.now();
  const report: IngestReport = { at: now, fetched: {}, errors: {}, relevant: 0, newArticles: 0, clustersCreated: 0, clustersUpdated: 0, needingScore: [] };

  const raw: RawArticle[] = [];
  const results = await Promise.allSettled(deps.fetchers.map((f) => f.fetch()));
  results.forEach((r, i) => {
    const name = deps.fetchers[i].name;
    if (r.status === "fulfilled") {
      report.fetched[name] = r.value.length;
      raw.push(...r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      report.errors[name] = msg;
      logger.warn(`ingest source ${name} failed`, { error: msg });
    }
  });
  for (const f of deps.fetchers) {
    await recordSourceHealth(repo, f.name === "google_rss" ? "rss" : f.name, !report.errors[f.name], clock.now(), report.errors[f.name]);
  }

  const cutoff = now - cfg.ingest.lookbackHours * HOUR_MS;
  const relevant = raw.filter((a) => {
    const t = Date.parse(a.publishedAt);
    return Number.isFinite(t) && t >= cutoff && isMarketRelevant(`${a.title} ${a.description ?? ""}`);
  });
  report.relevant = relevant.length;

  const normalized = await normalizeArticles(relevant, now);
  const known = await repo.articles.knownIds(normalized.map((a) => a.id));
  const fresh = normalized.filter((a) => !known.has(a.id));
  report.newArticles = fresh.length;
  if (fresh.length === 0) return report;

  const active = await repo.clusters.active(now - cfg.events.clusterWindowHours * HOUR_MS);
  const { touched, createdIds, updatedIds } = clusterArticles(fresh, active, clusterParams(cfg), (t) => extractLocation(t)?.name);
  // Age-based re-score: a scored story that is still drawing coverage hours later.
  for (const c of touched) {
    if (c.status === "SCORED" && c.scoredAtMs !== undefined && now - c.scoredAtMs >= cfg.events.rescoreAfterHours * HOUR_MS) c.status = "RESCORE";
  }
  await repo.articles.upsertMany(fresh);
  await repo.clusters.upsertMany(touched);
  report.clustersCreated = createdIds.size;
  report.clustersUpdated = updatedIds.size;
  report.needingScore = touched.filter((c) => c.status === "UNSCORED" || c.status === "RESCORE").map((c) => c.id);
  logger.info("ingest cycle", { fetched: report.fetched, new: fresh.length, created: createdIds.size, updated: updatedIds.size });
  return report;
}
