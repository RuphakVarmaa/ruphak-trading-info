/** Scoring: clusters → LLM (or lexicon) scores → story-key merges → event pressure. */
import type { TradingCalendar } from "../calendar/calendar";
import type { Clock } from "../clock";
import { HOUR_MS } from "../clock";
import type { EngineConfig } from "../config";
import { mergeClustersByKey } from "../events/cluster";
import type { ScoringContext } from "../events/llm/digest";
import { scoreClusters } from "../events/llm/scorer";
import { computePressure } from "../events/pressure";
import type { LlmClient, LlmUsage, Logger, Repository } from "../ports";
import { INDEX_IDS, type ArticleCluster, type Candle, type EventPressure, type IndexId, type ScoredEvent } from "../types";
import { logRetPct } from "../util/math";
import { clusterParams, recordSourceHealth } from "./ingestCycle";

export interface ScoringDeps {
  cfg: EngineConfig;
  clock: Clock;
  calendar: TradingCalendar;
  repo: Repository;
  logger: Logger;
  /** null = LLM disabled or over budget: lexicon scores only. */
  llm: LlmClient | null;
  /** Recent 5-minute index candles for "move since first seen" (optional). */
  indexCandles?: Partial<Record<IndexId, Candle[]>>;
}

export interface ScoringReport {
  at: number;
  scored: number;
  llmScored: number;
  fallbackScored: number;
  merged: number;
  removed: number;
  usage: LlmUsage;
  errors: string[];
  pressure: EventPressure[];
}

const MAX_LLM_ATTEMPTS = 3;

function moveSince(candles: Candle[] | undefined, fromMs: number): number | null {
  if (!candles || candles.length === 0) return null;
  let from: Candle | null = null;
  for (const c of candles) {
    if (c.t <= fromMs) from = c;
    else break;
  }
  const last = candles[candles.length - 1];
  if (!from || last.t <= from.t) return null;
  return logRetPct(from.c, last.c);
}

export async function buildScoringContext(deps: ScoringDeps, nowMs: number, excludeIds: Set<string>): Promise<ScoringContext> {
  const snap = await deps.repo.snapshots.latest();
  const fresh = snap && nowMs - snap.t < 6 * HOUR_MS ? snap : null;
  const known = (await deps.repo.events.active(nowMs - deps.cfg.events.knownClusterWindowHours * HOUR_MS))
    .filter((e) => !excludeIds.has(e.clusterId))
    .sort((a, b) => b.firstSeenMs - a.firstSeenMs)
    .map((e) => ({ key: e.clusterKey, oneLiner: e.title, firstSeenMs: e.firstSeenMs }));
  return {
    nowMs,
    market: {
      niftyRetTodayPct: fresh?.features.NIFTY?.retFromOpen ?? null,
      sensexRetTodayPct: fresh?.features.SENSEX?.retFromOpen ?? null,
      vix: fresh?.features.NIFTY?.vix ?? null,
      vixChangePct: fresh?.features.NIFTY?.vixChangePct ?? null,
    },
    upcomingEvents: deps.calendar
      .scheduledEvents(nowMs, nowMs + 24 * HOUR_MS, { includeExpiries: false })
      .map((e) => ({ title: e.title, at: e.at, impact: e.impact })),
    knownClusters: known,
    indexMoveSince: deps.indexCandles
      ? (ms) => ({ NIFTY: moveSince(deps.indexCandles?.NIFTY, ms), SENSEX: moveSince(deps.indexCandles?.SENSEX, ms) })
      : undefined,
  };
}

/** Recomputes and stores the EPI for every index from live events. */
export async function refreshPressure(repo: Repository, cfg: EngineConfig, nowMs: number): Promise<EventPressure[]> {
  const events = await repo.events.active(nowMs - cfg.events.staleAfterHours * HOUR_MS);
  const out: EventPressure[] = [];
  for (const index of INDEX_IDS) {
    const p = computePressure(events, index, nowMs, cfg.events);
    await repo.pressure.append(p);
    out.push(p);
  }
  return out;
}

export async function runScoringCycle(deps: ScoringDeps, opts: { clusterIds?: string[]; limit?: number } = {}): Promise<ScoringReport> {
  const { cfg, clock, repo, logger } = deps;
  const now = clock.now();
  const loaded = opts.clusterIds
    ? await repo.clusters.byIds(opts.clusterIds)
    : await repo.clusters.needingScore(opts.limit ?? cfg.llm.maxClustersPerCycle);
  // Idempotent under queue redelivery: skip clusters that are already scored.
  const todo = loaded.filter((c) => c.status === "UNSCORED" || c.status === "RESCORE").slice(0, opts.limit ?? cfg.llm.maxClustersPerCycle);
  const report: ScoringReport = {
    at: now,
    scored: 0,
    llmScored: 0,
    fallbackScored: 0,
    merged: 0,
    removed: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    errors: [],
    pressure: [],
  };
  if (todo.length === 0) {
    report.pressure = await refreshPressure(repo, cfg, now);
    return report;
  }

  const ctx = await buildScoringContext(deps, now, new Set(todo.map((c) => c.id)));
  const res = await scoreClusters(todo, ctx, deps.llm, cfg, logger);
  report.usage = res.usage;
  report.errors = res.errors;
  report.llmScored = res.llmScored;
  report.fallbackScored = res.fallbackScored;
  if (deps.llm) await recordSourceHealth(repo, "claude", res.errors.length === 0, now, res.errors[0]);

  const failed = new Set(res.failedClusterIds);
  const eventByCluster = new Map(res.events.map((e) => [e.clusterId, e]));
  const updated: ArticleCluster[] = todo.map((c) => {
    const e = eventByCluster.get(c.id)!;
    const attempts = (c.scoreAttempts ?? 0) + (failed.has(c.id) ? 1 : 0);
    return {
      ...c,
      key: e.scorer === "llm" ? e.clusterKey : c.key,
      status: failed.has(c.id) && attempts < MAX_LLM_ATTEMPTS ? "RESCORE" : "SCORED",
      scoredArticleCount: c.articleCount,
      scoredToneMean: c.toneMean,
      scoredAtMs: now,
      scoreAttempts: failed.has(c.id) ? attempts : 0,
    };
  });

  // Layer-3 dedup: merge clusters (new and recent) that the LLM says are the same story.
  const keys = new Set(updated.map((c) => c.key).filter((k): k is string => !!k));
  const recent = (await repo.clusters.active(now - cfg.events.knownClusterWindowHours * HOUR_MS)).filter(
    (c) => c.key && keys.has(c.key) && !updated.some((u) => u.id === c.id),
  );
  const { merged, removedIds } = mergeClustersByKey([...updated, ...recent], clusterParams(cfg));
  const removed = new Set(removedIds);
  const mergedById = new Map(merged.map((c) => [c.id, c]));
  const finalClusters = [...updated.filter((c) => !removed.has(c.id) && !mergedById.has(c.id)), ...merged];
  await repo.clusters.upsertMany(finalClusters);
  if (removedIds.length > 0) {
    await repo.clusters.deleteMany(removedIds);
    await repo.events.deleteByClusterIds(removedIds);
  }

  // Events: keep scores of surviving clusters; a merged primary keeps its own score until re-scored.
  const keep: ScoredEvent[] = [];
  for (const e of res.events) {
    if (removed.has(e.clusterId)) continue;
    const m = mergedById.get(e.clusterId);
    keep.push(m ? { ...e, articleCount: m.articleCount, firstSeenMs: m.firstSeenMs } : e);
  }
  await repo.events.upsertMany(keep);
  report.scored = keep.length;
  report.merged = merged.length;
  report.removed = removedIds.length;
  report.pressure = await refreshPressure(repo, cfg, now);
  logger.info("scoring cycle", { scored: keep.length, llm: res.llmScored, fallback: res.fallbackScored, merged: merged.length, removed: removedIds.length });
  return report;
}
