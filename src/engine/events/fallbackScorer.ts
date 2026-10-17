/**
 * Zero-cost scorer used when the LLM is disabled, failing or over budget. Deliberately
 * conservative: LOW confidence, PARTIAL priced-in, so it nudges rather than drives conviction.
 */
import type { EngineConfig } from "../config";
import type { ArticleCluster, Direction, EventTaxonomy, IndexImpact, Magnitude, ScoredEvent } from "../types";
import { classifyCategory, classifySeverity, GLOBAL_MACRO_TERMS, INDIA_TERMS, lexiconPolarity } from "./lexicon";
import { defaultHalfLifeHours, toNumeric } from "./taxonomy";

function taxonomyFromText(text: string): EventTaxonomy {
  const t = text.toLowerCase();
  if (/\b(rbi|repo rate|monetary policy|inflation|cpi|gdp|fiscal|budget|gst)\b/.test(t)) return "MACRO_POLICY";
  if (/\b(fed|fomc|powell|treasury|wall street|nasdaq|s&p 500|payrolls)\b/.test(t)) return "US_MARKET_FED";
  if (/\b(fiis?|fpis?|diis?|foreign (portfolio |institutional )?investors|outflows?|inflows?)\b/.test(t)) return "FII_FLOWS";
  if (/\b(china|pboc|yuan|beijing)\b/.test(t)) return "CHINA";
  if (/\b(results|earnings|profit|revenue|q[1-4])\b/.test(t)) return "CORPORATE_EARNINGS";
  if (/\b(sebi|election|parliament|ministry|regulat)/.test(t)) return "DOMESTIC_POLITICS_REGULATION";
  if (/\b(monsoon|flood|cyclone|earthquake|heatwave)\b/.test(t)) return "WEATHER_DISASTER";
  switch (classifyCategory(t)) {
    case "MILITARY":
    case "MARITIME":
      return "GEOPOLITICAL";
    case "ENERGY":
    case "MINING":
      return /\b(oil|crude|opec|brent|gas|metal|copper|gold)\b/.test(t) ? "COMMODITY_SHOCK" : "OTHER";
  }
}


function polarityDirection(p: number): Direction {
  return p > 0 ? "BULL" : p < 0 ? "BEAR" : "NEUTRAL";
}

export function scoreFallback(cluster: ArticleCluster, cfg: EngineConfig, nowMs: number): ScoredEvent {
  const text = cluster.headlines.join(". ");
  const taxonomy = taxonomyFromText(text);
  let polarity: number = lexiconPolarity(text);
  if (polarity === 0 && typeof cluster.toneMean === "number" && Math.abs(cluster.toneMean) >= 2) polarity = Math.sign(cluster.toneMean);
  // A clearly polarized headline moves the index at least a little; violent or urgent wording more.
  const magnitude: Magnitude = polarity === 0 ? "NONE" : classifySeverity(text) === "FLASH" ? "MODERATE" : "SMALL";
  const direction = magnitude === "NONE" ? "NEUTRAL" : polarityDirection(polarity);
  const impact: IndexImpact = { direction, magnitude, confidence: "LOW" };
  const indiaRelevance = INDIA_TERMS.test(text) ? "DIRECT" : GLOBAL_MACRO_TERMS.test(text) ? "INDIRECT" : "NONE";
  const base = {
    clusterId: cluster.id,
    clusterKey: cluster.key ?? cluster.id,
    scoredAtMs: nowMs,
    scorer: "fallback" as const,
    version: `${cfg.rubricVersion}-lexicon`,
    taxonomy,
    indiaRelevance,
    isScheduledData: false,
    surprise: "NA" as const,
    novelty: "NEW" as const,
    pricedIn: "PARTIAL" as const,
    horizon: "INTRADAY" as const,
    halfLifeHours: Math.min(6, defaultHalfLifeHours({ taxonomy, isScheduledData: false }, cfg)),
    impact: { NIFTY: impact, SENSEX: { ...impact } },
    sectors: [],
    rationale: magnitude === "NONE" ? "Lexicon scorer: no clear market polarity." : `Lexicon scorer: ${direction.toLowerCase()} keywords in ${cluster.articleCount} article(s).`,
    firstSeenMs: cluster.firstSeenMs,
    articleCount: cluster.articleCount,
    toneMean: cluster.toneMean,
    title: cluster.representativeTitle,
  } satisfies Omit<ScoredEvent, "numeric">;
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") } };
}
