import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, istAt, weekdayOf } from "../clock";
import { DEFAULT_CONFIG, makeConfig, validateConfig, withOverrides, type EngineConfig } from "../config";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type MarketSnapshot } from "../types";
import { closesBefore, minSessionsLeft, n2Blocks, n2Daily, n2DailyByIndex, n2DailyFor, n2Gate, n3Allows, n3Gate, N2_MIN_PCTILE_CLOSES, positionExitByMs } from "./rules";

const calendar = new TradingCalendar();
const TODAY = "2026-10-07";

/** Daily bars (09:15 IST stamps) for the trading days before `today`, oldest first, with the given closes. */
function dailyBefore(today: string, closes: number[]): Candle[] {
  const dates: string[] = [];
  let d = today;
  while (dates.length < closes.length) {
    d = addDays(d, -1);
    if (weekdayOf(d) <= 5) dates.unshift(d);
  }
  return dates.map((date, i) => ({ t: istAt(date, "09:15"), o: closes[i], h: closes[i], l: closes[i], c: closes[i], v: 0 }));
}

const on = makeConfig({ rules: { n2: { enabled: true }, n3: { enabled: true }, n4: { enabled: true } } });
/** 300 flat VIX closes at 15 followed by `tail`. */
const vixSeries = (tail: number[]) => [...Array(300).fill(15), ...tail];
const flatIndex = dailyBefore(TODAY, Array(30).fill(24_000));

describe("N2: no entry after a volatility jump or a big run", () => {
  it("uses only closes before today, one per date", () => {
    const bars = [...dailyBefore(TODAY, [10, 11, 12]), { t: istAt(TODAY, "09:15"), o: 99, h: 99, l: 99, c: 99, v: 0 }, { t: istAt("2026-10-06", "09:15"), o: 13, h: 13, l: 13, c: 13, v: 0 }];
    expect(closesBefore(bars, TODAY).map((x) => x.c)).toEqual([10, 11, 13]);
  });

  it("measures the 5-session VIX change, the VIX percentile and the 5-session run as the evidence did", () => {
    const vix = dailyBefore(TODAY, vixSeries([15, 15, 15, 15, 15, 16.8]));
    const idx = dailyBefore(TODAY, [...Array(25).fill(24_000), 24_000, 24_100, 24_200, 24_300, 24_400, 24_500]);
    const d = n2Daily(vix, idx, TODAY, on)!;
    expect(d.lastSession).toBe("2026-10-06");
    expect(d.vix5dChangePct).toBeCloseTo(12, 9); // 16.8 / 15 - 1
    expect(d.vixPctile).toBe(1); // above every prior close in the window
    expect(d.vixPctileN).toBe(251); // a 252-close window, the current one included
    expect(d.run5dPct).toBeCloseTo(Math.log(24_500 / 24_000) * 100, 9);
    expect(n2Blocks(d, 0, on)).toHaveLength(3);
  });

  it("blocks each condition on its own, strictly above the plan's thresholds", () => {
    const quiet = n2Daily(dailyBefore(TODAY, vixSeries([15])), flatIndex, TODAY, on)!;
    expect(quiet.vixPctile).toBe(0);
    expect(n2Blocks(quiet, 0, on)).toEqual([]);
    expect(n2Gate(quiet, { vixChangePct: 1 }, on)).toMatchObject({ gate: "vol_jump", passed: true });
    // On the day: more than 8% (the EVENT regime's measure), not 8% itself.
    expect(n2Blocks(quiet, 8, on)).toEqual([]);
    expect(n2Blocks(quiet, 8.01, on)[0]).toMatch(/today/);
    // Five sessions: more than 10%.
    const fiveDay = (last: number) => n2Blocks(n2Daily(dailyBefore(TODAY, [...Array(196).fill(15), 15, 15, 15, 15, 15, last]), flatIndex, TODAY, on), 0, on).some((r) => /^VIX .* over 5 sessions/.test(r));
    expect(fiveDay(16.49)).toBe(false);
    expect(fiveDay(16.51)).toBe(true);
    // Top third of the year by percentile rank (> 2/3).
    const ramp = Array.from({ length: 252 }, (_, i) => 10 + i * 0.01);
    const high = n2Daily(dailyBefore(TODAY, [...ramp.slice(0, 251), 10 + 0.7 * 2.51]), flatIndex, TODAY, on)!;
    expect(high.vixPctile).toBeGreaterThan(2 / 3);
    expect(n2Blocks(high, 0, on).some((r) => /percentile/.test(r))).toBe(true);
    const mid = n2Daily(dailyBefore(TODAY, [...ramp.slice(0, 251), 10 + 0.6 * 2.51]), flatIndex, TODAY, on)!;
    expect(n2Blocks(mid, 0, on)).toEqual([]);
    // A 2% run in either direction.
    const down = n2Daily(dailyBefore(TODAY, vixSeries([15])), dailyBefore(TODAY, [...Array(25).fill(24_000), 24_000, 23_900, 23_800, 23_700, 23_600, 23_500]), TODAY, on)!;
    expect(n2Blocks(down, 0, on)).toEqual(["index -2.11% over 5 sessions (beyond ±2%)"]);
  });

  it("fails closed without enough history", () => {
    expect(n2Blocks(null, 0, on)).toEqual(["no India VIX history"]);
    const short = n2Daily(dailyBefore(TODAY, Array(N2_MIN_PCTILE_CLOSES - 1).fill(15)), flatIndex, TODAY, on)!;
    expect(short.vixPctile).toBeNull();
    expect(n2Gate(short, { vixChangePct: 0 }, on)).toMatchObject({ passed: false });
    expect(n2Blocks(n2Daily(dailyBefore(TODAY, Array(N2_MIN_PCTILE_CLOSES).fill(15)), flatIndex, TODAY, on), 0, on)).toEqual([]);
  });

  it("reads the daily bars once per index and day", async () => {
    let calls = 0;
    const snap: MarketSnapshot = { t: 0, candles: {}, daily: { [MARKET_SYMBOLS.INDIAVIX]: dailyBefore(TODAY, vixSeries([15])), [MARKET_SYMBOLS.NIFTY]: flatIndex }, ltp: {}, dataAgeSec: 0 };
    const market: MarketDataSource = {
      snapshot: async () => {
        calls++;
        return snap;
      },
    } as MarketDataSource;
    const a = await n2DailyFor(market, "NIFTY", istAt(TODAY, "10:00"), "2026-10-06", on);
    const b = await n2DailyFor(market, "NIFTY", istAt(TODAY, "13:00"), "2026-10-06", on);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await n2DailyFor(market, "SENSEX", istAt(TODAY, "10:00"), "2026-10-06", on);
    expect(calls).toBe(2);
    expect(await n2DailyFor(undefined, "NIFTY", istAt(TODAY, "10:00"), null, on)).toBeNull();
  });

  it("stores each index's inputs with the snapshot, whether or not N2 is on, and never throws", () => {
    const snap = { daily: { [MARKET_SYMBOLS.INDIAVIX]: dailyBefore(TODAY, vixSeries([15])), [MARKET_SYMBOLS.NIFTY]: flatIndex } };
    const t = istAt(TODAY, "10:00");
    const byIndex = n2DailyByIndex(snap, ["NIFTY", "SENSEX"], t, DEFAULT_CONFIG);
    expect(byIndex.NIFTY).toEqual(n2Daily(snap.daily[MARKET_SYMBOLS.INDIAVIX], flatIndex, TODAY, DEFAULT_CONFIG));
    expect(byIndex.SENSEX).toMatchObject({ lastSession: "2026-10-06", run5dPct: null }); // VIX known, no SENSEX closes
    expect(n2DailyByIndex({ daily: {} }, ["NIFTY"], t, DEFAULT_CONFIG)).toEqual({ NIFTY: null });
    // A config without the rules block (never built by makeConfig) gives "no data" instead of breaking the tick.
    const broken = { ...DEFAULT_CONFIG, rules: undefined } as unknown as EngineConfig;
    expect(n2DailyByIndex(snap, ["NIFTY", "SENSEX"], t, broken)).toEqual({ NIFTY: null, SENSEX: null });
  });
});

describe("N3: morning only", () => {
  it("allows new entries from 09:30 until (not at) 11:15", () => {
    const at = (hhmm: string, s = 30) => istAt(TODAY, hhmm) + s * 1000;
    expect(n3Allows(at("09:26"), on)).toBe(false);
    expect(n3Allows(at("09:31"), on)).toBe(true);
    expect(n3Allows(at("11:11"), on)).toBe(true);
    expect(n3Allows(at("11:16"), on)).toBe(false);
    expect(n3Gate(at("09:26"), on)).toMatchObject({ gate: "morning_only", passed: false, detail: "too early" });
    expect(n3Gate(at("12:01"), on)).toMatchObject({ passed: false, detail: "after the morning window" });
  });

  it("closes positions at 11:15 when on, at the square-off otherwise", () => {
    const t = istAt(TODAY, "09:31");
    expect(positionExitByMs(t, on)).toBe(istAt(TODAY, "11:15"));
    expect(positionExitByMs(t, DEFAULT_CONFIG)).toBe(istAt(TODAY, "15:05"));
  });
});

describe("N4 and the rule switches", () => {
  it("needs two sessions to expiry when on, one otherwise", () => {
    expect(minSessionsLeft(DEFAULT_CONFIG)).toBe(1);
    expect(minSessionsLeft(on)).toBe(2);
  });

  it("is off by default and validated", () => {
    expect(DEFAULT_CONFIG.rules.n2.enabled || DEFAULT_CONFIG.rules.n3.enabled || DEFAULT_CONFIG.rules.n4.enabled).toBe(false);
    expect(DEFAULT_CONFIG.selection.itmSteps).toBe(0);
    expect(validateConfig(on)).toEqual([]);
    expect(() => withOverrides(DEFAULT_CONFIG, { rules: { n3: { entryFromIst: "11:30" } } })).toThrow(/entryFromIst must be before exitByIst/);
    expect(() => withOverrides(DEFAULT_CONFIG, { rules: { n3: { exitByIst: "15:20" } } })).toThrow(/after exits.squareOffIst/);
    expect(() => withOverrides(DEFAULT_CONFIG, { rules: { n4: { minSessionsLeft: 0 } } })).toThrow(/minSessionsLeft/);
    expect(() => withOverrides(DEFAULT_CONFIG, { rules: { n2: { vixPctileAbove: 1.5 } } })).toThrow(/vixPctileAbove/);
    expect(() => withOverrides(DEFAULT_CONFIG, { selection: { itmSteps: 1.5 } })).toThrow(/itmSteps/);
    expect(() => withOverrides(DEFAULT_CONFIG, { strategy: { firstCandle: { rangeMin: 12 } } })).toThrow(/firstCandle.rangeMin/);
    expect(calendar.isTradingDay(TODAY)).toBe(true);
  });
});
