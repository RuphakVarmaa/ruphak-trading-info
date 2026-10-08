import { describe, expect, it } from "vitest";
import { makeConfig } from "../config";
import type { Position, RiskState } from "../types";
import { riskGates } from "./limits";

function state(openOnNifty: number): RiskState {
  const open = Array.from({ length: openOnNifty }, () => ({ index: "NIFTY", side: "BEAR" }) as unknown as Position);
  return {
    nowMs: Date.parse("2026-10-08T10:15:00+05:30"),
    settings: {
      mode: "PAPER",
      armedUntil: null,
      killSwitch: false,
      killReason: null,
      maxOpenPositions: 2,
      maxOrdersPerDay: 10,
      maxLotsPerOrder: 1,
      dailyLossCapInr: 15_000,
      maxPremiumPerTradeInr: 20_000,
      holidayOverrides: [],
      updatedMs: 0,
      updatedBy: "test",
    },
    capitalRupees: 500_000,
    day: { realized: 0, unrealized: 0, charges: 0, consecutiveLosses: 0 } as unknown as RiskState["day"],
    weekRealized: 0,
    openPositions: open,
    ordersToday: openOnNifty,
    entriesToday: { NIFTY: openOnNifty, SENSEX: 0 },
    lastStopOutMs: {},
  };
}

const perIndex = (open: number, limit: number) =>
  riskGates("NIFTY", "BEAR", state(open), makeConfig({ sizing: { maxOpenPerIndex: limit } })).find((g) => g.gate === "per_index")!;

describe("per-index open position gate", () => {
  it("blocks a second position when the limit is 1", () => {
    expect(perIndex(0, 1).passed).toBe(true);
    const g = perIndex(1, 1);
    expect(g.passed).toBe(false);
    expect(g.detail).toBe("1 of 1");
  });

  it("allows a second position, but not a third, when the limit is 2", () => {
    expect(perIndex(1, 2).passed).toBe(true);
    expect(perIndex(1, 2).detail).toBe("1 of 2");
    expect(perIndex(2, 2).passed).toBe(false);
  });
});
