import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, istDate, istMinutes } from "../clock";
import type { Candle } from "../types";
import { fixtureCandles5m, fixtureDaily, sessionFromCloses } from "../__fixtures__/market/loadFixtures";
import {
  BAR_5M_MS,
  barsOnDate,
  closedBars,
  dailyFromIntraday,
  istDateOf,
  istMinuteOfDay,
  lastAtOrBefore,
  mergeCandles,
  resample,
  sessionBars,
  sessionDates,
} from "./candles";

const cal = new TradingCalendar();
const nifty5m = fixtureCandles5m()["^NSEI"];

describe("IST integer helpers", () => {
  it("agree with clock.ts", () => {
    for (const t of [istAt("2026-10-07", "00:00"), istAt("2026-10-07", "09:15"), istAt("2026-10-07", "23:59"), Date.UTC(2026, 9, 7, 18, 30)]) {
      expect(istDateOf(t)).toBe(istDate(t));
      expect(istMinuteOfDay(t)).toBe(istMinutes(t));
    }
  });
});

describe("sessionBars", () => {
  it("keeps only [09:15, 15:30) IST bars on trading days", () => {
    const s = sessionBars(nifty5m, cal);
    // 4 sessions x 75 bars; Yahoo's 15:30 closing tick on 2026-10-07 is dropped.
    expect(s.length).toBe(300);
    expect(nifty5m.length).toBe(301);
    for (const c of s) {
      const m = istMinuteOfDay(c.t);
      expect(m).toBeGreaterThanOrEqual(555);
      expect(m).toBeLessThan(930);
      expect(cal.isTradingDay(istDate(c.t))).toBe(true);
    }
  });

  it("drops bars on holidays and outside hours even when they carry prices", () => {
    const bars: Candle[] = [
      { t: istAt("2026-10-02", "10:00"), o: 1, h: 1, l: 1, c: 1, v: 0 }, // holiday
      { t: istAt("2026-10-03", "10:00"), o: 1, h: 1, l: 1, c: 1, v: 0 }, // Saturday
      { t: istAt("2026-10-05", "09:10"), o: 1, h: 1, l: 1, c: 1, v: 0 }, // pre-open
      { t: istAt("2026-10-05", "09:15"), o: 2, h: 2, l: 2, c: 2, v: 0 },
      { t: istAt("2026-10-05", "15:25"), o: 3, h: 3, l: 3, c: 3, v: 0 },
      { t: istAt("2026-10-05", "15:30"), o: 4, h: 4, l: 4, c: 4, v: 0 }, // closing tick
    ];
    expect(sessionBars(bars, cal).map((c) => c.c)).toEqual([2, 3]);
  });
});

describe("point-in-time slicing", () => {
  it("closedBars uses the bar close time inclusively", () => {
    const bars = sessionFromCloses("2026-10-07", [10, 11, 12], 10);
    const t1005 = istAt("2026-10-07", "09:25");
    expect(closedBars(bars, t1005, BAR_5M_MS).map((c) => c.c)).toEqual([10, 11]);
    expect(closedBars(bars, t1005 - 1, BAR_5M_MS).map((c) => c.c)).toEqual([10]);
    expect(closedBars(bars, istAt("2026-10-07", "09:15"), BAR_5M_MS)).toEqual([]);
  });

  it("lastAtOrBefore searches by open time", () => {
    const bars = sessionFromCloses("2026-10-07", [10, 11, 12], 10);
    expect(lastAtOrBefore(bars, istAt("2026-10-07", "09:22"))?.c).toBe(11);
    expect(lastAtOrBefore(bars, istAt("2026-10-07", "09:20"))?.c).toBe(11);
    expect(lastAtOrBefore(bars, istAt("2026-10-07", "09:14"))).toBeNull();
    expect(lastAtOrBefore([], 0)).toBeNull();
  });

  it("barsOnDate and sessionDates use IST dates", () => {
    expect(sessionDates(nifty5m)).toEqual(["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(barsOnDate(nifty5m, "2026-10-06").length).toBe(75);
    expect(barsOnDate(nifty5m, "2026-10-02").length).toBe(0);
  });
});

describe("resample", () => {
  const day = sessionBars(barsOnDate(nifty5m, "2026-10-06"), cal);

  it("aligns 15-minute buckets to 09:15 IST", () => {
    const r = resample(day, 15);
    expect(r.length).toBe(25);
    expect(r[0].t).toBe(istAt("2026-10-06", "09:15"));
    expect(r[1].t).toBe(istAt("2026-10-06", "09:30"));
    const firstThree = day.slice(0, 3);
    expect(r[0].o).toBe(firstThree[0].o);
    expect(r[0].c).toBe(firstThree[2].c);
    expect(r[0].h).toBe(Math.max(...firstThree.map((c) => c.h)));
    expect(r[0].l).toBe(Math.min(...firstThree.map((c) => c.l)));
  });

  it("aligns hourly buckets to 09:15, 10:15, ... with a short last bucket", () => {
    const r = resample(day, 60);
    expect(r.map((c) => istMinutes(c.t))).toEqual([555, 615, 675, 735, 795, 855, 915]);
    expect(r[6].c).toBe(day[day.length - 1].c);
  });

  it("sums volume and is the identity for 5 minutes", () => {
    const bars = sessionFromCloses("2026-10-07", [1, 2, 3, 4], 1, 0, 10);
    expect(resample(bars, 10).map((c) => c.v)).toEqual([20, 20]);
    expect(resample(bars, 5)).toEqual(bars);
  });

  it("buckets bars from several days independently", () => {
    const two = sessionBars(nifty5m, cal).filter((c) => ["2026-10-05", "2026-10-06"].includes(istDate(c.t)));
    const r = resample(two, 30);
    expect(r.filter((c) => istDate(c.t) === "2026-10-05")[0].t).toBe(istAt("2026-10-05", "09:15"));
    expect(r.filter((c) => istDate(c.t) === "2026-10-06")[0].t).toBe(istAt("2026-10-06", "09:15"));
  });
});

describe("daily aggregation and merging", () => {
  it("dailyFromIntraday matches Yahoo's daily bars", () => {
    const daily = dailyFromIntraday(sessionBars(nifty5m, cal));
    expect(daily.map((c) => istDate(c.t))).toEqual(["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(daily.every((c) => istMinutes(c.t) === 555)).toBe(true);
    const yahooDaily = fixtureDaily()["^NSEI"];
    for (const d of daily.slice(0, 3)) {
      const y = yahooDaily.find((c) => c.t === d.t);
      expect(y).toBeDefined();
      expect(d.c).toBeCloseTo(y!.c, 1);
      expect(d.o).toBeCloseTo(y!.o, 1);
    }
  });

  it("mergeCandles unions by open time, later input wins, sorted", () => {
    const a = sessionFromCloses("2026-10-07", [1, 2, 3], 1);
    const b = [{ ...a[1], c: 20 }, ...sessionFromCloses("2026-10-06", [9], 9)];
    const m = mergeCandles(a, b);
    expect(m.map((c) => c.c)).toEqual([9, 1, 20, 3]);
  });
});
