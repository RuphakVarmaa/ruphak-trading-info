/**
 * Main's book must stay exactly as it is with the agent running next to it (BRIEF decision 2). This replays
 * 7 Oct 2026 every 5 minutes with and without the agent (the replay of pipeline/accountCycle.test.ts), the agent
 * judged by a fake reflex model in an in-process AgentBrain and trading its own scoped paper book.
 */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import type { OptionFlowView } from "../api-types";
import { formatHHMM, istAt, istDate, istIso, istMinutes, MINUTE_MS } from "../clock";
import { makeConfig } from "../config";
import { runEndOfDay } from "../pipeline/dayLifecycle";
import { runPositionCycle } from "../pipeline/positionCycle";
import { runTradingCycle, type CycleReport } from "../pipeline/tradingCycle";
import { sequentialIds, silentLogger } from "../ports";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import { MARKET_SYMBOLS, type IndexId, type TradingMode } from "../types";
import { agentPositionPass, bookAsOf, bookFrom, buildReflexInput, executeAgentBatch, initialBook } from "./agentCycle";
import { AgentBrain } from "./brain";
import { causalMarketSnapshot, latestClosedBarMs } from "./causal";
import { AGENT_POLICY } from "./constants";
import type { ReflexJudge, ReflexRequest, ReflexResponse } from "./judge";
import { MemoryAgentStore } from "./store";
import { agentSample } from "./storeContract";
import type { AgentBookState, AgentPositionTag, DecisionRecord, ReflexDecision, ReflexInput } from "./types";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();
// As in the follower replay: low thresholds and no edge floor, so main trades on this day.
const mainCfg = makeConfig({
  indices: ["NIFTY"],
  conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0 },
  sizing: { maxTradesPerDay: 3 },
});
const agentCfg = accountConfig(mainCfg, "agent");
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];
/** Two minutes after each bar close: in a replay a bar counts as complete 90 s after it closes. */
const STEP_OFFSET_MS = 2 * MINUTE_MS;

/** The reflex model's script: LONG on NIFTY at 10:00 and 12:00, SHORT on SENSEX at 11:00, NEUTRAL otherwise. */
const SCRIPT: Record<string, Partial<Record<IndexId, Partial<ReflexDecision>>>> = {
  "10:00": { NIFTY: { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } },
  "11:00": { SENSEX: { direction: "SHORT", directionConfidence: 0.9, setupQuality: 3 } },
  "12:00": { NIFTY: { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } },
};

class ScriptedReflex implements ReflexJudge {
  readonly kind = "fake" as const;
  readonly model = "claude-haiku-5-5";
  calls = 0;
  constructor(private readonly fail: boolean) {}
  async judge(req: ReflexRequest): Promise<ReflexResponse> {
    this.calls++;
    if (this.fail) return { status: "ERROR", decisions: [], dropped: [], usage: null, model: this.model, latencyMs: 20_000, error: "the fake always fails" };
    const at = formatHHMM(istMinutes(req.input.barCloseMs));
    const decisions = req.finalists.map((f) => ({
      finalistId: f.id, regime: "TRENDING" as const, direction: "NEUTRAL" as const, directionConfidence: 0.45, toxicFlow: false, setupQuality: 1 as const, riskState: "SAFE" as const, reason: "no clear move",
      ...(SCRIPT[at]?.[f.index] ?? {}),
    }));
    return { status: "OK", decisions, dropped: [], usage: { inputTokens: 1_700, outputTokens: 600, cacheReadTokens: 1_300, cacheCreationTokens: 0 }, model: this.model, latencyMs: 1_500, error: null };
  }
}

/** A minute sample of the option chain as of `t` (the shape MarketFeedDO.getOptionFlowAsOf returns). */
function flowView(index: IndexId, spot: number, t: number): OptionFlowView {
  const step = index === "NIFTY" ? 50 : 100;
  const atm = Math.round(spot / step) * step;
  const side = (mid: number) => ({ oi: 120_000, ltp: mid, bid: mid - 0.5, ask: mid + 0.5, iv: 13, delta: 0.5, oiChg: 0, oiChgPct: 0, vol: 1_000, volMultiple: 1, ltpChgPct: 0, ivChg: 0, buildup: "NEUTRAL" });
  const rows = [-2, -1, 0, 1, 2].map((k) => ({ strike: atm + k * step, ce: side(120 - 20 * k), pe: side(115 + 20 * k) }));
  const w = (minutes: number) => ({ minutes, from: istIso(t - minutes * MINUTE_MS), rows });
  return {
    index, source: "feed", asOf: istIso(t - 30_000), expiry: null, lotSize: null, spot, atm, step, minutes: 60, note: null,
    windows: { "1m": w(1), "5m": w(5), "15m": w(15) }, events: [],
    summary: { pcr: 0.9, pcrChg15m: null, resistance: { strike: atm + 2 * step, oi: 150_000 }, support: { strike: atm - 2 * step, oi: 150_000 } },
  } as unknown as OptionFlowView;
}

/** Graded reflex history (most calls paid), so the sizing probability is above one half and Kelly sizes a trade. */
async function seedHistory(store: MemoryAgentStore, version: string): Promise<void> {
  const rows: DecisionRecord[] = [];
  for (let i = 0; i < 400; i++) {
    const t = istAt("2026-08-20", "09:30") + Math.floor(i / 9) * 24 * 60 * MINUTE_MS + (i % 9) * 40 * MINUTE_MS;
    const date = istDate(t);
    rows.push(agentSample.decision({ id: `h${i}`, date, barCloseMs: t, instructionVersion: version, directionConfidence: 0.9, outcome: agentSample.outcome({ status: "HIT", y: 1, paid: i % 5 !== 0 }) }));
  }
  await store.putDecisions(rows);
}

interface AgentSim {
  deps: ReplayDeps;
  brain: AgentBrain;
  reflex: ScriptedReflex;
  inputs: Map<number, ReflexInput>;
  books: AgentBookState[];
  positions: Record<string, AgentPositionTag>;
  peak: number | null;
  lastSubmitted: number;
}

async function makeAgent(main: ReplayDeps, failing: boolean): Promise<AgentSim> {
  const deps = createFollowerDeps(main, agentCfg, "agent");
  const store = new MemoryAgentStore();
  const reflex = new ScriptedReflex(failing);
  const brain = new AgentBrain({
    store,
    settings: { mode: "paper", reflexModel: reflex.model, escalationModel: "claude-opus-5-5", reviewModel: "claude-opus-5-5", dailyUsdCap: 3, escalationsPerDay: 8 },
    reflex,
    escalation: null,
    review: null,
    advisor: async () => null,
    barsFallback: async () => [],
    calendar: main.calendar,
    cfg: agentCfg,
    now: () => main.clock.now(),
    newId: sequentialIds("agent-brain"),
    logger: silentLogger,
  });
  await seedHistory(store, (await brain.status()).instructionVersion);
  return { deps, brain, reflex, inputs: new Map(), books: [], positions: {}, peak: null, lastSubmitted: 0 };
}

/** The agent's part of one tick: submit the newest complete bar, let the brain judge it, execute the fresh batch. */
async function agentStep(a: AgentSim, main: ReplayDeps, r: CycleReport, t: number): Promise<void> {
  if (!r.snapshot) return;
  const bar = latestClosedBarMs(r.snapshot, INDICES, t, main.calendar);
  if (!bar || bar.barCloseMs <= a.lastSubmitted || bar.complete.length === 0) return;
  a.lastSubmitted = bar.barCloseMs;
  const T = bar.barCloseMs;
  const causal = causalMarketSnapshot(r.snapshot, T);
  const flows: Partial<Record<IndexId, OptionFlowView>> = {};
  for (const index of bar.complete) {
    const bars = causal.candles[MARKET_SYMBOLS[index]] ?? [];
    const close = bars[bars.length - 1]?.c;
    if (close) flows[index] = flowView(index, close, T);
  }
  const input = buildReflexInput({
    barCloseMs: T, indices: INDICES, complete: bar.complete, market: r.snapshot, calendar: main.calendar, cfg: agentCfg, events: [], perf: r.perf ?? [], flows,
    book: bookAsOf(a.books, T, initialBook(null, agentCfg.capitalRupees, T)), nowMs: t,
  });
  a.inputs.set(T, input);
  await a.brain.submitBar(input);
  await a.brain.runDue(t, t + 10 * MINUTE_MS);
  const batch = await a.brain.takeDecisions(T - 1);
  if (!batch || t - batch.barCloseMs > AGENT_POLICY.maxDecisionAgeMs) return;
  const rec = await executeAgentBatch(a.deps, batch, {
    mode: "paper", nowMs: t, calendar: main.calendar, features: r.features, pressure: r.pressure, convictions: r.convictions, snapshots: a.inputs.get(batch.barCloseMs)?.snapshots ?? {},
    noEntries: null, mainSettings: () => main.repo.settings.get(), peakEquity: a.peak, ddHalt: false, positions: a.positions, trades: [], acceptSyntheticQuotes: true,
  });
  await a.brain.recordExecution(rec);
  a.peak = rec.risk.peakEquity;
  a.books.push(bookFrom(rec.risk, await a.deps.repo.positions.open(a.deps.mode), (p) => p.contract.lotSize));
}

interface KvWrite {
  key: string;
  value: unknown;
  agent: boolean;
}

async function replay(o: { agent: boolean; failing?: boolean; before?: (main: ReplayDeps, agent: AgentSim | null) => Promise<void> }) {
  const start = istAt(DAY, "09:15");
  const main = createReplayDeps({ cfg: mainCfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  // Spies on main's repository kv and on the shared market context; `inAgent` marks the agent's part of a tick.
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
  const agent = o.agent ? await makeAgent(main, o.failing ?? false) : null;
  if (o.before) await o.before(main, agent);
  const asAgent = async (fn: () => Promise<unknown>) => {
    inAgent = true;
    try {
      await fn();
    } finally {
      inAgent = false;
    }
  };

  for (let t = start + STEP_OFFSET_MS; t <= istAt(DAY, "15:30") + STEP_OFFSET_MS; t += 5 * MINUTE_MS) {
    main.clock.set(t);
    const r = await runTradingCycle(main, { noEvents: true });
    if (agent) await asAgent(() => agentStep(agent, main, r, t));
    await runPositionCycle(main, { convictions: r.convictions });
    if (agent) await asAgent(() => agentPositionPass(agent.deps));
  }
  main.clock.set(istAt(DAY, "16:00"));
  await runEndOfDay(main);
  if (agent) await asAgent(() => runEndOfDay(agent.deps, { grade: false, performance: false }));

  const from = istAt(DAY, "09:00");
  const to = istAt(DAY, "16:00");
  const book = async (d: ReplayDeps, mode: TradingMode = "BACKTEST") => ({
    trades: await d.repo.trades.between(from, to, mode),
    ledger: await d.repo.ledger.get(DAY, mode),
    // refId is random per order (idempotency key), so it differs between otherwise identical runs.
    orders: (await d.repo.orders.between(from, to, mode)).map((x) => ({ ...x, refId: "" })),
  });
  return {
    main,
    agent,
    kv,
    contextWrites,
    mainBook: await book(main),
    agentBook: agent ? await book(agent.deps) : null,
    decisions: await main.repo.decisions.between(from, to),
    outcomes: await main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER),
    storedModes: async () => {
      const modes = new Set<string>();
      for (const m of ["BACKTEST", "BACKTEST@agent", "PAPER", "PAPER@agent", "LIVE", "LIVE@agent"] as TradingMode[]) if ((await main.repo.orders.between(from, to, m)).length) modes.add(m);
      return [...modes].sort();
    },
  };
}

/** Main's kv writes, in order: everything but the agent's own keys (acct:agent:*). */
const mainKv = (w: KvWrite[]) => w.filter((x) => !x.agent && !x.key.startsWith("acct:agent:")).map(({ key, value }) => ({ key, value }));

describe("the options agent next to main (7 Oct replay)", () => {
  it("leaves main's trades, ledger, orders, decisions, outcomes and kv exactly as without it", async () => {
    const alone = await replay({ agent: false });
    const both = await replay({ agent: true });
    expect(alone.mainBook.trades.length).toBeGreaterThan(0);
    expect(both.mainBook).toEqual(alone.mainBook);
    expect(both.decisions).toEqual(alone.decisions);
    expect(both.outcomes).toEqual(alone.outcomes);
    expect(mainKv(both.kv)).toEqual(mainKv(alone.kv));

    // The agent judged every bar of its window and traded its own book.
    expect(both.agent!.reflex.calls).toBe(70);
    expect(both.agentBook!.trades.length).toBeGreaterThan(0);
    expect(both.agentBook!.orders.every((x) => x.mode === "BACKTEST")).toBe(true);
    expect(await both.storedModes()).toEqual(["BACKTEST", "BACKTEST@agent"]);
    // Every kv key the agent wrote is its own; it never wrote the shared market context.
    expect(both.kv.filter((w) => w.agent).every((w) => w.key.startsWith("acct:agent:"))).toBe(true);
    expect(both.contextWrites).toEqual([]);
    // Its plans are tagged as the agent's and never stored as signals.
    for (const ord of both.agentBook!.orders.filter((x) => x.reason === "ENTRY")) {
      const plan = (await both.agent!.deps.repo.plans.get(ord.planId!))!;
      expect(plan.dominantSource).toBe("VOL_REGIME");
      expect(plan.gates.some((g) => g.gate === "agent")).toBe(true);
    }
    expect(await both.agent!.deps.repo.decisions.latest("NIFTY")).toBeNull();
  });

  it("takes no agent trade with the agent's kill switch on, and main is unchanged", async () => {
    const alone = await replay({ agent: false });
    const killed = await replay({
      agent: true,
      before: async (_main, agent) => {
        await agent!.deps.repo.settings.update({ killSwitch: true, killReason: "test" }, "test");
      },
    });
    expect(killed.agentBook!.orders).toEqual([]);
    expect(killed.agentBook!.trades).toEqual([]);
    expect(killed.mainBook).toEqual(alone.mainBook);
    expect(mainKv(killed.kv)).toEqual(mainKv(alone.kv));
  });

  it("takes no agent entry when main's kill switch is on before the session", async () => {
    const run = await replay({
      agent: true,
      before: async (main) => {
        await main.repo.settings.update({ killSwitch: true, killReason: "owner" }, "test");
      },
    });
    expect(run.agentBook!.orders.filter((x) => x.reason === "ENTRY")).toEqual([]);
  });

  it("places no agent order when every model call fails, and main is unchanged", async () => {
    const alone = await replay({ agent: false });
    const failing = await replay({ agent: true, failing: true });
    expect(failing.agent!.reflex.calls).toBe(70);
    expect(failing.agentBook!.orders).toEqual([]);
    expect(failing.mainBook).toEqual(alone.mainBook);
    expect(failing.decisions).toEqual(alone.decisions);
    expect(mainKv(failing.kv)).toEqual(mainKv(alone.kv));
  });
});
