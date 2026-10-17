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
import { AGENT_POLICY, AGENT_STEP } from "../../../../src/engine/agent/constants";
import { drawdownBreached, riskSnapshotFrom } from "../../../../src/engine/agent/risk";
import { codeToxicity } from "../../../../src/engine/agent/policy";
import type {
  AgentPositionTag,
  AgentRiskSnapshot,
  AgentSettings,
  AgentTradeRecord,
  DecisionRecord,
  ExecutionRecord,
  IndexSnapshot,
  ReflexBatch,
  ReflexInput,
  SubmitBarResult,
} from "../../../../src/engine/agent/types";
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
import type { MarketSnapshot, OptionContract, Order, Position, TradeRecord, TradingMode } from "../../../../src/engine/types";
import { AGENT_NO_MARKET, AgentRunner, HOT_KEY, agentQuoteSource, agentStepBudgetMs, killAll, type AgentDoPort, type AgentHot, type AgentResult, type AgentRunnerOptions, type KillStep } from "./agentRunner";

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

/**
 * The AgentDO as the runner sees it: each answer can be replaced; it keeps each bar once, like the real one, and answers
 * a resubmitted bar as a duplicate with the snapshots it stored.
 */
class FakeAgentDo implements AgentDoPort {
  stored = new Map<number, ReflexInput["snapshots"]>();
  submits: ReflexInput[] = [];
  takes: number[] = [];
  records: ExecutionRecord[] = [];
  batches: ReflexBatch[] = [];
  submit: (input: ReflexInput) => Promise<SubmitBarResult> = async (input) => this.store(input);
  take: (afterBarMs: number) => Promise<ReflexBatch | null> = async (after) => this.batches.filter((b) => b.barCloseMs > after).at(-1) ?? null;
  record: (rec: ExecutionRecord) => Promise<void> = async () => {};

  store(input: ReflexInput): SubmitBarResult {
    const kept = this.stored.get(input.barCloseMs);
    if (kept) return { accepted: true, reason: "duplicate", snapshots: structuredClone(kept) };
    this.stored.set(input.barCloseMs, structuredClone(input.snapshots));
    return { accepted: true, reason: null };
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

function setup(
  o: {
    settings?: Partial<AgentSettings>;
    agentDo?: FakeAgentDo;
    clock?: Clock;
    repo?: (r: Repository) => Repository;
    quotes?: OptionQuoteSource | null;
    hot?: Partial<AgentHot>;
    /** Main's repository and TE's storage, to share them between two runners (a restart). */
    base?: InMemoryRepository;
    kept?: Map<string, unknown>;
    /** True: this put to TE's storage fails. */
    failPut?: () => boolean;
    /** The MarketFeedDO's option flow (default: none). */
    feed?: AgentRunnerOptions["feed"];
    /** How long each Telegram alert takes to send (default: at once). */
    alertMs?: number;
  } = {},
) {
  const clock = o.clock ?? new FixedClock(T0);
  const base = o.base ?? new InMemoryRepository(cfg, T0);
  const scoped = accountRepository(base, "agent", agentCfg, () => clock.now());
  const agentRepo = o.repo ? o.repo(scoped) : scoped;
  const kept = o.kept ?? new Map<string, unknown>();
  if (o.hot) kept.set(HOT_KEY, structuredClone(o.hot));
  const agentDo = o.agentDo ?? new FakeAgentDo();
  const alerts: string[] = [];
  /** Each alert's send, from its start to its end. */
  const sends: { text: string; from: number; to: number }[] = [];
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
        if (o.failPut?.()) throw new Error("storage put failed (transient)");
        kept.set(key, structuredClone(value));
      },
    },
    agentDo,
    feed: o.feed ?? { getOptionFlowAsOf: async () => null },
    quotes: o.quotes === undefined ? QUOTES : o.quotes,
    instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
    marketContext,
    alerts: {
      send: async (text) => {
        alerts.push(text);
        const from = Date.now();
        if (o.alertMs) await sleep(o.alertMs);
        sends.push({ text, from, to: Date.now() });
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
  return { runner, clock: clock as FixedClock, base, agentRepo, agentDo, alerts, sends, hot };
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

  it("records a batch taken more than 4 minutes after its close as not executed, its exit-only decisions too", async () => {
    const h = setup();
    const old = BAR - 5 * 60_000;
    h.agentDo.batches = [batch({ barCloseMs: old, exitOnly: [decision({ id: "x-esc", barCloseMs: old, source: "ESCALATION", effective: false })] })];
    await h.runner.step(report(), calendar, false, LATER);
    expect(executeAgentBatch).not.toHaveBeenCalled();
    const [rec] = h.agentDo.records;
    expect(rec.barCloseMs).toBe(old);
    expect(rec.decisions.map((d) => [d.decisionId, d.execution.action])).toEqual([
      [`d-${old}`, "NOT_EXECUTED"],
      ["x-esc", "NOT_EXECUTED"],
    ]);
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
    expect([...agentDo.stored.keys()]).toEqual([BAR]);
    expect(h.hot().lastSubmittedBarMs).toBe(BAR);
  });

  for (const firstHasOptions of [true, false]) {
    it(`gives the code gate the copy of a resubmitted bar that the AgentDO stored (the first, ${firstHasOptions ? "with" : "without"} its option block)`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        vi.setSystemTime(T0);
        const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
        // The second copy's flow read went the other way, so only one of the two has the option block.
        const withBlock = { c: 25_000, o: { oa: 30, cs: 0.6, ps: 0.7 } } as unknown as IndexSnapshot;
        const withoutBlock = { c: 25_000, o: null } as unknown as IndexSnapshot;
        const copies = firstHasOptions ? [withBlock, withoutBlock] : [withoutBlock, withBlock];
        let built = 0;
        vi.mocked(buildReflexInput).mockImplementation((a) => ({ barCloseMs: a.barCloseMs, date: istDate(a.barCloseMs), builtMs: a.nowMs, snapshots: { NIFTY: copies[built++] }, tokensEst: {}, closes: { NIFTY: 25_000 }, problems: [] }));
        vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
        const agentDo = new FakeAgentDo();
        let first = true;
        agentDo.submit = async (input) => {
          const answer = agentDo.store(input);
          if (first) {
            first = false;
            await sleep(2_500); // past the runner's 2 s: the AgentDO stored the first copy all the same
          }
          return answer;
        };
        const h = setup({ clock, agentDo });
        const step = async () => {
          const running = h.runner.step(report({ t: Date.now() }), calendar, false, Date.now() + AGENT_STEP.maxMs);
          await vi.advanceTimersByTimeAsync(5_000);
          await running;
        };
        await step();
        expect(h.hot().lastSubmittedBarMs).toBe(istMidnight(DAY));
        await step();
        expect(agentDo.submits.map((i) => i.snapshots.NIFTY)).toEqual(copies);
        expect(h.hot().lastSubmittedBarMs).toBe(BAR);
        // The batch the model made from the stored copy is gated on that copy, not on the one resubmitted.
        expect(h.hot().inputs).toEqual([{ barCloseMs: BAR, snapshots: { NIFTY: copies[0] } }]);
        agentDo.batches = [batch()];
        await step();
        const gated = vi.mocked(executeAgentBatch).mock.calls[0][2].snapshots.NIFTY ?? null;
        expect(gated).toEqual(copies[0]);
        expect(codeToxicity(gated, "LONG")).toEqual(codeToxicity(copies[0], "LONG"));
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("keeps no snapshots for a bar the AgentDO refused, and empty ones for a duplicate it sent none with", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const refused = new FakeAgentDo();
    refused.submit = async () => ({ accepted: false, reason: "paused: the operator paused the agent" });
    const r = setup({ agentDo: refused });
    await r.runner.step(report(), calendar, false, LATER);
    expect(r.hot()).toMatchObject({ lastSubmittedBarMs: BAR, inputs: [] });

    // A duplicate that names no stored snapshots: the gate gets none, so it blocks the bar's entries (exits still run).
    const bare = new FakeAgentDo();
    bare.submit = async () => ({ accepted: true, reason: "duplicate" });
    const b = setup({ agentDo: bare });
    await b.runner.step(report(), calendar, false, LATER);
    expect(b.hot().inputs).toEqual([{ barCloseMs: BAR, snapshots: {} }]);
  });

  it("gates a batch on the snapshots it comes with, the ones the model judged; without them (an older AgentDO) on its own copy", async () => {
    const judged = { c: 25_000, o: { oa: 30, cs: 0.6, ps: 0.7 } } as unknown as IndexSnapshot;
    const kept = { date: DAY, inputs: [{ barCloseMs: BAR, snapshots: { NIFTY: SNAP } }] };
    const h = setup({ hot: kept });
    h.agentDo.batches = [batch({ snapshots: { NIFTY: judged } })];
    await h.runner.step(report(), calendar, false, LATER);
    expect(vi.mocked(executeAgentBatch).mock.calls[0][2].snapshots).toEqual({ NIFTY: judged });
    // Empty when the AgentDO stored none for the bar: the model judged none either.
    const none = setup({ hot: kept });
    none.agentDo.batches = [batch({ snapshots: {} })];
    await none.runner.step(report(), calendar, false, LATER);
    expect(vi.mocked(executeAgentBatch).mock.calls[1][2].snapshots).toEqual({});
    const old = setup({ hot: kept });
    old.agentDo.batches = [batch()];
    await old.runner.step(report(), calendar, false, LATER);
    expect(vi.mocked(executeAgentBatch).mock.calls[2][2].snapshots).toEqual({ NIFTY: SNAP });
  });

  it("gates a batch taken before its bar's resubmission on the copy the AgentDO stored (main flat: no wait resubmits it first)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(T0);
      const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
      const withBlock = { c: 25_000, o: { oa: 30, cs: 0.6, ps: 0.7 } } as unknown as IndexSnapshot;
      vi.mocked(buildReflexInput).mockImplementation((a) => ({ barCloseMs: a.barCloseMs, date: istDate(a.barCloseMs), builtMs: a.nowMs, snapshots: { NIFTY: withBlock }, tokensEst: {}, closes: { NIFTY: 25_000 }, problems: [] }));
      vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
      const agentDo = new FakeAgentDo();
      let first = true;
      agentDo.submit = async (input) => {
        const answer = agentDo.store(input);
        if (first) {
          first = false;
          await sleep(2_500); // past the runner's 2 s: the AgentDO stored the bar all the same
        }
        return answer;
      };
      // As the AgentDO answers: a batch comes with its bar's snapshots as stored.
      agentDo.take = async (after) => {
        const b = agentDo.batches.filter((x) => x.barCloseMs > after).at(-1);
        return b ? { ...b, snapshots: structuredClone(agentDo.stored.get(b.barCloseMs) ?? {}) } : null;
      };
      const h = setup({ clock, agentDo });
      const step = async () => {
        const running = h.runner.step(report({ t: Date.now() }), calendar, false, Date.now() + AGENT_STEP.maxMs);
        await vi.advanceTimersByTimeAsync(5_000);
        await running;
      };
      await step();
      expect(h.hot()).toMatchObject({ lastSubmittedBarMs: istMidnight(DAY), inputs: [] });
      // The AgentDO's alarm judged the stored copy; the next step takes the batch before it resubmits the bar.
      agentDo.batches = [batch()];
      await vi.advanceTimersByTimeAsync(25_000);
      await step();
      expect(executeAgentBatch).toHaveBeenCalledTimes(1);
      const gated = vi.mocked(executeAgentBatch).mock.calls[0][2].snapshots.NIFTY ?? null;
      expect(gated).toEqual(withBlock);
      expect(codeToxicity(gated, "LONG")).toEqual(codeToxicity(withBlock, "LONG"));
      expect(agentDo.submits).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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
    // The halt as it stands once latched: its kill switch on.
    await h.agentRepo.settings.update({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" }, "engine");
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
    // The AgentDO is away, so the record stays in the outbox (a paused agent still sends its records when it can).
    h.agentDo.record = async () => {
      throw new Error("AgentDO restarting");
    };
    await h.runner.step(report(), calendar, false, LATER);
    const hot = h.hot();
    expect(hot).toMatchObject({ date: DAY, lastSubmittedBarMs: istMidnight(DAY), lastExecutedBarMs: istMidnight(DAY), peakEquity: 510_000, ddHalt: true, paused: true, sentTrades: [] });
    expect(hot.books.map((b) => b.t)).toEqual([T0]);
    expect(hot.outbox).toHaveLength(1);
    expect(hot.outbox[0].barCloseMs).toBe(istAt("2026-10-16", "15:05"));
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

/** Earlier losses: today starts at ₹4,20,000 against a ₹5,00,000 peak (16%, past the 15% limit). */
async function seedDrawdown(repo: Repository, realized = -80_000): Promise<void> {
  await repo.ledger.save({ date: "2026-10-16", mode: "PAPER", realized, unrealized: 0, charges: 0, trades: 4, wins: 0, losses: 4, consecutiveLosses: 4, ordersPlaced: 8, maxIntradayDrawdown: -realized, peakEquity: 500_000, startEquity: 500_000, updatedMs: T0 - 3 * 86_400_000 });
}

const killRows = async (repo: Repository) => (await repo.audit.recent(50)).filter((a) => a.action === "kill");
const haltAlerts = (alerts: string[]) => alerts.filter((a) => /from its peak equity/.test(a));

describe("the drawdown halt acts first, latches last and is checked again on every step", () => {
  it("a TE storage write that fails at the breach: the halt's actions are done already, and nothing is lost on the next step", async () => {
    let failNext = true;
    const h = setup({ hot: { date: DAY, peakEquity: 500_000 }, failPut: () => (failNext ? ((failNext = false), true) : false) });
    await seedDrawdown(h.agentRepo);
    await h.agentRepo.positions.save(position());
    await h.runner.step(report(), calendar, false, LATER);
    // The latch is the last write of the halt: it failed, so the step counts as failed...
    expect(h.runner.errors).toBe(1);
    // ...but the kill switch, the audit row, the alert and the exit at market were already done.
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" });
    expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 30_000);
    expect(h.runner.errors).toBe(0);
    expect(h.hot().ddHalt).toBe(true);
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(true);
    expect(await killRows(h.base)).toHaveLength(1);
    expect(haltAlerts(h.alerts)).toHaveLength(1);
  });

  it("a kill-switch write that fails at the breach: the next step does all of it, also after TE restarted", async () => {
    const base = new InMemoryRepository(cfg, T0);
    const kept = new Map<string, unknown>([[HOT_KEY, { date: DAY, peakEquity: 500_000 }]]);
    const clock = new FixedClock(T0);
    let failNext = true;
    const failingSettings = (r: Repository): Repository => ({
      ...r,
      settings: {
        get: () => r.settings.get(),
        update: async (patch, by) => {
          if (failNext) {
            failNext = false;
            throw new Error("D1_ERROR: transient");
          }
          return r.settings.update(patch, by);
        },
      },
    });
    const first = setup({ base, kept, clock, repo: failingSettings });
    await seedDrawdown(first.agentRepo);
    await first.agentRepo.positions.save(position());
    await first.runner.step(report(), calendar, false, LATER);
    expect(first.runner.errors).toBe(1);
    // Nothing latched: the halt is not on record yet.
    expect(first.hot().ddHalt ?? false).toBe(false);
    expect((await first.agentRepo.settings.get()).killSwitch).toBe(false);

    // TE restarted: a new runner on the same storage and book.
    const second = setup({ base, kept, clock });
    for (let k = 1; k <= 4; k++) {
      clock.set(T0 + k * 30_000);
      await second.runner.step(report({ t: clock.now() }), calendar, false, clock.now() + 60_000);
    }
    expect(second.hot().ddHalt).toBe(true);
    expect(await second.agentRepo.settings.get()).toMatchObject({ killSwitch: true });
    expect(await second.agentRepo.positions.open("PAPER")).toEqual([]);
    expect(await second.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(await killRows(base)).toHaveLength(1);
    expect(haltAlerts(second.alerts)).toHaveLength(1);
  });

  it("once latched, a kill switch that went off is put back on and the exits run again", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000, ddHalt: true } });
    await seedDrawdown(h.agentRepo);
    await h.agentRepo.positions.save(position());
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(false);
    await h.runner.step(report(), calendar, false, LATER);
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" });
    expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    // The halt was on record already: no second audit row or alert.
    expect(await killRows(h.base)).toEqual([]);
    expect(haltAlerts(h.alerts)).toEqual([]);
  });
});

describe("the runner and main's market data", () => {
  it("gives every batch a market source that refuses reads: the agent never reads main's", async () => {
    const h = setup();
    h.agentDo.batches = [batch()];
    await h.runner.step(report(), calendar, false, LATER);
    const [deps] = vi.mocked(executeAgentBatch).mock.calls[0];
    expect(deps.market).toBe(AGENT_NO_MARKET);
    expect(h.runner.deps().market).toBe(AGENT_NO_MARKET);
    await expect(deps.market.snapshot(T0)).rejects.toThrow("the agent never reads main's market data source");
  });
});

describe("the operator's pause and a running batch", () => {
  it("passes the pause to the batch, read live: a pause set while the batch runs reaches its order checks", async () => {
    const h = setup();
    h.agentDo.batches = [batch()];
    const seen: (boolean | null)[] = [];
    vi.mocked(executeAgentBatch).mockImplementationOnce(async (_deps, b, x) => {
      const paused = x.paused;
      seen.push(paused ? paused() : null);
      // /ops/agent-pause arrives while the batch is pricing its entry.
      await h.runner.setPaused(true, "ops");
      seen.push(paused ? paused() : null);
      return { barCloseMs: b.barCloseMs, t: x.nowMs, decisions: [], exits: [], trades: [], risk: risk(x.nowMs) };
    });
    await h.runner.step(report(), calendar, false, LATER);
    expect(seen).toEqual([false, true]);
  });
});

describe("the book's time", () => {
  it("is stamped after its positions are read: a fill after a bar's close never reaches that bar's book", async () => {
    // A step that starts 2 s before the 10:05 close; its exit pass is slow and ends 1 s after the close.
    const close = BAR + 300_000;
    const clock = new FixedClock(close - 2_000);
    const h = setup({ clock });
    await h.agentRepo.positions.save(position());
    vi.mocked(agentPositionPass).mockImplementationOnce(async (deps) => {
      clock.set(close + 1_000);
      return runPositionCycle(deps, {});
    });
    await h.runner.step(report({ t: close - 2_000 }), calendar, false, close + 60_000);
    const book = h.hot().books.at(-1)!;
    expect(book.t).toBe(close + 1_000);
    // bookAsOf for the 10:05 bar picks the newest book at or before its close: never this one.
    expect(book.t).toBeGreaterThan(close);
  });

  it("is never older than the marks it carries when the clock moves on every read (as Date.now does in a Worker)", async () => {
    let t = T0;
    const clock: Clock = { now: () => ++t, sleep: async () => {} };
    const h = setup({ clock });
    await h.agentRepo.positions.save(position({ markMs: T0 - 60_000 }));
    let readAt = 0;
    const open = h.agentRepo.positions.open.bind(h.agentRepo.positions);
    h.agentRepo.positions.open = async (mode) => {
      const rows = await open(mode);
      readAt = t;
      return rows;
    };
    await h.runner.step(report(), calendar, false, T0 + 60_000);
    const book = h.hot().books.at(-1)!;
    // The exits re-marked the position during this step; the book is stamped after its positions were read.
    expect(book.positions).toHaveLength(1);
    expect(book.positions[0].markMs).toBeGreaterThan(T0);
    expect(book.positions[0].markMs).toBeLessThanOrEqual(book.t);
    expect(book.t).toBeGreaterThanOrEqual(readAt);
  });
});

describe("a paper entry that rests before it fills", () => {
  const TAG: AgentPositionTag = { finalistId: "gen:NIFTY", decisionId: "d-entry", index: "NIFTY", side: "LONG" };
  /** The entry as submitEntry leaves it while it rests: a buy limit under the ask, no fill yet, its position id reserved. */
  const resting = (positionId: string): Order => ({
    id: `ord-${positionId}`,
    refId: `REF${positionId}`,
    contract: CONTRACT,
    side: "BUY",
    qty: 65,
    type: "LIMIT",
    limitPrice: 99,
    product: agentCfg.broker.product,
    reason: "ENTRY",
    planId: `plan-${positionId}`,
    positionId,
    status: "OPEN",
    filledQty: 0,
    createdMs: T0 - 5_000,
    updatedMs: T0 - 5_000,
    mode: "PAPER",
  });

  it("keeps its tag while the order rests, so the model's exit applies once it has filled", async () => {
    const real = await vi.importActual<typeof import("../../../../src/engine/agent/agentCycle")>("../../../../src/engine/agent/agentCycle");
    const h = setup({ hot: { date: DAY, positions: { "pos-r": TAG } } });
    await h.agentRepo.orders.save(resting("pos-r"));
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.hot().positions).toEqual({ "pos-r": TAG });

    // It fills; the next batch calls a CRISIS on NIFTY, which closes the agent's NIFTY position at market.
    await h.agentRepo.orders.save({ ...resting("pos-r"), status: "FILLED", filledQty: 65, avgFillPrice: 99, updatedMs: T0 + 10_000 });
    await h.agentRepo.positions.save(position({ id: "pos-r", planId: "plan-pos-r", avgEntry: 99, markPremium: 99, entryMs: T0 + 10_000 }));
    h.agentDo.batches = [batch({ decisions: [decision({ id: "d-crisis", regime: "CRISIS", direction: "NEUTRAL" })] })];
    vi.mocked(executeAgentBatch).mockImplementationOnce(real.executeAgentBatch);
    h.clock.advance(20_000);
    await h.runner.step(report({ t: T0 + 20_000 }), calendar, false, LATER + 20_000);
    expect(h.agentDo.records.at(-1)?.exits).toEqual([{ positionId: "pos-r", decisionId: "d-crisis", reason: "AGENT_CRISIS", status: "FILLED" }]);
    expect(await h.agentRepo.positions.get("pos-r")).toMatchObject({ status: "CLOSED", exitReason: "SIGNAL_FLIP" });
    // Closed and no order left: the tag goes at that step's book.
    expect(h.hot().positions).toEqual({});
  });

  it("drops the tag once the order is cancelled unfilled", async () => {
    const h = setup({ hot: { date: DAY, positions: { "pos-c": TAG } } });
    await h.agentRepo.orders.save(resting("pos-c"));
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.hot().positions).toEqual({ "pos-c": TAG });
    // Past the chase timeout the code exits cancel the entry, never filled: no position and no open order, so no tag.
    h.clock.advance(agentCfg.broker.limitChaseTimeoutSec * 1_000);
    await h.runner.step(report({ t: h.clock.now() }), calendar, false, h.clock.now() + 60_000);
    expect((await h.agentRepo.orders.get("ord-pos-c"))?.status).toBe("CANCELLED");
    expect(h.hot().positions).toEqual({});
  });
});

/** A repository whose every call takes `lat` ms of the clock (a D1 round trip); calls sent together overlap. */
function slowRepo<T extends object>(target: T, clock: FixedClock, lat: number): T {
  return new Proxy(target, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const start = clock.now();
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          if (out && typeof (out as Promise<unknown>).then === "function") {
            return (out as Promise<unknown>).then((x) => {
              clock.set(Math.max(clock.now(), start + lat));
              return x;
            });
          }
          return out;
        };
      }
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) return slowRepo(v as object, clock, lat);
      return v;
    },
  });
}

describe("the bar while main is positioned (the agent's step gets its 4 s floor)", () => {
  it("is still submitted on the first tick at 60 ms a D1 round trip, 100 ms an AgentDO call and 300 ms a flow read", async () => {
    const tick0 = BAR + 30_000;
    const clock = new FixedClock(tick0);
    const base = slowRepo(new InMemoryRepository(cfg, tick0) as unknown as Repository, clock, 60);
    const scoped = accountRepository(base, "agent", agentCfg, () => clock.now());
    const kept = new Map<string, unknown>();
    const submits: number[] = [];
    const marketContext = new MarketContextStore();
    marketContext.set("NIFTY", { spot: 25_000, vix: 13, t: tick0 });
    marketContext.set("SENSEX", { spot: 82_000, vix: 13, t: tick0 });
    const runner = new AgentRunner({
      account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo: scoped },
      mainRepo: base,
      settings: { ...SETTINGS, mode: "shadow" },
      storage: { get: async <T,>(k: string) => (kept.has(k) ? (structuredClone(kept.get(k)) as T) : undefined), put: async <T,>(k: string, v: T) => void kept.set(k, structuredClone(v)) },
      agentDo: {
        submitBar: async (input) => {
          clock.advance(100);
          submits.push(input.barCloseMs);
          return { accepted: true, reason: null };
        },
        takeDecisions: async () => {
          clock.advance(100);
          return null;
        },
        recordExecution: async () => {
          clock.advance(100);
        },
      },
      feed: {
        getOptionFlowAsOf: async () => {
          const start = clock.now();
          await Promise.resolve();
          clock.set(Math.max(clock.now(), start + 300));
          return null;
        },
      },
      quotes: null,
      instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
      marketContext,
      alerts: { send: async () => true },
      logger: silentLogger,
      calendar,
      clock,
      newId: sequentialIds("ag"),
    });
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    // Main holds a position: its cycle and two 10 s exit polls bring TE to 24 s past the tick's start.
    clock.set(tick0 + 24_000);
    const budget = agentStepBudgetMs(tick0, clock.now());
    expect(budget).toBe(AGENT_STEP.minMs);
    await runner.step(report({ t: clock.now() }), calendar, false, clock.now() + budget);
    expect(submits).toEqual([BAR]);
  });
});

describe("the risk the AgentDO keeps", () => {
  it("is sent while paused too, at most once a minute", async () => {
    const h = setup();
    await h.runner.setPaused(true, "ops");
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.agentDo.records.map((r) => [r.decisions.length, r.risk.t])).toEqual([[0, T0]]);
    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 30_000);
    expect(h.agentDo.records).toHaveLength(1);
    h.clock.advance(30_000);
    await h.runner.step(report(), calendar, false, LATER + 60_000);
    expect(h.agentDo.records).toHaveLength(2);
    expect(h.agentDo.takes).toEqual([]);
  });

  it("drops the halt at once after a re-arm, also in the evening when no step runs", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000, ddHalt: true } });
    await seedDrawdown(h.agentRepo);
    await h.agentRepo.settings.update({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" }, "engine");
    h.clock.set(istAt(DAY, "18:30"));
    const res = await h.runner.rearm("dashboard");
    expect(res).toEqual({ ok: true, message: "Agent re-armed: kill switch off; peak equity restarts at ₹420000" });
    const latest = h.agentDo.records.at(-1)!;
    expect(latest).toMatchObject({ t: istAt(DAY, "18:30"), decisions: [], exits: [], trades: [] });
    expect(latest.risk).toMatchObject({ t: istAt(DAY, "18:30"), ddHalt: false, killSwitch: false, killReason: null, peakEquity: 420_000, equity: 420_000, ddPct: 0 });
    expect(h.hot().lastRisk).toEqual(latest.risk);
  });

  it("re-arms even when the AgentDO does not answer; the next step's risk row corrects the page", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000, ddHalt: true } });
    await seedDrawdown(h.agentRepo);
    h.agentDo.record = async () => {
      throw new Error("AgentDO restarting");
    };
    expect((await h.runner.rearm("dashboard")).ok).toBe(true);
    expect(h.hot()).toMatchObject({ ddHalt: false, peakEquity: 420_000 });
    expect(h.hot().lastRisk).toMatchObject({ ddHalt: false, killSwitch: false });
  });
});

describe("clearing the kill switch without a halt", () => {
  it("keeps measuring the drawdown from the old peak", async () => {
    // 12% down from the peak, and the agent's kill switch on (main's was engaged and reset earlier).
    const h = setup({ hot: { date: DAY, peakEquity: 500_000, ddHalt: false } });
    await seedDrawdown(h.agentRepo, -60_000);
    await h.agentRepo.settings.update({ killSwitch: true, killReason: "main kill switch engaged at 10:00" }, "engine");
    const res = await h.runner.rearm("dashboard");
    expect(res).toEqual({ ok: true, message: "Agent re-armed: kill switch off; drawdown still measured from ₹500000" });
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(false);
    expect(h.hot().peakEquity).toBe(500_000);
    expect(h.agentDo.records.at(-1)!.risk).toMatchObject({ peakEquity: 500_000, equity: 440_000, ddPct: 12, ddHalt: false, killSwitch: false });
    expect(h.alerts).toContain("🤖 Agent (paper experiment): ✅ kill switch cleared by dashboard; drawdown still measured from ₹500000");
  });
});

describe("Telegram's words for the model's orders", () => {
  it("names the model's call and the option bought, and an exit's contract and plain reason", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position({ id: "pos-1" }));
    h.agentDo.batches = [
      batch({
        decisions: [
          decision({ id: "d-long", direction: "LONG", directionConfidence: 0.85, setupQuality: 3, finalistId: "gen:NIFTY" }),
          decision({ id: "d-short", index: "SENSEX", direction: "SHORT", directionConfidence: 0.82, setupQuality: 2, finalistId: "gen:SENSEX" }),
        ],
      }),
    ];
    vi.mocked(executeAgentBatch).mockImplementationOnce(async (_deps, b, x) => {
      const exec = (action: "ENTERED" | "ENTRY_PENDING", sym: string, lots: number) => ({
        t: x.nowMs,
        gate: { fired: true, lines: [], codeToxic: [], codeRisk: "SAFE" as const, effectiveRisk: "SAFE" as const },
        action,
        detail: "test",
        planId: "p",
        positionId: null,
        tradingSymbol: sym,
        edge: null,
        sizing: { p: 0.6, b: 1, kelly: 0.2, quarterKelly: 0.05, riskPct: 1, lots, riskRupees: 5_000, limitedBy: "the 1% cap" },
      });
      return {
        barCloseMs: b.barCloseMs,
        t: x.nowMs,
        decisions: [
          { decisionId: "d-long", execution: exec("ENTERED", "NIFTY26O2725100CE", 2) },
          { decisionId: "d-short", execution: exec("ENTRY_PENDING", "SENSEX26O2382000PE", 1) },
        ],
        exits: [{ positionId: "pos-1", decisionId: "d-long", reason: "AGENT_REDUCE" as const, status: "FILLED" }],
        trades: [],
        risk: risk(x.nowMs),
      };
    });
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.alerts).toEqual([
      "🤖 Agent (paper experiment): ENTRY NIFTY26O2725100CE 2 lots (filled) on the model's Up call (bought a call): confidence 0.85, setup 3, gen:NIFTY",
      "🤖 Agent (paper experiment): ENTRY SENSEX26O2382000PE 1 lot (order sent) on the model's Down call (bought a put): confidence 0.82, setup 2, gen:SENSEX",
      "🤖 Agent (paper experiment): EXIT NIFTY26O2725000CE on the model's call: the model asked to cut risk (filled)",
    ]);
  });
});

describe("AgentRunner.pollStep: the step but its decisions, inside main's exit-poll waits", () => {
  const WAIT_END = T0 + 10_000;

  it("runs the exits, the risk row, the book and the latest closed bar by the wait's end, and never takes decisions", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position());
    h.agentDo.batches = [batch()];
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    await h.runner.pollStep(report(), calendar, WAIT_END);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(h.agentDo.takes).toEqual([]);
    expect(executeAgentBatch).not.toHaveBeenCalled();
    expect(h.agentDo.records.map((r) => [r.decisions.length, r.risk.t])).toEqual([[0, T0]]);
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);
    expect(h.hot()).toMatchObject({ lastSubmittedBarMs: BAR, lastExecutedBarMs: istMidnight(DAY) });
    expect(h.hot().books.map((b) => b.t)).toEqual([T0]);

    // The step after it takes the decisions; the bar is not submitted again.
    h.clock.advance(20_000);
    await h.runner.step(report({ t: T0 + 20_000 }), calendar, false, LATER + 20_000);
    expect(h.agentDo.takes).toEqual([istMidnight(DAY)]);
    expect(executeAgentBatch).toHaveBeenCalledTimes(1);
    expect(h.agentDo.submits).toHaveLength(1);
  });

  it("halts at the drawdown limit within the wait: kill switch, flattened at market, latched, and the AgentDO told", async () => {
    const h = setup({ hot: { date: DAY, peakEquity: 500_000 } });
    await seedDrawdown(h.agentRepo);
    await h.agentRepo.positions.save(position());
    await h.runner.pollStep(report(), calendar, WAIT_END);
    expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" });
    expect(h.hot().ddHalt).toBe(true);
    expect(await killRows(h.base)).toHaveLength(1);
    expect(haltAlerts(h.alerts)).toHaveLength(1);
    // The risk row carries the halt and the closed trade, so the Agent page shows them without waiting for a step.
    const rec = h.agentDo.records.at(-1)!;
    expect(rec.risk).toMatchObject({ ddHalt: true, killSwitch: true });
    expect(rec.trades.map((t) => t.positionId)).toEqual(["pos-1"]);
  });

  it("while paused, and in mode off, still checks the drawdown and runs the exits, but submits no bar", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    for (const h of [setup({ hot: { date: DAY, peakEquity: 500_000, paused: true } }), setup({ settings: { mode: "off" }, hot: { date: DAY, peakEquity: 500_000 } })]) {
      await seedDrawdown(h.agentRepo);
      await h.agentRepo.positions.save(position());
      await h.runner.pollStep(report(), calendar, WAIT_END);
      expect(h.hot().ddHalt).toBe(true);
      expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
      expect(h.agentDo.submits).toEqual([]);
      expect(h.agentDo.takes).toEqual([]);
    }
  });

  it("once a kill pre-empts it, starts nothing after the part it is in; the next wait does the rest", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    // Pre-empted during its code exits: no drawdown check, no risk row, no book, no bar.
    const h = setup({ hot: { date: DAY, peakEquity: 500_000 } });
    await seedDrawdown(h.agentRepo);
    await h.agentRepo.positions.save(position());
    await h.runner.pollStep(report(), calendar, WAIT_END, () => true);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(h.hot().ddHalt ?? false).toBe(false);
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(false);
    expect((await h.agentRepo.positions.get("pos-1"))?.status).toBe("OPEN");
    expect(h.agentDo.records).toEqual([]);
    expect(h.agentDo.submits).toEqual([]);
    h.clock.advance(10_000);
    await h.runner.pollStep(report(), calendar, WAIT_END + 10_000);
    expect(h.hot().ddHalt).toBe(true);
    expect(await h.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);

    // Pre-empted during its drawdown check (at the halt's alert): the halt finishes and latches; nothing comes after it.
    const mid = setup({ hot: { date: DAY, peakEquity: 500_000 } });
    await seedDrawdown(mid.agentRepo);
    await mid.agentRepo.positions.save(position());
    await mid.runner.pollStep(report(), calendar, WAIT_END, () => mid.alerts.length > 0);
    expect(mid.hot().ddHalt).toBe(true);
    expect(await mid.agentRepo.positions.get("pos-1")).toMatchObject({ status: "CLOSED", exitReason: "KILL_SWITCH" });
    expect(mid.agentDo.records).toEqual([]);
    expect(mid.agentDo.submits).toEqual([]);
  });

  it("is bounded by the wait's end: a bar needs 2.5 s of it, and after it nothing more starts", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const short = setup();
    await short.runner.pollStep(report(), calendar, T0 + 2_400);
    // The risk row fits (2 s); the bar does not, so it stays unsent for the step or the next wait.
    expect(short.agentDo.records).toHaveLength(1);
    expect(short.agentDo.submits).toEqual([]);
    expect(short.hot().lastSubmittedBarMs).toBe(istMidnight(DAY));

    const over = setup({ hot: { date: DAY, peakEquity: 500_000 } });
    await seedDrawdown(over.agentRepo);
    await over.agentRepo.positions.save(position());
    await over.runner.pollStep(report(), calendar, T0 - 1);
    expect(agentPositionPass).toHaveBeenCalled();
    expect(over.hot().ddHalt ?? false).toBe(false);
    expect(over.agentDo.records).toEqual([]);
    expect(over.agentDo.submits).toEqual([]);
  });

  it("before the open runs only the code exits", async () => {
    const h = setup();
    await h.agentRepo.positions.save(position());
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    await h.runner.pollStep(report({ phase: "PRE_OPEN" }), calendar, WAIT_END);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(h.agentDo.takes).toEqual([]);
    expect(h.agentDo.records).toEqual([]);
    expect(h.agentDo.submits).toEqual([]);
  });
});

describe("a step that a kill pre-empts (TE's stopped())", () => {
  const TAG: AgentPositionTag = { finalistId: "gen:NIFTY", decisionId: "d-entry", index: "NIFTY", side: "LONG" };

  it("from its start: its kill coupling and code exits run; it takes no batch and sends no record or bar; the next step does", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const h = setup();
    await h.agentRepo.positions.save(position());
    await h.base.settings.update({ killSwitch: true, killReason: "operator" }, "tester");
    h.agentDo.batches = [batch()];
    await h.runner.step(report(), calendar, false, LATER, () => true);
    expect((await h.agentRepo.settings.get()).killSwitch).toBe(true);
    expect(agentPositionPass).toHaveBeenCalledTimes(1);
    expect(h.agentDo.takes).toEqual([]);
    expect(executeAgentBatch).not.toHaveBeenCalled();
    expect(h.agentDo.records).toEqual([]);
    expect(h.agentDo.submits).toEqual([]);
    expect(h.hot()).toMatchObject({ lastExecutedBarMs: istMidnight(DAY), lastSubmittedBarMs: istMidnight(DAY) });

    h.clock.advance(30_000);
    await h.runner.step(report({ t: T0 + 30_000 }), calendar, false, LATER + 30_000);
    expect(h.agentDo.takes).toEqual([istMidnight(DAY)]);
    expect(executeAgentBatch).toHaveBeenCalledTimes(1);
    expect(h.agentDo.records).toHaveLength(1);
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);
  });

  it("once its batch is on its way: the model's exit is not sent, the record waits in the outbox and no bar goes", async () => {
    const real = await vi.importActual<typeof import("../../../../src/engine/agent/agentCycle")>("../../../../src/engine/agent/agentCycle");
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const h = setup({ hot: { date: DAY, positions: { "pos-1": TAG } } });
    await h.agentRepo.positions.save(position());
    h.agentDo.batches = [batch({ decisions: [decision({ id: "d-crisis", regime: "CRISIS", direction: "NEUTRAL" })] })];
    // The kill comes in while takeDecisions is on its way.
    let killed = false;
    const take = h.agentDo.take;
    h.agentDo.take = async (after) => {
      killed = true;
      return take(after);
    };
    vi.mocked(executeAgentBatch).mockImplementationOnce(real.executeAgentBatch);
    await h.runner.step(report(), calendar, false, LATER, () => killed);
    expect(h.agentDo.takes).toEqual([istMidnight(DAY)]);
    expect(vi.mocked(executeAgentBatch).mock.calls[0][2].stopped?.()).toBe(true);
    // The position stays open for the code exits (and, after a kill of main, the agent's own kill); no exit is alerted.
    expect((await h.agentRepo.positions.get("pos-1"))?.status).toBe("OPEN");
    expect(h.alerts.filter((a) => /EXIT/.test(a))).toEqual([]);
    expect(h.agentDo.records).toEqual([]);
    expect(h.agentDo.submits).toEqual([]);
    const [rec] = h.hot().outbox;
    expect(rec.exits).toEqual([]);
    expect(rec.decisions.map((d) => d.execution.action)).toEqual(["NOT_EXECUTED"]);
    expect(rec.decisions[0].execution.detail).toMatch(/^AGENT_CRISIS for NIFTY26O2725000CE not sent: a kill came in/);

    // The next step sends the record first, and the bar.
    h.clock.advance(30_000);
    await h.runner.step(report({ t: T0 + 30_000 }), calendar, false, LATER + 30_000);
    expect(h.agentDo.records.map((r) => r.decisions.length)).toEqual([1, 0]);
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);
  });
});

describe("the bar's checks just before it is sent", () => {
  it("sends no bar when the operator's pause lands while the pass reads its flow; resumed, the next pass sends it while fresh", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    let pause = async () => {};
    const h = setup({
      feed: {
        getOptionFlowAsOf: async () => {
          await pause();
          return null;
        },
      },
    });
    pause = async () => void (await h.runner.setPaused(true, "ops"));
    await h.runner.pollStep(report(), calendar, T0 + 10_000);
    expect(h.agentDo.submits).toEqual([]);
    expect(h.hot()).toMatchObject({ paused: true, lastSubmittedBarMs: istMidnight(DAY) });

    pause = async () => {};
    await h.runner.setPaused(false, "ops");
    h.clock.advance(10_000);
    await h.runner.pollStep(report({ t: T0 + 10_000 }), calendar, T0 + 20_000);
    expect(h.agentDo.submits.map((i) => i.barCloseMs)).toEqual([BAR]);
  });

  it("sends no bar when the mode reads off by the time of the send (it is read from the settings each time)", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    const settings = { ...SETTINGS };
    const h = setup({
      feed: {
        getOptionFlowAsOf: async () => {
          settings.mode = "off";
          return null;
        },
      },
    });
    (h.runner as unknown as { o: AgentRunnerOptions }).o.settings = settings;
    await h.runner.step(report(), calendar, false, LATER);
    expect(h.agentDo.submits).toEqual([]);
    expect(h.hot().lastSubmittedBarMs).toBe(istMidnight(DAY));
  });

  it("skips a bar that its flow read took past the age limit, before the send: no model call is spent on it", async () => {
    vi.mocked(latestClosedBarMs).mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
    // Fresh when the pass reaches the bar (half a second to spare); each index's flow read then takes a second.
    const clock = new FixedClock(BAR + AGENT_POLICY.maxDecisionAgeMs - 500);
    const h = setup({
      clock,
      feed: {
        getOptionFlowAsOf: async () => {
          clock.advance(1_000);
          return null;
        },
      },
    });
    await h.runner.pollStep(report({ t: clock.now() }), calendar, clock.now() + 10_000);
    expect(buildReflexInput).toHaveBeenCalledTimes(1);
    expect(h.agentDo.submits).toEqual([]);
    // Skipped for good, as a bar found too old at the start of the pass is.
    expect(h.hot().lastSubmittedBarMs).toBe(BAR);
  });
});

describe("a slow Telegram", () => {
  it("holds the agent at most a second an alert: a halt in a wait ends within it and the next step still takes its decisions; the alerts go out in order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(T0);
      const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
      // Each alert takes 10 s (sendTelegram's own timeout).
      const h = setup({ clock, alertMs: 10_000, hot: { date: DAY, peakEquity: 500_000 } });
      await seedDrawdown(h.agentRepo);
      await h.agentRepo.positions.save(position());
      h.agentDo.batches = [batch()];
      // A 10 s exit-poll wait: the drawdown halt in it alerts twice (the halt, then the exit at market).
      const waiting = h.runner.pollStep(report(), calendar, T0 + 10_000);
      // The wait, then main's 1 s of poll exits, then the step with its 4 s floor: it is not skipped for the halt's pass.
      await vi.advanceTimersByTimeAsync(11_000);
      const stepping = h.runner.step(report({ t: Date.now() }), calendar, false, Date.now() + AGENT_STEP.minMs);
      await vi.advanceTimersByTimeAsync(AGENT_STEP.minMs);
      await stepping;
      expect(h.agentDo.takes).toEqual([istMidnight(DAY)]);
      expect(executeAgentBatch).toHaveBeenCalledTimes(1);
      // The halt was done within its wait: flattened at market and latched.
      expect(h.hot().ddHalt).toBe(true);
      const [trade] = await h.base.trades.recent(5, "PAPER@agent" as TradingMode);
      expect(trade).toMatchObject({ positionId: "pos-1", exitReason: "KILL_SWITCH" });
      expect(trade.exitMs).toBeLessThanOrEqual(T0 + 10_000);
      // Every alert was sent, each after the one before it had gone out, in the order the agent raised them.
      await vi.advanceTimersByTimeAsync(30_000);
      await waiting;
      expect(h.sends.map((x) => x.text)).toEqual([expect.stringMatching(/from its peak equity/), expect.stringMatching(/EXIT NIFTY26O2725000CE KILL_SWITCH/)]);
      expect(h.sends[1].from).toBeGreaterThanOrEqual(h.sends[0].to);
    } finally {
      vi.useRealTimers();
    }
  });
});
