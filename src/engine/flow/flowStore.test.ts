import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import type { ChainSnapshot, SideQuote } from "./flowMonitor";
import { FLOW_SESSION_KEY, FLOW_SNAP_PREFIX, PersistentFlowMonitor, type FlowStorage } from "./flowStore";
import type { FlowStatsFile } from "./flowStatsTypes";
import { chainSnapshotFromTicks, inFlowSession } from "./feedSnapshot";
import type { FeedTick } from "../market/upstoxFeed";

const STATS: FlowStatsFile = {
  generatedAt: "",
  source: "test",
  method: "",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Test."],
};

/** A Map with DurableObjectStorage's KV methods, counting writes. */
class MapStorage implements FlowStorage {
  readonly map = new Map<string, unknown>();
  puts = 0;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.map.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.puts++;
    this.map.set(key, structuredClone(value));
  }
  async list<T>(o: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of [...this.map.keys()].sort()) if (k.startsWith(o.prefix)) out.set(k, structuredClone(this.map.get(k)) as T);
    return out;
  }
  async delete(keys: string[]): Promise<number> {
    if (keys.length > 128) throw new Error("at most 128 keys");
    let n = 0;
    for (const k of keys) if (this.map.delete(k)) n++;
    return n;
  }
  snapKeys(): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(FLOW_SNAP_PREFIX));
  }
}

const q = (o: Partial<SideQuote>): SideQuote => ({ ltp: 100, volume: 0, oi: 100_000, bid: 99.95, ask: 100.05, iv: 12, delta: 0.5, ...o });
const t0 = istAt("2026-10-14", "10:00") + 2_000;

function snap(m: number, index: "NIFTY" | "SENSEX" = "NIFTY", day = t0): ChainSnapshot {
  const strikes = index === "NIFTY" ? [22450, 22500, 22550] : [72500, 72600, 72700];
  return {
    t: day + m * 60_000,
    index,
    expiry: "2026-10-20",
    lotSize: 65,
    spot: strikes[1] + 3,
    rows: strikes.map((strike) => ({
      strike,
      ce: q({ volume: 100 * m + (m === 14 ? 900 : 0), oi: 100_000 + 2000 * m, ltp: 100 + m }),
      pe: q({ volume: 100 * m, oi: 100_000 + 500 * m, ltp: 100 - m, delta: -0.5 }),
    })),
  };
}

describe("option flow persistence", () => {
  it("restores the session exactly after an eviction", async () => {
    const storage = new MapStorage();
    const a = new PersistentFlowMonitor(storage, { stats: STATS });
    await a.load(t0);
    for (let m = 0; m < 20; m++) {
      await a.record(snap(m));
      await a.record(snap(m, "SENSEX"));
    }
    expect(a.stored("NIFTY")).toBe(20);
    const now = t0 + 19 * 60_000 + 10_000;
    const before = a.view("NIFTY", now);

    // A new instance (the Durable Object was evicted) replays storage.
    const b = new PersistentFlowMonitor(storage, { stats: STATS });
    await b.load(now);
    expect(b.view("NIFTY", now)).toEqual(before);
    expect(b.view("SENSEX", now).minutes).toBe(20);
    expect(b.stored("NIFTY")).toBe(20);
    // And it carries on from there.
    await b.record(snap(20));
    expect(b.view("NIFTY", now + 60_000).minutes).toBe(21);
  });

  it("does not store a second sample in the same minute", async () => {
    const storage = new MapStorage();
    const a = new PersistentFlowMonitor(storage, { stats: STATS });
    await a.load(t0);
    expect(await a.record(snap(0))).toBe(true);
    expect(await a.record({ ...snap(0), t: t0 + 30_000 })).toBe(false);
    expect(storage.snapKeys()).toHaveLength(1);
  });

  it("clears the previous session at load and on the first sample of a new day", async () => {
    const storage = new MapStorage();
    const a = new PersistentFlowMonitor(storage, { stats: STATS });
    await a.load(t0);
    for (let m = 0; m < 5; m++) await a.record(snap(m));
    const nextDay = istAt("2026-10-15", "09:20");
    const b = new PersistentFlowMonitor(storage, { stats: STATS });
    await b.load(nextDay);
    expect(storage.snapKeys()).toHaveLength(0);
    expect(b.view("NIFTY", nextDay).minutes).toBe(0);

    for (let m = 0; m < 3; m++) await a.record(snap(m));
    await a.record(snap(0, "NIFTY", istAt("2026-10-15", "09:30") + 2_000));
    expect(storage.snapKeys()).toHaveLength(1);
    expect(storage.map.get(FLOW_SESSION_KEY)).toBe("2026-10-15");
  });

  it("caps the stored snapshots per index, deleting the oldest", async () => {
    const storage = new MapStorage();
    const a = new PersistentFlowMonitor(storage, { stats: STATS, maxSnaps: 8 });
    await a.load(t0);
    for (let m = 0; m < 12; m++) await a.record(snap(m));
    expect(storage.snapKeys()).toHaveLength(8);
    const b = new PersistentFlowMonitor(storage, { stats: STATS, maxSnaps: 8 });
    await b.load(t0 + 12 * 60_000);
    expect(b.view("NIFTY", t0 + 12 * 60_000).minutes).toBe(8);
  });

  it("deletes more than 128 stale keys in batches", async () => {
    const storage = new MapStorage();
    for (let i = 0; i < 300; i++) storage.map.set(`${FLOW_SNAP_PREFIX}NIFTY:${String(i).padStart(10, "0")}`, { v: 1 });
    storage.map.set(FLOW_SESSION_KEY, "2026-10-13");
    const a = new PersistentFlowMonitor(storage, { stats: STATS });
    await a.load(t0);
    expect(storage.snapKeys()).toHaveLength(0);
  });
});

describe("the feed's minute sample", () => {
  const tick = (key: string, o: Partial<FeedTick>): FeedTick => ({
    key,
    ltp: null,
    ltt: null,
    cp: null,
    bid: null,
    ask: null,
    bidQty: null,
    askQty: null,
    volume: null,
    oi: null,
    iv: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    open: null,
    high: null,
    low: null,
    receivedAt: t0,
    ...o,
  });

  it("builds a snapshot from the subscribed strikes' ticks and the index tick", () => {
    const ticks = new Map<string, FeedTick>([
      ["NSE_INDEX|Nifty 50", tick("NSE_INDEX|Nifty 50", { ltp: 22512.4 })],
      ["NSE_FO|1", tick("NSE_FO|1", { ltp: 120, volume: 5000, oi: 70_000, bid: 119.9, ask: 120.1, iv: 11.2, delta: 0.55 })],
      ["NSE_FO|2", tick("NSE_FO|2", { ltp: 95, volume: 4000, oi: 90_000, bid: 94.9, ask: 95.1, iv: 12.4, delta: -0.45 })],
    ]);
    const book = {
      index: "NIFTY" as const,
      expiry: "2026-10-20",
      lotSize: 65,
      strikes: [
        { strike: 22500, ce: "NSE_FO|1", pe: "NSE_FO|2" },
        { strike: 22550, ce: "NSE_FO|3", pe: null },
      ],
    };
    const s = chainSnapshotFromTicks(book, (k) => ticks.get(k), t0);
    expect(s).toEqual({
      t: t0,
      index: "NIFTY",
      expiry: "2026-10-20",
      lotSize: 65,
      spot: 22512.4,
      rows: [
        {
          strike: 22500,
          ce: { ltp: 120, volume: 5000, oi: 70_000, bid: 119.9, ask: 120.1, iv: 11.2, delta: 0.55 },
          pe: { ltp: 95, volume: 4000, oi: 90_000, bid: 94.9, ask: 95.1, iv: 12.4, delta: -0.45 },
        },
      ],
    });
    expect(chainSnapshotFromTicks(book, (k) => (k.startsWith("NSE_INDEX") ? undefined : ticks.get(k)), t0)).toBeNull();
  });

  it("samples only during the session on weekdays", () => {
    expect(inFlowSession(istAt("2026-10-14", "09:14"))).toBe(false);
    expect(inFlowSession(istAt("2026-10-14", "09:15"))).toBe(true);
    expect(inFlowSession(istAt("2026-10-14", "15:29"))).toBe(true);
    expect(inFlowSession(istAt("2026-10-14", "15:30"))).toBe(false);
    expect(inFlowSession(istAt("2026-10-17", "10:00"))).toBe(false);
  });
});
