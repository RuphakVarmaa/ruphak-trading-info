import { describe, expect, it } from "vitest";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { istAt, istDate } from "@/engine/clock";
import type { YahooChart } from "@/engine/market/yahooClient";
import type { Candle } from "@/engine/types";
import { recordedChart } from "./__fixtures__/liveFixtures";
import { buildNiftyFeed, checkedDayRange, niftySession, prevCloseFromBars, prevSessionClose } from "./niftyFeed";

const chart = (candles: Candle[], meta: Partial<YahooChart["meta"]> = {}): YahooChart => ({
  symbol: "^NSEI",
  candles,
  meta: { regularMarketPrice: null, previousClose: null, regularMarketTime: null, gmtoffset: 19800, ...meta },
});

/** Yahoo stamps ^NSEI daily bars at 09:15 IST. */
const day = (date: string, c: number): Candle => ({ t: istAt(date, "09:15"), o: c, h: c, l: c, c, v: 0 });

// ^NSEI 1d/1mo on 2026-10-08 after the close: 10-02 is a holiday and the 10-08 bar has a null close (dropped).
const DAILY = chart([day("2026-10-01", 22950.4), day("2026-10-05", 22555.75), day("2026-10-06", 22776.099609375), day("2026-10-07", 22603.05078125)]);

describe("prevSessionClose", () => {
  it("takes the last daily bar before the session, rounded to 2 decimals", () => {
    expect(prevSessionClose(DAILY, "2026-10-08")).toBe(22603.05);
    expect(prevSessionClose(DAILY, "2026-10-08", defaultCalendar)).toBe(22603.05);
    expect(prevSessionClose(DAILY, "2026-10-07", defaultCalendar)).toBe(22776.1);
    // Monday after a Friday holiday: Thursday's close.
    expect(prevSessionClose(DAILY, "2026-10-05", defaultCalendar)).toBe(22950.4);
    expect(prevSessionClose(DAILY, "2026-10-01")).toBeNull();
  });

  it("with a calendar, gives null rather than a close two sessions old while Yahoo lacks the prior bar", () => {
    expect(prevSessionClose(DAILY, "2026-10-09")).toBe(22603.05);
    expect(prevSessionClose(DAILY, "2026-10-09", defaultCalendar)).toBeNull();
  });
});

describe("buildNiftyFeed", () => {
  const bars = [
    { t: istAt("2026-10-08", "09:15"), o: 22599.05, h: 22599.05, l: 22560, c: 22570, v: 0 },
    { t: istAt("2026-10-08", "15:29"), o: 22231.8, h: 22231.8, l: 22231.8, c: 22231.8, v: 0 },
  ];
  // Yahoo's 1-minute meta.previousClose that day was 10-06's close (22776.1), two sessions back.
  const nifty = chart(bars, { regularMarketPrice: 22231.8, regularMarketTime: Math.floor(istAt("2026-10-08", "15:30") / 1000), previousClose: 22776.1 });
  const now = istAt("2026-10-08", "16:00");

  it("measures the change from the prior close it is given, not Yahoo's meta.previousClose", () => {
    expect(niftySession(nifty)).toBe("2026-10-08");
    const f = buildNiftyFeed(nifty, null, 22603.05, now, null)!;
    expect(f.prevClose).toBe(22603.05);
    expect(f.change).toBeCloseTo(-371.25, 2);
    expect(f.changePct).toBeCloseTo(-1.6425, 3);
    expect(f.session).toBe("2026-10-08");
    expect(f.open).toBe(22599.05);
  });

  it("leaves the change unknown without a prior close", () => {
    const f = buildNiftyFeed(nifty, null, null, now, null)!;
    expect(f).toMatchObject({ spot: 22231.8, prevClose: null, change: null, changePct: null });
  });
});

describe("prevCloseFromBars (the 5-minute fallback while the daily close is missing)", () => {
  const five = recordedChart("^NSEI 5m");

  it("takes the last bar of the previous trading day", () => {
    // Friday 2026-10-09: Thursday's 15:30 closing print. Thursday: Wednesday's last bar, which is its daily close.
    expect(prevCloseFromBars(five, "2026-10-09", defaultCalendar)).toBe(22231.8);
    expect(prevCloseFromBars(five, "2026-10-08", defaultCalendar)).toBe(22603.05);
    expect(prevCloseFromBars(recordedChart("^BSESN 5m"), "2026-10-09", defaultCalendar)).toBe(71593.24);
    expect(prevCloseFromBars(recordedChart("^INDIAVIX 5m"), "2026-10-09", defaultCalendar, 4)).toBe(15.275);
  });

  it("gives null when the last bar before the session is from two sessions back", () => {
    const noThursday = { ...five, candles: five.candles.filter((c) => istDate(c.t) < "2026-10-08") };
    expect(prevCloseFromBars(noThursday, "2026-10-09", defaultCalendar)).toBeNull();
    expect(prevCloseFromBars({ ...five, candles: [] }, "2026-10-09", defaultCalendar)).toBeNull();
  });

  it("looks past a holiday to the trading day before it", () => {
    // Monday 2026-10-05 after the Friday 2026-10-02 holiday: Thursday 2026-10-01 is the previous trading day.
    const bars = chart([
      { t: istAt("2026-10-01", "15:25"), o: 22420, h: 22430, l: 22410, c: 22421.94921875, v: 0 },
      { t: istAt("2026-10-05", "09:15"), o: 22532.4, h: 22540, l: 22520, c: 22530, v: 0 },
    ]);
    expect(prevCloseFromBars(bars, "2026-10-05", defaultCalendar)).toBe(22421.95);
  });
});

describe("day range", () => {
  // The recorded 2026-10-08 session: the bars' lowest low is 22,180.30; Yahoo's day low is 22,179.90.
  const recorded = recordedChart("^NSEI 1m");
  const now = istAt("2026-10-09", "00:41");

  it("prefers Yahoo's day range over the bars' extremes when it agrees with them", () => {
    expect(buildNiftyFeed(recorded, null, 22603.05, now, null)).toMatchObject({ high: 22599.05078125, low: 22180.30078125 });
    expect(buildNiftyFeed(recorded, null, 22603.05, now, null, { high: 22599.05, low: 22179.9 })).toMatchObject({ high: 22599.05, low: 22179.9 });
  });

  it("ignores a day range that leaves out the price or a close, or is for another day", () => {
    expect(checkedDayRange({ high: 110, low: 90 }, [95, 105], 100)).toEqual({ high: 110, low: 90 });
    expect(checkedDayRange({ high: 104, low: 90 }, [95, 105], 100)).toBeNull();
    expect(checkedDayRange({ high: 110, low: 101 }, [105], 100)).toBeNull();
    expect(checkedDayRange({ high: 90, low: 110 }, [], 100)).toBeNull();
    expect(checkedDayRange({ high: null, low: 90 }, [], 100)).toBeNull();
    expect(checkedDayRange(undefined, [], 100)).toBeNull();
    // A quote from the next day over the old bars: the range belongs to that day, not to the bars.
    const nextDay = { ...recorded, meta: { ...recorded.meta, regularMarketTime: Math.floor(istAt("2026-10-09", "09:08") / 1000) } };
    expect(buildNiftyFeed(nextDay, null, 22231.8, now, null, { high: 22599.05, low: 22179.9 })).toMatchObject({ low: 22180.30078125 });
  });
});
