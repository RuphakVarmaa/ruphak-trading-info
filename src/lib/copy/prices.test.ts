import { describe, expect, it } from "vitest";
import { buyLimit, ceilTick, floorTick, indexLevel, isOnTick, nearestTick, rupees, wholeRupees } from "./prices";

describe("tick rounding", () => {
  it("rounds up, down and to the nearest 0.05 without float drift", () => {
    expect(ceilTick(146.61)).toBe(146.65);
    expect(ceilTick(146.65)).toBe(146.65);
    expect(ceilTick(100.345)).toBe(100.35);
    expect(floorTick(100.345)).toBe(100.3);
    expect(floorTick(99.75)).toBe(99.75);
    expect(floorTick(109.4275)).toBe(109.4);
    expect(nearestTick(100.374)).toBe(100.35);
    expect(nearestTick(100.376)).toBe(100.4);
    // Values whose ×20 lands a hair off an integer in binary floating point stay put.
    for (const x of [0.05, 0.15, 1.1, 99.95, 145.35, 146.65, 171.75, 2907 / 20]) {
      expect(ceilTick(x)).toBe(x);
      expect(floorTick(x)).toBe(x);
    }
  });

  it("knows what is on the tick", () => {
    expect(isOnTick(146.65)).toBe(true);
    expect(isOnTick(0.05)).toBe(true);
    expect(isOnTick(142.5)).toBe(true);
    expect(isOnTick(146.62)).toBe(false);
    expect(isOnTick(Number.NaN)).toBe(false);
  });
});

describe("buyLimit", () => {
  it("is the fill plus 2 %, rounded up to the tick", () => {
    expect(buyLimit(142.5)).toBe(145.35);
    expect(buyLimit(168.35)).toBe(171.75);
    expect(buyLimit(55)).toBe(56.1);
    expect(isOnTick(buyLimit(123.45))).toBe(true);
    expect(buyLimit(123.45)).toBeGreaterThanOrEqual(123.45 * 1.02);
  });

  it("leaves at least two ticks of room on very cheap options", () => {
    expect(buyLimit(3)).toBe(3.1);
    expect(buyLimit(0.05)).toBe(0.15);
  });
});

describe("formatting", () => {
  it("formats rupees and index levels the Indian way", () => {
    expect(rupees(146.65)).toBe("₹146.65");
    expect(rupees(9448.25)).toBe("₹9,448.25");
    expect(rupees(-2.5)).toBe("−₹2.50");
    expect(wholeRupees(123456.4)).toBe("₹1,23,456");
    expect(wholeRupees(-2555)).toBe("−₹2,555");
    expect(wholeRupees(1150, true)).toBe("+₹1,150");
    expect(wholeRupees(0, true)).toBe("₹0");
    expect(indexLevel(22631)).toBe("22,631");
    expect(indexLevel(81234)).toBe("81,234");
  });
});
