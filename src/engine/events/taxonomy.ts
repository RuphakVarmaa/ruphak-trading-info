/** Numeric mappings from the categorical event score to signed index impact. */
import type { EngineConfig } from "../config";
import type {
  Confidence,
  Direction,
  IndexId,
  Magnitude,
  NiftySector,
  Novelty,
  PricedIn,
  Relevance,
  ScoredEvent,
  SectorWeight,
} from "../types";
import { clamp } from "../util/math";

export const DIRECTION_VALUE: Record<Direction, number> = { STRONG_BEAR: -1, BEAR: -0.5, NEUTRAL: 0, BULL: 0.5, STRONG_BULL: 1 };
export const MAGNITUDE_VALUE: Record<Magnitude, number> = { NONE: 0, SMALL: 0.25, MODERATE: 0.5, LARGE: 0.75, EXTREME: 1 };
/** Midpoint of each magnitude bucket's expected index move, in percent (rubric anchors). */
export const MAGNITUDE_MIDPOINT_PCT: Record<Magnitude, number> = { NONE: 0, SMALL: 0.15, MODERATE: 0.5, LARGE: 1.1, EXTREME: 2 };
export const CONFIDENCE_VALUE: Record<Confidence, number> = { LOW: 0.35, MEDIUM: 0.6, HIGH: 0.85 };
export const NOVELTY_VALUE: Record<Novelty, number> = { NEW: 1, DEVELOPMENT: 0.6, REPEAT: 0.2 };
export const PRICED_IN_VALUE: Record<PricedIn, number> = { LOW: 1, PARTIAL: 0.5, MOSTLY: 0.15 };
export const RELEVANCE_VALUE: Record<Relevance, number> = { NONE: 0, INDIRECT: 0.6, DIRECT: 1 };
export const SECTOR_WEIGHT_VALUE: Record<SectorWeight, number> = { LOW: 0.3, MEDIUM: 0.6, HIGH: 1 };

/** Approximate index weights by sector, percent (sum 100). */
export const SECTOR_WEIGHTS: Record<IndexId, Record<NiftySector, number>> = {
  NIFTY: { FINANCIALS: 33, IT: 12, OIL_GAS: 10, FMCG: 8, AUTO: 7, METALS: 4, PHARMA: 4, INFRA_OTHER: 22 },
  SENSEX: { FINANCIALS: 38, IT: 14, OIL_GAS: 11, FMCG: 9, AUTO: 6, METALS: 2, PHARMA: 2, INFRA_OTHER: 18 },
};

type ScoreCore = Pick<
  ScoredEvent,
  "impact" | "sectors" | "novelty" | "pricedIn" | "indiaRelevance" | "toneMean"
>;

/**
 * Signed impact on `index` in [-1, 1] before time decay:
 * 0.7 × (direction × magnitude × confidence) + 0.3 × index-weighted sector view,
 * discounted by novelty, priced-in and India relevance. A low-confidence score that
 * disagrees with a clearly signed GDELT tone is halved.
 */
export function toNumeric(e: ScoreCore, index: IndexId): number {
  const imp = e.impact[index];
  const direct = DIRECTION_VALUE[imp.direction] * MAGNITUDE_VALUE[imp.magnitude] * CONFIDENCE_VALUE[imp.confidence];
  let sector = 0;
  for (const s of e.sectors) {
    sector += (SECTOR_WEIGHTS[index][s.sector] / 100) * DIRECTION_VALUE[s.direction] * SECTOR_WEIGHT_VALUE[s.weight];
  }
  let raw = 0.7 * direct + 0.3 * clamp(sector, -1, 1);
  if (imp.confidence === "LOW" && typeof e.toneMean === "number" && Math.abs(e.toneMean) >= 1.5 && Math.sign(e.toneMean) !== Math.sign(raw) && raw !== 0) {
    raw *= 0.5;
  }
  const discounted = raw * NOVELTY_VALUE[e.novelty] * PRICED_IN_VALUE[e.pricedIn] * RELEVANCE_VALUE[e.indiaRelevance];
  // `|| 0` turns -0 into 0 for clean equality checks and JSON.
  return clamp(discounted, -1, 1) || 0;
}

/** Taxonomy default half-life (scheduled data releases fade fastest). */
export function defaultHalfLifeHours(e: Pick<ScoredEvent, "taxonomy" | "isScheduledData">, cfg: EngineConfig): number {
  const table = cfg.events.halfLifeHoursByTaxonomy;
  if (e.isScheduledData) return table.SCHEDULED_DATA ?? 4;
  return table[e.taxonomy] ?? 12;
}

/** The LLM's half-life clamped to the taxonomy default ±50%. */
export function clampHalfLife(llmHours: number, e: Pick<ScoredEvent, "taxonomy" | "isScheduledData">, cfg: EngineConfig): number {
  const d = defaultHalfLifeHours(e, cfg);
  if (!Number.isFinite(llmHours) || llmHours <= 0) return d;
  return clamp(llmHours, d * 0.5, d * 1.5);
}
