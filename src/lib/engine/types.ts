/** Dashboard-local engine types shared by the server snapshot and the client provider, and short names for the Agent page's view parts. */
import type {
  AgentCandidateView,
  AgentDecisionView,
  EngineStateDTO,
  EventClusterView,
  FillView,
  OrderView,
  PnlResponse,
  PositionView,
  ScheduledEventView,
  SignalPerformanceRow,
  SignalView,
  TodayPlanView,
} from "@/engine/api-types";

/** A decision's sizing, with n: the number of graded calls behind p (null or absent when unknown). */
export type AgentSizingView = NonNullable<AgentDecisionView["sizing"]>;

/**
 * The candidate's replay, with its coverage (barsTotal), each run's graded count and the count all three runs
 * labelled (the Brier scores are over those), and why an incomplete one stopped. The fields are optional: a replay
 * stored before the engine wrote them still reads.
 */
export type AgentReplayView = NonNullable<AgentCandidateView["replay"]>;

export interface EngineSlices {
  state: EngineStateDTO | null;
  signals: SignalView[] | null;
  positions: PositionView[] | null;
  events: EventClusterView[] | null;
  orders: { orders: OrderView[]; fills: FillView[] } | null;
  pnl: PnlResponse | null;
  performance: SignalPerformanceRow[] | null;
  scheduled: ScheduledEventView[] | null;
  /** The plan's no-trade rules for the session (market-wide, like events). */
  plan: TodayPlanView | null;
}

export interface EngineSnapshot extends EngineSlices {
  source: "engine" | "mock";
  /** Server epoch ms when the snapshot was taken. */
  fetchedAt: number;
}

export type SliceKey = keyof EngineSlices;
