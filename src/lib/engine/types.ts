/** Dashboard-local engine types shared by the server snapshot and the client provider. */
import type {
  EngineStateDTO,
  EventClusterView,
  FillView,
  OrderView,
  PnlResponse,
  PositionView,
  ScheduledEventView,
  SignalPerformanceRow,
  SignalView,
} from "@/engine/api-types";

export interface EngineSlices {
  state: EngineStateDTO | null;
  signals: SignalView[] | null;
  positions: PositionView[] | null;
  events: EventClusterView[] | null;
  orders: { orders: OrderView[]; fills: FillView[] } | null;
  pnl: PnlResponse | null;
  performance: SignalPerformanceRow[] | null;
  scheduled: ScheduledEventView[] | null;
}

export interface EngineSnapshot extends EngineSlices {
  source: "engine" | "mock";
  /** Server epoch ms when the snapshot was taken. */
  fetchedAt: number;
}

export type SliceKey = keyof EngineSlices;
