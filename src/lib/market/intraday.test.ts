import { describe, expect, it } from "vitest";
import { istAt } from "@/engine/clock";
import type { YahooChart } from "@/engine/market/yahooClient";
import type { Candle } from "@/engine/types";
import { buildIntraday } from "./intraday";

const bar = (date: string, hm: string, o: number, h: number, l: number, c: number): Candle => ({ t: istAt(date, hm), o, h, l, c, v: 0 });

const chart = (candles: Candle[], meta: Partial<YahooChart["meta"]> = {}): YahooChart => ({
  symbol: "^NSEI",
  candles,
  meta: { regularMarketPrice: null, previousClose: null, regularMarketTime: null, gmtoffset: 19800, ...meta },
});

const day1 = [bar("2026-10-08", "15:25", 25_190, 25_210, 25_180, 25_200)];
const day2 = [
  bar("2026-10-09", "09:15", 25_150, 25_160, 25_100, 25_120),
  bar("2026-10-09", "09:20", 25_120, 25_140, 25_090, 25_100),
  bar("2026-10-09", "09:25", 25_100, 25_130, 25_070, 25_080),
  bar("2026-10-09", "09:30", 25_080, 25_090, 25_040, 25_050),
];

describe("buildIntraday", () => {
  it("takes the latest session, with VWAP, the opening range and the previous close", () => {
    const f = buildIntraday("NIFTY", chart([...day1, ...day2]), null)!;
    expect(f.session).toBe("2026-10-09");
    expect(f.candles.map((c) => c.c)).toEqual([25_120, 25_100, 25_080, 25_050]);
    expect(f.openingRange).toEqual({ high: 25_160, low: 25_070, complete: true });
    expect(f.prevClose).toBe(25_200);
    // Equal-weighted typical price while Yahoo reports no volume.
    expect(f.vwap[0]).toBeCloseTo((25_160 + 25_100 + 25_120) / 3, 2);
    expect(f.vwap).toHaveLength(4);
    expect(f.last).toBe(25_050);
    expect(f.asOf).toBe("2026-10-09T09:35:00+05:30");
  });

  it("uses Yahoo's last trade for today and marks a forming opening range", () => {
    const now = istAt("2026-10-09", "09:22");
    const f = buildIntraday("NIFTY", chart([...day1, ...day2.slice(0, 2)], { regularMarketPrice: 25_095.5, regularMarketTime: Math.floor(now / 1000) }), null)!;
    expect(f.last).toBe(25_095.5);
    expect(f.asOf).toBe("2026-10-09T09:22:00+05:30");
    expect(f.openingRange?.complete).toBe(false);
  });

  it("serves an earlier session by date, and nothing for a day without bars", () => {
    const f = buildIntraday("NIFTY", chart([...day1, ...day2]), "2026-10-08")!;
    expect(f.candles).toHaveLength(1);
    expect(f.prevClose).toBeNull();
    expect(buildIntraday("NIFTY", chart([...day1, ...day2]), "2026-10-07")).toBeNull();
    expect(buildIntraday("NIFTY", chart([]), null)).toBeNull();
  });

  it("clips bad wicks the way the engine does", () => {
    const spike = [bar("2026-10-09", "09:15", 25_000, 25_000 * 1.01, 24_990, 25_010)];
    const f = buildIntraday("NIFTY", chart(spike), null)!;
    expect(f.candles[0].h).toBeCloseTo(25_010 * 1.003, 1);
  });
});
