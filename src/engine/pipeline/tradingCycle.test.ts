import { describe, expect, it } from "vitest";
import { istAt, istMinutes, MINUTE_MS, parseHHMM } from "../clock";
import { DEFAULT_CONFIG, makeConfig, type EngineConfig } from "../config";
import { toNumeric } from "../events/taxonomy";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId, ScoredEvent } from "../types";
import { runEndOfDay } from "./dayLifecycle";
import { runPositionCycle } from "./positionCycle";
import { runTradingCycle } from "./tradingCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();

function rbiHike(t: number): ScoredEvent {
  const base: Omit<ScoredEvent, "numeric"> = {
    clusterId: "c_rbi",
    clusterKey: "rbi-mpc-oct-2026-hike",
    scoredAtMs: t,
    scorer: "llm",
    model: "test",
    version: "rubric-v1",
    taxonomy: "MACRO_POLICY",
    indiaRelevance: "DIRECT",
    isScheduledData: true,
    surprise: "NEGATIVE",
    novelty: "NEW",
    pricedIn: "LOW",
    horizon: "DAYS_1_2",
    halfLifeHours: 6,
    impact: {
      NIFTY: { direction: "STRONG_BEAR", magnitude: "LARGE", confidence: "HIGH" },
      SENSEX: { direction: "STRONG_BEAR", magnitude: "LARGE", confidence: "HIGH" },
    },
    sectors: [{ sector: "FINANCIALS", direction: "STRONG_BEAR", weight: "HIGH" }],
    rationale: "Surprise 25 bp repo hike tightens liquidity; banks lead the fall.",
    firstSeenMs: t - 3 * MINUTE_MS,
    articleCount: 25,
    title: "RBI hikes repo rate by 25 bps",
  };
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") } };
}

async function replayDay(cfg: EngineConfig, withEvent: boolean) {
  const start = istAt(DAY, "09:15");
  const deps = createReplayDeps({ cfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  const entries: { t: number; index: IndexId }[] = [];
  for (let t = start; t <= istAt(DAY, "15:30"); t += 5 * MINUTE_MS) {
    deps.clock.set(t);
    if (withEvent && t === istAt(DAY, "10:05")) await deps.repo.events.upsertMany([rbiHike(t)]);
    const r = await runTradingCycle(deps);
    for (const e of r.entries) if (e.positionId) entries.push({ t, index: (await deps.repo.positions.get(e.positionId))!.index });
    await runPositionCycle(deps, { convictions: r.convictions as Partial<Record<IndexId, Conviction>> });
  }
  deps.clock.set(istAt(DAY, "16:00"));
  const eod = await runEndOfDay(deps);
  return { deps, entries, eod };
}

describe("trading cycle replay of 7 Oct 2026", () => {
  it("runs a full session with default settings and keeps every invariant", async () => {
    const { deps, entries, eod } = await replayDay(DEFAULT_CONFIG, true);
    expect(await deps.repo.positions.open("BACKTEST")).toEqual([]);
    for (const e of entries) {
      const m = istMinutes(e.t);
      expect(m).toBeGreaterThanOrEqual(parseHHMM(DEFAULT_CONFIG.gates.noEntryBeforeIst));
      expect(m).toBeLessThanOrEqual(parseHHMM(DEFAULT_CONFIG.gates.noEntryAfterIst));
    }
    expect(entries.length).toBeLessThanOrEqual(DEFAULT_CONFIG.sizing.maxTradesPerDay);
    const decisions = await deps.repo.decisions.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"));
    expect(decisions.length).toBeGreaterThan(10);
    // Every decision records its gates; the conviction gate is always first.
    for (const d of decisions) expect(d.gates[0].gate).toBe("conviction");
    expect(eod.graded).toBe(decisions.length);
    const snap = await deps.repo.snapshots.latest();
    expect(snap?.quotes.find((q) => q.key === "NIFTY")?.price).toBeGreaterThan(20_000);
  });

  it("enters, manages and exits trades end to end with permissive gates", async () => {
    const cfg = makeConfig({
      conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
      gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0 },
      sizing: { maxTradesPerDay: 3 },
    });
    const { deps, entries } = await replayDay(cfg, true);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(await deps.repo.positions.open("BACKTEST")).toEqual([]);
    const trades = await deps.repo.trades.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"), "BACKTEST");
    expect(trades.length).toBe(entries.length);
    const ledger = (await deps.repo.ledger.get(DAY, "BACKTEST"))!;
    const net = trades.reduce((s, t) => s + t.pnl, 0);
    expect(ledger.realized - ledger.charges).toBeCloseTo(net, 1);
    expect(ledger.trades).toBe(trades.length);
    for (const t of trades) {
      expect(t.exitMs).toBeLessThanOrEqual(istAt(DAY, "15:05"));
      expect(t.charges).toBeGreaterThan(40);
    }
    const orders = await deps.repo.orders.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"), "BACKTEST");
    expect(orders.filter((o) => o.reason === "ENTRY").length).toBe(entries.length);
    expect(orders.every((o) => o.status === "FILLED")).toBe(true);
    // After the RBI story, event-driven entries must be bearish (puts).
    const plans = await Promise.all(orders.filter((o) => o.reason === "ENTRY" && o.createdMs >= istAt(DAY, "10:05")).map((o) => deps.repo.plans.get(o.planId!)));
    for (const p of plans) if (p?.dominantSource === "EVENT") expect(p.contract.type).toBe("PE");
  });

  it("never trades when the kill switch is engaged", async () => {
    const cfg = makeConfig({
      conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 } },
      gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000 },
    });
    const start = istAt(DAY, "09:15");
    const deps = createReplayDeps({ cfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
    await deps.repo.settings.update({ killSwitch: true, killReason: "test" }, "test");
    for (let t = start; t <= istAt(DAY, "12:00"); t += 5 * MINUTE_MS) {
      deps.clock.set(t);
      const r = await runTradingCycle(deps);
      expect(r.entries).toEqual([]);
      expect(r.halted).toBe("test");
    }
  });
});
