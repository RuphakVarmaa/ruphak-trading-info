import { describe, expect, it } from "vitest";
import { istAt, istMinutes, MINUTE_MS, parseHHMM } from "../clock";
import { DEFAULT_CONFIG, makeConfig, type EngineConfig } from "../config";
import { toNumeric } from "../events/taxonomy";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId, Quote, ScoredEvent } from "../types";
import { runEndOfDay } from "./dayLifecycle";
import { exitPriceProblem, runPositionCycle } from "./positionCycle";
import { runTradingCycle, type TradingCycleOptions } from "./tradingCycle";

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

async function replayDay(cfg: EngineConfig, withEvent: boolean, opts: TradingCycleOptions = {}) {
  const start = istAt(DAY, "09:15");
  const deps = createReplayDeps({ cfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  const entries: { t: number; index: IndexId }[] = [];
  for (let t = start; t <= istAt(DAY, "15:30"); t += 5 * MINUTE_MS) {
    deps.clock.set(t);
    if (withEvent && t === istAt(DAY, "10:05")) await deps.repo.events.upsertMany([rbiHike(t)]);
    const r = await runTradingCycle(deps, opts);
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

  it("trades on the indicator signals alone when there is no news", async () => {
    const { deps, entries } = await replayDay(DEFAULT_CONFIG, false, { noEvents: true });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.length).toBeLessThanOrEqual(DEFAULT_CONFIG.sizing.maxTradesPerDay);
    expect(await deps.repo.positions.open("BACKTEST")).toEqual([]);
    const orders = await deps.repo.orders.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"), "BACKTEST");
    const plans = await Promise.all(orders.filter((o) => o.reason === "ENTRY").map((o) => deps.repo.plans.get(o.planId!)));
    for (const p of plans) {
      expect(p).toBeTruthy();
      expect(["TREND", "ORB", "MOMENTUM", "MEAN_REVERSION", "GAP", "GLOBAL_BETA", "RELATIVE_VALUE"]).toContain(p!.dominantSource);
    }
    const decisions = await deps.repo.decisions.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"));
    const planned = decisions.filter((d) => d.plan);
    expect(planned.length).toBeGreaterThanOrEqual(entries.length);
    for (const d of planned) {
      // News is switched off: EVENT abstains and the score comes from at least two technical signals.
      expect(d.conviction.components.find((c) => c.source === "EVENT")!.abstain).toBe(true);
      expect(d.conviction.activeWeight).toBeGreaterThanOrEqual(DEFAULT_CONFIG.conviction.minActiveWeight);
      expect(d.indicators).toBeDefined();
      expect(d.indicators!.adx14).toBeGreaterThan(0);
    }
  });

  it("trades only the configured indices", async () => {
    const cfg = makeConfig({ indices: ["NIFTY"] });
    const { deps, entries } = await replayDay(cfg, false, { noEvents: true });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((e) => e.index === "NIFTY")).toBe(true);
    const decisions = await deps.repo.decisions.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"));
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.index === "NIFTY")).toBe(true);
    expect(await deps.repo.positions.open("BACKTEST")).toEqual([]);
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

describe("exit price guard", () => {
  const q = (over: Partial<Quote> = {}): Quote => ({ symbol: "X", t: 0, ltp: 100, bid: 99, ask: 101, bidQty: 100, askQty: 100, source: "synthetic", ...over });
  it("refuses synthetic prices without spot or VIX and quotes without a bid or last price", () => {
    expect(exitPriceProblem({ spot: 22600, vix: 14, t: 0 }, q())).toBeNull();
    expect(exitPriceProblem({ spot: 0, vix: 14, t: 0 }, q())).toMatch(/no market data/);
    expect(exitPriceProblem({ spot: 22600, vix: 0, t: 0 }, q())).toMatch(/no market data/);
    expect(exitPriceProblem({ spot: 0, vix: 0, t: 0 }, q({ source: "groww" }))).toBeNull(); // a broker quote stands on its own
    expect(exitPriceProblem({ spot: 22600, vix: 14, t: 0 }, q({ bid: 0, ltp: 0 }))).toMatch(/no bid/);
  });
});
