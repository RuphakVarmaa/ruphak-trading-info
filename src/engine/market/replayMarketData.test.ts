import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, istDate, istMidnight } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import type { Candle } from "../types";
import { fixtureCandles5m, fixtureDaily } from "../__fixtures__/market/loadFixtures";
import { computeFeatures, NO_DATA_AGE_SEC } from "./features";
import { ReplayMarketDataSource, YAHOO_LAG_MS } from "./replayMarketData";

const cal = new TradingCalendar();
const BAR = 300_000;
const candles = fixtureCandles5m();
const daily = fixtureDaily();

/** Probe instants: every 5 minutes through the 2026-10-07 session plus off-grid seconds. */
function probes(): number[] {
  const out: number[] = [];
  for (let m = 9 * 60; m <= 16 * 60; m += 5) {
    const t = istAt("2026-10-07", m);
    out.push(t - 1, t, t + 1, t + 37_000);
  }
  out.push(istAt("2026-10-06", "12:00"), istAt("2026-10-05", "15:31"), istAt("2026-10-03", "11:00"));
  return out;
}

describe("ReplayMarketDataSource point-in-time guarantees", () => {
  for (const lagMs of [0, YAHOO_LAG_MS]) {
    it(`exposes exactly the bars closed and published by t (lag ${lagMs} ms)`, async () => {
      const src = new ReplayMarketDataSource({ candles, daily }, { lagMs });
      for (const t of probes()) {
        const snap = await src.snapshot(t);
        expect(snap.t).toBe(t);
        for (const [sym, all] of Object.entries(candles)) {
          const visible = snap.candles[sym];
          for (const c of visible) expect(c.t + BAR).toBeLessThanOrEqual(t - lagMs);
          // Completeness: every eligible bar is there, and the next one is not eligible.
          const eligible = all.filter((c) => c.t + BAR <= t - lagMs);
          expect(visible.length).toBe(eligible.length);
          const next = all[visible.length];
          if (next) expect(next.t + BAR).toBeGreaterThan(t - lagMs);
        }
        for (const bars of Object.values(snap.daily)) {
          for (const c of bars) expect(istDate(c.t) < istDate(t)).toBe(true);
        }
      }
    });
  }

  it("reports LTP as the last visible close and an honest data age", () => {
    const src = new ReplayMarketDataSource({ candles, daily }, { lagMs: YAHOO_LAG_MS });
    const t = istAt("2026-10-07", "11:02");
    const snap = src.snapshotSync(t);
    const nifty = snap.candles["^NSEI"];
    const last = nifty[nifty.length - 1];
    expect(last.t).toBe(istAt("2026-10-07", "10:55")); // closed 11:00, published 11:01:30
    expect(snap.ltp.NIFTY).toBe(last.c);
    expect(snap.ltp.SENSEX).toBe(snap.candles["^BSESN"].at(-1)!.c);
    expect(snap.ltp.BANKNIFTY).toBe(snap.candles["^NSEBANK"].at(-1)!.c);
    expect(snap.dataAgeSec).toBe(120);
  });

  it("builds daily bars from intraday when none are supplied, without today's", () => {
    const src = new ReplayMarketDataSource({ candles });
    const snap = src.snapshotSync(istAt("2026-10-07", "12:00"));
    const nseiDaily = snap.daily["^NSEI"];
    expect(nseiDaily.map((c) => istDate(c.t))).toEqual(["2026-10-01", "2026-10-05", "2026-10-06"]);
    expect(nseiDaily[2].c).toBeCloseTo(22776.1, 1);
    // A 24-hour asset's previous IST day is complete (dates before today only).
    expect(snap.daily["ES=F"].every((c) => c.t < istMidnight("2026-10-07"))).toBe(true);
  });

  it("holds back a 24-hour asset's daily bar until its close is final", () => {
    // USDINR daily bars run 00:00-24:00 London (stamped 04:30 IST): yesterday's bar closes at 04:30 IST today.
    const fx: Candle[] = [
      { t: istAt("2026-10-05", "04:30"), o: 96, h: 96, l: 96, c: 96.1, v: 0 },
      { t: istAt("2026-10-06", "04:30"), o: 96, h: 96, l: 96, c: 96.4, v: 0 },
    ];
    const src = new ReplayMarketDataSource({ candles: {}, daily: { "USDINR=X": fx } });
    expect(src.snapshotSync(istAt("2026-10-07", "03:00")).daily["USDINR=X"].map((c) => c.c)).toEqual([96.1]);
    expect(src.snapshotSync(istAt("2026-10-07", "09:15")).daily["USDINR=X"].map((c) => c.c)).toEqual([96.1, 96.4]);
  });

  it("never lets future data change today's features", () => {
    const lagMs = YAHOO_LAG_MS;
    const full = new ReplayMarketDataSource({ candles, daily }, { lagMs });
    for (const hm of ["09:16", "09:31", "10:02", "11:00", "13:47", "15:29", "15:40"]) {
      const t = istAt("2026-10-07", hm);
      const cutoff = t - lagMs;
      // 1) Truncate everything after t; 2) corrupt everything after t. Neither may change anything.
      const truncated = new ReplayMarketDataSource(
        {
          candles: Object.fromEntries(Object.entries(candles).map(([k, v]) => [k, v.filter((c) => c.t + BAR <= cutoff)])),
          daily: Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, v.filter((c) => istDate(c.t) < istDate(t))])),
        },
        { lagMs },
      );
      const poisoned = new ReplayMarketDataSource(
        {
          candles: Object.fromEntries(
            Object.entries(candles).map(([k, v]) => [k, v.map((c) => (c.t + BAR <= cutoff ? c : { ...c, o: c.o * 3, h: c.h * 3, l: c.l * 3, c: c.c * 3 }))]),
          ),
          daily: Object.fromEntries(
            Object.entries(daily).map(([k, v]) => [k, v.map((c) => (istDate(c.t) < istDate(t) ? c : { ...c, c: c.c * 3, o: c.o * 3 }))]),
          ),
        },
        { lagMs },
      );
      for (const index of ["NIFTY", "SENSEX"] as const) {
        const a = computeFeatures(index, full.snapshotSync(t), cal, DEFAULT_CONFIG);
        expect(computeFeatures(index, truncated.snapshotSync(t), cal, DEFAULT_CONFIG)).toEqual(a);
        expect(computeFeatures(index, poisoned.snapshotSync(t), cal, DEFAULT_CONFIG)).toEqual(a);
      }
    }
  });

  it("handles empty data", async () => {
    const src = new ReplayMarketDataSource({ candles: {} });
    const snap = await src.snapshot(istAt("2026-10-07", "10:00"));
    expect(snap.ltp).toEqual({});
    expect(snap.dataAgeSec).toBe(NO_DATA_AGE_SEC);
    expect(src.range()).toBeNull();
  });

  it("sorts and de-duplicates input and reports its range", () => {
    const a = candles["^NSEI"];
    const shuffled = [...a].reverse().concat(a.slice(0, 5));
    const src = new ReplayMarketDataSource({ candles: { "^NSEI": shuffled } });
    const snap = src.snapshotSync(istAt("2026-10-08", "00:00"));
    expect(snap.candles["^NSEI"]).toEqual(a);
    expect(src.range()).toEqual({ fromMs: a[0].t, toMs: a[a.length - 1].t });
  });
});
