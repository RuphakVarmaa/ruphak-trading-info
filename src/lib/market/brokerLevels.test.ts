import { beforeEach, describe, expect, it } from "vitest";
import type { LiveIndexLevelsView } from "@/engine/api-types";
import { istAt } from "@/engine/clock";
import { feedInput } from "@/lib/copy/action";
import { getMockEngine } from "@/lib/engine/mock";
import { __resetBrokerLevelsForTests, BROKER_TTL_MS, getBrokerLevels, mergeBrokerLevels, type BrokerResult } from "./brokerLevels";
import { LIVE_SOURCE } from "./liveFeed";
import { BROKER_MAX_AGE_MS, BROKER_SOURCE, LAGGING_TRADE_MS, type LiveIndex, type LiveIndicesFeed } from "./liveIndices";
import type { LiveFeedResult } from "./liveSource";

const NOW = istAt("2026-10-14", "11:00");
const iso = (ms: number) => new Date(ms).toISOString();

function yahooIndex(index: "NIFTY" | "SENSEX", price: number, prevClose: number, asOfMs: number): LiveIndex {
  return {
    index,
    label: index === "NIFTY" ? "NIFTY 50" : "SENSEX",
    symbol: index === "NIFTY" ? "^NSEI" : "^BSESN",
    price,
    prevClose,
    prevCloseSource: "daily",
    change: Math.round((price - prevClose) * 100) / 100,
    changePct: 0,
    open: prevClose,
    high: price + 10,
    low: prevClose - 10,
    vwap: price - 5,
    openingRange: { high: price + 5, low: price - 20 },
    session: "2026-10-14",
    asOf: new Date(asOfMs).toISOString(),
    bars: [{ t: asOfMs - 60_000, o: price, h: price, l: price, c: price }],
    stale: false,
    fetchedAt: iso(NOW),
  };
}

/** Yahoo as it is in practice: NIFTY a minute behind, SENSEX 15 minutes behind. */
function yahoo(): LiveFeedResult {
  const feed: LiveIndicesFeed = {
    indices: [yahooIndex("NIFTY", 22600, 22500, NOW - 60_000), yahooIndex("SENSEX", 72500, 72300, NOW - 15 * 60_000)],
    vix: { price: 14.1, prevClose: 14.4, prevCloseSource: "daily", change: -0.3, changePct: -2.083, asOf: iso(NOW - 60_000), stale: false, fetchedAt: iso(NOW) },
    marketPhase: "OPEN",
    source: LIVE_SOURCE,
    generatedAt: iso(NOW),
    fetchedAt: iso(NOW),
    stale: false,
    missing: [],
    holidayName: null,
    nextOpenAt: "2026-10-15T09:15:00+05:30",
  };
  return { ok: true, feed };
}

function broker(fetchedAtMs: number, keys: LiveIndexLevelsView["levels"][number]["key"][] = ["NIFTY", "SENSEX", "INDIAVIX", "BANKNIFTY"]): BrokerResult {
  const all: LiveIndexLevelsView["levels"] = [
    { key: "NIFTY", price: 22612.456, open: 22510, high: 22630, low: 22490, prevClose: 22500, change: 112.46, changePct: 0.5 },
    { key: "SENSEX", price: 72555.5, open: 72310, high: 72600, low: 72250, prevClose: 72300, change: 255.5, changePct: 0.35 },
    { key: "INDIAVIX", price: 13.9825, open: 14.3, high: 14.5, low: 13.9, prevClose: 14.4, change: -0.4175, changePct: -2.9 },
    { key: "BANKNIFTY", price: 49800, open: 49700, high: 49900, low: 49650, prevClose: 49690, change: 110, changePct: 0.22 },
  ];
  return { ok: true, view: { fetchedAt: iso(fetchedAtMs), source: "upstox", levels: all.filter((l) => keys.includes(l.key)), error: null } };
}

const live = (feed: LiveIndicesFeed) => ({ data: feed, freshness: "live" as const, ageMs: 1000, error: null });

function ok(r: LiveFeedResult): LiveIndicesFeed {
  if (!r.ok) throw new Error(r.error);
  return r.feed;
}

describe("mergeBrokerLevels", () => {
  it("broker wins: price, previous close, change and day levels from Upstox, its read time as the quote time; Yahoo's bars stay", () => {
    const f = ok(mergeBrokerLevels(yahoo(), broker(NOW - 2000), { nowMs: NOW }));
    expect(f.source).toBe(BROKER_SOURCE);
    expect(f.broker).toEqual({ status: "live", fetchedAt: iso(NOW - 2000), error: null });
    const [n, s] = f.indices;
    expect(n).toMatchObject({ index: "NIFTY", price: 22612.46, prevClose: 22500, prevCloseSource: "broker", change: 112.46, changePct: 0.5, open: 22510, high: 22630, low: 22490, feed: "upstox", source: BROKER_SOURCE, stale: false });
    expect(n.asOf).toBe("2026-10-14T10:59:58+05:30");
    expect(n.fetchedAt).toBe(iso(NOW - 2000));
    expect(n.bars).toHaveLength(1);
    expect(n.vwap).toBe(22595);
    expect(s).toMatchObject({ index: "SENSEX", price: 72555.5, change: 255.5, feed: "upstox" });
    expect(f.vix).toMatchObject({ price: 13.9825, prevClose: 14.4, change: -0.4175, feed: "upstox" });
    expect(f.missing).toEqual([]);
    expect(f.stale).toBe(false);
    expect(f.marketPhase).toBe("OPEN");
  });

  it("SENSEX no longer pauses for a missing trade while the broker feed is live", () => {
    const pure = ok(yahoo());
    expect(feedInput(live(pure), "SENSEX", false).tradeLagMs).toBe(15 * 60_000);
    const merged = ok(mergeBrokerLevels(yahoo(), broker(NOW - 2000), { nowMs: NOW }));
    const input = feedInput(live(merged), "SENSEX", false);
    expect(input.tradeLagMs).toBeNull();
    expect(input.sourceName).toBe("Upstox");
  });

  it("falls back per index: an index the broker did not send stays Yahoo's", () => {
    const f = ok(mergeBrokerLevels(yahoo(), broker(NOW - 2000, ["NIFTY"]), { nowMs: NOW }));
    expect(f.indices.map((i) => [i.index, i.feed, i.price])).toEqual([
      ["NIFTY", "upstox", 22612.46],
      ["SENSEX", "yahoo", 72500],
    ]);
    expect(f.vix).toMatchObject({ price: 14.1, feed: "yahoo" });
    expect(f.source).toBe(`${BROKER_SOURCE} · SENSEX: ${LIVE_SOURCE}`);
    // That index keeps Yahoo's trade time, so the lag check still applies to it.
    expect(feedInput(live(f), "SENSEX", false).tradeLagMs).toBe(15 * 60_000);
    expect(feedInput(live(f), "NIFTY", false).tradeLagMs).toBeNull();
  });

  it("a level without a price, or with the broker's previous close missing, falls back sensibly", () => {
    const b = broker(NOW - 2000);
    if (!b.ok) throw new Error();
    b.view.levels[0] = { ...b.view.levels[0], prevClose: null, change: null, changePct: null };
    b.view.levels[1] = { ...b.view.levels[1], price: 0 };
    const f = ok(mergeBrokerLevels(yahoo(), b, { nowMs: NOW }));
    expect(f.indices[0]).toMatchObject({ feed: "upstox", prevClose: 22500, prevCloseSource: "daily", change: 112.46 });
    expect(f.indices[1]).toMatchObject({ feed: "yahoo", price: 72500 });
  });

  it("broker error -> pure Yahoo (prices, times and source unchanged)", () => {
    const y = ok(yahoo());
    for (const b of [{ ok: false, error: "the engine did not answer in time" } as BrokerResult, { ok: true, view: { fetchedAt: iso(NOW), source: "upstox", levels: [], error: "UPSTOX_TOKEN missing" } } as BrokerResult]) {
      const f = ok(mergeBrokerLevels(yahoo(), b, { nowMs: NOW }));
      expect(f.source).toBe(LIVE_SOURCE);
      expect(f.indices.map((i) => [i.price, i.asOf, i.feed])).toEqual(y.indices.map((i) => [i.price, i.asOf, "yahoo"]));
      expect(f.vix?.price).toBe(14.1);
      expect(f.broker?.status).toBe("error");
    }
    expect(ok(mergeBrokerLevels(yahoo(), { ok: false, error: "x" }, { nowMs: NOW })).broker?.error).toBe("x");
    // Not asked at all: no broker status.
    expect(ok(mergeBrokerLevels(yahoo(), null, { nowMs: NOW })).broker).toBeUndefined();
  });

  it(`broker levels older than ${BROKER_MAX_AGE_MS / 1000} s -> Yahoo, so SENSEX pauses again when the broker feed goes stale`, () => {
    const fresh = ok(mergeBrokerLevels(yahoo(), broker(NOW - BROKER_MAX_AGE_MS), { nowMs: NOW }));
    expect(fresh.indices.every((i) => i.feed === "upstox")).toBe(true);
    const f = ok(mergeBrokerLevels(yahoo(), broker(NOW - BROKER_MAX_AGE_MS - 1000), { nowMs: NOW }));
    expect(f.indices.every((i) => i.feed === "yahoo")).toBe(true);
    expect(f.source).toBe(LIVE_SOURCE);
    expect(f.broker).toMatchObject({ status: "stale", fetchedAt: iso(NOW - BROKER_MAX_AGE_MS - 1000) });
    const lag = feedInput(live(f), "SENSEX", false).tradeLagMs;
    expect(lag).not.toBeNull();
    expect(lag!).toBeGreaterThan(LAGGING_TRADE_MS);
  });

  it("Yahoo down: broker levels alone make the payload (no bars); neither -> Yahoo's error", () => {
    const down: LiveFeedResult = { ok: false, error: "Yahoo Finance did not return NIFTY 50 or SENSEX prices: it is limiting requests." };
    const f = ok(mergeBrokerLevels(down, broker(NOW - 1000), { nowMs: NOW }));
    expect(f.indices.map((i) => [i.index, i.price, i.bars.length, i.session, i.vwap])).toEqual([
      ["NIFTY", 22612.46, 0, "2026-10-14", null],
      ["SENSEX", 72555.5, 0, "2026-10-14", null],
    ]);
    expect(f).toMatchObject({ marketPhase: "OPEN", missing: [], stale: false, source: BROKER_SOURCE, generatedAt: iso(NOW) });
    expect(mergeBrokerLevels(down, { ok: false, error: "no token" }, { nowMs: NOW })).toEqual(down);
  });

  it("while the market is open, Yahoo bars from an earlier session are not joined to today's broker price", () => {
    const y = yahoo();
    if (!y.ok) throw new Error();
    y.feed.indices = y.feed.indices.map((i) => ({ ...i, session: "2026-10-13" }));
    const f = ok(mergeBrokerLevels(y, broker(NOW - 1000), { nowMs: NOW }));
    expect(f.indices[0]).toMatchObject({ session: "2026-10-14", bars: [], vwap: null, openingRange: null, open: 22510 });
  });
});

describe("getBrokerLevels", () => {
  beforeEach(() => __resetBrokerLevelsForTests());
  const view = (fetchedAt: string): LiveIndexLevelsView => ({ fetchedAt, source: "upstox", levels: [], error: null });

  it("shares one engine call per TTL and joins a running one", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return view(`call ${calls}`);
    };
    const [a, b] = await Promise.all([getBrokerLevels(load, { nowMs: 1000 }), getBrokerLevels(load, { nowMs: 1001 })]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    await getBrokerLevels(load, { nowMs: 1000 + BROKER_TTL_MS - 1 });
    expect(calls).toBe(1);
    const c = await getBrokerLevels(load, { nowMs: 1000 + BROKER_TTL_MS });
    expect(calls).toBe(2);
    expect(c).toEqual({ ok: true, view: view("call 2") });
  });

  it("a failure or a slow engine reads as an error", async () => {
    expect(await getBrokerLevels(async () => Promise.reject(new Error("RPC down")), { nowMs: 1 })).toEqual({ ok: false, error: "RPC down" });
    __resetBrokerLevelsForTests();
    const slow = await getBrokerLevels(() => new Promise<LiveIndexLevelsView>(() => {}), { nowMs: 1, timeoutMs: 20 });
    expect(slow).toEqual({ ok: false, error: "the engine did not answer in time" });
  });
});

describe("mock engine getLiveIndices", () => {
  it("serves NIFTY, SENSEX, BANKNIFTY and India VIX from its own spot, read now", async () => {
    const v = await getMockEngine({ adminToken: null, fail: false }).getLiveIndices();
    expect(v.source).toBe("mock");
    expect(v.error).toBeNull();
    expect(Math.abs(Date.now() - Date.parse(v.fetchedAt))).toBeLessThan(5000);
    expect(v.levels.map((l) => l.key)).toEqual(["NIFTY", "SENSEX", "BANKNIFTY", "INDIAVIX"]);
    for (const l of v.levels) {
      expect(l.price).toBeGreaterThan(0);
      expect(l.prevClose).toBeGreaterThan(0);
      expect(l.change).toBeCloseTo(l.price - l.prevClose!, 2);
      expect(l.low!).toBeLessThanOrEqual(l.price);
      expect(l.high!).toBeGreaterThanOrEqual(l.price);
    }
    const nifty = v.levels[0];
    expect(nifty.price).toBeGreaterThan(20_000);
    expect(nifty.price).toBeLessThan(25_000);
    const vix = v.levels[3];
    expect(vix.price).toBeGreaterThan(5);
    expect(vix.price).toBeLessThan(40);
    // Used by the live route: the mock's levels win over Yahoo, labelled as the mock.
    const f = ok(mergeBrokerLevels(yahoo(), { ok: true, view: v }, { nowMs: Date.parse(v.fetchedAt) }));
    expect(f.indices.map((i) => i.feed)).toEqual(["mock", "mock"]);
    expect(f.source).toMatch(/Mock engine/);
  });
});
