/**
 * The trading DO's glue around the options agent (TradingEngineDO.ts), on the real class methods with the Workers
 * runtime module stubbed and every collaborator a fake (a real AgentRunner where the coupling matters):
 * - a kill that squares off flattens main (and sends the relay panic) before the agent is waited for, a kill without
 *   one leaves the agent's switch to it (set even when that kill fails part way), and a follower's square-off holds the
 *   agent's step too, without stopping the agent's work;
 * - the agent's step never pushes main's next alarm back;
 * - main's kill switch engages the agent's at once;
 * - a failing alert, a silent AgentDO or a bad agent config never reaches main's tick, its end of day or its /status.
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

import { ACCOUNTS, accountConfig } from "../../../../src/engine/accounts";
import type { AgentStatus } from "../../../../src/engine/agent/brain";
import { TradingCalendar } from "../../../../src/engine/calendar/calendar";
import { istAt, systemClock } from "../../../../src/engine/clock";
import { DEFAULT_CONFIG } from "../../../../src/engine/config";
import { MarketContextStore } from "../../../../src/engine/pipeline/marketContext";
import type { CycleReport } from "../../../../src/engine/pipeline/tradingCycle";
import { silentLogger, type Repository } from "../../../../src/engine/ports";
import { accountRepository } from "../../../../src/engine/repo/accountRepo";
import { InMemoryRepository } from "../../../../src/engine/repo/memory";
import type { Position } from "../../../../src/engine/types";
import { AgentRunner } from "../agent/agentRunner";
import { TradingEngineDO, type AdminResult } from "./TradingEngineDO";

const cal = new TradingCalendar();
const report = (t: number): CycleReport => ({ t, phase: "OPEN", features: {}, convictions: {}, pressure: {}, decisions: [], entries: [], halted: null, errors: [], snapshot: null, perf: [] });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type KillReq = { engaged: boolean; squareOff: boolean; reason: string };

/** The members of TradingEngineDO these tests set or call (most are private in the class). */
interface Te {
  hot: { consecutiveErrors: number; lastError: string | null };
  agentHold: number;
  agentKillsDue: number;
  agent: unknown;
  agentInitError: string | null;
  agentAlerts: { send(text: string, o?: unknown): Promise<boolean> };
  followers: unknown[];
  tick(now: number): Promise<number>;
  runTick(): Promise<number>;
  agentStep(report: CycleReport, calendar: TradingCalendar, degraded: boolean, tickStartMs: number): Promise<void>;
  setKillSwitch(req: KillReq, actor: string, account?: string): Promise<AdminResult>;
  onNewScores(count: number): Promise<void>;
  endOfDay(): Promise<AdminResult>;
  statusText(): Promise<string>;
}

/** A TradingEngineDO without its constructor: the fields its agent glue reads, each replaceable. */
function makeTe(fields: Record<string, unknown> = {}): Te {
  const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
  const te = Object.create(TradingEngineDO.prototype) as object;
  Object.assign(te, {
    rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG },
    hot: { consecutiveErrors: 0, lastError: null, lastTickMs: null, lastOffHoursSnapshotMs: 0, lastReconcileMs: 0, reconcileMismatches: 0 },
    ticking: null,
    tickSoon: false,
    followers: [],
    relay: null,
    alerts: { send: async () => true },
    ctx: { storage: { setAlarm: async () => {}, put: async () => {}, getAlarm: async () => null } },
    agentEnabled: false,
    agentInitError: null,
    agent: null,
    agentAlerts: { send: async () => true },
    agentPreempt: null,
    agentStepping: false,
    agentHold: 0,
    agentKillsDue: 0,
    agentKillOwed: false,
    allResets: 0,
    liveData: "yahoo",
    paperQuotes: null,
    writeHeartbeat: async () => {},
    kickQuoteRecorder: () => {},
    calendarFor: () => cal,
    ...fields,
  });
  return te as Te;
}

/** An agent runner that uses its whole budget every step (a cold or silent AgentDO). */
function hangingAgent(o: { onKill?: (req: KillReq, opts: unknown) => Promise<void> } = {}) {
  const calls = { steps: 0, kills: [] as { at: number; req: KillReq; opts: unknown }[], stopped: [] as (() => boolean)[] };
  const agent = {
    step: (_report: CycleReport, _cal: TradingCalendar, _degraded: boolean, _deadlineMs: number, stopped: () => boolean) => {
      calls.steps++;
      calls.stopped.push(stopped);
      return new Promise<void>(() => {});
    },
    exitsOnly: async () => {},
    setKill: async (req: KillReq, _actor: string, opts: unknown) => {
      calls.kills.push({ at: Date.now(), req, opts });
      await o.onKill?.(req, opts);
      return { ok: true, message: "Agent kill switch engaged" };
    },
    statusLines: async () => [],
  };
  return { agent, calls };
}

/** A tick whose own work (trading cycle, exits, exit polls) takes mainWorkMs, then the agent's step, as tick() runs it. */
function fakeTick(mainWorkMs: number, starts: number[]) {
  return async function (this: Te, now: number): Promise<number> {
    starts.push(Date.now());
    await sleep(mainWorkMs);
    await this.agentStep(report(now), cal, false, now);
    return now + 30_000;
  };
}

describe("kills that square off: main first, the agent after", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-19T04:30:00.000Z")); // 10:00 IST
  });
  afterEach(() => vi.useRealTimers());

  /** Telegram /kill (or a kill of main) with main holding a LIVE position, an alarm tick in flight or not. */
  async function kill(o: { agent: boolean; mainWorkMs: number; inFlight: boolean; target?: "all" | "main" }) {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    // A LIVE position the square-off has not closed yet, so the relay panic goes out.
    await repo.positions.save({ id: "live-1", mode: "LIVE", status: "OPEN", index: "NIFTY", contract: { tradingSymbol: "NIFTY-LIVE" } } as unknown as Position);
    const starts: number[] = [];
    let panicAt: number | null = null;
    // The agent's kill step: its kv writes, audit row and a Telegram alert that takes 10 s (sendTelegram's timeout).
    const { agent, calls } = hangingAgent({ onKill: () => sleep(10_000) });
    const te = makeTe({
      rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG },
      relay: {
        panic: async () => {
          panicAt = Date.now();
          return { status: 200, body: "ok" };
        },
      },
      agentEnabled: o.agent,
      agent: o.agent ? agent : null,
      tick: fakeTick(o.mainWorkMs, starts),
    });
    if (o.inFlight) {
      void te.runTick();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const killAt = Date.now();
    const killing = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner /kill" }, "telegram", o.target ?? "all");
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await killing;
    expect((await repo.settings.get()).killSwitch).toBe(true);
    const squareOff = starts[o.inFlight ? 1 : 0];
    return { res, squareOffStart: squareOff - killAt, panic: (panicAt ?? Number.NaN) - killAt, kills: calls.kills.map((k) => ({ ...k, at: k.at - killAt })), steps: calls.steps };
  }

  it("Telegram /kill, positioned, a tick in flight: the square-off tick and the relay panic come as early as without the agent", async () => {
    const without = await kill({ agent: false, mainWorkMs: 22_000, inFlight: true });
    const withAgent = await kill({ agent: true, mainWorkMs: 22_000, inFlight: true });
    expect(without).toMatchObject({ squareOffStart: 21_000, panic: 43_000 });
    expect(withAgent.squareOffStart).toBe(without.squareOffStart);
    expect(withAgent.panic).toBe(without.panic);
    // No agent step ran in either tick; the agent's own kill came after the panic, alone, so it runs its own exits.
    expect(withAgent.steps).toBe(0);
    expect(withAgent.kills).toHaveLength(1);
    expect(withAgent.kills[0].at).toBeGreaterThanOrEqual(withAgent.panic);
    expect(withAgent.kills[0].req).toMatchObject({ engaged: true, squareOff: true });
    expect(withAgent.kills[0].opts).toMatchObject({ all: false });
    expect(withAgent.res).toEqual({ ok: true, message: "kill switch engaged; Agent kill switch engaged" });
  });

  it("Telegram /kill between ticks: main's square-off starts at once; the agent's kill step comes after it", async () => {
    const without = await kill({ agent: false, mainWorkMs: 22_000, inFlight: false });
    const withAgent = await kill({ agent: true, mainWorkMs: 22_000, inFlight: false });
    expect(without.squareOffStart).toBe(0);
    expect(withAgent.squareOffStart).toBe(0);
    expect(withAgent.panic).toBe(without.panic);
    expect(withAgent.kills[0].at).toBeGreaterThanOrEqual(withAgent.panic);
  });

  it("a kill of main that squares off: main first, then the agent's switch with its own exits", async () => {
    const without = await kill({ agent: false, mainWorkMs: 22_000, inFlight: true, target: "main" });
    const withAgent = await kill({ agent: true, mainWorkMs: 22_000, inFlight: true, target: "main" });
    expect(withAgent.squareOffStart).toBe(without.squareOffStart);
    expect(withAgent.panic).toBe(without.panic);
    expect(withAgent.kills).toHaveLength(1);
    expect(withAgent.kills[0].at).toBeGreaterThanOrEqual(withAgent.panic);
    expect(withAgent.kills[0].req).toEqual({ engaged: true, squareOff: true, reason: "main kill switch: owner /kill" });
    expect(withAgent.kills[0].opts).toMatchObject({ all: false });
    expect(withAgent.res).toEqual({ ok: true, message: "kill switch engaged" });
  });

  async function squareOffDelay(o: { agent: boolean; mainWorkMs: number; account?: string; followers?: unknown[] }): Promise<number> {
    const starts: number[] = [];
    const { agent } = hangingAgent();
    const te = makeTe({ agentEnabled: o.agent, agent: o.agent ? agent : null, tick: fakeTick(o.mainWorkMs, starts), followers: o.followers ?? [] });
    void te.runTick(); // an alarm tick is running
    await vi.advanceTimersByTimeAsync(1_000);
    const killAt = Date.now();
    const killing = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner /kill" }, "telegram", o.account ?? "all");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await killing).ok).toBe(true);
    expect(starts).toHaveLength(2);
    return starts[1] - killAt;
  }

  it("unpositioned, a kill during main's work: the tick's agent step is skipped (1 s, as without the agent; it was 13 s)", async () => {
    expect(await squareOffDelay({ agent: false, mainWorkMs: 2_000 })).toBe(1_000);
    expect(await squareOffDelay({ agent: true, mainWorkMs: 2_000 })).toBe(1_000);
  });

  it("a kill while the agent's step runs: TE stops waiting for it at once (it was its whole 12 s budget)", async () => {
    expect(await squareOffDelay({ agent: true, mainWorkMs: 500 })).toBe(0);
  });

  /** A kill with main's own switch write watched: the agent's hold when it is written, and after the kill. */
  async function holds(o: { target: "all" | "main"; squareOff: boolean; failWrite?: boolean }) {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    const atWrite: number[] = [];
    const update = repo.settings.update.bind(repo.settings);
    const { agent, calls } = hangingAgent();
    const te = makeTe({ rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG }, agentEnabled: true, agent, tick: fakeTick(1_000, []) });
    repo.settings.update = async (patch, by) => {
      atWrite.push(te.agentHold);
      if (o.failWrite) throw new Error("D1 write failed");
      return update(patch, by);
    };
    const killing = te.setKillSwitch({ engaged: true, squareOff: o.squareOff, reason: "owner /kill" }, "telegram", o.target).then(
      (res) => res,
      (err: unknown) => err as Error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return { res: await killing, atWrite, after: te.agentHold, agentKills: calls.kills.length };
  }

  it("a kill that squares off holds the agent before main's switch is written, and always lets it go after", async () => {
    for (const target of ["all", "main"] as const) {
      expect(await holds({ target, squareOff: true })).toMatchObject({ atWrite: [1], after: 0 });
      // Main's write fails: a kill of main fails with it, "all" carries on to the square-off; either way the hold ends.
      const failed = await holds({ target, squareOff: true, failWrite: true });
      expect(failed).toMatchObject({ atWrite: [1], after: 0 });
      if (target === "main") expect(failed.res).toEqual(new Error("D1 write failed"));
      else expect(failed.res).toMatchObject({ ok: false });
      // Main's switch stays off, so a kill of main leaves the agent's alone on its way out; "all" sets it in its own line.
      expect(failed.agentKills).toBe(target === "main" ? 0 : 1);
    }
  });

  it("a kill without a square-off never holds the agent", async () => {
    for (const target of ["all", "main"] as const) expect(await holds({ target, squareOff: false })).toMatchObject({ atWrite: [0], after: 0 });
  });

  it("a follower's square-off does not wait for a running agent step either", async () => {
    const base = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    const f = { spec: ACCOUNTS.small10k, cfg: accountConfig(DEFAULT_CONFIG, "small10k"), repo: accountRepository(base, "small10k", accountConfig(DEFAULT_CONFIG, "small10k"), Date.now), alerts: { send: async () => true }, errors: 0 };
    expect(await squareOffDelay({ agent: true, mainWorkMs: 500, account: "small10k", followers: [f] })).toBe(0);
  });

  it("a follower's square-off holds the agent from its start: the tick's agent step is skipped, as for main's kills (it was 13 s)", async () => {
    const base = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    const f = { spec: ACCOUNTS.small10k, cfg: accountConfig(DEFAULT_CONFIG, "small10k"), repo: accountRepository(base, "small10k", accountConfig(DEFAULT_CONFIG, "small10k"), Date.now), alerts: { send: async () => true }, errors: 0 };
    expect(await squareOffDelay({ agent: false, mainWorkMs: 2_000, account: "small10k", followers: [f] })).toBe(1_000);
    expect(await squareOffDelay({ agent: true, mainWorkMs: 2_000, account: "small10k", followers: [f] })).toBe(1_000);
    // The hold ends once the tick in progress is done, also when the follower's writes fail.
    const failing = { ...f, repo: { settings: { update: () => Promise.reject(new Error("D1 write failed")) } } };
    const { agent } = hangingAgent();
    const te = makeTe({ agentEnabled: true, agent, tick: fakeTick(1_000, []), followers: [failing] });
    const killing = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner" }, "dashboard", "small10k").then(
      (res) => res,
      (err: unknown) => err as Error,
    );
    expect(te.agentHold).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await killing).toEqual(new Error("D1 write failed"));
    expect(te.agentHold).toBe(0);
  });

  it("tells the running step when a kill pre-empts it: its stopped() turns true at the kill and stays so while the kill runs", async () => {
    const { agent, calls } = hangingAgent();
    const te = makeTe({ agentEnabled: true, agent, tick: fakeTick(500, []) });
    void te.runTick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.steps).toBe(1);
    const stopped = calls.stopped[0];
    expect(stopped()).toBe(false);
    // A kill without a square-off holds nothing and pre-empts nothing.
    await te.setKillSwitch({ engaged: true, squareOff: false, reason: "owner" }, "dashboard", "main");
    expect(stopped()).toBe(false);
    const killing = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner /kill" }, "telegram", "all");
    expect(stopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await killing;
    // Pre-empted: it stays stopped after the kill's hold has ended.
    expect(te.agentHold).toBe(0);
    expect(stopped()).toBe(true);
    // A step that no kill pre-empts is stopped only while a kill of main or of every account squares off.
    void te.runTick();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = calls.stopped.at(-1)!;
    expect(calls.stopped).toHaveLength(2);
    expect(next()).toBe(false);
    te.agentKillsDue++;
    expect(next()).toBe(true);
    te.agentKillsDue--;
  });

  it("a follower's square-off ends TE's wait for a running step without stopping it, and its square-off tick runs a step: it is not the agent's kill", async () => {
    const base = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    const fcfg = accountConfig(DEFAULT_CONFIG, "small10k");
    const f = { spec: ACCOUNTS.small10k, cfg: fcfg, repo: accountRepository(base, "small10k", fcfg, Date.now), alerts: { send: async () => true }, errors: 0 };
    const { agent, calls } = hangingAgent();
    const starts: number[] = [];
    const te = makeTe({ agentEnabled: true, agent, tick: fakeTick(500, starts), followers: [f] });
    void te.runTick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.steps).toBe(1);
    const killAt = Date.now();
    const killing = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner" }, "dashboard", "small10k");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await killing).ok).toBe(true);
    // The square-off tick starts at once. The step in progress carries on, its batch's exits and its calls to the
    // AgentDO included (it was stopped as if the agent were killed), and the square-off tick runs a step of its own
    // after its exits (it was skipped, and the waits ran only the agent's code exits until then).
    expect(starts[1] - killAt).toBe(0);
    expect(calls.steps).toBe(2);
    expect(calls.stopped.map((stopped) => stopped())).toEqual([false, false]);
    expect(te.agentHold).toBe(0);
  });

  /**
   * A kill that squares off (`first`) and, 100 ms after it, one without a square-off (`second`, the dashboard with the
   * box unticked), with main holding a LIVE position and one follower account. Times are from the first kill. With
   * `failPanic` the relay panic's read of main's LIVE positions fails, so the first kill throws after its square-off tick.
   */
  async function mixedKills(first: "all" | "main" | "small10k", second: "all" | "main" | null, failPanic = false) {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    await repo.positions.save({ id: "live-1", mode: "LIVE", status: "OPEN", index: "NIFTY", contract: { tradingSymbol: "NIFTY-LIVE" } } as unknown as Position);
    if (failPanic) {
      repo.positions.open = async () => {
        throw new Error("D1: LIVE positions read failed");
      };
    }
    let panicAt: number | null = null;
    const { agent, calls } = hangingAgent();
    const fcfg = accountConfig(DEFAULT_CONFIG, "small10k");
    const te = makeTe({
      rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG },
      relay: {
        panic: async () => {
          panicAt = Date.now();
          return { status: 200, body: "ok" };
        },
      },
      agentEnabled: true,
      agent,
      followers: [{ spec: ACCOUNTS.small10k, cfg: fcfg, repo: accountRepository(repo, "small10k", fcfg, Date.now), alerts: { send: async () => true }, errors: 0 }],
      tick: fakeTick(22_000, []),
    });
    void te.runTick();
    await vi.advanceTimersByTimeAsync(1_000);
    const killAt = Date.now();
    let k1At = Number.NaN;
    const k1 = te.setKillSwitch({ engaged: true, squareOff: true, reason: "owner /kill" }, "telegram", first).then(
      (res) => ((k1At = Date.now() - killAt), res),
      (err: unknown) => ((k1At = Date.now() - killAt), err as Error),
    );
    await vi.advanceTimersByTimeAsync(100);
    const k2 = second ? te.setKillSwitch({ engaged: true, squareOff: false, reason: "dashboard, box unticked" }, "dashboard", second) : null;
    await vi.advanceTimersByTimeAsync(120_000);
    const [r1, r2] = await Promise.all([k1, k2]);
    return { r1, r2, k1At, panic: (panicAt ?? Number.NaN) - killAt, kills: calls.kills.map((k) => ({ ...k, at: k.at - killAt })), hold: te.agentHold, mainKill: (await repo.settings.get()).killSwitch };
  }

  it("a kill without a square-off while one of main or of every account squares off leaves the agent's switch to that kill, after the panic", async () => {
    for (const [first, second] of [
      ["all", "main"],
      ["all", "all"],
      ["main", "main"],
      ["main", "all"],
    ] as const) {
      const at = `${first} with a square-off, then ${second} without`;
      const m = await mixedKills(first, second);
      expect(m.mainKill, at).toBe(true);
      expect(Number.isFinite(m.panic), at).toBe(true);
      // Only the first kill sets the agent's switch, after main's square-off and the panic, with its own exits.
      expect(m.kills, at).toHaveLength(1);
      expect(m.kills[0].at, at).toBeGreaterThanOrEqual(m.panic);
      expect(m.kills[0].req, at).toMatchObject({ engaged: true, squareOff: true });
      expect(m.r1, at).toMatchObject({ ok: true });
      expect(m.r2, at).toEqual(
        second === "all"
          ? { ok: true, message: `kill switch engaged; ${ACCOUNTS.small10k.shortLabel} kill switch engaged; Agent kill switch follows main's after the square-off in progress` }
          : { ok: true, message: "kill switch engaged" },
      );
      expect(m.hold, at).toBe(0);
    }
  });

  it("a kill of main or of every account that squares off and fails after its square-off tick still sets the agent's switch on its way out", async () => {
    for (const [first, second] of [
      ["all", "main"],
      ["all", "all"],
      ["main", "main"],
      ["main", "all"],
      ["all", null],
      ["main", null],
    ] as const) {
      const at = `${first} with a square-off, failing at its panic, then ${second ?? "no other kill"}`;
      const m = await mixedKills(first, second, true);
      expect(m.r1, at).toEqual(new Error("D1: LIVE positions read failed"));
      expect(m.mainKill, at).toBe(true);
      // Once, as the first kill fails (the second left it to that kill), with no exits of the agent's own: its code
      // exits close its positions at its next pass. A reset of main after that cannot leave the agent trading.
      expect(m.kills, at).toHaveLength(1);
      expect(m.kills[0].at, at).toBe(m.k1At);
      expect(m.kills[0].at, at).toBeGreaterThan(20_000);
      expect(m.kills[0].req, at).toEqual({ engaged: true, squareOff: false, reason: "main kill switch: owner /kill" });
      if (second) expect(m.r2, at).toMatchObject({ ok: true });
      expect(m.hold, at).toBe(0);
    }
  });

  it("a kill without a square-off during a follower's square-off sets the agent's switch at once, as without it (that kill sets none)", async () => {
    for (const second of ["main", "all"] as const) {
      const m = await mixedKills("small10k", second);
      expect(m.mainKill, second).toBe(true);
      expect(m.kills, second).toHaveLength(1);
      expect(m.kills[0].at, second).toBe(100);
      expect(m.kills[0].req, second).toMatchObject({ engaged: true, squareOff: false });
      expect(m.hold, second).toBe(0);
    }
  });

  /**
   * Kill-switch calls (`steps`, times from the first) with main holding a LIVE position and an alarm tick in flight
   * (22 s of main's work, so each square-off tick runs 22 s). `fail`: main's switch write or its kill audit insert fails
   * for the kill by that actor, or the relay panic's first read of main's LIVE positions fails.
   */
  async function overlap(
    steps: { at: number; target: string; engaged?: boolean; squareOff: boolean; actor: string }[],
    fail: { write?: string; audit?: string; panicRead?: boolean } = {},
  ) {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    await repo.positions.save({ id: "live-1", mode: "LIVE", status: "OPEN", index: "NIFTY", contract: { tradingSymbol: "NIFTY-LIVE" } } as unknown as Position);
    const update = repo.settings.update.bind(repo.settings);
    repo.settings.update = async (patch, by) => {
      if (patch.killSwitch === true && by === fail.write) throw new Error("D1: main settings write failed");
      return update(patch, by);
    };
    const append = repo.audit.append.bind(repo.audit);
    repo.audit.append = async (e) => {
      if (e.action === "kill" && e.actor === fail.audit) throw new Error("D1: kill audit insert failed");
      return append(e);
    };
    const open = repo.positions.open.bind(repo.positions);
    let liveReads = 0;
    repo.positions.open = async (mode) => {
      if (fail.panicRead && mode === "LIVE" && liveReads++ === 0) throw new Error("D1: LIVE positions read failed");
      return open(mode);
    };
    const panics: number[] = [];
    const { agent, calls } = hangingAgent();
    const te = makeTe({
      rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG },
      relay: {
        panic: async () => {
          panics.push(Date.now());
          return { status: 200, body: "ok" };
        },
      },
      agentEnabled: true,
      agent,
      tick: fakeTick(22_000, []),
    });
    void te.runTick();
    await vi.advanceTimersByTimeAsync(1_000);
    const t0 = Date.now();
    const results: Promise<AdminResult | Error>[] = [];
    for (const s of steps) {
      await vi.advanceTimersByTimeAsync(t0 + s.at - Date.now());
      results.push(
        te.setKillSwitch({ engaged: s.engaged ?? true, squareOff: s.squareOff, reason: s.actor }, s.actor, s.target).then(
          (res) => res,
          (err: unknown) => err as Error,
        ),
      );
    }
    await vi.advanceTimersByTimeAsync(240_000);
    return {
      res: await Promise.all(results),
      panics: panics.map((at) => at - t0),
      // The agent's kill switch set (a reset of every account resets it too: left out here).
      agentKills: calls.kills.filter((k) => k.req.engaged).map((k) => ({ at: k.at - t0, req: k.req })),
      hold: te.agentHold,
      due: te.agentKillsDue,
      mainKill: (await repo.settings.get()).killSwitch,
    };
  }

  it("a kill of main that squares off and fails at its switch write or kill audit row while another squares off leaves the agent's switch to that one, after its panic", async () => {
    for (const first of ["main", "all"]) {
      for (const failAt of ["write", "audit"] as const) {
        const at = `${first} with a square-off, then main with one failing at its ${failAt}`;
        const m = await overlap(
          [
            { at: 0, target: first, squareOff: true, actor: "telegram" },
            { at: 100, target: "main", squareOff: true, actor: "dashboard" },
          ],
          { [failAt]: "dashboard" },
        );
        expect(m.res[1], at).toBeInstanceOf(Error);
        expect(m.panics, at).toHaveLength(1);
        // Once, after the first kill's square-off tick and panic, with the agent's own exits (it was set 0.1 s in).
        expect(m.agentKills, at).toHaveLength(1);
        expect(m.agentKills[0].at, at).toBeGreaterThanOrEqual(m.panics[0]);
        expect(m.agentKills[0].req, at).toMatchObject({ engaged: true, squareOff: true });
        expect([m.hold, m.due], at).toEqual([0, 0]);
      }
    }
  });

  it("a kill that squares off and fails at its panic while a later one squares off leaves the agent's switch to the later one, after its panic", async () => {
    for (const first of ["main", "all"]) {
      for (const second of ["main", "all"]) {
        const at = `${first} failing at its panic, then ${second} during its square-off tick`;
        const m = await overlap(
          [
            { at: 0, target: first, squareOff: true, actor: "telegram" },
            { at: 30_000, target: second, squareOff: true, actor: "dashboard" },
          ],
          { panicRead: true },
        );
        expect(m.res[0], at).toEqual(new Error("D1: LIVE positions read failed"));
        expect(m.res[1], at).toMatchObject({ ok: true });
        // The later kill's panic, after its own square-off tick (43 s to 65 s).
        expect(m.panics, at).toEqual([65_000]);
        // Once, after that panic (it was set at 43 s, as the first kill failed).
        expect(m.agentKills, at).toHaveLength(1);
        expect(m.agentKills[0].at, at).toBe(65_000);
        expect([m.hold, m.due], at).toEqual([0, 0]);
      }
    }
  });

  it("a kill that squares off and fails at its panic still sets the agent's switch on its way out after a reset of main during it", async () => {
    for (const first of ["main", "all"]) {
      for (const withLater of [false, true]) {
        const at = `${first} failing at its panic, main reset at 30 s${withLater ? ", a kill of main without a square-off at 1 s" : ""}`;
        const steps: Parameters<typeof overlap>[0] = [{ at: 0, target: first, squareOff: true, actor: "telegram" }];
        if (withLater) steps.push({ at: 1_000, target: "main", squareOff: false, actor: "dashboard" });
        steps.push({ at: 30_000, target: "main", engaged: false, squareOff: false, actor: "owner" });
        const m = await overlap(steps, { panicRead: true });
        expect(m.mainKill, at).toBe(false);
        // On its way out at 43 s, without the agent's own exits: the reset of main did not leave the agent trading.
        expect(m.agentKills, at).toEqual([{ at: 43_000, req: { engaged: true, squareOff: false, reason: "main kill switch: telegram" } }]);
        expect([m.hold, m.due], at).toEqual([0, 0]);
      }
    }
  });

  it("a reset of every account during a kill that squares off leaves the agent reset, unless a kill after the reset owes its switch", async () => {
    for (const first of ["main", "all"]) {
      const kill = { at: 0, target: first, squareOff: true, actor: "telegram" };
      const reset = { at: 100, target: "all", engaged: false, squareOff: false, actor: "owner" };
      const m = await overlap([kill, reset]);
      expect(m.mainKill, first).toBe(false);
      expect(m.panics, first).toHaveLength(1);
      // The kill no longer sets the agent's switch after its panic (it did, leaving main reset and the agent killed).
      expect(m.agentKills, first).toEqual([]);
      if (first === "all") expect(m.res[0], first).toMatchObject({ message: expect.stringContaining("Agent kill switch not set: every account was reset after this kill came in") });
      // A kill of main without a square-off after the reset leaves the agent's switch to the running kill: after its panic.
      const again = await overlap([kill, reset, { at: 2_000, target: "main", squareOff: false, actor: "dashboard" }]);
      expect(again.mainKill, first).toBe(true);
      expect(again.agentKills, first).toHaveLength(1);
      expect(again.agentKills[0].at, first).toBeGreaterThanOrEqual(again.panics[0]);
      expect([again.hold, again.due], first).toEqual([0, 0]);
    }
  });
});

describe("the agent's budget and main's next alarm", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-19T04:30:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function nextAlarm(agentOn: boolean, mainWorkMs: number): Promise<{ inMs: number; steps: number }> {
    const alarms: number[] = [];
    const { agent, calls } = hangingAgent();
    const te = makeTe({
      agentEnabled: agentOn,
      agent: agentOn ? agent : null,
      ctx: { storage: { setAlarm: async (ms: number) => void alarms.push(ms), put: async () => {}, getAlarm: async () => null } },
      tick: fakeTick(mainWorkMs, []),
    });
    const t0 = Date.now();
    const p = te.runTick();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    return { inMs: alarms[0] - t0, steps: calls.steps };
  }

  it("ends the step before main's next alarm is due, however long main's own work took", async () => {
    expect((await nextAlarm(false, 29_000)).inMs).toBe(30_000);
    // 29 s of main's work: under a second is left, so the step is skipped (it was +34 s with the 4 s minimum).
    expect(await nextAlarm(true, 29_000)).toEqual({ inMs: 30_000, steps: 0 });
    // 26 s: the step gets the 2.5 s left before the alarm's margin (it was +31 s).
    expect(await nextAlarm(true, 26_000)).toEqual({ inMs: 30_000, steps: 1 });
    expect(await nextAlarm(true, 20_000)).toEqual({ inMs: 30_000, steps: 1 });
  });

  /** New event scores `scoresAfterMs` into an alarm tick whose own work takes 2 s: main's next alarm, from the scores. */
  async function alarmAfterScores(agentOn: boolean, scoresAfterMs: number): Promise<{ inMs: number; steps: number }> {
    // One alarm, as Durable Object storage keeps it: none is pending while the alarm's own tick runs.
    let pending: number | null = null;
    const { agent, calls } = hangingAgent();
    const te = makeTe({
      agentEnabled: agentOn,
      agent: agentOn ? agent : null,
      ctx: {
        storage: {
          setAlarm: async (ms: number) => {
            pending = ms;
          },
          put: async () => {},
          getAlarm: async () => pending,
        },
      },
      tick: fakeTick(2_000, []),
    });
    const tick = te.runTick();
    await vi.advanceTimersByTimeAsync(scoresAfterMs);
    const scoresAt = Date.now();
    const scores = te.onNewScores(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([tick, scores]);
    return { inMs: (pending ?? Number.NaN) - scoresAt, steps: calls.steps };
  }

  it("new event scores while the agent's step runs: main's tick comes 2 s after them, as without the agent", async () => {
    for (const after of [2_500, 4_000, 9_000]) {
      expect((await alarmAfterScores(false, after)).inMs, `${after} ms`).toBe(2_000);
      // The step runs from 2 s; TE stops waiting for it (it carries on), so the tick sets main's next alarm first (the
      // tick's own alarm, 30 s after its start, replaced the 2 s one when the step ended).
      expect(await alarmAfterScores(true, after), `${after} ms`).toEqual({ inMs: 2_000, steps: 1 });
    }
  });
});

describe("an agent that could not start", () => {
  it("never throws its alert into main's tick: main's error count stays at 0", async () => {
    const te = makeTe({
      agentEnabled: true,
      agent: null,
      agentInitError: "the agent's pinned config failed validation",
      agentAlerts: {
        send: async () => {
          throw new Error("state store read failed (transient)");
        },
      },
      tick: fakeTick(0, []),
    });
    await te.runTick();
    expect(te.hot.consecutiveErrors).toBe(0);
    expect(te.hot.lastError).toBeNull();
  });

  it("a config valid for main but not with the agent's pins: TE starts, ticks main and reports the agent as not running", async () => {
    // A later change to main's defaults: entries until 15:10, square-off 15:20 (valid for main; the agent squares off at 15:05).
    const patch = { gates: { noEntryAfterIst: "15:10" }, exits: { squareOffIst: "15:20" }, features: { indicatorCutoffIst: "15:25" } } as const;
    const saved = structuredClone({ gates: DEFAULT_CONFIG.gates, exits: DEFAULT_CONFIG.exits, features: DEFAULT_CONFIG.features });
    const env = { ACCOUNTS: "main,small10k,small5k,agent", AGENT_MODE: "shadow", ENGINE_ENV: "test", DB: {}, KV: {} } as unknown as Env;
    const ctx = {
      storage: { get: async () => undefined, put: async () => {}, setAlarm: async () => {}, getAlarm: async () => null },
      blockConcurrencyWhile: (f: () => Promise<void>) => f(),
      waitUntil: () => {},
    } as unknown as DurableObjectState;
    Object.assign(DEFAULT_CONFIG.gates, patch.gates);
    Object.assign(DEFAULT_CONFIG.exits, patch.exits);
    Object.assign(DEFAULT_CONFIG.features, patch.features);
    try {
      expect(() => accountConfig(DEFAULT_CONFIG, "agent")).toThrow(/noEntryAfterIst must be before exits.squareOffIst/);
      const te = new TradingEngineDO(ctx, env) as unknown as Te;
      expect(te.agent).toBeNull();
      expect(te.agentInitError).toMatch(/noEntryAfterIst must be before exits.squareOffIst/);
      expect(te.followers).toHaveLength(2);
      // Main's tick runs; the agent's part only sends its "could not start" alert.
      const alerts: string[] = [];
      const starts: number[] = [];
      Object.assign(te, {
        agentAlerts: { send: async (text: string) => (alerts.push(text), true) },
        tick: fakeTick(0, starts),
        writeHeartbeat: async () => {},
        kickQuoteRecorder: () => {},
      });
      await te.runTick();
      expect(starts).toHaveLength(1);
      expect(te.hot.consecutiveErrors).toBe(0);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(/is in ACCOUNTS but could not start, so it stays off: .*noEntryAfterIst must be before exits\.squareOffIst/);
    } finally {
      Object.assign(DEFAULT_CONFIG.gates, saved.gates);
      Object.assign(DEFAULT_CONFIG.exits, saved.exits);
      Object.assign(DEFAULT_CONFIG.features, saved.features);
    }
  });
});

describe("main's kill switch and the agent's", () => {
  it("main's kill engages the agent's at once: a reset of main 15 s later leaves the agent's on", async () => {
    let now = istAt("2026-10-19", "10:00");
    const clock = { now: () => now, sleep: async () => {} };
    const base = new InMemoryRepository(DEFAULT_CONFIG, now);
    const agentCfg = accountConfig(DEFAULT_CONFIG, "agent");
    const agentRepo: Repository = accountRepository(base, "agent", agentCfg, () => now);
    const kept = new Map<string, unknown>();
    const runner = new AgentRunner({
      account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo: agentRepo },
      mainRepo: base,
      settings: { mode: "paper", reflexModel: "r", escalationModel: "d", reviewModel: "d", dailyUsdCap: 3, escalationsPerDay: 8 },
      storage: { get: async <T,>(k: string) => (kept.has(k) ? (structuredClone(kept.get(k)) as T) : undefined), put: async <T,>(k: string, v: T) => void kept.set(k, structuredClone(v)) },
      agentDo: { submitBar: async () => ({ accepted: true, reason: null }), takeDecisions: async () => null, recordExecution: async () => {} },
      feed: { getOptionFlowAsOf: async () => null },
      quotes: null,
      instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
      marketContext: new MarketContextStore(),
      alerts: { send: async () => true },
      logger: silentLogger,
      calendar: cal,
      clock,
    });
    const te = makeTe({ rt: { logger: silentLogger, repo: base, calendar: cal, cfg: DEFAULT_CONFIG }, agentEnabled: true, agent: runner });
    now += 5_000;
    expect(await te.setKillSwitch({ engaged: true, squareOff: false, reason: "owner" }, "owner", "main")).toEqual({ ok: true, message: "kill switch engaged" });
    expect(await agentRepo.settings.get()).toMatchObject({ killSwitch: true, killReason: "main kill switch: owner" });
    now += 15_000;
    expect((await te.setKillSwitch({ engaged: false, squareOff: false, reason: "" }, "owner", "main")).ok).toBe(true);
    expect((await base.settings.get()).killSwitch).toBe(false);
    // Resetting main never resets the agent's.
    expect((await agentRepo.settings.get()).killSwitch).toBe(true);
  });

  it("a kill of main without a square-off that fails after main's switch is written still engages the agent's at once", async () => {
    for (const failAt of ["audit", "alert"] as const) {
      let now = istAt("2026-10-19", "10:00");
      const clock = { now: () => now, sleep: async () => {} };
      const base = new InMemoryRepository(DEFAULT_CONFIG, now);
      const append = base.audit.append.bind(base.audit);
      // Main's own kill row (the agent's carry "…@agent").
      base.audit.append = async (e) => {
        if (failAt === "audit" && e.action === "kill" && e.actor === "owner") throw new Error("D1: kill audit insert failed");
        return append(e);
      };
      const agentCfg = accountConfig(DEFAULT_CONFIG, "agent");
      const agentRepo: Repository = accountRepository(base, "agent", agentCfg, () => now);
      const kept = new Map<string, unknown>();
      const runner = new AgentRunner({
        account: { spec: ACCOUNTS.agent, cfg: agentCfg, repo: agentRepo },
        mainRepo: base,
        settings: { mode: "paper", reflexModel: "r", escalationModel: "d", reviewModel: "d", dailyUsdCap: 3, escalationsPerDay: 8 },
        storage: { get: async <T,>(k: string) => (kept.has(k) ? (structuredClone(kept.get(k)) as T) : undefined), put: async <T,>(k: string, v: T) => void kept.set(k, structuredClone(v)) },
        agentDo: { submitBar: async () => ({ accepted: true, reason: null }), takeDecisions: async () => null, recordExecution: async () => {} },
        feed: { getOptionFlowAsOf: async () => null },
        quotes: null,
        instruments: { expiries: async () => [], resolve: async () => null, strikes: async () => [] },
        marketContext: new MarketContextStore(),
        alerts: { send: async () => true },
        logger: silentLogger,
        calendar: cal,
        clock,
      });
      const te = makeTe({
        rt: { logger: silentLogger, repo: base, calendar: cal, cfg: DEFAULT_CONFIG },
        agentEnabled: true,
        agent: runner,
        alerts: {
          send: async (text: string) => {
            if (failAt === "alert" && text.startsWith("🛑 KILL SWITCH")) throw new Error("Telegram: KILL alert failed");
            return true;
          },
        },
      });
      now += 5_000;
      await expect(te.setKillSwitch({ engaged: true, squareOff: false, reason: "owner" }, "owner", "main"), failAt).rejects.toThrow();
      expect((await base.settings.get()).killSwitch, failAt).toBe(true);
      // Engaged with main's on its way out (it was left to the agent's next step, so a reset of main before it left the
      // agent trading).
      expect(await agentRepo.settings.get(), failAt).toMatchObject({ killSwitch: true, killReason: "main kill switch: owner" });
      now += 2_000;
      expect((await te.setKillSwitch({ engaged: false, squareOff: false, reason: "" }, "owner", "main")).ok, failAt).toBe(true);
      expect((await agentRepo.settings.get()).killSwitch, failAt).toBe(true);
    }
  });
});

describe("the end of day with a silent AgentDO", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:30:00.000Z")); // 16:00 IST
  });
  afterEach(() => vi.useRealTimers());

  async function summary(agentDoAnswers: boolean): Promise<{ sent: string[]; doneAfterMs: number | null }> {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, Date.now());
    const sent: string[] = [];
    const deps = () => ({
      cfg: DEFAULT_CONFIG,
      clock: systemClock,
      calendar: cal,
      repo,
      market: { snapshot: async (t: number) => ({ t, candles: {}, daily: {}, ltp: {}, dataAgeSec: 0 }) },
      mode: "PAPER",
      logger: silentLogger,
    });
    const te = makeTe({
      rt: { logger: silentLogger, repo, calendar: cal, cfg: DEFAULT_CONFIG },
      alerts: { send: async (text: string) => (sent.push(text), true) },
      agentEnabled: true,
      agent: { deps, afterEndOfDay: async () => "Agent (paper experiment, shadow): no trades" },
      env: { AGENT_DO: { idFromName: () => "agent", get: () => ({ scheduleReview: () => (agentDoAnswers ? Promise.resolve() : new Promise(() => {})) }) } },
      deps,
    });
    const t0 = Date.now();
    let doneAt: number | null = null;
    void te.endOfDay().then(() => (doneAt = Date.now()));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    return { sent, doneAfterMs: doneAt === null ? null : doneAt - t0 };
  }

  it("still sends main's summary: the review request waits at most 5 s (the POSTMARKET cron asks again)", async () => {
    const answered = await summary(true);
    expect(answered.doneAfterMs).toBe(0);
    expect(answered.sent.filter((t) => /summary/.test(t))).toHaveLength(1);
    const silent = await summary(false);
    expect(silent.doneAfterMs).toBe(5_000);
    expect(silent.sent).toHaveLength(1);
    expect(silent.sent[0]).toMatch(/^📊 2026-10-19 summary\n/);
    expect(silent.sent[0]).toContain("Agent (paper experiment, shadow): no trades");
  });
});

describe("Telegram /status and the AgentDO", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z")); // 15:30 IST
  });
  afterEach(() => vi.useRealTimers());

  const status: AgentStatus = {
    mode: "shadow",
    paused: false,
    nextJobMs: istAt("2026-10-19", "16:20"),
    spentUsd: 0.1234,
    capUsd: 3,
    lastBatch: { barCloseMs: istAt("2026-10-19", "15:05"), status: "OK" },
    instructionVersion: "core-2/78fd38db",
  };

  function statusTe(agentDoStatus: () => Promise<AgentStatus>): Te {
    return makeTe({
      agentEnabled: true,
      agent: { statusLines: async () => ["Agent (paper experiment): mode shadow · kill switch off"] },
      env: { AGENT_DO: { idFromName: () => "agent", get: () => ({ status: agentDoStatus }) } },
    });
  }

  it("adds the AgentDO's line: mode, pause, next job, today's spend against the cap and the last batch", async () => {
    const text = await statusTe(async () => status).statusText();
    const lines = text.split("\n");
    expect(lines.at(-2)).toBe("Agent (paper experiment): mode shadow · kill switch off");
    expect(lines.at(-1)).toBe("  AgentDO: mode shadow · next job 16:20 · spent $0.123 of $3.00 today · last batch 15:05 OK");
    const paused = await statusTe(async () => ({ ...status, paused: true, nextJobMs: istAt("2026-10-20", "09:20"), lastBatch: null })).statusText();
    expect(paused.split("\n").at(-1)).toBe("  AgentDO: mode shadow · PAUSED · next job 2026-10-20 09:20 · spent $0.123 of $3.00 today · last batch none");
  });

  it("never waits more than 3 s for it, and never fails because of it", async () => {
    const pending = statusTe(() => new Promise<AgentStatus>(() => {})).statusText();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).split("\n").at(-1)).toBe("  AgentDO: no answer within 3 s");
    const failing = await statusTe(async () => {
      throw new Error("Durable Object reset");
    }).statusText();
    expect(failing.split("\n").at(-1)).toBe("  AgentDO: status unavailable (Durable Object reset)");
  });
});
