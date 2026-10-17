import { describe, expect, it } from "vitest";
import { buildOptionChainView, parseUpstoxChain } from "./upstoxChain";
import { NIFTY_CHAIN_SAMPLE } from "./upstoxChain.fixture";
import { FEED_FRAMES_B64 } from "./upstoxFeed.fixture";
import {
  TickStore,
  feedBackoffMs,
  feedRequestFrame,
  freshTicks,
  inFeedWindow,
  indexLevelsFromTicks,
  needsRecentre,
  nextFeedWindowStart,
  optionFeedMode,
  overlayChainTicks,
  redactFeedError,
  selectStrikes,
  strikeKeysFromRows,
  type FeedSnapshot,
  type FeedTick,
  type StrikeKeys,
} from "./upstoxFeed";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function realStore(at: number): TickStore {
  const store = new TickStore();
  for (const f of FEED_FRAMES_B64) store.applyFrame(b64(f), at);
  return store;
}

describe("TickStore", () => {
  it("holds the latest tick per key from real frames, IV in percent, and the market status", () => {
    const at = ist("2026-10-14T19:59:08");
    const store = realStore(at);
    expect(store.size).toBe(10);
    expect(store.frames).toBe(3);
    expect(store.marketStatus.NSE_FO).toBe("NORMAL_CLOSE");
    expect(store.get("NSE_INDEX|Nifty 50")).toMatchObject({ ltp: 22622.7, cp: 22721.95, open: 22715.75, high: 22757.95, low: 22558.95, receivedAt: at, bid: null, oi: null });
    expect(store.get("NSE_FO|47141")).toMatchObject({ ltp: 119.85, cp: 243.15, bid: 119.85, ask: 120.8, bidQty: 520, askQty: 845, oi: 3055000, volume: 109067660, iv: 12.23, delta: 0.4827 });
  });

  it("merges a later ltpc-only frame over the earlier full values", () => {
    const store = realStore(1000);
    store.apply({ type: 1, currentTs: 0, marketStatus: null, feeds: { "NSE_FO|47141": { kind: "ltpc", ltpc: { ltp: 121, ltt: 5, ltq: 1, cp: 243.15 }, depth: null, greeks: null, ohlc: [], vtt: null, oi: null, iv: null, atp: null, requestMode: 0 } } }, 2000);
    expect(store.get("NSE_FO|47141")).toMatchObject({ ltp: 121, ltt: 5, bid: 119.85, oi: 3055000, iv: 12.23, receivedAt: 2000 });
    expect(store.list(["NSE_FO|47141", "nope"]).map((t) => t.key)).toEqual(["NSE_FO|47141"]);
    store.retain(new Set(["NSE_FO|47141"]));
    expect(store.size).toBe(1);
  });
});

describe("feed window (IST)", () => {
  it("is open 09:10-15:35 IST on weekdays only", () => {
    expect(inFeedWindow(ist("2026-10-14T09:09:59"))).toBe(false);
    expect(inFeedWindow(ist("2026-10-14T09:10:00"))).toBe(true);
    expect(inFeedWindow(ist("2026-10-14T15:34:59"))).toBe(true);
    expect(inFeedWindow(ist("2026-10-14T15:35:00"))).toBe(false);
    expect(inFeedWindow(ist("2026-10-17T11:00:00"))).toBe(false); // Saturday
    expect(inFeedWindow(ist("2026-10-18T11:00:00"))).toBe(false); // Sunday
  });

  it("finds the next window start, skipping the weekend", () => {
    expect(nextFeedWindowStart(ist("2026-10-14T08:00:00"))).toBe(ist("2026-10-14T09:10:00"));
    expect(nextFeedWindowStart(ist("2026-10-14T20:00:00"))).toBe(ist("2026-10-15T09:10:00"));
    expect(nextFeedWindowStart(ist("2026-10-16T16:00:00"))).toBe(ist("2026-10-19T09:10:00")); // Friday evening -> Monday
    const inside = ist("2026-10-14T10:00:00");
    expect(nextFeedWindowStart(inside)).toBe(inside);
  });

  it("backs off 1 s doubling to 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(feedBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe("strike selection and re-centring", () => {
  const strikes: StrikeKeys[] = Array.from({ length: 81 }, (_, i) => ({ strike: 21500 + i * 50, ce: `CE${i}`, pe: `PE${i}` }));

  it("selects ATM +/- 15 strikes (62 keys) and its step", () => {
    const sel = selectStrikes(strikes, 22622.7)!;
    expect(sel.centre).toBe(22600);
    expect(sel.step).toBe(50);
    expect(sel.keys).toHaveLength(62);
    expect(sel.keys[0]).toBe("CE7");
    expect(sel.keys.at(-1)).toBe("PE37");
    expect(optionFeedMode(124)).toBe("option_greeks");
    expect(optionFeedMode(4000)).toBe("ltpc");
  });

  it("clips at the chain's edge and needs a spot", () => {
    expect(selectStrikes(strikes, 21000)!.keys).toHaveLength(32);
    expect(selectStrikes(strikes, 0)).toBeNull();
    expect(selectStrikes([], 22600)).toBeNull();
  });

  it("re-centres only when the spot moves more than 3 strikes", () => {
    const sel = selectStrikes(strikes, 22600)!;
    expect(needsRecentre(sel, 22750)).toBe(false);
    expect(needsRecentre(sel, 22751)).toBe(true);
    expect(needsRecentre(sel, 22449)).toBe(true);
    expect(needsRecentre(null, 22600)).toBe(true);
    expect(needsRecentre(sel, 0)).toBe(false);
  });

  it("reads strike keys from a parsed chain", () => {
    const keys = strikeKeysFromRows(parseUpstoxChain(NIFTY_CHAIN_SAMPLE).rows);
    expect(keys.map((k) => k.strike)).toEqual([22550, 22600, 22650, 22700]);
    expect(keys[1]).toEqual({ strike: 22600, ce: "NSE_FO|47139", pe: "NSE_FO|47140" });
  });

  it("builds the binary subscribe request", () => {
    const frame = feedRequestFrame("g1", "sub", "option_greeks", ["NSE_FO|1"]);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(frame))).toEqual({ guid: "g1", method: "sub", data: { mode: "option_greeks", instrumentKeys: ["NSE_FO|1"] } });
  });
});

describe("redactFeedError", () => {
  it("removes the authorized URL, bearer values and the token", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
    const msg = redactFeedError(new Error(`connect wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=abc&code=secret123 failed; Bearer ${token}; raw ${token}`), [token]);
    expect(msg).not.toContain("secret123");
    expect(msg).not.toContain("requestId");
    expect(msg).not.toContain(token);
    expect(msg).toContain("wss://wsfeeder-api.upstox.com/[redacted]");
    expect(redactFeedError("GET https://api.upstox.com/v3/feed/market-data-feed/authorize?x=1 HTTP 500")).toContain("https://api.upstox.com/v3/feed/market-data-feed/authorize HTTP 500");
  });
});

describe("views from ticks", () => {
  const now = ist("2026-10-15T10:00:05");
  const tick = (key: string, over: Partial<FeedTick> = {}): FeedTick => ({
    key,
    ltp: 100,
    ltt: null,
    cp: 90,
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
    receivedAt: now - 1000,
    ...over,
  });
  const snap = (ticks: FeedTick[], connected = true, lastMessageAt: number | null = now - 500): FeedSnapshot => ({ ticks, connected, lastMessageAt, at: now });

  it("keeps ticks younger than 3 s, or any tick while the connected stream is that fresh", () => {
    const old = tick("A", { receivedAt: now - 60_000 });
    expect([...freshTicks(snap([old, tick("B")]), now).keys()]).toEqual(["A", "B"]);
    expect([...freshTicks(snap([old, tick("B")], false), now).keys()]).toEqual(["B"]);
    expect([...freshTicks(snap([old], true, now - 10_000), now).keys()]).toEqual([]);
    expect(freshTicks(null, now).size).toBe(0);
  });

  it("builds index levels from ticks (change = ltp - cp), OHLC from REST when the tick lacks it", () => {
    const fresh = freshTicks(
      snap([
        tick("NSE_INDEX|Nifty 50", { ltp: 22700, cp: 22600, open: 22610, high: 22720, low: 22590 }),
        tick("BSE_INDEX|SENSEX", { ltp: 73000, cp: 72800 }),
      ]),
      now,
    );
    const rest = [
      { key: "SENSEX" as const, price: 72900, open: 72850, high: 73050, low: 72700, prevClose: 72800, change: 100, changePct: 0.14 },
      { key: "INDIAVIX" as const, price: 14, open: 14, high: 15, low: 13, prevClose: 14.2, change: -0.2, changePct: -1.41 },
    ];
    const levels = indexLevelsFromTicks(fresh, rest)!;
    expect(levels.map((l) => l.key)).toEqual(["NIFTY", "SENSEX", "INDIAVIX"]);
    expect(levels[0]).toEqual({ key: "NIFTY", price: 22700, open: 22610, high: 22720, low: 22590, prevClose: 22600, change: 100, changePct: 0.44 });
    expect(levels[1]).toMatchObject({ price: 73000, open: 72850, high: 73050, low: 72700, change: 200 });
    expect(levels[2]).toBe(rest[1]);
    expect(indexLevelsFromTicks(freshTicks(snap([tick("NSE_INDEX|Nifty 50")]), now), null)).toBeNull();
  });

  it("lays fresh option ticks over the REST chain and moves the spot", () => {
    const chain = parseUpstoxChain(NIFTY_CHAIN_SAMPLE);
    const view = buildOptionChainView({ index: "NIFTY", expiry: "2026-10-19", meta: { expiries: ["2026-10-19"], lotSize: 65 }, chain, fetchedMs: now - 20_000 });
    const fresh = freshTicks(
      snap([
        tick("NSE_INDEX|Nifty 50", { ltp: 22702, cp: 22721.95 }),
        tick("NSE_FO|47143", { ltp: 110, cp: 207.2, bid: 109.5, ask: 110.5, bidQty: 65, askQty: 130, oi: 9_200_000, iv: 12.5, receivedAt: now - 200 }),
      ]),
      now,
    );
    const out = overlayChainTicks(view, fresh, "NSE_INDEX|Nifty 50");
    expect(out.feed).toBe("websocket");
    expect(out.spot).toBe(22702);
    expect(out.atmStrike).toBe(22700);
    const row = out.rows.find((r) => r.strike === 22700)!;
    expect(row.ce).toMatchObject({ ltp: 110, close: 207.2, change: -97.2, bid: 109.5, ask: 110.5, oi: 9_200_000, oiChange: 9_200_000 - 3_922_620, iv: 12.5, delta: 0.4219 });
    expect(row.pe).toBe(view.rows.find((r) => r.strike === 22700)!.pe);
    expect(out.pcr).not.toBe(view.pcr);
    expect(overlayChainTicks(view, new Map(), "NSE_INDEX|Nifty 50")).toMatchObject({ feed: "rest", spot: view.spot });
  });
});
