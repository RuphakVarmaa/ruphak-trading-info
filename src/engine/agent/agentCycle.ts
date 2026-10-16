/**
 * The TE-side agent cycle: build the bar's reflex input, execute a batch of decisions through the code gate, the
 * planner and the risk layer, and run the agent's code exits. Pure over EngineDeps (also used by the replay tests).
 */
import type { TradingCalendar } from "../calendar/calendar";
import type { EngineConfig } from "../config";
import type { EngineDeps } from "../ports";
import type { PositionReport } from "../pipeline/positionCycle";
import type { OptionFlowView } from "../api-types";
import type { Conviction, EngineSettings, EventPressure, IndexId, MarketFeatures, MarketSnapshot, Position, ScoredEvent, SignalPerformance } from "../types";
import type { AgentBookState, AgentPositionTag, AgentRiskSnapshot, AgentTradeRecord, ExecutionRecord, IndexSnapshot, ReflexBatch, ReflexInput } from "./types";
import { notImplemented } from "./notImplemented";

export interface BuildInputArgs {
  barCloseMs: number;
  indices: readonly IndexId[];
  complete: readonly IndexId[];
  /** report.snapshot: may hold data after the bar close; truncated inside. */
  market: MarketSnapshot;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  events: ScoredEvent[];
  perf: SignalPerformance[];
  flows: Partial<Record<IndexId, OptionFlowView | null>>;
  book: AgentBookState;
  nowMs: number;
}

export function buildReflexInput(a: BuildInputArgs): ReflexInput {
  return notImplemented(a);
}

/** The newest recorded book with t ≤ barCloseMs, else the fallback. */
export function bookAsOf(ring: readonly AgentBookState[], barCloseMs: number, fallback: AgentBookState): AgentBookState {
  return notImplemented(ring, barCloseMs, fallback);
}

/** The fallback book: from the latest stored risk with t ≤ the bar close, else flat at `capital` with t = the day start. */
export function initialBook(risk: AgentRiskSnapshot | null, capital: number, t: number): AgentBookState {
  return notImplemented(risk, capital, t);
}

/** The book TE records each step: the risk snapshot plus the open positions marked at their last premium. */
export function bookFrom(risk: AgentRiskSnapshot, positions: readonly Position[], lotSizeOf: (p: Position) => number): AgentBookState {
  return notImplemented(risk, positions, lotSizeOf);
}

/** A conviction with no view (score 0, not passing) and the config's threshold, for an index without one this tick. */
export function neutralConviction(index: IndexId, t: number, cfg: EngineConfig): Conviction {
  return notImplemented(index, t, cfg);
}

export interface ExecuteContext {
  mode: "shadow" | "paper";
  nowMs: number;
  calendar: TradingCalendar;
  features: Partial<Record<IndexId, MarketFeatures>>;
  pressure: Partial<Record<IndexId, EventPressure>>;
  convictions: Partial<Record<IndexId, Conviction>>;
  snapshots: Partial<Record<IndexId, IndexSnapshot>>;
  noEntries: string | null;
  mainSettings: () => Promise<EngineSettings>;
  peakEquity: number | null;
  ddHalt: boolean;
  /** positionId → finalist (mutated: entries added, closed positions removed). */
  positions: Record<string, AgentPositionTag>;
  trades: readonly AgentTradeRecord[];
  acceptSyntheticQuotes?: boolean;
  /** Milliseconds left in the runner's time budget; once ≤ 0 the remaining entries are not executed. Exits always run. */
  timeLeftMs?: () => number;
}

export function executeAgentBatch(deps: EngineDeps, batch: ReflexBatch, x: ExecuteContext): Promise<ExecutionRecord> {
  return notImplemented(deps, batch, x);
}

/** The agent's code exits (stop, target, trail, time stop, square-off, halt): runPositionCycle(deps, {}). */
export function agentPositionPass(deps: EngineDeps): Promise<PositionReport> {
  return notImplemented(deps);
}
