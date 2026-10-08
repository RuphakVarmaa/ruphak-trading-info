import { describe, expect, it } from "vitest";
import type { LiveIndexBar } from "@/lib/market/liveIndices";
import { gutterWidth, istDay, linePath, marksOnSession, nearestPoint, niceStep, niceTicks, pricePoints, SESSION_MINUTES, sessionMinute, spreadLabels, timeTicks, yDomain } from "./chartGeometry";

const at = (hm: string, s = 0) => Date.parse(`2026-10-08T${hm}:00+05:30`) + s * 1000;
const b = (hm: string, o: number, h: number, l: number, c: number): LiveIndexBar => ({ t: at(hm), o, h, l, c });
const BARS = [b("09:15", 100, 104, 99, 103), b("09:16", 103, 105, 102, 104), b("09:17", 104, 104, 100, 101)];

describe("time scale", () => {
  it("measures minutes from 09:15 IST, clamped to the session", () => {
    expect(sessionMinute(at("09:15"))).toBe(0);
    expect(sessionMinute(at("12:22", 30))).toBe(187.5);
    expect(sessionMinute(at("15:30"))).toBe(SESSION_MINUTES);
    expect(sessionMinute(at("08:00"))).toBe(0);
    expect(sessionMinute(at("16:10"))).toBe(SESSION_MINUTES);
    expect(istDay(at("00:10"))).toBe("2026-10-08");
  });

  it("keeps time labels apart on a phone and shows them all when wide", () => {
    expect(timeTicks(254).map((t) => t.label)).toEqual(["09:15", "11:00", "12:00", "13:00", "14:00", "15:30"]);
    // 15:00 sits 44 px from the right-aligned 15:30 label at 550 px: dropped.
    expect(timeTicks(550).map((t) => t.label)).toEqual(["09:15", "10:00", "11:00", "12:00", "13:00", "14:00", "15:30"]);
    expect(timeTicks(1000).map((t) => t.label)).toEqual(["09:15", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"]);
    expect(timeTicks(120).map((t) => t.label)).toEqual(["09:15", "12:00", "15:30"]);
  });

  it("sizes the price gutter to its longest tag", () => {
    expect(gutterWidth(["22,231.80", "22,600"])).toBe(68);
    expect(gutterWidth(["↑ 1,00,000.00"])).toBe(93);
    expect(gutterWidth([])).toBe(62);
  });
});

describe("price path", () => {
  it("starts at the first open, then each close at its bar's close time, with the running VWAP", () => {
    const pts = pricePoints(BARS, at("09:17", 40));
    expect(pts.map((p) => [p.t, p.price, p.bar])).toEqual([
      [at("09:15"), 100, -1],
      [at("09:16"), 103, 0],
      [at("09:17"), 104, 1],
      [at("09:17", 40), 101, 2], // the forming bar sits at the last trade, not a minute ahead
    ]);
    expect(pts[1].vwap).toBeCloseTo((104 + 99 + 103) / 3, 9);
    expect(pts[3].vwap).toBeCloseTo(((104 + 99 + 103) / 3 + (105 + 102 + 104) / 3 + (104 + 100 + 101) / 3) / 3, 9);
    expect(pricePoints(BARS, null)[3].t).toBe(at("09:18"));
    expect(pricePoints([], null)).toEqual([]);
  });

  it("finds the nearest point to a time", () => {
    const pts = pricePoints(BARS, null);
    expect(nearestPoint(pts, at("09:15", 10))).toBe(0);
    expect(nearestPoint(pts, at("09:16", 35))).toBe(2);
    expect(nearestPoint(pts, at("15:00"))).toBe(3);
    expect(nearestPoint([], at("09:15"))).toBe(-1);
  });

  it("draws a path", () => {
    expect(
      linePath([
        [0, 1],
        [2.25, 3.5],
      ]),
    ).toBe("M0.0,1.0L2.3,3.5");
  });
});

describe("price axis", () => {
  const pts = pricePoints(BARS, null);
  const base = { price: 101, prevClose: null, openingRange: null };

  it("covers the path, the VWAP and the trade levels, with headroom", () => {
    const d = yDomain(base, pts, { stop: 95, target: 110 });
    expect(d.min).toBeCloseTo(95 - 15 * 0.06, 9);
    expect(d.max).toBeCloseTo(110 + 15 * 0.06, 9);
    expect(d.prevClose).toBeNull();
  });

  it("keeps a near previous close in view and notes a far one at the edge", () => {
    expect(yDomain({ ...base, prevClose: 106 }, pts).prevClose).toBe("in");
    expect(yDomain({ ...base, prevClose: 106 }, pts).max).toBeGreaterThan(106);
    const far = yDomain({ ...base, prevClose: 150 }, pts);
    expect(far.prevClose).toBe("above");
    expect(far.max).toBeLessThan(110);
    expect(yDomain({ ...base, prevClose: 50 }, pts).prevClose).toBe("below");
  });

  it("has height with a single price", () => {
    const d = yDomain({ ...base, price: 22000 }, []);
    expect(d.max).toBeGreaterThan(d.min);
  });

  it("picks round ticks", () => {
    expect(niceStep(37)).toBe(50);
    expect(niceStep(23)).toBe(25);
    expect(niceStep(0.7)).toBe(0.5);
    expect(niceStep(110)).toBe(100);
    expect(niceTicks(22170, 22610, 4)).toEqual([22200, 22300, 22400, 22500, 22600]);
    expect(niceTicks(71300, 72700, 4)).toEqual([71500, 72000, 72500]);
    expect(niceTicks(5, 5)).toEqual([]);
  });
});

describe("labels and marks", () => {
  it("moves overlapping labels apart inside the plot, in input order", () => {
    expect(spreadLabels([50, 52, 120], 12, 10, 200)).toEqual([50, 62, 120]);
    expect(spreadLabels([52, 50], 12, 10, 200)).toEqual([62, 50]);
    expect(spreadLabels([198, 199, 200], 12, 10, 200)).toEqual([176, 188, 200]);
    expect(spreadLabels([], 12, 10, 200)).toEqual([]);
  });

  it("draws an entry or exit only on its own session; levels always", () => {
    const marks = { entry: { t: at("10:05"), price: 22500, side: "BUY" as const }, exit: { t: Date.parse("2026-10-07T14:00:00+05:30"), price: 22400 }, stop: 22300 };
    const m = marksOnSession(marks, "2026-10-08");
    expect(m.entry).toEqual(marks.entry);
    expect(m.exit).toBeUndefined();
    expect(m.stop).toBe(22300);
    expect(marksOnSession(undefined, "2026-10-08")).toEqual({});
  });
});
