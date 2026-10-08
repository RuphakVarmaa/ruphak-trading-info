import { describe, expect, it } from "vitest";
import type { PositionView } from "@/engine/api-types";
import { capitalSlices, pnlSlices } from "./pieData";

const pos = (id: string, strike: number, avgPrice: number, pnl: number) =>
  ({ id, avgPrice, qty: 65, pnl, contract: { strike, optionType: "PE" } }) as unknown as PositionView;

describe("capitalSlices", () => {
  it("splits capital into one slice per position plus free capital", () => {
    const c = capitalSlices(500_000, [pos("a", 22500, 143.45, 0), pos("b", 22450, 146.55, 0)]);
    expect(c.slices.map((s) => s.label)).toEqual(["22500 PE", "22450 PE", "Free capital"]);
    expect(c.used).toBeCloseTo(18_850, 6);
    expect(c.usedPct).toBeCloseTo(3.77, 2);
    expect(c.slices.reduce((s, x) => s + x.value, 0)).toBeCloseTo(500_000, 6);
  });

  it("is all free capital with no positions", () => {
    const c = capitalSlices(500_000, []);
    expect(c.slices).toHaveLength(1);
    expect(c.slices[0].label).toBe("Free capital");
    expect(c.usedPct).toBe(0);
  });

  it("folds a fourth and later position into one slice", () => {
    const c = capitalSlices(500_000, [1, 2, 3, 4, 5].map((i) => pos(String(i), 22000 + i * 50, 100, 0)));
    expect(c.slices.map((s) => s.label)).toEqual(["22050 PE", "22100 PE", "22150 PE", "Other positions", "Free capital"]);
    expect(c.slices.find((s) => s.key === "other")!.value).toBeCloseTo(2 * 100 * 65, 6);
  });

  it("never lets free capital go negative", () => {
    expect(capitalSlices(5_000, [pos("a", 22500, 143.45, 0)]).slices.at(-1)!.value).toBe(0);
  });
});

describe("pnlSlices", () => {
  it("counts open gains and the realized total as profit, and nets to the page's net", () => {
    const p = pnlSlices({ realized: 0, positions: [pos("a", 22500, 143.45, 2231), pos("b", 22450, 146.55, 339)], charges: 56 });
    expect(p.gains).toBe(2570);
    expect(p.losses).toBe(0);
    expect(p.net).toBe(2514);
    expect(p.slices.map((s) => s.label)).toEqual(["Profit (gross)", "Charges"]);
  });

  it("separates gross profit from gross loss across closed and open trades", () => {
    const p = pnlSlices({ realized: -2516, positions: [pos("a", 22500, 143.45, 2139), pos("b", 22450, 146.55, -300)], charges: 90 });
    expect(p.gains).toBe(2139);
    expect(p.losses).toBe(2816);
    expect(p.net).toBe(2139 - 2816 - 90);
    expect(p.slices.map((s) => s.label)).toEqual(["Profit (gross)", "Loss (gross)", "Charges"]);
  });

  it("has no slices before any trade", () => {
    const p = pnlSlices({ realized: 0, positions: [], charges: 0 });
    expect(p.slices).toEqual([]);
    expect(p.net).toBe(0);
  });
});
