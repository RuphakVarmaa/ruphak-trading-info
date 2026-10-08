import { describe, expect, it } from "vitest";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { istAt } from "@/engine/clock";
import { parseYahooChart } from "@/engine/market/yahooClient";
import { bar, chartJson, recordedBars, recordedChart } from "./__fixtures__/liveFixtures";
import { barsSession, buildLiveIndex, buildLiveVix, dayRange, quoteSession, sessionBars, type LiveChart } from "./liveFeed";
import { openingRangeOf, runningVwap, typicalPrice } from "./liveIndices";
import { prevSessionClose } from "./niftyFeed";

/** Yahoo's day range from the recorded meta (the parser drops it). */
const live = (key: string, dayHigh: number | null, dayLow: number | null): LiveChart => ({ chart: recordedChart(key), dayHigh, dayLow });

const NIFTY = live("^NSEI 1m", 22599.05, 22179.9);
const SENSEX = live("^BSESN 1m", 72693.97, 71327.75);

describe("recorded 2026-10-08 session (read before the next open)", () => {
  it("takes the previous close from the daily chart, not the 1-minute meta.previousClose", () => {
    expect(recordedChart("^NSEI 1m").meta.previousClose).toBe(22776.1); // the 2026-10-06 close: two sessions back
    expect(quoteSession(NIFTY.chart)).toBe("2026-10-08");
    expect(prevSessionClose(recordedChart("^NSEI 1d"), "2026-10-08", defaultCalendar)).toBe(22603.05);
    expect(prevSessionClose(recordedChart("^BSESN 1d"), "2026-10-08", defaultCalendar)).toBe(72638.7);
    expect(prevSessionClose(recordedChart("^INDIAVIX 1d"), "2026-10-08", defaultCalendar)).toBe(13.89);
  });

  it("builds NIFTY 50: close 22,231.80 against 22,603.05", () => {
    const n = buildLiveIndex("NIFTY", NIFTY, 22603.05)!;
    expect(n).toMatchObject({
      index: "NIFTY",
      label: "NIFTY 50",
      symbol: "^NSEI",
      price: 22231.8,
      prevClose: 22603.05,
      change: -371.25,
      changePct: -1.642,
      open: 22599.05,
      high: 22599.05,
      low: 22179.9,
      session: "2026-10-08",
      asOf: "2026-10-08T15:31:53+05:30",
      openingRange: { high: 22599.05, low: 22475.85 },
    });
    expect(n.bars).toHaveLength(376);
    expect(n.bars[0]).toEqual({ t: istAt("2026-10-08", "09:15"), o: 22599.05, h: 22599.05, l: 22521.7, c: 22526.95 });
    expect(n.bars.at(-1)).toEqual({ t: istAt("2026-10-08", "15:30"), o: 22231.8, h: 22231.8, l: 22231.8, c: 22231.8 });
    // VWAP: the mean typical price of the returned bars.
    const mean = n.bars.reduce((s, b) => s + (b.h + b.l + b.c) / 3, 0) / n.bars.length;
    expect(n.vwap).toBe(Math.round(mean * 100) / 100);
    expect(n.vwap).toBeCloseTo(22339.59, 1);
  });

  it("uses Yahoo's day range over a bad 1-minute print (SENSEX 15:25 low 71,188.60)", () => {
    const s = buildLiveIndex("SENSEX", SENSEX, 72638.7)!;
    expect(Math.min(...s.bars.map((b) => b.l))).toBe(71188.6);
    expect(s).toMatchObject({ label: "SENSEX", symbol: "^BSESN", price: 71593.24, change: -1045.46, changePct: -1.439, high: 72693.97, low: 71327.75 });
    expect(s.openingRange).toEqual({ high: 72693.97, low: 72254.23 });
    // Without Yahoo's day range, the bars' extremes.
    expect(buildLiveIndex("SENSEX", { ...SENSEX, dayHigh: null, dayLow: null }, 72638.7)).toMatchObject({ high: 72693.97, low: 71188.6 });
  });

  it("builds India VIX to 4 decimals", () => {
    expect(buildLiveVix(recordedChart("^INDIAVIX 1m"), 13.89)).toEqual({
      price: 15.275,
      prevClose: 13.89,
      change: 1.385,
      changePct: 9.971,
      asOf: "2026-10-08T15:42:54+05:30",
    });
    expect(buildLiveVix(recordedChart("^INDIAVIX 1m"), null)).toMatchObject({ price: 15.275, prevClose: null, change: null, changePct: null });
  });
});

describe("the session in progress", () => {
  const upTo = (hm: string) => recordedBars("^NSEI 1m").filter((b) => b.t <= istAt("2026-10-08", hm));
  const at = (hm: string, s: number) => Math.floor(istAt("2026-10-08", hm) / 1000) + s;
  const midSession = (hm: string, s = 40): LiveChart => {
    const bars = upTo(hm);
    const last = bars[bars.length - 1].c!;
    const chart = parseYahooChart(chartJson("^NSEI", "1m", bars, { regularMarketPrice: last, regularMarketTime: at(hm, s) }), "^NSEI");
    const highs = bars.map((b) => b.h!);
    const lows = bars.map((b) => b.l!);
    return { chart, dayHigh: Math.max(...highs), dayLow: Math.min(...lows) };
  };

  it("has no opening range until a bar at or after 09:30 is in", () => {
    const early = buildLiveIndex("NIFTY", midSession("09:29"), 22603.05)!;
    expect(early.bars).toHaveLength(15);
    expect(early.openingRange).toBeNull();
    expect(early.vwap).not.toBeNull();
    expect(early.asOf).toBe("2026-10-08T09:29:40+05:30");
    const later = buildLiveIndex("NIFTY", midSession("09:30"), 22603.05)!;
    expect(later.openingRange).toEqual({ high: 22599.05, low: 22475.85 });
  });

  it("keeps the VWAP as the running mean of typical prices", () => {
    const n = buildLiveIndex("NIFTY", midSession("09:17"), 22603.05)!;
    const tp = n.bars.map(typicalPrice);
    expect(runningVwap(n.bars)).toEqual([tp[0], (tp[0] + tp[1]) / 2, (tp[0] + tp[1] + tp[2]) / 3]);
    expect(n.vwap).toBe(Math.round(((tp[0] + tp[1] + tp[2]) / 3) * 100) / 100);
    expect(n).toMatchObject({ open: 22599.05, high: 22599.05, low: 22521.7, price: 22545.9, change: -57.15 });
  });
});

describe("edges", () => {
  it("reads the previous session's bars before the open, and falls back from a day range that disagrees", () => {
    // Before a bar of the new day exists, Yahoo still serves the last session; a quote from the new day
    // (if Yahoo posted one) belongs to that day, so its range and change cannot come from the old bars' meta.
    const old = recordedBars("^NSEI 1m");
    const chart = parseYahooChart(chartJson("^NSEI", "1m", old, { regularMarketPrice: 22250, regularMarketTime: Math.floor(istAt("2026-10-09", "09:08") / 1000) }), "^NSEI");
    expect(barsSession(chart)).toBe("2026-10-08");
    expect(quoteSession(chart)).toBe("2026-10-09");
    const n = buildLiveIndex("NIFTY", { chart, dayHigh: 22260, dayLow: 22240 }, 22231.8)!;
    expect(n).toMatchObject({ session: "2026-10-08", price: 22250, prevClose: 22231.8, change: 18.2, high: 22599.05, low: 22180.3 });
    expect(n.bars).toHaveLength(376);
  });

  it("keeps only 09:15-15:30 bars of the session and drops bad rows", () => {
    const chart = parseYahooChart(
      chartJson("^NSEI", "1m", [bar("2026-10-08", "09:14", 100), bar("2026-10-08", "09:15", 101), bar("2026-10-08", "09:16", null), bar("2026-10-08", "15:30", 102), bar("2026-10-08", "15:31", 103)]),
      "^NSEI",
    );
    expect(sessionBars(chart, "2026-10-08").map((b) => b.c)).toEqual([101, 102]);
  });

  it("gives no index without a price, and no change without a previous close", () => {
    const empty = parseYahooChart(chartJson("^NSEI", "1m", []), "^NSEI");
    expect(buildLiveIndex("NIFTY", { chart: empty, dayHigh: null, dayLow: null }, 22603.05)).toBeNull();
    const n = buildLiveIndex("NIFTY", NIFTY, null)!;
    expect(n).toMatchObject({ price: 22231.8, prevClose: null, change: null, changePct: null });
    expect(buildLiveIndex("NIFTY", NIFTY, Number.NaN)!.prevClose).toBeNull();
  });

  it("opening range needs bars in the 09:15-09:29 window", () => {
    const late = [bar("2026-10-08", "09:40", 1), bar("2026-10-08", "09:41", 2)].map((b) => ({ t: b.t, o: 1, h: 2, l: 1, c: 2 }));
    expect(openingRangeOf(late, "2026-10-08")).toBeNull();
  });

  it("day range: Yahoo's when it holds the price and every close, else the bars'", () => {
    const bars = [
      { t: 1, o: 10, h: 12, l: 9, c: 11 },
      { t: 2, o: 11, h: 13, l: 10, c: 12 },
    ];
    const src = (dayHigh: number | null, dayLow: number | null): LiveChart => ({ chart: parseYahooChart(chartJson("^NSEI", "1m", []), "^NSEI"), dayHigh, dayLow });
    expect(dayRange(src(13.5, 8.5), bars, 12, true)).toEqual({ high: 13.5, low: 8.5 });
    expect(dayRange(src(11.5, 8.5), bars, 12, true)).toEqual({ high: 13, low: 9 }); // a close above Yahoo's high
    expect(dayRange(src(13.5, 8.5), bars, 12, false)).toEqual({ high: 13, low: 9 }); // another day's range
    expect(dayRange(src(null, null), [], 12, true)).toBeNull();
  });
});
