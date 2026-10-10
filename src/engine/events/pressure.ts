/**
 * Event Pressure Index (EPI): a bounded, decaying sum of scored events per index.
 * epi = tanh( Σ numeric_k · coverage_k · 2^(−age_k / halfLife_k) ) over live events.
 */
import type { EngineConfig } from "../config";
import { HOUR_MS, MINUTE_MS } from "../clock";
import type { EventPressure, IndexId, PressureContributor, ScoredEvent } from "../types";

/** log(1 + n) / log(1 + K), capped at 1: 50 articles weigh ~1.3x as much as 10, not 5x. */
export function coverageWeight(articleCount: number, saturationK: number): number {
  if (articleCount <= 0) return 0;
  return Math.min(1, Math.log1p(articleCount) / Math.log1p(saturationK));
}

/** Remaining fraction of an event's impact at `nowMs` (1 at first sight, 0.5 after one half-life). */
export function decayFactor(e: Pick<ScoredEvent, "firstSeenMs" | "halfLifeHours">, nowMs: number): number {
  const ageH = Math.max(0, nowMs - e.firstSeenMs) / HOUR_MS;
  return Math.pow(2, -ageH / Math.max(0.25, e.halfLifeHours));
}

export function isLive(e: ScoredEvent, nowMs: number, cfg: EngineConfig["events"]): boolean {
  const ageH = (nowMs - e.firstSeenMs) / HOUR_MS;
  return ageH >= 0 && ageH <= Math.min(cfg.staleAfterHours, e.halfLifeHours * cfg.maxHalfLives);
}

export function eventContribution(e: ScoredEvent, index: IndexId, nowMs: number, cfg: EngineConfig["events"]): number {
  return e.numeric[index] * coverageWeight(e.articleCount, cfg.coverageSaturationK) * decayFactor(e, nowMs);
}

export function computePressure(events: ScoredEvent[], index: IndexId, nowMs: number, cfg: EngineConfig["events"], topN = 5): EventPressure {
  let signed = 0;
  let unsigned = 0;
  let active = 0;
  let freshest: number | null = null;
  const contributions: PressureContributor[] = [];
  for (const e of events) {
    if (!isLive(e, nowMs, cfg)) continue;
    const c = eventContribution(e, index, nowMs, cfg);
    const ageMin = Math.round((nowMs - e.firstSeenMs) / MINUTE_MS);
    if (Math.abs(c) < 1e-4) continue;
    active++;
    signed += c;
    unsigned += Math.abs(c);
    if (freshest === null || ageMin < freshest) freshest = ageMin;
    contributions.push({ clusterId: e.clusterId, clusterKey: e.clusterKey, title: e.title, contribution: c, ageMin });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    index,
    t: nowMs,
    epi: Math.tanh(signed),
    absPressure: Math.tanh(unsigned),
    activeClusters: active,
    freshestEventAgeMin: freshest,
    topContributors: contributions.slice(0, topN),
  };
}
