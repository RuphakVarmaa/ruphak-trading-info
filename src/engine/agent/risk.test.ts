import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig, maxOpenTotal, type EngineConfig } from "../config";
import { newLedger } from "../pipeline/riskState";
import { riskGates } from "../risk/limits";
import { defaultSettings } from "../settings";
import type { Position, RiskState } from "../types";
import { AGENT_LIMITS } from "./constants";
import { drawdownBreached, riskSnapshotFrom } from "./risk";
import type { AgentRiskSnapshot } from "./types";

const NOW = istAt("2026-10-19", "11:00");
const flags = { killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, nowMs: NOW };

function riskState(o: { startEquity?: number; realized?: number; unrealized?: number; charges?: number; open?: Partial<Position>[]; pending?: number; entries?: [number, number] } = {}): RiskState {
  const cfg = accountConfig(DEFAULT_CONFIG, "agent");
  const day = newLedger("2026-10-19", "PAPER", o.startEquity ?? 500_000, NOW);
  day.realized = o.realized ?? 0;
  day.unrealized = o.unrealized ?? 0;
  day.charges = o.charges ?? 0;
  return {
    nowMs: NOW,
    settings: defaultSettings(cfg, NOW),
    capitalRupees: day.startEquity,
    day,
    weekRealized: 0,
    openPositions: (o.open ?? []).map((p, i) => ({ id: `p${i}`, index: "NIFTY", side: "BULL", qty: 65, avgEntry: 150, unrealized: 0, ...p }) as Position),
    ordersToday: 0,
    entriesToday: { NIFTY: o.entries?.[0] ?? 0, SENSEX: o.entries?.[1] ?? 0 },
    lastStopOutMs: {},
    pendingEntries: Array.from({ length: o.pending ?? 0 }, () => ({ index: "SENSEX" as const, side: "BULL" as const })),
  };
}

describe("riskSnapshotFrom", () => {
  it("marks equity to market and measures today's loss on the equity sizing uses", () => {
    const s = riskSnapshotFrom(riskState({ realized: -10_000, unrealized: -2_500, charges: 500 }), null, flags);
    expect(s).toMatchObject({ t: NOW, date: "2026-10-19", equity: 487_000, peakEquity: 487_000, ddPct: 0, killSwitch: false, ddHalt: false });
    expect(s.dayLossPct).toBeCloseTo(2.6, 10);
    // 2.6% lost today is past 0.8 × the 3% cap.
    expect(s.codeRisk).toBe("REDUCE");
  });

  it("keeps the peak across days and measures the drawdown from it", () => {
    const s = riskSnapshotFrom(riskState({ startEquity: 490_000, realized: 3_000 }), 520_000, flags);
    expect(s.peakEquity).toBe(520_000);
    expect(s.ddPct).toBeCloseTo(((520_000 - 493_000) / 520_000) * 100, 10);
    const up = riskSnapshotFrom(riskState({ realized: 30_000 }), 520_000, flags);
    expect(up).toMatchObject({ equity: 530_000, peakEquity: 530_000, ddPct: 0 });
  });

  it("restarts the peak at the current equity without a previous one (first run or a re-arm)", () => {
    expect(riskSnapshotFrom(riskState({ startEquity: 420_000 }), null, flags)).toMatchObject({ peakEquity: 420_000, ddPct: 0 });
    expect(riskSnapshotFrom(riskState({ startEquity: 420_000 }), Number.NaN, flags)).toMatchObject({ peakEquity: 420_000, ddPct: 0 });
  });

  it("counts working entry orders as open, and a position marked at a non-number as a total loss", () => {
    const s = riskSnapshotFrom(riskState({ open: [{}], pending: 1, entries: [1, 0] }), null, flags);
    expect(s.openPositions).toBe(2);
    expect(s.codeRisk).toBe("NEAR_LIMIT");
    const broken = riskSnapshotFrom(riskState({ unrealized: Number.NaN, open: [{ unrealized: Number.NaN, avgEntry: 150, qty: 65 }] }), 500_000, flags);
    expect(broken.equity).toBe(500_000 - 150 * 65);
    expect(Number.isFinite(broken.ddPct)).toBe(true);
  });

  it("is near the limit one entry short of the agent's six trades a day", () => {
    expect(riskSnapshotFrom(riskState({ entries: [3, 2] }), null, flags).codeRisk).toBe("NEAR_LIMIT");
    expect(riskSnapshotFrom(riskState({ entries: [2, 2] }), null, flags).codeRisk).toBe("SAFE");
    expect(riskSnapshotFrom(riskState({ entries: [2, 2] }), null, { ...flags, maxTradesPerDay: 5 }).codeRisk).toBe("NEAR_LIMIT");
  });

  it("carries the kill switches and the drawdown halt", () => {
    const s = riskSnapshotFrom(riskState(), null, { killSwitch: true, killReason: "max drawdown", mainKillSwitch: true, ddHalt: true, nowMs: NOW });
    expect(s).toMatchObject({ killSwitch: true, killReason: "max drawdown", mainKillSwitch: true, ddHalt: true });
  });

  it("carries the week's realized loss and today's losing streak, at the caps where the planner's gates refuse every entry", () => {
    const cfg = accountConfig(DEFAULT_CONFIG, "agent");
    for (const [weekRealized, streak] of [
      [-29_999, 2],
      [-30_000, 3],
      [12_000, 0],
    ] as const) {
      const r = riskState();
      r.weekRealized = weekRealized;
      r.day.consecutiveLosses = streak;
      const s = riskSnapshotFrom(r, null, flags);
      expect(s.weekLossPct).toBeCloseTo(Math.max(0, -weekRealized) / 5_000, 10);
      expect(s.lossStreak).toBe(streak);
      const gates = riskGates("NIFTY", "BULL", r, cfg);
      expect(gates.find((g) => g.gate === "weekly_loss")?.passed, `${weekRealized}`).toBe((s.weekLossPct ?? 0) < AGENT_LIMITS.weeklyLossCapPct);
      expect(gates.find((g) => g.gate === "loss_streak")?.passed, `${streak}`).toBe((s.lossStreak ?? 0) < AGENT_LIMITS.maxLossStreak);
      // Neither is part of the code's risk state (the model's snapshot and the gate's risk line read that).
      expect(s.codeRisk).toBe("SAFE");
    }
  });
});

describe("drawdownBreached", () => {
  const at = (ddPct: number) => drawdownBreached({ ddPct } as AgentRiskSnapshot);

  it("halts at a drawdown of exactly 15.00% from the peak, not before", () => {
    expect(at(15)).toBe(true);
    expect(at(15.0000000001)).toBe(true);
    expect(at(14.99)).toBe(false);
    expect(at(0)).toBe(false);
    expect(at(Number.NaN)).toBe(true);
    // ₹5,00,000 down to ₹4,25,000 is 15.00%; ₹1 better is not.
    expect(drawdownBreached(riskSnapshotFrom(riskState({ realized: -75_000 }), 500_000, flags))).toBe(true);
    expect(drawdownBreached(riskSnapshotFrom(riskState({ realized: -74_999 }), 500_000, flags))).toBe(false);
  });
});

describe("AGENT_LIMITS", () => {
  function agrees(base: EngineConfig) {
    const cfg = accountConfig(base, "agent");
    expect(cfg.capitalRupees).toBe(AGENT_LIMITS.capitalRupees);
    expect(cfg.risk.dailyLossCapPct).toBe(AGENT_LIMITS.dailyLossCapPct);
    expect(cfg.risk.weeklyLossCapPct).toBe(AGENT_LIMITS.weeklyLossCapPct);
    expect(cfg.risk.maxConsecutiveLossesPerDay).toBe(AGENT_LIMITS.maxLossStreak);
    expect(maxOpenTotal(cfg)).toBe(AGENT_LIMITS.maxOpenTotal);
    expect(cfg.sizing.maxOpenPerIndex).toBe(AGENT_LIMITS.maxOpenPerIndex);
    expect(cfg.sizing.maxLots).toBe(AGENT_LIMITS.maxLotsPerPosition);
    expect(cfg.sizing.maxRiskPctPerTrade).toBe(AGENT_LIMITS.maxRiskPctPerTrade);
    expect(cfg.sizing.kellyFraction).toBe(AGENT_LIMITS.kellyFraction);
    expect(defaultSettings(cfg, NOW).maxOpenPositions).toBe(AGENT_LIMITS.maxOpenTotal);
  }

  it("agree with the agent account's pinned config", () => {
    agrees(DEFAULT_CONFIG);
  });

  it("still agree when main's Worker settings differ", () => {
    agrees(makeConfig({ capitalRupees: 123, sizing: { maxOpenPerIndex: 2, maxTradesPerDay: 8, maxLots: 10 }, risk: { dailyLossCapPct: 5 }, gates: { expectedMoveModel: "legacy" } }));
  });
});
