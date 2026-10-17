/**
 * The market feed's as-of option flow: FlowAsOfCache (src/engine/agent/flowAsOf.ts) gives flowViewAsOf's view as the
 * feed calls it, once per candle close and index while its samples arrive, at the cost of the samples since the
 * previous call (the 15:25 read costs one view, not a replay of the day); and MarketFeedDO.getOptionFlowAsOf goes
 * through it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import { FlowAsOfCache, flowViewAsOf } from "../../../../src/engine/agent/flowAsOf";
import { defaultCalendar } from "../../../../src/engine/calendar/calendar";
import { addDays, istAt, MINUTE_MS } from "../../../../src/engine/clock";
import { FlowMonitor, type ChainSnapshot, type SideQuote } from "../../../../src/engine/flow/flowMonitor";
import { FLOW_STATS } from "../../../../src/engine/flow/flowStats";
import type { IndexId } from "../../../../src/engine/types";
import { MarketFeedDO } from "./MarketFeedDO";

const DAY = "2026-10-19";
const q = (m: number, k: number, ce: boolean): SideQuote => ({
  ltp: 100 + Math.sin(m / 7 + k) * 5,
  volume: 1000 * m + ((m * 7919 + k) % 13) * 400,
  oi: 100_000 + 500 * m * (ce ? 1 : -1) + k * 100 + ((m * k) % 17) * 300,
  bid: 99,
  ask: 101,
  iv: 12 + (m % 5) / 10,
  delta: ce ? 0.5 : -0.5,
});
/** A sample 1.5 s after minute m of the session (09:15 + m), as the feed takes them: `strikes` strikes (31 live). */
const sample = (m: number, index: IndexId = "NIFTY", day = DAY, strikes = 31): ChainSnapshot => ({
  t: istAt(day, "09:15") + 1_500 + m * MINUTE_MS,
  index,
  expiry: "2026-10-20",
  lotSize: index === "NIFTY" ? 65 : 20,
  spot: (index === "NIFTY" ? 25_000 : 82_000) + 3 * Math.sin(m / 9) * 20,
  rows: Array.from({ length: strikes }, (_, k) => ({ strike: (index === "NIFTY" ? 24_250 : 80_500) + (index === "NIFTY" ? 50 : 100) * k, ce: q(m, k, true), pe: q(m, k, false) })),
});
const session = (n: number, index: IndexId = "NIFTY", day = DAY, strikes = 31) => Array.from({ length: n }, (_, m) => sample(m, index, day, strikes));
const closes = (day = DAY) => {
  const out: number[] = [];
  for (let t = istAt(day, "09:20"); t <= istAt(day, "15:30"); t += 5 * MINUTE_MS) out.push(t);
  return out;
};
const fresh = (snaps: readonly ChainSnapshot[], index: IndexId, at: number, dte: number | null = 1) => flowViewAsOf(snaps, index, at, { stats: FLOW_STATS, dte });

afterEach(() => vi.restoreAllMocks());

describe("FlowAsOfCache, as the market feed calls it", () => {
  it("equals flowViewAsOf at every bar close of a 375-sample session, with the samples arriving as the day goes", { timeout: 60_000 }, () => {
    // Five strikes keep the 75 reference replays quick; the cache's own work is the same whatever the count.
    const all = session(375, "NIFTY", DAY, 5);
    const cache = new FlowAsOfCache({ stats: FLOW_STATS });
    for (const at of closes()) {
      // What the live monitor holds at that moment: the samples taken so far.
      const held = all.filter((s) => s.t <= at + 20_000);
      expect(cache.viewAt(held, "NIFTY", at, 1)).toEqual(fresh(held, "NIFTY", at));
    }
  });

  it("ingests only the samples since its previous call: the 15:25 call costs a view, not a replay of the day", () => {
    const all = session(375);
    const cache = new FlowAsOfCache({ stats: FLOW_STATS });
    for (const at of closes().filter((t) => t < istAt(DAY, "15:25"))) cache.viewAt(all, "NIFTY", at, 1);
    const ingest = vi.spyOn(FlowMonitor.prototype, "ingest");
    const t0 = performance.now();
    const view = cache.viewAt(all, "NIFTY", istAt(DAY, "15:25"), 1);
    const ms = performance.now() - t0;
    expect(ingest).toHaveBeenCalledTimes(5);
    expect(ms).toBeLessThan(100);
    expect(view).toEqual(fresh(all, "NIFTY", istAt(DAY, "15:25")));
    // A replay at 15:25 ingests the whole session so far.
    ingest.mockClear();
    fresh(all, "NIFTY", istAt(DAY, "15:25"));
    expect(ingest.mock.calls.length).toBeGreaterThan(360);
  });

  it("equals flowViewAsOf for calls out of order, after a late sample, across a date change and for each index", () => {
    const cache = new FlowAsOfCache({ stats: FLOW_STATS });
    const nifty = session(120);
    const sensex = session(120, "SENSEX");
    const both = [...nifty, ...sensex];
    const at = (hhmm: string, day = DAY) => istAt(day, hhmm);
    // Forward, then backward (a rebuild), then the other index, then forward again.
    for (const t of [at("10:00"), at("10:30"), at("09:45"), at("10:35")]) {
      expect(cache.viewAt(both, "NIFTY", t, 1)).toEqual(fresh(both, "NIFTY", t));
      expect(cache.viewAt(both, "SENSEX", t, 2)).toEqual(fresh(both, "SENSEX", t, 2));
    }
    // A sample that arrives late, for a minute already read: the next call sees it, as a replay does.
    const gap = nifty.filter((s) => s.t !== sample(100).t);
    const c2 = new FlowAsOfCache({ stats: FLOW_STATS });
    expect(c2.viewAt(gap, "NIFTY", at("11:00"), 1)).toEqual(fresh(gap, "NIFTY", at("11:00")));
    const late = [...gap, sample(100)];
    expect(c2.viewAt(late, "NIFTY", at("11:05"), 1)).toEqual(fresh(late, "NIFTY", at("11:05")));
    // The next day: only that day's samples count; none yet gives null.
    const next = addDays(DAY, 1);
    const withNext = [...nifty, ...session(30, "NIFTY", next)];
    expect(cache.viewAt(withNext, "NIFTY", istAt(next, "09:15"), 1)).toBeNull();
    expect(cache.viewAt(withNext, "NIFTY", istAt(next, "09:40"), 1)).toEqual(fresh(withNext, "NIFTY", istAt(next, "09:40")));
    expect(cache.viewAt([], "SENSEX", at("10:00"), 1)).toBeNull();
  });
});

describe("MarketFeedDO.getOptionFlowAsOf", () => {
  async function feedDo(): Promise<{ dO: MarketFeedDO; monitor: FlowMonitor }> {
    const storage = {
      get: async () => undefined,
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
      getAlarm: async () => null,
      setAlarm: async () => {},
    };
    let loading: Promise<void> = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile: (f: () => Promise<void>) => (loading = f()) } as unknown as DurableObjectState;
    const dO = new MarketFeedDO(ctx, { UPSTOX_ANALYTICS_TOKEN: "" } as unknown as Env);
    // The constructor restores the stored session (none here) before the DO serves a call.
    await loading;
    return { dO, monitor: (dO as unknown as { flow: { monitor: FlowMonitor } }).flow.monitor };
  }

  it("answers from the incremental cache with the same view as a replay", async () => {
    const { dO, monitor } = await feedDo();
    for (const s of session(200)) monitor.ingest(s);
    const viewAt = vi.spyOn(FlowAsOfCache.prototype, "viewAt");
    const dte = defaultCalendar.tradingDaysBetween(DAY, "2026-10-20");
    for (const t of [istAt(DAY, "11:00"), istAt(DAY, "11:05"), istAt(DAY, "12:00")]) {
      const got = await dO.getOptionFlowAsOf("NIFTY", t);
      expect(got).not.toBeNull();
      expect(got).toEqual(flowViewAsOf(monitor.snapshots("NIFTY"), "NIFTY", t, { stats: FLOW_STATS, dte }));
    }
    expect(viewAt).toHaveBeenCalledTimes(3);
  });

  it("stays incremental between candle closes: the live monitor's samples reach the cache as the same objects", async () => {
    const { dO, monitor } = await feedDo();
    const all = session(200);
    // The feed samples a minute at a time while the agent reads at each candle close.
    for (const s of all.filter((x) => x.t <= istAt(DAY, "11:00"))) monitor.ingest(s);
    await dO.getOptionFlowAsOf("NIFTY", istAt(DAY, "11:00"));
    const ingest = vi.spyOn(FlowMonitor.prototype, "ingest");
    for (const s of all.filter((x) => x.t > istAt(DAY, "11:00") && x.t <= istAt(DAY, "11:05"))) monitor.ingest(s);
    const live = ingest.mock.calls.length;
    expect(live).toBe(5);
    await dO.getOptionFlowAsOf("NIFTY", istAt(DAY, "11:05"));
    // The cache ingested only the 5 samples since 11:00, not the 110 of the day so far (a rebuild).
    expect(ingest.mock.calls.length - live).toBe(5);
  });
});
