import { describe, expect, it } from "vitest";
import {
  aggregate,
  drawInt,
  fillPrice,
  hhmmToMin,
  itmStrike,
  laterMode,
  minToHhmm,
  MinuteSeries,
  nearestListed,
  pairedGap,
  perturbDistance,
  positionValue,
  runPosition,
  typical,
  vwapOf,
  walkForwardSplit,
  type MinuteBar,
} from "./intraday1m";

const bar = (m: number, o: number, h: number, l: number, c: number, v = 100): MinuteBar => ({ m, o, h, l, c, v, oi: 0 });
/** A flat bar: open = high = low = close. */
const flat = (m: number, px: number, v = 100): MinuteBar => bar(m, px, px, px, px, v);

describe("clock helpers", () => {
  it("converts HH:MM and minutes of the day both ways", () => {
    expect(hhmmToMin("09:15")).toBe(555);
    expect(hhmmToMin("15:30")).toBe(930);
    expect(minToHhmm(555)).toBe("09:15");
    expect(minToHhmm(905)).toBe("15:05");
    expect(() => hhmmToMin("9.15")).toThrow();
  });
});

describe("MinuteSeries", () => {
  const s = new MinuteSeries([flat(560, 10), flat(555, 9), flat(557, 9.5)]);

  it("sorts bars and refuses two bars in one minute", () => {
    expect(s.bars.map((b) => b.m)).toEqual([555, 557, 560]);
    expect(() => new MinuteSeries([flat(555, 1), flat(555, 2)])).toThrow(/duplicate/);
  });

  it("finds the bar of a minute, the first bar within a wait, and the last bar so far", () => {
    expect(s.at(557)?.c).toBe(9.5);
    expect(s.at(556)).toBeUndefined();
    expect(s.firstFrom(556, 1)?.m).toBe(557);
    expect(s.firstFrom(558, 1)).toBeUndefined(); // 560 is beyond 558 + 1
    expect(s.firstFrom(558, 2)?.m).toBe(560);
    expect(s.lastUpTo(559)?.m).toBe(557);
    expect(s.lastUpTo(554)).toBeUndefined();
    expect(s.between(555, 560).map((b) => b.m)).toEqual([555, 557]);
    expect(s.first?.m).toBe(555);
    expect(s.last?.m).toBe(560);
  });

  it("lays the day out minute by minute, carrying the last close through minutes without a bar", () => {
    const d = new MinuteSeries([bar(557, 10, 12, 9, 11), bar(559, 11, 14, 10, 13)]).dense();
    expect(d.h.length).toBe(930 - 555 + 1);
    expect(Number.isNaN(d.c[0])).toBe(true); // 09:15, before the first bar
    expect([d.h[2], d.l[2], d.c[2], d.has[2]]).toEqual([12, 9, 11, 1]); // 09:17
    expect([d.h[3], d.l[3], d.c[3], d.has[3]]).toEqual([11, 11, 11, 0]); // 09:18 carries 11
    expect(d.c[930 - 555]).toBe(13);
  });
});

describe("fills", () => {
  const b = bar(600, 100, 104, 97, 101);

  it("sells at the low and buys at the high when conservative, at the close for mid, at the open for print", () => {
    expect(fillPrice(b, "sell", "conservative")).toBe(97);
    expect(fillPrice(b, "buy", "conservative")).toBe(104);
    expect(fillPrice(b, "sell", "mid")).toBe(101);
    expect(fillPrice(b, "buy", "mid")).toBe(101);
    expect(fillPrice(b, "sell", "print")).toBe(100);
  });

  it("prices every order after a print entry at the close", () => {
    expect(laterMode("print")).toBe("mid");
    expect(laterMode("conservative")).toBe("conservative");
  });
});

describe("aggregation and VWAP", () => {
  it("builds n-minute bars aligned to 09:15, skipping missing minutes and empty buckets", () => {
    const ones = [bar(555, 10, 12, 9, 11, 1), bar(556, 11, 13, 10, 12, 2), bar(559, 12, 12, 8, 9, 3), bar(566, 20, 21, 19, 20, 4), bar(930, 1, 1, 1, 1, 1)];
    const five = aggregate(ones, 5);
    expect(five).toEqual([
      { m: 555, o: 10, h: 13, l: 8, c: 9, v: 6, oi: 0 },
      { m: 565, o: 20, h: 21, l: 19, c: 20, v: 4, oi: 0 },
    ]);
  });

  it("weights each bar's typical price by its volume over [from, to)", () => {
    const bars = [bar(900, 0, 12, 6, 9, 1), bar(901, 0, 30, 0, 15, 3), bar(930, 0, 99, 99, 99, 5)];
    expect(typical(bars[0])).toBe(9);
    expect(vwapOf(bars, 900, 930)).toBeCloseTo((9 * 1 + 15 * 3) / 4, 10);
    expect(vwapOf(bars, 900, 930, (b) => b.c)).toBeCloseTo((9 + 45) / 4, 10);
    expect(vwapOf(bars, 931, 940)).toBeNull();
  });
});

describe("strike pickers", () => {
  const ks = [22900, 22950, 23000, 23050, 23100];

  it("takes the nearest listed strike, the lower one on a tie", () => {
    expect(nearestListed(ks, 23012)).toBe(23000);
    expect(nearestListed(ks, 23025)).toBe(23000);
    expect(nearestListed(ks, 23026)).toBe(23050);
    expect(nearestListed([], 23000)).toBeNull();
  });

  it("steps in the money: below the ATM for a call, above it for a put", () => {
    expect(itmStrike(ks, 23000, "CE", 1)).toBe(22950);
    expect(itmStrike(ks, 23000, "PE", 1)).toBe(23050);
    expect(itmStrike(ks, 23000, "CE", 0)).toBe(23000);
    expect(itmStrike(ks, 22900, "CE", 1)).toBeNull();
    expect(itmStrike(ks, 23010, "PE", 1)).toBeNull();
  });
});

describe("positions", () => {
  // A short straddle: the call and the put, each with a bar every minute 555..560 except where noted.
  const call = new MinuteSeries([bar(555, 100, 104, 96, 100), bar(556, 100, 101, 99, 100), bar(557, 100, 140, 99, 130), bar(558, 130, 131, 129, 130), bar(560, 120, 121, 118, 120)]);
  const put = new MinuteSeries([bar(555, 100, 103, 97, 100), bar(556, 100, 101, 99, 100), bar(557, 100, 101, 95, 96), bar(559, 96, 97, 95, 96), bar(560, 90, 91, 89, 90)]);
  const legs = [
    { series: call, side: "short" as const },
    { series: put, side: "short" as const },
  ];

  it("values a position at adverse prices (conservative) or closes, carrying a missing bar's last close", () => {
    expect(positionValue(legs, 557, "conservative")).toBe(-(140 + 101));
    expect(positionValue(legs, 557, "mid")).toBe(-(130 + 96));
    expect(positionValue(legs, 558, "mid")).toBe(-(130 + 96)); // the put has no 558 bar: its 557 close
    expect(positionValue(legs, 554, "mid")).toBeNull();
  });

  it("enters at the low (conservative sells), holds to the exit and buys back at the high", () => {
    const r = runPosition({ legs, entryMin: 555, entryWait: 0, exitMin: 560, exitWait: 0, stopFrac: null, mode: "conservative" });
    expect(r).not.toBeNull();
    expect(r!.entryValue).toBe(-(96 + 97));
    expect(r!.legs.map((l) => [l.entry, l.exit])).toEqual([
      [96, 121],
      [97, 91],
    ]);
    expect(r!.exitReason).toBe("time");
  });

  it("stops when the premium's adverse value reaches 1 + stop times the credit, filling at that minute's adverse prices", () => {
    // Credit 193 (conservative); +20% -> 231.6; minute 557 adverse cost 140 + 101 = 241.
    const r = runPosition({ legs, entryMin: 555, entryWait: 0, exitMin: 560, exitWait: 0, stopFrac: 0.2, mode: "conservative" });
    expect(r!.exitReason).toBe("stop");
    expect(r!.exitMin).toBe(557);
    expect(r!.legs.map((l) => l.exit)).toEqual([140, 101]);
    // On closes (mid) the credit is 200 and the 557 cost 226 < 240: no stop at 20%.
    const mid = runPosition({ legs, entryMin: 555, entryWait: 0, exitMin: 560, exitWait: 0, stopFrac: 0.2, mode: "mid" });
    expect(mid!.exitReason).toBe("time");
    expect(mid!.legs.map((l) => l.exit)).toEqual([120, 90]);
  });

  it("stops a long when its value falls by the stop fraction", () => {
    const long = new MinuteSeries([flat(600, 100), bar(601, 100, 100, 69, 75), flat(605, 80)]);
    const r = runPosition({ legs: [{ series: long, side: "long" }], entryMin: 600, entryWait: 0, exitMin: 605, exitWait: 0, stopFrac: 0.3, mode: "conservative" });
    expect(r!.exitReason).toBe("stop");
    expect(r!.legs[0].exit).toBe(69);
    const mid = runPosition({ legs: [{ series: long, side: "long" }], entryMin: 600, entryWait: 0, exitMin: 605, exitWait: 0, stopFrac: 0.3, mode: "mid" });
    expect(mid!.exitReason).toBe("time");
    expect(mid!.legs[0].exit).toBe(80);
  });

  it("waits for a leg's first bar, refuses a missing entry and marks a stale exit", () => {
    const thin = new MinuteSeries([flat(557, 50), flat(590, 40)]);
    const thick = new MinuteSeries([flat(555, 50), flat(556, 50), flat(557, 50), flat(600, 45)]);
    const pos = (entryWait: number) => runPosition({ legs: [{ series: thin, side: "long" }, { series: thick, side: "long" }], entryMin: 555, entryWait, exitMin: 600, exitWait: 2, stopFrac: null, mode: "mid" });
    expect(pos(1)).toBeNull();
    const r = pos(2)!;
    expect(r.entryMin).toBe(557);
    expect(r.legs[0]).toMatchObject({ exit: 40, staleExit: true });
    expect(r.legs[1]).toMatchObject({ exit: 45, staleExit: false, exitMin: 600 });
  });

  it("uses the open for a print entry and closes afterwards", () => {
    const r = runPosition({ legs, entryMin: 555, entryWait: 0, exitMin: 560, exitWait: 0, stopFrac: null, mode: "print" });
    expect(r!.legs.map((l) => [l.entry, l.exit])).toEqual([
      [100, 120],
      [100, 90],
    ]);
  });
});

describe("placebo gap and perturbations", () => {
  it("pairs strategy and placebo by session, weighting sessions by their trades", () => {
    const r = pairedGap([
      { n: 1, s: 100, p: 40 },
      { n: 2, s: -50, p: -80 },
      { n: 1, s: 10, p: 30 },
      { n: 0, s: NaN, p: 5 },
    ]);
    // differences 60, 30 (x2), -20 -> (60 + 60 - 20) / 4 = 25
    expect(r.gap).toBeCloseTo(25, 10);
    expect(r.sessions).toBe(3);
    expect(r.trades).toBe(4);
    // CR1: sqrt(3/2 * ((60-25)^2 + (2*(30-25))^2 + (-20-25)^2)) / 4
    expect(r.se).toBeCloseTo(Math.sqrt(1.5 * (35 ** 2 + 10 ** 2 + 45 ** 2)) / 4, 10);
    expect(r.t).toBeCloseTo(r.gap / r.se, 10);
    expect(pairedGap([]).sessions).toBe(0);
  });

  it("moves a time distance by ±20%, at least a minute, never past the anchor", () => {
    expect(perturbDistance(0)).toEqual([1]); // 09:15 -> 09:16 only
    expect(perturbDistance(1)).toEqual([0, 2]);
    expect(perturbDistance(5)).toEqual([4, 6]);
    expect(perturbDistance(15)).toEqual([12, 18]);
    expect(perturbDistance(120)).toEqual([96, 144]);
    expect(perturbDistance(30)).toEqual([24, 36]); // an exit at 15:00 -> 15:06 and 14:54
    expect(perturbDistance(10)).toEqual([8, 12]);
  });
});

describe("samples", () => {
  it("splits days 60/40 in date order", () => {
    const days = ["2024-01-05", "2024-01-01", "2024-01-03", "2024-01-02", "2024-01-04"];
    expect(walkForwardSplit(days)).toEqual({ train: ["2024-01-01", "2024-01-02", "2024-01-03"], test: ["2024-01-04", "2024-01-05"] });
  });

  it("maps a uniform draw onto an inclusive integer range", () => {
    expect(drawInt(0, 555, 840)).toBe(555);
    expect(drawInt(0.999999, 555, 840)).toBe(840);
    expect(drawInt(0.5, 0, 1)).toBe(1);
  });
});
