/**
 * Ports: the only way the pure engine touches the outside world. Production wires them to
 * D1, Groww, Yahoo and Anthropic; tests and backtests wire in-memory and replay versions.
 */
import type { ZodType } from "zod";
import type { Clock } from "./clock";
import type { EngineConfig } from "./config";
import type { TradingCalendar } from "./calendar/calendar";
import type {
  ArticleCluster,
  AuditEntry,
  DayLedger,
  EngineSettings,
  EventPressure,
  Fill,
  Heartbeat,
  IndexId,
  MarketSnapshot,
  NormalizedArticle,
  OptionContract,
  OptionType,
  Order,
  OrderRequest,
  PlanDecision,
  Position,
  Quote,
  ScoredEvent,
  SignalOutcome,
  SignalPerformance,
  SnapshotRecord,
  TradePlan,
  TradeRecord,
  TradingMode,
} from "./types";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ArticleStore {
  knownIds(ids: string[]): Promise<Set<string>>;
  upsertMany(articles: NormalizedArticle[]): Promise<void>;
  byIds(ids: string[]): Promise<NormalizedArticle[]>;
}

export interface ClusterStore {
  upsertMany(clusters: ArticleCluster[]): Promise<void>;
  /** Clusters whose lastSeenMs >= sinceMs. */
  active(sinceMs: number): Promise<ArticleCluster[]>;
  byIds(ids: string[]): Promise<ArticleCluster[]>;
  byKey(key: string): Promise<ArticleCluster | null>;
  /** Clusters with status UNSCORED or RESCORE, most recently seen first. */
  needingScore(limit: number): Promise<ArticleCluster[]>;
  deleteMany(ids: string[]): Promise<void>;
}

export interface EventStore {
  /** Upserts by clusterId: a re-score supersedes the previous score. */
  upsertMany(events: ScoredEvent[]): Promise<void>;
  /** Scores whose cluster was first seen at or after sinceMs. */
  active(sinceMs: number): Promise<ScoredEvent[]>;
  byClusterIds(ids: string[]): Promise<ScoredEvent[]>;
  deleteByClusterIds(ids: string[]): Promise<void>;
}

export interface PressureStore {
  append(p: EventPressure): Promise<void>;
  latest(index: IndexId): Promise<EventPressure | null>;
}

export interface SnapshotStore {
  append(s: SnapshotRecord): Promise<void>;
  latest(): Promise<SnapshotRecord | null>;
  between(fromMs: number, toMs: number): Promise<SnapshotRecord[]>;
}

export interface DecisionStore {
  append(d: PlanDecision): Promise<void>;
  latest(index: IndexId): Promise<PlanDecision | null>;
  between(fromMs: number, toMs: number): Promise<PlanDecision[]>;
}

export interface OutcomeStore {
  upsertMany(o: SignalOutcome[]): Promise<void>;
  between(fromMs: number, toMs: number): Promise<SignalOutcome[]>;
}

export interface PlanStore {
  save(p: TradePlan): Promise<void>;
  get(id: string): Promise<TradePlan | null>;
}

export interface OrderStore {
  save(o: Order): Promise<void>;
  get(id: string): Promise<Order | null>;
  byRefId(refId: string): Promise<Order | null>;
  /** Orders not yet in a terminal state. */
  open(mode: TradingMode): Promise<Order[]>;
  between(fromMs: number, toMs: number, mode?: TradingMode): Promise<Order[]>;
}

export interface FillStore {
  append(f: Fill): Promise<void>;
  forOrder(orderId: string): Promise<Fill[]>;
  between(fromMs: number, toMs: number): Promise<Fill[]>;
}

export interface PositionStore {
  save(p: Position): Promise<void>;
  get(id: string): Promise<Position | null>;
  open(mode: TradingMode): Promise<Position[]>;
  closedBetween(fromMs: number, toMs: number, mode: TradingMode): Promise<Position[]>;
}

export interface TradeStore {
  append(t: TradeRecord): Promise<void>;
  /** Most recent first. */
  recent(n: number, mode: TradingMode): Promise<TradeRecord[]>;
  between(fromMs: number, toMs: number, mode: TradingMode): Promise<TradeRecord[]>;
}

export interface PerformanceStore {
  all(mode: TradingMode): Promise<SignalPerformance[]>;
  upsertMany(rows: SignalPerformance[]): Promise<void>;
}

export interface LedgerStore {
  get(date: string, mode: TradingMode): Promise<DayLedger | null>;
  save(l: DayLedger): Promise<void>;
  range(fromDate: string, toDate: string, mode: TradingMode): Promise<DayLedger[]>;
}

export interface SettingsStore {
  get(): Promise<EngineSettings>;
  update(patch: Partial<EngineSettings>, by: string): Promise<EngineSettings>;
}

/** Small JSON key-value state: cursors, cached tokens, source health. */
export interface StateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface AuditStore {
  append(e: AuditEntry): Promise<void>;
  recent(n: number): Promise<AuditEntry[]>;
}

export interface HeartbeatStore {
  write(h: Heartbeat): Promise<void>;
  read(): Promise<Heartbeat | null>;
}

export interface Repository {
  articles: ArticleStore;
  clusters: ClusterStore;
  events: EventStore;
  pressure: PressureStore;
  snapshots: SnapshotStore;
  decisions: DecisionStore;
  outcomes: OutcomeStore;
  plans: PlanStore;
  orders: OrderStore;
  fills: FillStore;
  positions: PositionStore;
  trades: TradeStore;
  perf: PerformanceStore;
  ledger: LedgerStore;
  settings: SettingsStore;
  state: StateStore;
  audit: AuditStore;
  heartbeat: HeartbeatStore;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface MarketDataSource {
  /** Point-in-time view of index and cross-asset data at `t`. */
  snapshot(t: number): Promise<MarketSnapshot>;
}

export interface OptionChainRow {
  strike: number;
  type: OptionType;
  tradingSymbol: string;
  ltp: number | null;
  oi: number | null;
  iv: number | null;
  delta: number | null;
}

/** Live (or synthetic) option prices. */
export interface OptionQuoteSource {
  readonly kind: "groww" | "synthetic" | "replay";
  quote(contract: OptionContract, ctx: { t: number; spot: number; vix: number }): Promise<Quote>;
  chain?(index: IndexId, expiry: string): Promise<{ underlyingLtp: number; rows: OptionChainRow[] }>;
}

/** Resolves option contracts from the exchange instrument master. */
export interface InstrumentProvider {
  /** Weekly/monthly expiries (YYYY-MM-DD) listed for an index, ascending. */
  expiries(index: IndexId): Promise<string[]>;
  resolve(index: IndexId, expiry: string, strike: number, type: OptionType): Promise<OptionContract | null>;
  /** Strikes listed for an index and expiry, ascending. */
  strikes(index: IndexId, expiry: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export interface OrderResult {
  order: Order;
  /** Fills that happened during this call (not previously reported). */
  fills: Fill[];
}

export interface BrokerPosition {
  tradingSymbol: string;
  exchange: string;
  qty: number;
  avgPrice: number;
}

export interface Broker {
  readonly mode: TradingMode;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  /** Polls the broker for status changes and new fills of an open order. */
  refreshOrder(order: Order): Promise<OrderResult>;
  cancelOrder(order: Order): Promise<OrderResult>;
  /** Broker's view of open positions, for reconciliation. */
  positions(): Promise<BrokerPosition[]>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LlmRequest<T> {
  system: string;
  user: string;
  model: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  schema: ZodType<T>;
}

export interface LlmResponse<T> {
  parsed: T | null;
  usage: LlmUsage;
  model: string;
  stopReason: string | null;
}

export interface LlmClient {
  structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const consoleLogger: Logger = {
  debug: () => {},
  info: (msg, data) => console.log(msg, data ?? ""),
  warn: (msg, data) => console.warn(msg, data ?? ""),
  error: (msg, data) => console.error(msg, data ?? ""),
};

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export type IdGenerator = () => string;

export const randomId: IdGenerator = () => crypto.randomUUID();

/** Deterministic ids for tests and reproducible backtests. */
export function sequentialIds(prefix = "id"): IdGenerator {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Everything the trading cycles need. Identical shape in backtest, paper and live. */
export interface EngineDeps {
  cfg: EngineConfig;
  clock: Clock;
  calendar: TradingCalendar;
  repo: Repository;
  broker: Broker;
  market: MarketDataSource;
  optionQuotes: OptionQuoteSource;
  instruments: InstrumentProvider;
  logger: Logger;
  newId: IdGenerator;
  mode: TradingMode;
}
