import { describe, expect, it } from "vitest";
import { istAt } from "@/engine/clock";
import { parseYahooChart } from "@/engine/market/yahooClient";
import { chartJson, recordedBars } from "./__fixtures__/liveFixtures";
import { buildLiveIndex } from "./liveFeed";
import { barsSince, freshnessOf, IDLE_POLL_MS, LIVE_POLL_MS, mergeBars, openingRangeOf, runningVwap, SINCE_OVERLAP_MS, sinceFor, type LiveIndicesFeed } from "./liveIndices";

/** The recorded 2026-10-08 session as served at `hm`, both indices. */
function feedAt(hm: string): LiveIndicesFeed {
  const index = (id: "NIFTY" | "SENSEX", symbol: string, prev: number) => {
    const bars = recordedBars(`${symbol} 1m`).filter((b) => b.t <= istAt("2026-10-08", hm));
    const meta = { regularMarketPrice: bars[bars.length - 1].c, regularMarketTime: Math.floor(istAt("2026-10-08", hm) / 1000) + 30 };
    return buildLiveIndex(id, { chart: parseYahooChart(chartJson(symbol, "1m", bars, meta), symbol), dayHigh: null, dayLow: null }, prev)!;
  };
  const at = new Date(istAt("2026-10-08", hm) + 31_000).toISOString();
  return {
    indices: [index("NIFTY", "^NSEI", 22603.05), index("SENSEX", "^BSESN", 72638.7)],
    vix: null,
    marketPhase: "OPEN",
    source: "Yahoo Finance",
    generatedAt: at,
    fetchedAt: at,
    stale: false,
    missing: [],
  };
}

describe("updates since a time", () => {
  it("asks from 5 minutes before the last bar, and the server cut joins back to the full session", () => {
    const before = feedAt("11:00");
    const since = sinceFor(before)!;
    expect(since).toBe(istAt("2026-10-08", "11:00") - SINCE_OVERLAP_MS);

    const server = feedAt("11:07");
    const update = barsSince(server, since);
    expect(update.indices[0].barsFrom).toBe(since);
    expect(update.indices[0].bars.map((b) => b.t)).toEqual(Array.from({ length: 13 }, (_, i) => istAt("2026-10-08", "10:55") + i * 60_000));
    expect(JSON.stringify(update).length).toBeLessThan(JSON.stringify(server).length / 5);

    const joined = mergeBars(before, update)!;
    expect(joined).toEqual(server);
    expect(joined.indices.every((i) => i.barsFrom === undefined)).toBe(true);
  });

  it("sends the whole session when `since` is from another day, and refuses to join without earlier bars", () => {
    const server = feedAt("11:07");
    const otherDay = barsSince(server, istAt("2026-10-07", "15:25"));
    expect(otherDay).toEqual(server);
    expect(mergeBars(null, otherDay)).toBe(otherDay);

    const update = barsSince(server, istAt("2026-10-08", "10:55"));
    expect(mergeBars(null, update)).toBeNull();
    expect(mergeBars({ ...feedAt("11:00"), indices: feedAt("11:00").indices.slice(0, 1) }, update)).toBeNull();
    expect(mergeBars({ ...feedAt("11:00"), indices: feedAt("11:00").indices.map((i) => ({ ...i, session: "2026-10-07" })) }, update)).toBeNull();
  });

  it("asks for everything without a full previous feed", () => {
    expect(sinceFor(null)).toBeNull();
    expect(sinceFor({ ...feedAt("11:00"), missing: ["SENSEX"] })).toBeNull();
    expect(sinceFor({ ...feedAt("11:00"), indices: feedAt("11:00").indices.map((i) => ({ ...i, bars: [] })) })).toBeNull();
  });
});

describe("pure helpers", () => {
  it("freshness from the last good response", () => {
    expect(freshnessOf(null, 1)).toBe("loading");
    expect(freshnessOf(0, 10_000)).toBe("live");
    expect(freshnessOf(0, 10_001)).toBe("stale");
    expect(freshnessOf(0, 60_001)).toBe("offline");
  });

  it("does not call a feed stale between its own 30-second polls while the market is closed", () => {
    expect(freshnessOf(0, 29_000, IDLE_POLL_MS)).toBe("live");
    expect(freshnessOf(0, 38_500, IDLE_POLL_MS)).toBe("live");
    expect(freshnessOf(0, 38_501, IDLE_POLL_MS)).toBe("stale");
    expect(freshnessOf(0, 88_501, IDLE_POLL_MS)).toBe("offline");
    expect(freshnessOf(0, 10_001, LIVE_POLL_MS)).toBe("stale");
  });

  it("running VWAP and the opening range", () => {
    const t = (hm: string) => istAt("2026-10-08", hm);
    const bars = [
      { t: t("09:15"), o: 10, h: 12, l: 9, c: 11 },
      { t: t("09:29"), o: 11, h: 14, l: 10, c: 13 },
      { t: t("09:30"), o: 13, h: 20, l: 1, c: 15 },
    ];
    expect(runningVwap(bars)).toEqual([32 / 3, (32 / 3 + 37 / 3) / 2, (32 / 3 + 37 / 3 + 12) / 3]);
    expect(openingRangeOf(bars, "2026-10-08")).toEqual({ high: 14, low: 9 });
    expect(openingRangeOf(bars.slice(0, 2), "2026-10-08")).toBeNull();
  });
});
