import { describe, expect, it } from "vitest";
import { istAt, istDate } from "../clock";
import { readMarketFixture, readMarketFixtureText } from "../__fixtures__/market/loadFixtures";
import { fetchYahooChart, parseYahooChart, yahooChartUrl, YAHOO_USER_AGENT } from "./yahooClient";

function chartJson(rows: { ts: number; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null }[]) {
  return {
    chart: {
      result: [
        {
          meta: { symbol: "^TEST", regularMarketPrice: 101, regularMarketTime: 1700000000, gmtoffset: 19800, previousClose: 99 },
          timestamp: rows.map((r) => r.ts),
          indicators: {
            quote: [
              {
                open: rows.map((r) => r.o),
                high: rows.map((r) => r.h),
                low: rows.map((r) => r.l),
                close: rows.map((r) => r.c),
                volume: rows.map((r) => r.v),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

describe("parseYahooChart", () => {
  it("parses the recorded ^NSEI 5m response and drops the holiday's null rows", () => {
    const raw = readMarketFixture("yahoo-5m-5d-NSEI.json") as { chart: { result: { timestamp: number[] }[] } };
    const chart = parseYahooChart(raw, "^NSEI");
    expect(raw.chart.result[0].timestamp.length).toBe(376);
    // 2026-10-02 (Gandhi Jayanti) is 75 rows of nulls.
    expect(chart.candles.length).toBe(301);
    expect(chart.candles.some((c) => istDate(c.t) === "2026-10-02")).toBe(false);
    const first = chart.candles[0];
    expect(first.t).toBe(istAt("2026-10-01", "09:15"));
    expect(first.o).toBeCloseTo(22543.7, 1);
    expect(first.v).toBe(0);
    for (let i = 1; i < chart.candles.length; i++) expect(chart.candles[i].t).toBeGreaterThan(chart.candles[i - 1].t);
    for (const c of chart.candles) {
      expect(c.h).toBeGreaterThanOrEqual(c.l);
      expect(Number.isFinite(c.o + c.h + c.l + c.c + c.v)).toBe(true);
    }
    expect(chart.meta.gmtoffset).toBe(19800);
    expect(chart.meta.regularMarketPrice).toBeCloseTo(22603.05, 2);
    expect(chart.meta.regularMarketTime).toBe(1791367286);
  });

  it("drops bars with any null OHLC value and maps null volume to 0", () => {
    const t0 = 1_791_344_700; // 2026-10-07 09:15 IST
    const chart = parseYahooChart(
      chartJson([
        { ts: t0, o: 100, h: 101, l: 99, c: 100.5, v: null },
        { ts: t0 + 300, o: 100.5, h: null, l: 100, c: 100.2, v: 10 },
        { ts: t0 + 600, o: null, h: null, l: null, c: null, v: null },
        { ts: t0 + 900, o: 100.2, h: 100.9, l: 100.1, c: 100.8, v: 25 },
      ]),
      "^TEST",
    );
    expect(chart.candles).toEqual([
      { t: t0 * 1000, o: 100, h: 101, l: 99, c: 100.5, v: 0 },
      { t: (t0 + 900) * 1000, o: 100.2, h: 100.9, l: 100.1, c: 100.8, v: 25 },
    ]);
    expect(chart.meta).toEqual({ regularMarketPrice: 101, previousClose: 99, regularMarketTime: 1700000000, gmtoffset: 19800 });
  });

  it("sorts and de-duplicates repeated timestamps (later row wins)", () => {
    const t0 = 1_791_344_700;
    const chart = parseYahooChart(
      chartJson([
        { ts: t0 + 300, o: 2, h: 2, l: 2, c: 2, v: 0 },
        { ts: t0, o: 1, h: 1, l: 1, c: 1, v: 0 },
        { ts: t0 + 300, o: 3, h: 3, l: 3, c: 3, v: 0 },
      ]),
      "^TEST",
    );
    expect(chart.candles.map((c) => c.c)).toEqual([1, 3]);
  });

  it("folds Yahoo's trailing live tick into its 5-minute bar", () => {
    // Recorded ES=F chart: the last point is stamped 20:35:54 IST (the last trade), after the 20:35 bar.
    const raw = readMarketFixture("yahoo-5m-5d-ES_F.json") as {
      chart: { result: { timestamp: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] };
    };
    const ts = raw.chart.result[0].timestamp;
    expect(ts[ts.length - 1] % 300).not.toBe(0);
    const chart = parseYahooChart(raw, "ES=F");
    expect(chart.candles.every((c) => c.t % 300_000 === 0)).toBe(true);
    const last = chart.candles[chart.candles.length - 1];
    expect(last.t).toBe(istAt("2026-10-07", "20:35"));
    expect(last.c).toBe(raw.chart.result[0].indicators.quote[0].close[ts.length - 1]);

    const t0 = 1_791_344_700; // 09:15 IST
    const live = chartJson([
      { ts: t0, o: 100, h: 101, l: 99, c: 100.5, v: 5 },
      { ts: t0 + 300, o: 100.5, h: 100.8, l: 100.4, c: 100.6, v: 3 },
      { ts: t0 + 433, o: 100.9, h: 100.9, l: 100.9, c: 100.9, v: 0 },
    ]) as { chart: { result: { meta: Record<string, unknown> }[] } };
    live.chart.result[0].meta.dataGranularity = "5m";
    expect(parseYahooChart(live, "^TEST").candles).toEqual([
      { t: t0 * 1000, o: 100, h: 101, l: 99, c: 100.5, v: 5 },
      { t: (t0 + 300) * 1000, o: 100.5, h: 100.9, l: 100.4, c: 100.9, v: 3 },
    ]);
    // A tick whose own bar is missing becomes that bar.
    const orphan = chartJson([{ ts: t0 + 777, o: 101, h: 101, l: 101, c: 101, v: 0 }]) as typeof live;
    orphan.chart.result[0].meta.dataGranularity = "5m";
    expect(parseYahooChart(orphan, "^TEST").candles).toEqual([{ t: (t0 + 600) * 1000, o: 101, h: 101, l: 101, c: 101, v: 0 }]);
    // Daily charts are left alone (their last point is today's running bar).
    const daily = parseYahooChart(readMarketFixture("yahoo-1d-3mo-NSEI.json"), "^NSEI");
    expect(daily.candles.length).toBeGreaterThan(60);
  });

  it("returns no candles when the range holds no data", () => {
    const chart = parseYahooChart({ chart: { result: [{ meta: { symbol: "X" }, indicators: { quote: [{}] } }], error: null } }, "X");
    expect(chart.candles).toEqual([]);
    expect(chart.meta.regularMarketPrice).toBeNull();
  });

  it("throws descriptive errors on chart.error and malformed payloads", () => {
    expect(() =>
      parseYahooChart({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, "NOPE"),
    ).toThrow(/NOPE: Not Found: No data found/);
    expect(() => parseYahooChart({ foo: 1 }, "X")).toThrow(/unexpected response shape/);
    expect(() => parseYahooChart({ chart: { result: [], error: null } }, "X")).toThrow(/empty result/);
  });

  it("parses daily bars stamped at 09:15 IST", () => {
    const chart = parseYahooChart(readMarketFixture("yahoo-1d-3mo-NSEI.json"), "^NSEI");
    const oct1 = chart.candles.find((c) => istDate(c.t) === "2026-10-01");
    expect(oct1?.t).toBe(istAt("2026-10-01", "09:15"));
    expect(oct1?.c).toBeCloseTo(22421.95, 2);
    expect(chart.candles.some((c) => istDate(c.t) === "2026-10-02")).toBe(false);
  });
});

describe("fetchYahooChart", () => {
  it("builds range and period URLs with an encoded symbol", () => {
    expect(yahooChartUrl("^NSEI", { interval: "5m", range: "5d" })).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=5m&range=5d",
    );
    expect(yahooChartUrl("USDINR=X", { interval: "1d", period1: 1700000000.9, period2: 1700086400 })).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&period1=1700000000&period2=1700086400",
    );
    // period1 alone is rejected by Yahoo, so period2 defaults to a far-future "now".
    expect(yahooChartUrl("ES=F", { interval: "5m", period1: 1700000000 })).toContain("period1=1700000000&period2=9999999999");
  });

  it("sends a browser User-Agent and parses the response", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(readMarketFixtureText("yahoo-5m-5d-TNX.json"), { status: 200 });
    }) as unknown as typeof fetch;
    const chart = await fetchYahooChart("^TNX", { interval: "5m", range: "5d", fetchImpl });
    expect(calls[0].url).toBe("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=5m&range=5d");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("User-Agent")).toBe(YAHOO_USER_AGENT);
    expect(chart.candles.length).toBeGreaterThan(300);
    expect(chart.meta.regularMarketPrice).toBeCloseTo(5.305, 3);
  });

  it("throws with Yahoo's error description on non-200 responses", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ chart: { result: null, error: { code: "Unprocessable Entity", description: "The requested range must be within the last 60 days." } } }),
        { status: 422 },
      )) as unknown as typeof fetch;
    await expect(fetchYahooChart("^NSEI", { interval: "5m", range: "3mo", fetchImpl })).rejects.toThrow(
      /\^NSEI \(5m\): HTTP 422: Unprocessable Entity: The requested range must be within the last 60 days/,
    );
    const html = (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchYahooChart("^NSEI", { interval: "5m", fetchImpl: html })).rejects.toThrow(/HTTP 429: Too Many Requests/);
  });

  it("times out", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(fetchYahooChart("^NSEI", { interval: "5m", fetchImpl: hang, timeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
  });

  it("reports invalid JSON", async () => {
    const bad = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchYahooChart("^NSEI", { interval: "5m", fetchImpl: bad })).rejects.toThrow(/invalid JSON/);
  });
});
