/**
 * Dashboard contract: JSON-safe DTOs returned by the engine Worker's EngineAdmin RPC
 * entrypoint (and by the dashboard's mock), plus the RPC interface itself.
 * Client components may import TYPES from this file; it has no runtime dependencies
 * beyond the small pure helpers at the bottom.
 */
import type {
  EngineMode,
  EnginePhase,
  EventTaxonomy,
  GateResult,
  ImpactLevel,
  IndexId,
  IndicatorView,
  OptionType,
  OrderReason,
  OrderStatus,
  Regime,
  ScheduledEventKind,
  SessionPhase,
  Side,
  SignalSource,
  SourceName,
  SourceStatus,
  Stance,
  TradingMode,
} from "./types";

export type {
  EngineMode,
  EnginePhase,
  EventTaxonomy,
  GateResult,
  ImpactLevel,
  IndexId,
  IndicatorView,
  OptionType,
  OrderReason,
  OrderStatus,
  Regime,
  ScheduledEventKind,
  SessionPhase,
  Side,
  SignalSource,
  SourceName,
  SourceStatus,
  Stance,
  TradingMode,
};

// ---------------------------------------------------------------------------
// Route-handler envelope
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "ENGINE_UNREACHABLE"
  | "UNAUTHORIZED"
  | "ADMIN_DISABLED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export type ApiOk<T> = { ok: true; data: T; generatedAt: string };
export type ApiErr = { ok: false; code: ApiErrorCode; error: string };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface IndexQuote {
  /** Stable key: NIFTY, SENSEX, INDIAVIX, BANKNIFTY, USDINR, BRENT, SPFUT. */
  key: string;
  label: string;
  price: number;
  /** Versus the previous close; null when that close is unknown (show "—", not 0.00%). */
  change: number | null;
  changePct: number | null;
  /** ISO timestamp of the observation. */
  asOf: string;
  stale: boolean;
}

export interface SourceHealthView {
  ok: boolean;
  lastOkAt: string | null;
  detail?: string;
}

export interface EngineStateDTO {
  /** Where the data came from: the real engine Worker or the dashboard's built-in mock. */
  dataSource: "engine" | "mock";
  mode: EngineMode;
  /** Worker var LIVE_TRADING: the first of the three keys needed for a live order. */
  liveTradingEnabled: boolean;
  armed: boolean;
  armedUntil: string | null;
  killSwitch: boolean;
  killReason: string | null;
  caps: {
    dailyLossCap: number;
    /** Today's realized + unrealized loss as a positive number (0 when in profit). */
    dailyLossUsed: number;
    maxPositions: number;
    openPositions: number;
    maxOrdersPerDay: number;
    ordersToday: number;
  };
  heartbeat: {
    lastTickAt: string | null;
    phase: EnginePhase;
    loopIntervalSec: number;
    consecutiveErrors: number;
    version: string | null;
    lastError: string | null;
  };
  health: Partial<Record<SourceName, SourceHealthView>>;
  market: {
    phase: SessionPhase;
    nowIst: string;
    nextOpenAt: string;
    nextCloseAt: string;
    isHoliday: boolean;
    holidayName: string | null;
  };
  quotes: IndexQuote[];
  stats: {
    clustersScoredToday: number;
    signalsToday: number;
    llmInputTokensToday: number;
    llmOutputTokensToday: number;
  };
  /** The account this state describes. Absent from older engines and the mock (main). */
  account?: AccountView;
  /** Every account the engine runs, main first. Absent from older engines and the mock. */
  accounts?: AccountView[];
}

/** A paper account: "main" is the engine's own book; others follow its signals with their own capital. */
export interface AccountView {
  id: string;
  label: string;
  shortLabel: string;
  paperOnly: boolean;
  capitalRupees: number;
}

// ---------------------------------------------------------------------------
// Signals and positions
// ---------------------------------------------------------------------------

export interface ImpactView {
  index: IndexId;
  /** -1 bearish, 0 neutral, +1 bullish. */
  direction: -1 | 0 | 1;
  /** Signed numeric impact in [-1, 1] after novelty/priced-in discounts (before decay). */
  score: number;
  /** Magnitude bucket midpoint in percent (e.g. 0.5 for MODERATE). */
  magnitudePct: number;
  /** Confidence 0-1. */
  confidence: number;
  halfLifeHours: number;
}

export interface EventContribution extends ImpactView {
  clusterId: string;
  title: string;
  taxonomy: EventTaxonomy;
  /** Share of the index's current event pressure, signed, in [-1, 1]. */
  weight: number;
  ageMin: number;
  pricedIn: boolean;
}

export interface SuggestedContract {
  index: IndexId;
  expiry: string;
  strike: number;
  optionType: OptionType;
  tradingSymbol: string;
  lotSize: number;
  lots: number;
  premium: number | null;
  premiumAtRisk: number | null;
  /** e.g. "NIFTY 13-OCT-2026 22600 CE". */
  label: string;
}

export interface PositionView {
  id: string;
  index: IndexId;
  contract: SuggestedContract;
  mode: TradingMode;
  qty: number;
  avgPrice: number;
  ltp: number | null;
  ltpAsOf: string | null;
  pnl: number;
  pnlPct: number;
  stopPrice: number;
  targetPrice: number;
  /** Trailing stop level once active, else null. */
  trailPrice: number | null;
  timeStopAt: string;
  squareOffAt: string;
  openedAt: string;
  planId: string;
  dominantSource: SignalSource;
}

export interface SignalComponentView {
  source: SignalSource;
  value: number;
  weight: number;
  enabled: boolean;
  notes?: string;
  /** No view right now (not applicable, or not used in this regime): left out of the conviction. */
  abstain?: boolean;
}

export interface SignalView {
  index: IndexId;
  stance: Stance;
  conviction: number;
  entryThreshold: number;
  regime: Regime;
  computedAt: string;
  spot: number | null;
  expectedMovePct: number | null;
  impliedMovePct: number | null;
  edgeRatio: number | null;
  /** Minimum edge ratio the theta gate requires. */
  minEdgeRatio: number;
  gates: GateResult[];
  allGatesPassed: boolean;
  contract: SuggestedContract | null;
  noPlanReason: string | null;
  components: SignalComponentView[];
  contributors: EventContribution[];
  /** Plain-language explanation built from the top contributors and gates. */
  rationale: string;
  position: PositionView | null;
  /** Indicator readings the decision was made on (null for decisions stored before indicators existed). */
  indicators: IndicatorView | null;
  /**
   * Live entry advice while the measured-edge check pauses the engine's book: what it would buy
   * right now on its own signal and trade checks. Null when the signal or another check says WAIT
   * (the gates say why), when the engine is entering itself, or when the reading is old.
   */
  advice: SignalAdviceView | null;
  /**
   * Level-based trade setups read off the 5-minute chart (strategy/setups.ts): decision support for a
   * person buying options, not the engine's own entries. Empty when none is near, outside 09:25–14:30
   * IST, or when the reading is older than 3 minutes.
   */
  setups?: TradeSetupView[];
  /** The key levels (merged into zones) the setups were read from, nearest the price. */
  levels?: KeyLevelView[];
  /** Why there are no setups right now ("No new setups after 14:30 IST"), when that is the reason. */
  setupNote?: string | null;
  /**
   * The engine's one recommendation for this index (src/engine/flow/recommend.ts), sized for ₹10,000:
   * setup + live option flow + measured statistics. Null when older than 3 minutes or from another session;
   * absent from older engines.
   */
  recommendation?: RecommendationView | null;
}

/** One key level, or several within ~0.05% of each other merged into one zone ("PDH + R1"). */
export interface KeyLevelView {
  price: number;
  label: string;
  /** The levels in the zone: PDH, PDL, PDC, ORH, ORL, HOD, LOD, VWAP, VWAP+1σ, P, R1, S1, ST, R22500... */
  kinds: string[];
  /** Summed weight of the levels in the zone (1 weak, 5+ strong). */
  strength: number;
}

export type TradeSetupKind = "ORB" | "PDH_PDL" | "VWAP_PULLBACK" | "RANGE_REVERSAL";
export type TradeSetupStatus = "WATCHING" | "READY" | "TRIGGERED" | "MISSED" | "INVALID";

export interface SetupEvidenceView {
  /** "ADX 26.4 (≥ 20: a trend is in place)". */
  text: string;
  supports: boolean;
}

/** The option to buy for a setup, with the index levels mapped to premiums (delta, gamma, theta). */
export interface SetupOptionView {
  contract: { index: IndexId; expiry: string; strike: number; optionType: OptionType; tradingSymbol: string; lotSize: number; label: string };
  /** The ask now (quote), or the model price when no quote came back. */
  premiumNow: number;
  priceSource: "broker" | "model";
  iv: number | null;
  delta: number;
  gamma: number;
  /** Premium lost per minute to time decay (positive). */
  decayPerMin: number;
  /** Premiums on the contract's tick: entry at the trigger, stop and targets after the planned holding time. */
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  stopPct: number;
  /** True when the index stop maps below the engine's −30% premium stop, so the stop is that instead. */
  stopCapped: boolean;
  riskPerLot: number;
  rewardT1PerLot: number;
  rewardT2PerLot: number;
  holdMin: number;
}

export interface TradeSetupView {
  /** Stable for the session: "2026-10-14:NIFTY:ORB:BULL". */
  id: string;
  index: IndexId;
  kind: TradeSetupKind;
  name: string;
  side: "BULL" | "BEAR";
  status: TradeSetupStatus;
  /** When the current status began, and when the setup was first seen (ISO, IST). */
  statusSince: string;
  firstSeen: string;
  score: number;
  spot: number;
  /** The index level that confirms the entry and the candle condition, in words. */
  trigger: number;
  condition: string;
  /** Entry stays valid until the index is past this level (trigger ± 0.5 ATR); beyond it the setup is MISSED. */
  chaseLimit: number;
  /** Points from the price to the trigger in the trade's direction (negative once past it). */
  distance: number;
  /** The zone the setup is built on ("PDH + R1"). */
  level: { price: number; label: string };
  stop: number;
  t1: number;
  t2: number;
  t1Label: string;
  t2Label: string;
  rr1: number;
  rr2: number;
  invalidation: string;
  evidence: SetupEvidenceView[];
  /** Today's-plan style warnings that would make the Desk wait (event blackout, VIX jump). */
  cautions: string[];
  atr: number;
  option: SetupOptionView | null;
}

/** The contract the engine would buy now, its reading's ask, and the levels it would manage it by. */
export interface SignalAdviceView {
  kind: "ENTER";
  /** When the engine's reading was made (ISO, IST). Refreshed at least every minute while it says ENTER. */
  at: string;
  side: "BULL" | "BEAR";
  contract: {
    index: IndexId;
    expiry: string;
    strike: number;
    optionType: OptionType;
    tradingSymbol: string;
    lotSize: number;
    /** e.g. "NIFTY 13-OCT-2026 22600 CE". */
    label: string;
  };
  /** The ask the reading saw. */
  premium: number;
  priceSource: "broker" | "model";
  /** The index at the reading, and the level past which half of the expected move has happened (null when unknown). */
  spot: number;
  skipBeyondSpot: number | null;
  /** The levels for a fill at `premium`, on the contract's tick, as the engine would manage it. */
  levels: {
    stopPct: number;
    stop: number;
    targetPct: number;
    target: number;
    trailActivatePct: number;
    trailActivateAt: number;
    trailGivebackPct: number;
    timeStopAt: string;
    timeStopMinPnlPct: number;
    squareOffAt: string;
  };
  /** The checks pausing the engine's own entry, in its words ("Edge with measured move and realized vol ≥ 10% of premium"). */
  pausedBy: string[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventTab = "ALL" | "MACRO" | "GEOPOLITICS" | "COMMODITY" | "FLOWS" | "CORPORATE" | "SCHEDULED";
export const EVENT_TABS: readonly EventTab[] = ["ALL", "MACRO", "GEOPOLITICS", "COMMODITY", "FLOWS", "CORPORATE", "SCHEDULED"] as const;

export type Severity = "FLASH" | "ALERT" | "UPDATE";

export interface EventClusterView {
  clusterId: string;
  title: string;
  /** LLM rationale (one line). */
  summary: string;
  taxonomy: EventTaxonomy;
  tab: EventTab;
  severity: Severity;
  scorer: "llm" | "fallback" | "pending";
  firstSeenAt: string;
  lastSeenAt: string;
  articleCount: number;
  sources: string[];
  impacts: ImpactView[];
  sectors: { sector: string; direction: -1 | 0 | 1; weight: "LOW" | "MEDIUM" | "HIGH" }[];
  pricedIn: boolean;
  /** Fraction of the original impact still active after time decay (0-1). */
  decayRemaining: number;
  topUrl: string | null;
  isScheduledData: boolean;
}

export interface EventClusterDetail extends EventClusterView {
  rationale: string;
  novelty: "NEW" | "DEVELOPMENT" | "REPEAT";
  surprise: "POSITIVE" | "NEGATIVE" | "INLINE" | "NA";
  horizon: "INTRADAY" | "DAYS_1_2" | "WEEK" | "MONTH_PLUS";
  model: string | null;
  scoredAt: string | null;
  headlines: { title: string; url: string | null }[];
}

// ---------------------------------------------------------------------------
// Orders, P&L, performance, calendar
// ---------------------------------------------------------------------------

export interface OrderView {
  id: string;
  placedAt: string;
  mode: TradingMode;
  contractLabel: string;
  tradingSymbol: string;
  side: Side;
  qty: number;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL_M";
  limitPrice: number | null;
  status: OrderStatus;
  reason: OrderReason;
  filledQty: number;
  avgFillPrice: number | null;
  planId: string | null;
  error: string | null;
}

export interface FillView {
  id: string;
  orderId: string;
  at: string;
  price: number;
  qty: number;
  charges: number;
}

export interface DailyPnlView {
  date: string;
  realized: number;
  unrealized: number;
  charges: number;
  net: number;
  trades: number;
  equityEnd: number;
}

export interface ChargesView {
  brokerage: number;
  stt: number;
  exchange: number;
  gst: number;
  sebi: number;
  stamp: number;
  total: number;
}

export interface PnlResponse {
  mode: TradingMode;
  startingEquity: number;
  today: DailyPnlView;
  history: DailyPnlView[];
  equityCurve: { t: string; equity: number }[];
  /** Charges over the requested window. */
  charges: ChargesView;
}

export interface SignalPerformanceRow {
  source: SignalSource;
  label: string;
  index: IndexId | "ALL";
  trades: number;
  wins: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  tStat: number;
  status: SourceStatus;
  weight: number;
  disabledReason: string | null;
  lastTradeAt: string | null;
}

export interface ScheduledEventView {
  id: string;
  title: string;
  kind: ScheduledEventKind;
  at: string;
  impact: ImpactLevel;
  approx: boolean;
  /** Entry blackout window around the event (null for events outside market hours). */
  blackoutStart: string | null;
  blackoutEnd: string | null;
  indices: IndexId[];
}

// ---------------------------------------------------------------------------
// Today's plan: the plan's no-trade rules for the session (read-only)
// ---------------------------------------------------------------------------

/** One of the plan's no-trade rules (docs/research/options-trading-plan.md §4), checked for one index. */
export interface PlanCheckView {
  /** N1 scheduled event, N2 volatility jump or big run, N4 short-dated contract, N7 expiry day, N9 the opening gap. */
  rule: "N1" | "N2" | "N4" | "N7" | "N9";
  label: string;
  /** block: no new entry today on this rule; caution: a narrower limit applies; clear; unknown: an input is missing. */
  status: "block" | "caution" | "clear" | "unknown";
  detail: string;
}

export interface IndexPlanView {
  index: IndexId;
  /** From the market checks only; the paused buying is reported once, for every index. */
  verdict: "no_trade" | "caution" | "clear";
  headline: string;
  checks: PlanCheckView[];
  /** The global-markets estimate of the opening gap, percent (null without a snapshot). */
  expectedGapPct: number | null;
  /** The actual opening gap once the index has opened today, percent. */
  gapPct: number | null;
  /** The nearest contract a buyer may use (never one expiring on the session) and its sessions left after the session. */
  expiry: string | null;
  sessionsLeft: number | null;
}

/** A part of the session and what the evidence says about buying in it. */
export interface PlanWindowView {
  /** IST "HH:mm". */
  from: string;
  to: string;
  /** trade: the only window the evidence supports for a buyer; avoid: no new buys; close: everything is squared off. */
  kind: "trade" | "avoid" | "close";
  label: string;
  why: string;
}

export interface TodayPlanView {
  /** The IST session the plan is for: today while it is a trading day and before the close, otherwise the next trading day. */
  date: string;
  when: "today" | "next";
  /** True while the measured-edge gate (EDGE_GATE=calibrated) is on: it has blocked every entry on the current signals. */
  buyingPaused: boolean;
  pausedReason: string | null;
  windows: PlanWindowView[];
  indices: IndexPlanView[];
  /** When the market inputs were taken (the engine's latest snapshot), or null without one. */
  asOf: string | null;
  source: string;
}

// ---------------------------------------------------------------------------
// Copy trading
// ---------------------------------------------------------------------------

/** One paper trade laid out for a person to repeat by hand in their own broker account. */
export interface CopyTicketView {
  /** Position id. */
  id: string;
  planId: string;
  account: { id: string; label: string; shortLabel: string; capitalRupees: number };
  mode: TradingMode;
  status: "OPEN" | "CLOSED";
  index: IndexId;
  side: "BULL" | "BEAR";
  /** e.g. "BUY NIFTY 25000 PE (13 Oct)". */
  headline: string;
  contract: SuggestedContract & { growwSymbol: string };
  /** What to type into a broker app's search box, e.g. "NIFTY 25000 PE". */
  searchText: string;
  /** e.g. "Tue 13 Oct". */
  expiryLabel: string;
  qty: number;
  lots: number;
  entry: {
    at: string;
    /** The paper fill. */
    premium: number;
    /** Limit price of the engine's entry order (marketable: a couple of ticks over the ask); null for a market order or when unknown. */
    limitPrice: number | null;
    costRupees: number;
    charges: number;
    /** "model": Black-Scholes on India VIX (a broker's real price will differ); "broker": a Groww quote. */
    priceSource: "model" | "broker";
    /** Index level when the trade was planned. */
    spot: number;
    /**
     * Index level past which the copy is probably too late: half the expected move already happened
     * in the trade's direction (below it for puts, above it for calls). Null without an expected move.
     */
    skipBeyondSpot: number | null;
  };
  levels: {
    stopPct: number;
    stop: number;
    targetPct: number;
    target: number;
    trailActivatePct: number;
    trailActivateAt: number;
    /** Share of the peak gain the trail gives back before it sells, percent. */
    trailGivebackPct: number;
    /** Current trailing-stop level once the trail is on, else null. */
    trail: number | null;
    timeStopAt: string;
    /** The time stop sells at timeStopAt unless the trade is up at least this much, percent. */
    timeStopMinPnlPct: number;
    squareOffAt: string;
  };
  /** Loss if the stop is hit (price move plus charges), rupees and percent of the account's capital. */
  riskAtStop: { rupees: number; pctOfCapital: number };
  /**
   * Open trades: the engine's latest mark. `pnl` is after entry charges; `movePct` is the premium's change
   * since entry (the stop, target and trail are set on it); mfe/mae are its best and worst so far.
   */
  live: { mark: number; markAt: string | null; pnl: number; movePct: number; peak: number; mfePct: number; maePct: number } | null;
  /** Closed trades. `pnl` is after all charges; `movePct` is the exit premium versus the entry. */
  exit: { at: string; premium: number; reason: OrderReason; reasonText: string; pnl: number; movePct: number; holdMin: number } | null;
  /** Why the engine took the trade (null when the plan record is missing). */
  setup: {
    stance: Stance;
    conviction: number;
    threshold: number;
    regime: Regime;
    dominantSource: SignalSource;
    expectedMovePct: number;
    impliedMovePct: number;
    breakevenMovePct: number;
    edgeRatio: number;
    horizonMin: number;
    /** Voting signals first, strongest contribution first. */
    components: SignalComponentView[];
    gates: GateResult[];
    /** Plain-language reasons, strongest first. */
    reasons: string[];
  } | null;
  /** The index when the trade was planned. */
  market: {
    spot: number;
    /** Percent versus the previous close (null without one). */
    changePct: number | null;
    vix: number | null;
    indicators: IndicatorView | null;
  };
  /** Numbered steps for copying this trade by hand. */
  steps: string[];
}

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

export interface BacktestParams {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  index: IndexId | "BOTH";
  /** Overrides for the regime thresholds (all regimes shifted by this delta). */
  thresholdDelta: number;
  stopPct: number;
  targetPct: number;
  /** When true, the event layer is disabled (no-events baseline). */
  noEvents: boolean;
  /**
   * Follower account to backtest (e.g. "small10k"): main replays alongside it, the stop and target
   * apply to the follower, and the result is the follower's. Omitted means main.
   */
  account?: string;
}

export interface BacktestTrade {
  entryAt: string;
  exitAt: string;
  index: IndexId;
  contractLabel: string;
  side: "BULL" | "BEAR";
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  exitReason: OrderReason;
  dominantSource: SignalSource;
  conviction: number;
  priceSource: "real" | "synthetic";
}

export interface BacktestSummary {
  trades: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  netPnl: number;
  grossPnl: number;
  charges: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  avgHoldingMin: number;
  tradesPerDay: number;
  realPriceShare: number;
}

export interface BacktestResult {
  runId: string;
  status: "RUNNING" | "DONE" | "ERROR";
  params: BacktestParams;
  startedAt: string;
  finishedAt: string | null;
  progress: number;
  error: string | null;
  summary: BacktestSummary | null;
  equityCurve: { t: string; equity: number }[];
  trades: BacktestTrade[];
  attribution: SignalPerformanceRow[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// RPC interface (engine Worker EngineAdmin entrypoint / dashboard mock)
// ---------------------------------------------------------------------------

export interface EventsQuery {
  tab?: EventTab;
  limit?: number;
  /** Epoch ms; only clusters seen after this. */
  sinceMs?: number;
}

export interface KillSwitchRequest {
  engaged: boolean;
  /** Market-exit open positions when engaging. */
  squareOff: boolean;
  reason: string;
}

/**
 * `account` (optional, last argument) selects a paper account other than main, e.g. "small10k";
 * omitted means main. Events, scheduled events and backtests are not per account.
 */
// ---------------------------------------------------------------------------
// Live option chain (Upstox read-only Analytics Token; GET /v2/option/chain)
// ---------------------------------------------------------------------------

/** One side (CE or PE) of one strike, as the broker shows it. Null fields: not reported. */
export interface OptionSideView {
  /** e.g. "NSE_FO|47139". */
  instrumentKey: string;
  ltp: number | null;
  /** Previous session's close; change = ltp - close. */
  close: number | null;
  change: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  oi: number | null;
  prevOi: number | null;
  oiChange: number | null;
  /** Implied volatility, percent. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** Upstox's probability of profit, percent. */
  pop: number | null;
}

export interface OptionChainRowView {
  strike: number;
  ce: OptionSideView | null;
  pe: OptionSideView | null;
}

export interface OptionChainView {
  index: IndexId;
  /** YYYY-MM-DD. */
  expiry: string;
  /** Every listed expiry, nearest first (for the selector). */
  expiries: string[];
  lotSize: number;
  /** Underlying index level at fetch time. */
  spot: number;
  /** Strike nearest the spot. */
  atmStrike: number;
  /** Put-call ratio on open interest (sum PE OI / sum CE OI); null without OI. */
  pcr: number | null;
  /** Strike where option buyers' total payoff at expiry is smallest; null without OI. */
  maxPain: number | null;
  rows: OptionChainRowView[];
  /** When the engine fetched it (ISO, IST). */
  fetchedAt: string;
  source: "upstox" | "mock";
  /** Set when the chain could not be fetched (rows are then empty). */
  error: string | null;
  /** "websocket" when Upstox market-feed ticks are laid over the REST chain; "rest" (or absent) otherwise. */
  feed?: "websocket" | "rest";
}

/** Live index levels from the broker feed (Upstox LTP), for the dashboard's ticker. */
export interface LiveIndexLevelsView {
  fetchedAt: string;
  source: "upstox" | "mock";
  levels: { key: "NIFTY" | "SENSEX" | "INDIAVIX" | "BANKNIFTY"; price: number; open: number | null; high: number | null; low: number | null; prevClose: number | null; change: number | null; changePct: number | null }[];
  error: string | null;
  /** "websocket" when built from Upstox's market feed (1-second ticks), "rest" from the quotes endpoint; absent from older engines. */
  feed?: "websocket" | "rest";
}

// ---------------------------------------------------------------------------
// Live option flow (src/engine/flow/flowMonitor.ts): OI added and removed, build-ups, volume spikes
// ---------------------------------------------------------------------------

/** Price and open interest moving together: up/up long build-up, down/up short build-up, up/down short covering, down/down long unwinding. */
export type FlowBuildup = "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";
export type FlowWindowKey = "1m" | "5m" | "15m";

/** One side of one strike over a window: the latest quote and the change since the window's start. */
export interface FlowSideView {
  /** Latest values (null: not reported). */
  oi: number | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  /** Implied volatility, percent. */
  iv: number | null;
  delta: number | null;
  /** Change over the window; null when either end is missing. */
  oiChg: number | null;
  oiChgPct: number | null;
  /** Quantity traded in the window (the day's cumulative volume now minus then). */
  vol: number | null;
  /** The window's volume per minute over the normal volume per minute (research baseline, else the session's median); null without one. */
  volMultiple: number | null;
  ltpChgPct: number | null;
  /** Change in implied volatility, vol points. */
  ivChg: number | null;
  buildup: FlowBuildup;
}

export interface FlowStrikeRow {
  strike: number;
  ce: FlowSideView | null;
  pe: FlowSideView | null;
}

export interface FlowWindowView {
  minutes: number;
  /** The snapshot the changes are measured from (ISO, IST); null when the session has no snapshot that old yet. */
  from: string | null;
  rows: FlowStrikeRow[];
}

export type FlowEventKind = "OI_BUILDUP" | "VOLUME_SPIKE" | "DRY_UP" | "PCR_SHIFT" | "WALL_SHIFT";

export interface FlowEventView {
  /** ISO, IST. */
  at: string;
  kind: FlowEventKind;
  strike: number | null;
  side: "CE" | "PE" | null;
  buildup: FlowBuildup | null;
  oiChg: number | null;
  ltpChgPct: number | null;
  volMultiple: number | null;
  /** "10:42 · NIFTY 22500 PE · +18.4L OI in 5 min, price −6.0% → SHORT BUILD-UP (put writers adding)". */
  text: string;
}

export interface FlowSummaryView {
  /** OI added at ATM±3 strikes over 15 minutes (or since the previous close on the REST fallback), calls against puts. */
  callWritersVsPutWriters: {
    window: "15m" | "day";
    ceOiAdded: number | null;
    peOiAdded: number | null;
    lean: "CALL_WRITERS" | "PUT_WRITERS" | "BALANCED" | "UNKNOWN";
    text: string;
  };
  /** Put-call ratio on open interest over the monitored strikes. */
  pcr: number | null;
  /** PCR now minus PCR 15 minutes ago, on the strikes present at both times. */
  pcrChg15m: number | null;
  /** The strike with the most call OI (resistance) and with the most put OI (support). */
  resistance: { strike: number; oi: number } | null;
  support: { strike: number; oi: number } | null;
  /** Where OI was added fastest over 15 minutes. */
  fastestOiAdd: { ce: { strike: number; oiChg: number } | null; pe: { strike: number; oiChg: number } | null };
  /** Volume and |ΔOI| at ATM±2 both under half of normal for 15 minutes: premium drying up. */
  premiumDryUp: boolean;
  dryUpDetail: string;
  /** Premium the ATM straddle lost per hour beyond what delta × the index move explains, percent (positive = decaying); null without history. */
  decayPctPerHourAtm: number | null;
  /** Where "normal volume" came from: the research's measured medians, the session's own running medians, or none yet. */
  volumeBaseline: "research" | "session" | "none";
}

export interface EntryTimeStatsView {
  window: string;
  avgPremiumDecayPctPerHour: number;
  avgAbsIndexMovePct: number;
  costPerPointMove: number;
  sample: number;
}

/** The measured entry-time statistics for now (FLOW_STATS.entryTimes) and whether now is a good or expensive time to buy. */
export interface FlowEntryWindowView {
  verdict: "good" | "average" | "expensive" | "closed" | "unknown";
  text: string;
  now: EntryTimeStatsView | null;
  best: EntryTimeStatsView | null;
}

export interface OptionFlowView {
  index: IndexId;
  /** "feed": 1-minute samples of the Upstox market feed; "rest": one REST chain (no minute history); "mock": the dashboard's synthetic engine. */
  source: "feed" | "rest" | "mock";
  /** The latest snapshot (ISO, IST); null without one. */
  asOf: string | null;
  expiry: string | null;
  lotSize: number | null;
  spot: number | null;
  atm: number | null;
  step: number | null;
  /** 1-minute snapshots held for the session. */
  minutes: number;
  /** Plain words when the view is partial or stale. */
  note: string | null;
  windows: Record<FlowWindowKey, FlowWindowView>;
  /** REST fallback only: the change since the previous session's close. */
  day?: FlowWindowView;
  /** Newest first, at most 100. */
  events: FlowEventView[];
  summary: FlowSummaryView;
  bestEntryWindow: FlowEntryWindowView;
  /** The research's plain sentences, printed verbatim. */
  honestSummary: string[];
  statsGeneratedAt: string | null;
}

// ---------------------------------------------------------------------------
// The recommendation (src/engine/flow/recommend.ts): at most one per index, sized to a capital
// ---------------------------------------------------------------------------

export type RecommendationStatus = "ENTER" | "WAIT" | "NO_TRADE";
/** A: a rule with a positive measured edge matches; B: the setup and the option flow agree but no edge is proven; C: watch only. */
export type RecommendationGrade = "A" | "B" | "C";

export interface RecommendationView {
  index: IndexId;
  status: RecommendationStatus;
  grade: RecommendationGrade;
  /** One line a person can act on. */
  headline: string;
  /** When it was computed (ISO, IST). */
  at: string;
  /** The capital it is sized for, rupees. */
  capital: number;
  side: "BULL" | "BEAR" | null;
  setup: { id: string; name: string; kind: TradeSetupKind; status: TradeSetupStatus } | null;
  contract: {
    index: IndexId;
    expiry: string;
    strike: number;
    optionType: OptionType;
    tradingSymbol: string;
    lotSize: number;
    /** e.g. "NIFTY 21-OCT-2026 25200 CE". */
    label: string;
    delta: number | null;
    iv: number | null;
    /** feed: the 1-second market feed; broker: a REST quote; model: Black-Scholes (no live quote); mock: the dashboard's synthetic engine. */
    priceSource: "feed" | "broker" | "model" | "mock";
  } | null;
  entry: {
    /** Limit price, on the contract's tick: at most the live ask + 2% when entering now; the expected premium at the trigger (+2%) when waiting. */
    limit: number;
    ask: number | null;
    bid: number | null;
    /** ISO, IST. */
    validUntil: string;
    /** The index condition, in words. */
    trigger: string;
    triggerLevel: number | null;
    /** Do not buy once the index is past this level (the setup's chase limit). */
    chaseLimit: number | null;
  } | null;
  stop: { premium: number; pct: number; index: number | null } | null;
  target: { t1: number; t2: number; t1Pct: number; t2Pct: number; indexT1: number | null; indexT2: number | null } | null;
  /** IST "HH:MM": be out by then whatever happens. */
  timeExit: string | null;
  qty: { lots: number; units: number; premiumRupees: number; chargesRupees: number; totalRupees: number } | null;
  risk: { riskRupees: number; rewardT1Rupees: number; rewardT2Rupees: number; rr1: number; rr2: number; pctOfCapital: number } | null;
  /** Setup and flow evidence, in plain words with numbers. */
  reasons: string[];
  cautions: string[];
  /** The measured statistics of the matching research rule (FLOW_STATS), or verdict "none". */
  historical: {
    ruleIds: string[];
    title: string | null;
    sample: number;
    inSample: number;
    hitRate: number | null;
    avgPnlPerLot: number | null;
    medianPnlPerLot: number | null;
    ci95: [number, number] | null;
    verdict: "positive" | "not_proven" | "negative" | "none";
    dataRange: string | null;
    text: string;
  };
  /** Why this is not a measured edge, when the grade is not A. */
  honest: string | null;
  /** The same trade sized for other capitals (₹5,000, ₹10,000, ₹5,00,000). */
  sizing: { capital: number; fits: boolean; lots: number; strike: number | null; optionType: OptionType | null; totalRupees: number | null; text: string }[];
  /** When the option-flow reading it used was taken (ISO, IST), or null without one. */
  flowAsOf: string | null;
}

// ---------------------------------------------------------------------------
// Advisor: one plain-English market brief written by Claude from every live input the engine has
// (option chains across expiries, OI build-up and short covering, premium levels, setups, signals,
// news and scheduled events) plus web research (FII/DII flows, global cues). Trade ideas are picked
// from a list of real listed contracts with live prices; the engine re-validates and re-prices them.
// ---------------------------------------------------------------------------

export type AdvisorLean = "UP" | "DOWN" | "SIDEWAYS";
export type AdvisorConfidence = "LOW" | "MEDIUM" | "HIGH";
export type AdvisorHorizon = "TODAY" | "WEEK" | "MONTH";

export interface AdvisorOutlook {
  index: IndexId;
  horizon: AdvisorHorizon;
  lean: AdvisorLean;
  confidence: AdvisorConfidence;
  /** Expected range for the horizon (index points), e.g. from the option-implied move; null when unknown. */
  rangeLow: number | null;
  rangeHigh: number | null;
  /** Plain-English reasons, most important first. */
  why: string[];
}

export type AdvisorFactorKey =
  | "FII_DII"
  | "NEWS_UNCERTAINTY"
  | "GLOBAL_CUES"
  | "VOLATILITY_PREMIUM"
  | "OPTIONS_POSITIONING"
  | "SHORT_COVERING"
  | "TREND"
  | "EVENTS"
  | "OTHER";

export interface AdvisorFactor {
  key: AdvisorFactorKey;
  /** Short plain label, e.g. "Foreign and domestic funds". */
  label: string;
  reading: "SUPPORTS_UP" | "SUPPORTS_DOWN" | "NEUTRAL" | "RISK" | "NO_DATA";
  /** One or two plain sentences with the numbers behind the reading. */
  detail: string;
  /** Where it came from: "Upstox option chain", "news: Business Standard", "web research", … */
  source: string;
}

export interface AdvisorIdea {
  id: string;
  horizon: AdvisorHorizon;
  contract: { index: IndexId; expiry: string; strike: number; optionType: OptionType; tradingSymbol: string; lotSize: number; label: string };
  /** Buy zone for the premium; `ask` is the live ask the engine checked when the brief was written. */
  entry: { low: number; high: number; ask: number; asOf: string };
  stop: number;
  target: number;
  /** IST date-time by which to exit if neither stop nor target is hit. */
  exitBy: string;
  lots: number;
  costPerLot: number;
  maxLossPerLot: number;
  rewardPerLot: number;
  /** Index level at expiry where the option is worth what you paid (strike ± premium). */
  breakevenAtExpiry: number | null;
  delta: number | null;
  iv: number | null;
  /** Rough chance the option ends in the money at expiry (≈ |delta|), 0..1. */
  probItm: number | null;
  why: string[];
  /** What would prove the idea wrong (exit early). */
  wrongIf: string;
  confidence: AdvisorConfidence;
}

export interface AdvisorReport {
  id: string;
  /** IST ISO time the brief was written. */
  createdAt: string;
  model: string;
  durationMs: number;
  /** Rough API cost of this brief in USD (research + advice), from token usage. */
  costUsd: number | null;
  market: { nifty: number | null; sensex: number | null; vix: number | null; phase: string };
  /** One plain sentence: the answer first. */
  headline: string;
  /** Today's call: BUY one idea, WAIT, or AVOID trading today; `ideaId` points into `ideas`. */
  today: { action: "BUY" | "WAIT" | "AVOID"; summary: string; ideaId: string | null };
  outlook: AdvisorOutlook[];
  factors: AdvisorFactor[];
  ideas: AdvisorIdea[];
  /** Expiry-day lottery tickets (far out-of-the-money options bought for a few rupees), with honest odds. */
  zeroHero: { applicable: boolean; expiry: string | null; summary: string };
  /** Are option premiums cheap or rich right now, and is an event about to deflate them. */
  premium: { verdict: "CHEAP" | "NORMAL" | "EXPENSIVE" | "NO_DATA"; detail: string };
  /** Factors the owner did not ask about but should know (plain English). */
  alsoKnow: string[];
  /** What not to do today. */
  avoid: string[];
  sources: { title: string; url: string }[];
  /** The standing caution: no measured edge, size small, always use the stop. */
  honesty: string;
}

export interface AdvisorReportSummary {
  id: string;
  createdAt: string;
  headline: string;
  todayAction: "BUY" | "WAIT" | "AVOID";
  ideas: { id: string; label: string; horizon: AdvisorHorizon; entryAsk: number; stop: number; target: number }[];
}

export interface AdvisorView {
  status: "idle" | "queued" | "running" | "error";
  /** Why the last run failed (plain), when status is "error" or the last attempt failed. */
  lastError: string | null;
  runningSince: string | null;
  /** Earliest time a new analysis may start (rate limit); null when one may start now. */
  nextAllowedAt: string | null;
  runsToday: number;
  maxRunsPerDay: number;
  latest: AdvisorReport | null;
  history: AdvisorReportSummary[];
}

export interface EngineApi {
  getState(account?: string): Promise<EngineStateDTO>;
  getSignals(account?: string): Promise<SignalView[]>;
  getPositions(account?: string): Promise<PositionView[]>;
  getEvents(q: EventsQuery): Promise<EventClusterView[]>;
  getEventDetail(clusterId: string): Promise<EventClusterDetail | null>;
  /** Orders and fills for an IST date YYYY-MM-DD. */
  getOrders(date: string, account?: string): Promise<{ orders: OrderView[]; fills: FillView[] }>;
  getPnl(days: number, account?: string): Promise<PnlResponse>;
  getPerformance(account?: string): Promise<SignalPerformanceRow[]>;
  getScheduled(hours: number): Promise<ScheduledEventView[]>;
  /** The plan's no-trade rules evaluated for today's session (or the next one), with the session's entry windows. */
  getTodayPlan(): Promise<TodayPlanView>;
  /** The live option chain for an index; `expiry` defaults to the nearest one that is not expiring today after 15:30. */
  getOptionChain(index: IndexId, expiry?: string): Promise<OptionChainView>;
  /** Live index levels from the broker feed (null-free; `error` set when unavailable). */
  getLiveIndices(): Promise<LiveIndexLevelsView>;
  /** The live option flow for an index (OI added/removed per strike, build-ups, volume spikes, premium decay). */
  getOptionFlow(index: IndexId): Promise<OptionFlowView>;
  getBacktest(runId: string): Promise<BacktestResult | null>;
  /** The account's trades opened on an IST date YYYY-MM-DD as copy tickets: open ones first, then newest first. */
  getCopyTickets(date: string, account?: string): Promise<CopyTicketView[]>;
  /** The latest advisor brief, the run status and recent history. */
  getAdvisor(): Promise<AdvisorView>;
  /** Starts a new advisor analysis unless one is running or the rate limit says wait; returns the view at once (poll getAdvisor). */
  runAdvisor(reason: string): Promise<AdvisorView>;

  /** Admin methods re-check the token inside the engine (defense in depth). */
  verifyAdmin(token: string): Promise<boolean>;
  setArmed(token: string, armed: boolean, actor: string): Promise<EngineStateDTO>;
  /** `account`: main (default), a follower account id, or "all". */
  setKillSwitch(token: string, req: KillSwitchRequest, actor: string, account?: string): Promise<EngineStateDTO>;
  setMode(token: string, mode: EngineMode, actor: string): Promise<EngineStateDTO>;
  startBacktest(token: string, params: BacktestParams, actor: string): Promise<{ runId: string; status: "RUNNING" | "DONE" }>;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by the engine read model and the dashboard
// ---------------------------------------------------------------------------

export function taxonomyTab(taxonomy: EventTaxonomy, isScheduledData: boolean): EventTab {
  if (isScheduledData) return "SCHEDULED";
  switch (taxonomy) {
    case "MACRO_POLICY":
    case "US_MARKET_FED":
      return "MACRO";
    case "GEOPOLITICAL":
    case "CHINA":
    case "DOMESTIC_POLITICS_REGULATION":
      return "GEOPOLITICS";
    case "COMMODITY_SHOCK":
    case "WEATHER_DISASTER":
      return "COMMODITY";
    case "FII_FLOWS":
      return "FLOWS";
    case "CORPORATE_EARNINGS":
      return "CORPORATE";
    default:
      return "GEOPOLITICS";
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "2026-10-13" -> "13-OCT-2026". */
export function formatExpiry(expiry: string): string {
  const [y, m, d] = expiry.split("-");
  return `${d}-${MONTHS[Number(m) - 1] ?? m}-${y}`;
}

/** "NIFTY 13-OCT-2026 22600 CE". */
export function contractLabel(c: { index: IndexId; expiry: string; strike: number; optionType: OptionType }): string {
  return `${c.index} ${formatExpiry(c.expiry)} ${c.strike} ${c.optionType}`;
}

export const SIGNAL_SOURCE_LABELS: Record<SignalSource, string> = {
  EVENT: "Event pressure",
  TREND: "Trend (EMA 9/21, Supertrend, ADX)",
  ORB: "Opening-range breakout",
  MEAN_REVERSION: "VWAP mean reversion",
  MOMENTUM: "Intraday momentum",
  GAP: "Opening gap",
  RELATIVE_VALUE: "Relative value",
  GLOBAL_BETA: "Global beta residual",
  VOL_REGIME: "Volatility regime",
};
