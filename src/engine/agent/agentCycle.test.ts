import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { addDays, istAt, istMidnight, MINUTE_MS } from "../clock";
import { makeConfig, type EngineConfig } from "../config";
import { computeFeatures } from "../market/features";
import { practiceConfig } from "../pipeline/practiceCycle";
import { submitExit } from "../pipeline/execution";
import type { OptionQuoteSource } from "../ports";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type Conviction, type DayLedger, type MarketSnapshot, type Position, type Quote, type ScoredEvent } from "../types";
import {
  agentConviction,
  agentPlannerConfig,
  agentPositionPass,
  bookAsOf,
  bookFrom,
  buildReflexInput,
  edgeVerdict,
  executeAgentBatch,
  initialBook,
  neutralConviction,
  type ExecuteContext,
} from "./agentCycle";
import { agentSample as s } from "./storeContract";
import type { AgentBookState, AgentRiskSnapshot, DecisionRecord, Finalist, IndexSnapshot, ReflexBatch, ReflexInput } from "./types";

const DAY = "2026-10-07";
const T = istAt(DAY, "11:00");
const fixtures = loadMarketFixtures();
const mainCfg = makeConfig({ gates: { maxDataAgeSec: 100_000, minOi: 0 } });
const agentCfg = accountConfig(mainCfg, "agent");

// ---------------------------------------------------------------------------
// Books and small helpers
// ---------------------------------------------------------------------------

const book = (o: Partial<AgentBookState> = {}): AgentBookState => ({ t: T - 20_000, equity: 498_000, peakEquity: 500_000, ddPct: 0.4, dayLossPct: 0.4, positions: [], ...o });
const risk = (o: Partial<AgentRiskSnapshot> = {}): AgentRiskSnapshot => s.risk({ date: DAY, t: T - 10_000, ...o });

describe("bookAsOf and initialBook", () => {
  it("takes the newest book recorded at or before the bar close, else the fallback", () => {
    const fallback = book({ t: istMidnight(DAY), equity: 500_000, ddPct: 0, dayLossPct: 0 });
    const ring = [book({ t: T - 60_000, equity: 1 }), book({ t: T, equity: 2 }), book({ t: T + 1, equity: 3 }), book({ t: T - 30_000, equity: 4 })];
    expect(bookAsOf(ring, T, fallback).equity).toBe(2);
    expect(bookAsOf(ring, T - 45_000, fallback).equity).toBe(1);
    expect(bookAsOf(ring, T - 120_000, fallback)).toBe(fallback);
    expect(bookAsOf([], T, fallback)).toBe(fallback);
  });

  it("falls back to the latest risk at or before the close, else to a flat book at the day start (AMENDMENTS #26)", () => {
    expect(initialBook(risk({ t: T - 5_000, equity: 497_000, peakEquity: 500_000, ddPct: 0.6, dayLossPct: 0.6 }), 500_000, T)).toEqual({
      t: T - 5_000, equity: 497_000, peakEquity: 500_000, ddPct: 0.6, dayLossPct: 0.6, positions: [],
    });
    // A risk recorded after the close could carry an exit made after it: never used.
    expect(initialBook(risk({ t: T + 5_000, equity: 400_000 }), 500_000, T)).toEqual({ t: istMidnight(DAY), equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, positions: [] });
    expect(initialBook(null, 480_000, T)).toEqual({ t: istMidnight(DAY), equity: 480_000, peakEquity: 480_000, ddPct: 0, dayLossPct: 0, positions: [] });
    // Yesterday's risk keeps the drawdown but no loss is used today yet.
    const y = initialBook(risk({ t: istAt(addDays(DAY, -1), "15:20"), date: addDays(DAY, -1), equity: 490_000, ddPct: 2, dayLossPct: 1.5 }), 500_000, T);
    expect(y).toMatchObject({ equity: 490_000, ddPct: 2, dayLossPct: 0 });
  });

  it("takes the day start as t when the caller already picked a risk at or before the bar", () => {
    const dayStart = istMidnight(DAY);
    expect(initialBook(risk({ t: T - 5_000, equity: 497_000, dayLossPct: 0.6 }), 500_000, dayStart)).toMatchObject({ t: T - 5_000, equity: 497_000, dayLossPct: 0.6 });
    expect(initialBook(null, 500_000, dayStart)).toEqual({ t: dayStart, equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, positions: [] });
    // A later day's risk is never used.
    expect(initialBook(risk({ t: istAt(addDays(DAY, 1), "09:30"), date: addDays(DAY, 1), equity: 1 }), 500_000, dayStart).equity).toBe(500_000);
  });

  it("records the book from the risk snapshot and the open positions", () => {
    const open = { id: "p", index: "NIFTY", side: "BULL", qty: 130, avgEntry: 120, markPremium: 126, markMs: T - 3_000, status: "OPEN", contract: { lotSize: 65 } } as unknown as Position;
    const b = bookFrom(risk({ t: T - 1_000 }), [open, { ...open, id: "closed", status: "CLOSED" }], (p) => p.contract.lotSize);
    expect(b).toEqual({ t: T - 1_000, equity: 498_000, peakEquity: 500_000, ddPct: 0.4, dayLossPct: 0.4, positions: [{ index: "NIFTY", side: "BULL", lots: 2, avgEntry: 120, markPremium: 126, markMs: T - 3_000 }] });
  });
});

describe("planner helpers", () => {
  it("relaxes exactly the practice quota's edge checks and nothing else; the losing streak is not raised", () => {
    const c = agentPlannerConfig(agentCfg, 0.75);
    expect(c.gates).toEqual(practiceConfig(agentCfg).gates);
    expect(c.gates.expectedMoveModel).toBe("legacy");
    expect(c.risk).toEqual(agentCfg.risk);
    expect(c.risk.maxConsecutiveLossesPerDay).toBe(3);
    expect(c.sizing).toMatchObject({ defaultRiskPct: 0.75, minRiskPct: 0, maxRiskPctPerTrade: 1, maxLots: 3, kellyMinTrades: Number.MAX_SAFE_INTEGER });
    expect(c.exits).toEqual(agentCfg.exits);
    expect(c.selection).toEqual(agentCfg.selection);
    expect(agentCfg.gates.expectedMoveModel).toBe("calibrated");
  });

  it("turns a conviction to the decision's side, at least at the threshold, and gives a neutral one for a missing index", () => {
    const base: Conviction = { ...neutralConviction("NIFTY", T, agentCfg), score: -0.12, threshold: 0.35, regime: "TREND_DOWN", stance: "BEARISH" };
    expect(agentConviction(base, "LONG")).toMatchObject({ score: 0.35, passes: true, stance: "BULLISH", regime: "TREND_DOWN", sizeMult: 1 });
    expect(agentConviction({ ...base, score: -0.6 }, "SHORT")).toMatchObject({ score: -0.6, passes: true, stance: "BEARISH" });
    const n = neutralConviction("SENSEX", T, agentCfg);
    expect(n).toMatchObject({ index: "SENSEX", t: T, score: 0, passes: false, regime: "RANGE", threshold: agentCfg.conviction.thresholds.RANGE, stance: "NEUTRAL" });
  });
});

// ---------------------------------------------------------------------------
// The reflex input: causal at the bar close (leak checks)
// ---------------------------------------------------------------------------

const truncated = (t: number): MarketSnapshot => {
  const candles: Record<string, Candle[]> = {};
  for (const [sym, arr] of Object.entries(fixtures.candles)) candles[sym] = arr.filter((c) => c.t + 5 * MINUTE_MS <= t);
  const daily: Record<string, Candle[]> = {};
  for (const [sym, arr] of Object.entries(fixtures.daily)) daily[sym] = arr.filter((c) => c.t < istMidnight(DAY));
  return { t, candles, daily, ltp: {}, dataAgeSec: 0, dataAgeSecByIndex: {} };
};

/** Everything A has, plus data from after the close: later bars, today's daily bar, a live LTP, an observation time, data age. */
const withFuture = (t: number): MarketSnapshot => {
  const a = truncated(t);
  const candles: Record<string, Candle[]> = {};
  for (const [sym, arr] of Object.entries(fixtures.candles)) candles[sym] = arr.filter((c) => c.t < istAt(DAY, "15:30"));
  const daily: Record<string, Candle[]> = {};
  for (const [sym, arr] of Object.entries(a.daily)) {
    const last = arr[arr.length - 1];
    daily[sym] = last ? [...arr, { ...last, t: istAt(DAY, "09:15"), c: last.c * 1.3, h: last.h * 1.3 }] : arr;
  }
  const nifty = candles[MARKET_SYMBOLS.NIFTY][candles[MARKET_SYMBOLS.NIFTY].length - 1].c;
  return { t: t + 10 * MINUTE_MS, candles, daily, ltp: { NIFTY: nifty * 1.05, SENSEX: 99_999 }, dataAgeSec: 999, dataAgeSecByIndex: { NIFTY: 999 }, asOfMs: { "^NSEI": t + 9 * MINUTE_MS } };
};

const event = (id: string, scoredAtMs: number, firstSeenMs = scoredAtMs): ScoredEvent =>
  ({
    clusterId: id, clusterKey: `k-${id}`, scoredAtMs, scorer: "llm", version: "rubric-v1", taxonomy: "MACRO_POLICY", indiaRelevance: "DIRECT", isScheduledData: false,
    surprise: "NA", novelty: "NEW", pricedIn: "LOW", horizon: "DAYS_1_2", halfLifeHours: 24,
    impact: { NIFTY: { direction: "BEAR", magnitude: "LARGE", confidence: "HIGH" }, SENSEX: { direction: "BEAR", magnitude: "LARGE", confidence: "HIGH" } },
    sectors: [], rationale: "r", numeric: { NIFTY: -0.8, SENSEX: -0.8 }, firstSeenMs, articleCount: 3, title: id,
  }) as ScoredEvent;

const input = (market: MarketSnapshot, b: AgentBookState, events: ScoredEvent[] = [], complete: ("NIFTY" | "SENSEX")[] = ["NIFTY", "SENSEX"], nowMs = T + 60_000): ReflexInput =>
  buildReflexInput({ barCloseMs: T, indices: ["NIFTY", "SENSEX"], complete, market, calendar: createReplayDeps({ cfg: agentCfg, startMs: T, candles: {} }).calendar, cfg: agentCfg, events, perf: [], flows: {}, book: b, nowMs });

const noBuilt = (i: ReflexInput) => ({ ...i, builtMs: 0 });

describe("buildReflexInput", () => {
  it("is the same with or without data from after the bar close (leak item 2)", () => {
    const past = [event("e1", T - 30 * MINUTE_MS)];
    const a = input(truncated(T), book(), past);
    const b = input(withFuture(T), book(), [...past, event("late", T + 60_000, T - MINUTE_MS), event("future", T + 2 * MINUTE_MS)], ["NIFTY", "SENSEX"], T + 95_000);
    expect(Object.keys(a.snapshots).sort()).toEqual(["NIFTY", "SENSEX"]);
    expect(noBuilt(b)).toEqual(noBuilt(a));
    expect(a.builtMs).toBe(T + 60_000);
    expect(a.date).toBe(DAY);
    expect(a.closes.NIFTY).toBe(fixtures.candles[MARKET_SYMBOLS.NIFTY].find((c) => c.t === T - 5 * MINUTE_MS)!.c);
    expect(a.tokensEst.NIFTY).toBeGreaterThan(0);
    expect(a.tokensEst.NIFTY).toBeLessThan(400);
  });

  it("is sensitive: a different close before the bar close changes the snapshot (the control)", () => {
    const m = truncated(T);
    const bars = m.candles[MARKET_SYMBOLS.NIFTY];
    const changed = { ...m, candles: { ...m.candles, [MARKET_SYMBOLS.NIFTY]: [...bars.slice(0, -1), { ...bars[bars.length - 1], c: bars[bars.length - 1].c * 1.004 }] } };
    const a = input(m, book());
    const b = input(changed, book());
    expect(b.snapshots.NIFTY!.c !== a.snapshots.NIFTY!.c || b.snapshots.NIFTY!.r5 !== a.snapshots.NIFTY!.r5).toBe(true);
  });

  it("uses the flat fallback when the only recorded book is from after the close (AMENDMENTS #26)", () => {
    const later = book({ t: T + 30_000, equity: 470_000, ddPct: 6, dayLossPct: 6, positions: [{ index: "NIFTY", side: "BULL", lots: 2, avgEntry: 120, markPremium: 90, markMs: T + 29_000 }] });
    const fallback = initialBook(risk({ t: T + 30_000, equity: 470_000, ddPct: 6, dayLossPct: 6 }), 500_000, T);
    const used = bookAsOf([later], T, fallback);
    expect(used.t).toBeLessThanOrEqual(T);
    const i = input(truncated(T), used);
    expect(i.snapshots.NIFTY!.bk).toEqual({ pos: "-", lots: 0, pnl: null, dd: 0, dl: 0 });
    expect(noBuilt(i)).toEqual(noBuilt(input(truncated(T), { t: istMidnight(DAY), equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, positions: [] })));
  });

  it("refuses a book recorded after the bar close", () => {
    expect(() => input(truncated(T), book({ t: T + 1 }))).toThrow(/after the bar close/);
  });

  it("leaves out an incomplete index's snapshot and its close: a partial close is never graded (C6)", () => {
    const i = input(truncated(T), book(), [], ["NIFTY"]);
    expect(Object.keys(i.snapshots)).toEqual(["NIFTY"]);
    expect(i.tokensEst.SENSEX).toBeUndefined();
    expect(i.closes.SENSEX).toBeUndefined();
    expect(i.closes.NIFTY).toBe(fixtures.candles[MARKET_SYMBOLS.NIFTY].find((c) => c.t === T - 5 * MINUTE_MS)!.c);
    expect(i.problems).toEqual(["SENSEX: the candle was not complete in time, so it has no snapshot and no close"]);
  });

  it("stores no close for an index last seen mid-candle (probe-partialclose)", () => {
    const D = "2026-10-19";
    const at = (hhmm: string) => istAt(D, hhmm);
    const flat = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 0 });
    const B = at("10:35");
    const now = B + 125_000;
    const m: MarketSnapshot = {
      t: now,
      candles: {
        [MARKET_SYMBOLS.NIFTY]: [flat(at("10:25"), 25_000), flat(at("10:30"), 25_010), flat(at("10:35"), 25_012)],
        // SENSEX's 10:30-10:35 candle was last fetched at 10:34:40: its close is a mid-minute price.
        [MARKET_SYMBOLS.SENSEX]: [flat(at("10:25"), 82_000), flat(at("10:30"), 82_040)],
      },
      daily: {},
      ltp: {},
      dataAgeSec: 5,
      dataAgeSecByIndex: { NIFTY: 5, SENSEX: (now - (B - 20_000)) / 1000 },
      asOfMs: { [MARKET_SYMBOLS.NIFTY]: now - 5_000, [MARKET_SYMBOLS.SENSEX]: B - 20_000 },
    };
    const i = buildReflexInput({
      barCloseMs: B, indices: ["NIFTY", "SENSEX"], complete: ["NIFTY"], market: m, calendar: createReplayDeps({ cfg: agentCfg, startMs: B, candles: {} }).calendar, cfg: agentCfg,
      events: [], perf: [], flows: {}, book: { t: istMidnight(D), equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, positions: [] }, nowMs: now,
    });
    expect(i.closes).toEqual({ NIFTY: 25_010 });
    expect(i.snapshots.SENSEX).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Executing a batch on the agent's book (7 Oct replay data, synthetic option prices)
// ---------------------------------------------------------------------------

const NOW = T + 70_000;
const snap = (o: Partial<IndexSnapshot> = {}): IndexSnapshot => ({
  c: 25_000, r5: 12, r15: 20, r60: 31, ro: 45, vw: -18, vz: 0.9, orh: -11, orl: 21, ors: "U", pdh: -35, pdl: 64, pdc: 45,
  rsi: 61, adx: 27, di: 9, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
  o: { k: 25_000, cm: 112.4, cs: 0.6, pm: 98.1, ps: 0.7, iv: 13, ivx: -0.4, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [1, 0, 3, 0], bp: [0, 3, 0, 1], oa: 40 },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkkkk", ew: 1, dte: 3, xd: 0, bk: { pos: "-", lots: 0, pnl: null, dd: 0, dl: 0 },
  ...o,
});
const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({ id: `gen:${index}`, kind: "GENERIC", index, label: `${index}: best long or short now`, side: null, contract: null, entryHigh: null, condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null });
const fired = (o: Partial<DecisionRecord> = {}): DecisionRecord =>
  s.decision({ id: "d-long", date: DAY, barCloseMs: T, finalistId: "gen:NIFTY", direction: "LONG", directionConfidence: 0.9, setupQuality: 3, regime: "TRENDING", riskState: "SAFE", sizing: { p: 0.6, mode: "pooled", n: 400, mean: 0.62 }, ...o });
const batchOf = (decisions: DecisionRecord[], o: Partial<ReflexBatch> = {}): ReflexBatch => s.batch(T, { date: DAY, finalists: [generic("NIFTY"), generic("SENSEX")], decisions, payoff: { b: 1, n: 0 }, ...o });

class TweakQuotes implements OptionQuoteSource {
  readonly kind = "replay" as const;
  constructor(
    private readonly base: OptionQuoteSource,
    private readonly tweak: (q: Quote) => Quote,
  ) {}
  async quote(contract: Parameters<OptionQuoteSource["quote"]>[0], ctx: Parameters<OptionQuoteSource["quote"]>[1]): Promise<Quote> {
    return this.tweak(await this.base.quote(contract, ctx));
  }
}

async function setup(o: { tweak?: (q: Quote) => Quote; cfg?: EngineConfig } = {}) {
  const main = createReplayDeps({ cfg: mainCfg, startMs: NOW, candles: fixtures.candles, daily: fixtures.daily });
  const base = createFollowerDeps(main, o.cfg ?? agentCfg, "agent");
  const agent: ReplayDeps = o.tweak ? { ...base, optionQuotes: new TweakQuotes(base.optionQuotes, o.tweak) } : base;
  const market = await main.market.snapshot(NOW);
  const features = { NIFTY: computeFeatures("NIFTY", market, main.calendar, agentCfg), SENSEX: computeFeatures("SENSEX", market, main.calendar, agentCfg) };
  for (const index of ["NIFTY", "SENSEX"] as const) main.marketContext.set(index, { spot: features[index].spot, vix: features[index].vix, t: NOW });
  const ctx = (x: Partial<ExecuteContext> = {}): ExecuteContext => ({
    mode: "paper", nowMs: NOW, calendar: main.calendar, features, pressure: {}, convictions: {}, snapshots: { NIFTY: snap(), SENSEX: snap({ c: 82_000, o: { ...snap().o!, k: 82_000 } }) },
    noEntries: null, mainSettings: () => main.repo.settings.get(), peakEquity: null, ddHalt: false, positions: {}, trades: [], acceptSyntheticQuotes: true,
    ...x,
  });
  return { main, agent, ctx, features };
}

const exec = (r: Awaited<ReturnType<typeof executeAgentBatch>>, id: string) => r.decisions.find((d) => d.decisionId === id)!.execution;
const line = (e: ReturnType<typeof exec>, gate: string) => e.gate.lines.find((l) => l.gate === gate);

describe("executeAgentBatch", () => {
  it("buys a fired decision on the agent's book, tagged as the agent's and never stored as a signal (AMENDMENTS #19a)", async () => {
    const { main, agent, ctx } = await setup();
    const x = ctx();
    const r = await executeAgentBatch(agent, batchOf([fired()]), x);
    const e = exec(r, "d-long");
    expect(e.action).toBe("ENTERED");
    expect(e.gate.fired).toBe(true);
    expect(e.sizing).toMatchObject({ p: 0.6, b: 1, riskPct: 1, n: 400 });
    expect(e.sizing!.lots).toBeGreaterThanOrEqual(1);
    expect(line(e, "kelly")).toEqual({ gate: "kelly", passed: true, detail: "p 0.600, b 1.00: risk 1.00% of equity, measured on about 400 graded calls" });
    expect(line(e, "kelly_cap")?.passed).toBe(true);
    expect(line(e, "kill_switch")?.passed).toBe(true);
    expect(line(e, "quote_toxic")).toMatchObject({ passed: true, detail: expect.stringMatching(/^Live quote usable \(synthetic bid [\d.]+ \/ ask [\d.]+\)$/) });
    expect(line(e, "one_sided_book")?.passed).toBeNull();
    expect(e.edge?.rows[0].gate).toBe("move_vs_breakeven");
    expect(e.positionId).not.toBeNull();
    expect(x.positions[e.positionId!]).toEqual({ finalistId: "gen:NIFTY", decisionId: "d-long", index: "NIFTY", side: "LONG" });

    const plan = (await agent.repo.plans.get(e.planId!))!;
    expect(plan.dominantSource).toBe("VOL_REGIME");
    expect(plan.contract.type).toBe("CE");
    expect(plan.gates.find((g) => g.gate === "agent")?.detail).toMatch(/LONG 0\.90 setup 3 \(decision d-long\)/);
    expect(plan.gates.find((g) => g.gate === "edge_ratio")?.passed).toBe(true);
    expect(await agent.repo.decisions.latest("NIFTY")).toBeNull();
    const open = await agent.repo.positions.open("BACKTEST");
    expect(open.map((p) => p.id)).toEqual([e.positionId]);
    // Main's book is untouched.
    expect(await main.repo.positions.open("BACKTEST")).toEqual([]);
    expect(r.risk.openPositions).toBe(1);
  });

  it("takes no trade when Kelly is not above zero (no measured edge yet)", async () => {
    const { agent, ctx } = await setup();
    const r = await executeAgentBatch(agent, batchOf([fired({ sizing: { p: 0.5, mode: "pooled", n: 120, mean: 0.52 } })]), ctx());
    const e = exec(r, "d-long");
    expect(e.action).toBe("NO_ENTRY");
    expect(e.detail).toBe("Kelly ≤ 0: past calls have not cleared break-even (p=0.500, b=1.00)");
    expect(line(e, "kelly")).toEqual({ gate: "kelly", passed: false, detail: "p 0.500, b 1.00, Kelly 0.000" });
    expect(await agent.repo.orders.open("BACKTEST")).toEqual([]);
  });

  it("never sizes a trade on a probability with no graded call behind it, whatever b is (C2)", async () => {
    const { agent, ctx } = await setup();
    // The prior alone (an escalation with no graded escalation yet) and a payoff that would clear break-even.
    const prior = { p: 0.4578886359060713, mode: "pooled" as const, n: 0, mean: 0.5 };
    const r = await executeAgentBatch(agent, batchOf([fired({ source: "ESCALATION", sizing: prior })], { payoff: { b: 1.5, n: 40 } }), ctx());
    const e = exec(r, "d-long");
    expect(e.action).toBe("NO_ENTRY");
    expect(e.detail).toBe("no graded calls of this kind yet: no trade");
    expect(line(e, "kelly")).toEqual({ gate: "kelly", passed: false, detail: "no graded calls of this kind yet" });
    expect(e.sizing).toMatchObject({ p: prior.p, b: 1.5, n: 0, riskPct: 0, lots: 0, riskRupees: 0 });
    // Kelly alone would have sized it.
    expect(e.sizing!.kelly).toBeGreaterThan(0);
    expect(line(e, "plan")).toBeUndefined();
    expect(await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    // A weight that is not a number fails closed too.
    const nan = await executeAgentBatch(agent, batchOf([fired({ sizing: { ...prior, p: 0.6, n: Number.NaN } })], { payoff: { b: 1.5, n: 40 } }), ctx());
    expect(exec(nan, "d-long").action).toBe("NO_ENTRY");
  });

  it("records why the code gate did not fire, with no order", async () => {
    const { agent, ctx } = await setup();
    const r = await executeAgentBatch(agent, batchOf([fired({ id: "d-low", directionConfidence: 0.8 }), fired({ id: "d-neutral", direction: "NEUTRAL" })]), ctx());
    expect(exec(r, "d-low").action).toBe("NO_ENTRY");
    expect(line(exec(r, "d-low"), "confidence")?.passed).toBe(false);
    expect(line(exec(r, "d-neutral"), "direction")?.passed).toBe(false);
    expect((await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).length).toBe(0);
  });

  it("re-reads the kill switches right before the order", async () => {
    const { main, agent, ctx } = await setup();
    let calls = 0;
    const mainSettings = async () => {
      const s0 = await main.repo.settings.get();
      calls++;
      // Off when the batch starts, on by the time the order would go out.
      return calls >= 2 ? { ...s0, killSwitch: true, killReason: "owner pressed kill" } : s0;
    };
    const r = await executeAgentBatch(agent, batchOf([fired()]), ctx({ mainSettings }));
    const e = exec(r, "d-long");
    expect(e.action).toBe("NO_ENTRY");
    expect(e.detail).toBe("kill switch: main kill switch on: owner pressed kill");
    expect(line(e, "kill_switch")?.passed).toBe(false);
    expect(await agent.repo.positions.open("BACKTEST")).toEqual([]);
  });

  it("in shadow mode records what it would have done and writes no order, position or trade", async () => {
    const { agent, ctx } = await setup();
    const r = await executeAgentBatch(agent, batchOf([fired(), fired({ id: "d-idea-like", finalistId: "gen:NIFTY", directionConfidence: 0.85 })]), ctx({ mode: "shadow" }));
    expect(exec(r, "d-long").action).toBe("SHADOW_ENTRY");
    expect(exec(r, "d-long").detail).toMatch(/^would buy 1 lot\(s\) of NIFTY/);
    // The would-be position holds its slot for the batch's other decisions.
    expect(exec(r, "d-idea-like").action).toBe("NO_ENTRY");
    expect(await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await agent.repo.positions.open("BACKTEST")).toEqual([]);
    expect(await agent.repo.trades.between(0, Number.MAX_SAFE_INTEGER, "BACKTEST")).toEqual([]);
  });

  it("exits a tagged position at market on REDUCE, CRISIS or a confident opposite call", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const reduce = fired({ id: "d-reduce", direction: "NEUTRAL", directionConfidence: 0.5, setupQuality: 1, riskState: "REDUCE" });
    const r = await executeAgentBatch(agent, batchOf([reduce]), ctx({ positions: x.positions }));
    expect(r.exits).toEqual([{ positionId: pid, decisionId: "d-reduce", reason: "AGENT_REDUCE", status: "FILLED" }]);
    expect(exec(r, "d-reduce").action).toBe("EXITED");
    const closed = await agent.repo.positions.get(pid);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.exitReason).toBe("SIGNAL_FLIP");
    expect(r.risk.openPositions).toBe(0);
  });

  it("leaves a position with a resting exit order alone: EXIT_PENDING, never a second sell (AMENDMENTS #9)", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const pos = (await agent.repo.positions.get(pid))!;
    // A target limit far above the bid: it rests.
    await submitExit(agent, pos, { reason: "TARGET", orderType: "LIMIT", limitPrice: 9_999, detail: "test target" });
    const before = (await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).length;
    const crisis = fired({ id: "d-crisis", regime: "CRISIS", direction: "NEUTRAL", directionConfidence: 0.5 });
    const r = await executeAgentBatch(agent, batchOf([crisis]), ctx({ positions: x.positions }));
    expect(r.exits).toEqual([{ positionId: pid, decisionId: "d-crisis", reason: "AGENT_CRISIS", status: "EXIT_PENDING" }]);
    expect(exec(r, "d-crisis").action).toBe("EXIT_PENDING");
    expect((await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).length).toBe(before);
    expect((await agent.repo.positions.get(pid))?.status).toBe("OPEN");
  });

  it("in shadow mode an exit is only recorded", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const opposite = fired({ id: "d-short", direction: "SHORT", directionConfidence: 0.9 });
    const r = await executeAgentBatch(agent, batchOf([opposite]), ctx({ mode: "shadow", positions: x.positions }));
    expect(r.exits).toEqual([{ positionId: pid, decisionId: "d-short", reason: "AGENT_OPPOSITE", status: "SHADOW_EXIT" }]);
    expect((await agent.repo.positions.get(pid))?.status).toBe("OPEN");
  });

  it("sends no decision exit once a kill stops the runner's step: not executed, the position left to the code exits", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const crisis = fired({ id: "d-crisis", regime: "CRISIS", direction: "NEUTRAL", directionConfidence: 0.5 });
    // Shadow mode records what paper mode would have done: the same.
    for (const mode of ["paper", "shadow"] as const) {
      const r = await executeAgentBatch(agent, batchOf([crisis]), ctx({ mode, positions: x.positions, stopped: () => true }));
      expect(r.exits).toEqual([]);
      expect(exec(r, "d-crisis").action).toBe("NOT_EXECUTED");
      expect(exec(r, "d-crisis").detail).toMatch(/^AGENT_CRISIS for \S+ not sent: a kill came in while the step ran/);
      expect((await agent.repo.positions.get(pid))?.status).toBe("OPEN");
    }
    // Not stopped: the same batch closes it.
    const r = await executeAgentBatch(agent, batchOf([crisis]), ctx({ positions: x.positions, stopped: () => false }));
    expect(r.exits).toEqual([{ positionId: pid, decisionId: "d-crisis", reason: "AGENT_CRISIS", status: "FILLED" }]);
    expect((await agent.repo.positions.get(pid))?.status).toBe("CLOSED");
  });

  it("caps the quarter-Kelly budget on the account's capital as the planner sizes it (AMENDMENTS #22)", async () => {
    // One lot's risk at the stop, from a plain entry.
    const probe = await setup();
    const oneLot = exec(await executeAgentBatch(probe.agent, batchOf([fired()]), probe.ctx()), "d-long").sizing!.riskRupees;
    expect(oneLot).toBeGreaterThan(0);

    const { agent, ctx } = await setup();
    // A loss in an earlier week: the planner sizes from today's starting equity (₹4,00,000), and so does the cap.
    const prior = { date: "2026-09-30", mode: "BACKTEST", realized: -100_000, unrealized: 0, charges: 0, trades: 1, wins: 0, losses: 1, consecutiveLosses: 1, ordersPlaced: 2, maxIntradayDrawdown: 0, peakEquity: 500_000, startEquity: 500_000, updatedMs: T - 7 * 86_400_000 } as DayLedger;
    await agent.repo.ledger.save(prior);
    // A budget a little under one lot's risk: the sizer's minimum-one-lot allowance takes the lot, the cap refuses it.
    const budget = Math.round(oneLot / 1.2);
    const riskPct = (budget / 400_000) * 100;
    const p = (4 * (riskPct / 100) + 1) / 2;
    const r = await executeAgentBatch(agent, batchOf([fired({ sizing: { p, mode: "pooled", n: 400, mean: p } })]), ctx());
    const e = exec(r, "d-long");
    expect(e.sizing?.riskPct).toBeCloseTo(riskPct, 6);
    expect(e.action).toBe("NO_ENTRY");
    expect(line(e, "plan")?.passed).toBe(true);
    expect(line(e, "kelly_cap")?.passed).toBe(false);
    expect(line(e, "kelly_cap")?.detail).toMatch(new RegExp(`^₹[\\d,]+ at risk vs ₹${budget.toLocaleString("en-IN")} allowed$`));
    // Nothing was bought, and the trace says so (kellycap): 0 lots, ₹0 at risk, the cap named.
    expect(e.sizing).toMatchObject({ lots: 0, riskRupees: 0, limitedBy: expect.stringMatching(/^the quarter-Kelly budget: one lot risks ₹[\d,]+, more than the ₹[\d,]+ it allows$/) });
    expect(await agent.repo.positions.open("BACKTEST")).toEqual([]);
  });

  it("treats a one-sided book as information only and blocks a book with no depth (AMENDMENTS #27)", async () => {
    const lopsided = await setup({ tweak: (q) => ({ ...q, source: "upstox", depth: undefined, bidQty: 75, askQty: 1_950 }) });
    const r1 = await executeAgentBatch(lopsided.agent, batchOf([fired()]), lopsided.ctx({ acceptSyntheticQuotes: false }));
    const e1 = exec(r1, "d-long");
    expect(e1.action).toBe("ENTERED");
    expect(line(e1, "one_sided_book")).toEqual({ gate: "one_sided_book", passed: null, detail: "Information only: one-sided book 0.93 (75 bid vs 1950 offered, top of book; 0.85 would count as one-sided)" });

    const empty = await setup({ tweak: (q) => ({ ...q, source: "upstox", depth: undefined, bidQty: 0, askQty: 0 }) });
    const r2 = await executeAgentBatch(empty.agent, batchOf([fired()]), empty.ctx({ acceptSyntheticQuotes: false }));
    const e2 = exec(r2, "d-long");
    expect(e2.action).toBe("NO_ENTRY");
    expect(line(e2, "quote_toxic")).toMatchObject({ passed: false, detail: "Live quote not usable: no quantity bid or offered" });
  });

  it("never buys on a synthetic (model) price unless a test allows it", async () => {
    const { agent, ctx } = await setup();
    const r = await executeAgentBatch(agent, batchOf([fired()]), ctx({ acceptSyntheticQuotes: false }));
    expect(exec(r, "d-long").action).toBe("NO_ENTRY");
    expect(line(exec(r, "d-long"), "quote_toxic")).toMatchObject({ passed: false, detail: "Live quote not usable: the quote is a model price, not the market's" });
    expect(exec(r, "d-long").detail).toBe("the live quote is not usable: SYNTHETIC_QUOTE");
  });

  it("stops entries when the time budget is used up but still runs the exits", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const reduce = fired({ id: "d-reduce", index: "NIFTY", direction: "NEUTRAL", riskState: "REDUCE" });
    const sensex = fired({ id: "d-sensex", index: "SENSEX", finalistId: "gen:SENSEX" });
    const r = await executeAgentBatch(agent, batchOf([reduce, sensex]), ctx({ positions: x.positions, timeLeftMs: () => 0 }));
    expect(r.exits.map((e) => [e.positionId, e.status])).toEqual([[pid, "FILLED"]]);
    expect(exec(r, "d-sensex").action).toBe("NOT_EXECUTED");
    expect(line(exec(r, "d-sensex"), "time_budget")?.passed).toBe(false);
  });

  it("never reads the market source itself: an index with no features from main's tick gets no entry (S3)", async () => {
    const { agent, ctx, features } = await setup();
    let marketCalls = 0;
    const market = {
      snapshot: async () => {
        marketCalls++;
        throw new Error("the agent read main's market source");
      },
    };
    const r = await executeAgentBatch({ ...agent, market }, batchOf([fired()]), ctx({ features: { SENSEX: features.SENSEX } }));
    const e = exec(r, "d-long");
    expect(e.action).toBe("NO_ENTRY");
    expect(e.detail).toBe("no market features: main's tick computed no market features for this index; the agent never fetches its own");
    expect(line(e, "features")).toEqual({ gate: "features", passed: false, detail: "main's tick computed no market features for this index; the agent never fetches its own" });
    // The sizing is kept in the record; nothing was planned or ordered.
    expect(e.sizing).toMatchObject({ p: 0.6, b: 1, riskPct: 1, lots: 0 });
    expect(line(e, "plan")).toBeUndefined();
    expect(marketCalls).toBe(0);
    expect(await agent.repo.orders.between(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("stops the rest of a running batch when the operator pauses the agent (S4)", async () => {
    const { agent, ctx } = await setup();
    let reads = 0;
    // Off for the first order, on from the second: the pause was pressed while the batch ran.
    const paused = () => ++reads > 1;
    const sensex = fired({ id: "d-sensex", index: "SENSEX", finalistId: "gen:SENSEX", directionConfidence: 0.85 });
    const r = await executeAgentBatch(agent, batchOf([fired(), sensex]), ctx({ paused }));
    expect(exec(r, "d-long").action).toBe("ENTERED");
    const e = exec(r, "d-sensex");
    expect(e.action).toBe("NO_ENTRY");
    expect(e.detail).toBe("paused: the operator paused the agent");
    expect(line(e, "kill_switch")).toEqual({ gate: "kill_switch", passed: false, detail: "the operator paused the agent" });
    expect((await agent.repo.positions.open("BACKTEST")).map((p) => p.index)).toEqual(["NIFTY"]);
    // Paused from the start: no entry at all.
    const again = await setup();
    const r2 = await executeAgentBatch(again.agent, batchOf([fired(), sensex]), again.ctx({ paused: () => true }));
    expect([exec(r2, "d-long").action, exec(r2, "d-sensex").action]).toEqual(["NO_ENTRY", "NO_ENTRY"]);
    expect(await again.agent.repo.positions.open("BACKTEST")).toEqual([]);
  });

  it("does not enter while main is degraded or the drawdown halt is on", async () => {
    const { agent, ctx } = await setup();
    const r1 = await executeAgentBatch(agent, batchOf([fired()]), ctx({ noEntries: "main engine degraded" }));
    expect(exec(r1, "d-long").action).toBe("NO_ENTRY");
    expect(exec(r1, "d-long").gate.lines.some((l) => l.gate === "entry_mode" && l.passed === false)).toBe(true);
    const r2 = await executeAgentBatch(agent, batchOf([fired()]), ctx({ ddHalt: true }));
    expect(exec(r2, "d-long").action).toBe("NO_ENTRY");
    expect(await agent.repo.positions.open("BACKTEST")).toEqual([]);
  });

  it("buys an Advisor idea's own contract and checks the brief's buy zone", async () => {
    const { agent, ctx } = await setup();
    const atm = Math.round(agent.marketContext.get("NIFTY")!.spot / 50) * 50;
    const expiry = agent.calendar.followingExpiry("NIFTY", agent.calendar.expiryOnOrAfter("NIFTY", DAY));
    const contract = (await agent.instruments.resolve("NIFTY", expiry, atm + 100, "CE"))!;
    const idea: Finalist = {
      id: "idea:b1:i1", kind: "IDEA", index: "NIFTY", label: contract.tradingSymbol, side: "LONG",
      contract: { expiry, strike: contract.strike, type: "CE", tradingSymbol: contract.tradingSymbol, lotSize: contract.lotSize },
      entryHigh: 10_000, condition: "only above VWAP", wrongIf: "a close below the opening range", bearCase: null, why: [], horizon: "TODAY", briefId: "b1",
    };
    const d = fired({ id: "d-idea", finalistId: idea.id, finalistKind: "IDEA" });
    const r = await executeAgentBatch(agent, batchOf([d], { finalists: [generic("NIFTY"), idea] }), ctx());
    const e = exec(r, "d-idea");
    expect(e.action).toBe("ENTERED");
    expect(e.tradingSymbol).toBe(contract.tradingSymbol);
    expect(line(e, "idea_band")?.passed).toBe(true);

    const { agent: agent2, ctx: ctx2 } = await setup();
    const tight: Finalist = { ...idea, entryHigh: 1 };
    const r2 = await executeAgentBatch(agent2, batchOf([d], { finalists: [tight] }), ctx2());
    expect(exec(r2, "d-idea").action).toBe("NO_ENTRY");
    expect(line(exec(r2, "d-idea"), "idea_band")?.passed).toBe(false);
  });
});

describe("edgeVerdict", () => {
  it("compares the move the option needs with the move the index usually makes, with no conviction score", async () => {
    const { agent, features } = await setup();
    const f = features.NIFTY;
    const expiry = agent.calendar.followingExpiry("NIFTY", agent.calendar.expiryOnOrAfter("NIFTY", DAY));
    const contract = (await agent.instruments.resolve("NIFTY", expiry, Math.round(f.spot / 50) * 50, "CE"))!;
    const quote = await agent.optionQuotes.quote(contract, { t: NOW, spot: f.spot, vix: f.vix });
    const v = edgeVerdict({ cfg: agentCfg, spot: f.spot, quote, contract, calendar: agent.calendar, vix: f.vix, horizonMin: 60, t: NOW });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ gate: "move_vs_breakeven", label: "Move this option needs vs the move the index usually makes" });
    expect(v.rows[0].detail).toMatch(/^it needs a \d+\.\d\d% move in 60 min to cover time decay, the spread and charges; the index usually moves about \d+\.\d\d% in that time/);
    expect(v.passed).toBe(v.rows[0].passed);
    // A much longer holding time needs more of a move to pay for the decay.
    const long = edgeVerdict({ cfg: agentCfg, spot: f.spot, quote, contract, calendar: agent.calendar, vix: f.vix, horizonMin: 240, t: NOW });
    expect(long.rows[0].detail).not.toBe(v.rows[0].detail);
  });
});

describe("agentPositionPass", () => {
  it("runs the code exits with no conviction, so main's signals never flip an agent position", async () => {
    const { agent, ctx } = await setup();
    const x = ctx();
    const first = await executeAgentBatch(agent, batchOf([fired()]), x);
    const pid = exec(first, "d-long").positionId!;
    const report = await agentPositionPass(agent);
    expect(report.marked).toBe(1);
    expect(report.exits).toEqual([]);
    expect((await agent.repo.positions.get(pid))?.status).toBe("OPEN");
    // The square-off closes it.
    agent.clock.set(istAt(DAY, "15:06"));
    agent.marketContext.set("NIFTY", { ...agent.marketContext.get("NIFTY")!, t: istAt(DAY, "15:06") });
    const late = await agentPositionPass(agent);
    expect(late.exits.map((e) => e.reason)).toEqual(["SQUARE_OFF"]);
  });
});
