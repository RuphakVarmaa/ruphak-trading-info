import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { roundTripChargesPerUnit } from "../broker/charges";
import { istAt, istDate } from "../clock";
import { makeConfig, premiumBand } from "../config";
import { computeFeatures } from "../market/features";
import { loadRiskState } from "../pipeline/riskState";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId, PlanDecision, Position, RiskState, TradeSide } from "../types";
import { planEntry } from "./planner";

const fixtures = loadMarketFixtures();
const T = istAt("2026-10-07", "11:00");

// Main's signals are taken as given (a passing conviction); the gates that judge the market are
// opened so that only the account's own contract, sizing and risk checks decide.
const mainCfg = makeConfig({
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0, maxSpreadPct: 100 },
});
const cfg = accountConfig(mainCfg, "small5k");

function conviction(index: IndexId, side: TradeSide): Conviction {
  const score = side === "BULL" ? 0.7 : -0.7;
  return {
    index,
    t: T,
    score,
    components: [{ source: "MOMENTUM", value: Math.sign(score), weight: 0.15, horizonMin: 60, enabled: true }],
    regime: "RANGE",
    threshold: 0.55,
    passes: true,
    sizeMult: 1,
    stance: side === "BULL" ? "BULLISH" : "BEARISH",
    activeWeight: 0.3,
  };
}

async function plan(index: IndexId, side: TradeSide, tweak: (r: RiskState) => void = () => {}): Promise<PlanDecision> {
  const deps = createReplayDeps({ cfg, startMs: T, candles: fixtures.candles, daily: fixtures.daily });
  const snap = await deps.market.snapshot(T);
  const features = computeFeatures(index, snap, deps.calendar, cfg);
  const risk = await loadRiskState(deps.repo, cfg, await deps.repo.settings.get(), T, "BACKTEST");
  tweak(risk);
  return planEntry({ index, t: T, features, pressure: null, conviction: conviction(index, side), risk, perf: [] }, deps);
}

const gate = (d: PlanDecision, name: string) => d.gates.find((g) => g.gate === name);

describe("₹5k account entry planning", () => {
  it("plans exactly one lot of a NIFTY strike in the ₹40–60 band, with room under ₹1,500", async () => {
    for (const side of ["BULL", "BEAR"] as const) {
      const d = await plan("NIFTY", side);
      expect(d.plan, d.noPlanReason ?? "").not.toBeNull();
      expect(d.plan!.lots).toBe(1);
      expect(d.plan!.qty).toBe(65);
      expect(d.plan!.contract.type).toBe(side === "BULL" ? "CE" : "PE");
      expect(d.plan!.refPremium).toBeGreaterThanOrEqual(40);
      expect(d.plan!.refPremium).toBeLessThanOrEqual(60);
      expect(d.plan!.refPremium * 65).toBeLessThanOrEqual(3_900);
      expect(gate(d, "premium_band")?.passed).toBe(true);
      expect(gate(d, "loss_room")?.passed).toBe(true);
      expect(d.plan!.stops).toMatchObject({ stopPct: -35, targetPct: 60 });
    }
  });

  it("plans one SENSEX lot inside its band", async () => {
    const d = await plan("SENSEX", "BEAR");
    const band = premiumBand(cfg, "SENSEX");
    expect(d.contract?.index).toBe("SENSEX");
    if (d.plan) {
      expect(d.plan.qty).toBe(20);
      expect(d.plan.refPremium).toBeGreaterThanOrEqual(band.minPremium);
      expect(d.plan.refPremium).toBeLessThanOrEqual(band.maxPremium);
    } else {
      // Only the account's own checks may refuse it.
      expect(["premium_band", "loss_room"]).toContain(d.gates.find((g) => g.passed === false)?.gate);
    }
  });

  it("blocks an entry whose stop-out would take the day's loss past ₹1,500", async () => {
    const free = await plan("NIFTY", "BEAR");
    const p = free.plan!;
    // The stop-out (35% of the lot) plus the round-trip charges.
    const atRisk = p.riskRupees + roundTripChargesPerUnit(p.refPremium, p.contract.lotSize, p.contract.exchange, istDate(T)) * p.contract.lotSize;
    expect(atRisk).toBeLessThan(1_500);
    const lostBy = (rupees: number) => (r: RiskState) => {
      r.day.realized = -rupees;
    };
    // ₹1 more lost today than the stop-out leaves room for: refused, and only by the loss-room check.
    const over = await plan("NIFTY", "BEAR", lostBy(Math.ceil(1_500 - atRisk) + 1));
    expect(over.plan).toBeNull();
    expect(gate(over, "loss_room")?.passed).toBe(false);
    expect(over.gates.filter((g) => g.passed === false).map((g) => g.gate)).toEqual(["loss_room"]);
    expect(over.noPlanReason).toMatch(/Room under the daily loss cap/);
    // ₹1 less: allowed.
    const under = await plan("NIFTY", "BEAR", lostBy(Math.floor(1_500 - atRisk) - 1));
    expect(under.plan?.lots).toBe(1);
  });

  it("stops for the day at ₹1,500 lost", async () => {
    const d = await plan("NIFTY", "BEAR", (r) => {
      r.day.realized = -1_500;
    });
    expect(d.plan).toBeNull();
    expect(gate(d, "halt")).toMatchObject({ passed: false });
    expect(gate(d, "halt")?.detail).toMatch(/cap ₹1500/);
  });

  it("stops for the day after one losing trade", async () => {
    const d = await plan("NIFTY", "BEAR", (r) => {
      r.day.trades = 1;
      r.day.losses = 1;
      r.day.consecutiveLosses = 1;
      r.day.realized = -200;
    });
    expect(d.plan).toBeNull();
    expect(gate(d, "loss_streak")).toMatchObject({ passed: false, detail: "1 of 1" });
  });

  it("takes at most two entries a day", async () => {
    const one = await plan("NIFTY", "BEAR", (r) => {
      r.entriesToday.SENSEX = 1;
    });
    expect(one.plan?.lots).toBe(1);
    const two = await plan("NIFTY", "BEAR", (r) => {
      r.entriesToday.NIFTY = 1;
      r.entriesToday.SENSEX = 1;
    });
    expect(two.plan).toBeNull();
    expect(gate(two, "trades_today")).toMatchObject({ passed: false, detail: "2 of 2" });
  });

  it("holds one position at a time across NIFTY and SENSEX", async () => {
    const d = await plan("NIFTY", "BEAR", (r) => {
      r.openPositions.push({ id: "p1", index: "SENSEX", side: "BEAR", qty: 20, avgEntry: 150, unrealized: 0 } as Position);
    });
    expect(d.plan).toBeNull();
    expect(gate(d, "max_positions")).toMatchObject({ passed: false, detail: "1 of 1" });
  });
});
