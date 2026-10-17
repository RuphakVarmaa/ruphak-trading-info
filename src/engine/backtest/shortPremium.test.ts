import { describe, expect, it } from "vitest";
import { computeCharges } from "../broker/charges";
import { CHARGE_SCHEDULES, type ChargeSchedule } from "../config";
import { bsPrice } from "../pricing/blackScholes";
import {
  black76Iv,
  black76StraddleIv,
  dteBucket,
  engineSpread,
  eventOn,
  expectedMove,
  exerciseSttPct,
  flyNoArbitrage,
  gapBucket,
  intrinsic,
  maxDrawdown,
  modeLot,
  RESEARCH_CHARGE_SCHEDULES,
  scaledSpread,
  SCHEDULED_EVENTS,
  strikeBeyond,
  structurePnl,
  tailShare,
  tercile,
  withinFactor,
  worstRun,
} from "./shortPremium";

const ZERO: readonly ChargeSchedule[] = [
  { ...CHARGE_SCHEDULES[0], effectiveFrom: "2000-01-01", brokeragePerOrder: 0, sttSellPct: 0, exchangeTxnPct: { NSE: 0, BSE: 0 }, sebiPct: 0, stampBuyPct: 0, ipftPct: 0 },
];
const noSpread = () => 0;

describe("dated research charges", () => {
  it("applies the STT and exchange rates in force on each date", () => {
    // 1 lot of 75 sold at 200: turnover 15,000.
    const stt = (date: string, ex: "NSE" | "BSE" = "NSE") => computeCharges("SELL", 200, 75, ex, date, RESEARCH_CHARGE_SCHEDULES).stt;
    const txn = (date: string, ex: "NSE" | "BSE" = "NSE") => computeCharges("SELL", 200, 75, ex, date, RESEARCH_CHARGE_SCHEDULES).exchangeTxn;
    expect(stt("2019-06-03")).toBeCloseTo(7.5, 2); // 0.05%
    expect(txn("2019-06-03")).toBeCloseTo(7.95, 2); // 0.053%
    expect(stt("2023-04-03")).toBeCloseTo(9.375, 1); // 0.0625% (rounded to paise)
    expect(txn("2023-04-03")).toBeCloseTo(7.5, 2); // 0.05%
    expect(txn("2024-04-01")).toBeCloseTo(7.425, 1); // 0.0495%
    expect(txn("2023-06-01", "BSE")).toBeCloseTo(7.5, 2); // billed like NSE before Oct 2024
    expect(stt("2024-10-01")).toBeCloseTo(15, 2); // 0.1%, the engine's own schedule
    expect(txn("2024-10-01", "BSE")).toBeCloseTo(4.875, 1); // 0.0325%
    expect(stt("2026-04-01")).toBeCloseTo(22.5, 2); // 0.15%
  });

  it("keeps the engine's schedules unchanged from October 2024", () => {
    for (const date of ["2024-10-01", "2025-06-02", "2026-04-01", "2026-10-08"]) {
      expect(computeCharges("SELL", 150, 65, "NSE", date, RESEARCH_CHARGE_SCHEDULES)).toEqual(computeCharges("SELL", 150, 65, "NSE", date));
    }
  });

  it("raises exercise STT to 0.15% from April 2026", () => {
    expect(exerciseSttPct("2026-03-31")).toBe(0.125);
    expect(exerciseSttPct("2026-04-01")).toBe(0.15);
  });
});

describe("spreads", () => {
  it("uses max(1 tick, 0.4% of premium) in whole ticks, and scales it", () => {
    expect(engineSpread(100)).toBeCloseTo(0.4, 10);
    expect(engineSpread(5)).toBeCloseTo(0.05, 10);
    expect(engineSpread(13)).toBeCloseTo(0.1, 10); // 0.052 -> 2 ticks
    expect(scaledSpread(2)(100)).toBeCloseTo(0.8, 10);
  });
});

describe("structurePnl", () => {
  const base = { lot: 50, exchange: "NSE" as const, entryDate: "2024-01-08", exitDate: "2024-01-08", schedules: ZERO };

  it("prices a short straddle bought back at the close, before costs", () => {
    const r = structurePnl(
      [
        { side: "short", entry: 100, exit: 80, settled: false },
        { side: "short", entry: 90, exit: 60, settled: false },
      ],
      { ...base, spread: noSpread },
    );
    expect(r.gross).toBeCloseTo(50 * 50, 6);
    expect(r.net).toBeCloseTo(2500, 6);
    expect(r.premium).toBeCloseTo(190 * 50, 6);
    expect(r.spread).toBeCloseTo(0, 6);
  });

  it("charges half the spread on each order, and none on a settled leg", () => {
    const spread = () => 1; // full spread ₹1: ₹0.50 per order
    const open = structurePnl([{ side: "short", entry: 100, exit: 80, settled: false }], { ...base, spread });
    expect(open.spread).toBeCloseTo(1 * 50, 6);
    const settled = structurePnl([{ side: "short", entry: 100, exit: 80, settled: true }], { ...base, spread });
    expect(settled.spread).toBeCloseTo(0.5 * 50, 6);
    expect(settled.net).toBeCloseTo((99.5 - 80) * 50, 6);
  });

  it("pays a long wing's spread both ways, floors its sale at 0 and adds exercise STT at settlement", () => {
    const spread = () => 0.1;
    const sold = structurePnl([{ side: "long", entry: 5, exit: 0.02, settled: false }], { ...base, spread });
    expect(sold.net).toBeCloseTo((0 - 5.05) * 50, 6);
    const settled = structurePnl([{ side: "long", entry: 5, exit: 40, settled: true }], { ...base, exitDate: "2024-01-11", spread });
    expect(settled.charges).toBeCloseTo((40 * 50 * 0.125) / 100, 6);
    expect(settled.net).toBeCloseTo((40 - 5.05) * 50 - 2.5, 6);
  });

  it("applies the dated charges per order", () => {
    const legs = [
      { side: "short" as const, entry: 100, exit: 80, settled: false },
      { side: "short" as const, entry: 90, exit: 60, settled: false },
    ];
    const r = structurePnl(legs, { lot: 50, exchange: "NSE", entryDate: "2025-01-06", exitDate: "2025-01-06", spread: noSpread });
    const expected =
      computeCharges("SELL", 100, 50, "NSE", "2025-01-06").total +
      computeCharges("BUY", 80, 50, "NSE", "2025-01-06").total +
      computeCharges("SELL", 90, 50, "NSE", "2025-01-06").total +
      computeCharges("BUY", 60, 50, "NSE", "2025-01-06").total;
    expect(r.charges).toBeCloseTo(expected, 6);
    expect(r.net).toBeCloseTo(2500 - expected, 6);
  });

  it("computes intrinsic values", () => {
    expect(intrinsic("CE", 25000, 25120)).toBe(120);
    expect(intrinsic("PE", 25000, 25120)).toBe(0);
    expect(intrinsic("PE", 25000, 24900)).toBe(100);
  });
});

describe("expected moves and strikes", () => {
  it("scales VIX by the square root of sessions over 252", () => {
    expect(expectedMove(25000, 13)).toBeCloseTo(25000 * 0.13 / Math.sqrt(252), 6);
    expect(expectedMove(25000, 13, 4)).toBeCloseTo(2 * expectedMove(25000, 13), 6);
  });

  it("picks the listed strike beyond the ATM strike nearest the target", () => {
    const strikes = [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200, 25300];
    expect(strikeBeyond(strikes, 25000, 25204, "above")).toBe(25200);
    expect(strikeBeyond(strikes, 25000, 24796, "below")).toBe(24800);
    expect(strikeBeyond(strikes, 25000, 25010, "above")).toBe(25050); // never the ATM strike itself
    expect(strikeBeyond(strikes, 25000, 25250, "above")).toBe(25200); // tie goes nearer the ATM strike
    expect(strikeBeyond(strikes, 25300, 25400, "above")).toBeNull();
  });

  it("takes the most common lot", () => {
    expect(modeLot([75, 74, 75, null, 76, 75])).toBe(75);
    expect(modeLot([null])).toBeNull();
  });
});

describe("iron-fly opening checks", () => {
  const ok = { k: 25000, kc: 25200, kp: 24800, c: 120, p: 110, wc: 30, wp: 35 };
  it("accepts consistent prints and names the first bound that fails", () => {
    expect(flyNoArbitrage(ok)).toBe("ok");
    expect(flyNoArbitrage({ ...ok, wc: 130 })).toBe("call-vertical"); // wing above the ATM call
    expect(flyNoArbitrage({ ...ok, p: 260, wp: 20 })).toBe("put-vertical"); // vertical worth more than its width
    expect(flyNoArbitrage({ ...ok, c: 190, wc: 10, p: 180, wp: 10 })).toBe("fly-value"); // 180 + 170 >= 200
  });

  it("checks a factor band", () => {
    expect(withinFactor(0.2, 0.15, 2)).toBe(true);
    expect(withinFactor(0.31, 0.15, 2)).toBe(false);
    expect(withinFactor(0.07, 0.15, 2)).toBe(false);
  });

  it("recovers Black-76 volatilities of a leg and of a straddle", () => {
    const t = 3 / 252;
    const put = bsPrice({ spot: 25000, strike: 24700, tYears: t, vol: 0.16, r: 0, type: "PE" });
    expect(black76Iv(put, 25000, 24700, t, "PE")).toBeCloseTo(0.16, 6);
    const straddle = bsPrice({ spot: 25000, strike: 25050, tYears: t, vol: 0.12, r: 0, type: "CE" }) + bsPrice({ spot: 25000, strike: 25050, tYears: t, vol: 0.12, r: 0, type: "PE" });
    expect(black76StraddleIv(straddle, 25000, 25050, t)).toBeCloseTo(0.12, 6);
    expect(black76StraddleIv(10, 25000, 25300, t)).toBeNull(); // below intrinsic
  });
});

describe("tail statistics", () => {
  const xs = [5, -2, 4, -10, -3, 6, 1, -1];
  it("finds the worst run of k consecutive values", () => {
    expect(worstRun(xs, 1)).toEqual({ sum: -10, start: 3 });
    expect(worstRun(xs, 2)).toEqual({ sum: -13, start: 3 });
    expect(worstRun(xs, 3)).toEqual({ sum: -9, start: 2 });
    expect(worstRun([1, 2], 5)).toEqual({ sum: 3, start: 0 });
  });

  it("measures the maximum drawdown of the cumulative sum", () => {
    // cumulative: 5 3 7 -3 -6 0 1 0 -> peak 7 at index 2, trough -6 at index 4
    expect(maxDrawdown(xs)).toEqual({ depth: 13, peak: 2, trough: 4 });
    expect(maxDrawdown([-1, -2]).depth).toBe(3);
  });

  it("measures the share of the total carried by the worst values", () => {
    const r = tailShare([10, 10, 10, 10, 10, 10, 10, 10, 10, -40], 0.1);
    expect(r).toEqual({ count: 1, worstSum: -40, total: 50, multiple: -0.8 });
    expect(tailShare([], 0.05).count).toBe(0);
  });
});

describe("breakdown keys and events", () => {
  it("buckets DTE, gaps and terciles", () => {
    expect([0, 1, 2, 5, 6].map(dteBucket)).toEqual(["0", "1", "2-5", "2-5", "6+"]);
    expect([0.001, -0.003, 0.007, -0.012].map(gapBucket)).toEqual(["<0.25%", "0.25-0.5%", "0.5-1%", ">=1%"]);
    expect([10, 40, 90].map(tercile)).toEqual([0, 1, 2]);
  });

  it("lists scheduled events only", () => {
    expect(eventOn("2024-06-04")).toBe("election");
    expect(eventOn("2026-02-01")).toBe("budget");
    expect(eventOn("2025-10-01")).toBe("rbi");
    expect(eventOn("2020-03-27")).toBeNull(); // off-cycle RBI cut
    expect(eventOn("2022-05-04")).toBeNull(); // off-cycle RBI hike
    const n = (k: string) => SCHEDULED_EVENTS.filter((e) => e.kind === k).length;
    expect([n("budget"), n("rbi"), n("election")]).toEqual([10, 45, 2]);
  });
});
