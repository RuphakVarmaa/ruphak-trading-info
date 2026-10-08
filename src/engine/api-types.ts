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
  change: number;
  changePct: number;
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
  getBacktest(runId: string): Promise<BacktestResult | null>;
  /** The account's trades opened on an IST date YYYY-MM-DD as copy tickets: open ones first, then newest first. */
  getCopyTickets(date: string, account?: string): Promise<CopyTicketView[]>;

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
