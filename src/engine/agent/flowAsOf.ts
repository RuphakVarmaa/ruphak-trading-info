/** The option flow as it read at a past moment, from the market feed's minute samples (SPEC §2.1, §3.1). */
import type { OptionFlowView } from "../api-types";
import { istDate } from "../clock";
import { FlowMonitor, type ChainSnapshot } from "../flow/flowMonitor";
import type { FlowStatsFile } from "../flow/flowStatsTypes";
import type { IndexId } from "../types";

/**
 * The flow view built only from the index's samples taken at or before asOfMs on asOfMs's IST date; null without
 * one. Pure: a fresh monitor replays those samples in time order (FlowMonitor.restore) and builds its view at
 * asOfMs, so samples taken later can never change it, whatever order they arrive in.
 */
export function flowViewAsOf(snaps: readonly ChainSnapshot[], index: IndexId, asOfMs: number, opts: { stats?: FlowStatsFile; dte?: number | null } = {}): OptionFlowView | null {
  const day = istDate(asOfMs);
  const m = new FlowMonitor(opts.stats ? { stats: opts.stats } : {});
  m.restore(
    index,
    snaps.filter((s) => s.index === index && s.t <= asOfMs && istDate(s.t) === day),
  );
  return m.snapshots(index).length > 0 ? m.view(index, asOfMs, { source: "feed", dte: opts.dte ?? null }) : null;
}
