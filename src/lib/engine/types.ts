/** Dashboard-local engine types shared by the server snapshot and the client provider, and the Agent page's view fields. */
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

// ---------------------------------------------------------------------------
// The Agent page's view fields (FIXPLAN I-6). Each is optional, so a record stored before the engine wrote it
// still reads; the page uses the fallback given with each field. They match the engine's view types field for
// field, so these stay assignable both ways once api-types.ts carries the same fields.
// ---------------------------------------------------------------------------

/** A decision's sizing, with the number of graded calls behind p. */
export type AgentSizingView = NonNullable<AgentDecisionView["sizing"]> & {
  /** Effective (overlap-weighted) number of graded calls behind p; null or absent when unknown. */
  n?: number | null;
};

/** Why an incomplete replay stopped. */
export type AgentReplayStopReason = "cost_cap" | "interrupted" | "no_key";

/** The candidate's replay, with its coverage and the counts behind each Brier score. */
export type AgentReplayView = NonNullable<AgentCandidateView["replay"]> & {
  /** The day's candles with an OK batch: what the replay set out to judge. Fallback: bars. */
  barsTotal?: number;
  /** Directional calls each run labelled HIT or MISS. Fallback for each: graded. */
  gradedCandidate?: number;
  gradedCurrent?: number;
  gradedLive?: number;
  /** Calls (candle and finalist) that all three runs labelled HIT or MISS; all three Brier scores are over exactly these. */
  gradedCommon?: number;
  /** Why an incomplete replay stopped; null when complete. Absent on an incomplete replay: "stopped early", no cause. */
  stopReason?: AgentReplayStopReason | null;
};

/** The candidate card: the text it was written against, whether it is the text in use, and its replay. */
export type AgentCandidateCardView = Omit<AgentCandidateView, "replay"> & {
  /** The text the candidate was written against (the reviewed session's text): the diff's "before". Fallback: currentGuidance. */
  baseGuidance?: string;
  /** APPROVED, and its text is the active one now. Fallback: status === "APPROVED". */
  inUse?: boolean;
  replay: AgentReplayView | null;
};

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
