import { describe, expect, it } from "vitest";
import {
  blocksOf,
  calendarNoArbitrage,
  CLOSE_MIN,
  cutDate,
  overallVerdict,
  pickBest,
  remainingSessionEm,
  robustness,
  runOvernight,
  sessionBefore,
  syncMinute,
  worstBlocks,
  type OvernightLeg,
} from "./expiryCalendar";
import { MinuteSeries, type MinuteBar } from "./intraday1m";
import { expectedMove } from "./shortPremium";

const bar = (m: number, o: number, h: number, l: number, c: number, v = 100): MinuteBar => ({ m, o, h, l, c, v, oi: 0 });

describe("remainingSessionEm", () => {
  it("scales the daily expected move by the square root of the share of the session left", () => {
    const daily = expectedMove(24_000, 14);
    expect(remainingSessionEm(24_000, 14, 9 * 60 + 15)).toBeCloseTo(daily, 9); // the whole session
    // 14:00 leaves 90 of 375 minutes: √(90/375) of the daily move.
    expect(remainingSessionEm(24_000, 14, 14 * 60)).toBeCloseTo(daily * Math.sqrt(90 / 375), 9);
    expect(remainingSessionEm(24_000, 14, 14 * 60)).toBeCloseTo(24_000 * 0.14 * Math.sqrt(90 / 375 / 252), 9);
  });

  it("is zero at or after the close", () => {
    expect(remainingSessionEm(24_000, 14, CLOSE_MIN)).toBe(0);
    expect(remainingSessionEm(24_000, 14, CLOSE_MIN + 5)).toBe(0);
  });
});

describe("syncMinute", () => {
  const a = new MinuteSeries([bar(600, 1, 1, 1, 1), bar(601, 1, 1, 1, 1), bar(603, 1, 1, 1, 1)]);
  const b = new MinuteSeries([bar(601, 1, 1, 1, 1), bar(602, 1, 1, 1, 1), bar(603, 1, 1, 1, 1)]);
  const c = new MinuteSeries([bar(603, 1, 1, 1, 1)]);

  it("finds the first minute of the window in which every leg traded", () => {
    expect(syncMinute([a, b], 600, 2)).toBe(601);
    expect(syncMinute([a, b, c], 600, 3)).toBe(603);
  });

  it("returns null when no minute of the window has every leg", () => {
    expect(syncMinute([a, b, c], 600, 2)).toBeNull();
    expect(syncMinute([a, b], 604, 2)).toBeNull();
  });
});

describe("calendarNoArbitrage", () => {
  it("requires the later straddle to be dearer than the nearer one", () => {
    expect(calendarNoArbitrage({ nearCall: 50, nearPut: 45, farCall: 120, farPut: 110 })).toBe(true);
    expect(calendarNoArbitrage({ nearCall: 50, nearPut: 45, farCall: 50, farPut: 45 })).toBe(false);
    // One far leg cheaper than its near twin is allowed while the straddle as a whole is dearer.
    expect(calendarNoArbitrage({ nearCall: 50, nearPut: 45, farCall: 49, farPut: 60 })).toBe(true);
  });
});

describe("runOvernight", () => {
  // Entry day: the near call and put (short) and the far call and put (long), all with a 09:30 bar.
  const d1 = (h: number, l: number, c: number) => new MinuteSeries([bar(570, c, h, l, c)]);
  // Exit day: bars at 15:20 (920) and 15:21.
  const d2 = (h: number, l: number, c: number) => new MinuteSeries([bar(919, c, c, c, c), bar(920, c, h, l, c), bar(921, c, c, c, c)]);
  const legs = (): OvernightLeg[] => [
    { entry: d1(52, 48, 50), exit: d2(12, 8, 10), side: "short" },
    { entry: d1(47, 43, 45), exit: d2(6, 4, 5), side: "short" },
    { entry: d1(122, 118, 120), exit: d2(92, 88, 90), side: "long" },
    { entry: d1(112, 108, 110), exit: d2(82, 78, 80), side: "long" },
  ];

  it("fills a calendar at the bar close (mid)", () => {
    const r = runOvernight({ legs: legs(), entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 5, mode: "mid" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.legs.map((l) => [l.entry, l.exit])).toEqual([
      [50, 10],
      [45, 5],
      [120, 90],
      [110, 80],
    ]);
    expect(r.entryValue).toBe(120 + 110 - 50 - 45); // a debit of 135
    expect(r.legs.every((l) => !l.staleExit)).toBe(true);
  });

  it("charges the worst traded price of each minute at the conservative fill", () => {
    const r = runOvernight({ legs: legs(), entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 5, mode: "conservative" });
    if ("skip" in r) throw new Error(r.skip);
    // Shorts sell at the low and buy back at the high; longs buy at the high and sell at the low.
    expect(r.legs.map((l) => [l.entry, l.exit])).toEqual([
      [48, 12],
      [43, 6],
      [122, 88],
      [112, 78],
    ]);
  });

  it("uses the last close before the exit when the exit window has no bar (stale), and skips without any bar that day", () => {
    const stale = new MinuteSeries([bar(900, 7, 7, 7, 7)]);
    const l = legs();
    l[0] = { ...l[0], exit: stale };
    const r = runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 5, mode: "mid" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.legs[0]).toMatchObject({ exit: 7, staleExit: true, exitMin: 920 });
    l[0] = { ...l[0], exit: null };
    expect(runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 5, mode: "mid" })).toEqual({ skip: "no exit price" });
    l[0] = { ...l[0], exit: new MinuteSeries([bar(925, 7, 7, 7, 7)]) }; // only after the exit window
    expect(runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 4, mode: "mid" })).toEqual({ skip: "no exit price" });
  });

  it("exits a leg with no bar at all on the exit day at its fallback (an expiring leg's intrinsic value)", () => {
    const l = legs();
    l[0] = { ...l[0], exit: new MinuteSeries([bar(925, 7, 7, 7, 7)]), exitFallback: 0 }; // only a bar after the window
    l[1] = { ...l[1], exit: null, exitFallback: 140.5 };
    const r = runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 4, mode: "conservative" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.legs[0]).toMatchObject({ exit: 0, staleExit: true });
    expect(r.legs[1]).toMatchObject({ exit: 140.5, staleExit: true });
    // A bar earlier that day still comes first: the fallback is only for a leg with no bar at all.
    l[1] = { ...l[1], exit: new MinuteSeries([bar(900, 9, 9, 9, 9)]), exitFallback: 140.5 };
    const r2 = runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 4, mode: "mid" });
    if ("skip" in r2) throw new Error(r2.skip);
    expect(r2.legs[1].exit).toBe(9);
  });

  it("skips when a leg has no bar in the entry window", () => {
    const l = legs();
    l[2] = { ...l[2], entry: new MinuteSeries([bar(575, 1, 1, 1, 1)]) };
    expect(runOvernight({ legs: l, entryMin: 570, entryWait: 2, exitMin: 920, exitWait: 5, mode: "mid" })).toEqual({ skip: "no entry bar" });
  });
});

describe("blocksOf and worstBlocks", () => {
  const trades = [
    { block: "2024-06-06", net: -500 },
    { block: "2024-06-06", net: -300 },
    { block: "2024-06-13", net: 200 },
    { block: "2024-06-27", net: -100 },
  ];

  it("groups trades by block key and keeps empty blocks", () => {
    expect(blocksOf(trades, ["2024-06-06", "2024-06-13", "2024-06-20"])).toEqual([
      { day: "2024-06-06", pnls: [-500, -300] },
      { day: "2024-06-13", pnls: [200] },
      { day: "2024-06-20", pnls: [] },
      { day: "2024-06-27", pnls: [-100] }, // outside the keys: a block of its own
    ]);
  });

  it("ranks blocks by their summed net", () => {
    expect(worstBlocks(trades, 2)).toEqual([
      { block: "2024-06-06", net: -800, n: 2 },
      { block: "2024-06-27", net: -100, n: 1 },
    ]);
    expect(worstBlocks(trades, 0)).toEqual([]);
  });
});

describe("sessionBefore and cutDate", () => {
  const days = ["2024-01-01", "2024-01-02", "2024-01-04", "2024-01-05", "2024-01-08"];

  it("finds the previous session", () => {
    expect(sessionBefore(days, "2024-01-04")).toBe("2024-01-02");
    expect(sessionBefore(days, "2024-01-03")).toBe("2024-01-02"); // not itself a session
    expect(sessionBefore(days, "2024-01-01")).toBeNull();
    expect(sessionBefore(days, "2024-02-01")).toBe("2024-01-08");
  });

  it("puts the walk-forward cut after the first ⌈60%⌉ of the days", () => {
    expect(cutDate(days)).toBe("2024-01-04"); // ⌈3⌉ = 3 days in sample
    expect(cutDate([...days].reverse())).toBe("2024-01-04");
    expect(cutDate(days.slice(0, 4))).toBe("2024-01-04"); // ⌈2.4⌉ = 3
    expect(cutDate([])).toBeNull();
  });
});

describe("pickBest", () => {
  it("picks the highest finite score and breaks ties by name", () => {
    const vs = [
      { name: "b", s: 10 },
      { name: "a", s: 10 },
      { name: "c", s: NaN },
      { name: "d", s: -5 },
    ];
    expect(pickBest(vs, (v) => v.s, (v) => v.name)?.name).toBe("a");
    expect(pickBest([{ name: "x", s: NaN }], (v) => v.s, (v) => v.name)).toBeNull();
    expect(pickBest(vs.slice(2), (v) => v.s, (v) => v.name)?.name).toBe("d");
  });
});

describe("robustness", () => {
  it("needs 80% of the perturbations positive and the worst within half the base", () => {
    expect(robustness(1000, [900, 800, 1200, 600, 700])).toMatchObject({ positive: 5, total: 5, worst: 600, pass: true });
    expect(robustness(1000, [900, 800, 1200, 400, 700]).pass).toBe(false); // worst below 500
    expect(robustness(1000, [900, 800, 1200, -10, 700]).pass).toBe(false); // 4/5 positive, but worst −10
    expect(robustness(1000, [900, 800, 1200, 600, 700, -1]).pass).toBe(false); // 5 of 6 (83%) positive, but the worst is below 500
    expect(robustness(-200, [-150, -100]).pass).toBe(false); // nothing positive
    expect(robustness(1000, []).pass).toBe(false);
  });
});

describe("overallVerdict", () => {
  it("fails on any failure or skipped step, else reports a small sample, else passes", () => {
    expect(overallVerdict(["PASS", "PASS", "N/A"])).toBe("PASS");
    expect(overallVerdict(["INSUFFICIENT", "PASS"])).toBe("INSUFFICIENT");
    expect(overallVerdict(["INSUFFICIENT", "FAIL"])).toBe("FAIL");
    expect(overallVerdict(["PASS", "NOT RUN"])).toBe("FAIL");
  });
});
