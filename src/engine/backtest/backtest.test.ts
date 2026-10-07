import { describe, expect, it } from "vitest";
import { istAt, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG, makeConfig, withOverrides } from "../config";
import { toNumeric } from "../events/taxonomy";
import { loadMarketFixtures } from "../testing/fixtures";
import type { DayLedger, ScoredEvent, TradeRecord } from "../types";
import { attribution, equityPath, maxDrawdown, profitFactor, summarize } from "./metrics";
import { BacktestRun, configForParams, runBacktest, seededRandom, shuffleEventTimes, toBacktestResult } from "./runBacktest";
import { defaultGrid, makeFolds } from "./walkForward";

const fixtures = loadMarketFixtures();
const permissive = makeConfig({
  conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, minOi: 0 },
  sizing: { maxTradesPerDay: 3 },
});

function rbiHike(): ScoredEvent {
  const t = istAt("2026-10-07", "10:02");
  const base: Omit<ScoredEvent, "numeric"> = {
    clusterId: "c_rbi",
    clusterKey: "rbi-mpc-oct-2026-hike",
    scoredAtMs: t,
    scorer: "llm",
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
    sectors: [],
    rationale: "test",
    firstSeenMs: t,
    articleCount: 20,
    title: "RBI hikes repo rate",
  };
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") } };
}

describe("backtest over the fixture week (1-7 Oct 2026)", () => {
  it("replays only trading days with data and stays conservative by default", async () => {
    const run = new BacktestRun({ cfg: DEFAULT_CONFIG, from: "2026-10-01", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily });
    expect(run.days).toEqual(["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"]);
    const out = await run.runAll();
    expect(run.progress).toBe(1);
    expect(out.ledgers.map((l) => l.date)).toEqual(out.days);
    expect(out.decisions).toBeGreaterThan(100);
    expect(out.summary.netPnl).toBeCloseTo(out.trades.reduce((s, t) => s + t.pnl, 0), 1);
  }, 60_000);

  it("trades with permissive gates, flattens daily and reconciles equity", async () => {
    const out = await runBacktest({ cfg: permissive, from: "2026-10-05", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, events: [rbiHike()] });
    expect(out.trades.length).toBeGreaterThan(0);
    for (const t of out.trades) expect(t.exitMs).toBeLessThanOrEqual(istAt(new Date(t.entryMs + 5.5 * 3_600_000).toISOString().slice(0, 10), "15:05"));
    const ledgerNet = out.ledgers.reduce((s, l) => s + l.realized + l.unrealized - l.charges, 0);
    expect(ledgerNet).toBeCloseTo(out.summary.netPnl, 0);
    expect(out.equityCurve.at(-1)!.equity).toBeCloseTo(permissive.capitalRupees + ledgerNet, 0);
    expect(out.summary.charges).toBeGreaterThan(0);
    const shares = attribution(out.trades).reduce((s, a) => s + a.attributedPnl, 0);
    expect(shares).toBeCloseTo(out.summary.netPnl, 0);
    expect(out.notes.join(" ")).toMatch(/synthetic/);
  }, 60_000);

  it("ignores events before they are visible and supports the no-events baseline", async () => {
    const base = { cfg: permissive, from: "2026-10-07", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily };
    const none = await runBacktest({ ...base, noEvents: true, events: [rbiHike()] });
    expect(none.notes.join(" ")).toMatch(/No-events baseline/);
    const future = { ...rbiHike(), firstSeenMs: istAt("2026-10-08", "10:00") };
    const withFuture = await runBacktest({ ...base, events: [future] });
    const without = await runBacktest({ ...base, events: [] });
    // An event first seen tomorrow must not change today's trades.
    expect(withFuture.trades.map((t) => [t.entryMs, t.tradingSymbol])).toEqual(without.trades.map((t) => [t.entryMs, t.tradingSymbol]));
  }, 60_000);
});

describe("placebo and parameters", () => {
  it("shuffles event times deterministically and keeps the multiset", () => {
    const evs = [1, 2, 3, 4, 5].map((i) => ({ ...rbiHike(), clusterId: `c${i}`, firstSeenMs: i * 1000 }));
    const a = shuffleEventTimes(evs, 7).map((e) => e.firstSeenMs);
    const b = shuffleEventTimes(evs, 7).map((e) => e.firstSeenMs);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("maps dashboard parameters onto the config", () => {
    const cfg = configForParams(DEFAULT_CONFIG, { from: "2026-10-01", to: "2026-10-07", index: "NIFTY", thresholdDelta: 0.1, stopPct: 25, targetPct: 60, noEvents: false });
    expect(cfg.indices).toEqual(["NIFTY"]);
    expect(cfg.conviction.thresholds.RANGE).toBeCloseTo(DEFAULT_CONFIG.conviction.thresholds.RANGE + 0.1);
    expect(cfg.exits.stopPct).toBe(-25);
    expect(cfg.exits.targetPct).toBe(60);
  });

  it("deep-merges walk-forward grid points onto the base config", () => {
    const base = withOverrides(DEFAULT_CONFIG, { conviction: { minActiveWeight: 0.4, counterTrendThreshold: 0.7 }, gates: { kEM: 0.9 } });
    const grid = defaultGrid(base);
    expect(grid).toHaveLength(12);
    const cfg = withOverrides(base, grid[0].overrides);
    // Keys the grid point does not touch keep the base values instead of reverting to defaults.
    expect(cfg.conviction.minActiveWeight).toBe(0.4);
    expect(cfg.conviction.counterTrendThreshold).toBe(0.7);
    expect(cfg.gates.kEM).toBe(0.9);
    expect(cfg.conviction.gain).toBe(1.2);
    expect(cfg.gates.minEdgeRatio).toBe(0.1);
    expect(cfg.conviction.thresholds.RANGE).toBeCloseTo(base.conviction.thresholds.RANGE - 0.05, 9);
  });

  it("builds walk-forward folds without overlap", () => {
    const folds = makeFolds("2026-07-01", "2026-09-30", 56, 14);
    expect(folds[0]).toEqual({ trainFrom: "2026-07-01", trainTo: "2026-08-25", testFrom: "2026-08-26", testTo: "2026-09-08" });
    for (let i = 1; i < folds.length; i++) expect(folds[i].testFrom > folds[i - 1].testTo).toBe(true);
    expect(folds.at(-1)!.testTo).toBe("2026-09-30");
  });
});

describe("metrics", () => {
  const trade = (pnl: number, pct: number, over: Partial<TradeRecord> = {}): TradeRecord => ({
    positionId: "p",
    index: "NIFTY",
    side: "BULL",
    mode: "BACKTEST",
    tradingSymbol: "X",
    entryMs: 0,
    exitMs: 60 * MINUTE_MS,
    holdingMin: 60,
    entryPremium: 100,
    exitPremium: 100 + pct,
    qty: 65,
    pnl,
    grossPnl: pnl + 70,
    pnlPctPremium: pct,
    charges: 70,
    maePct: 0,
    mfePct: 0,
    regime: "RANGE",
    exitReason: "TARGET",
    convictionAtEntry: 0.5,
    dominantSource: "MOMENTUM",
    attribution: [
      { source: "MOMENTUM", share: 0.75 },
      { source: "EVENT", share: 0.25 },
    ],
    ...over,
  });
  const ledger = (date: string, net: number): DayLedger => ({
    date,
    mode: "BACKTEST",
    realized: net,
    unrealized: 0,
    charges: 0,
    trades: 1,
    wins: net > 0 ? 1 : 0,
    losses: net > 0 ? 0 : 1,
    consecutiveLosses: 0,
    ordersPlaced: 2,
    maxIntradayDrawdown: 0,
    peakEquity: 0,
    startEquity: 0,
    updatedMs: 0,
  });

  it("computes profit factor, drawdown and risk-adjusted returns", () => {
    expect(profitFactor([100, -50, 50])).toBe(3);
    expect(profitFactor([10])).toBe(99);
    const path = equityPath([ledger("2026-10-01", 1000), ledger("2026-10-02", -3000), ledger("2026-10-03", 500)], 100_000);
    expect(path.map((p) => p.equity)).toEqual([101_000, 98_000, 98_500]);
    expect(maxDrawdown(path, 100_000).abs).toBe(3000);
    const s = summarize([trade(1000, 15), trade(-3000, -30), trade(500, 8)], [ledger("2026-10-01", 1000), ledger("2026-10-02", -3000), ledger("2026-10-03", 500)], 100_000);
    expect(s.trades).toBe(3);
    expect(s.hitRate).toBeCloseTo(2 / 3, 3);
    expect(s.netPnl).toBe(-1500);
    expect(s.sharpe).toBeLessThan(0);
    expect(s.maxDrawdownPct).toBeCloseTo((3000 / 101_000) * 100, 1);
  });

  it("attributes P&L by entry shares", () => {
    const a = attribution([trade(1000, 15), trade(-400, -10, { dominantSource: "EVENT" })]);
    const mom = a.find((x) => x.source === "MOMENTUM")!;
    const ev = a.find((x) => x.source === "EVENT")!;
    expect(mom.trades).toBe(1);
    expect(mom.attributedPnl).toBeCloseTo(0.75 * 1000 + 0.75 * -400);
    expect(ev.attributedPnl).toBeCloseTo(0.25 * 1000 + 0.25 * -400);
  });

  it("converts to the dashboard DTO", () => {
    const r = toBacktestResult("run1", { from: "2026-10-01", to: "2026-10-07", index: "BOTH", thresholdDelta: 0, stopPct: 30, targetPct: 50, noEvents: false }, null, {
      startedMs: istAt("2026-10-07", "18:00"),
      finishedMs: null,
      status: "RUNNING",
      progress: 0.25,
    });
    expect(r).toMatchObject({ runId: "run1", status: "RUNNING", progress: 0.25, summary: null, trades: [], startedAt: "2026-10-07T18:00:00+05:30" });
  });
});
