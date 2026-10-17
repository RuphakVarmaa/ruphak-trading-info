import { describe, expect, it } from "vitest";
import { MinuteSeries, type MinuteBar } from "./intraday1m";
import {
  futuresSttPct,
  meanGapBootstrap,
  nthSessionBefore,
  spreadEntry,
  spreadExit,
  spreadMargin,
  spreadStrikes,
  spreadValueAt,
  spreadWidth,
  tomWindows,
  weekKey,
} from "./putSpreads";

const range = (lo: number, hi: number, step: number) => Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

describe("spreadStrikes", () => {
  const strikes = range(23000, 25000, 50);

  it("places the short put m expected moves below the index and the long put half an expected move further", () => {
    // Level 24,010, EM 400: the short put nearest 23,610 below the index is 23,600; the long put nearest 23,400 below it.
    const s = spreadStrikes(strikes, 24010, 400, 1, { kind: "em", mult: 0.5 }, "put", 50)!;
    expect(s).toEqual({ short: 23600, long: 23400, shortTarget: 23610, longTarget: 23400 });
    expect(spreadWidth(s)).toBe(200);
    // The mirror call spread: short nearest 24,410 above the index (24,400), long nearest 24,600 above it.
    expect(spreadStrikes(strikes, 24010, 400, 1, { kind: "em", mult: 0.5 }, "call", 50)).toEqual({ short: 24400, long: 24600, shortTarget: 24410, longTarget: 24600 });
  });

  it("keeps the short leg strictly out of the money and the long leg strictly beyond it", () => {
    // 0.1 EM out aims at 23,990, but the put must be below the index (24,000 is not): 23,950.
    expect(spreadStrikes(strikes, 24000, 100, 0.1, { kind: "em", mult: 0.1 }, "put", 50)).toMatchObject({ short: 23950, long: 23900 });
    expect(spreadStrikes(strikes, 24000, 100, 0.1, { kind: "em", mult: 0.1 }, "call", 50)).toMatchObject({ short: 24050, long: 24100 });
  });

  it("uses an exact number of strike steps for a width in steps, and needs that strike listed", () => {
    expect(spreadStrikes(strikes, 24010, 400, 1, { kind: "steps", steps: 2 }, "put", 50)).toEqual({ short: 23600, long: 23500, shortTarget: 23610, longTarget: 23500 });
    expect(spreadStrikes(strikes, 24010, 400, 1, { kind: "steps", steps: 1 }, "call", 50)).toMatchObject({ short: 24400, long: 24450 });
    // 23,550 not listed (100-point grid): no spread.
    expect(spreadStrikes(range(23000, 25000, 100), 24010, 400, 1, { kind: "steps", steps: 1 }, "put", 50)).toBeNull();
  });

  it("returns null without a strike beyond the index or the short leg, or with bad inputs", () => {
    // A short put (24,000) but no strike below it for the long put.
    expect(spreadStrikes([24000, 24050], 24010, 400, 1, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    // No strike below the index at all.
    expect(spreadStrikes([24050, 24100], 24010, 400, 1, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    expect(spreadStrikes([24000], 24010, 400, 1, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    expect(spreadStrikes(strikes, 24010, 0, 1, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    expect(spreadStrikes(strikes, Number.NaN, 400, 1, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    expect(spreadStrikes(strikes, 24010, 400, 1, { kind: "steps", steps: 0 }, "put", 50)).toBeNull();
  });

  it("aims at the furthest listed strike when the target lies beyond the listed range", () => {
    expect(spreadStrikes(range(23500, 24500, 50), 24000, 400, 1.5, { kind: "em", mult: 0.5 }, "put", 50)).toBeNull();
    expect(spreadStrikes(range(23300, 24500, 50), 24000, 400, 1.5, { kind: "em", mult: 0.5 }, "put", 50)).toMatchObject({ short: 23400, long: 23300 });
  });
});

describe("spreadValueAt", () => {
  const put = { short: 23600, long: 23400 };
  const call = { short: 24400, long: 24600 };

  it("is zero out of the money, linear between the strikes and capped at the width", () => {
    expect([24000, 23600, 23500, 23400, 22000].map((s) => spreadValueAt("put", put, s))).toEqual([0, 0, 100, 200, 200]);
    expect([24000, 24400, 24500, 24600, 26000].map((s) => spreadValueAt("call", call, s))).toEqual([0, 0, 100, 200, 200]);
  });
});

describe("spreadMargin", () => {
  it("adds the width × lot, 2% exposure and, on the expiry day from 20 Nov 2024, another 2%", () => {
    expect(spreadMargin({ width: 100, lot: 75, level: 24000, onExpiryDay: false, date: "2025-01-02" })).toEqual({ span: 7500, exposure: 36000, elm: 0, total: 43500 });
    expect(spreadMargin({ width: 100, lot: 75, level: 24000, onExpiryDay: true, date: "2025-01-02" }).total).toBe(79500);
    expect(spreadMargin({ width: 100, lot: 75, level: 24000, onExpiryDay: true, date: "2024-11-19" }).elm).toBe(0);
  });
});

describe("weekKey and nthSessionBefore", () => {
  it("maps a date to the Monday of its ISO week", () => {
    expect(weekKey("2026-10-08")).toBe("2026-10-05"); // Thursday
    expect(weekKey("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(weekKey("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(weekKey("2025-01-01")).toBe("2024-12-30"); // across a year
    expect(() => weekKey("not a date")).toThrow();
  });

  it("counts sessions strictly before a day", () => {
    const s = ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
    expect(nthSessionBefore(s, "2026-10-08", 1)).toBe("2026-10-07");
    expect(nthSessionBefore(s, "2026-10-08", 4)).toBe("2026-10-01");
    expect(nthSessionBefore(s, "2026-10-08", 5)).toBeNull();
    // A day that is not itself a session (a holiday) counts back from the sessions before it.
    expect(nthSessionBefore(s, "2026-10-02", 1)).toBe("2026-10-01");
    expect(nthSessionBefore(s, "2026-10-08", 0)).toBeNull();
  });
});

const bar = (m: number, o: number, h: number, l: number, c: number): MinuteBar => ({ m, o, h, l, c, v: 10, oi: 0 });

describe("spreadEntry and spreadExit", () => {
  // The short put trades at 15:20 and 15:21; the long put only at 15:21.
  const short = new MinuteSeries([bar(920, 40, 42, 39, 41), bar(921, 41, 43, 40, 42)]);
  const long = new MinuteSeries([bar(921, 20, 21, 19, 20.5)]);

  it("fills both legs in the first minute in which both traded", () => {
    expect(spreadEntry(short, long, 920, 2, "conservative")).toEqual({ m: 921, shortIn: 40, longIn: 21 });
    expect(spreadEntry(short, long, 920, 2, "mid")).toEqual({ m: 921, shortIn: 42, longIn: 20.5 });
    expect(spreadEntry(short, long, 920, 0, "mid")).toBeNull();
  });

  it("closes in a common minute, else each leg at its last close (stale), else not at all", () => {
    expect(spreadExit(short, long, 920, 5, "conservative")).toEqual({ m: 921, shortOut: 43, longOut: 19, stale: false });
    const lonely = new MinuteSeries([bar(900, 5, 5, 5, 5)]);
    expect(spreadExit(short, lonely, 920, 5, "mid")).toEqual({ m: 920, shortOut: 41, longOut: 5, stale: true });
    expect(spreadExit(short, null, 920, 5, "mid")).toBeNull();
    expect(spreadExit(new MinuteSeries([bar(925, 1, 1, 1, 1)]), lonely, 920, 2, "mid")).toBeNull();
  });
});

describe("tomWindows", () => {
  const s = ["2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-05"];

  it("takes the month's last session and the next month's first three, started by the session before", () => {
    const w = tomWindows(s);
    expect(w).toEqual([{ month: "2026-08", start: "2026-08-28", days: ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"], end: "2026-09-03" }]);
  });

  it("skips windows that run past the data and supports other spans", () => {
    // September's window needs three October sessions; only two are listed.
    expect(tomWindows(s).map((x) => x.month)).not.toContain("2026-09");
    expect(tomWindows(s, 1, 2).map((x) => `${x.month}:${x.start}→${x.end}`)).toEqual(["2026-08:2026-08-28→2026-09-02", "2026-09:2026-09-29→2026-10-05"]);
    expect(tomWindows(s, 2, 3)[0]).toEqual({ month: "2026-08", start: "2026-08-27", days: ["2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"], end: "2026-09-03" });
    expect(tomWindows(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"])).toEqual([]); // no session before T−1
    expect(tomWindows(s, 0, 3)).toEqual([]);
  });
});

describe("meanGapBootstrap", () => {
  it("measures the gap between flagged and other sessions, with a seeded interval", () => {
    const x = Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? 0.01 : 0) + ((i * 7919) % 13) / 13000 - 0.0005);
    const flag = x.map((_, i) => i % 10 === 0);
    const g = meanGapBootstrap(x, flag, { block: 20, resamples: 2000, seed: 7 });
    expect(g.nIn).toBe(40);
    expect(g.nOut).toBe(360);
    const mIn = x.filter((_, i) => flag[i]).reduce((a, b) => a + b, 0) / 40;
    const mOut = x.filter((_, i) => !flag[i]).reduce((a, b) => a + b, 0) / 360;
    expect(g.gap).toBeCloseTo(mIn - mOut, 12);
    expect(g.lo).toBeGreaterThan(0.008);
    expect(g.p).toBeLessThan(0.001);
    expect(meanGapBootstrap(x, flag, { block: 20, resamples: 2000, seed: 7 })).toEqual(g);
  });

  it("returns NaN for a gap without both kinds of sessions and rejects mismatched inputs", () => {
    expect(Number.isNaN(meanGapBootstrap([1, 2], [true, true], { block: 1, resamples: 10 }).gap)).toBe(true);
    expect(() => meanGapBootstrap([1, 2], [true], { block: 1 })).toThrow();
  });
});

describe("futuresSttPct", () => {
  it("follows the dated rates", () => {
    expect(["2019-02-11", "2023-04-01", "2024-09-30", "2024-10-01", "2026-03-31", "2026-04-01"].map(futuresSttPct)).toEqual([0.01, 0.0125, 0.0125, 0.02, 0.02, 0.05]);
  });
});
