/** The option flow as it read at a past moment, from the feed's minute samples. */
import type { OptionFlowView } from "../api-types";
import type { ChainSnapshot } from "../flow/flowMonitor";
import type { FlowStatsFile } from "../flow/flowStatsTypes";
import type { IndexId } from "../types";
import { notImplemented } from "./notImplemented";

/** The flow view built only from samples taken at or before asOfMs; null without one. Pure (FlowMonitor.restore + view). */
export function flowViewAsOf(snaps: readonly ChainSnapshot[], index: IndexId, asOfMs: number, opts?: { stats?: FlowStatsFile; dte?: number | null }): OptionFlowView | null {
  return notImplemented(snaps, index, asOfMs, opts);
}
