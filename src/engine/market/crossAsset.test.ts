import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { GLOBAL_KEYS, MARKET_SYMBOLS, type Candle, type GlobalKey, type MarketSnapshot } from "../types";
import { fixtureCandles5m, fixtureDaily, mulberry32 } from "../__fixtures__/market/loadFixtures";
import {
  dailyFinalAfterMs,
  expectedGapPct,
  fitGapBetas,
  GLOBAL_SYMBOL,
  globalMoves,
  overnightObservations,
  pricePointAtOrBefore,
  type GapObservation,
} from "./crossAsset";

const cal = new TradingCalendar();
const bar = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 0 });
const snap = (t: number, candles: Record<string, Candle[]>, daily: Record<string, Candle[]> = {}): MarketSnapshot => ({
  t,
  candles,
  daily,
  ltp: {},
  dataAgeSec: 0,
});

describe("GLOBAL_SYMBOL", () => {
  it("maps every global key to its Yahoo symbol", () => {
    expect(Object.keys(GLOBAL_SYMBOL).sort()).toEqual([...GLOBAL_KEYS].sort());
    expect(GLOBAL_SYMBOL.US10Y).toBe("^TNX");
    expect(GLOBAL_SYMBOL.SSE).toBe(MARKET_SYMBOLS.SSE);
  });
});

describe("globalMoves", () => {
  const from = istAt("2026-10-06", "15:30");
  const to = istAt("2026-10-07", "09:15");

  it("returns percent moves, US10Y in basis points, null when missing", () => {
    const s = snap(to, {
      "ES=F": [bar(istAt("2026-10-06", "15:25"), 5000), bar(istAt("2026-10-07", "09:10"), 5050)],
      "^TNX": [bar(istAt("2026-10-06", "01:00"), 4.2), bar(istAt("2026-10-07", "01:00"), 4.27)],
    });
    const m = globalMoves(s, from, to);
    expect(m.ES).toBeCloseTo(1, 12);
    expect(m.US10Y).toBeCloseTo(7, 9);
    expect(m.NQ).toBeNull();
    expect(Object.keys(m).sort()).toEqual([...GLOBAL_KEYS].sort());
  });

  it("matches values computed independently from the recorded Yahoo bars", () => {
    const s = snap(istAt("2026-10-07", "11:00"), fixtureCandles5m());
    const m = globalMoves(s, from, to);
    // Reference values from a separate Python scan of the raw JSON (last bar closed by each time).
    expect(m.ES).toBeCloseTo(0.4494310394288048, 9);
    expect(m.BZ).toBeCloseTo(3.168802331498366, 9);
    expect(m.USDINR).toBeCloseTo(-0.0337070917030724, 9);
    expect(m.US10Y).toBeCloseTo(-4.199981689453125, 6);
    for (const k of ["NQ", "CL", "GC", "DXY", "VIXUS", "N225", "HSI", "SSE"] as GlobalKey[]) expect(m[k]).toBeNull();
    expect(expectedGapPct(m, DEFAULT_CONFIG.features.gapBetas)).toBeCloseTo(0.294804422192102, 6);
  });

  it("only uses 5m bars closed by the requested time", () => {
    const s = snap(istAt("2026-10-07", "10:00"), {
      "ES=F": [
        bar(istAt("2026-10-06", "15:25"), 100),
        bar(istAt("2026-10-07", "09:10"), 101),
        bar(istAt("2026-10-07", "09:15"), 150), // closes 09:20, after `to`
        bar(istAt("2026-10-07", "09:20"), 151),
      ],
    });
    expect(globalMoves(s, from, to).ES).toBeCloseTo(1, 12);
  });

  it("uses the running close of a still-forming newest bar (live data)", () => {
    const now = istAt("2026-10-07", "10:02");
    const s = snap(now, { "ES=F": [bar(istAt("2026-10-06", "15:25"), 100), bar(istAt("2026-10-07", "09:55"), 101), bar(istAt("2026-10-07", "10:00"), 102)] });
    expect(globalMoves(s, from, now).ES).toBeCloseTo(2, 12);
  });

  it("falls back to daily closes once they are final", () => {
    // ES daily bars are stamped 00:00 New York (09:30 IST) and settle by 17:00 New York.
    const daily = {
      "ES=F": [bar(istAt("2026-10-05", "09:30"), 100), bar(istAt("2026-10-06", "09:30"), 102), bar(istAt("2026-10-07", "09:30"), 999)],
    };
    const m = globalMoves(snap(to, {}, daily), from, to);
    expect(m.ES).toBeCloseTo(2, 12);
    expect(dailyFinalAfterMs("ES=F")).toBe(18 * 3_600_000);
    expect(dailyFinalAfterMs("UNKNOWN")).toBe(24 * 3_600_000);
  });

  it("reports 0 for an asset that did not trade in between (holiday)", () => {
    // Shanghai is closed for Golden Week: its last bar predates both instants.
    const s = snap(to, { "000001.SS": [bar(istAt("2026-09-30", "12:25"), 3842)] });
    expect(globalMoves(s, from, to).SSE).toBe(0);
  });

  it("prefers the fresher of 5m and daily observations", () => {
    const T = istAt("2026-10-07", "09:15");
    const stale5m = [bar(istAt("2026-10-03", "02:00"), 90)];
    const daily = [bar(istAt("2026-10-06", "09:30"), 95)];
    const p = pricePointAtOrBefore(stale5m, daily, T, dailyFinalAfterMs("ES=F"));
    expect(p).toMatchObject({ price: 95, source: "daily" });
    expect(pricePointAtOrBefore(undefined, undefined, T)).toBeNull();
  });
});

describe("expectedGapPct", () => {
  it("sums beta * move over known moves only", () => {
    const moves = Object.fromEntries(GLOBAL_KEYS.map((k) => [k, null])) as Record<GlobalKey, number | null>;
    moves.ES = 1;
    moves.US10Y = -10;
    moves.CL = null;
    expect(expectedGapPct(moves, { ES: 0.45, US10Y: -0.01, CL: -0.08, BOGUS: 3 })).toBeCloseTo(0.45 + 0.1, 12);
    expect(expectedGapPct(moves, {})).toBe(0);
  });
});

describe("overnightObservations", () => {
  it("pairs each session's opening gap with the overnight global moves", () => {
    const s = snap(istAt("2026-10-07", "15:35"), fixtureCandles5m(), fixtureDaily());
    const obs = overnightObservations(s, "NIFTY", cal, 3);
    expect(obs.map((o) => o.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const oct7 = obs[2];
    expect(oct7.gapPct).toBeCloseTo(-0.3760538112054346, 9);
    expect(oct7.moves.ES).toBeCloseTo(0.4494310394288048, 9);
    // Daily bars extend the history beyond the 5m window (60+ sessions in the 3-month fixture).
    const all = overnightObservations(s, "NIFTY", cal, 1000);
    expect(all.length).toBeGreaterThan(55);
    expect(all.every((o) => Number.isFinite(o.gapPct))).toBe(true);
    expect(overnightObservations(s, "NIFTY", cal, 0)).toEqual([]);
  });
});

describe("fitGapBetas", () => {
  const keys: GlobalKey[] = ["ES", "USDINR", "US10Y"];
  const truth: Record<string, number> = { ES: 0.45, USDINR: -1.5, US10Y: -0.01 };

  function synthetic(n: number, noise: number): GapObservation[] {
    const rnd = mulberry32(11);
    const out: GapObservation[] = [];
    for (let i = 0; i < n; i++) {
      const moves = Object.fromEntries(GLOBAL_KEYS.map((k) => [k, null])) as Record<GlobalKey, number | null>;
      moves.ES = (rnd() - 0.5) * 2; // percent
      moves.USDINR = (rnd() - 0.5) * 0.6; // percent
      moves.US10Y = (rnd() - 0.5) * 16; // basis points
      const gapPct = keys.reduce((s, k) => s + truth[k] * (moves[k] as number), 0) + (rnd() - 0.5) * noise;
      out.push({ date: `d${i}`, gapPct, moves });
    }
    return out;
  }

  it("recovers known betas in original units", () => {
    const betas = fitGapBetas(synthetic(120, 0.01), keys, 0.01);
    expect(betas.ES).toBeCloseTo(0.45, 2);
    expect(betas.USDINR).toBeCloseTo(-1.5, 1);
    expect(betas.US10Y).toBeCloseTo(-0.01, 3);
  });

  it("needs 20 complete rows", () => {
    const obs = synthetic(25, 0.01);
    for (let i = 0; i < 6; i++) obs[i].moves.US10Y = null;
    expect(fitGapBetas(obs, keys, 0.01)).toEqual({});
    expect(Object.keys(fitGapBetas(synthetic(20, 0.01), keys, 0.01)).sort()).toEqual(["ES", "US10Y", "USDINR"]);
  });
});
