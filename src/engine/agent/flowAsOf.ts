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

/** One index's replay: the samples it ingested (in order) and the asOfMs it last answered for. */
interface AsOfState {
  day: string;
  lastAsOfMs: number;
  consumed: ChainSnapshot[];
  monitor: FlowMonitor;
}

/**
 * flowViewAsOf for the market feed, one call per bar close and index, without replaying the whole session each time
 * (a fresh replay at 15:25 ingests about 370 samples; this ingests the few new ones).
 *
 * Per index it keeps one FlowMonitor and the samples it has ingested. A call that moves asOfMs forward within the same
 * IST date, when the samples at or before the last asOfMs are exactly those (the same objects, in the same order),
 * ingests only the samples after the last asOfMs, in time order. Anything else rebuilds from scratch: an earlier
 * asOfMs, a new date, or a sample at or before the last asOfMs that arrived late, was dropped or was replaced. The
 * monitor's view does not change its state, and ingesting the same samples in the same order gives the same state,
 * so the answer always equals flowViewAsOf's.
 */
export class FlowAsOfCache {
  private readonly stats: FlowStatsFile | undefined;
  private readonly state = new Map<IndexId, AsOfState>();

  constructor(opts: { stats?: FlowStatsFile } = {}) {
    this.stats = opts.stats;
  }

  /** Equal to flowViewAsOf(snaps, index, asOfMs, { stats, dte }) for any sequence of calls; incremental while asOfMs moves forward within one IST date. */
  viewAt(snaps: readonly ChainSnapshot[], index: IndexId, asOfMs: number, dte: number | null): OptionFlowView | null {
    const day = istDate(asOfMs);
    // The samples flowViewAsOf would replay, in the order it replays them (FlowMonitor.restore: a stable sort by time).
    const relevant = snaps.filter((s) => s.index === index && s.t <= asOfMs && istDate(s.t) === day).sort((a, b) => a.t - b.t);
    let st = this.state.get(index);
    if (!st || st.day !== day || !(asOfMs >= st.lastAsOfMs) || !continues(st, relevant)) {
      st = { day, lastAsOfMs: -Infinity, consumed: [], monitor: new FlowMonitor(this.stats ? { stats: this.stats } : {}) };
      this.state.set(index, st);
    }
    for (let i = st.consumed.length; i < relevant.length; i++) {
      st.monitor.ingest(relevant[i]);
      st.consumed.push(relevant[i]);
    }
    st.lastAsOfMs = asOfMs;
    return st.monitor.snapshots(index).length > 0 ? st.monitor.view(index, asOfMs, { source: "feed", dte }) : null;
  }
}

/** True when the samples at or before the last asOfMs are exactly the ones already ingested, in the same order. */
function continues(st: AsOfState, relevant: readonly ChainSnapshot[]): boolean {
  const n = st.consumed.length;
  if (relevant.length < n) return false;
  for (let i = 0; i < n; i++) if (relevant[i] !== st.consumed[i]) return false;
  return n === relevant.length || relevant[n].t > st.lastAsOfMs;
}
