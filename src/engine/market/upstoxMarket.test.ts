import { describe, expect, it } from "vitest";
import { FallbackOptionQuotes } from "../broker/groww/optionQuotes";
import { MINUTE_MS, istAt } from "../clock";
import type { MarketDataSource, OptionQuoteSource } from "../ports";
import type { Candle, MarketSnapshot, OptionContract, Quote } from "../types";
import { UpstoxOptionQuotes, UpstoxOverlayMarketData, aggregate1mTo5m, parseUpstoxCandles, type UpstoxMarketClient } from "./upstoxMarket";
import { UpstoxError, UpstoxQuotes } from "./upstoxQuotes";

const D = "2026-10-14";
const at = (hhmm: string) => istAt(D, hhmm);
const iso = (ms: number) => new Date(ms + 330 * MINUTE_MS).toISOString().replace("Z", "+05:30").replace(".000", "");

/** Upstox candle rows, newest first, for 1-minute bars opening at `from` (o = 100 + i, h = o + 1, l = o - 1, c = o + 0.5). */
function rows(from: number, count: number, base = 100) {
  const out: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const o = base + i;
    out.push([iso(from + i * MINUTE_MS), o, o + 1, o - 1, o + 0.5, 0, 0]);
  }
  return out.reverse();
}

const bar = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 0 });

describe("parseUpstoxCandles / aggregate1mTo5m", () => {
  it("reads newest-first rows oldest first and skips malformed rows", () => {
    const payload = { status: "success", data: { candles: [...rows(at("09:15"), 3), ["bad", 1, 2, 3, 4], [iso(at("09:18")), null, 1, 1, 1]] } };
    const c = parseUpstoxCandles(payload);
    expect(c.map((x) => x.t)).toEqual([at("09:15"), at("09:16"), at("09:17")]);
    expect(c[0]).toEqual({ t: at("09:15"), o: 100, h: 101, l: 99, c: 100.5, v: 0 });
    expect(parseUpstoxCandles({ status: "success", data: {} })).toEqual([]);
  });

  it("buckets 1-minute bars at 09:15-aligned 5-minute bars, keeping the forming bar and dropping out-of-session bars", () => {
    const ones = parseUpstoxCandles({ data: { candles: [...rows(at("09:14"), 13), ...rows(at("15:29"), 2, 500)] } });
    const fives = aggregate1mTo5m(ones);
    expect(fives.map((x) => x.t)).toEqual([at("09:15"), at("09:20"), at("09:25"), at("15:25")]);
    // 09:15..09:19 are rows 1..5 (o 101..105).
    expect(fives[0]).toMatchObject({ o: 101, h: 106, l: 100, c: 105.5 });
    // Forming bar: 09:25 and 09:26 only.
    expect(fives[2]).toMatchObject({ o: 111, h: 113, l: 110, c: 112.5 });
    // 15:29 is in; the 15:30 closing tick is not.
    expect(fives[3]).toMatchObject({ o: 500, c: 500.5 });
  });
});

interface FakeClient extends UpstoxMarketClient {
  calls: string[];
  fail: boolean;
}

function fakeClient(o: { candles: Record<string, unknown[][]>; quotes?: Record<string, Record<string, unknown>> }): FakeClient {
  const c: FakeClient = {
    calls: [],
    fail: false,
    async get(path: string) {
      c.calls.push(path);
      if (c.fail) throw new UpstoxError("Upstox GET: HTTP 503", "transient", 503);
      const key = decodeURIComponent(path.split("/")[4]);
      return { status: "success", data: { candles: o.candles[key] ?? [] } };
    },
    async quotesByKey(keys: readonly string[]) {
      c.calls.push(`quotes:${keys.join(",")}`);
      if (c.fail) throw new UpstoxError("Upstox GET: HTTP 503", "transient", 503);
      const m = new Map<string, Record<string, unknown>>();
      for (const k of keys) if (o.quotes?.[k]) m.set(k, o.quotes[k]);
      return m;
    },
  };
  return c;
}

function yahooSnapshot(t: number): MarketSnapshot {
  const yesterday = istAt("2026-10-13", "15:25");
  return {
    t,
    // Yahoo's SENSEX is ~15 minutes late; its 15:30 tick and a delayed bar must not survive the overlay.
    candles: {
      "^NSEI": [bar(yesterday, 22_500), bar(at("09:15"), 22_550), bar(at("09:20"), 22_560)],
      "^BSESN": [bar(yesterday, 81_000), bar(at("09:15"), 81_100)],
      "^INDIAVIX": [bar(yesterday, 11), bar(at("09:15"), 11.2)],
      "ES=F": [bar(at("09:15"), 6_000)],
    },
    daily: {},
    ltp: { NIFTY: 22_560, SENSEX: 81_100 },
    dataAgeSec: 60,
    dataAgeSecByIndex: { NIFTY: 60, SENSEX: 900 },
    asOfMs: { "^NSEI": t - 60_000, "^BSESN": t - 900_000 },
  };
}

const innerOf = (calls: { n: number }): MarketDataSource => ({
  async snapshot(t) {
    calls.n++;
    return yahooSnapshot(t);
  },
});

const CANDLES = {
  "NSE_INDEX|Nifty 50": rows(at("09:15"), 13, 22_540),
  "BSE_INDEX|SENSEX": rows(at("09:15"), 13, 81_150),
  "NSE_INDEX|India VIX": rows(at("09:15"), 13, 12),
};

describe("UpstoxOverlayMarketData", () => {
  const now0 = at("09:28") + 10_000;

  it("replaces today's index bars, spot and trade time with Upstox's and leaves everything else as Yahoo had it", async () => {
    let now = now0;
    const client = fakeClient({
      candles: CANDLES,
      quotes: {
        "NSE_INDEX|Nifty 50": { last_price: 22_555.5, last_trade_time: String(now0 - 2_000) },
        "BSE_INDEX|SENSEX": { last_price: 81_170.25 },
      },
    });
    const src = new UpstoxOverlayMarketData(innerOf({ n: 0 }), client, { now: () => now });
    const snap = await src.snapshot(now);
    const sensex = snap.candles["^BSESN"];
    expect(sensex.map((c) => c.t)).toEqual([istAt("2026-10-13", "15:25"), at("09:15"), at("09:20"), at("09:25")]);
    expect(sensex[0].c).toBe(81_000);
    expect(sensex[3]).toMatchObject({ o: 81_160, c: 81_162.5 });
    expect(snap.candles["^INDIAVIX"].at(-1)?.t).toBe(at("09:25"));
    expect(snap.candles["ES=F"]).toEqual([bar(at("09:15"), 6_000)]);
    expect(snap.ltp).toEqual({ NIFTY: 22_555.5, SENSEX: 81_170.25 });
    // NIFTY: the quote's trade time; SENSEX: no trade time, so the fetch time.
    expect(snap.asOfMs?.["^NSEI"]).toBe(now0 - 2_000);
    expect(snap.asOfMs?.["^BSESN"]).toBe(now0);
    // Bars observed up to the 09:27 bar's close (09:28): 10 s old, not Yahoo's 15 minutes.
    expect(snap.dataAgeSecByIndex?.SENSEX).toBe(10);
    expect(snap.dataAgeSecByIndex?.NIFTY).toBe(10);
    expect(snap.dataAgeSec).toBe(10);
    // One quote request and three candle requests.
    expect(client.calls).toHaveLength(4);

    // A tick 10 s later is served from the caches.
    now += 10_000;
    await src.snapshot(now);
    expect(client.calls).toHaveLength(4);
    // 20 s on: the spot again; candles wait for their 60 s.
    now += 10_000;
    await src.snapshot(now);
    expect(client.calls).toHaveLength(5);
    now += 45_000;
    await src.snapshot(now);
    expect(client.calls).toHaveLength(9);
  });

  it("returns Yahoo's snapshot untouched when Upstox fails, warning once per failure streak", async () => {
    let now = now0;
    const client = fakeClient({ candles: CANDLES, quotes: { "NSE_INDEX|Nifty 50": { last_price: 22_555 } } });
    client.fail = true;
    const logs: string[] = [];
    const src = new UpstoxOverlayMarketData(innerOf({ n: 0 }), client, { now: () => now, log: (m) => logs.push(m) });
    const first = await src.snapshot(now);
    expect(first).toEqual(yahooSnapshot(now));
    now += 61_000;
    expect(await src.snapshot(now)).toEqual(yahooSnapshot(now));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("failed");
    client.fail = false;
    now += 61_000;
    const back = await src.snapshot(now);
    expect(back.ltp.NIFTY).toBe(22_555);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("recovered");
  });

  it("keeps Yahoo's bars for a symbol Upstox has no candles for, and ignores bars after the snapshot time", async () => {
    const client = fakeClient({ candles: { "BSE_INDEX|SENSEX": CANDLES["BSE_INDEX|SENSEX"] } });
    const src = new UpstoxOverlayMarketData(innerOf({ n: 0 }), client, { now: () => now0 });
    const snap = await src.snapshot(at("09:21"));
    expect(snap.candles["^NSEI"]).toEqual(yahooSnapshot(at("09:21")).candles["^NSEI"]);
    expect(snap.candles["^BSESN"].at(-1)?.t).toBe(at("09:20"));
    expect(snap.ltp.SENSEX).toBe(snap.candles["^BSESN"].at(-1)?.c);
    expect(snap.ltp.NIFTY).toBe(22_560);
  });

  it("stays within its request budget", async () => {
    let now = now0;
    const client = fakeClient({ candles: CANDLES });
    const src = new UpstoxOverlayMarketData(innerOf({ n: 0 }), client, { now: () => now, ltpTtlMs: 0, candleTtlMs: 0 });
    for (let i = 0; i < 12; i++) {
      await src.snapshot(now);
      now += 5_000;
    }
    expect(client.calls.length).toBeLessThanOrEqual(8);
  });
});

const contract = (sym: string, token: string): OptionContract => ({
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: sym,
  growwSymbol: "",
  exchangeToken: token,
  expiry: "2026-10-20",
  strike: 22_500,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
});

const optionEntry = (token: string, bid: number, ask: number) => ({
  instrument_token: `NSE_FO|${token}`,
  last_price: (bid + ask) / 2,
  depth: { buy: [{ quantity: 650, price: bid, orders: 3 }], sell: [{ quantity: 650, price: ask, orders: 2 }] },
});

describe("UpstoxOptionQuotes", () => {
  const A = contract("NIFTY26O2022500CE", "111");
  const B = contract("NIFTY26O2022500PE", "222");
  const C = contract("NIFTY26O2022600CE", "333");

  function client(entries: Record<string, ReturnType<typeof optionEntry>>, fail = { on: false }): FakeClient & { keys: string[][] } {
    const c = fakeClient({ candles: {} }) as FakeClient & { keys: string[][] };
    c.keys = [];
    c.quotesByKey = async (keys) => {
      c.keys.push([...keys]);
      if (fail.on) throw new UpstoxError("Upstox GET /v2/market-quote/quotes: HTTP 503", "transient", 503);
      const m = new Map<string, Record<string, unknown>>();
      for (const k of keys) if (entries[k]) m.set(k, entries[k]);
      return m;
    };
    return c;
  }

  const ENTRIES = { "NSE_FO|111": optionEntry("111", 100, 101), "NSE_FO|222": optionEntry("222", 90, 91), "NSE_FO|333": optionEntry("333", 50, 51) };
  const ctx = { t: 0, spot: 22_500, vix: 12 };

  it("serves concurrent asks with one request, tags quotes upstox and caches them for 5 s", async () => {
    let now = at("10:00");
    const c = client(ENTRIES);
    const q = new UpstoxOptionQuotes(c, { now: () => now });
    const [qa, qb, qc] = await Promise.all([q.quote(A), q.quote(B), q.quote(C)]);
    expect(c.keys).toHaveLength(1);
    expect(c.keys[0].sort()).toEqual(["NSE_FO|111", "NSE_FO|222", "NSE_FO|333"]);
    expect(qa).toMatchObject({ symbol: A.tradingSymbol, bid: 100, ask: 101, source: "upstox" });
    expect(qb.bid).toBe(90);
    expect(qc.ask).toBe(51);
    now += 4_000;
    await q.quote(A);
    expect(c.keys).toHaveLength(1);
    now += 2_000;
    await q.quote(A);
    expect(c.keys).toHaveLength(2);
  });

  it("refreshes every recently asked contract in one request, so later asks in the same tick hit the cache", async () => {
    let now = at("10:00");
    const c = client(ENTRIES);
    const q = new UpstoxOptionQuotes(c, { now: () => now });
    await q.quote(A);
    await q.quote(B);
    expect(c.keys).toHaveLength(2);
    // Next tick: main asks A, the followers ask B and A.
    now += 30_000;
    await q.quote(A);
    await q.quote(B);
    await q.quote(A);
    expect(c.keys).toHaveLength(3);
    expect(c.keys[2].sort()).toEqual(["NSE_FO|111", "NSE_FO|222"]);
  });

  it("throws for contracts Upstox does not return and for synthetic contracts, without a request for the latter", async () => {
    const c = client(ENTRIES);
    const q = new UpstoxOptionQuotes(c, { now: () => at("10:00") });
    await expect(q.quote(contract("X", "999"))).rejects.toMatchObject({ kind: "not_found" });
    const n = c.keys.length;
    await expect(q.quote(contract("Y", "SYN-Y"))).rejects.toMatchObject({ kind: "bad_request" });
    expect(c.keys).toHaveLength(n);
  });

  it("falls back to synthetic on failure, pauses after it, and respects its budget", async () => {
    let now = at("10:00");
    const fail = { on: true };
    const c = client(ENTRIES, fail);
    const q = new UpstoxOptionQuotes(c, { now: () => now, pauseAfterErrorMs: 30_000 });
    const synthetic: OptionQuoteSource = {
      kind: "synthetic",
      async quote(ct): Promise<Quote> {
        return { symbol: ct.tradingSymbol, t: now, ltp: 1, bid: 1, ask: 1.1, bidQty: 1, askQty: 1, source: "synthetic" };
      },
    };
    const errors: unknown[] = [];
    const fb = new FallbackOptionQuotes(q, synthetic, (e) => errors.push(e));
    expect(fb.kind).toBe("upstox");
    expect((await fb.quote(A, ctx)).source).toBe("synthetic");
    fail.on = false;
    now += 10_000;
    expect((await fb.quote(A, ctx)).source).toBe("synthetic");
    expect(c.keys).toHaveLength(1);
    now += 25_000;
    expect((await fb.quote(A, ctx)).source).toBe("upstox");
    expect(errors).toHaveLength(2);

    const capped = new UpstoxOptionQuotes(client(ENTRIES), { now: () => now, cacheMs: 1_000, maxRequestsPerMinute: 15 });
    let served = 0;
    for (let i = 0; i < 20; i++) {
      try {
        now += 1_000;
        await capped.quote(A);
        served++;
      } catch (err) {
        expect(err).toMatchObject({ kind: "rate_limited" });
        break;
      }
    }
    expect(served).toBe(15);
  });

  it("works through UpstoxQuotes over a fake fetch (encoded keys, bearer token)", async () => {
    const urls: string[] = [];
    let auth = "";
    const http = new UpstoxQuotes({
      token: "secret-token",
      fetch: async (url, init) => {
        urls.push(url);
        auth = new Headers(init.headers).get("Authorization") ?? "";
        if (url.includes("historical-candle")) return Response.json({ status: "success", data: { candles: rows(at("09:15"), 2) } });
        return Response.json({ status: "success", data: { "NSE_FO:NIFTY26O2022500CE": optionEntry("111", 100, 101) } });
      },
    });
    const q = new UpstoxOptionQuotes(http, { now: () => at("10:00") });
    expect((await q.quote(A)).source).toBe("upstox");
    expect(urls[0]).toBe("https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_FO%7C111");
    expect(auth).toBe("Bearer secret-token");
    const body = await http.get(`/v2/historical-candle/intraday/${encodeURIComponent("BSE_INDEX|SENSEX")}/1minute`);
    expect(urls[1]).toBe("https://api.upstox.com/v2/historical-candle/intraday/BSE_INDEX%7CSENSEX/1minute");
    expect(parseUpstoxCandles(body)).toHaveLength(2);
  });
});
