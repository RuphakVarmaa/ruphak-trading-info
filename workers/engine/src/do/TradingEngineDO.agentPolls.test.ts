/**
 * The options agent inside main's exit-poll waits (TradingEngineDO.pollWait), on the real TE methods and a real
 * AgentRunner, on fake timers where each D1 round trip, AgentDO call and flow read takes its own time.
 * Main is positioned, so its tick is its trading cycle and exits, then two 10 s exit-poll waits each followed by its
 * poll exits, then the agent's step under its budget. When main's own work reaches 26-28 s, the step gets 2.5 s or
 * less (or is skipped), too little to submit a bar after its other parts; the waits then catch up on everything but
 * the decisions:
 * - the latest closed bar is submitted within its 4-minute window;
 * - a drawdown halt flattens the agent within one wait;
 * - main's waits stay 10 s and its next alarm stays 30 s after the tick's start;
 * - a kill that squares off still goes first: the agent's work in a wait stops, and main's square-off and the relay
 *   panic come exactly as early as without the agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
// The bar's completeness and its snapshots need a day of market data; both are stood in for (agentRunner.test.ts does too).
vi.mock("../../../../src/engine/agent/causal", async (orig) => ({ ...(await orig<typeof import("../../../../src/engine/agent/causal")>()), latestClosedBarMs: vi.fn() }));
vi.mock("../../../../src/engine/agent/agentCycle", async (orig) => ({ ...(await orig<typeof import("../../../../src/engine/agent/agentCycle")>()), buildReflexInput: vi.fn() }));

import { ACCOUNTS, accountConfig } from "../../../../src/engine/accounts";
import { buildReflexInput } from "../../../../src/engine/agent/agentCycle";
import { latestClosedBarMs } from "../../../../src/engine/agent/causal";
import { AGENT_POLICY } from "../../../../src/engine/agent/constants";
import type { AgentSettings, IndexSnapshot } from "../../../../src/engine/agent/types";
import { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { istAt, istDate } from "../../../../src/engine/clock";
import { DEFAULT_CONFIG } from "../../../../src/engine/config";
import { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import type { CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { sequentialIds, silentLogger, type OptionQuoteSource, type Repository } from "../../../../src/engine/ports";
import { accountRepository } from "../../../../src/engine/repo/accountRepo";
import { InMemoryRepository } from "../../../../src/engine/repo/memory";
import type { MarketSnapshot, OptionContract, Position, TradingMode } from "../../../../src/engine/types";
import { AgentRunner, HOT_KEY, type AgentHot } from "../agent/agentRunner";
import { TradingEngineDO, type AdminResult } from "./TradingEngineDO";

const DAY = "2026-10-19"; // a Monday, a trading day
const BAR = istAt(DAY, "10:00"); // the latest closed 5-minute bar
const TICK0 = BAR + 30_000; // main's first tick after it
const cfg = DEFAULT_CONFIG;
const agentCfg = accountConfig(cfg, "agent");
const cal = new TradingCalendar();
const SETTINGS: AgentSettings = { mode: "shadow", reflexModel: "r", escalationModel: "d", reviewModel: "d", dailyUsdCap: 3, escalationsPerDay: 8 };
/** A slow session: 60 ms a D1 round trip, 100 ms an AgentDO call, 300 ms a flow read (the step alone stopped submitting from 25.5 s). */
const D1_MS = 60;
const RPC_MS = 100;
const FLOW_MS = 300;
/** Main's own exit polls after each wait. */
const POLL_EXITS_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type KillReq = { engaged: boolean; squareOff: boolean; reason: string };

/** The members of TradingEngineDO these tests set or call (most are private in the class). */
interface Te {
  agentHold: number;
  agentPreempt: (() => void) | null;
  runTick(): Promise<number>;
  pollWait(ms: number, cal: TradingCalendar, report: CycleReport): Promise<void>;
  agentStep(report: CycleReport, calendar: TradingCalendar, degraded: boolean, tickStartMs: number): Promise<void>;
  setKillSwitch(req: KillReq, actor: string, account?: string): Promise<AdminResult>;
}

/** A repository whose every call answers `latMs` later (a D1 round trip); calls sent together overlap. */
function slowRepo<T extends object>(target: T, latMs: number): T {
  return new Proxy(target, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          return out instanceof Promise ? out.then(async (x) => (await sleep(latMs), x)) : out;
        };
      }
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) return slowRepo(v as object, latMs);
      return v;
    },
  });
}

const report = (t: number): CycleReport => ({ t, phase: "OPEN", features: {}, convictions: {}, pressure: {}, decisions: [], entries: [], halted: null, errors: [], snapshot: {} as unknown as MarketSnapshot, perf: [] });

/** A two-sided book around ₹100, as the runner's own live quotes would give. */
const QUOTES: OptionQuoteSource = {
  kind: "upstox",
  quote: async (c, ctx) => ({ symbol: c.tradingSymbol, t: ctx.t, ltp: 100, bid: 99.5, ask: 100.5, bidQty: 650, askQty: 650, source: "upstox" }),
};
const CONTRACT: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "NIFTY26O2725000CE", growwSymbol: "NSE-NIFTY-27Oct26-25000-CE", exchangeToken: "50001", expiry: "2026-10-27", strike: 25_000, type: "CE", lotSize: 65, tickSize: 0.05 };

function agentPosition(): Position {
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
  };
}

interface Harness {
  te: Te;
  base: InMemoryRepository;
  /** The agent's book without the D1 delay, for setting up and reading back. */
  agentRepo: Repository;
  kept: Map<string, unknown>;
  /** When each bar reached the AgentDO, and which. */
  submits: { at: number; bar: number }[];
  records: number[];
  alerts: string[];
  /** Per tick: when main's poll exits started after each wait, from the tick's start. */
  polls: number[][];
  /** Main's next alarm after each tick. */
  alarms: number[];
  tickStarts: number[];
  panicAt: number | null;
}

/**
 * TE positioned, its own work `mainWorkMs` a tick (its cycle and exits, two 10 s waits, 1 s of poll exits after each),
 * with a real AgentRunner on the same slow D1, or with no agent. `agentDoHangs`: the AgentDO never answers.
 */
function harness(o: { mainWorkMs: number; agent?: boolean; agentDoHangs?: boolean }): Harness {
  // Each run starts at TICK0, without what an earlier run in the same test left running.
  vi.clearAllTimers();
  vi.setSystemTime(TICK0);
  const base = new InMemoryRepository(cfg, TICK0);
  const slow = slowRepo(base as unknown as Repository, D1_MS);
  const kept = new Map<string, unknown>();
  // The object returned: TE and the fakes below write into it as they run.
  const h: Harness = {
    te: Object.create(TradingEngineDO.prototype) as Te,
    base,
    agentRepo: accountRepository(base, "agent", agentCfg, () => Date.now()),
    kept,
    submits: [],
    records: [],
    alerts: [],
    polls: [],
    alarms: [],
    tickStarts: [],
    panicAt: null,
  };
  const answer = async <T,>(value: T): Promise<T> => {
    await (o.agentDoHangs ? new Promise<void>(() => {}) : sleep(RPC_MS));
    return value;
  };
  const marketContext = new MarketContextStore();
  marketContext.set("NIFTY", { spot: 25_000, vix: 13, t: TICK0 });
  marketContext.set("SENSEX", { spot: 82_000, vix: 13, t: TICK0 });
  const runner = new AgentRunner({
    account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo: accountRepository(slow, "agent", agentCfg, () => Date.now()) },
    mainRepo: slow,
    settings: SETTINGS,
    storage: {
      get: async <T,>(k: string) => (kept.has(k) ? (structuredClone(kept.get(k)) as T) : undefined),
      put: async <T,>(k: string, v: T) => void kept.set(k, structuredClone(v)),
    },
    agentDo: {
      submitBar: async (input) => {
        h.submits.push({ at: Date.now(), bar: input.barCloseMs });
        return answer({ accepted: true, reason: null });
      },
      takeDecisions: () => answer(null),
      recordExecution: async () => {
        h.records.push(Date.now());
        await answer(undefined);
      },
    },
    feed: { getOptionFlowAsOf: async () => (await sleep(FLOW_MS), null) },
    quotes: QUOTES,
    instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
    marketContext,
    alerts: { send: async (text) => (h.alerts.push(text), true) },
    logger: silentLogger,
    calendar: cal,
    newId: sequentialIds("ag"),
  });
  const cycleMs = o.mainWorkMs - 2 * (10_000 + POLL_EXITS_MS);
  Object.assign(h.te, {
    // Main's own reads and writes answer at once, so a kill's hold starts the moment the kill comes in.
    rt: { logger: silentLogger, repo: base, calendar: cal, cfg },
    hot: { consecutiveErrors: 0, lastError: null, lastTickMs: null, lastOffHoursSnapshotMs: 0, lastReconcileMs: 0, reconcileMismatches: 0 },
    ticking: null,
    tickSoon: false,
    followers: [],
    relay: {
      panic: async () => {
        h.panicAt = Date.now();
        return { status: 200, body: "ok" };
      },
    },
    alerts: { send: async () => true },
    ctx: { storage: { setAlarm: async (ms: number) => void h.alarms.push(ms), put: async () => {}, getAlarm: async () => null } },
    agentEnabled: o.agent !== false,
    agentInitError: null,
    agent: o.agent !== false ? runner : null,
    agentAlerts: { send: async () => true },
    agentPreempt: null,
    agentHold: 0,
    writeHeartbeat: async () => {},
    kickQuoteRecorder: () => {},
    calendarFor: () => cal,
    // tick() while positioned: the cycle and exits, two exit-poll waits each followed by the poll exits, the agent's step.
    tick: async function (this: Te, now: number): Promise<number> {
      h.tickStarts.push(now);
      const r = report(now);
      const polls: number[] = [];
      h.polls.push(polls);
      await sleep(cycleMs);
      for (const ms of [10_000, 10_000]) {
        await this.pollWait(ms, cal, r);
        polls.push(Date.now() - now);
        await sleep(POLL_EXITS_MS);
      }
      await this.agentStep(r, cal, false, now);
      return now + 30_000;
    },
  });
  return h;
}

/** Runs main's alarm ticks 30 s apart from TICK0, as the alarm loop does. */
async function ticks(h: Harness, n: number): Promise<void> {
  for (let k = 0; k < n; k++) {
    await vi.advanceTimersByTimeAsync(TICK0 + k * 30_000 - Date.now());
    const running = h.te.runTick();
    await vi.advanceTimersByTimeAsync(29_000);
    await running;
  }
}

/** Earlier losses: today starts at ₹4,20,000 against a ₹5,00,000 peak (16%, past the 15% limit). */
async function seedDrawdown(h: Harness): Promise<void> {
  h.kept.set(HOT_KEY, { date: DAY, peakEquity: 500_000 });
  await h.agentRepo.ledger.save({ date: "2026-10-16", mode: "PAPER", realized: -80_000, unrealized: 0, charges: 0, trades: 4, wins: 0, losses: 4, consecutiveLosses: 4, ordersPlaced: 8, maxIntradayDrawdown: 80_000, peakEquity: 500_000, startEquity: 500_000, updatedMs: TICK0 - 3 * 86_400_000 });
  await h.agentRepo.positions.save(agentPosition());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(TICK0);
  vi.mocked(latestClosedBarMs).mockReset().mockReturnValue({ barCloseMs: BAR, complete: ["NIFTY", "SENSEX"] });
  vi.mocked(buildReflexInput)
    .mockReset()
    .mockImplementation((a) => ({ barCloseMs: a.barCloseMs, date: istDate(a.barCloseMs), builtMs: a.nowMs, snapshots: { NIFTY: { c: 1 } as unknown as IndexSnapshot }, tokensEst: {}, closes: { NIFTY: 25_000 }, problems: [] }));
});
afterEach(() => vi.useRealTimers());

describe("main at 26-28 s of tick work: the agent catches up in main's exit-poll waits", () => {
  for (const mainWorkMs of [26_000, 27_000, 28_000]) {
    const cycleMs = mainWorkMs - 2 * (10_000 + POLL_EXITS_MS);

    it(`${mainWorkMs / 1000} s: the bar is submitted within its 4-minute window, in the first wait after it`, async () => {
      const h = harness({ mainWorkMs });
      await ticks(h, 8);
      expect(h.submits.map((s) => s.bar)).toEqual([BAR]);
      expect(h.submits[0].at - BAR).toBeLessThanOrEqual(AGENT_POLICY.maxDecisionAgeMs);
      expect(h.submits[0].at).toBeLessThan(TICK0 + cycleMs + 10_000);
      expect((h.kept.get(HOT_KEY) as AgentHot).lastSubmittedBarMs).toBe(BAR);
    });

    it(`${mainWorkMs / 1000} s: a drawdown halt flattens the agent within one wait`, async () => {
      const h = harness({ mainWorkMs });
      await seedDrawdown(h);
      await ticks(h, 1);
      const [trade] = await h.base.trades.recent(5, "PAPER@agent" as TradingMode);
      expect(trade).toMatchObject({ positionId: "pos-1", exitReason: "KILL_SWITCH" });
      expect(trade.exitMs).toBeLessThanOrEqual(TICK0 + cycleMs + 10_000);
      expect(await h.agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" });
      expect((h.kept.get(HOT_KEY) as AgentHot).ddHalt).toBe(true);
      expect((await h.base.audit.recent(50)).filter((a) => a.action === "kill")).toHaveLength(1);
      expect(h.alerts.filter((a) => /from its peak equity/.test(a))).toHaveLength(1);
    });

    for (const agentDoHangs of [false, true]) {
      it(`${mainWorkMs / 1000} s: main's waits stay 10 s and its next alarm 30 s after the tick's start${agentDoHangs ? ", with a silent AgentDO" : ""}`, async () => {
        const h = harness({ mainWorkMs, agentDoHangs });
        await seedDrawdown(h);
        await ticks(h, 4);
        expect(h.polls).toEqual(Array.from({ length: 4 }, () => [cycleMs + 10_000, cycleMs + 10_000 + POLL_EXITS_MS + 10_000]));
        expect(h.alarms).toEqual([1, 2, 3, 4].map((k) => TICK0 + k * 30_000));
      });
    }
  }
});

describe("a kill that squares off during the agent's work in a wait", () => {
  /** Telegram /kill ("all", or main) `afterMs` into the first wait of an alarm tick, with main holding a LIVE position. */
  async function kill(o: { agent: boolean; target: "all" | "main"; afterMs: number }) {
    const mainWorkMs = 26_000;
    const h = harness({ mainWorkMs, agent: o.agent });
    await h.base.positions.save({ id: "live-1", mode: "LIVE", status: "OPEN", index: "NIFTY", contract: { tradingSymbol: "NIFTY-LIVE" } } as unknown as Position);
    void h.te.runTick();
    await vi.advanceTimersByTimeAsync(mainWorkMs - 2 * (10_000 + POLL_EXITS_MS) + o.afterMs);
    const killAt = Date.now();
    const killing = h.te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner /kill" }, "telegram", o.target);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await killing).ok).toBe(true);
    return {
      killAt,
      squareOffStart: h.tickStarts[1] - killAt,
      panic: (h.panicAt ?? Number.NaN) - killAt,
      submits: h.submits,
      records: h.records,
      hold: h.te.agentHold,
      preempt: h.te.agentPreempt,
      agentKill: (await h.agentRepo.settings.get()).killSwitch,
      // When the agent's own kill switch went on (its audit rows carry the actor "…@agent"), from the kill.
      agentKillRows: (await h.base.audit.recent(100)).filter((a) => a.action === "kill" && a.actor.endsWith("@agent")).map((a) => a.ts - killAt),
    };
  }

  for (const target of ["all", "main"] as const) {
    // Into its kill coupling and exits, its drawdown check, and its risk row and book: always before its bar.
    for (const afterMs of [30, 200, 400]) {
      it(`${target}, ${afterMs} ms into the agent's work: main squares off and panics as without the agent; the agent starts nothing more`, async () => {
        const without = await kill({ agent: false, target, afterMs });
        const withAgent = await kill({ agent: true, target, afterMs });
        expect(Number.isFinite(without.panic)).toBe(true);
        expect(withAgent.squareOffStart).toBe(without.squareOffStart);
        expect(withAgent.panic).toBe(without.panic);
        // The wait's work stopped at its next check: no bar, and nothing sent to the AgentDO after the kill. The waits
        // during the square-off ran the code exits only.
        expect(withAgent.submits).toEqual([]);
        expect(withAgent.records.filter((at) => at >= withAgent.killAt)).toEqual([]);
        expect(withAgent.hold).toBe(0);
        expect(withAgent.preempt).toBeNull();
        // The agent's own switch follows main's square-off and panic, never before them.
        expect(withAgent.agentKill).toBe(true);
        expect(withAgent.agentKillRows.length).toBeGreaterThan(0);
        expect(withAgent.agentKillRows.every((at) => at >= withAgent.panic)).toBe(true);
      });
    }
  }
});
