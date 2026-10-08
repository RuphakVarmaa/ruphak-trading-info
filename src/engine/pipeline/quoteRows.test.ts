import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt, istDate } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { computeFeatures } from "../market/features";
import { loadMarketFixtures } from "../testing/fixtures";
import type { Candle, MarketSnapshot } from "../types";
import { quoteRows } from "./tradingCycle";

const bar = (date: string, hhmm: string, c: number): Candle => ({ t: istAt(date, hhmm), o: c, h: c, l: c, c, v: 0 });

describe("Desk quotes when Yahoo's daily chart lags a session (DF-2)", () => {
  // 9 Oct, 10:00 IST: the daily chart ends on 7 Oct (8 Oct's close was still null when it loaded),
  // while the 5-minute bars have all of 8 Oct.
  const snap: MarketSnapshot = {
    t: istAt("2026-10-09", "10:00"),
    candles: { "^NSEI": [bar("2026-10-08", "15:25", 25_100), bar("2026-10-09", "09:50", 25_290), bar("2026-10-09", "09:55", 25_300)] },
    daily: { "^NSEI": [bar("2026-10-06", "09:15", 24_900), bar("2026-10-07", "09:15", 25_000)] },
    ltp: { NIFTY: 25_300 },
    dataAgeSec: 60,
  };

  it("compares with the previous session's last 5-minute close, not an older daily close", () => {
    const nifty = quoteRows(snap).find((q) => q.key === "NIFTY")!;
    expect(nifty.price).toBe(25_300);
    expect(nifty.change).toBe(200);
    expect(nifty.changePct).toBeCloseTo((200 / 25_100) * 100, 6);
  });

  it("still prefers the daily close when the daily chart has that session", () => {
    const full = { ...snap, daily: { "^NSEI": [...snap.daily["^NSEI"], bar("2026-10-08", "09:15", 25_110)] } };
    expect(quoteRows(full).find((q) => q.key === "NIFTY")!.change).toBe(190);
  });
});

describe("decision inputs when the daily chart lags a session (DF-2)", () => {
  it("take the previous close from the 5-minute bars, so they do not change", () => {
    const fx = loadMarketFixtures();
    const t = istAt("2026-10-07", "11:00");
    const prevDate = "2026-10-06";
    const full: MarketSnapshot = { t, candles: fx.candles, daily: fx.daily, ltp: {}, dataAgeSec: 0 };
    const lagging: MarketSnapshot = {
      ...full,
      daily: Object.fromEntries(Object.entries(fx.daily).map(([k, v]) => [k, v.filter((c) => istDate(c.t) < prevDate)])),
    };
    for (const index of ["NIFTY", "SENSEX"] as const) {
      const a = computeFeatures(index, full, defaultCalendar, DEFAULT_CONFIG);
      const b = computeFeatures(index, lagging, defaultCalendar, DEFAULT_CONFIG);
      // The gap, the previous day's range and close, and spot come from the 5-minute bars.
      expect(b.indicators.prevDayClose).toBe(a.indicators.prevDayClose);
      expect(b.gapPct).toBe(a.gapPct);
      expect(b.spot).toBe(a.spot);
    }
  });
});
