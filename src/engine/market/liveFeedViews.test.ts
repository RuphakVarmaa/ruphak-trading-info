import { describe, expect, it } from "vitest";
import { liveIndicesWithFeed, optionChainWithFeed, type SnapshotFn } from "./liveFeedViews";
import { NIFTY_CHAIN_SAMPLE } from "./upstoxChain.fixture";
import { FEED_FRAMES_B64 } from "./upstoxFeed.fixture";
import { TickStore, type FeedSnapshot } from "./upstoxFeed";
import { UpstoxLive } from "./upstoxLive";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const QUOTES = {
  status: "success",
  data: {
    "NSE_INDEX:Nifty 50": { last_price: 22600, net_change: -121.95, ohlc: { open: 22715.75, high: 22757.95, low: 22558.95 }, instrument_token: "NSE_INDEX|Nifty 50" },
    "BSE_INDEX:SENSEX": { last_price: 72700, net_change: -333.78, instrument_token: "BSE_INDEX|SENSEX" },
  },
};
const CONTRACTS = { status: "success", data: [{ expiry: "2026-10-19", lot_size: 65 }] };

function harness(start: number) {
  const clock = { t: start };
  const calls: string[] = [];
  const market = new UpstoxLive({
    token: "tok",
    now: () => clock.t,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/v2/option/contract") return Response.json(CONTRACTS);
      if (path === "/v2/option/chain") return Response.json(NIFTY_CHAIN_SAMPLE);
      return Response.json(QUOTES);
    },
  });
  const count = (p: string) => calls.filter((c) => c === p).length;
  return { market, calls, clock, count };
}

/** The real captured frames, received at `receivedAt`, as MarketFeedDO.ticks() returns them. */
function snapshotOf(receivedAt: number, connected: boolean, lastMessageAt: number | null): SnapshotFn {
  const store = new TickStore();
  for (const f of FEED_FRAMES_B64) store.applyFrame(b64(f), receivedAt);
  return async (keys) => ({ ticks: store.list(keys), connected, lastMessageAt, at: receivedAt }) satisfies FeedSnapshot;
}

describe("getLiveIndices with the market feed", () => {
  const now = ist("2026-10-15T10:00:00");

  it("builds the view from fresh feed ticks without a REST call", async () => {
    const h = harness(now);
    const v = await liveIndicesWithFeed(h.market, snapshotOf(now - 1200, true, now - 300), now);
    expect(v.feed).toBe("websocket");
    expect(v.error).toBeNull();
    expect(v.levels.map((l) => l.key)).toEqual(["NIFTY", "SENSEX", "BANKNIFTY", "INDIAVIX"]);
    expect(v.levels[0]).toEqual({ key: "NIFTY", price: 22622.7, open: 22715.75, high: 22757.95, low: 22558.95, prevClose: 22721.95, change: -99.25, changePct: -0.44 });
    expect(h.calls).toEqual([]);
  });

  it("falls back to REST when the ticks are stale (e.g. after the close)", async () => {
    const h = harness(now);
    const v = await liveIndicesWithFeed(h.market, snapshotOf(now - 60_000, false, now - 60_000), now);
    expect(v.feed).toBe("rest");
    expect(v.levels[0]).toMatchObject({ key: "NIFTY", price: 22600 });
    expect(h.calls).toEqual(["/v2/market-quote/quotes"]);
  });

  it("falls back to REST when the feed has no ticks, answers null or is unreachable", async () => {
    const snaps: SnapshotFn[] = [
      async () => ({ ticks: [], connected: true, lastMessageAt: now, at: now }),
      async () => null,
      async () => {
        throw new Error("DO down");
      },
    ];
    for (const snap of snaps) {
      const h = harness(now);
      const v = await liveIndicesWithFeed(h.market, snap, now);
      expect(v.feed).toBe("rest");
      expect(v.levels).toHaveLength(2);
      expect(h.calls).toEqual(["/v2/market-quote/quotes"]);
    }
  });
});

describe("getOptionChain with the market feed", () => {
  const now = ist("2026-10-15T10:00:00");

  it("overlays fresh option ticks on the REST chain and refreshes REST every 30 s, not 5 s", async () => {
    const h = harness(now);
    const v = await optionChainWithFeed(h.market, snapshotOf(now - 500, true, now - 100), "NIFTY", undefined, now);
    expect(v.feed).toBe("websocket");
    expect(v.spot).toBe(22622.7);
    const ce = v.rows.find((r) => r.strike === 22650)!.ce!;
    expect(ce).toMatchObject({ instrumentKey: "NSE_FO|47141", ltp: 119.85, close: 243.15, bid: 119.85, ask: 120.8, oi: 3055000, iv: 12.23 });
    h.clock.t += 10_000;
    await optionChainWithFeed(h.market, snapshotOf(h.clock.t - 500, true, h.clock.t - 100), "NIFTY", undefined, h.clock.t);
    expect(h.count("/v2/option/chain")).toBe(1);
    h.clock.t += 21_000;
    await optionChainWithFeed(h.market, snapshotOf(h.clock.t - 500, true, h.clock.t - 100), "NIFTY", undefined, h.clock.t);
    expect(h.count("/v2/option/chain")).toBe(2);
  });

  it("uses REST alone with the 5 s TTL when the feed is stale", async () => {
    const h = harness(now);
    const stale = snapshotOf(now - 60_000, false, null);
    const v = await optionChainWithFeed(h.market, stale, "NIFTY", undefined, now);
    expect(v.feed).toBe("rest");
    expect(v.rows.find((r) => r.strike === 22650)!.ce!.ltp).toBe(119.85);
    h.clock.t += 6_000;
    await optionChainWithFeed(h.market, stale, "NIFTY", undefined, h.clock.t);
    expect(h.count("/v2/option/chain")).toBe(2);
  });
});
