/**
 * Domain types for the event-driven NIFTY / SENSEX options engine.
 *
 * Conventions:
 * - Time is epoch milliseconds (UTC) everywhere. IST helpers live in clock.ts.
 * - Money is Indian rupees as plain numbers.
 * - Percentages are expressed in percent units (0.5 means 0.5%) unless the field
 *   name says "Frac" or the doc comment says otherwise.
 * - Nothing in src/engine imports Node, DOM-only or Cloudflare APIs: only fetch,
 *   crypto.subtle, Date and TextEncoder/TextDecoder.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type IndexId = "NIFTY" | "SENSEX";
export const INDEX_IDS: readonly IndexId[] = ["NIFTY", "SENSEX"] as const;

/** Indices used as features (BANKNIFTY is not traded, only observed). */
export type FeatureIndexId = IndexId | "BANKNIFTY";

export type Exchange = "NSE" | "BSE";
export type OptionType = "CE" | "PE";
export type Side = "BUY" | "SELL";
export type Stance = "BULLISH" | "BEARISH" | "NEUTRAL";
export type TradeSide = "BULL" | "BEAR";

/** Where an order/position lives. BACKTEST never reaches the database. */
export type TradingMode = "BACKTEST" | "PAPER" | "LIVE";

export type Regime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "EVENT";
export const REGIMES: readonly Regime[] = ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "EVENT"] as const;

export type SessionPhase = "PRE_OPEN" | "OPEN" | "CLOSED" | "HOLIDAY";

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** OHLCV bar. `t` is the bar OPEN time in epoch ms. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi?: number;
}

export interface Level {
  price: number;
  qty: number;
}

export interface Quote {
  symbol: string;
  t: number;
  ltp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  depth?: { buy: Level[]; sell: Level[] };
  /** Implied volatility in percent (e.g. 14.2). */
  iv?: number;
  oi?: number;
  volume?: number;
  source: "groww" | "synthetic" | "groww-historical" | "replay";
}

export interface OptionContract {
  index: IndexId;
  exchange: Exchange;
  /** Exchange trading symbol, e.g. NIFTY26O1319250CE. Always resolved from the instrument master. */
  tradingSymbol: string;
  /** Groww symbol, e.g. NSE-NIFTY-13Oct26-19250-CE. */
  growwSymbol: string;
  exchangeToken: string;
  /** Expiry date as YYYY-MM-DD (IST calendar date). */
  expiry: string;
  strike: number;
  type: OptionType;
  lotSize: number;
  tickSize: number;
  freezeQty?: number;
}

/** Symbols the engine reads from the market-data source. */
export const MARKET_SYMBOLS = {
  NIFTY: "^NSEI",
  SENSEX: "^BSESN",
  BANKNIFTY: "^NSEBANK",
  INDIAVIX: "^INDIAVIX",
  ES: "ES=F",
  NQ: "NQ=F",
  CL: "CL=F",
  BZ: "BZ=F",
  GC: "GC=F",
  DXY: "DX-Y.NYB",
  USDINR: "USDINR=X",
  US10Y: "^TNX",
  VIXUS: "^VIX",
  N225: "^N225",
  HSI: "^HSI",
  SSE: "000001.SS",
} as const;
export type MarketSymbolKey = keyof typeof MARKET_SYMBOLS;
export type GlobalKey = "ES" | "NQ" | "CL" | "BZ" | "GC" | "DXY" | "USDINR" | "US10Y" | "VIXUS" | "N225" | "HSI" | "SSE";
export const GLOBAL_KEYS: readonly GlobalKey[] = [
  "ES", "NQ", "CL", "BZ", "GC", "DXY", "USDINR", "US10Y", "VIXUS", "N225", "HSI", "SSE",
] as const;

export interface MarketSnapshot {
  t: number;
  /** 5-minute candles keyed by MARKET_SYMBOLS value (e.g. "^NSEI"), oldest first. */
  candles: Record<string, Candle[]>;
  /** Daily candles keyed by symbol, oldest first (for 20-day stats and prior closes). */
  daily: Record<string, Candle[]>;
  /** Real-time LTP for the traded indices (from the broker when available). */
  ltp: Partial<Record<FeatureIndexId, number>>;
  /** Age in seconds of the freshest index observation at `t`. */
  dataAgeSec: number;
  /**
   * Age in seconds of each traded index's own latest observation at `t`. A frozen SENSEX must not
   * borrow NIFTY's freshness, so features read their own index's age when it is present.
   */
  dataAgeSecByIndex?: Partial<Record<FeatureIndexId, number>>;
  /**
   * When each symbol's latest price was traded (epoch ms): Yahoo's regularMarketTime, or the fetch
   * time of a broker LTP that replaced it. Absent in replays.
   */
  asOfMs?: Partial<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventTaxonomy =
  | "GEOPOLITICAL"
  | "MACRO_POLICY"
  | "COMMODITY_SHOCK"
  | "FII_FLOWS"
  | "CORPORATE_EARNINGS"
  | "DOMESTIC_POLITICS_REGULATION"
  | "WEATHER_DISASTER"
  | "US_MARKET_FED"
  | "CHINA"
  | "OTHER";
export const EVENT_TAXONOMIES: readonly EventTaxonomy[] = [
  "GEOPOLITICAL", "MACRO_POLICY", "COMMODITY_SHOCK", "FII_FLOWS", "CORPORATE_EARNINGS",
  "DOMESTIC_POLITICS_REGULATION", "WEATHER_DISASTER", "US_MARKET_FED", "CHINA", "OTHER",
] as const;

export type NiftySector = "FINANCIALS" | "IT" | "OIL_GAS" | "FMCG" | "AUTO" | "METALS" | "PHARMA" | "INFRA_OTHER";
export const NIFTY_SECTORS: readonly NiftySector[] = [
  "FINANCIALS", "IT", "OIL_GAS", "FMCG", "AUTO", "METALS", "PHARMA", "INFRA_OTHER",
] as const;

export type Direction = "STRONG_BEAR" | "BEAR" | "NEUTRAL" | "BULL" | "STRONG_BULL";
export type Magnitude = "NONE" | "SMALL" | "MODERATE" | "LARGE" | "EXTREME";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type Horizon = "INTRADAY" | "DAYS_1_2" | "WEEK" | "MONTH_PLUS";
export type Novelty = "NEW" | "DEVELOPMENT" | "REPEAT";
export type PricedIn = "LOW" | "PARTIAL" | "MOSTLY";
export type Relevance = "NONE" | "INDIRECT" | "DIRECT";
export type Surprise = "POSITIVE" | "NEGATIVE" | "INLINE" | "NA";
export type SectorWeight = "LOW" | "MEDIUM" | "HIGH";

export type ArticleSource = "gnews" | "google_rss" | "gdelt" | "publisher_rss" | "bing_rss";

export interface RawArticle {
  source: ArticleSource;
  title: string;
  description?: string;
  url: string;
  /** ISO timestamp or anything Date.parse understands. */
  publishedAt: string;
  publisher?: string;
  /** GDELT tone (roughly -10..+10) when available. */
  tone?: number;
  sourceCountry?: string;
  language?: string;
}

export interface NormalizedArticle extends RawArticle {
  /** sha256(canonicalUrl) as lowercase hex. */
  id: string;
  canonicalUrl: string;
  /** Lowercased title with publisher suffix and punctuation removed. */
  normTitle: string;
  /** Word 3-grams of normTitle. */
  shingles: string[];
  /** Salient tokens: proper nouns, numbers, lexicon hits (RBI, Fed, crude...). */
  entities: string[];
  publishedMs: number;
  ingestedMs: number;
}

export type ClusterStatus = "UNSCORED" | "SCORED" | "RESCORE" | "STALE";

export interface ArticleCluster {
  id: string;
  /** Canonical story slug assigned by the LLM, used to merge clusters about the same story. */
  key?: string;
  articleIds: string[];
  representativeTitle: string;
  /** Up to 5 most distinct headlines. */
  headlines: string[];
  /** Article URLs (same order as headlines when possible) for the dashboard. */
  urls: string[];
  firstSeenMs: number;
  lastSeenMs: number;
  articleCount: number;
  toneMean?: number;
  toneN?: number;
  sources: string[];
  status: ClusterStatus;
  /** articleCount at the time of the last score, for re-score triggers. */
  scoredArticleCount?: number;
  /** toneMean at the time of the last score. */
  scoredToneMean?: number;
  /** When the cluster was last scored. */
  scoredAtMs?: number;
  /** LLM attempts that failed; after 3 the lexicon score is kept. */
  scoreAttempts?: number;
  /** Location hint from the geo lexicon, used by the map. */
  locationName?: string;
}

export interface IndexImpact {
  direction: Direction;
  magnitude: Magnitude;
  confidence: Confidence;
}

export interface SectorImpact {
  sector: NiftySector;
  direction: Direction;
  weight: SectorWeight;
}

export interface ScoredEvent {
  clusterId: string;
  clusterKey: string;
  scoredAtMs: number;
  scorer: "llm" | "fallback";
  model?: string;
  /** Rubric version, e.g. "rubric-v1". */
  version: string;
  taxonomy: EventTaxonomy;
  indiaRelevance: Relevance;
  isScheduledData: boolean;
  surprise: Surprise;
  novelty: Novelty;
  pricedIn: PricedIn;
  horizon: Horizon;
  halfLifeHours: number;
  impact: Record<IndexId, IndexImpact>;
  sectors: SectorImpact[];
  rationale: string;
  /** Derived signed impact per index in [-1, 1] before time decay. */
  numeric: Record<IndexId, number>;
  firstSeenMs: number;
  articleCount: number;
  toneMean?: number;
  /** Representative headline, denormalized for display. */
  title: string;
}

export interface PressureContributor {
  clusterId: string;
  clusterKey: string;
  title: string;
  /** Signed contribution to the pre-tanh sum. */
  contribution: number;
  ageMin: number;
}

export interface EventPressure {
  index: IndexId;
  t: number;
  /** Signed Event Pressure Index in [-1, 1]. */
  epi: number;
  /** Unsigned "something is happening" level in [0, 1]. */
  absPressure: number;
  activeClusters: number;
  freshestEventAgeMin: number | null;
  topContributors: PressureContributor[];
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type ScheduledEventKind = "RBI" | "FOMC" | "US_CPI" | "US_NFP" | "IN_CPI" | "IN_GDP" | "BUDGET" | "EXPIRY" | "OTHER";
export type ImpactLevel = "HIGH" | "MED" | "LOW";

export interface ScheduledEvent {
  id: string;
  kind: ScheduledEventKind;
  title: string;
  /** Epoch ms of the release / decision. */
  at: number;
  impact: ImpactLevel;
  /** True when the date/time is an estimate rather than an official schedule. */
  approx?: boolean;
  indices: IndexId[];
}

// ---------------------------------------------------------------------------
// Features and regime
// ---------------------------------------------------------------------------

/** Classic intraday indicators for one index (5-minute bars unless noted). */
export interface Indicators {
  /** Wilder RSI(14) over the last ~120 closed bars (crosses sessions so it exists at the open). */
  rsi14: number;
  /** Wilder ADX(14) and directional indicators. */
  adx14: number;
  plusDi14: number;
  minusDi14: number;
  ema9: number;
  /** 0 until 21 bars exist. */
  ema21: number;
  /** Change of EMA9 over the last 3 bars, percent. */
  ema9SlopePct: number;
  /** Supertrend(10, 3): +1 up, −1 down, 0 while warming up. */
  supertrendDir: number;
  supertrendLine: number;
  /** Bollinger(20, 2) position of the last close (0 lower band, 1 upper band) and width in % of the middle band. */
  bbPctB: number;
  bbWidthPct: number;
  /** Today's VWAP and the spot's distance from it in standard deviations of the session's typical prices. */
  vwap: number;
  vwapZ: number;
  /** +1 when the daily EMA20 is above the EMA50, −1 below, 0 with fewer than 50 daily closes. */
  dailyBias: number;
  dailyEmaGapPct: number;
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
}

export interface OpeningRange {
  high: number;
  low: number;
  state: "FORMING" | "INSIDE" | "BROKE_UP" | "BROKE_DOWN";
  /** Distance of the last close beyond the range, in 5-minute ATRs (0 when inside or forming). */
  strengthAtr: number;
  /** Consecutive closed bars outside the range on the current side. */
  barsOutside: number;
  /** Side of the most recent close outside the range today, if any. */
  lastBreak: "UP" | "DOWN" | null;
  /** Closed bars back inside the range since the last close outside it (0 when outside or never broken). */
  barsSinceReentry: number;
}

export interface MarketFeatures {
  index: IndexId;
  t: number;
  spot: number;
  dataAgeSec: number;
  /** Log returns in percent. */
  ret5m: number;
  ret15m: number;
  ret60m: number;
  retFromOpen: number;
  vwapDistPct: number;
  /** Signed count: +n bars closed above VWAP in a row, -n below. */
  barsSameSideOfVwap: number;
  openingRange: OpeningRange;
  efficiencyRatio60m: number;
  atrPct5m: number;
  /** Percentile (0-100) of today's ATR% versus the trailing 20 sessions. */
  atrPctile20d: number;
  /** Open versus prior close, percent. */
  gapPct: number;
  /** Gap implied by overnight global moves, percent. */
  expectedGapPct: number;
  gapResidualPct: number;
  vix: number;
  vixChangePct: number;
  /** Annualized realized volatility in percent. */
  realizedVol2h: number;
  realizedVol20d: number;
  /** realizedVol2h / vix. */
  rvIvRatio: number;
  divergence: {
    /** z-score of this index's 30-minute return versus the other traded index. */
    vsOtherIndexZ: number;
    /** z-score of BANKNIFTY's 15-minute return minus this index's (NIFTY only, else 0). */
    vsBankNiftyZ: number;
    otherIndexRet30m: number;
    bankNiftyRet15m: number;
    selfRet30m: number;
  };
  /** Percent move since the prior Indian close (US10Y in basis points). */
  global: Record<GlobalKey, number | null>;
  minutesSinceOpen: number;
  minutesToClose: number;
  isExpiryDay: boolean;
  tradingDaysToExpiry: number;
  nextScheduledEvent: { id: string; name: string; impact: ImpactLevel; minutesAway: number } | null;
  /** Most recent scheduled event in the past 30 minutes, if any. */
  recentScheduledEvent: { id: string; name: string; impact: ImpactLevel; minutesAgo: number } | null;
  indicators: Indicators;
}

/** The indicator readings a decision was made on, as shown on the dashboard. */
export type IndicatorView = Indicators & { spot: number; atrPct5m: number; vwapDistPct: number; openingRange: OpeningRange };

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type SignalSource =
  | "EVENT"
  | "TREND"
  | "ORB"
  | "MOMENTUM"
  | "GAP"
  | "MEAN_REVERSION"
  | "RELATIVE_VALUE"
  | "GLOBAL_BETA"
  | "VOL_REGIME";
export const SIGNAL_SOURCES: readonly SignalSource[] = [
  "EVENT", "TREND", "ORB", "MOMENTUM", "GAP", "MEAN_REVERSION", "RELATIVE_VALUE", "GLOBAL_BETA", "VOL_REGIME",
] as const;
/** Sources that vote on direction (VOL_REGIME only modifies thresholds and size). */
export const DIRECTIONAL_SOURCES: readonly SignalSource[] = SIGNAL_SOURCES.filter((s) => s !== "VOL_REGIME");

export interface SignalComponent {
  source: SignalSource;
  /** Directional view in [-1, 1]. VOL_REGIME is always 0. */
  value: number;
  /** Effective weight after shrinkage toward the prior (0 when disabled or masked by regime). */
  weight: number;
  horizonMin: number;
  enabled: boolean;
  modifiers?: { thresholdDelta?: number; sizeMult?: number };
  notes?: string;
  /** True when the source has no view right now (not applicable, or not used in this regime): it is left out of the weighted mean. */
  abstain?: boolean;
}

export interface Conviction {
  index: IndexId;
  t: number;
  /** Combined score in [-1, 1]. */
  score: number;
  components: SignalComponent[];
  regime: Regime;
  threshold: number;
  passes: boolean;
  sizeMult: number;
  stance: Stance;
  /** Total weight of the sources that voted (abstainers excluded). */
  activeWeight?: number;
  /** Why the score was forced to 0, if it was. */
  note?: string;
}

export interface GateResult {
  gate: string;
  label: string;
  /** null = not applicable to this decision. */
  passed: boolean | null;
  detail: string;
}

export interface StopsSpec {
  /** Premium stop as percent change from entry (negative, e.g. -30). */
  stopPct: number;
  targetPct: number;
  trailActivatePct: number;
  /** Fraction (0-100%) of the peak gain given back before the trail exits. */
  trailGivebackPct: number;
  /** Epoch ms after which the time stop applies. */
  timeStopMs: number;
  /** Epoch ms of the hard intraday square-off. */
  squareOffMs: number;
}

export interface TradePlan {
  id: string;
  index: IndexId;
  t: number;
  side: TradeSide;
  contract: OptionContract;
  lots: number;
  qty: number;
  entryType: "MARKET" | "LIMIT";
  limitPrice?: number;
  refPremium: number;
  refSpot: number;
  horizonMin: number;
  expectedMovePct: number;
  impliedMovePct: number;
  /** Underlying move (percent) needed to cover theta and costs over the horizon. */
  breakevenMovePct: number;
  edgeRatio: number;
  stops: StopsSpec;
  riskRupees: number;
  riskPct: number;
  kellyFraction: number;
  conviction: Conviction;
  gates: GateResult[];
  /** Dominant signal source at entry (largest |weight * value|). */
  dominantSource: SignalSource;
  /** Market readings the plan was made on, for the copy-trade view (absent on older plans). */
  indicators?: IndicatorView;
  vix?: number;
  /** The index's move since today's open, percent. */
  retFromOpenPct?: number;
  /** Where the entry premium came from: a broker quote or the model. */
  quoteSource?: Quote["source"];
}

/** Result of planning for one index on one tick, including the no-trade case. */
export interface PlanDecision {
  id: string;
  index: IndexId;
  t: number;
  conviction: Conviction;
  gates: GateResult[];
  plan: TradePlan | null;
  /** Suggested contract even when no plan is produced (for the dashboard). */
  contract: OptionContract | null;
  refPremium: number | null;
  expectedMovePct: number | null;
  impliedMovePct: number | null;
  edgeRatio: number | null;
  noPlanReason: string | null;
  /** Indicator readings at decision time (for the dashboard). */
  indicators?: IndicatorView;
}

export type OrderReason =
  | "ENTRY"
  | "STOP"
  | "TARGET"
  | "TRAIL"
  | "TIME_STOP"
  | "SQUARE_OFF"
  | "SIGNAL_FLIP"
  | "EVENT_INVALIDATION"
  | "KILL_SWITCH"
  | "DAILY_LOSS_CAP"
  | "RECONCILE"
  | "MANUAL";

export interface ExitDecision {
  reason: OrderReason;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Orders, fills, positions
// ---------------------------------------------------------------------------

export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL_M";
export type ProductType = "MIS" | "NRML";
export type OrderStatus = "NEW" | "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED" | "UNKNOWN";
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["FILLED", "CANCELLED", "REJECTED"] as const;

export interface OrderRequest {
  /** Idempotency key; also Groww's order_reference_id (8-20 alphanumerics). */
  refId: string;
  contract: OptionContract;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  triggerPrice?: number;
  product: ProductType;
  reason: OrderReason;
  planId?: string;
  positionId?: string;
}

export interface Order extends OrderRequest {
  id: string;
  brokerOrderId?: string;
  brokerStatus?: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice?: number;
  createdMs: number;
  updatedMs: number;
  mode: TradingMode;
  error?: string;
}

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  ipft: number;
  gst: number;
  total: number;
}

export interface Fill {
  id: string;
  orderId: string;
  t: number;
  qty: number;
  price: number;
  charges: ChargeBreakdown;
  slippageTicks: number;
  brokerTradeId?: string;
}

export interface SourceShare {
  source: SignalSource;
  share: number;
}

export interface Position {
  id: string;
  planId: string;
  index: IndexId;
  side: TradeSide;
  contract: OptionContract;
  mode: TradingMode;
  qty: number;
  avgEntry: number;
  entryMs: number;
  entryCharges: number;
  status: "OPEN" | "CLOSED";
  markPremium: number;
  markMs: number;
  peakPremium: number;
  unrealized: number;
  stops: StopsSpec;
  horizonMin: number;
  convictionAtEntry: number;
  regimeAtEntry: Regime;
  dominantSource: SignalSource;
  /** Shares of |w*v| at entry; sums to 1. */
  attribution: SourceShare[];
  /** Cluster keys of the top event contributors at entry (for invalidation exits). */
  eventKeysAtEntry: string[];
  exitMs?: number;
  exitReason?: OrderReason;
  /** Quantity sold so far (partial exits reduce `qty` until it reaches 0). */
  exitedQty?: number;
  avgExit?: number;
  /** Gross realized P&L so far, rupees (before charges). */
  realized?: number;
  exitCharges?: number;
  /** Max adverse / favorable premium excursion in percent of entry. */
  maePct: number;
  mfePct: number;
}

export interface TradeRecord {
  positionId: string;
  index: IndexId;
  side: TradeSide;
  mode: TradingMode;
  tradingSymbol: string;
  entryMs: number;
  exitMs: number;
  holdingMin: number;
  entryPremium: number;
  exitPremium: number;
  qty: number;
  /** Net P&L after all charges, rupees. */
  pnl: number;
  /** Gross P&L before charges, rupees. */
  grossPnl: number;
  /** Net P&L as percent of entry premium paid. */
  pnlPctPremium: number;
  charges: number;
  maePct: number;
  mfePct: number;
  regime: Regime;
  exitReason: OrderReason;
  convictionAtEntry: number;
  dominantSource: SignalSource;
  attribution: SourceShare[];
}

// ---------------------------------------------------------------------------
// Performance, risk, settings
// ---------------------------------------------------------------------------

export type SourceStatus = "ACTIVE" | "PROBATION" | "DISABLED";

export interface SignalPerformance {
  source: SignalSource;
  index: IndexId | "ALL";
  mode: TradingMode;
  windowTrades: number;
  hitRate: number;
  /** Mean net P&L per trade as percent of premium. */
  expectancyPct: number;
  expectancyRupees: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  tStat: number;
  status: SourceStatus;
  enabled: boolean;
  disabledSinceMs?: number;
  disabledReason?: string;
  /** When the source was re-enabled on probation. */
  probationSinceMs?: number;
  /** Counterfactual trades taken while disabled, for re-enable decisions. */
  shadowTrades: number;
  shadowExpectancyPct: number;
  /** Effective weight used by the conviction model at the last update. */
  weight: number;
  lastTradeMs?: number;
  updatedMs: number;
}

export interface DayLedger {
  /** IST calendar date YYYY-MM-DD. */
  date: string;
  mode: TradingMode;
  realized: number;
  unrealized: number;
  charges: number;
  trades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  ordersPlaced: number;
  /** Peak-to-trough intraday drawdown in rupees (positive number). */
  maxIntradayDrawdown: number;
  peakEquity: number;
  startEquity: number;
  updatedMs: number;
}

export type EngineMode = "PAPER" | "LIVE";
export type EnginePhase = "IDLE" | "PREMARKET" | "OPEN" | "CLOSING" | "CLOSED" | "DEGRADED" | "KILLED";

export interface EngineSettings {
  mode: EngineMode;
  /** Epoch ms until which the engine is armed for LIVE trading (null = disarmed). */
  armedUntil: number | null;
  killSwitch: boolean;
  killReason: string | null;
  maxOpenPositions: number;
  maxOrdersPerDay: number;
  maxLotsPerOrder: number;
  dailyLossCapInr: number;
  maxPremiumPerTradeInr: number;
  /** Extra closed dates YYYY-MM-DD and special open dates, editable from the dashboard. */
  holidayOverrides: { date: string; open: boolean; note?: string }[];
  updatedMs: number;
  updatedBy: string;
}

export interface RiskState {
  nowMs: number;
  settings: EngineSettings;
  capitalRupees: number;
  day: DayLedger;
  /** Rolling realized P&L over the current ISO week, rupees. */
  weekRealized: number;
  openPositions: Position[];
  /** Orders placed today (entries and exits). */
  ordersToday: number;
  /** Entries taken today per index. */
  entriesToday: Record<IndexId, number>;
  /** Last stop-out time per index, for cooldowns. */
  lastStopOutMs: Partial<Record<IndexId, number>>;
  /** Free cash for new premium when sizing from current equity (small accounts). */
  cashRupees?: number;
  /**
   * Entry orders sent but not filled yet (a resting limit, a live order still at the exchange). Each
   * may still fill, so it holds a position slot and counts as a trade today.
   */
  pendingEntries?: { index: IndexId; side: TradeSide }[];
}

export interface Heartbeat {
  ts: number;
  phase: EnginePhase;
  mode: EngineMode;
  alarmNextMs: number | null;
  lastTickMs: number | null;
  openPositions: number;
  consecutiveErrors: number;
  version: string;
  relayHealthy: boolean | null;
  lastError?: string;
}

export type SourceName = "yahoo" | "gdelt" | "gnews" | "rss" | "claude" | "groww" | "relay";
export interface SourceHealth {
  ok: boolean;
  lastOkMs: number | null;
  lastErrorMs: number | null;
  detail?: string;
}

/** Forward returns of a decision, measured after the fact to grade every signal (traded or not). */
export interface SignalOutcome {
  decisionId: string;
  index: IndexId;
  t: number;
  stance: Stance;
  score: number;
  regime: Regime;
  /** Underlying returns in percent after the decision. */
  ret15m: number | null;
  ret60m: number | null;
  retClose: number | null;
  /** True when the stance direction matched the 60-minute return (null for NEUTRAL). */
  hit: boolean | null;
  evaluatedMs: number;
}

export interface QuoteRow {
  key: string;
  label: string;
  price: number;
  /** Versus the previous close; null when that close is unknown (never an invented 0). */
  change: number | null;
  changePct: number | null;
  asOf: number;
}

/** What the engine saw on one tick, persisted for the dashboard and for audits. */
export interface SnapshotRecord {
  t: number;
  quotes: QuoteRow[];
  features: Partial<Record<IndexId, MarketFeatures>>;
  regimes: Partial<Record<IndexId, Regime>>;
  pressure: Partial<Record<IndexId, number>>;
}

export interface AuditEntry {
  ts: number;
  actor: string;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}
