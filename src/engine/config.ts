/**
 * Every tunable of the engine lives here, with opinionated defaults.
 * Backtests, paper trading and live trading all read the same EngineConfig.
 */
import type { Exchange, Horizon, IndexId, Regime, SignalSource } from "./types";

/** Exchange-mandated and broker charges for index options, effective from a date. */
export interface ChargeSchedule {
  /** IST date YYYY-MM-DD from which this schedule applies. */
  effectiveFrom: string;
  brokeragePerOrder: number;
  /** STT on the SELL side, percent of premium turnover. */
  sttSellPct: number;
  /** Exchange transaction charges, percent of premium turnover, both sides. */
  exchangeTxnPct: Record<Exchange, number>;
  /** SEBI turnover fee, percent of premium turnover (Rs 10 per crore = 0.0001%). */
  sebiPct: number;
  /** Stamp duty on the BUY side, percent of premium turnover. */
  stampBuyPct: number;
  /** Investor Protection Fund Trust charge, percent of premium turnover. */
  ipftPct: number;
  /** GST percent applied to brokerage + exchange transaction + SEBI + IPFT. */
  gstPct: number;
}

/**
 * Index option charges as Groww publishes them (exchange charges are passed through).
 * Budget 2026 raised STT on option sales from 0.1% to 0.15% of premium from 1 April 2026.
 * Brokerage is Groww's flat Rs 20 per executed F&O order. Sources: Groww pricing page,
 * Zerodha charges page (docs/RESEARCH.md).
 */
export const CHARGE_SCHEDULES: readonly ChargeSchedule[] = [
  {
    effectiveFrom: "2024-10-01",
    brokeragePerOrder: 20,
    sttSellPct: 0.1,
    exchangeTxnPct: { NSE: 0.03503, BSE: 0.0325 },
    sebiPct: 0.0001,
    stampBuyPct: 0.003,
    ipftPct: 0.0005,
    gstPct: 18,
  },
  {
    effectiveFrom: "2026-04-01",
    brokeragePerOrder: 20,
    sttSellPct: 0.15,
    exchangeTxnPct: { NSE: 0.03503, BSE: 0.0325 },
    sebiPct: 0.0001,
    stampBuyPct: 0.003,
    ipftPct: 0.0005,
    gstPct: 18,
  },
] as const;

export interface IndexSpec {
  exchange: Exchange;
  /** Strike interval used for ATM rounding. */
  strikeStep: number;
  /** Fallback lot size; the instrument master is authoritative. */
  lotSize: number;
  tickSize: number;
  /** ISO weekday of the weekly expiry: 1 = Monday ... 7 = Sunday. */
  weeklyExpiryWeekday: number;
  /** Groww underlying symbol in the instrument master. */
  underlying: string;
  /** Groww exchange symbol for LTP calls, e.g. NSE_NIFTY. */
  ltpSymbol: string;
}

export interface EngineConfig {
  capitalRupees: number;
  indices: IndexId[];
  indexSpecs: Record<IndexId, IndexSpec>;
  rubricVersion: string;
  llm: {
    enabled: boolean;
    model: string;
    effort: "low" | "medium" | "high";
    /** Clusters per scoring request. */
    batchSize: number;
    maxClustersPerCycle: number;
    timeoutMs: number;
  };
  ingest: {
    gnewsQueries: string[];
    rssQueries: string[];
    gdeltQueries: string[];
    gdeltMinIntervalMs: number;
    lookbackHours: number;
  };
  events: {
    halfLifeHoursByTaxonomy: Record<string, number>;
    halfLifeHoursByHorizon: Record<Horizon, number>;
    /** Article count at which coverage saturates (log scale). */
    coverageSaturationK: number;
    /** Events older than this many half-lives stop contributing. */
    maxHalfLives: number;
    staleAfterHours: number;
    rescoreAfterNewArticles: number;
    rescoreToneShift: number;
    rescoreAfterHours: number;
    clusterWindowHours: number;
    knownClusterWindowHours: number;
    jaccardThreshold: number;
    entityOverlapThreshold: number;
    entityJaccardFloor: number;
  };
  features: {
    /** Overnight-gap betas: index gap percent per 1% move (US10Y per basis point). */
    gapBetas: Record<string, number>;
    rvBars: number;
    divergenceBars: number;
    openingRangeMin: number;
    sessionLookbackDays: number;
  };
  regime: {
    trendRet60mPct: number;
    trendEfficiency: number;
    trendVwapBars: number;
    highVolVix: number;
    highVolRvIv: number;
    highVolAtrPctile: number;
    eventAbsPressure: number;
    eventFreshMin: number;
    eventWindowBeforeMin: number;
    eventWindowAfterMin: number;
    eventVixJumpPct: number;
  };
  conviction: {
    priorWeights: Record<SignalSource, number>;
    /** Pseudo-trades of prior weight in the shrinkage estimator. */
    shrinkK: number;
    /** tanh gain applied to the weighted mean. */
    gain: number;
    thresholds: Record<Regime, number>;
    counterTrendThreshold: number;
    /** Sources that may vote in the EVENT regime. */
    eventRegimeSources: SignalSource[];
  };
  gates: {
    noEntryBeforeIst: string;
    noEntryAfterIst: string;
    expiryDayNoEntryMinBeforeClose: number;
    preEventBlackoutMin: number;
    postEventWaitMin: number;
    minEdgeRatio: number;
    minExpectedVsImplied: number;
    maxSpreadPct: number;
    minOi: number;
    maxDataAgeSec: number;
    maxEventAgeMinForEventPlay: number;
    /** Expected-move multiplier per unit of conviction (calibrated in backtests). */
    kEM: number;
    /** Multiplier on VIX-implied vol for short intraday horizons. */
    intradayVolFactor: number;
    stopOutCooldownMin: number;
  };
  sizing: {
    defaultRiskPct: number;
    minRiskPct: number;
    maxRiskPctPerTrade: number;
    maxPremiumPctPerTrade: number;
    kellyFraction: number;
    kellyMinTrades: number;
    maxLots: number;
    maxOpenPerIndex: number;
    maxTradesPerDay: number;
    maxCombinedPremiumPct: number;
  };
  exits: {
    stopPct: number;
    targetPct: number;
    trailActivatePct: number;
    trailGivebackPct: number;
    squareOffIst: string;
    horizonMinByRegime: Record<Regime, number>;
    /** Time stop fires only when P&L is below this percent of premium. */
    timeStopMinPnlPct: number;
    /** Signal flip exits when |score| >= threshold * this fraction on the other side. */
    flipExitFraction: number;
    targetChaseSec: number;
  };
  risk: {
    dailyLossCapPct: number;
    weeklyLossCapPct: number;
    maxConsecutiveLossesPerDay: number;
    staleDataHaltSec: number;
    reconcileMismatchHalts: boolean;
  };
  broker: {
    slippageTicksMarket: number;
    limitChaseTimeoutSec: number;
    partialFillDepthLevels: number;
    /** Simulated order latency for paper fills. */
    paperLatencyMs: number;
    product: "MIS" | "NRML";
  };
  pricing: {
    /** Risk-free rate, annual decimal. */
    r: number;
    /** Multiplier on India VIX to approximate each index's ATM weekly IV. */
    vixMultiplier: Record<IndexId, number>;
    spreadModel: { minTicks: number; pctOfPremium: number };
    tradingMinutesPerDay: number;
    tradingDaysPerYear: number;
  };
  decay: {
    windowTrades: number;
    disableMinTrades: number;
    disableIfExpectancyPctBelow: number;
    disableIfTStatBelow: number;
    reenableShadowTrades: number;
    probationTrades: number;
  };
}

export const DEFAULT_CONFIG: EngineConfig = {
  capitalRupees: 500_000,
  indices: ["NIFTY", "SENSEX"],
  indexSpecs: {
    NIFTY: { exchange: "NSE", strikeStep: 50, lotSize: 65, tickSize: 0.05, weeklyExpiryWeekday: 2, underlying: "NIFTY", ltpSymbol: "NSE_NIFTY" },
    SENSEX: { exchange: "BSE", strikeStep: 100, lotSize: 20, tickSize: 0.05, weeklyExpiryWeekday: 4, underlying: "SENSEX", ltpSymbol: "BSE_SENSEX" },
  },
  rubricVersion: "rubric-v1",
  llm: {
    enabled: true,
    model: "claude-opus-5-5",
    effort: "medium",
    batchSize: 10,
    maxClustersPerCycle: 40,
    timeoutMs: 60_000,
  },
  ingest: {
    gnewsQueries: [
      "Nifty OR Sensex OR RBI OR rupee",
      "FII OR FPI India stocks",
      "crude oil OPEC prices",
      "Federal Reserve OR FOMC OR treasury yields",
      "Iran OR Israel OR Taiwan OR Ukraine war",
    ],
    rssQueries: [
      "Nifty Sensex stock market India",
      "RBI policy rupee inflation India",
      "FII FPI outflow India",
      "crude oil OPEC Brent",
      "Federal Reserve rate decision",
      "geopolitical conflict oil shipping Hormuz Red Sea",
      "China stimulus economy markets",
    ],
    gdeltQueries: [
      "(India OR Nifty OR Sensex OR RBI) sourcelang:english",
      "(\"Federal Reserve\" OR FOMC OR \"Treasury yields\") sourcelang:english",
      "(crude OR OPEC OR Brent) sourcelang:english",
      "(war OR missile OR sanctions OR blockade) sourcelang:english",
      "(China stimulus OR yuan OR PBOC) sourcelang:english",
      "sourcecountry:IN (market OR economy OR policy)",
    ],
    gdeltMinIntervalMs: 5_500,
    lookbackHours: 24,
  },
  events: {
    halfLifeHoursByTaxonomy: {
      GEOPOLITICAL: 12,
      MACRO_POLICY: 48,
      COMMODITY_SHOCK: 24,
      FII_FLOWS: 72,
      CORPORATE_EARNINGS: 4,
      DOMESTIC_POLITICS_REGULATION: 24,
      WEATHER_DISASTER: 96,
      US_MARKET_FED: 24,
      CHINA: 24,
      OTHER: 12,
      SCHEDULED_DATA: 4,
    },
    halfLifeHoursByHorizon: { INTRADAY: 4, DAYS_1_2: 24, WEEK: 72, MONTH_PLUS: 240 },
    coverageSaturationK: 20,
    maxHalfLives: 4,
    staleAfterHours: 120,
    rescoreAfterNewArticles: 5,
    rescoreToneShift: 3,
    rescoreAfterHours: 6,
    clusterWindowHours: 36,
    knownClusterWindowHours: 72,
    jaccardThreshold: 0.45,
    entityOverlapThreshold: 0.6,
    entityJaccardFloor: 0.3,
  },
  features: {
    gapBetas: { ES: 0.45, NQ: 0.1, CL: -0.08, DXY: -0.15, USDINR: -1.5, US10Y: -0.01, N225: 0.1, HSI: 0.1, SSE: 0.05 },
    rvBars: 24,
    divergenceBars: 6,
    openingRangeMin: 15,
    sessionLookbackDays: 20,
  },
  regime: {
    trendRet60mPct: 0.35,
    trendEfficiency: 0.6,
    trendVwapBars: 6,
    highVolVix: 18,
    highVolRvIv: 1.5,
    highVolAtrPctile: 90,
    eventAbsPressure: 0.5,
    eventFreshMin: 60,
    eventWindowBeforeMin: 15,
    eventWindowAfterMin: 30,
    eventVixJumpPct: 8,
  },
  conviction: {
    priorWeights: { EVENT: 0.35, MOMENTUM: 0.25, GAP: 0.15, RELATIVE_VALUE: 0.1, GLOBAL_BETA: 0.15, VOL_REGIME: 0 },
    shrinkK: 30,
    gain: 1.5,
    thresholds: { TREND_UP: 0.35, TREND_DOWN: 0.35, RANGE: 0.55, HIGH_VOL: 0.5, EVENT: 0.45 },
    counterTrendThreshold: 0.6,
    eventRegimeSources: ["EVENT", "GAP"],
  },
  gates: {
    noEntryBeforeIst: "09:25",
    noEntryAfterIst: "14:30",
    expiryDayNoEntryMinBeforeClose: 90,
    preEventBlackoutMin: 15,
    postEventWaitMin: 5,
    minEdgeRatio: 0.15,
    minExpectedVsImplied: 0.5,
    maxSpreadPct: 1.5,
    minOi: 50_000,
    maxDataAgeSec: 180,
    maxEventAgeMinForEventPlay: 120,
    kEM: 1.0,
    intradayVolFactor: 1.1,
    stopOutCooldownMin: 30,
  },
  sizing: {
    defaultRiskPct: 0.75,
    minRiskPct: 0.25,
    maxRiskPctPerTrade: 1.0,
    maxPremiumPctPerTrade: 4,
    kellyFraction: 0.25,
    kellyMinTrades: 20,
    maxLots: 10,
    maxOpenPerIndex: 1,
    maxTradesPerDay: 4,
    maxCombinedPremiumPct: 6,
  },
  exits: {
    stopPct: -30,
    targetPct: 50,
    trailActivatePct: 30,
    trailGivebackPct: 50,
    squareOffIst: "15:05",
    horizonMinByRegime: { TREND_UP: 120, TREND_DOWN: 120, RANGE: 90, HIGH_VOL: 60, EVENT: 180 },
    timeStopMinPnlPct: 10,
    flipExitFraction: 0.5,
    targetChaseSec: 30,
  },
  risk: {
    dailyLossCapPct: 3,
    weeklyLossCapPct: 6,
    maxConsecutiveLossesPerDay: 2,
    staleDataHaltSec: 600,
    reconcileMismatchHalts: true,
  },
  broker: {
    slippageTicksMarket: 2,
    limitChaseTimeoutSec: 30,
    partialFillDepthLevels: 5,
    paperLatencyMs: 1_500,
    product: "MIS",
  },
  pricing: {
    r: 0.065,
    vixMultiplier: { NIFTY: 1.0, SENSEX: 1.05 },
    spreadModel: { minTicks: 1, pctOfPremium: 0.4 },
    tradingMinutesPerDay: 375,
    tradingDaysPerYear: 252,
  },
  decay: {
    windowTrades: 30,
    disableMinTrades: 20,
    disableIfExpectancyPctBelow: 0,
    disableIfTStatBelow: -1,
    reenableShadowTrades: 10,
    probationTrades: 10,
  },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/** Returns DEFAULT_CONFIG overridden by `overrides`, validated. Throws on invalid values. */
export function makeConfig(overrides: DeepPartial<EngineConfig> = {}): EngineConfig {
  const cfg = deepMerge(DEFAULT_CONFIG, overrides);
  const problems = validateConfig(cfg);
  if (problems.length > 0) throw new Error(`Invalid engine config: ${problems.join("; ")}`);
  return cfg;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns a list of human-readable problems (empty when valid). */
export function validateConfig(cfg: EngineConfig): string[] {
  const p: string[] = [];
  const pos = (name: string, v: number) => {
    if (!(Number.isFinite(v) && v > 0)) p.push(`${name} must be > 0 (got ${v})`);
  };
  const frac = (name: string, v: number) => {
    if (!(Number.isFinite(v) && v >= 0 && v <= 1)) p.push(`${name} must be within [0, 1] (got ${v})`);
  };
  pos("capitalRupees", cfg.capitalRupees);
  if (cfg.indices.length === 0) p.push("indices must not be empty");
  for (const idx of cfg.indices) {
    const spec = cfg.indexSpecs[idx];
    if (!spec) p.push(`indexSpecs.${idx} missing`);
    else {
      pos(`indexSpecs.${idx}.strikeStep`, spec.strikeStep);
      pos(`indexSpecs.${idx}.lotSize`, spec.lotSize);
      if (!(spec.weeklyExpiryWeekday >= 1 && spec.weeklyExpiryWeekday <= 5)) p.push(`indexSpecs.${idx}.weeklyExpiryWeekday must be 1-5`);
    }
  }
  for (const [k, v] of Object.entries(cfg.conviction.thresholds)) frac(`conviction.thresholds.${k}`, v);
  frac("conviction.counterTrendThreshold", cfg.conviction.counterTrendThreshold);
  for (const [k, v] of Object.entries(cfg.conviction.priorWeights)) {
    if (!(v >= 0)) p.push(`conviction.priorWeights.${k} must be >= 0`);
  }
  for (const key of ["noEntryBeforeIst", "noEntryAfterIst"] as const) {
    if (!HHMM.test(cfg.gates[key])) p.push(`gates.${key} must be HH:MM`);
  }
  if (!HHMM.test(cfg.exits.squareOffIst)) p.push("exits.squareOffIst must be HH:MM");
  if (cfg.gates.noEntryBeforeIst >= cfg.gates.noEntryAfterIst) p.push("gates.noEntryBeforeIst must be before noEntryAfterIst");
  if (cfg.gates.noEntryAfterIst >= cfg.exits.squareOffIst) p.push("gates.noEntryAfterIst must be before exits.squareOffIst");
  if (!(cfg.exits.stopPct < 0 && cfg.exits.stopPct > -100)) p.push("exits.stopPct must be within (-100, 0)");
  pos("exits.targetPct", cfg.exits.targetPct);
  if (!(cfg.exits.trailGivebackPct > 0 && cfg.exits.trailGivebackPct < 100)) p.push("exits.trailGivebackPct must be within (0, 100)");
  pos("sizing.maxRiskPctPerTrade", cfg.sizing.maxRiskPctPerTrade);
  if (cfg.sizing.defaultRiskPct > cfg.sizing.maxRiskPctPerTrade) p.push("sizing.defaultRiskPct must not exceed maxRiskPctPerTrade");
  if (cfg.sizing.minRiskPct > cfg.sizing.defaultRiskPct) p.push("sizing.minRiskPct must not exceed defaultRiskPct");
  frac("sizing.kellyFraction", cfg.sizing.kellyFraction);
  if (!(cfg.sizing.maxOpenPerIndex >= 1)) p.push("sizing.maxOpenPerIndex must be >= 1");
  pos("risk.dailyLossCapPct", cfg.risk.dailyLossCapPct);
  pos("pricing.tradingMinutesPerDay", cfg.pricing.tradingMinutesPerDay);
  if (!(cfg.pricing.r >= 0 && cfg.pricing.r < 0.5)) p.push("pricing.r must be an annual decimal rate");
  if (!(cfg.llm.batchSize >= 1 && cfg.llm.batchSize <= 25)) p.push("llm.batchSize must be within 1-25");
  return p;
}
