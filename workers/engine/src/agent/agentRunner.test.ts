/**
 * The options agent's side of TE's tick (agentRunner.ts) against fakes: the AgentDO and MarketFeedDO stubs, TE's
 * storage and the quote source, over in-memory repositories (the agent's book is the scoped PAPER@agent book, as in
 * production). The engine-side agent functions (src/engine/agent) are small fakes here, so these tests cover the
 * runner's own order, time budget, retries, outbox and safety glue; the engine package tests those functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTS, accountConfig } from "../../../../src/engine/accounts";
import { agentPositionPass, bookAsOf, bookFrom, buildReflexInput, executeAgentBatch, initialBook } from "../../../../src/engine/agent/agentCycle";
import { latestClosedBarMs } from "../../../../src/engine/agent/causal";
import { AGENT_STEP } from "../../../../src/engine/agent/constants";
import { drawdownBreached, riskSnapshotFrom } from "../../../../src/engine/agent/risk";
import type { AgentRiskSnapshot, AgentSettings, AgentTradeRecord, DecisionRecord, ExecutionRecord, IndexSnapshot, ReflexBatch, ReflexInput } from "../../../../src/engine/agent/types";
import { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { FixedClock, istAt, istDate, istMidnight, type Clock } from "../../../../src/engine/clock";
import { DEFAULT_CONFIG } from "../../../../src/engine/config";
import { UpstoxOptionQuotes, type UpstoxMarketClient } from "../../../../src/engine/market/upstoxMarket";
import { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import { runPositionCycle } from "../../../../src/engine/pipeline/positionCycle";
import type { CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { sequentialIds, silentLogger, type OptionQuoteSource, type Repository } from "../../../../src/engine/ports";
import { accountRepository } from "../../../../src/engine/repo/accountRepo";
import { InMemoryRepository } from "../../../../src/engine/repo/memory";
import type { MarketSnapshot, OptionContract, Position, TradeRecord, TradingMode } from "../../../../src/engine/types";
import { AgentRunner, HOT_KEY, agentQuoteSource, agentStepBudgetMs, killAll, type AgentDoPort, type AgentHot, type AgentResult, type KillStep } from "./agentRunner";

vi.mock("../../../../src/engine/agent/agentCycle", () => ({
  agentPositionPass: vi.fn(),
  executeAgentBatch: vi.fn(),
  buildReflexInput: vi.fn(),
  bookAsOf: vi.fn(),
  bookFrom: vi.fn(),
  initialBook: vi.fn(),
}));
vi.mock("../../../../src/engine/agent/causal", () => ({ latestClosedBarMs: vi.fn() }));
vi.mock("../../../../src/engine/agent/risk", () => ({ riskSnapshotFrom: vi.fn(), drawdownBreached: vi.fn() }));

const DAY = "2026-10-19"; // a Monday, a trading day
const BAR = istAt(DAY, "10:00"); // the latest closed 5-minute bar
const T0 = BAR + 45_000; // TE's tick, 45 s after the close
const LATER = T0 + 60_000; // a deadline with time for everything (the fixed clock does not move on its own)
const cfg = DEFAULT_CONFIG;
const agentCfg = accountConfig(cfg, "agent");
const calendar = new TradingCalendar();
const SETTINGS: AgentSettings = { mode: "paper", reflexModel: "reflex-test", escalationModel: "deep-test", reviewModel: "deep-test", dailyUsdCap: 3, escalationsPerDay: 8 };
const SNAP = { c: 25_000 } as unknown as IndexSnapshot;

function risk(t: number, o: Partial<AgentRiskSnapshot> = {}): AgentRiskSnapshot {
  return { t, date: istDate(t), equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, openPositions: 0, killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, codeRisk: "SAFE", ...o };
}

function decision(o: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d-1",
    date: DAY,
    barCloseMs: BAR,
    index: "NIFTY",
    finalistKind: "GENERIC",
    source: "REFLEX",
    callId: "c-1",
    instructionVersion: "core-1/test",
    effective: true,
    finalistId: "gen:NIFTY",
    regime: "TRENDING",
    direction: "LONG",
    directionConfidence: 0.85,
    toxicFlow: false,
    setupQuality: 3,
    riskState: "SAFE",
    reason: "test",
    sizing: null,
    execution: null,
    outcome: null,
    ...o,
  };
}

function batch(o: Partial<ReflexBatch> = {}): ReflexBatch {
  const barCloseMs = o.barCloseMs ?? BAR;
  return {
    barCloseMs,
    date: DAY,
    status: "OK",
    error: null,
    callId: "c-1",
    instructionVersion: "core-1/test",
    finalists: [],
    briefId: null,
    briefContext: null,
    decisions: [decision({ id: `d-${barCloseMs}`, barCloseMs })],
    exitOnly: [],
    payoff: { b: 1, n: 0 },
    completedMs: barCloseMs + 40_000,
    ...o,
  };
}

const CONTRACT: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "NIFTY26O2725000CE", growwSymbol: "NSE-NIFTY-27Oct26-25000-CE", exchangeToken: "50001", expiry: "2026-10-27", strike: 25_000, type: "CE", lotSize: 65, tickSize: 0.05 };

function position(o: Partial<Position> = {}): Position {
  return {
    id: "pos-1",
    planId: "plan-1",
    index: "NIFTY",
    side: "BULL",
    contract: CONTRACT,
    mode: "PAPER",
    qty: 65,
    avgEntry: 120,
    entryMs: istAt(DAY, "09:40"),
    entryCharges: 30,
    status: "OPEN",
    markPremium: 120,
    markMs: istAt(DAY, "09:59"),
    peakPremium: 120,
    unrealized: 0,
    stops: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: istAt(DAY, "12:00"), squareOffMs: istAt(DAY, "15:05") },
    horizonMin: 120,
    convictionAtEntry: 0.5,
    regimeAtEntry: "TREND_UP",
    dominantSource: "VOL_REGIME",
    attribution: [{ source: "VOL_REGIME", share: 1 }],
    eventKeysAtEntry: [],
    maePct: 0,
    mfePct: 0,
    ...o,
  };
}

function trade(o: Partial<TradeRecord> = {}): TradeRecord {
  return {
    positionId: "pos-9",
    index: "NIFTY",
    side: "BULL",
    mode: "PAPER",
    tradingSymbol: CONTRACT.tradingSymbol,
    entryMs: istAt(DAY, "09:30"),
    exitMs: istAt(DAY, "09:50"),
    holdingMin: 20,
    entryPremium: 110,
    exitPremium: 120,
    qty: 130,
    pnl: 1_250,
    grossPnl: 1_300,
    pnlPctPremium: 8.7,
    charges: 50,
    maePct: -2,
    mfePct: 9,
    regime: "TREND_UP",
    exitReason: "SIGNAL_FLIP",
    convictionAtEntry: 0.5,
    dominantSource: "VOL_REGIME",
    attribution: [{ source: "VOL_REGIME", share: 1 }],
    ...o,
  };
}

function report(o: Partial<CycleReport> = {}): CycleReport {
  return { t: T0, phase: "OPEN", features: {}, convictions: {}, pressure: {}, decisions: [], entries: [], halted: null, errors: [], snapshot: {} as unknown as MarketSnapshot, perf: [], ...o };
}

/** The AgentDO as the runner sees it: each answer can be replaced; it keeps each bar once, like the real one. */
class FakeAgentDo implements AgentDoPort {
  stored = new Set<number>();
  submits: ReflexInput[] = [];
  takes: number[] = [];
  records: ExecutionRecord[] = [];
  batches: ReflexBatch[] = [];
  submit: (input: ReflexInput) => Promise<{ accepted: boolean; reason: string | null }> = async (input) => this.store(input);
  take: (afterBarMs: number) => Promise<ReflexBatch | null> = async (after) => this.batches.filter((b) => b.barCloseMs > after).at(-1) ?? null;
  record: (rec: ExecutionRecord) => Promise<void> = async () => {};

  store(input: ReflexInput): { accepted: boolean; reason: string | null } {
    const duplicate = this.stored.has(input.barCloseMs);
    this.stored.add(input.barCloseMs);
    return { accepted: true, reason: duplicate ? "duplicate" : null };
  }
  async submitBar(input: ReflexInput) {
    this.submits.push(input);
    return this.submit(input);
  }
  async takeDecisions(afterBarMs: number) {
    this.takes.push(afterBarMs);
    return this.take(afterBarMs);
  }
  async recordExecution(rec: ExecutionRecord) {
    await this.record(rec);
    this.records.push(structuredClone(rec));
  }
}

/** Upstox-like quotes: a two-sided book around ₹100. */
const QUOTES: OptionQuoteSource = {
  kind: "upstox",
  quote: async (c, ctx) => ({ symbol: c.tradingSymbol, t: ctx.t, ltp: 100, bid: 99.5, ask: 100.5, bidQty: 650, askQty: 650, source: "upstox" }),
};

function setup(o: { settings?: Partial<AgentSettings>; agentDo?: FakeAgentDo; clock?: Clock; repo?: (r: Repository) => Repository; quotes?: OptionQuoteSource | null; hot?: Partial<AgentHot> } = {}) {
  const clock = o.clock ?? new FixedClock(T0);
  const base = new InMemoryRepository(cfg, T0);
  const scoped = accountRepository(base, "agent", agentCfg, () => clock.now());
  const agentRepo = o.repo ? o.repo(scoped) : scoped;
  const kept = new Map<string, unknown>();
  if (o.hot) kept.set(HOT_KEY, structuredClone(o.hot));
  const agentDo = o.agentDo ?? new FakeAgentDo();
  const alerts: string[] = [];
  const marketContext = new MarketContextStore();
  marketContext.set("NIFTY", { spot: 25_000, vix: 13, t: T0 });
  marketContext.set("SENSEX", { spot: 82_000, vix: 13, t: T0 });
  const runner = new AgentRunner({
    account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo: agentRepo },
    mainRepo: base,
    settings: { ...SETTINGS, ...o.settings },
    storage: {
      get: async <T,>(key: string) => (kept.has(key) ? (structuredClone(kept.get(key)) as T) : undefined),
      put: async <T,>(key: string, value: T) => {
        kept.set(key, structuredClone(value));
      },
    },
    agentDo,
    feed: { getOptionFlowAsOf: async () => null },
    quotes: o.quotes === undefined ? QUOTES : o.quotes,
    market: {
      snapshot: async () => {
        throw new Error("the runner reads no market data itself");
      },
    },
    instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
    marketContext,
    alerts: {
      send: async (text) => {
        alerts.push(text);
        return true;
      },
    },
    logger: silentLogger,
    calendar,
    clock,
    newId: sequentialIds("ag"),
  });
  const hot = () => kept.get(HOT_KEY) as AgentHot;
  // The tests that pass a live clock never move it by hand.
  return { runner, clock: clock as FixedClock, base, agentRepo, agentDo, alerts, hot };
}

/** A clock that moves with real time (for the time-budget tests), starting at T0. */
function liveClock(): Clock {
  const offset = T0 - Date.now();
  return { now: () => Date.now() + offset, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  // The real agentPositionPass is runPositionCycle(deps, {}); it runs for real on the in-memory book.
  vi.mocked(agentPositionPass).mockReset().mockImplementation((deps) => runPositionCycle(deps, {}));
  vi.mocked(riskSnapshotFrom)
    .mockReset()
    .mockImplementation((r, prevPeak, f) => {
      const equity = r.day.startEquity + r.day.realized + r.day.unrealized - r.day.charges;
      const peakEquity = Math.max(prevPeak ?? equity, equity);
      const dayLoss = Math.max(0, -(r.day.realized + r.day.unrealized - r.day.charges));
      return risk(f.nowMs, {
        equity,
        peakEquity,
        ddPct: ((peakEquity - equity) / peakEquity) * 100,
        dayLossPct: (dayLoss / r.day.startEquity) * 100,
        openPositions: r.openPositions.length,
        killSwitch: f.killSwitch,
        killReason: f.killReason,
        mainKillSwitch: f.mainKillSwitch,
        ddHalt: f.ddHalt,
      });
    });
  vi.mocked(drawdownBreached).mockReset().mockImplementation((s) => s.ddPct >= 15);
  vi.mocked(bookFrom)
    .mockReset()
    .mockImplementation((r, positions, lotSizeOf) => ({
      t: r.t,
      equity: r.equity,
      peakEquity: r.peakEquity,
      ddPct: r.ddPct,
      dayLossPct: r.dayLossPct,
      positions: positions.map((p) => ({ index: p.index, side: p.side, lots: p.qty / lotSizeOf(p), avgEntry: p.avgEntry, markPremium: p.markPremium, markMs: p.markMs })),
    }));
  vi.mocked(bookAsOf)
    .mockReset()
    .mockImplementation((ring, t, fallback) => [...ring].reverse().find((b) => b.t <= t) ?? fallback);
  vi.mocked(initialBook)
    .mockReset()
    .mockImplementation((r, capital, t) => ({ t, equity: r?.equity ?? capital, peakEquity: r?.peakEquity ?? capital, ddPct: r?.ddPct ?? 0, dayLossPct: 0, positions: [] }));
  vi.mocked(latestClosedBarMs).mockReset().mockReturnValue(null);
  vi.mocked(buildReflexInput)
    .mockReset()
    .mockImplementation((a) => ({ barCloseMs: a.barCloseMs, date: istDate(a.barCloseMs), builtMs: a.nowMs, snapshots: { NIFTY: SNAP }, tokensEst: { NIFTY: 300 }, closes: { NIFTY: 25_000 }, problems: [] }));
  vi.mocked(executeAgentBatch)
    .mockReset()
    .mockImplementation(async (_deps, b, x) => ({
      barCloseMs: b.barCloseMs,
      t: x.nowMs,
      decisions: b.decisions.map((d) => ({
        decisionId: d.id,
        execution: {
          t: x.nowMs,
          gate: { fired: false, lines: [], codeToxic: [], codeRisk: "SAFE", effectiveRisk: "SAFE" },
          action: x.mode === "paper" ? "NO_ENTRY" : "SHADOW_ENTRY",
          detail: "test",
          planId: null,
          positionId: null,
          tradingSymbol: null,
          edge: null,
          sizing: null,
        },
      })),
      exits: [],
      trades: [],
      risk: risk(x.nowMs),
    }));
});

describe("agentStepBudgetMs", () => {
  it("is what is left of 27 s from the tick start, at least 4 s and at most 12 s", () => {
    expect(agentStepBudgetMs(T0, T0)).toBe(12_000);
    expect(agentStepBudgetMs(T0, T0 + 20_000)).toBe(7_000);
    expect(agentStepBudgetMs(T0, T0 + 26_000)).toBe(4_000);
    expect(agentStepBudgetMs(T0, T0 + 40_000)).toBe(4_000);
  });
});

describe("the agent's deps and quotes", () => {
  it("are PAPER on the agent's own book: a PAPER broker, the pinned config, its own quotes with synthetic ones behind", async () => {
    const h = setup();
    const deps = h.runner.deps(calendar);
    expect(deps.mode).toBe("PAPER");
    expect(deps.broker.mode).toBe("PAPER");
    expect(deps.cfg.capitalRupees).toBe(500_000);
    expect(deps.cfg.sizing.maxOpenPerIndex).toBe(1);
    expect(deps.optionQuotes.kind).toBe("upstox");
    expect(setup({ quotes: null }).runner.deps().optionQuotes.kind).toBe("synthetic");

    // Its orders land in the agent's book (PAPER@agent), never in main's.
    await h.agentRepo.positions.save(position());
    await h.runner.setKill({ engaged: true, squareOff: true, reason: "test" }, "tester");
    expect(await h.base.positions.open("PAPER")).toEqual([]);
    expect(await h.base.trades.recent(5, "PAPER")).toEqual([]);
    const [t] = await h.base.trades.recent(5, "PAPER@agent" as TradingMode);
    expect(t).toMatchObject({ positionId: "pos-1", exitReason: "KILL_SWITCH", mode: "PAPER@agent" });
  });

  it("uses its own Upstox quote instance with a budget of 4 requests a minute, apart from main's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      let requests = 0;
      const client: UpstoxMarketClient = {
        get: async () => ({}),
        quotesByKey: async (keys) => {
          requests++;
          return new Map(keys.map((k) => [k, {}]));
        },
      };
      const contract = (token: string): OptionContract => ({ ...CONTRACT, tradingSymbol: `NIFTY-${token}`, exchangeToken: token });
      const agent = agentQuoteSource(client);
      expect(agent).toBeInstanceOf(UpstoxOptionQuotes);
      expect(agentQuoteSource(null)).toBeNull();
      // One contract asked for every 16 s: each needs a request (the cache keeps a quote 15 s).
      for (const [i, s] of [0, 16, 32, 48].entries()) {
        vi.setSystemTime(T0 + s * 1_000);
        await agent!.quote(contract("A"));
        expect(requests).toBe(i + 1);
      }
      // The fifth request inside the minute is refused, so the fallback would price that one synthetically...
      vi.setSystemTime(T0 + 50_000);
      await expect(agent!.quote(contract("B"))).rejects.toThrow(/budget/);
      expect(requests).toBe(4);
      // ...while main's own instance (its default budget) still answers: the agent never spends main's requests.
      const main = new UpstoxOptionQuotes(client);
      await main.quote(contract("C"));
      expect(requests).toBe(5);
      // A minute after the first request the agent may ask again.
      vi.setSystemTime(T0 + 61_000);
      await agent!.quote(contract("B"));
      expect(requests).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentRunner.step", () => {
  it("runs the exits, executes the newest fresh batch, records it and submits the latest closed bar", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position());
    h.agentDo.batches = [batch({ barCloseMs: BAR - 300_000 }), batch()];
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    await h.runner.step(report(), calendar, false, LATER);

    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    // The newest batch after the day's start; the older one is never executed.
    expect(h.agentDo.takes).toEqual([istMidnight(DAY)]);
    expect(executeAgentBatch).toHaveBeenCalledTimes(1);
    const [deps, executed, ctx] = vi.mocked(executeAgentBatch).mock.calls[0];
    expect(executed.barCloseMs).toBe(BAR);
    expect(deps.mode).toBe("PAPER");
    expect(ctx).toMatchObject({ mode: "paper", nowMs: T0, noEntries: null, ddHalt: false, peakEquity: expect.any(Number) });
    expect((await ctx.mainSettings()).killSwitch).toBe(false);
    expect(ctx.timeLeftMs!()).toBe(LATER - T0);
    // The record carries every decision's execution and the risk.
    expect(h.agentDo.records).toHaveLength(1);
    expect(h.agentDo.records[0].decisions.map((d) => d.execution.action)).toEqual(["NO_ENTRY"]);
    // The bar went to the AgentDO with the book as of its close.
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);
    expect(vi.mocked(buildReflexInput).mock.calls[0][0]).toMatchObject({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"], indices: ["NIFTY", "SENSEX"], nowMs: T0 });
    const hot = h.hot();
    expect(hot).toMatchObject({ date: DAY, lastExecutedBarMs: BAR, lastSubmittedBarMs: BAR, ddHalt: false, paused: false });
    expect(hot.books).toHaveLength(1);
    expect(hot.inputs).toEqual([{ barCloseMs: BAR, snapshots: { NIFTY: SNAP } }]);
  });

  it("gives the code gate the snapshot its bar was submitted with", async () => {
    const h = setup();
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    await h.runner.step(report(), calendar, false, LATER);
    h.agentDo.batches = [batch()];
    h.clock.advance(30_000);
    await h.runner.step(report({ t: T0 + 30_000 }), calendar, false, LATER + 30_000);
    expect(vi.mocked(executeAgentBatch).mock.calls[0][2].snapshots).toEqual({ NIFTY: SNAP });
    // The bar was submitted once.
    expect(h.agentDo.submits).toHaveLength(1);
  });

  it("records a batch taken more than 4 minutes after its close as not executed", async () => {
    const h = setup();
    const old = BAR - 5 * 60_000;
    h.agentDo.batches = [batch({ barCloseMs: old })];
    await h.runner.step(report(), calendar, false, LATER);
    expect(executeAgentBatch).not.toHaveBeenCalled();
    const [rec] = h.agentDo.records;
    expect(rec.barCloseMs).toBe(old);
    expect(rec.decisions[0].execution).toMatchObject({ action: "NOT_EXECUTED", gate: { fired: false, lines: [{ gate: "fresh", passed: false }] } });
    expect(rec.decisions[0].execution.detail).toMatch(/^stale: taken 345 s after the candle closed/);
    expect(h.hot().lastExecutedBarMs).toBe(old);
  });

  it("in shadow mode executes in shadow and runs no position pass while the account holds nothing", async () => {
    const h = setup({ settings: { mode: "shadow" } });
    h.agentDo.batches = [batch()];
    await h.runner.step(report(), calendar, false, LATER);
    expect(vi.mocked(executeAgentBatch).mock.calls[0][2].mode).toBe("shadow");
    expect(agentPositionPass).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([]);
  });

  it("while paused, and in mode off, runs only the code exits: no decisions taken, no bar submitted", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const paused = setup();
    await paused.agentRepo.positions.save(position());
    expect(await paused.runner.setPaused(true, "ops")).toEqual({ ok: true, message: "agent paused: only its code exits run" });
    await paused.runner.step(report(), calendar, false, LATER);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(paused.agentDo.takes).toEqual([]);
    expect(paused.agentDo.submits).toEqual([]);
    expect(paused.hot().paused).toBe(true);

    vi.mocked(agentPositionPass).mockClear();
    const off = setup({ settings: { mode: "off" } });
    await off.agentRepo.positions.save(position());
    await off.runner.step(report(), calendar, false, LATER);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(off.agentDo.takes).toEqual([]);
    expect(off.agentDo.submits).toEqual([]);
  });

  it("before the open only loads its state", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position());
    h.agentDo.batches = [batch()];
    await h.runner.step(report({ phase: "PRE_OPEN" }), calendar, false, LATER);
    expect(agentPositionPass).not.toHaveBeenCalled();
    expect(h.agentDo.takes).toEqual([]);
    expect(h.hot().date).toBe(DAY);
  });

  it("waits for both indices' bars until 2 minutes after the close, then submits what is complete; skips a bar after 4", async () => {
    const h = setup();
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY"] });
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.agentDo.submits).toEqual([]);
    h.clock.set(BAR + 2 * 60_000);
    await h.runner.step(report(), calendar, false, BAR + 3 * 60_000);
    expect(vi.mocked(buildReflexInput).mock.calls[0][0].complete).toEqual(["NIFTY"]);
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);

    const late = setup();
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: [] });
    late.clock.set(BAR + 4 * 60_000 + 1);
    await late.runner.step(report(), calendar, false, BAR + 6 * 60_000);
    expect(late.agentDo.submits).toEqual([]);
    expect(late.hot().lastSubmittedBarMs).toBe(BAR);
  });

  it("returns within its budget when the AgentDO hangs, after the exits; the bar waits for the next tick", async () => {
    const clock = liveClock();
    const agentDo = new FakeAgentDo();
    agentDo.take = () => new Promise(() => {});
    agentDo.submit = () => new Promise(() => {});
    const h = setup({ clock, agentDo });
    await h.agentRepo.positions.save(position());
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });

    // The smallest budget: the decisions time out (1.5 s) and no time is left to submit the bar.
    let started = Date.now();
    await h.runner.step(report(), calendar, false, clock.now() + AGENT_STEP.minMs);
    expect(Date.now() - started).toBeLessThan(AGENT_STEP.minMs);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(agentDo.takes).toHaveLength(1);
    expect(agentDo.submits).toHaveLength(0);

    // The largest: the submission is tried and times out too (2 s); the bar stays unsubmitted, so it is retried.
    started = Date.now();
    await h.runner.step(report(), calendar, false, clock.now() + AGENT_STEP.maxMs);
    expect(Date.now() - started).toBeLessThan(AGENT_STEP.maxMs);
    expect(agentDo.submits).toHaveLength(1);
    expect(h.hot().lastSubmittedBarMs).toBe(istMidnight(DAY));
  });

  it("retries a submission that timed out; the AgentDO keeps the bar once", async () => {
    const clock = liveClock();
    const agentDo = new FakeAgentDo();
    let first = true;
    agentDo.submit = async (input) => {
      if (first) {
        first = false;
        await sleep(2_500); // past the runner's 2 s: the AgentDO still stores the bar
      }
      return agentDo.store(input);
    };
    const h = setup({ clock, agentDo });
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    await h.runner.step(report(), calendar, false, clock.now() + AGENT_STEP.maxMs);
    expect(h.hot().lastSubmittedBarMs).toBe(istMidnight(DAY));
    await sleep(700);
    await h.runner.step(report(), calendar, false, clock.now() + AGENT_STEP.maxMs);
    expect(agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR, BAR]);
    expect([...agentDo.stored]).toEqual([BAR]);
    expect(h.hot().lastSubmittedBarMs).toBe(BAR);
  });

  it("couples main's kill switch to the agent's; resetting main leaves the agent's on", async () => {
    const h = setup();
    await h.base.settings.update({ killSwitch: true, killReason: "operator" }, "tester");
    await h.runner.step(report(), calendar, false, LATER);
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "main kill switch engaged at 10:00" });
    expect(h.alerts.some((a) => a.includes("kill switch engaged because main's is on (operator)"))).toBe(true);
    // A reset of the agent alone is refused while main's is on.
    expect((await h.runner.setKill({ engaged: false, squareOff: false, reason: "" }, "tester")).ok).toBe(false);

    await h.base.settings.update({ killSwitch: false, killReason: null }, "tester");
    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 30_000);
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(true);
    expect(await h.runner.setKill({ engaged: false, squareOff: false, reason: "" }, "tester")).toEqual({ ok: true, message: "Agent kill switch reset" });
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(false);
  });

  it("halts at a 15% drawdown: kill switch, positions closed at market, entries refused; only a re-arm clears it", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000 } });
    // Earlier losses: today starts at ₹4,20,000 against a ₹5,00,000 peak (16%).
    await h.agentRepo.ledger.save({ date: "2026-10-16", mode: "PAPER", realized: -80_000, unrealized: 0, charges: 0, trades: 4, wins: 0, losses: 4, consecutiveLosses: 4, ordersPlaced: 8, maxIntradayDrawdown: 80_000, peakEquity: 500_000, startEquity: 500_000, updatedMs: T0 - 3 * 86_400_000 });
    await h.agentRepo.positions.save(position());
    h.agentDo.batches = [batch()];
    await h.runner.step(report(), calendar, false, LATER);

    expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" });
    expect(h.hot().ddHalt).toBe(true);
    expect(vi.mocked(executeAgentBatch).mock.calls[0][2].ddHalt).toBe(true);
    expect(h.alerts.filter((a) => /down 16\.\d% from its peak equity/.test(a))).toHaveLength(1);

    // A plain reset cannot clear it, alone or as part of "all".
    expect((await h.runner.setKill({ engaged: false, squareOff: false, reason: "" }, "tester")).message).toMatch(/drawdown limit; use Re-arm/);
    expect((await h.runner.setKill({ engaged: false, squareOff: false, reason: "" }, "tester", { all: true })).ok).toBe(false);

    const res = await h.runner.rearm("tester");
    expect(res.ok).toBe(true);
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: false, killReason: null });
    const after = h.hot();
    expect(after.ddHalt).toBe(false);
    expect(after.peakEquity).toBeLessThan(420_000); // the current equity, after the loss on the closed position
    expect(res.message).toBe(`Agent re-armed: kill switch off; peak equity restarts at ₹${after.peakEquity!.toFixed(0)}`);

    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 30_000);
    expect(h.hot().ddHalt).toBe(false);
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(false);
  });

  it("re-arms only after the step in progress, so the step cannot write the old peak back", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000, ddHalt: true } });
    await h.agentRepo.ledger.save({ date: "2026-10-16", mode: "PAPER", realized: -80_000, unrealized: 0, charges: 0, trades: 4, wins: 0, losses: 4, consecutiveLosses: 4, ordersPlaced: 8, maxIntradayDrawdown: 80_000, peakEquity: 500_000, startEquity: 500_000, updatedMs: T0 - 3 * 86_400_000 });
    await h.agentRepo.positions.save(position());
    let release = () => {};
    vi.mocked(agentPositionPass).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ t: T0, marked: 0, exits: [], ordersRefreshed: 0, ordersCancelled: 0, errors: [] });
        }),
    );
    const order: string[] = [];
    const stepping = h.runner.step(report(), calendar, false, LATER).then(() => order.push("step"));
    await sleep(10);
    const rearming = h.runner.rearm("tester").then((r) => {
      order.push("re-arm");
      return r;
    });
    await sleep(10);
    expect(order).toEqual([]);
    release();
    const res = await rearming;
    await stepping;
    expect(order).toEqual(["step", "re-arm"]);
    expect(res.ok).toBe(true);
    expect(h.hot()).toMatchObject({ ddHalt: false, peakEquity: 420_000 });
  });

  it("refuses a re-arm while main's kill switch is on", async () => {
    const h = setup({ hot: { date: DAY, ddHalt: true } });
    await h.base.settings.update({ killSwitch: true, killReason: "operator" }, "tester");
    expect((await h.runner.rearm("tester")).ok).toBe(false);
  });

  it("keeps an undelivered record in the outbox and sends it first; trades count as sent only when acknowledged", async () => {
    const h = setup();
    await h.base.trades.append({ ...trade(), mode: "PAPER@agent" as TradingMode });
    let fail = true;
    h.agentDo.record = async () => {
      if (fail) throw new Error("AgentDO restarting");
    };
    h.agentDo.batches = [batch()];
    await h.runner.step(report(), calendar, false, LATER);
    let hot = h.hot();
    expect(hot.outbox).toHaveLength(1);
    expect(hot.outbox[0].decisions).toHaveLength(1);
    expect(hot.outbox[0].trades).toEqual([]);
    expect(hot.unsentTrades.map((t) => t.positionId)).toEqual(["pos-9"]);
    expect(hot.sentTrades).toEqual([]);

    fail = false;
    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 30_000);
    expect(h.agentDo.records.map((r) => [r.barCloseMs, r.decisions.length, r.trades.map((t) => t.positionId)])).toEqual([
      [BAR, 1, []],
      [BAR, 0, ["pos-9"]],
    ]);
    const sent: AgentTradeRecord = h.agentDo.records[1].trades[0];
    expect(sent).toMatchObject({ date: DAY, lots: 2, pnlRupees: 1_250, exitReason: "SIGNAL_FLIP", agentExit: null, finalistId: null });
    hot = h.hot();
    expect(hot.outbox).toEqual([]);
    expect(hot.unsentTrades).toEqual([]);
    expect(hot.sentTrades).toEqual(["pos-9"]);
  });

  it("caps the outbox at its limit, dropping the oldest records but never a trade", async () => {
    const h = setup();
    await h.base.trades.append({ ...trade(), mode: "PAPER@agent" as TradingMode });
    h.agentDo.record = async () => {
      throw new Error("AgentDO down");
    };
    for (let i = 0; i < AGENT_STEP.outboxMax + 3; i++) {
      const bar = BAR + i * 300_000;
      h.agentDo.batches.push(batch({ barCloseMs: bar }));
      h.clock.set(bar + 45_000);
      await h.runner.step(report({ t: bar + 45_000 }), calendar, false, bar + 105_000);
    }
    const hot = h.hot();
    expect(hot.outbox).toHaveLength(AGENT_STEP.outboxMax);
    expect(hot.outbox[0].barCloseMs).toBe(BAR + 3 * 300_000);
    expect(hot.unsentTrades.map((t) => t.positionId)).toEqual(["pos-9"]);
  });

  it("on a new IST date clears the day's fields and keeps the peak, the halt, the pause and the outbox", async () => {
    const yesterday: Partial<AgentHot> = {
      date: "2026-10-16",
      lastSubmittedBarMs: istAt("2026-10-16", "15:30"),
      lastExecutedBarMs: istAt("2026-10-16", "15:05"),
      peakEquity: 510_000,
      ddHalt: true,
      paused: true,
      books: [{ t: istAt("2026-10-16", "15:29"), equity: 505_000, peakEquity: 510_000, ddPct: 1, dayLossPct: 0, positions: [] }],
      sentTrades: ["old"],
      outbox: [{ barCloseMs: istAt("2026-10-16", "15:05"), t: 1, decisions: [{ decisionId: "x", execution: {} as never }], exits: [], trades: [], risk: risk(1) }],
    };
    const h = setup({ hot: yesterday });
    await h.runner.step(report(), calendar, false, LATER);
    const hot = h.hot();
    expect(hot).toMatchObject({ date: DAY, lastSubmittedBarMs: istMidnight(DAY), lastExecutedBarMs: istMidnight(DAY), peakEquity: 510_000, ddHalt: true, paused: true, sentTrades: [] });
    expect(hot.books.map((b) => b.t)).toEqual([T0]);
    expect(hot.outbox).toHaveLength(1);
  });

  it("alerts once a day when the model budget is used up", async () => {
    const h = setup();
    h.agentDo.batches = [batch({ status: "COST_CAP", decisions: [] })];
    await h.runner.step(report(), calendar, false, LATER);
    h.agentDo.batches.push(batch({ barCloseMs: BAR + 300_000, status: "COST_CAP", decisions: [] }));
    h.clock.set(BAR + 345_000);
    await h.runner.step(report(), calendar, false, BAR + 405_000);
    expect(h.alerts.filter((a) => a.includes("daily model budget ($3) is used up"))).toHaveLength(1);
  });
});

describe("the runner's guards", () => {
  it("never throws from openCount, exitsOnly or statusLines; failures count against the agent only", async () => {
    const h = setup({
      repo: (r) => ({
        ...r,
        positions: {
          ...r.positions,
          open: async () => {
            throw new Error("D1 unavailable");
          },
        },
      }),
    });
    expect(await h.runner.openCount()).toBe(0);
    await expect(h.runner.exitsOnly(calendar)).resolves.toBeUndefined();
    await expect(h.runner.step(report(), calendar, false, LATER)).resolves.toBeUndefined();
    expect(h.runner.errors).toBe(2);
    expect(await h.runner.statusLines()).toEqual(["Agent: status unavailable (D1 unavailable)"]);
  });

  it("alerts once at five failed steps in a row", async () => {
    const h = setup();
    vi.mocked(agentPositionPass).mockRejectedValue(new Error("boom"));
    await h.agentRepo.positions.save(position());
    for (let i = 0; i < 6; i++) await h.runner.exitsOnly(calendar);
    expect(h.runner.errors).toBe(6);
    expect(h.alerts.filter((a) => a.includes("5 failed steps in a row (exits): boom"))).toHaveLength(1);
  });

  it("skips work while an earlier step still runs", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position());
    let release = () => {};
    vi.mocked(agentPositionPass).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ t: T0, marked: 0, exits: [], ordersRefreshed: 0, ordersCancelled: 0, errors: [] });
        }),
    );
    const running = h.runner.step(report(), calendar, false, LATER);
    await sleep(10);
    await h.runner.exitsOnly(calendar);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    release();
    await running;
  });

  it("reports its state in Telegram /status lines", async () => {
    const h = setup({ settings: { mode: "shadow" } });
    await h.agentRepo.positions.save(position());
    expect(await h.runner.statusLines()).toEqual([
      "Agent (paper experiment): mode shadow · kill switch off",
      "  bars: last submitted none, last executed none · open 1 · today net ₹0 · errors 0",
      "  Agent NIFTY26O2725000CE x65 @ 120.00 mark 120.00",
    ]);
  });
});

describe("kill switches", () => {
  const step = (order: string[], label: string, res: AgentResult | Error): KillStep => ({
    label,
    run: async () => {
      order.push(label);
      if (res instanceof Error) throw res;
      return res;
    },
  });

  it("for all: main first, then every account on its own; one failure never stops the rest", async () => {
    const order: string[] = [];
    const res = await killAll(true, step(order, "main", { ok: true, message: "kill switch engaged" }), [
      step(order, "₹10k", new Error("kv write failed")),
      step(order, "Agent", { ok: true, message: "Agent kill switch engaged" }),
    ]);
    expect(order).toEqual(["main", "₹10k", "Agent"]);
    expect(res).toEqual({ ok: false, message: "kill switch engaged; ₹10k: kill switch not engaged: kv write failed; Agent kill switch engaged" });
  });

  it("for an all reset, the agent's drawdown-halt refusal is a line, not a failure; main's failure is one", async () => {
    const order: string[] = [];
    const refusal = { ok: false, message: "Agent: stopped at its 15% drawdown limit; use Re-arm on the Agent page" };
    expect(await killAll(false, step(order, "main", { ok: true, message: "kill switch reset" }), [step(order, "Agent", refusal)])).toEqual({ ok: true, message: `kill switch reset; ${refusal.message}` });
    expect((await killAll(true, step(order, "main", { ok: true, message: "kill switch engaged" }), [step(order, "Agent", refusal)])).ok).toBe(false);
    expect((await killAll(false, step(order, "main", { ok: false, message: "no" }), [])).ok).toBe(false);
  });

  it("for all, the agent's switch is set without exits (TE's one tick squares off every account); alone it exits at once", async () => {
    const all = setup();
    await all.agentRepo.positions.save(position());
    expect(await all.runner.setKill({ engaged: true, squareOff: true, reason: "telegram /kill" }, "telegram", { all: true })).toEqual({ ok: true, message: "Agent kill switch engaged" });
    expect(await all.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "telegram /kill" });
    expect(agentPositionPass).not.toHaveBeenCalled();
    expect((await all.agentRepo.positions.get("pos-1"))?.status).toBe("OPEN");

    const alone = setup();
    await alone.agentRepo.positions.save(position());
    await alone.runner.setKill({ engaged: true, squareOff: true, reason: "dashboard" }, "tester");
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(await alone.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(alone.alerts).toEqual(["🤖 Agent (paper experiment): 🛑 KILL SWITCH by tester: dashboard (squaring off)", expect.stringMatching(/^🤖 Agent \(paper experiment\): EXIT NIFTY26O2725000CE KILL_SWITCH \(FILLED\) net ₹-\d+$/)]);
  });
});

describe("afterEndOfDay", () => {
  it("sends every trade of the day again with the final risk and returns the summary line", async () => {
    const h = setup({ hot: { date: DAY, sentTrades: ["pos-9"] } });
    await h.base.trades.append({ ...trade(), mode: "PAPER@agent" as TradingMode });
    h.clock.set(istAt(DAY, "16:00"));
    const line = await h.runner.afterEndOfDay();
    expect(line).toBe("Agent (paper experiment, paper): no trades, equity ₹500000, drawdown 0.0%");
    const [rec] = h.agentDo.records;
    expect(rec).toMatchObject({ barCloseMs: istAt(DAY, "15:30"), decisions: [], exits: [] });
    expect(rec.trades.map((t) => t.positionId)).toEqual(["pos-9"]);
  });

  it("says when the record could not be delivered", async () => {
    const h = setup();
    await h.base.trades.append({ ...trade(), mode: "PAPER@agent" as TradingMode });
    h.agentDo.record = async () => {
      throw new Error("AgentDO down");
    };
    h.clock.set(istAt(DAY, "16:00"));
    expect(await h.runner.afterEndOfDay()).toMatch(/; 1 trade record wait for the AgentDO$/);
    expect(h.hot().unsentTrades.map((t) => t.positionId)).toEqual(["pos-9"]);
  });
});
