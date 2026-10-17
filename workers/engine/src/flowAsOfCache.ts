/**
 * The option flow as it read at a past moment, for MarketFeedDO.getOptionFlowAsOf (the options agent's read at each
 * candle close), kept incrementally: one flow monitor per index ingests only the samples taken since the previous
 * call, so a call late in the session costs about one view instead of a replay of the whole day's minute samples
 * (which took about 0.6 s an index at 15:25 and held up the feed's socket and sampling meanwhile).
 *
 * Every answer equals flowViewAsOf(snaps, index, asOfMs, { stats, dte }) (src/engine/agent/flowAsOf.ts), for any
 * order of calls. An index's monitor is rebuilt from scratch when asOfMs moves back, when the IST date changes, or
 * when the number of that date's samples at or before the previous asOfMs changed (a late sample arrived).
 */
import type { OptionFlowView } from "../../../src/engine/api-types";
import { DAY_MS, istDate, istMidnight } from "../../../src/engine/clock";
import { FlowMonitor, type ChainSnapshot } from "../../../src/engine/flow/flowMonitor";
import type { FlowStatsFile } from "../../../src/engine/flow/flowStatsTypes";
import type { IndexId } from "../../../src/engine/types";

interface IndexState {
  monitor: FlowMonitor;
  /** The IST date the monitor's samples are from. */
  date: string;
  /** The previous call's asOfMs: every sample of `date` at or before it has been ingested. */
  asOfMs: number;
  /** How many samples of `date` at or before asOfMs the previous call saw. */
  seen: number;
}

export class FlowAsOfCache {
  private readonly stats: FlowStatsFile | undefined;
  private readonly byIndex = new Map<IndexId, IndexState>();

  constructor(opts: { stats?: FlowStatsFile } = {}) {
    this.stats = opts.stats;
  }

  /** The flow view at asOfMs from the index's samples of asOfMs's IST date taken at or before it; null without one. */
  viewAt(snaps: readonly ChainSnapshot[], index: IndexId, asOfMs: number, dte: number | null): OptionFlowView | null {
    const date = istDate(asOfMs);
    const start = istMidnight(date);
    const sameDay = snaps.filter((s) => s.index === index && s.t >= start && s.t < start + DAY_MS);
    let st = this.byIndex.get(index);
    const prev = st;
    const lateSample = prev !== undefined && sameDay.filter((s) => s.t <= prev.asOfMs).length !== prev.seen;
    if (!st || asOfMs < st.asOfMs || st.date !== date || lateSample) {
      st = { monitor: new FlowMonitor(this.stats ? { stats: this.stats } : {}), date, asOfMs: -Infinity, seen: 0 };
      this.byIndex.set(index, st);
    }
    const from = st.asOfMs;
    // In time order, as a replay ingests them; every one is later than all the samples already in the monitor.
    for (const s of sameDay.filter((x) => x.t > from && x.t <= asOfMs).sort((a, b) => a.t - b.t)) st.monitor.ingest(s);
    st.asOfMs = asOfMs;
    st.seen = sameDay.filter((s) => s.t <= asOfMs).length;
    return st.monitor.snapshots(index).length > 0 ? st.monitor.view(index, asOfMs, { source: "feed", dte }) : null;
  }
}
