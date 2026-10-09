import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import type { Candle } from "../types";
import { FIXTURE_1D, FIXTURE_5M, readMarketFixtureText } from "../__fixtures__/market/loadFixtures";
import { NO_DATA_AGE_SEC } from "./features";
import { CROSS_ASSET_SYMBOLS, INDIAN_SYMBOLS, YahooMarketDataSource } from "./yahooMarketData";

const cal = new TradingCalendar();

interface Call {
  symbol: string;
  interval: string;
  range: string;
}

function chartBody(symbol: string, candles: Candle[], regularMarketTime: number | null = null): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { symbol, regularMarketTime, regularMarketPrice: candles.at(-1)?.c ?? null, gmtoffset: 19800 },
          timestamp: candles.map((c) => c.t / 1000),
          indicators: {
            quote: [
              {
                open: candles.map((c) => c.o),
                high: candles.map((c) => c.h),
                low: candles.map((c) => c.l),
                close: candles.map((c) => c.c),
                volume: candles.map((c) => c.v),
              },
            ],
          },
        },
      ],
      error: null,
    },
  });
}

/** Fake Yahoo: serves the recorded fixtures, 404s for the rest, tracks calls and concurrency. */
function fakeYahoo(opts: { fail?: Set<string>; override?: (c: Call) => string | null } = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const symbol = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const call = { symbol, interval: url.searchParams.get("interval") ?? "", range: url.searchParams.get("range") ?? "" };
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (opts.fail?.has(symbol)) return new Response("upstream error", { status: 500 });
      const custom = opts.override?.(call);
      if (custom) return new Response(custom, { status: 200 });
      const file = call.interval === "1d" ? FIXTURE_1D[symbol] : FIXTURE_5M[symbol];
      if (!file) {
        return new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found", description: "No data found" } } }), { status: 404 });
      }
      return new Response(readMarketFixtureText(file), { status: 200 });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

function clock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), set: (t: number) => (now = t) };
}

const AFTER_CLOSE = istAt("2026-10-07", "20:45");

describe("YahooMarketDataSource", () => {
  it("loads 60 days of Indian 5m data, 5 days of cross-assets and 6 months of daily, at most 4 at once", async () => {
    const yahoo = fakeYahoo();
    const logs: string[] = [];
    const c = clock(AFTER_CLOSE);
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now, log: (m) => logs.push(m) });
    const snap = await src.snapshot(c.now());

    const ranges = (sym: string, interval: string) => yahoo.calls.filter((x) => x.symbol === sym && x.interval === interval).map((x) => x.range);
    for (const sym of INDIAN_SYMBOLS) {
      expect(ranges(sym, "5m")).toEqual(["60d"]);
      expect(ranges(sym, "1d")).toEqual(["6mo"]);
    }
    for (const sym of CROSS_ASSET_SYMBOLS) {
      expect(ranges(sym, "5m")).toEqual(["5d"]);
      expect(ranges(sym, "1d")).toEqual(["6mo"]);
    }
    expect(yahoo.calls.length).toBe(32);
    expect(yahoo.maxInFlight()).toBeLessThanOrEqual(4);
    expect(yahoo.maxInFlight()).toBeGreaterThan(1);

    // Symbols without fixtures failed (404) but did not fail the snapshot.
    expect(logs.filter((m) => m.includes("fetch failed")).length).toBe(8 + 12);
    expect(snap.candles["^NSEI"].length).toBe(301);
    expect(snap.candles["ES=F"].length).toBeGreaterThan(900);
    expect(snap.candles["NQ=F"]).toBeUndefined();
    expect(snap.daily["^NSEI"].length).toBeGreaterThan(60);

    // Default spot is Yahoo's latest price; age is measured to the freshest NIFTY/SENSEX last-trade time
    // (the closing bars are stamped 15:30 but Yahoo's regularMarketTime says when they were last updated).
    expect(snap.ltp.NIFTY).toBeCloseTo(22603.05, 2);
    expect(snap.ltp.BANKNIFTY).toBeGreaterThan(50000);
    const lastTrade = (file: string) =>
      (JSON.parse(readMarketFixtureText(file)) as { chart: { result: { meta: { regularMarketTime: number } }[] } }).chart.result[0].meta
        .regularMarketTime * 1000;
    const freshest = Math.max(lastTrade(FIXTURE_5M["^NSEI"]), lastTrade(FIXTURE_5M["^BSESN"]));
    expect(freshest).toBeGreaterThan(istAt("2026-10-07", "15:30"));
    expect(snap.dataAgeSec).toBe((AFTER_CLOSE - freshest) / 1000);
  });

  it("serves from cache within the TTLs and refreshes incrementally after them", async () => {
    const yahoo = fakeYahoo();
    const c = clock(istAt("2026-10-07", "11:00"));
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    await src.snapshot(c.now());
    const n0 = yahoo.calls.length;

    c.advance(30_000);
    await src.snapshot(c.now());
    expect(yahoo.calls.length).toBe(n0);

    c.advance(31_000); // 61 s: Indian 5m refresh (range=1d); failed daily loads retried; cross not due yet
    await src.snapshot(c.now());
    const wave2 = yahoo.calls.slice(n0);
    expect(wave2.filter((x) => x.interval === "5m").map((x) => `${x.symbol}:${x.range}`).sort()).toEqual(
      INDIAN_SYMBOLS.map((s) => `${s}:1d`).sort(),
    );
    expect(wave2.filter((x) => x.interval === "1d").map((x) => x.symbol).sort()).toEqual([...CROSS_ASSET_SYMBOLS].sort());

    c.advance(60_000); // 121 s: cross-assets due (2 min)
    const n2 = yahoo.calls.length;
    await src.snapshot(c.now());
    const wave3 = yahoo.calls.slice(n2).filter((x) => x.interval === "5m");
    expect(wave3.filter((x) => x.range === "5d").length).toBe(12);
    expect(wave3.filter((x) => x.range === "1d").length).toBe(4);
  });

  it("stops incremental Indian refreshes after the close once the final bars are in", async () => {
    const yahoo = fakeYahoo();
    const c = clock(istAt("2026-10-07", "15:36"));
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    await src.snapshot(c.now()); // fetched before close + 10 min: not settled yet
    const indian5m = () => yahoo.calls.filter((x) => x.interval === "5m" && INDIAN_SYMBOLS.includes(x.symbol)).length;
    expect(indian5m()).toBe(4);
    c.set(istAt("2026-10-07", "15:42"));
    await src.snapshot(c.now()); // 1d refresh after the settle time
    expect(indian5m()).toBe(8);
    for (let i = 0; i < 5; i++) {
      c.advance(61_000);
      await src.snapshot(c.now());
    }
    expect(indian5m()).toBe(8);
    // Cross-assets keep refreshing (they trade around the clock).
    expect(yahoo.calls.filter((x) => x.symbol === "ES=F" && x.interval === "5m").length).toBeGreaterThan(1);
    // A new IST day always starts with the 60-day reload.
    c.set(istAt("2026-10-08", "10:00"));
    await src.snapshot(c.now());
    expect(indian5m()).toBe(12);
    // On an exchange holiday (Dussehra) the reload happens once, then nothing until the next session.
    c.set(istAt("2026-10-20", "11:00"));
    await src.snapshot(c.now());
    expect(indian5m()).toBe(16);
    c.advance(61_000);
    await src.snapshot(c.now());
    expect(indian5m()).toBe(16);
  });

  it("reloads the 60-day window and daily bars on a new IST day", async () => {
    const yahoo = fakeYahoo();
    const c = clock(AFTER_CLOSE);
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    await src.snapshot(c.now());
    c.set(istAt("2026-10-08", "08:00"));
    const n0 = yahoo.calls.length;
    await src.snapshot(c.now());
    const next = yahoo.calls.slice(n0);
    expect(next.filter((x) => x.symbol === "^NSEI").map((x) => `${x.interval}:${x.range}`).sort()).toEqual(["1d:6mo", "5m:60d"]);
  });

  it("merges refreshed bars and keeps stale data when a symbol starts failing", async () => {
    const extra: Candle = { t: istAt("2026-10-08", "09:15"), o: 22600, h: 22650, l: 22590, c: 22640, v: 0 };
    let failNsei = false;
    const fail = new Set<string>();
    const yahoo = fakeYahoo({
      fail,
      override: (call) => (call.symbol === "^NSEI" && call.range === "1d" && call.interval === "5m" && !failNsei ? chartBody("^NSEI", [extra]) : null),
    });
    const logs: unknown[] = [];
    const c = clock(istAt("2026-10-08", "09:16"));
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now, log: (_m, d) => logs.push(d) });
    const first = await src.snapshot(c.now());
    expect(first.candles["^NSEI"].length).toBe(301);
    c.advance(61_000);
    const second = await src.snapshot(c.now());
    expect(second.candles["^NSEI"].length).toBe(302);
    expect(second.candles["^NSEI"].at(-1)).toEqual(extra);

    failNsei = true;
    fail.add("^NSEI");
    c.advance(61_000);
    const third = await src.snapshot(c.now());
    expect(third.candles["^NSEI"].length).toBe(302);
    expect(logs.some((d) => (d as { symbol?: string }).symbol === "^NSEI")).toBe(true);
  });

  it("replaces revised bars instead of accumulating them", async () => {
    // First refresh returns a forming 09:15 bar; the next returns the finished bar plus 09:20.
    let wave = 0;
    const t0 = istAt("2026-10-08", "09:15");
    const yahoo = fakeYahoo({
      override: (call) => {
        if (call.symbol !== "^NSEI" || call.interval !== "5m" || call.range !== "1d") return null;
        return wave === 0
          ? chartBody("^NSEI", [{ t: t0, o: 22600, h: 22610, l: 22595, c: 22605, v: 0 }])
          : chartBody("^NSEI", [
              { t: t0, o: 22600, h: 22630, l: 22580, c: 22620, v: 0 },
              { t: t0 + 300_000, o: 22620, h: 22640, l: 22615, c: 22635, v: 0 },
            ]);
      },
    });
    const c = clock(istAt("2026-10-08", "09:17"));
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    await src.snapshot(c.now()); // 60-day load (fixture)
    c.advance(61_000);
    await src.snapshot(c.now()); // 1d refresh, wave 0
    wave = 1;
    c.advance(61_000);
    const snap = await src.snapshot(c.now() + 300_000);
    const today = snap.candles["^NSEI"].filter((x) => x.t >= t0);
    expect(today.map((x) => x.c)).toEqual([22620, 22635]);
    expect(snap.candles["^NSEI"].length).toBe(301 + 2);
  });

  it("filters to the requested time and lets the LTP provider override the spot", async () => {
    const yahoo = fakeYahoo();
    const c = clock(istAt("2026-10-07", "11:00") + 20_000);
    const src = new YahooMarketDataSource({
      calendar: cal,
      fetchImpl: yahoo.fetchImpl,
      now: c.now,
      ltp: async () => ({ NIFTY: 22610.5, SENSEX: Number.NaN }),
    });
    const t = istAt("2026-10-07", "11:00");
    const snap = await src.snapshot(t);
    expect(snap.candles["^NSEI"].at(-1)?.t).toBe(t); // the 11:00 bar is still forming at t
    expect(snap.candles["^NSEI"].every((x) => x.t <= t)).toBe(true);
    expect(snap.ltp.NIFTY).toBe(22610.5);
    expect(snap.ltp.SENSEX).toBe(snap.candles["^BSESN"].at(-1)?.c); // NaN from the provider is ignored
    expect(snap.dataAgeSec).toBe(0);
  });

  it("survives an LTP provider failure and a total outage", async () => {
    const logs: string[] = [];
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const src = new YahooMarketDataSource({
      calendar: cal,
      fetchImpl: down,
      now: () => AFTER_CLOSE,
      ltp: async () => {
        throw new Error("groww 401");
      },
      log: (m) => logs.push(m),
    });
    const snap = await src.snapshot(AFTER_CLOSE);
    expect(snap.candles).toEqual({});
    expect(snap.ltp).toEqual({});
    expect(snap.dataAgeSec).toBe(NO_DATA_AGE_SEC);
    expect(logs).toContain("yahoo-market: LTP provider failed");
  });

  it("shares one refresh between concurrent callers", async () => {
    const yahoo = fakeYahoo();
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: () => AFTER_CLOSE });
    await Promise.all([src.snapshot(AFTER_CLOSE), src.snapshot(AFTER_CLOSE), src.snapshot(AFTER_CLOSE)]);
    expect(yahoo.calls.length).toBe(32);
  });
});

describe("quote times (DF-5)", () => {
  it("are the source's last trade time, or the fetch time of a broker LTP", async () => {
    const t = istAt("2026-10-09", "10:00");
    const bars: Candle[] = [{ t: istAt("2026-10-09", "09:50"), o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: istAt("2026-10-09", "09:55"), o: 2, h: 2, l: 2, c: 2, v: 0 }];
    const traded = istAt("2026-10-09", "09:57") + 30_000;
    const yahoo = fakeYahoo({ override: (c) => (c.interval === "5m" && (c.symbol === "BZ=F" || c.symbol === "^BSESN") ? chartBody(c.symbol, bars, traded / 1000) : null) });
    const c = clock(t);
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now, ltp: async () => ({ NIFTY: 25_300 }) });
    const snap = await src.snapshot(t);
    expect(snap.asOfMs?.["BZ=F"]).toBe(traded);
    expect(snap.asOfMs?.["^BSESN"]).toBe(traded);
    // NIFTY's price is Groww's LTP fetched now.
    expect(snap.asOfMs?.["^NSEI"]).toBe(t);
  });
});

describe("a daily chart that lags the previous session", () => {
  // At 00:30 IST on 9 Oct Yahoo's daily chart still had no close for 8 Oct (the bar is dropped).
  const bar = (date: string, c: number): Candle => ({ t: istAt(date, "09:15"), o: c, h: c, l: c, c, v: 0 });
  const upTo7 = [bar("2026-10-05", 24_800), bar("2026-10-06", 24_900), bar("2026-10-07", 25_000)];

  function setup() {
    let published = false;
    const yahoo = fakeYahoo({ override: (c) => (c.interval === "1d" && c.symbol === "^NSEI" ? chartBody("^NSEI", published ? [...upTo7, bar("2026-10-08", 25_100)] : upTo7) : null) });
    const c = clock(istAt("2026-10-09", "00:30"));
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    const dailyCalls = () => yahoo.calls.filter((x) => x.symbol === "^NSEI" && x.interval === "1d").length;
    const lastDaily = async () => (await src.snapshot(c.now())).daily["^NSEI"]?.at(-1)?.c;
    return { c, dailyCalls, lastDaily, publish: () => (published = true) };
  }

  it("is fetched again every few minutes until the previous trading day's bar is in", async () => {
    const s = setup();
    expect(await s.lastDaily()).toBe(25_000);
    expect(s.dailyCalls()).toBe(1);
    s.c.advance(2 * 60_000);
    await s.lastDaily();
    expect(s.dailyCalls()).toBe(1);
    s.c.advance(4 * 60_000);
    expect(await s.lastDaily()).toBe(25_000);
    expect(s.dailyCalls()).toBe(2);
    s.publish();
    s.c.advance(6 * 60_000);
    expect(await s.lastDaily()).toBe(25_100);
    expect(s.dailyCalls()).toBe(3);
    // Complete now: back to once a day.
    s.c.advance(6 * 60_000);
    await s.lastDaily();
    expect(s.dailyCalls()).toBe(3);
  });
});

describe("per-index data age", () => {
  const t = istAt("2026-10-07", "11:00") + 20_000;
  // 9 Oct 2026: Yahoo kept serving SENSEX's previous-session 5-minute bars into the next session.
  const frozenBars: Candle[] = [
    { t: istAt("2026-10-06", "15:20"), o: 81_000, h: 81_050, l: 80_990, c: 81_020, v: 0 },
    { t: istAt("2026-10-06", "15:25"), o: 81_020, h: 81_060, l: 81_000, c: 81_040, v: 0 },
  ];
  const frozenTraded = istAt("2026-10-06", "15:30") + 31_000;
  const frozenSensex = () => fakeYahoo({ override: (c) => (c.interval === "5m" && c.symbol === "^BSESN" ? chartBody(c.symbol, frozenBars, frozenTraded / 1000) : null) });

  it("marks a frozen SENSEX stale while NIFTY stays fresh", async () => {
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: frozenSensex().fetchImpl, now: () => t });
    const snap = await src.snapshot(t);
    expect(snap.dataAgeSecByIndex?.NIFTY).toBeLessThanOrEqual(300);
    expect(snap.dataAgeSecByIndex?.SENSEX).toBeGreaterThan(17 * 3600);
    // The snapshot-wide age still reports the freshest index.
    expect(snap.dataAgeSec).toBe(snap.dataAgeSecByIndex?.NIFTY);
  });

  it("does not let a broker LTP make frozen SENSEX bars look fresh", async () => {
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: frozenSensex().fetchImpl, now: () => t, ltp: async () => ({ NIFTY: 25_000, SENSEX: 82_000 }) });
    const snap = await src.snapshot(t);
    expect(snap.ltp.SENSEX).toBe(82_000); // the spot still comes from the broker
    expect(snap.dataAgeSec).toBe(0);
    expect(snap.dataAgeSecByIndex?.SENSEX).toBeGreaterThan(17 * 3600);
    expect(snap.dataAgeSecByIndex?.NIFTY).toBeLessThanOrEqual(300);
  });

  it("ages an index whose fetch starts failing, and only that index", async () => {
    const c = clock(t);
    const fail = new Set<string>();
    const sensexUpTo = (now: number): Candle[] => {
      const out: Candle[] = [];
      for (let b = istAt("2026-10-07", "09:15"); b <= now; b += 5 * 60_000) out.push({ t: b, o: 82_000, h: 82_010, l: 81_990, c: 82_005, v: 0 });
      return out;
    };
    const yahoo = fakeYahoo({ fail, override: (q) => (q.interval === "5m" && q.symbol === "^BSESN" ? chartBody(q.symbol, sensexUpTo(c.now()), (c.now() - 20_000) / 1000) : null) });
    const src = new YahooMarketDataSource({ calendar: cal, fetchImpl: yahoo.fetchImpl, now: c.now });
    const before = await src.snapshot(t);
    expect(before.dataAgeSecByIndex?.SENSEX).toBe(20);
    fail.add("^BSESN");
    const later = c.advance(10 * 60_000);
    const after = await src.snapshot(later);
    expect(after.dataAgeSecByIndex?.SENSEX).toBe(620); // last trade 11:00:00, now 11:10:20
    expect(after.dataAgeSecByIndex?.NIFTY).toBeLessThanOrEqual(300);
  });
});
