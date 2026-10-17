import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG, makeConfig, withOverrides } from "../config";
import { toNumeric } from "../events/taxonomy";
import { atmStrike } from "../instruments/instrumentMaster";
import { ReplayMarketDataSource, YAHOO_LAG_MS } from "../market/replayMarketData";
import type { Broker } from "../ports";
import { SyntheticOptionQuotes, syntheticQuote } from "../pricing/syntheticOptionPricer";
import { loadMarketFixtures } from "../testing/fixtures";
import type { DayLedger, OptionContract, Order, OrderRequest, Quote, ScoredEvent, TradeRecord } from "../types";
import { attribution, equityPath, maxDrawdown, profitFactor, summarize } from "./metrics";
import { regimeLookup } from "./placebo";
import {
  BacktestRun,
  ClosedBars,
  configForParams,
  CopierBroker,
  copyDelayOf,
  CopyDelayQuotes,
  followerConfigForParams,
  runBacktest,
  runBacktestAccounts,
  seededRandom,
  shuffleEventTimes,
  toBacktestResult,
  widenQuote,
} from "./runBacktest";
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

describe("backtest with the ₹10k account following main", () => {
  it("leaves main's results unchanged and books the follower separately from ₹10,000", async () => {
    const input = { cfg: permissive, from: "2026-10-05", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, noEvents: true };
    const alone = await runBacktest(input);
    const follower = followerConfigForParams(permissive, "small10k", { from: input.from, to: input.to, index: "NIFTY", thresholdDelta: 0, stopPct: 40, targetPct: 80, noEvents: true });
    expect(follower.exits.stopPct).toBe(-40);
    expect(follower.exits.targetPct).toBe(80);
    expect(follower.capitalRupees).toBe(10_000);
    const both = await runBacktestAccounts({ ...input, followers: [{ account: "small10k", cfg: follower }] });
    expect(both.main.summary).toEqual(alone.summary);
    const small = both.followers.small10k!;
    expect(small.trades.length).toBeGreaterThan(0);
    // One lot of whichever index it bought (NIFTY 65, SENSEX 20), one position at a time.
    for (const t of small.trades) expect(t.qty).toBe(follower.indexSpecs[t.index].lotSize);
    const sorted = [...small.trades].sort((a, b) => a.entryMs - b.entryMs);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].entryMs).toBeGreaterThanOrEqual(sorted[i - 1].exitMs);
    expect(small.ledgers[0].startEquity).toBe(10_000);
    expect(small.summary.netPnl).toBeCloseTo(small.trades.reduce((s, t) => s + t.pnl, 0), 1);
    expect(small.notes.some((n) => n.includes("small10k"))).toBe(true);
  }, 60_000);
});

describe("backtest with the ₹5k account following main", () => {
  it("leaves main's and the ₹10k account's results unchanged and books the ₹5k account from ₹5,000", async () => {
    const input = { cfg: permissive, from: "2026-10-01", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, noEvents: true };
    const params = { from: input.from, to: input.to, index: "BOTH" as const, thresholdDelta: 0, stopPct: 35, targetPct: 60, noEvents: true };
    const tenK = followerConfigForParams(permissive, "small10k", params);
    const fiveK = followerConfigForParams(permissive, "small5k", params);
    expect(fiveK.capitalRupees).toBe(5_000);
    expect(fiveK.exits).toMatchObject({ stopPct: -35, targetPct: 60 });
    const one = await runBacktestAccounts({ ...input, followers: [{ account: "small10k", cfg: tenK }] });
    const both = await runBacktestAccounts({ ...input, followers: [{ account: "small10k", cfg: tenK }, { account: "small5k", cfg: fiveK }] });
    expect(both.main.trades.length).toBeGreaterThan(0);
    expect(both.main.trades).toEqual(one.main.trades);
    expect(both.main.ledgers).toEqual(one.main.ledgers);
    expect(both.main.summary).toEqual(one.main.summary);
    expect(both.followers.small10k!.trades).toEqual(one.followers.small10k!.trades);
    const s = both.followers.small5k!;
    expect(s.trades.length).toBeGreaterThan(0);
    expect(s.ledgers[0].startEquity).toBe(5_000);
    for (const t of s.trades) expect(t.qty).toBe(fiveK.indexSpecs[t.index].lotSize);
    // One position at a time, at most 2 entries and 1 losing trade a day.
    const sorted = [...s.trades].sort((a, b) => a.entryMs - b.entryMs);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].entryMs).toBeGreaterThanOrEqual(sorted[i - 1].exitMs);
    for (const l of s.ledgers) {
      expect(l.trades).toBeLessThanOrEqual(2);
      expect(l.losses).toBeLessThanOrEqual(1);
    }
    expect(s.summary.netPnl).toBeCloseTo(s.trades.reduce((sum, t) => sum + t.pnl, 0), 1);
    expect(s.notes.some((n) => n.includes("small5k"))).toBe(true);
  }, 120_000);
});

describe("copy-delay penalty", () => {
  const input = { cfg: permissive, from: "2026-10-05", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, noEvents: true };
  const key = (t: TradeRecord) => `${t.entryMs}|${t.tradingSymbol}`;

  it("changes nothing unless asked", async () => {
    expect(copyDelayOf({})).toBeNull();
    expect(copyDelayOf({ fillDelayBars: 0, extraTicks: 0 })).toBeNull();
    expect(copyDelayOf({ fillDelayBars: 1.7, extraTicks: -2 })).toEqual({ fillDelayBars: 1, extraTicks: 0 });
    const a = await runBacktest(input);
    const b = await runBacktest({ ...input, fillDelayBars: 0, extraTicks: 0 });
    expect(b.trades).toEqual(a.trades);
    expect(b.ledgers).toEqual(a.ledgers);
    expect(b.notes).toEqual(a.notes);
    expect(a.signals).toBeUndefined();
  }, 60_000);

  it("fills the copier at market, the given ticks worse on both sides", async () => {
    const plain = await runBacktest(input);
    const ticks = await runBacktest({ ...input, extraTicks: 2 });
    expect(ticks.notes.join(" ")).toMatch(/2 extra tick\(s\) per side, at market/);
    const byKey = new Map(ticks.trades.map((t) => [key(t), t]));
    let matched = 0;
    for (const t of plain.trades) {
      const u = byKey.get(key(t));
      if (!u) continue;
      matched++;
      // The engine's entry fills at the ask; the copier pays two ticks more.
      expect(u.entryPremium).toBeCloseTo(t.entryPremium + 0.1, 6);
      if (u.exitMs === t.exitMs) expect(u.exitPremium).toBeCloseTo(t.exitPremium - 0.1, 6);
    }
    expect(matched).toBeGreaterThan(0);
  }, 60_000);

  it("prices delayed fills off the bar published fillDelayBars later", async () => {
    const calendar = new TradingCalendar();
    const bars = new ClosedBars(fixtures.candles, YAHOO_LAG_MS);
    const t = istAt("2026-10-06", "10:00") + YAHOO_LAG_MS;
    const t1 = t + 5 * MINUTE_MS;
    // ClosedBars is the replay source's point-in-time view.
    const snap = new ReplayMarketDataSource({ candles: fixtures.candles }, { lagMs: YAHOO_LAG_MS }).snapshotSync(t1);
    expect(bars.closeAt("^NSEI", t1)).toBe(snap.ltp.NIFTY);
    expect(bars.closeAt("^NSEI", t1)).not.toBe(bars.closeAt("^NSEI", t));
    expect(bars.closeAt("^NSEI", istAt("2026-10-06", "09:16"), true)).toBeNull();
    const spot1 = bars.closeAt("^NSEI", t1, true)!;
    const contract: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "T", growwSymbol: "", exchangeToken: "", expiry: "2026-10-13", strike: atmStrike(spot1, 50), type: "CE", lotSize: 65, tickSize: 0.05 };
    const quotes = new CopyDelayQuotes(new SyntheticOptionQuotes(calendar, DEFAULT_CONFIG), bars, { fillDelayBars: 1, extraTicks: 2 });
    const q = await quotes.quote(contract, { t, spot: bars.closeAt("^NSEI", t)!, vix: bars.closeAt("^INDIAVIX", t)! });
    const ref = syntheticQuote(contract, { t: t1, spot: spot1, vix: bars.closeAt("^INDIAVIX", t1)! }, calendar, DEFAULT_CONFIG);
    expect(q.t).toBe(t1);
    expect(q.ask).toBeCloseTo(ref.ask + 0.1, 6);
    expect(q.bid).toBeCloseTo(ref.bid - 0.1, 6);
    const delayed = await runBacktest({ ...input, fillDelayBars: 1, extraTicks: 2 });
    expect(delayed.notes.join(" ")).toMatch(/next closed 5-minute bar/);
    expect(delayed.trades.length).toBeGreaterThan(0);
  }, 60_000);

  it("widens quotes against the trader but never below one tick", () => {
    const q: Quote = { symbol: "X", t: 0, ltp: 1, bid: 0.1, ask: 0.2, bidQty: 65, askQty: 65, depth: { buy: [{ price: 0.1, qty: 65 }], sell: [{ price: 0.2, qty: 65 }] }, source: "synthetic" };
    const w = widenQuote(q, 2, 0.05);
    expect([w.bid, w.ask, w.depth!.buy[0].price, w.depth!.sell[0].price]).toEqual([0.05, 0.3, 0.05, 0.3]);
    expect(widenQuote(q, 0, 0.05)).toBe(q);
  });

  it("sends every copied order at market", async () => {
    const seen: OrderRequest[] = [];
    const inner: Broker = {
      mode: "BACKTEST",
      placeOrder: async (req) => {
        seen.push(req);
        return { order: { ...req, id: "o", status: "NEW", filledQty: 0, createdMs: 0, updatedMs: 0, mode: "BACKTEST" } as Order, fills: [] };
      },
      refreshOrder: async (order) => ({ order, fills: [] }),
      cancelOrder: async (order) => ({ order, fills: [] }),
      positions: async () => [],
      health: async () => ({ ok: true, detail: "fake" }),
    };
    const contract: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "T", growwSymbol: "", exchangeToken: "", expiry: "2026-10-13", strike: 25000, type: "CE", lotSize: 65, tickSize: 0.05 };
    const broker = new CopierBroker(inner);
    expect(broker.mode).toBe("BACKTEST");
    await broker.placeOrder({ refId: "r1", contract, side: "BUY", qty: 65, type: "LIMIT", limitPrice: 101.5, product: "MIS", reason: "ENTRY" });
    expect(seen[0]).toMatchObject({ type: "MARKET", limitPrice: undefined, side: "BUY", qty: 65 });
  });

  it("records the regime each index had at every decision when asked", async () => {
    const out = await runBacktest({ ...input, from: "2026-10-07", to: "2026-10-07", recordSignals: true });
    const tape = out.signals!;
    // Decisions at 09:16:30 .. 15:26:30 every 5 minutes (the 15:31:30 tick is after the close), both indices.
    expect(tape).toHaveLength(75 * 2);
    expect(new Set(tape.map((s) => s.index))).toEqual(new Set(["NIFTY", "SENSEX"]));
    const s = tape[40];
    expect(regimeLookup(tape)(s.index, s.t)).toBe(s.regime);
  }, 60_000);
});
