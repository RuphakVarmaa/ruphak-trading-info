import { beforeEach, describe, expect, it } from "vitest";
import type { YahooChart } from "@/engine/market/yahooClient";
import type { Candle } from "@/engine/types";
import { __resetCommodityCacheForTests, buildCommodityQuote, COMMODITIES, COMMODITY_SOURCE, fetchCommodityBoard, hasSessionGap } from "./commodities";

const GOLD = COMMODITIES.find((c) => c.key === "GOLD")!;
const COPPER = COMMODITIES.find((c) => c.key === "COPPER")!;

/** Daily futures bars are stamped at New York midnight (04:00 UTC in October). */
const bar = (date: string, o: number, h: number, l: number, c: number): Candle => ({ t: Date.parse(`${date}T04:00:00Z`), o, h, l, c, v: 1000 });

const chart = (candles: Candle[], meta: Partial<YahooChart["meta"]> = {}): YahooChart => ({
  symbol: "GC=F",
  candles,
  meta: { regularMarketPrice: null, previousClose: null, regularMarketTime: null, gmtoffset: -14400, ...meta },
});

// GC=F on 2026-10-08 as Yahoo returned it (float32 closes).
const GOLD_HISTORY = [
  bar("2026-10-05", 4169.4, 4198.9, 4150.4, 4156.7998046875),
  bar("2026-10-06", 4169.2, 4212.4, 4130.7, 4187.10009765625),
  bar("2026-10-07", 4195.0, 4197.8, 4091.2, 4140.7001953125),
];
const GOLD_TODAY = bar("2026-10-08", 4139.9, 4170.7001953125, 4128.10009765625, 4148.7001953125);
const LAST_TRADE = Date.parse("2026-10-08T18:30:32Z") / 1000;

describe("buildCommodityQuote", () => {
  it("reads the last daily bar as today's session when its close is the live price", () => {
    const q = buildCommodityQuote(GOLD, chart([...GOLD_HISTORY, GOLD_TODAY], { regularMarketPrice: 4148.7, regularMarketTime: LAST_TRADE }))!;
    expect(q).toMatchObject({ key: "GOLD", name: "Gold", symbol: "GC=F", unit: "$/oz", decimals: 2 });
    expect(q.price).toBe(4148.7);
    expect(q.prevClose).toBe(4140.7);
    expect(q.change).toBe(8);
    expect(q.changePct).toBe(0.193);
    expect(q.dayHigh).toBe(4170.7);
    expect(q.dayLow).toBe(4128.1);
    expect(q.asOf).toBe("2026-10-08T18:30:32.000Z");
    expect(q.closes).toEqual([4156.8, 4187.1, 4140.7, 4148.7]);
  });

  it("stretches today's range to the live price when the bar lags a little", () => {
    const lagging = bar("2026-10-08", 4139.9, 4148.5, 4128.1, 4148.5);
    const q = buildCommodityQuote(GOLD, chart([...GOLD_HISTORY, lagging], { regularMarketPrice: 4149.9, regularMarketTime: LAST_TRADE }))!;
    expect(q.prevClose).toBe(4140.7);
    expect(q.dayHigh).toBe(4149.9);
    expect(q.closes.at(-1)).toBe(4149.9);
  });

  it("reads the last bar as the previous session when the live price has moved away from it", () => {
    const q = buildCommodityQuote(GOLD, chart(GOLD_HISTORY, { regularMarketPrice: 4148.7, regularMarketTime: LAST_TRADE }))!;
    expect(q.prevClose).toBe(4140.7);
    expect(q.change).toBe(8);
    expect(q.dayHigh).toBeNull();
    expect(q.dayLow).toBeNull();
    expect(q.closes).toEqual([4156.8, 4187.1, 4140.7, 4148.7]);
  });

  it("gives a price without a change when there are no bars, and nothing without a price", () => {
    const q = buildCommodityQuote(GOLD, chart([], { regularMarketPrice: 4148.7, regularMarketTime: LAST_TRADE }))!;
    expect(q).toMatchObject({ price: 4148.7, prevClose: null, change: null, changePct: null, dayHigh: null, dayLow: null, closes: [] });
    expect(q.asOf).toBe("2026-10-08T18:30:32.000Z");
    expect(buildCommodityQuote(GOLD, chart([]))).toBeNull();
  });

  it("falls back to the last bar for the price and its time, and keeps one decimal past the display", () => {
    const hg = [bar("2026-10-07", 6.58, 6.6135, 6.58, 6.596499919891357), bar("2026-10-08", 6.641, 6.763, 6.563, 6.570000171661377)];
    const q = buildCommodityQuote(COPPER, chart(hg))!;
    expect(q.price).toBe(6.57);
    expect(q.prevClose).toBe(6.5965);
    expect(q.change).toBe(-0.0265);
    expect(q.changePct).toBe(-0.402);
    expect(q.asOf).toBe("2026-10-08T04:00:00.000Z");
  });

  it("takes the previous settlement from the 5-minute chart when given", () => {
    // SI=F on 2026-10-08: the daily 10-07 close (59.899) is not the front month's settlement (60.294).
    const si = [bar("2026-10-06", 60.92, 61.375, 60.92, 61.168), bar("2026-10-07", 60.88, 60.88, 59.53, 59.899), bar("2026-10-08", 60.19, 60.84, 58.73, 59.235)];
    const silver = COMMODITIES.find((c) => c.key === "SILVER")!;
    const q = buildCommodityQuote(silver, chart(si, { regularMarketPrice: 59.235, regularMarketTime: LAST_TRADE }), 60.294)!;
    expect(q.prevClose).toBe(60.294);
    expect(q.change).toBe(-1.059);
    expect(q.changePct).toBe(-1.756);
    expect(buildCommodityQuote(silver, chart(si, { regularMarketPrice: 59.235, regularMarketTime: LAST_TRADE }), Number.NaN)!.prevClose).toBe(59.899);
  });

  it("never reports a change across a missing session without the 5-minute settlement", () => {
    // PL=F on 2026-10-08: Yahoo had no 2026-10-07 bar, so the bar before today's is two sessions back.
    const platinum = COMMODITIES.find((c) => c.key === "PLATINUM")!;
    const pl = [bar("2026-10-02", 1744.5, 1744.5, 1683.2, 1683.2), bar("2026-10-05", 1727.5, 1737, 1706.9, 1706.9), bar("2026-10-06", 1692.7, 1692.7, 1692.7, 1692.7), bar("2026-10-08", 1638.4, 1675, 1633, 1646.9)];
    const meta = { regularMarketPrice: 1646.9, regularMarketTime: LAST_TRADE };
    const gapped = buildCommodityQuote(platinum, chart(pl, meta))!;
    expect(gapped).toMatchObject({ price: 1646.9, prevClose: null, change: null, changePct: null, dayHigh: 1675, dayLow: 1633 });
    expect(gapped.closes).toEqual([1683.2, 1706.9, 1692.7, 1646.9]);
    expect(buildCommodityQuote(platinum, chart(pl, meta), 1649.8)).toMatchObject({ prevClose: 1649.8, change: -2.9 });
    // A weekend is not a gap: Friday's bar is Monday's previous session.
    expect(buildCommodityQuote(platinum, chart(pl.slice(0, 2), { regularMarketPrice: 1706.9, regularMarketTime: LAST_TRADE }))!.prevClose).toBe(1683.2);
    // Previous-session case: the last bar is Tuesday's and Thursday is trading.
    expect(buildCommodityQuote(platinum, chart(pl.slice(0, 3), meta))!.prevClose).toBeNull();
  });

  it("finds a missing weekday between two dates", () => {
    expect(hasSessionGap("2026-10-06", "2026-10-08")).toBe(true);
    expect(hasSessionGap("2026-10-07", "2026-10-08")).toBe(false);
    expect(hasSessionGap("2026-10-02", "2026-10-05")).toBe(false); // Friday -> Monday
    expect(hasSessionGap("2026-10-01", "2026-10-05")).toBe(true); // Friday missing
    expect(hasSessionGap("2026-10-08", "2026-10-08")).toBe(false);
  });

  it("keeps at most 22 points for the sparkline", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...GOLD_HISTORY[0], t: GOLD_HISTORY[0].t - (30 - i) * 86_400_000, c: 4000 + i }));
    const q = buildCommodityQuote(GOLD, chart(many, { regularMarketPrice: 4029, regularMarketTime: LAST_TRADE }))!;
    expect(q.closes).toHaveLength(22);
    expect(q.closes.at(-1)).toBe(4029);
    expect(q.prevClose).toBe(4028);
  });
});

/** A daily chart v8 response like Yahoo's: 2026-10-05..08 with the 2026-10-07 row all nulls. */
function dailyJson(symbol: string, closes: number[], price: number) {
  const ts = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => Date.parse(`${d}T04:00:00Z`) / 1000);
  const col = [closes[0], closes[1], null, closes[2]];
  return {
    chart: {
      result: [
        {
          meta: { symbol, regularMarketPrice: price, regularMarketTime: LAST_TRADE, gmtoffset: -14400, dataGranularity: "1d" },
          timestamp: ts,
          indicators: { quote: [{ open: col, high: col, low: col, close: col, volume: col.map(() => 100) }] },
        },
      ],
      error: null,
    },
  };
}

/** A 5-minute chart whose meta carries the previous settlement (bars are not used). */
function intradayJson(symbol: string, price: number, settle: number) {
  const meta = { symbol, regularMarketPrice: price, previousClose: settle, regularMarketTime: LAST_TRADE, gmtoffset: -14400, dataGranularity: "5m" };
  return { chart: { result: [{ meta, timestamp: [], indicators: { quote: [{}] } }], error: null } };
}

/** symbol -> [daily closes for 10-05, 10-06 and 10-08, live price, previous settlement]. PL=F is unknown (404). */
const PRICES: Record<string, [number[], number, number]> = {
  "GC=F": [[4187.1, 4140.7, 4148.7], 4148.7, 4140.7],
  "SI=F": [[61.168, 59.899, 59.235], 59.235, 60.294],
  "HG=F": [[6.5945, 6.5965, 6.57], 6.57, 6.6495],
  "CL=F": [[89.44, 88.28, 91.52], 91.52, 88.28],
  "BZ=F": [[100.58, 100.2, 104.31], 104.31, 100.2],
};

function fakeYahoo(failing: (symbol: string, interval: string) => boolean = () => false) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const symbol = decodeURIComponent(url.pathname.split("/").pop()!);
    const interval = url.searchParams.get("interval") ?? "";
    const known = PRICES[symbol];
    if (failing(symbol, interval) || !known) {
      return new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }), { status: 404 });
    }
    const [closes, price, settle] = known;
    return new Response(JSON.stringify(interval === "5m" ? intradayJson(symbol, price, settle) : dailyJson(symbol, closes, price)), { status: 200 });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe("fetchCommodityBoard", () => {
  const T0 = Date.parse("2026-10-08T18:31:00Z");
  beforeEach(() => __resetCommodityCacheForTests());

  it("loads each symbol's daily and 5-minute charts and lists the one Yahoo did not return", async () => {
    const yahoo = fakeYahoo();
    const board = (await fetchCommodityBoard({ fetchImpl: yahoo.fetchImpl, nowMs: T0 }))!;
    const asked = yahoo.urls.map((u) => new URL(u).searchParams);
    expect(asked.filter((p) => p.get("interval") === "1d" && p.get("range") === "1mo")).toHaveLength(6);
    expect(asked.filter((p) => p.get("interval") === "5m" && p.get("range") === "1d")).toHaveLength(6);
    expect(board.quotes.map((q) => q.key)).toEqual(["GOLD", "SILVER", "COPPER", "WTI", "BRENT"]);
    expect(board.missing).toEqual(["PLATINUM"]);
    expect(board).toMatchObject({ source: COMMODITY_SOURCE, generatedAt: new Date(T0).toISOString(), stale: false });
    const silver = board.quotes.find((q) => q.key === "SILVER")!;
    expect(silver).toMatchObject({ price: 59.235, prevClose: 60.294, change: -1.059 });
    // The null 2026-10-07 row is dropped from the sparkline.
    expect(silver.closes).toEqual([61.168, 59.899, 59.235]);
  });

  it("falls back to the daily chart without the 5-minute chart, but not across the missing session", async () => {
    const yahoo = fakeYahoo((_, interval) => interval === "5m");
    const board = (await fetchCommodityBoard({ fetchImpl: yahoo.fetchImpl, nowMs: T0 }))!;
    // Every daily chart here lacks 2026-10-07, so no change is better than a change against 10-06.
    for (const q of board.quotes) expect(q).toMatchObject({ prevClose: null, change: null, changePct: null });
    expect(board.quotes.find((q) => q.key === "GOLD")!.price).toBe(4148.7);
  });

  it("reuses a board for a minute, then serves it as stale for up to 15 minutes when Yahoo fails", async () => {
    const ok = fakeYahoo();
    const first = (await fetchCommodityBoard({ fetchImpl: ok.fetchImpl, nowMs: T0 }))!;
    expect(await fetchCommodityBoard({ fetchImpl: ok.fetchImpl, nowMs: T0 + 59_000 })).toBe(first);
    expect(ok.urls).toHaveLength(12);

    const down = fakeYahoo(() => true);
    const stale = (await fetchCommodityBoard({ fetchImpl: down.fetchImpl, nowMs: T0 + 61_000 }))!;
    expect(down.urls).toHaveLength(12);
    expect(stale.stale).toBe(true);
    expect(stale.quotes).toEqual(first.quotes);
    expect(stale.generatedAt).toBe(first.generatedAt);
    expect(await fetchCommodityBoard({ fetchImpl: down.fetchImpl, nowMs: T0 + 15 * 60_000 + 1 })).toBeNull();
  });

  it("returns null when nothing loads and there is no earlier board", async () => {
    expect(await fetchCommodityBoard({ fetchImpl: fakeYahoo(() => true).fetchImpl, nowMs: T0 })).toBeNull();
  });
});
