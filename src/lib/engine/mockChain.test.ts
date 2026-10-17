import { describe, expect, it } from "vitest";
import type { OptionChainRowView, OptionSideView } from "@/engine/api-types";
import { istAt } from "@/lib/ist";
import { isMockHoliday } from "./fixtures";
import { buildMockChain, chainMaxPain, chainPcr, weeklyExpiries } from "./mockChain";
import { MockEngineApi } from "./mock";

const side = (oi: number): OptionSideView =>
  ({ instrumentKey: "x", ltp: 1, close: 1, change: 0, changePct: 0, bid: 1, ask: 1, bidQty: 1, askQty: 1, volume: 1, oi, prevOi: oi, oiChange: 0, iv: 10, delta: 0, gamma: 0, theta: 0, vega: 0, pop: 0 });

describe("chain maths", () => {
  it("pcr is put OI over call OI", () => {
    const rows: OptionChainRowView[] = [
      { strike: 100, ce: side(10), pe: side(30) },
      { strike: 110, ce: side(30), pe: side(10) },
    ];
    expect(chainPcr(rows)).toBe(1);
    expect(chainPcr([{ strike: 100, ce: side(0), pe: side(5) }])).toBeNull();
  });

  it("max pain is the strike minimising buyers' payoff", () => {
    // Light call OI at 100, heavy put OI at 120: at 100 the puts pay 20 000, at 110 11 000, at 120 only the calls' 2 000.
    const rows: OptionChainRowView[] = [
      { strike: 100, ce: side(100), pe: side(0) },
      { strike: 110, ce: side(0), pe: side(0) },
      { strike: 120, ce: side(0), pe: side(1000) },
    ];
    expect(chainMaxPain(rows)).toBe(120);
    expect(chainMaxPain([{ strike: 1, ce: null, pe: null }])).toBeNull();
  });
});

describe("mock chain", () => {
  const now = istAt("2026-10-14", "11:42");
  const expiries = weeklyExpiries("NIFTY", now, isMockHoliday);

  it("lists four weekly expiries, nearest first", () => {
    expect(expiries).toHaveLength(4);
    expect([...expiries].sort()).toEqual(expiries);
    expect(new Set(expiries).size).toBe(4);
  });

  it("is a sane NIFTY chain", () => {
    const c = buildMockChain({ index: "NIFTY", spot: 22646.35, prevSpot: 22518.1, nowMs: now, expiries });
    expect(c.lotSize).toBe(65);
    expect(c.atmStrike).toBe(22650);
    expect(c.expiry).toBe(expiries[0]);
    expect(c.rows).toHaveLength(51);
    const strikes = c.rows.map((r) => r.strike);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    expect(strikes.every((s) => s % 50 === 0)).toBe(true);
    expect(c.pcr).toBe(chainPcr(c.rows));
    expect(c.pcr).toBeGreaterThan(0.4);
    expect(c.pcr).toBeLessThan(2.5);
    expect(c.maxPain).not.toBeNull();
    expect(Math.abs((c.maxPain ?? 0) - c.spot)).toBeLessThan(600);
    for (const r of c.rows) {
      for (const s of [r.ce, r.pe]) {
        expect(s?.bid ?? 0).toBeLessThan(s?.ask ?? 0);
        expect((s?.oi ?? 0) % 65).toBe(0);
      }
    }
    // Calls fall and puts rise with the strike; put skew: OTM put IV above OTM call IV at equal distance.
    const ce = c.rows.map((r) => r.ce?.ltp ?? 0);
    expect(ce[0]).toBeGreaterThan(ce[ce.length - 1]);
    const lo = c.rows[15];
    const hi = c.rows[35];
    expect(lo.pe?.iv ?? 0).toBeGreaterThan(hi.ce?.iv ?? 0);
  });

  it("is a sane SENSEX chain for a later expiry", () => {
    const ex = weeklyExpiries("SENSEX", now, isMockHoliday);
    const c = buildMockChain({ index: "SENSEX", spot: 72640.8, prevSpot: 72301.45, nowMs: now, expiries: ex, expiry: ex[2] });
    expect(c.expiry).toBe(ex[2]);
    expect(c.lotSize).toBe(20);
    expect(c.rows.every((r) => r.strike % 100 === 0)).toBe(true);
  });

  it("is served by the mock engine", async () => {
    const api = new MockEngineApi("real");
    const c = await api.getOptionChain("NIFTY");
    expect(c.error).toBeNull();
    expect(c.rows.length).toBeGreaterThan(0);
    expect(c.source).toBe("mock");
  });
});
