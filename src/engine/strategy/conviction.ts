/**
 * Combines signal components into one conviction score with weights shrunk from the prior
 * toward each source's measured edge, masked by regime.
 */
import type { EngineConfig } from "../config";
import type { Conviction, IndexId, Regime, SignalComponent, SignalPerformance, SignalSource, Stance } from "../types";
import { clamp } from "../util/math";
import type { RawComponent } from "./signals";

/**
 * Shrinkage estimator: w = (n·w_emp + k·w_prior) / (n + k), with
 * w_emp = clamp(expectancy% / 20, 0, 1) · 2 · w_prior. A source with no history keeps its prior;
 * a source with negative expectancy fades toward 0 before the decay monitor disables it.
 */
export function effectiveWeight(source: SignalSource, perf: SignalPerformance | undefined, cfg: EngineConfig["conviction"]): { weight: number; enabled: boolean } {
  const prior = cfg.priorWeights[source] ?? 0;
  if (!perf) return { weight: prior, enabled: true };
  if (!perf.enabled) return { weight: 0, enabled: false };
  const n = perf.windowTrades;
  const emp = clamp(perf.expectancyPct / 20, 0, 1) * 2 * prior;
  return { weight: (n * emp + cfg.shrinkK * prior) / (n + cfg.shrinkK), enabled: true };
}

export function findPerf(perf: SignalPerformance[], source: SignalSource, index: IndexId): SignalPerformance | undefined {
  return perf.find((p) => p.source === source && p.index === index) ?? perf.find((p) => p.source === source && p.index === "ALL");
}

export function stanceOf(score: number, threshold: number): Stance {
  if (score >= threshold) return "BULLISH";
  if (score <= -threshold) return "BEARISH";
  return "NEUTRAL";
}

export function combineConviction(
  index: IndexId,
  t: number,
  raw: RawComponent[],
  regime: Regime,
  perf: SignalPerformance[],
  cfg: EngineConfig,
): Conviction {
  const masked = regime === "EVENT" ? new Set(cfg.conviction.eventRegimeSources) : null;
  const components: SignalComponent[] = raw.map((c) => {
    const { weight, enabled } = effectiveWeight(c.source, findPerf(perf, c.source, index), cfg.conviction);
    const votes = c.source !== "VOL_REGIME" && (!masked || masked.has(c.source));
    return { ...c, weight: votes ? weight : 0, enabled };
  });
  let num = 0;
  let den = 0;
  for (const c of components) {
    if (c.weight <= 0) continue;
    num += c.weight * c.value;
    den += c.weight;
  }
  const score = den > 0 ? Math.tanh(cfg.conviction.gain * (num / den)) : 0;
  let threshold = cfg.conviction.thresholds[regime];
  let sizeMult = 1;
  for (const c of components) {
    threshold += c.modifiers?.thresholdDelta ?? 0;
    sizeMult *= c.modifiers?.sizeMult ?? 1;
  }
  if (regime === "HIGH_VOL") sizeMult *= 0.5;
  if ((regime === "TREND_UP" && score < 0) || (regime === "TREND_DOWN" && score > 0)) {
    threshold = Math.max(threshold, cfg.conviction.counterTrendThreshold);
  }
  threshold = clamp(threshold, 0.05, 0.95);
  return {
    index,
    t,
    score,
    components,
    regime,
    threshold,
    passes: Math.abs(score) >= threshold,
    sizeMult,
    stance: stanceOf(score, threshold),
  };
}

/** The source contributing most to the score (largest non-zero |w·v|); MOMENTUM when nothing contributes. */
export function dominantSource(c: Conviction): SignalSource {
  let best: SignalComponent | null = null;
  for (const comp of c.components) {
    if (comp.source === "VOL_REGIME") continue;
    const m = Math.abs(comp.weight * comp.value);
    if (m > 0 && (!best || m > Math.abs(best.weight * best.value))) best = comp;
  }
  return best?.source ?? "MOMENTUM";
}

/** Shares of |w·v| per directional source, summing to 1 (equal shares when all are zero). */
export function attributionShares(c: Conviction): { source: SignalSource; share: number }[] {
  const dir = c.components.filter((x) => x.source !== "VOL_REGIME");
  const mags = dir.map((x) => Math.abs(x.weight * x.value));
  const total = mags.reduce((a, b) => a + b, 0);
  return dir.map((x, i) => ({ source: x.source, share: total > 0 ? mags[i] / total : 1 / dir.length }));
}
