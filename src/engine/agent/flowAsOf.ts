/** The option flow as it read at a past moment, from the feed's minute samples. */
import type { OptionFlowView } from "../api-types";
import { istDate } from "../clock";
import { FlowMonitor, type ChainSnapshot } from "../flow/flowMonitor";
import type { FlowStatsFile } from "../flow/flowStatsTypes";
import type { IndexId } from "../types";

/**
 * The flow view built only from samples taken at or before asOfMs on the same IST date; null without one. Pure: a
 * fresh monitor replays those samples in time order (FlowMonitor.restore) and builds its view at asOfMs, so samples
 * after asOfMs can never change it.
 */
export function flowViewAsOf(snaps: readonly ChainSnapshot[], index: IndexId, asOfMs: number, opts: { stats?: FlowStatsFile; dte?: number | null } = {}): OptionFlowView | null {
  const m = new FlowMonitor(opts.stats ? { stats: opts.stats } : {});
  const day = istDate(asOfMs);
  m.restore(
    index,
    snaps.filter((s) => s.index === index && s.t <= asOfMs && istDate(s.t) === day),
  );
  return m.snapshots(index).length ? m.view(index, asOfMs, { source: "feed", dte: opts.dte ?? null }) : null;
}
