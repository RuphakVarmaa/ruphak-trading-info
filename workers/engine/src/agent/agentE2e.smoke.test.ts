/**
 * End-to-end smoke test of the options agent (a paper experiment; docs/AGENT.md) over a replayed day (7 Oct 2026):
 * the real AgentRunner runs inside a stand-in for TE's tick, after main's own trading and position cycles, and its
 * AgentDO port is a real in-process AgentBrain (MemoryAgentStore, a fake reflex model) whose alarm makes the model
 * call between ticks. Each bar is submitted on the tick that first sees it complete and its decisions are taken and
 * executed through the code gate on the next one. Shadow mode records SHADOW_ENTRY and buys nothing; paper mode buys
 * on the agent's own book (a seeded calibration history makes quarter Kelly size a trade); the 15% drawdown halt
 * engages the kill switch, flattens at market and stops every later entry; main's book and kv stay exactly as they
 * are without the agent.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNTS, accountConfig } from "../../../../src/engine/accounts";
import { AgentBrain } from "../../../../src/engine/agent/brain";
import { AGENT_DEFAULTS } from "../../../../src/engine/agent/config";
import { AGENT_LIMITS, AGENT_STEP } from "../../../../src/engine/agent/constants";
import type { ReflexRequest } from "../../../../src/engine/agent/judge";
import { promptFinalists } from "../../../../src/engine/agent/prompt";
import { MemoryAgentStore } from "../../../../src/engine/agent/store";
import { agentSample } from "../../../../src/engine/agent/storeContract";
import type { AgentMode, AgentSettings, DecisionRecord, ExecutionRecord, ReflexDecision, ReflexInput } from "../../../../src/engine/agent/types";
import { withAccountSettings } from "../../../../src/engine/agent/view";
import { formatHHMM, istAt, istDate, istMinutes, MINUTE_MS } from "../../../../src/engine/clock";
import { makeConfig } from "../../../../src/engine/config";
import { BAR_5M_MS } from "../../../../src/engine/market/candles";
import { runEndOfDay } from "../../../../src/engine/pipeline/dayLifecycle";
import { runPositionCycle } from "../../../../src/engine/pipeline/positionCycle";
import { loadDayLedger } from "../../../../src/engine/pipeline/riskState";
import { runTradingCycle } from "../../../../src/engine/pipeline/tradingCycle";
import { sequentialIds, silentLogger, type OptionQuoteSource, type Repository } from "../../../../src/engine/ports";
import { SyntheticOptionQuotes } from "../../../../src/engine/pricing/syntheticOptionPricer";
import { accountRepository } from "../../../../src/engine/repo/accountRepo";
import { FakeReflexJudge, fakeFlowView } from "../../../../src/engine/testing/fakeAgent";
import { loadMarketFixtures } from "../../../../src/engine/testing/fixtures";
import { createReplayDeps, type ReplayDeps } from "../../../../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type IndexId, type TradingMode } from "../../../../src/engine/types";
import { AgentRunner, HOT_KEY, type AgentDoPort, type AgentHot, type AgentRunnerOptions } from "./agentRunner";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();
// As in the isolation replay (src/engine/agent/isolation.replay.test.ts): low thresholds, so main trades on this day.
const mainCfg = makeConfig({
  indices: ["NIFTY"],
  conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0 },
  sizing: { maxTradesPerDay: 3 },
});
const agentCfg = accountConfig(mainCfg, "agent");
/**
 * TE's ticks for each bar: at 100 s the bar is complete (90 s after its close in a replay) and is submitted; the
 * AgentDO's alarm judges it; at 160 s the batch is taken and executed (fresh: under AGENT_POLICY.maxDecisionAgeMs).
 */
const TICKS_AFTER_CLOSE_MS = [100_000, 160_000];
/** Bars with a model call: 09:20 to 15:05 IST. */
const JUDGED_BARS = 70;
/** Bars submitted: 09:20 to 15:25 IST (TE's ticks for the 15:30 bar fall after the close). */
const SUBMITTED_BARS = 74;

/** The fake reflex model's script: a confident LONG on NIFTY at these bars, NEUTRAL everywhere else. */
const LONG_AT = ["10:00", "12:00", "14:00"];

function decide(req: ReflexRequest): ReflexDecision[] {
  const at = formatHHMM(istMinutes(req.input.barCloseMs));
  return promptFinalists(req.input, req.finalists).map((f): ReflexDecision => {
    const base: ReflexDecision = { finalistId: f.id, regime: "TRENDING", direction: "NEUTRAL", directionConfidence: 0.45, toxicFlow: false, setupQuality: 1, riskState: "SAFE", reason: "no clear move" };
    return f.index === "NIFTY" && LONG_AT.includes(at) ? { ...base, direction: "LONG", directionConfidence: 0.9, setupQuality: 3, reason: "higher highs above VWAP" } : base;
  });
}

/** Graded reflex history (four calls in five paid), so the sizing probability is above one half and Kelly sizes a trade. */
async function seedHistory(store: MemoryAgentStore, version: string): Promise<void> {
  const rows: DecisionRecord[] = [];
  for (let i = 0; i < 400; i++) {
    const t = istAt("2026-08-20", "09:30") + Math.floor(i / 9) * 24 * 60 * MINUTE_MS + (i % 9) * 40 * MINUTE_MS;
    rows.push(agentSample.decision({ id: `h${i}`, date: istDate(t), barCloseMs: t, instructionVersion: version, directionConfidence: 0.9, outcome: agentSample.outcome({ status: "HIT", y: 1, paid: i % 5 !== 0 }) }));
  }
  await store.putDecisions(rows);
}

/**
 * The AgentDO as TE reaches it, backed by a real AgentBrain. Arguments and answers are copied, as Durable Object RPC
 * does. alarm() is the AgentDO's alarm: the model calls run there, never inside TE's tick.
 */
class InProcessAgentDo implements AgentDoPort {
  submits: number[] = [];
  constructor(
    private readonly brain: AgentBrain,
    private readonly now: () => number,
  ) {}
  async submitBar(input: ReflexInput) {
    this.submits.push(input.barCloseMs);
    return structuredClone(await this.brain.submitBar(structuredClone(input)));
  }
  async takeDecisions(afterBarMs: number) {
    return structuredClone(await this.brain.takeDecisions(afterBarMs));
  }
  async recordExecution(rec: ExecutionRecord) {
    await this.brain.recordExecution(structuredClone(rec));
  }
  async alarm(): Promise<void> {
    const now = this.now();
    await this.brain.runDue(now, now + 10 * MINUTE_MS);
  }
}

/**
 * The runner's live quote source. A replay has no market quotes, so these are the model prices with their depth,
 * labelled as the live source's: the gate refuses a quote marked synthetic, as in production.
 */
function liveLabelled(model: OptionQuoteSource): OptionQuoteSource {
  return { kind: "upstox", quote: async (c, ctx) => ({ ...(await model.quote(c, ctx)), source: "upstox" }) };
}

/** MarketFeedDO.getOptionFlowAsOf: a chain sampled 20 s before asOfMs around the last 5-minute close at or before it. */
async function flowAsOf(index: IndexId, asOfMs: number) {
  const last = (fixtures.candles[MARKET_SYMBOLS[index]] ?? []).filter((c) => c.t + BAR_5M_MS <= asOfMs).at(-1);
  return last ? fakeFlowView(index, last.c, asOfMs - 20_000) : null;
}

interface Agent {
  store: MemoryAgentStore;
  brain: AgentBrain;
  reflex: FakeReflexJudge;
  agentDo: InProcessAgentDo;
  runner: AgentRunner;
  repo: Repository;
  alerts: string[];
  hot: () => AgentHot;
  eod: string | null;
}

interface AgentOptions {
  /** The runner's clock moves 1 ms on every read within a tick, as a Worker's Date.now() moves on after each I/O. */
  drift?: boolean;
  /** The fake reflex model's script (default: `decide`). */
  script?: (req: ReflexRequest) => ReflexDecision[];
  /** Offer the runner main's own market data source, as TE once wired it. */
  offerMainMarket?: boolean;
}

async function makeAgent(main: ReplayDeps, mode: AgentMode, o: AgentOptions = {}): Promise<Agent> {
  const settings: AgentSettings = { ...AGENT_DEFAULTS, mode };
  const store = new MemoryAgentStore();
  const reflex = new FakeReflexJudge(o.script ?? decide, { model: settings.reflexModel });
  const now = () => main.clock.now();
  let tickAt = -1;
  let reads = 0;
  const runnerNow = o.drift
    ? () => {
        if (main.clock.now() !== tickAt) [tickAt, reads] = [main.clock.now(), 0];
        return tickAt + ++reads;
      }
    : now;
  const brain = new AgentBrain({
    store,
    settings,
    reflex,
    escalation: null,
    review: null,
    advisor: async () => null,
    barsFallback: async () => [],
    calendar: main.calendar,
    cfg: agentCfg,
    now,
    newId: sequentialIds("agent-brain"),
    logger: silentLogger,
  });
  await seedHistory(store, (await brain.status()).instructionVersion);
  const agentDo = new InProcessAgentDo(brain, now);
  // The agent's own book, scoped on main's repository as in production (PAPER@agent, kv acct:agent:).
  const repo = accountRepository(main.repo, "agent", agentCfg, now);
  const kept = new Map<string, unknown>();
  const alerts: string[] = [];
  const options: AgentRunnerOptions = {
    account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo },
    mainRepo: main.repo,
    settings,
    storage: {
      get: async <T,>(key: string) => (kept.has(key) ? (structuredClone(kept.get(key)) as T) : undefined),
      put: async <T,>(key: string, value: T) => {
        kept.set(key, structuredClone(value));
      },
    },
    agentDo,
    feed: { getOptionFlowAsOf: flowAsOf },
    quotes: liveLabelled(new SyntheticOptionQuotes(main.calendar, agentCfg)),
    instruments: main.instruments,
    marketContext: main.marketContext,
    alerts: {
      send: async (text) => {
        alerts.push(text);
        return true;
      },
    },
    logger: silentLogger,
    calendar: main.calendar,
    // TE's clock; the paper broker's simulated latency must not move the replay's time.
    clock: { now: runnerNow, sleep: async () => {} },
    newId: sequentialIds("agent-run"),
  };
  // TE once handed the runner main's own market source under `market`; the runner must ignore one if it is offered.
  const runner = new AgentRunner(o.offerMainMarket ? ({ ...options, market: main.market } as AgentRunnerOptions) : options);
  return { store, brain, reflex, agentDo, runner, repo, alerts, hot: () => kept.get(HOT_KEY) as AgentHot, eod: null };
}

interface KvWrite {
  key: string;
  value: unknown;
  agent: boolean;
}

async function replay(o: { mode: AgentMode | null; beforeStep?: (t: number, a: Agent) => Promise<void>; agent?: AgentOptions }) {
  const start = istAt(DAY, "09:15");
  const main = createReplayDeps({ cfg: mainCfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  // Spies on main's kv and on the market context main writes; `inAgent` marks the agent's part of a tick.
  let inAgent = false;
  const kv: KvWrite[] = [];
  const baseSet = main.repo.state.set.bind(main.repo.state);
  main.repo.state.set = async (key, value) => {
    kv.push({ key, value: structuredClone(value), agent: inAgent });
    return baseSet(key, value);
  };
  const contextWrites: string[] = [];
  const ctxSet = main.marketContext.set.bind(main.marketContext);
  main.marketContext.set = (index, c) => {
    if (inAgent) contextWrites.push(index);
    ctxSet(index, c);
  };
  // Reads of main's market data source (its request budget and caches): main's own, and any made in the agent's part.
  const marketReads = { main: 0, agent: 0 };
  const snapshot = main.market.snapshot.bind(main.market);
  main.market.snapshot = (t: number) => {
    marketReads[inAgent ? "agent" : "main"]++;
    return snapshot(t);
  };
  const agent = o.mode ? await makeAgent(main, o.mode, o.agent) : null;
  const asAgent = async (fn: () => Promise<unknown>) => {
    inAgent = true;
    try {
      await fn();
    } finally {
      inAgent = false;
    }
  };

  for (let T = start; T <= istAt(DAY, "15:30"); T += BAR_5M_MS) {
    for (const after of TICKS_AFTER_CLOSE_MS) {
      const t = T + after;
      main.clock.set(t);
      // TE's tick: main's trading cycle, main's exits, then the agent's step under its own budget.
      const r = await runTradingCycle(main, { noEvents: true });
      await runPositionCycle(main, { convictions: r.convictions });
      if (!agent) continue;
      await asAgent(async () => {
        await o.beforeStep?.(t, agent);
        await agent.runner.step(r, main.calendar, false, t + AGENT_STEP.maxMs);
        await agent.agentDo.alarm();
      });
    }
  }
  main.clock.set(istAt(DAY, "16:00"));
  await runEndOfDay(main);
  if (agent) {
    await asAgent(async () => {
      await runEndOfDay(agent.runner.deps(), { grade: false, performance: false });
      agent.eod = await agent.runner.afterEndOfDay();
    });
  }

  const from = istAt(DAY, "09:00");
  const to = istAt(DAY, "16:00");
  const book = async (repo: Repository, mode: TradingMode) => ({
    trades: await repo.trades.between(from, to, mode),
    ledger: await repo.ledger.get(DAY, mode),
    // refId is random per order (idempotency key), so it differs between otherwise identical runs.
    orders: (await repo.orders.between(from, to, mode)).map((x) => ({ ...x, refId: "" })),
  });
  const storedModes = new Set<string>();
  for (const m of ["BACKTEST", "BACKTEST@agent", "PAPER", "PAPER@agent", "LIVE", "LIVE@agent"] as TradingMode[]) if ((await main.repo.orders.between(from, to, m)).length) storedModes.add(m);
  return {
    main,
    agent,
    kv,
    contextWrites,
    marketReads,
    mainBook: await book(main.repo, "BACKTEST"),
    agentBook: agent ? await book(agent.repo, "PAPER") : null,
    decisions: await main.repo.decisions.between(from, to),
    outcomes: await main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER),
    storedModes: [...storedModes].sort(),
  };
}

type Run = Awaited<ReturnType<typeof replay>>;

/** Main's kv writes, in order: everything but the agent's own keys (acct:agent:*). */
const mainKv = (w: KvWrite[]) => w.filter((x) => !x.agent && !x.key.startsWith("acct:agent:")).map(({ key, value }) => ({ key, value }));
const at = (ms: number) => formatHHMM(istMinutes(ms));

let aloneRun: Promise<Run> | null = null;
const alone = () => (aloneRun ??= replay({ mode: null }));

/** Main's book, signal decisions, outcomes and kv are exactly as without the agent; the agent wrote only its own keys. */
async function expectMainUnchanged(run: Run): Promise<void> {
  const base = await alone();
  expect(base.mainBook.trades.length).toBeGreaterThan(0);
  expect(run.mainBook).toEqual(base.mainBook);
  expect(run.decisions).toEqual(base.decisions);
  expect(run.outcomes).toEqual(base.outcomes);
  expect(mainKv(run.kv)).toEqual(mainKv(base.kv));
  expect(run.kv.filter((w) => w.agent).every((w) => w.key.startsWith("acct:agent:"))).toBe(true);
  expect(run.contextWrites).toEqual([]);
  expect(run.marketReads.agent).toBe(0);
  expect(run.marketReads.main).toBe(base.marketReads.main);
}

/** Every bar went in, every judged bar's decisions came back and went through the code gate. */
async function expectBarsJudgedAndGated(a: Agent): Promise<DecisionRecord[]> {
  expect(a.agentDo.submits).toHaveLength(SUBMITTED_BARS);
  expect(new Set(a.agentDo.submits).size).toBe(SUBMITTED_BARS);
  expect(at(a.agentDo.submits[0])).toBe("09:20");
  expect(new Set((await a.store.bars(DAY)).map((b) => b.index))).toEqual(new Set(["NIFTY", "SENSEX"]));
  expect(a.reflex.calls).toHaveLength(JUDGED_BARS);
  const batches = await a.store.batches(DAY);
  expect(batches).toHaveLength(JUDGED_BARS);
  expect(batches.every((b) => b.status === "OK")).toBe(true);
  const decisions = await a.store.decisions(DAY);
  expect(decisions.length).toBe(2 * JUDGED_BARS);
  for (const d of decisions) {
    // Taken on the tick 160 s after its bar closed and gated there.
    expect(d.execution?.t).toBe(d.barCloseMs + TICKS_AFTER_CLOSE_MS[1]);
    expect(d.execution?.gate.lines.length).toBeGreaterThan(0);
  }
  return decisions;
}

const scripted = (d: DecisionRecord) => d.index === "NIFTY" && LONG_AT.includes(at(d.barCloseMs));

describe("the options agent end to end on a replayed day (runner, in-process AgentDO, code gate)", () => {
  it("shadow mode: judges every bar, gates every decision, records SHADOW_ENTRY and buys nothing", async () => {
    const run = await replay({ mode: "shadow" });
    const a = run.agent!;
    const decisions = await expectBarsJudgedAndGated(a);
    const shadow = decisions.filter((d) => d.execution?.action === "SHADOW_ENTRY");
    // The same calls paper mode buys (10:00 is in the RBI policy decision's blackout).
    expect(shadow.map((d) => at(d.barCloseMs))).toEqual(["12:00", "14:00"]);
    for (const d of shadow) {
      expect(scripted(d)).toBe(true);
      expect(d.execution!.gate.fired).toBe(true);
      expect(d.sizing!.p).toBeGreaterThan(0.5);
      expect(d.execution!.sizing!.lots).toBeGreaterThanOrEqual(1);
      expect(d.execution!.positionId).toBeNull();
    }
    expect(decisions.filter((d) => !scripted(d)).every((d) => d.execution?.action === "NO_ENTRY")).toBe(true);
    // Nothing on the agent's book, nothing to report as a trade, no entry alert.
    expect(run.agentBook!.orders).toEqual([]);
    expect(run.agentBook!.trades).toEqual([]);
    expect(await a.store.trades(DAY, DAY)).toEqual([]);
    expect(a.alerts.filter((x) => x.includes("ENTRY"))).toEqual([]);
    expect(run.storedModes).toEqual(["BACKTEST"]);
    expect(a.eod).toMatch(/\(paper experiment, shadow\)/);
    await expectMainUnchanged(run);
  });

  it("paper mode: a calibrated history sizes a paper entry on the agent's own book and its trade reaches the AgentDO", async () => {
    const run = await replay({ mode: "paper" });
    const a = run.agent!;
    const decisions = await expectBarsJudgedAndGated(a);
    // The engine's own checks apply to the agent's entries: 10:00 falls in the RBI policy decision's blackout.
    const blackout = decisions.find((d) => scripted(d) && at(d.barCloseMs) === "10:00")!;
    expect(blackout.execution!.action).toBe("NO_ENTRY");
    expect(blackout.execution!.gate.lines).toContainEqual(expect.objectContaining({ gate: "plan", passed: false, detail: expect.stringMatching(/^Scheduled-event blackout/) }));
    const entered = decisions.filter((d) => d.execution?.action === "ENTERED");
    expect(entered.map((d) => at(d.barCloseMs))).toEqual(["12:00", "14:00"]);
    for (const d of entered) {
      expect(scripted(d)).toBe(true);
      expect(d.execution!.gate.lines.every((l) => l.passed !== false)).toBe(true);
      expect(d.sizing!.p).toBeGreaterThan(0.5);
      expect(d.execution!.sizing!.lots).toBeGreaterThanOrEqual(1);
      expect(d.execution!.sizing!.lots).toBeLessThanOrEqual(AGENT_LIMITS.maxLotsPerPosition);
      expect(d.execution!.positionId).not.toBeNull();
    }
    const entries = run.agentBook!.orders.filter((x) => x.reason === "ENTRY");
    expect(entries).toHaveLength(entered.length);
    expect(run.storedModes).toEqual(["BACKTEST", "PAPER@agent"]);
    // Every agent trade was closed by its code exits (the 15:05 square-off at the latest) and reached the AgentDO
    // with its finalist and decision.
    expect(await a.repo.positions.open("PAPER")).toEqual([]);
    expect(run.agentBook!.trades.length).toBe(entered.length);
    for (const t of run.agentBook!.trades) expect(t.exitMs).toBeLessThanOrEqual(istAt(DAY, "15:05") + TICKS_AFTER_CLOSE_MS[0]);
    const stored = await a.store.trades(DAY, DAY);
    expect(stored.map((t) => t.positionId).sort()).toEqual(run.agentBook!.trades.map((t) => t.positionId).sort());
    for (const t of stored) {
      const d = entered.find((x) => x.id === t.decisionId)!;
      expect(d).toBeDefined();
      expect(t.positionId).toBe(d.execution!.positionId);
      expect(t.finalistId).toBe(d.finalistId);
    }
    expect(a.alerts.filter((x) => x.includes("ENTRY"))).toHaveLength(entered.length);
    expect(a.hot().unsentTrades).toEqual([]);
    expect(a.hot().outbox).toEqual([]);
    expect(a.eod).toMatch(/\(paper experiment, paper\)/);
    await expectMainUnchanged(run);
  });

  it("the 15% drawdown halt: kill switch on, the open position closed at market, no entry after it", async () => {
    let haltAt: number | null = null;
    const run = await replay({
      mode: "paper",
      // Once the agent holds a position, its equity drops 20% (the day's start lowered by ₹1L): past the 15% limit.
      beforeStep: async (t, a) => {
        if (haltAt !== null || (await a.repo.positions.open("PAPER")).length === 0) return;
        const day = await loadDayLedger(a.repo, agentCfg, t, "PAPER");
        await a.repo.ledger.save({ ...day, startEquity: day.startEquity - 100_000 });
        haltAt = t;
      },
    });
    const a = run.agent!;
    expect(haltAt).not.toBeNull();
    const halt = haltAt!;
    expect(a.hot().ddHalt).toBe(true);
    const settings = await a.repo.settings.get();
    expect(settings.killSwitch).toBe(true);
    expect(settings.killReason).toBe(`max drawdown ${AGENT_LIMITS.maxDrawdownPct}% reached: re-arm on the Agent page`);
    expect(a.alerts.some((x) => /down \d+\.\d% from its peak equity/.test(x))).toBe(true);
    // The position was closed at market on the halt's own step.
    const killed = run.agentBook!.trades.filter((x) => x.exitReason === "KILL_SWITCH");
    expect(killed).toHaveLength(1);
    expect(killed[0].exitMs).toBe(halt);
    // The model still called LONG later; the gate let nothing through.
    const decisions = await a.store.decisions(DAY);
    const later = decisions.filter((d) => scripted(d) && d.execution!.t > halt);
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) {
      expect(d.execution!.action).toBe("NO_ENTRY");
      expect(d.execution!.gate.lines).toContainEqual(expect.objectContaining({ gate: "entry_mode", passed: false, detail: expect.stringContaining("drawdown halt") }));
    }
    expect(run.agentBook!.orders.filter((x) => x.reason === "ENTRY").every((x) => x.createdMs < halt)).toBe(true);
    expect((await a.store.latestRisk())?.ddHalt).toBe(true);
    expect(a.eod).toMatch(/\(halted: re-arm on the Agent page\)$/);
    await expectMainUnchanged(run);

    // The operator re-arms in the evening, when no step runs: the Agent page (the AgentDO's view with the live kill
    // switches over it) drops the halt at once.
    run.main.clock.set(istAt(DAY, "18:30"));
    expect((await a.runner.rearm("dashboard")).ok).toBe(true);
    const view = withAccountSettings(await a.brain.view(DAY, null), await a.repo.settings.get(), await run.main.repo.settings.get());
    expect(view.risk).toMatchObject({ drawdownHalt: false, killSwitch: false, drawdownPct: 0 });
  });

  it("the snapshot shows the open P&L on every bar the agent holds a position, with a clock that moves on every read", async () => {
    const run = await replay({ mode: "paper", agent: { drift: true } });
    const held = (await run.agent!.store.bars(DAY)).filter((b) => b.index === "NIFTY" && b.snapshot && b.snapshot.bk.pos !== "-");
    expect(held.length).toBeGreaterThan(5);
    // The book is stamped after its positions were read, so their marks count: "null" would tell the model it is flat.
    expect(held.filter((b) => b.snapshot!.bk.pnl === null).map((b) => at(b.barCloseMs))).toEqual([]);
  });

  it("a call on an index main computed no features for: the agent never reads main's market data source", async () => {
    // Main trades NIFTY only; the model calls SENSEX up at 12:00.
    const sensexAt12 = (req: ReflexRequest): ReflexDecision[] =>
      decide(req).map((d) => {
        const f = promptFinalists(req.input, req.finalists).find((x) => x.id === d.finalistId);
        return f?.index === "SENSEX" && at(req.input.barCloseMs) === "12:00" ? { ...d, direction: "LONG", directionConfidence: 0.9, setupQuality: 3, reason: "higher highs" } : { ...d, direction: "NEUTRAL", directionConfidence: 0.45, setupQuality: 1 };
      });
    const run = await replay({ mode: "shadow", agent: { script: sensexAt12, offerMainMarket: true } });
    const call = (await run.agent!.store.decisions(DAY)).find((d) => d.index === "SENSEX" && at(d.barCloseMs) === "12:00" && d.direction === "LONG");
    expect(call).toBeDefined();
    expect(call!.execution!.action).toBe("NO_ENTRY");
    expect(run.marketReads.agent).toBe(0);
    await expectMainUnchanged(run);
  });
});
