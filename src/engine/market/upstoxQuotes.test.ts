import { describe, expect, it } from "vitest";
import type { OptionContract } from "../types";
import {
  UPSTOX_MAX_KEYS,
  UPSTOX_QUOTE_SOURCE,
  UpstoxError,
  UpstoxQuotes,
  classifyUpstoxStatus,
  parseUpstoxLevels,
  parseUpstoxQuote,
  parseUpstoxTime,
  upstoxEntriesByKey,
  upstoxInstrumentKey,
} from "./upstoxQuotes";

const contract = (o: Partial<OptionContract> & { tradingSymbol: string; exchangeToken: string }): OptionContract => ({
  index: "NIFTY",
  exchange: "NSE",
  growwSymbol: "",
  expiry: "2026-10-13",
  strike: 22_500,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
  freezeQty: 1_800,
  ...o,
});

/** An entry shaped like Upstox's documented full-quote response (unused depth levels are zeros). */
function entry(token: string, o: { ltp?: number; bid?: number; ask?: number; ltt?: string } = {}) {
  const bid = o.bid ?? 137.05;
  const ask = o.ask ?? 137.65;
  return {
    ohlc: { open: 61.6, high: 180, low: 56, close: 137.05 },
    depth: {
      buy: [
        { quantity: 0, price: 0, orders: 0 },
        { quantity: 650, price: bid - 0.05, orders: 3 },
        { quantity: 1_300, price: bid, orders: 5 },
      ],
      sell: [
        { quantity: 455, price: ask, orders: 2 },
        { quantity: 975, price: ask + 0.1, orders: 4 },
        { quantity: 0, price: 0, orders: 0 },
      ],
    },
    timestamp: "2026-10-12T09:15:21.099+05:30",
    instrument_token: token,
    symbol: "NIFTY2610132250CE",
    last_price: o.ltp ?? 137.3,
    volume: 7_729_502,
    average_price: 120.1,
    oi: 152_284,
    net_change: 89.5,
    total_buy_quantity: 474_435,
    total_sell_quantity: 430_560,
    lower_circuit_limit: 0.05,
    upper_circuit_limit: 445.9,
    last_trade_time: o.ltt ?? "1791726320130",
    oi_day_high: 0,
    oi_day_low: 0,
  };
}

function fakeFetch(handler: (keys: string[], init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; keys: string[]; auth: string | null }[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const keys = (u.searchParams.get("instrument_key") ?? "").split(",").filter(Boolean);
    calls.push({ url, keys, auth: new Headers(init.headers).get("authorization") });
    const r = handler(keys, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("Upstox market quotes (read-only recorder source)", () => {
  it("builds instrument keys from the exchange token", () => {
    expect(upstoxInstrumentKey({ exchange: "NSE", exchangeToken: "44612" })).toBe("NSE_FO|44612");
    expect(upstoxInstrumentKey({ exchange: "BSE", exchangeToken: "1114892" })).toBe("BSE_FO|1114892");
  });

  it("keeps positive depth levels, best first", () => {
    expect(parseUpstoxLevels(entry("k").depth.buy, "buy")).toEqual([
      { price: 137.05, qty: 1_300 },
      { price: 137, qty: 650 },
    ]);
    expect(parseUpstoxLevels(entry("k").depth.sell, "sell").map((l) => l.price)).toEqual([137.65, 137.75]);
    expect(parseUpstoxLevels(undefined, "buy")).toEqual([]);
  });

  it("reads last_trade_time as epoch ms (seconds and ISO accepted)", () => {
    expect(parseUpstoxTime("1791726320130")).toBe(1_791_726_320_130);
    expect(parseUpstoxTime(1_791_726_320)).toBe(1_791_726_320_000);
    expect(parseUpstoxTime("2026-10-12T09:15:20+05:30")).toBe(Date.parse("2026-10-12T03:45:20Z"));
    expect(parseUpstoxTime("0")).toBeNull();
    expect(parseUpstoxTime(null)).toBeNull();
  });

  it("maps an entry to a quote with depth, OI, volume and the last trade time", () => {
    const { quote, lastTradeMs } = parseUpstoxQuote("NIFTY26O1322500CE", entry("NSE_FO|44612"), 1_000);
    expect(quote).toMatchObject({ symbol: "NIFTY26O1322500CE", t: 1_000, ltp: 137.3, bid: 137.05, ask: 137.65, bidQty: 1_300, askQty: 455, oi: 152_284, volume: 7_729_502, source: "upstox" });
    expect(quote.depth?.buy).toHaveLength(2);
    expect(lastTradeMs).toBe(1_791_726_320_130);
    const empty = parseUpstoxQuote("X", { last_price: 5 }, 2);
    expect(empty.quote).toMatchObject({ bid: 0, ask: 0, bidQty: 0, askQty: 0, ltp: 5 });
    expect(empty.quote.depth).toBeUndefined();
    expect(empty.lastTradeMs).toBeNull();
  });

  it("indexes the response by instrument_token, whatever the data keys are", () => {
    const m = upstoxEntriesByKey({ status: "success", data: { "NSE_FO:NIFTY2610132250CE": entry("NSE_FO|44612"), "BSE_FO:SENSEX": entry("BSE_FO|1114892"), junk: 3 } });
    expect([...m.keys()].sort()).toEqual(["BSE_FO|1114892", "NSE_FO|44612"]);
    expect(upstoxEntriesByKey(null).size).toBe(0);
    // An index entry without instrument_token still maps by its data key.
    expect(upstoxEntriesByKey({ status: "success", data: { "NSE_INDEX:Nifty 50": { last_price: 22_520.45 } } }).get("NSE_INDEX|Nifty 50")).toEqual({ last_price: 22_520.45 });
  });

  it("classifies HTTP failures so the recorder stops on auth, permission and rate limits", () => {
    expect(classifyUpstoxStatus(401)).toBe("auth");
    expect(classifyUpstoxStatus(403)).toBe("forbidden");
    expect(classifyUpstoxStatus(429)).toBe("rate_limited");
    expect(classifyUpstoxStatus(400)).toBe("bad_request");
    expect(classifyUpstoxStatus(503)).toBe("transient");
  });

  it("quotes every contract in one call, sends the token only as a Bearer header, and leaves out what Upstox did not return", async () => {
    const a = contract({ tradingSymbol: "NIFTY26O1322500CE", exchangeToken: "44612" });
    const b = contract({ tradingSymbol: "NIFTY26O1322500PE", exchangeToken: "44613", type: "PE" });
    const c = contract({ index: "SENSEX", exchange: "BSE", tradingSymbol: "SENSEX26O1572500CE", exchangeToken: "1114892", lotSize: 20 });
    const missing = contract({ tradingSymbol: "NIFTY26O1322550CE", exchangeToken: "44614" });
    const { f, calls } = fakeFetch((keys) => ({ body: { status: "success", data: Object.fromEntries(keys.filter((k) => !k.endsWith("44614")).map((k) => [k.replace("|", ":"), entry(k)])) } }));
    const src = new UpstoxQuotes({ token: "tkn-123", fetch: f, now: () => 42 });
    expect(src.name).toBe(UPSTOX_QUOTE_SOURCE);
    const res = await src.quoteBatch([a, b, c, missing]);
    expect(res.requests).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].keys).toEqual(["NSE_FO|44612", "NSE_FO|44613", "BSE_FO|1114892", "NSE_FO|44614"]);
    expect(calls[0].url.startsWith("https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_FO%7C44612,")).toBe(true);
    expect(calls[0].url).not.toContain("tkn-123");
    expect(calls[0].auth).toBe("Bearer tkn-123");
    expect([...res.quotes.keys()]).toEqual(["NIFTY26O1322500CE", "NIFTY26O1322500PE", "SENSEX26O1572500CE"]);
    expect(res.quotes.get("SENSEX26O1572500CE")?.quote).toMatchObject({ symbol: "SENSEX26O1572500CE", t: 42, bid: 137.05 });
  });

  it("splits more than 500 contracts into several calls", async () => {
    const many = Array.from({ length: UPSTOX_MAX_KEYS + 3 }, (_, i) => contract({ tradingSymbol: `S${i}`, exchangeToken: String(1000 + i) }));
    const { f, calls } = fakeFetch((keys) => ({ body: { status: "success", data: Object.fromEntries(keys.map((k) => [k, entry(k)])) } }));
    const res = await new UpstoxQuotes({ token: "t", fetch: f }).quoteBatch(many);
    expect(res.requests).toBe(2);
    expect(calls.map((c) => c.keys.length)).toEqual([500, 3]);
    expect(res.quotes.size).toBe(503);
  });

  it("reads the index spots in one call", async () => {
    const { f, calls } = fakeFetch(() => ({
      body: { status: "success", data: { "NSE_INDEX:Nifty 50": { instrument_token: "NSE_INDEX|Nifty 50", last_price: 22_520.45 }, "BSE_INDEX:SENSEX": { instrument_token: "BSE_INDEX|SENSEX", last_price: 72_472.33 } } },
    }));
    expect(await new UpstoxQuotes({ token: "t", fetch: f }).indexLtp()).toEqual({ NIFTY: 22_520.45, SENSEX: 72_472.33 });
    expect(calls[0].keys).toEqual(["NSE_INDEX|Nifty 50", "BSE_INDEX|SENSEX"]);
  });

  it("turns failures into UpstoxErrors with the kind and Upstox's code, never the token", async () => {
    const expired = fakeFetch(() => ({ status: 401, body: { status: "error", errors: [{ errorCode: "UDAPI100050", message: "Invalid token used to access API" }] } }));
    const err = await new UpstoxQuotes({ token: "secret-token", fetch: expired.f }).quoteBatch([contract({ tradingSymbol: "A", exchangeToken: "1" })]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstoxError);
    expect(err).toMatchObject({ kind: "auth", status: 401, code: "UDAPI100050" });
    expect((err as Error).message).toContain("HTTP 401 UDAPI100050 Invalid token");
    expect((err as Error).message).not.toContain("secret-token");

    const limited = fakeFetch(() => ({ status: 429, body: {} }));
    await expect(new UpstoxQuotes({ token: "t", fetch: limited.f }).indexLtp()).rejects.toMatchObject({ kind: "rate_limited" });

    const odd = fakeFetch(() => ({ body: { status: "error" } }));
    await expect(new UpstoxQuotes({ token: "t", fetch: odd.f }).indexLtp()).rejects.toMatchObject({ kind: "unknown" });

    const down = async (): Promise<Response> => Promise.reject(new TypeError("network down"));
    await expect(new UpstoxQuotes({ token: "t", fetch: down }).indexLtp()).rejects.toMatchObject({ kind: "transient", status: 0 });
  });
});
