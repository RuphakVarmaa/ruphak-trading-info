import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import type { AdvisorIdea, AdvisorReport, AdvisorView } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, FixedClock, istAt, istIso, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { sequentialIds, silentLogger, type LlmUsage } from "../ports";
import type { IndexId } from "../types";
import { AGENT_META, AgentBrain, type AgentBrainDeps } from "./brain";
import { AGENT_POLICY, REVIEW_CALL, USER_MESSAGE_TOKEN_LIMIT } from "./constants";
import { worstCaseUsd } from "./cost";
import type { DeepJudge, DeepRequest, DeepResponse, ReflexJudge, ReflexRequest, ReflexResponse } from "./judge";
import { instructionVersion } from "./prompt";
import { MemoryAgentStore } from "./store";
import { agentSample } from "./storeContract";
import type { AgentSettings, AgentStore, CallStatus, DecisionRecord, IndexSnapshot, ReflexDecision, ReflexInput, ReviewOut } from "./types";

const DAY = "2026-10-19";
const B0 = istAt(DAY, "10:30");
const bar = (k: number) => B0 + k * 5 * MINUTE_MS;
const cfg = accountConfig(DEFAULT_CONFIG, "agent");
const cal = new TradingCalendar();
const REFLEX_MODEL = "claude-haiku-5-5";
const DEEP_MODEL = "claude-opus-5-5";
const USAGE: LlmUsage = { inputTokens: 1_700, outputTokens: 900, cacheReadTokens: 1_300, cacheCreationTokens: 0 };

// ---------------------------------------------------------------------------
// Test-local fakes
// ---------------------------------------------------------------------------

type ReflexAnswer = ReflexDecision[] | { status: Exclude<CallStatus, "OK">; usage?: LlmUsage | null } | "throw";

class TestReflex implements ReflexJudge {
  readonly kind = "fake" as const;
  readonly model = REFLEX_MODEL;
  calls: ReflexRequest[] = [];
  onCall: ((req: ReflexRequest) => Promise<void>) | null = null;
  constructor(private readonly answer: (req: ReflexRequest) => ReflexAnswer) {}
  async judge(req: ReflexRequest): Promise<ReflexResponse> {
    this.calls.push(req);
    if (this.onCall) await this.onCall(req);
    const a = this.answer(req);
    if (a === "throw") throw new Error("network down");
    if (!Array.isArray(a)) return { status: a.status, decisions: [], dropped: [], usage: a.usage ?? null, model: this.model, latencyMs: 2_000, error: `${a.status} from the fake` };
    return { status: "OK", decisions: a, dropped: [], usage: USAGE, model: this.model, latencyMs: 1_500, error: null };
  }
}

class TestDeep implements DeepJudge {
  readonly model = DEEP_MODEL;
  calls: DeepRequest<unknown>[] = [];
  constructor(private readonly answer: (req: DeepRequest<unknown>) => unknown) {}
  async structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    this.calls.push(req as DeepRequest<unknown>);
    const a = this.answer(req as DeepRequest<unknown>);
    if (a === "fail") return { status: "ERROR", parsed: null, usage: null, model: this.model, latencyMs: 9_000, error: "the fake failed" };
    return { status: "OK", parsed: req.schema.parse(a), usage: { inputTokens: 5_000, outputTokens: 2_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 }, model: this.model, latencyMs: 30_000, error: null };
  }
}

const dec = (finalistId: string, o: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId, regime: "TRENDING", direction: "NEUTRAL", directionConfidence: 0.45, toxicFlow: false, setupQuality: 1, riskState: "SAFE", reason: "returns disagree", ...o,
});
/** Answers every finalist it is given: NEUTRAL unless `over` says otherwise. */
const answerAll = (over: Record<string, Partial<ReflexDecision>> = {}) => (req: ReflexRequest) => req.finalists.map((f) => dec(f.id, over[f.id] ?? {}));

const snapshot = (index: IndexId, close: number): IndexSnapshot => ({
  c: close, r5: 8, r15: 12, r60: 20, ro: 30, vw: -10, vz: 0.6, orh: -5, orl: 25, ors: "U", pdh: -40, pdl: 70, pdc: 30,
  rsi: 60, adx: 26, di: 8, st: 1, rv: 12, atr: 8, vix: 13.2, vixc: -1.5,
  o: { k: index === "NIFTY" ? 25_000 : 82_000, cm: 110, cs: 60, pm: 95, ps: 70, iv: 13, ivx: -0.2, pcr: 0.9, mp: -5, cw: 40, pw: -60, bc: [1, 0, 2, 0], bp: [0, 2, 0, 1], oa: 45 },
  cv: 0.2, rg: "TU", pv: "C", pn: "kkkkk", ew: 1, dte: 5, xd: 0, bk: { pos: "-", lots: 0, pnl: null, dd: 0, dl: 0 },
});
const closeAt = (index: IndexId, ms: number) => (index === "NIFTY" ? 25_000 : 82_000) + Math.round((ms - istAt(DAY, "09:15")) / (5 * MINUTE_MS)) * (index === "NIFTY" ? 10 : 30);
const input = (T: number, o: { only?: IndexId[] } = {}): ReflexInput => {
  const indices: IndexId[] = o.only ?? ["NIFTY", "SENSEX"];
  const snapshots: ReflexInput["snapshots"] = {};
  const tokensEst: ReflexInput["tokensEst"] = {};
  for (const i of indices) {
    snapshots[i] = snapshot(i, closeAt(i, T));
    tokensEst[i] = 280;
  }
  return { barCloseMs: T, date: DAY, builtMs: T + 35_000, snapshots, tokensEst, closes: { NIFTY: closeAt("NIFTY", T), SENSEX: closeAt("SENSEX", T) }, problems: [] };
};

const idea = (id: string, o: Partial<AdvisorIdea> = {}): AdvisorIdea =>
  ({
    id, horizon: "TODAY",
    contract: { index: "NIFTY", expiry: "2026-10-27", strike: 25_100, optionType: "CE", tradingSymbol: "NIFTY26O2725100CE", lotSize: 65, label: "NIFTY 25100 CE 27 Oct" },
    entry: { low: 100, high: 115, ask: 112, asOf: istIso(B0) }, stop: 80, target: 160, exitBy: `${DAY}T15:05:00+05:30`, lots: 1, costPerLot: 7_280, maxLossPerLot: 2_080, rewardPerLot: 3_120,
    breakevenAtExpiry: 25_212, delta: 0.45, iv: 13, probItm: 0.4, why: ["call short covering near 25,100", "FII buying"], wrongIf: "NIFTY closes below 24,950",
    confidence: "LOW", condition: "Only if NIFTY holds above 25,050", bearCase: "a reversal from the call wall", ...o,
  }) as AdvisorIdea;
const brief = (id: string, createdMs: number, ideas: AdvisorIdea[] = [idea("i1")]): AdvisorReport =>
  ({
    id, createdAt: istIso(createdMs), model: "brief", durationMs: 1, costUsd: 0.2, market: { nifty: 25_000, sensex: 82_000, vix: 13, phase: "OPEN" },
    headline: `Brief ${id}: buy the dip only above 25,050`, today: { action: "WAIT", summary: "wait", ideaId: ideas[0]?.id ?? null }, outlook: [],
    factors: [{ key: "FII_FLOWS", label: "Foreign funds", reading: "SUPPORTS_UP", detail: "net buyers", source: "web research" }], ideas, zeroHero: { applicable: false, expiry: null, summary: "" },
    premium: { verdict: "NORMAL", detail: "" }, alsoKnow: [], avoid: [], sources: [], honesty: "no edge",
  }) as unknown as AdvisorReport;

interface Harness {
  brain: AgentBrain;
  store: AgentStore;
  clock: FixedClock;
  reflex: TestReflex;
  deep: TestDeep;
  briefs: { latest: AdvisorReport | null };
  archive: Map<IndexId, { t: number; c: number }[]>;
}

function harness(o: { answer?: (req: ReflexRequest) => ReflexAnswer; deep?: (req: DeepRequest<unknown>) => unknown; settings?: Partial<AgentSettings>; noKey?: boolean; store?: AgentStore; start?: number } = {}): Harness {
  const store = o.store ?? new MemoryAgentStore();
  const clock = new FixedClock(o.start ?? B0 + 40_000);
  const reflex = new TestReflex(o.answer ?? answerAll());
  const deep = new TestDeep(o.deep ?? (() => "fail"));
  const briefs: { latest: AdvisorReport | null } = { latest: null };
  const archive = new Map<IndexId, { t: number; c: number }[]>();
  const deps: AgentBrainDeps = {
    store,
    settings: { mode: "shadow", reflexModel: REFLEX_MODEL, escalationModel: DEEP_MODEL, reviewModel: DEEP_MODEL, dailyUsdCap: 3, escalationsPerDay: 8, ...o.settings },
    reflex: o.noKey ? null : reflex,
    escalation: o.noKey ? null : deep,
    review: o.noKey ? null : deep,
    advisor: async () => ({ latest: briefs.latest }) as AdvisorView,
    barsFallback: async (index, fromMs, toMs) => (archive.get(index) ?? []).filter((r) => r.t >= fromMs && r.t < toMs),
    calendar: cal,
    cfg,
    now: () => clock.now(),
    newId: sequentialIds("x"),
    logger: silentLogger,
  };
  return { brain: new AgentBrain(deps), store, clock, reflex, deep, briefs, archive };
}

/** Submits bar k (at its close + 40 s) and runs the alarm. */
async function step(h: Harness, k: number, o: { only?: IndexId[] } = {}) {
  h.clock.set(bar(k) + 40_000);
  const res = await h.brain.submitBar(input(bar(k), o));
  await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
  return res;
}

/** The whole session in the archive (bars_5m: t is the bar's open). */
function fillArchive(h: Harness, upTo = istAt(DAY, "15:30")) {
  for (const index of ["NIFTY", "SENSEX"] as IndexId[]) {
    const rows: { t: number; c: number }[] = [];
    for (let close = istAt(DAY, "09:20"); close <= upTo; close += 5 * MINUTE_MS) rows.push({ t: close - 5 * MINUTE_MS, c: closeAt(index, close) });
    h.archive.set(index, rows);
  }
}

/** Graded reflex history on earlier days, nine calls a day 40 minutes apart (no 30-minute windows overlap); most paid. */
async function seedHistory(store: AgentStore, n: number, version: string) {
  const rows: DecisionRecord[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(DAY, -(1 + Math.floor(i / 9)));
    const t = istAt(date, "09:30") + (i % 9) * 40 * MINUTE_MS;
    rows.push(agentSample.decision({ id: `h${i}`, date, barCloseMs: t, instructionVersion: version, directionConfidence: 0.9, outcome: agentSample.outcome({ status: "HIT", y: 1, paid: i % 10 !== 0 }) }));
  }
  await store.putDecisions(rows);
}

// ---------------------------------------------------------------------------

describe("AgentBrain: bars and the reflex job", () => {
  it("submitBar → runDue → takeDecisions gives the bar's batch with sizing hints from measured results only", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } }) });
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: null });
    expect(h.reflex.calls).toHaveLength(0);
    const next = await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(next).toBeNull();
    expect(h.reflex.calls).toHaveLength(1);
    expect(h.reflex.calls[0].finalists.map((f) => f.id)).toEqual(["gen:NIFTY", "gen:SENSEX"]);
    expect(h.reflex.calls[0].guidance).toBe((await h.store.activeInstruction())!.guidance);

    const b = (await h.brain.takeDecisions(0))!;
    expect(b.barCloseMs).toBe(bar(0));
    expect(b.status).toBe("OK");
    expect(b.decisions.map((d) => [d.finalistId, d.direction, d.source, d.effective])).toEqual([
      ["gen:NIFTY", "LONG", "REFLEX", true],
      ["gen:SENSEX", "NEUTRAL", "REFLEX", true],
    ]);
    const long = b.decisions[0];
    expect(long.sizing).not.toBeNull();
    // With no graded history the cautious estimate stays below a coin flip, so Kelly is not above zero.
    expect(long.sizing!.p).toBeLessThan(0.5);
    expect(b.decisions[1].sizing).toBeNull();
    expect(b.payoff).toEqual({ b: 1, n: 0 });
    expect(await h.brain.takeDecisions(bar(0))).toBeNull();
    const [call] = await h.store.calls(DAY);
    expect(call).toMatchObject({ kind: "REFLEX", status: "OK", barCloseMs: bar(0), model: REFLEX_MODEL, usage: USAGE });
    expect(call.costUsd).toBeGreaterThan(0);
    expect(b.callId).toBe(call.id);
    expect((await h.store.bars(DAY)).map((x) => [x.index, x.close])).toEqual([
      ["NIFTY", closeAt("NIFTY", bar(0))],
      ["SENSEX", closeAt("SENSEX", bar(0))],
    ]);
  });

  it("sizes on graded history once it exists (p above one half after many paid calls)", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } }) });
    await seedHistory(h.store, 600, (await h.brain.status()).instructionVersion);
    await step(h, 0);
    const b = (await h.brain.takeDecisions(0))!;
    expect(b.decisions[0].sizing!.p).toBeGreaterThan(0.5);
    expect(b.decisions[0].sizing!.n).toBeGreaterThan(100);
  });

  it("is idempotent per bar: a resubmitted bar makes no second call", async () => {
    const h = harness();
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: null });
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: "duplicate" });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: "duplicate" });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(1);
    expect((await h.store.decisions(DAY)).length).toBe(2);
  });

  it("never runs an interrupted job again: a RUNNING job left by a crashed alarm becomes FAILED with no call", async () => {
    const h = harness();
    await h.brain.submitBar(input(bar(0)));
    const [job] = await h.store.jobs();
    await h.store.putJob({ ...job, status: "RUNNING", startedMs: h.clock.now() });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(0);
    expect(await h.store.batch(bar(0))).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^interrupted/) });
    expect(await h.store.jobs()).toEqual([]);
  });

  it("keeps a finished batch when only the job's deletion was lost", async () => {
    const h = harness();
    await step(h, 0);
    await h.store.putJob({ id: `reflex:${bar(0)}`, kind: "REFLEX", dueMs: bar(0), status: "RUNNING", startedMs: bar(0) + 41_000, payload: { barCloseMs: bar(0) } });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect((await h.store.batch(bar(0)))?.status).toBe("OK");
    expect(h.reflex.calls).toHaveLength(1);
  });

  it("writes the call record at its worst-case cost before the request goes out", async () => {
    const h = harness();
    let during: unknown = null;
    h.reflex.onCall = async () => {
      during = (await h.store.calls(DAY))[0];
    };
    await step(h, 0);
    expect(during).toMatchObject({ kind: "REFLEX", status: "ERROR", error: expect.stringMatching(/^interrupted/), usage: null });
    expect((during as { costUsd: number }).costUsd).toBeGreaterThan((await h.store.calls(DAY))[0].costUsd);
  });

  it("fails closed: no API key, a failed call, a refusal; a call with no usage costs its worst case", async () => {
    const nokey = harness({ noKey: true });
    await step(nokey, 0);
    expect(await nokey.store.batch(bar(0))).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^NO_KEY/), decisions: [] });
    expect(await nokey.store.calls(DAY)).toEqual([]);

    const broken = harness({ answer: () => "throw" });
    await step(broken, 0);
    expect(await broken.store.batch(bar(0))).toMatchObject({ status: "FAILED", decisions: [], error: "ERROR: network down" });
    const [c1] = await broken.store.calls(DAY);
    expect(c1).toMatchObject({ status: "ERROR", usage: null });
    expect(c1.costUsd).toBeGreaterThan(0);

    const refused = harness({ answer: () => ({ status: "REFUSED", usage: USAGE }) });
    await step(refused, 0);
    expect((await refused.store.batch(bar(0)))?.status).toBe("FAILED");
    const [c2] = await refused.store.calls(DAY);
    expect(c2.status).toBe("REFUSED");
    expect(c2.costUsd).toBeLessThan(c1.costUsd);
  });

  it("stops at the day's cost cap: COST_CAP, no call, a skipped-call record", async () => {
    const h = harness({ settings: { dailyUsdCap: 0.001 } });
    await step(h, 0);
    expect(h.reflex.calls).toHaveLength(0);
    expect((await h.store.batch(bar(0)))?.status).toBe("COST_CAP");
    expect((await h.store.calls(DAY)).map((c) => [c.status, c.costUsd])).toEqual([["SKIPPED_CAP", 0]]);
  });

  it("marks a bar STALE when its turn comes too late, with no call", async () => {
    const h = harness();
    await h.brain.submitBar(input(bar(0)));
    h.clock.set(bar(0) + AGENT_POLICY.maxDecisionAgeMs + 1_000);
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(0);
    expect((await h.store.batch(bar(0)))?.status).toBe("STALE");
  });

  it("leaves out an index without a snapshot, and makes no call with no finalist", async () => {
    const h = harness();
    await step(h, 0, { only: ["NIFTY"] });
    expect(h.reflex.calls[0].finalists.map((f) => f.id)).toEqual(["gen:NIFTY"]);
    expect((await h.store.bars(DAY)).map((b) => [b.index, b.snapshot === null])).toEqual([
      ["NIFTY", false],
      ["SENSEX", true],
    ]);
    await step(h, 1, { only: [] });
    expect(h.reflex.calls).toHaveLength(1);
    expect((await h.store.batch(bar(1)))?.status).toBe("NO_FINALISTS");
  });

  it("stores bars after 15:05 for grading only, with no model call", async () => {
    const h = harness();
    const late = istAt(DAY, "15:10");
    h.clock.set(late + 40_000);
    expect(await h.brain.submitBar(input(late))).toEqual({ accepted: true, reason: "stored for grading only (outside the 09:20–15:05 reflex window)" });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(0);
    expect(await h.store.batch(late)).toBeNull();
    expect((await h.store.bars(DAY)).length).toBe(2);
  });

  it("accepts no bar while paused, and the paused flag shows in the status", async () => {
    const h = harness();
    await h.brain.setPaused(true);
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: false, reason: "paused: the operator paused the agent" });
    expect((await h.brain.status()).paused).toBe(true);
    expect(await h.store.bars(DAY)).toEqual([]);
    await h.brain.setPaused(false);
    expect((await h.brain.submitBar(input(bar(0)))).accepted).toBe(true);
  });

  it("starts a job only when its abort time fits before the deadline, and never throws", async () => {
    const h = harness();
    await h.brain.submitBar(input(bar(0)));
    const now = h.clock.now();
    expect(await h.brain.runDue(now, now + 30_000)).toBe(now);
    expect(h.reflex.calls).toHaveLength(0);
    await h.brain.runDue(now, now + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(1);

    const failing = new MemoryAgentStore();
    failing.dueJobs = async () => {
      throw new Error("disk on fire");
    };
    const f = harness({ store: failing });
    await f.brain.submitBar(input(bar(0)));
    const wake = await f.brain.runDue(f.clock.now(), f.clock.now() + MINUTE_MS);
    expect(wake === null || typeof wake === "number").toBe(true);
    expect(f.reflex.calls).toHaveLength(0);
  });
});

describe("AgentBrain: the Advisor's brief", () => {
  it("uses only a same-day brief created at or before the bar close (AMENDMENTS #6)", async () => {
    const h = harness();
    // Written 30 s after bar 0's close: bar 0 must not see it; bar 1 may.
    h.briefs.latest = brief("b-late", bar(0) + 30_000);
    await step(h, 0);
    expect(h.reflex.calls[0].finalists.map((f) => f.id)).toEqual(["gen:NIFTY", "gen:SENSEX"]);
    expect(h.reflex.calls[0].brief).toBeNull();
    expect(await h.store.batch(bar(0))).toMatchObject({ briefId: null, briefContext: null });

    await step(h, 1);
    expect(h.reflex.calls[1].finalists.map((f) => f.id)).toEqual(["gen:NIFTY", "gen:SENSEX", "idea:b-late:i1"]);
    const b1 = (await h.store.batch(bar(1)))!;
    expect(b1.briefId).toBe("b-late");
    expect(b1.briefContext?.headline).toBe("Brief b-late: buy the dip only above 25,050");
    expect(h.reflex.calls[1].brief).toEqual(b1.briefContext);
  });

  it("keeps using the earlier brief for a bar when a newer one appears after that bar's close", async () => {
    const h = harness();
    h.briefs.latest = brief("b-early", bar(0) - 10 * MINUTE_MS);
    await step(h, 0);
    h.briefs.latest = brief("b-new", bar(1) + 20_000);
    await step(h, 1);
    expect((await h.store.batch(bar(1)))?.briefId).toBe("b-early");
    await step(h, 2);
    expect((await h.store.batch(bar(2)))?.briefId).toBe("b-new");
  });
});

describe("AgentBrain: escalations", () => {
  const lowConf = { "gen:NIFTY": { direction: "LONG" as const, directionConfidence: 0.55, setupQuality: 2 as const } };
  const deepAnswer = () => ({ decision: dec("gen:NIFTY", { direction: "LONG", directionConfidence: 0.88, setupQuality: 3, reason: "trend and flow agree" }), reason: "the trend, VWAP side and call short covering agree" });

  it("queues a low-confidence call, runs it on the alarm, and merges it into the next bar's effective decision", async () => {
    const h = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    await step(h, 0);
    const [esc] = await h.store.escalations(DAY);
    expect(esc).toMatchObject({ trigger: "LOW_CONFIDENCE", status: "DONE", finalistId: "gen:NIFTY", appliedBarMs: null });
    expect(esc.decision?.directionConfidence).toBe(0.88);
    expect(h.deep.calls).toHaveLength(1);
    expect(h.deep.calls[0].effort).toBe("medium");

    await step(h, 1);
    const b1 = (await h.store.batch(bar(1)))!;
    const nifty = b1.decisions.find((d) => d.finalistId === "gen:NIFTY")!;
    expect(nifty).toMatchObject({ source: "ESCALATION", effective: true, direction: "LONG", directionConfidence: 0.88, barCloseMs: bar(1) });
    const rows = await h.store.decisionsForBar(bar(1));
    expect(rows.find((d) => d.finalistId === "gen:NIFTY" && d.source === "REFLEX")?.effective).toBe(false);
    expect((await h.store.escalation(esc.id))?.appliedBarMs).toBe(bar(1));
    expect((await h.store.calls(DAY)).map((c) => c.kind).slice(0, 3)).toEqual(["REFLEX", "ESCALATION", "REFLEX"]);
  });

  it("marks an escalation LATE when the next bar's reflex ran first", async () => {
    const h = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    h.clock.set(bar(0) + 40_000);
    await h.brain.submitBar(input(bar(0)));
    // Only the reflex fits this alarm; the escalation waits.
    await h.brain.runDue(h.clock.now(), h.clock.now() + 100_000);
    expect((await h.store.escalations(DAY))[0].status).toBe("QUEUED");
    await step(h, 1);
    const late = (await h.store.escalations(DAY)).find((e) => e.barCloseMs === bar(0))!;
    expect(late).toMatchObject({ status: "LATE", callId: null, decision: null });
    expect((await h.store.calls(DAY)).filter((c) => c.kind === "ESCALATION" && c.barCloseMs === bar(0))).toEqual([]);
  });

  it("leaves the rest of the day's reflex calls their reserve: an escalation that would eat it is SKIPPED (AMENDMENTS #11)", async () => {
    const escWorst = worstCaseUsd(DEEP_MODEL, 2 * USER_MESSAGE_TOKEN_LIMIT, 8_000);
    const tight = harness({ answer: answerAll(lowConf), deep: deepAnswer, settings: { dailyUsdCap: escWorst + 0.01 } });
    await step(tight, 0);
    expect((await tight.store.escalations(DAY))[0]).toMatchObject({ status: "SKIPPED", reason: "cost cap: the rest of the day's reflex calls come first" });
    expect(tight.deep.calls).toHaveLength(0);
    expect((await tight.store.batch(bar(0)))?.status).toBe("OK");

    const roomy = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    await step(roomy, 0);
    expect((await roomy.store.escalations(DAY))[0].status).toBe("DONE");
  });

  it("gives a failed reflex's bar only the escalations' exits, never an entry", async () => {
    let n = 0;
    const h = harness({ answer: (req) => (n++ === 0 ? answerAll(lowConf)(req) : { status: "TIMEOUT" }), deep: deepAnswer });
    await step(h, 0);
    await step(h, 1);
    const b1 = (await h.store.batch(bar(1)))!;
    expect(b1.status).toBe("FAILED");
    expect(b1.decisions).toEqual([]);
    expect(b1.exitOnly.map((d) => [d.finalistId, d.source, d.effective, d.directionConfidence])).toEqual([["gen:NIFTY", "ESCALATION", false, 0.88]]);
  });

  it("makes a finished escalation exit-only when the next bar has no decision for its finalist (a dropped decision, the cost cap)", async () => {
    let n = 0;
    const dropped = harness({ answer: (req) => (n++ === 0 ? answerAll(lowConf)(req) : req.finalists.filter((f) => f.id !== "gen:NIFTY").map((f) => dec(f.id))), deep: deepAnswer });
    await step(dropped, 0);
    await step(dropped, 1);
    const b1 = (await dropped.store.batch(bar(1)))!;
    expect(b1.status).toBe("OK");
    expect(b1.decisions.map((d) => d.finalistId)).toEqual(["gen:SENSEX"]);
    expect(b1.exitOnly.map((d) => [d.finalistId, d.source, d.effective, d.barCloseMs])).toEqual([["gen:NIFTY", "ESCALATION", false, bar(1)]]);
    expect((await dropped.store.escalations(DAY))[0].appliedBarMs).toBe(bar(1));

    const capped = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    await step(capped, 0);
    // The rest of the day's budget is spent before bar 1.
    await capped.store.putCall(agentSample.call({ id: "spent", date: DAY, costUsd: 3 }));
    await step(capped, 1);
    const c1 = (await capped.store.batch(bar(1)))!;
    expect(c1.status).toBe("COST_CAP");
    expect(c1.exitOnly.map((d) => [d.finalistId, d.source, d.effective])).toEqual([["gen:NIFTY", "ESCALATION", false]]);
  });
});

describe("AgentBrain: executions from TE", () => {
  it("records an execution idempotently: a replayed or older record changes nothing; trades by position", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } }) });
    await step(h, 0);
    const b = (await h.brain.takeDecisions(0))!;
    const id = b.decisions[0].id;
    const newer = agentSample.execution({ t: bar(0) + 80_000, action: "SHADOW_ENTRY", detail: "would buy 1 lot" });
    const older = agentSample.execution({ t: bar(0) + 75_000, action: "NOT_EXECUTED", detail: "time budget" });
    const trade = agentSample.trade({ positionId: "p1", date: DAY, decisionId: id, agentExit: null });
    const rec = {
      barCloseMs: bar(0), t: bar(0) + 80_000, decisions: [{ decisionId: id, execution: newer }],
      exits: [{ positionId: "p1", decisionId: id, reason: "AGENT_REDUCE" as const, status: "FILLED" }], trades: [trade], risk: agentSample.risk({ date: DAY, t: bar(0) + 80_000 }),
    };
    await h.brain.recordExecution(rec);
    await h.brain.recordExecution(rec);
    await h.brain.recordExecution({ ...rec, decisions: [{ decisionId: id, execution: older }], exits: [], t: bar(0) + 75_000 });
    const row = (await h.store.decisionsForBar(bar(0))).find((d) => d.id === id)!;
    expect(row.execution).toEqual(newer);
    const trades = await h.store.trades(DAY, DAY);
    expect(trades).toHaveLength(1);
    expect(trades[0].agentExit).toBe("AGENT_REDUCE");
    expect((await h.store.latestRisk())?.t).toBe(bar(0) + 80_000);
  });
});

describe("AgentBrain: the nightly review, the replay and the approval gate", () => {
  const review: ReviewOut = {
    summary: "Quiet trend day; the calls were mostly NEUTRAL.",
    fills: [],
    misses: ["the 11:00 push was missed"],
    mistakes: ["confidence above 0.8 against the flow once"],
    lessons: ["wait for the flow to agree"],
    candidate: { guidance: "- Prefer NEUTRAL unless the option flow agrees with the trend.", rationale: "two false alarms against the flow", wouldBeWrongIf: "the next three sessions show more misses" },
  };

  async function session(h: Harness, bars: number) {
    for (let k = 0; k < bars; k++) await step(h, k);
  }

  it("grades from the archive when both ends exist, retries at 16:40 without it, writes the review and replays both texts", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => review });
    await session(h, 18);
    expect(h.reflex.calls).toHaveLength(18);

    // 16:00: the review is queued for 16:20; the archive is not written yet.
    h.clock.set(istAt(DAY, "16:00"));
    await h.brain.scheduleReview(DAY);
    expect(await h.store.review(DAY)).toMatchObject({ status: "PENDING", dueMs: istAt(DAY, "16:20") });
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBe(istAt(DAY, "16:20"));
    h.clock.set(istAt(DAY, "16:20"));
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBe(istAt(DAY, "16:40"));
    expect(await h.store.review(DAY)).toMatchObject({ status: "PENDING", dueMs: istAt(DAY, "16:40") });
    expect(h.deep.calls).toHaveLength(0);

    fillArchive(h);
    h.clock.set(istAt(DAY, "16:40"));
    const wake = await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    const done = (await h.store.review(DAY))!;
    expect(done).toMatchObject({ status: "DONE", model: DEEP_MODEL, report: review });
    expect(done.calibration?.graded).toBeGreaterThan(0);
    expect(await h.store.getMeta(AGENT_META.calibration)).toEqual(done.calibration);
    expect(h.deep.calls[0]).toMatchObject({ effort: "high", maxTokens: 32_000 });

    const graded = (await h.store.decisions(DAY)).filter((d) => d.finalistId === "gen:NIFTY");
    // Rising closes: a LONG call six bars before the end of the data is a hit, graded from the archive.
    expect(graded[0].outcome).toMatchObject({ status: "HIT", y: 1, source: "BARS_5M" });
    expect(graded.every((d) => d.outcome !== null)).toBe(true);

    // The candidate is scored on today's bars, both texts replayed fresh; 15 bars per alarm.
    expect((await h.store.latestCandidate())?.status).toBe("SCORING");
    expect(wake).toBeGreaterThan(h.clock.now());
    expect(h.reflex.calls).toHaveLength(18 + 2 * REVIEW_CALL.replayBarsPerAlarm);
    h.clock.set(wake!);
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBeNull();
    expect(h.reflex.calls).toHaveLength(18 + 2 * 18);
    const replayed = h.reflex.calls.slice(18);
    const cand = (await h.store.latestCandidate())!;
    expect(new Set(replayed.map((c) => c.guidance))).toEqual(new Set([cand.guidance, (await h.store.activeInstruction())!.guidance]));
    // Identical inputs for both texts: the stored snapshots, finalists and brief context.
    expect(replayed[0].input.snapshots).toEqual(replayed[1].input.snapshots);
    expect(replayed[0].finalists).toEqual(replayed[1].finalists);
    expect(cand.status).toBe("PENDING");
    expect(cand.replay).toMatchObject({ bars: 18, complete: true, label: "in-sample, not proof", cursorBarMs: null });
    expect(cand.replay!.brierCandidate).not.toBeNull();
    expect(cand.replay!.brierCurrentReplayed).not.toBeNull();
    expect(cand.replay!.brierCurrentLive).not.toBeNull();
    expect((await h.store.calls(DAY)).filter((c) => c.kind === "REPLAY")).toHaveLength(36);
  });

  it("grades from the stored closes when the archive lacks an end", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "SHORT", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => ({ ...review, candidate: null }) });
    await session(h, 8);
    // The archive holds only the morning up to 10:40: bar 0 (10:30) has no 11:00 row there.
    fillArchive(h, istAt(DAY, "10:40"));
    h.clock.set(istAt(DAY, "16:41"));
    await h.brain.scheduleReview(DAY);
    await h.store.putJob({ id: `review:${DAY}`, kind: "REVIEW", dueMs: h.clock.now(), status: "QUEUED", startedMs: null, payload: { date: DAY, attempt: 2 } });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    const first = (await h.store.decisions(DAY)).find((d) => d.barCloseMs === bar(0) && d.finalistId === "gen:NIFTY")!;
    expect(first.outcome).toMatchObject({ status: "MISS", y: 0, source: "STORED" });
    expect((await h.store.review(DAY))?.status).toBe("DONE");
    expect(await h.store.latestCandidate()).toBeNull();
  });

  it("runs the review from the stored closes at 16:40 when the archive never arrives", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => ({ ...review, candidate: null }) });
    await session(h, 8);
    h.clock.set(istAt(DAY, "16:20"));
    await h.brain.scheduleReview(DAY);
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBe(istAt(DAY, "16:40"));
    h.clock.set(istAt(DAY, "16:40"));
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBeNull();
    expect((await h.store.review(DAY))?.status).toBe("DONE");
    const first = (await h.store.decisions(DAY)).find((d) => d.barCloseMs === bar(0) && d.finalistId === "gen:NIFTY")!;
    expect(first.outcome).toMatchObject({ status: "HIT", source: "STORED" });
    expect(await h.store.jobs()).toEqual([]);
  });

  it("never starts a review or a replay before or during the session", async () => {
    const h = harness();
    h.clock.set(istAt(DAY, "11:00"));
    await h.brain.scheduleReview("2026-10-16");
    expect(await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS)).toBe(istAt(DAY, "15:30"));
    expect((await h.store.review("2026-10-16"))?.status).toBe("PENDING");
    expect(h.deep.calls).toHaveLength(0);
  });

  it("approves only outside the session, switches the text and recomputes the calibration; rejects any time", async () => {
    const h = harness({ deep: () => review });
    await session(h, 2);
    fillArchive(h);
    h.clock.set(istAt(DAY, "16:25"));
    await h.brain.scheduleReview(DAY);
    for (let i = 0; i < 3; i++) {
      const w = await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
      if (w) h.clock.set(Math.max(w, h.clock.now()));
    }
    const cand = (await h.store.latestCandidate())!;
    expect(cand.status).toBe("PENDING");
    const before = (await h.store.activeInstruction())!.version;

    h.clock.set(istAt("2026-10-21", "11:00"));
    expect(await h.brain.decideCandidate(cand.id, "approve", "owner")).toEqual({ ok: false, message: "approve after 15:30 so one session is judged by one text" });
    expect(await h.brain.revertToBuiltin("owner")).toEqual({ ok: false, message: "revert after 15:30 so one session is judged by one text" });

    h.clock.set(istAt("2026-10-21", "16:00"));
    const res = await h.brain.decideCandidate(cand.id, "approve", "owner");
    expect(res.ok).toBe(true);
    const active = (await h.store.activeInstruction())!;
    expect(active).toMatchObject({ source: "CANDIDATE", candidateId: cand.id, guidance: cand.guidance, version: instructionVersion(cand.guidance) });
    expect(active.version).not.toBe(before);
    expect(await h.store.candidate(cand.id)).toMatchObject({ status: "APPROVED", decidedBy: "owner", decidedMs: istAt("2026-10-21", "16:00") });
    expect((await h.store.getMeta<{ asOfMs: number }>(AGENT_META.calibration))?.asOfMs).toBe(istAt("2026-10-21", "16:00"));
    expect((await h.brain.status()).instructionVersion).toBe(active.version);
    expect(await h.brain.decideCandidate(cand.id, "reject", "owner")).toMatchObject({ ok: false });

    expect(await h.brain.revertToBuiltin("ops")).toMatchObject({ ok: true });
    expect((await h.store.activeInstruction())?.version).toBe(before);
  });

  it("rejects a pending candidate during the session too", async () => {
    const h = harness();
    await h.store.putCandidate(agentSample.candidate({ id: "c1", status: "PENDING", date: "2026-10-16" }));
    h.clock.set(istAt(DAY, "11:00"));
    expect(await h.brain.decideCandidate("c1", "reject", "owner")).toEqual({ ok: true, message: "rejected: the current guidance stays" });
    expect((await h.store.candidate("c1"))?.status).toBe("REJECTED");
    expect(await h.brain.decideCandidate("nope", "approve", "owner")).toMatchObject({ ok: false });
  });
});

describe("AgentBrain: view and status", () => {
  it("builds the dashboard view and the ops status from the store", async () => {
    const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.9, setupQuality: 3 } }) });
    await step(h, 0);
    const v = await h.brain.view(DAY, null);
    expect(v.enabled).toBe(true);
    expect(v.mode).toBe("shadow");
    expect(v.status.state).toBe("WAITING");
    expect(v.indices[0].decisions.map((d) => [d.finalistId, d.direction])).toEqual([["gen:NIFTY", "LONG"]]);
    expect(v.cost.byKind.find((k) => k.kind === "REFLEX")?.calls).toBe(1);
    expect(v.instructionVersion).toBe((await h.store.activeInstruction())!.version);
    const st = await h.brain.status();
    expect(st).toMatchObject({ mode: "shadow", paused: false, nextJobMs: null, capUsd: 3, lastBatch: { barCloseMs: bar(0), status: "OK" } });
    expect(st.spentUsd).toBeGreaterThan(0);
  });
});
