/**
 * Internal types of the advisor (src/engine/advisor/*): the inputs it reads, the contracts it lets the
 * model pick from, and the usage it pays for. The dashboard contract (AdvisorView, AdvisorReport, …) lives in
 * src/engine/api-types.ts; nothing here crosses the RPC boundary.
 */
import type {
  AdvisorReport,
  EventClusterView,
  EventsQuery,
  IndexId,
  LiveIndexLevelsView,
  OptionChainView,
  OptionFlowView,
  OptionType,
  PnlResponse,
  PositionView,
  ScheduledEventView,
  SignalView,
  TodayPlanView,
} from "../api-types";

/** The engine reads the advisor uses: the same ones EngineAdmin serves (EngineApi is a superset). */
export interface AdvisorSources {
  getLiveIndices(): Promise<LiveIndexLevelsView>;
  getSignals(): Promise<SignalView[]>;
  getOptionFlow(index: IndexId): Promise<OptionFlowView>;
  getOptionChain(index: IndexId, expiry?: string): Promise<OptionChainView>;
  getEvents(q: EventsQuery): Promise<EventClusterView[]>;
  getScheduled(hours: number): Promise<ScheduledEventView[]>;
  getTodayPlan(): Promise<TodayPlanView>;
  getPnl(days: number): Promise<PnlResponse>;
  getPositions(): Promise<PositionView[]>;
}

/** What the advisor needs from the trading calendar (TradingCalendar provides it). */
export interface AdvisorCalendar {
  isTradingDay(date: string): boolean;
  followingExpiry(index: IndexId, expiry: string): string;
  sessionPhase(ms: number): string;
}

export interface AdvisorIndexInput {
  signal: SignalView | null;
  flow: OptionFlowView | null;
  /** Chains read for this index, one per expiry (the default chain included). */
  chains: OptionChainView[];
  /** Every listed expiry (from the default chain); empty when the chain could not be read. */
  listed: string[];
}

/** Everything the context builder reads, already fetched. Null: that read failed (shown as "no data"). */
export interface AdvisorInputs {
  nowMs: number;
  indices: LiveIndexLevelsView | null;
  perIndex: Partial<Record<IndexId, AdvisorIndexInput>>;
  events: EventClusterView[] | null;
  scheduled: ScheduledEventView[] | null;
  plan: TodayPlanView | null;
  pnl: PnlResponse | null;
  positions: PositionView[] | null;
  /** Reads that failed, in plain words ("option chain NIFTY 2026-10-27: timed out"). */
  errors: string[];
}

export type CandidateExpiryKind = "nearest" | "nextWeekly" | "monthly";

/** One listed contract the model may pick, with the live prices the engine validates ideas against. */
export interface AdvisorCandidate {
  /** "NIFTY-2026-10-20-23200-CE". */
  id: string;
  index: IndexId;
  expiry: string;
  expiryKind: CandidateExpiryKind;
  monthly: boolean;
  strike: number;
  optionType: OptionType;
  /** Strikes from the ATM strike, signed (−3 … +3). */
  atmOffset: number;
  tradingSymbol: string;
  /** "NIFTY 20-OCT-2026 23200 CE". */
  label: string;
  lotSize: number;
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  /** The ask, or the last traded price when no ask is quoted (market closed): what ideas are checked against. */
  price: number;
  priceBasis: "ask" | "ltp";
  delta: number | null;
  /** Implied volatility, percent. */
  iv: number | null;
  /** Premium lost per day to time decay (negative, Upstox's figure). */
  theta: number | null;
  oi: number | null;
  oiChange: number | null;
  daysToExpiry: number;
  /** Index level at expiry where the option is worth `price` (strike ± price). */
  breakevenAtExpiry: number;
  /** price × lot size, rupees. */
  costPerLot: number;
  /** When the chain was read (ISO, IST). */
  asOf: string;
}

/** A far out-of-the-money contract expiring today, priced at ₹10 or less (a "zero-hero" lottery ticket). */
export interface ZeroHeroCandidate {
  id: string;
  index: IndexId;
  expiry: string;
  strike: number;
  optionType: OptionType;
  label: string;
  lotSize: number;
  price: number;
  priceBasis: "ask" | "ltp";
  delta: number | null;
  costPerLot: number;
  /** How far the strike is from the index, percent. */
  distancePct: number;
  /** 100 × (1 − |delta|): the market's own rough odds that it expires worthless; null without a delta. */
  impliedWorthlessPct: number | null;
}

export interface AdvisorContext {
  /** The compact JSON the advice call reads. */
  promptJson: string;
  candidates: AdvisorCandidate[];
  zeroHeroCandidates: ZeroHeroCandidate[];
  market: AdvisorReport["market"];
  /** Expiring today (IST) per index, when there is one. */
  expiryToday: Partial<Record<IndexId, string>>;
  /** URLs the context itself carries (news links), which the brief may cite. */
  knownUrls: string[];
}

/** Token usage of one or more API calls, for the cost estimate. */
export interface AdvisorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearches: number;
}

export const ZERO_USAGE: AdvisorUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, webSearches: 0 };

export function addUsage(a: AdvisorUsage, b: AdvisorUsage): AdvisorUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    webSearches: a.webSearches + b.webSearches,
  };
}
