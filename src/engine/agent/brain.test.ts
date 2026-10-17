import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import type { AdvisorIdea, AdvisorReport, AdvisorView } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, FixedClock, istAt, istIso, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { sequentialIds, silentLogger, type LlmUsage } from "../ports";
import type { IndexId } from "../types";
import { AGENT_META, AgentBrain, type AgentBrainDeps } from "./brain";
import { AGENT_POLICY, ESCALATION, REFLEX_CALL, RETENTION_DAYS, REVIEW_CALL, USER_MESSAGE_TOKEN_LIMIT } from "./constants";
import { betaQuantile, sizingProbability } from "./calibration";
import { callCostUsd, worstCaseUsd } from "./cost";
import { ClaudeDeepJudge, ClaudeReflexJudge, type DeepJudge, type DeepRequest, type DeepResponse, type ReflexJudge, type ReflexRequest, type ReflexResponse } from "./judge";
import { agentRiskPct } from "./kelly";
import { BUILTIN_GUIDANCE, instructionVersion, REVIEW_SYSTEM } from "./prompt";
import { estimateProseTokens, estimateTokens } from "./snapshot";
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
  constructor(
    private readonly answer: (req: DeepRequest<unknown>) => unknown,
    private readonly usage: LlmUsage = { inputTokens: 5_000, outputTokens: 2_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 },
  ) {}
  async structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    this.calls.push(req as DeepRequest<unknown>);
    const a = this.answer(req as DeepRequest<unknown>);
    if (a === "fail") return { status: "ERROR", parsed: null, usage: null, model: this.model, latencyMs: 9_000, error: "the fake failed" };
    return { status: "OK", parsed: req.schema.parse(a), usage: this.usage, model: this.model, latencyMs: 30_000, error: null };
  }
}

const dec = (finalistId: string, o: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId, regime: "TRENDING", direction: "NEUTRAL", directionConfidence: 0.45, toxicFlow: false, setupQuality: 1, riskState: "SAFE", reason: "returns disagree", ...o,
});
/** Answers every finalist it is given: NEUTRAL unless `over` says otherwise. */
const answerAll = (over: Record<string, Partial<ReflexDecision>> = {}) => (req: ReflexRequest) => req.finalists.map((f) => dec(f.id, over[f.id] ?? {}));

const snapshot = (index: IndexId, close: number): IndexSnapshot => ({
  c: close, r5: 8, r15: 12, r60: 20, ro: 30, vw: -10, vz: 0.6, orh: -5, orl: 25, ors: "U", pdh: -40, pdl: 70, pdc: 30,
  rsi: 60, adx: 26, di: 8, st: 1, rv: 12, atr: 0.08, vix: 13.2, vixc: -1.5,
  o: { k: index === "NIFTY" ? 25_000 : 82_000, cm: 110, cs: 0.6, pm: 95, ps: 0.7, iv: 13, ivx: -0.2, pcr: 0.9, mp: -5, cw: 40, pw: -60, bc: [1, 0, 2, 0], bp: [0, 2, 0, 1], oa: 45 },
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

function harness(
  o: {
    answer?: (req: ReflexRequest) => ReflexAnswer;
    deep?: (req: DeepRequest<unknown>) => unknown;
    settings?: Partial<AgentSettings>;
    noKey?: boolean;
    store?: AgentStore;
    start?: number;
    /** In place of the test fakes: a real judge over a fake fetch, or null for none. */
    reflexJudge?: ReflexJudge;
    escalation?: DeepJudge | null;
    review?: DeepJudge | null;
    /** No reflex judge (no key for it), the deep judges kept. */
    noReflex?: boolean;
  } = {},
): Harness {
  const store = o.store ?? new MemoryAgentStore();
  const clock = new FixedClock(o.start ?? B0 + 40_000);
  const reflex = new TestReflex(o.answer ?? answerAll());
  const deep = new TestDeep(o.deep ?? (() => "fail"));
  const briefs: { latest: AdvisorReport | null } = { latest: null };
  const archive = new Map<IndexId, { t: number; c: number }[]>();
  const deps: AgentBrainDeps = {
    store,
    settings: { mode: "shadow", reflexModel: REFLEX_MODEL, escalationModel: DEEP_MODEL, reviewModel: DEEP_MODEL, dailyUsdCap: 3, escalationsPerDay: 8, ...o.settings },
    reflex: o.noKey || o.noReflex ? null : (o.reflexJudge ?? reflex),
    escalation: o.noKey ? null : o.escalation !== undefined ? o.escalation : deep,
    review: o.noKey ? null : o.review !== undefined ? o.review : deep,
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

/** A close on `day` that rises one step a bar from 09:15. */
const closeOn = (day: string, index: IndexId, ms: number) => (index === "NIFTY" ? 25_000 : 82_000) + Math.round((ms - istAt(day, "09:15")) / (5 * MINUTE_MS)) * (index === "NIFTY" ? 10 : 30);
const inputOn = (day: string, T: number): ReflexInput => ({
  barCloseMs: T,
  date: day,
  builtMs: T + 35_000,
  snapshots: { NIFTY: snapshot("NIFTY", closeOn(day, "NIFTY", T)), SENSEX: snapshot("SENSEX", closeOn(day, "SENSEX", T)) },
  tokensEst: { NIFTY: 280, SENSEX: 280 },
  closes: { NIFTY: closeOn(day, "NIFTY", T), SENSEX: closeOn(day, "SENSEX", T) },
  problems: [],
});

/** Bars of `day` from `from` to `to` (IST), each submitted 40 s after its close with the alarm run after it. */
async function sessionOn(h: Harness, day: string, from = "09:20", to = "15:05") {
  for (let t = istAt(day, from); t <= istAt(day, to); t += 5 * MINUTE_MS) {
    h.clock.set(t + 40_000);
    await h.brain.submitBar(inputOn(day, t));
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
  }
}

/** `day`'s settled bar archive (bars_5m: t is the bar's open), added to what is there. */
function fillArchiveOn(h: Harness, day: string) {
  for (const index of ["NIFTY", "SENSEX"] as IndexId[]) {
    const rows = [...(h.archive.get(index) ?? [])];
    for (let close = istAt(day, "09:20"); close <= istAt(day, "15:30"); close += 5 * MINUTE_MS) rows.push({ t: close - 5 * MINUTE_MS, c: closeOn(day, index, close) });
    h.archive.set(index, rows);
  }
}

/** Runs the alarm until no job is due within a minute (a review and its replay slices). */
async function drain(h: Harness, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    const w = await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    if (w === null) return;
    h.clock.set(Math.max(w, h.clock.now() + 1));
  }
}

/** Graded reflex history on earlier days, nine calls a day 40 minutes apart (no 30-minute windows overlap); most paid. */
async function seedHistory(store: AgentStore, n: number, version: string, source: "REFLEX" | "ESCALATION" = "REFLEX") {
  const rows: DecisionRecord[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(DAY, -(1 + Math.floor(i / 9)));
    const t = istAt(date, "09:30") + (i % 9) * 40 * MINUTE_MS;
    rows.push(agentSample.decision({ id: `h${source}${i}`, date, barCloseMs: t, source, instructionVersion: version, directionConfidence: 0.9, outcome: agentSample.outcome({ status: "HIT", y: 1, paid: i % 10 !== 0 }) }));
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
    const stored = input(bar(0)).snapshots;
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: null });
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: "duplicate", snapshots: stored });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(await h.brain.submitBar(input(bar(0)))).toEqual({ accepted: true, reason: "duplicate", snapshots: stored });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect(h.reflex.calls).toHaveLength(1);
    expect((await h.store.decisions(DAY)).length).toBe(2);
  });

  for (const firstHasOptions of [true, false]) {
    it(`answers a resubmitted bar with the snapshots it stored first, the ones the model judges (first ${firstHasOptions ? "with" : "without"} its option block)`, async () => {
      const h = harness();
      // TE resubmits a bar whose first send timed out on its side; the second copy's flow read went the other way.
      const withBlock = input(bar(0));
      const withoutBlock = input(bar(0));
      withoutBlock.snapshots.NIFTY = { ...withoutBlock.snapshots.NIFTY!, o: null };
      const [first, second] = firstHasOptions ? [withBlock, withoutBlock] : [withoutBlock, withBlock];
      expect(await h.brain.submitBar(first)).toEqual({ accepted: true, reason: null });
      expect(await h.brain.submitBar(second)).toEqual({ accepted: true, reason: "duplicate", snapshots: first.snapshots });
      await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
      expect(h.reflex.calls).toHaveLength(1);
      expect(h.reflex.calls[0].input.snapshots).toEqual(first.snapshots);
    });
  }

  it("hands TE a batch with its bar's stored snapshots, the ones the model judged; the stored batch is left as it was", async () => {
    const h = harness();
    // The first copy reached the AgentDO although TE timed out on it; the second, without the option block, is a duplicate.
    const first = input(bar(0));
    const second = input(bar(0));
    second.snapshots.NIFTY = { ...second.snapshots.NIFTY!, o: null };
    expect(await h.brain.submitBar(first)).toEqual({ accepted: true, reason: null });
    expect((await h.brain.submitBar(second)).reason).toBe("duplicate");
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    const b = (await h.brain.takeDecisions(0))!;
    expect(b.snapshots).toEqual(first.snapshots);
    expect(b.snapshots).toEqual(h.reflex.calls[0].input.snapshots);
    expect((await h.store.batch(bar(0)))!.snapshots).toBeUndefined();
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
    expect(h.deep.calls[0]).toMatchObject({ effort: "medium", abortMs: ESCALATION.abortMs });

    await step(h, 1);
    const b1 = (await h.store.batch(bar(1)))!;
    const nifty = b1.decisions.find((d) => d.finalistId === "gen:NIFTY")!;
    expect(nifty).toMatchObject({ source: "ESCALATION", effective: true, direction: "LONG", directionConfidence: 0.88, barCloseMs: bar(1) });
    const rows = await h.store.decisionsForBar(bar(1));
    expect(rows.find((d) => d.finalistId === "gen:NIFTY" && d.source === "REFLEX")?.effective).toBe(false);
    expect((await h.store.escalation(esc.id))?.appliedBarMs).toBe(bar(1));
    expect((await h.store.calls(DAY)).map((c) => c.kind).slice(0, 3)).toEqual(["REFLEX", "ESCALATION", "REFLEX"]);
  });

  it("checks the deep model's answer like a reflex decision: another finalist or a confidence outside 0..1 is FAILED and never applied", async () => {
    for (const bad of [dec("gen:SENSEX", { direction: "LONG", directionConfidence: 0.88, setupQuality: 3 }), dec("gen:NIFTY", { direction: "LONG", directionConfidence: 1.4, setupQuality: 3 })]) {
      const h = harness({ answer: answerAll(lowConf), deep: () => ({ decision: bad, reason: "a confident call" }) });
      await step(h, 0);
      const [esc] = await h.store.escalations(DAY);
      expect(esc).toMatchObject({ status: "FAILED", decision: null, reason: expect.stringMatching(/^the answer was not a valid decision: /) });
      expect(esc.callId).not.toBeNull();
      await step(h, 1);
      const b1 = (await h.store.batch(bar(1)))!;
      expect(b1.decisions.find((d) => d.finalistId === "gen:NIFTY")).toMatchObject({ source: "REFLEX", effective: true });
      expect(b1.exitOnly).toEqual([]);
    }
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
    // escalationAllowed's budget: spent + the rest of the day's reflex calls at their worst + tonight's review at its
    // worst + this one's worst case.
    expect((await tight.store.escalations(DAY))[0]).toMatchObject({
      status: "SKIPPED",
      reason: expect.stringMatching(/^cost cap: \$0\.\d{3} spent \+ \$\d+\.\d{3} kept for the reflex \+ \$\d+\.\d{3} kept for tonight's review \+ \$\d+\.\d{3} worst case is over \$\d+\.\d{2}$/),
    });
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

  it("sizes an escalation on graded escalations only: with none, the prior and no trade, however rich the reflex's record (C2, probe-escsizing)", async () => {
    const h = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    const version = (await h.brain.status()).instructionVersion;
    // 300 graded reflex calls, 90% paid: enough to size a reflex call.
    await seedHistory(h.store, 300, version);
    await step(h, 0);
    await step(h, 1);
    const b1 = (await h.store.batch(bar(1)))!;
    const nifty = b1.decisions.find((d) => d.finalistId === "gen:NIFTY")!;
    expect(nifty).toMatchObject({ source: "ESCALATION", effective: true, direction: "LONG", directionConfidence: 0.88 });
    expect(nifty.sizing).toMatchObject({ mode: "pooled", n: 0, mean: 0.5 });
    expect(nifty.sizing!.p).toBeCloseTo(betaQuantile(0.2, 50, 50), 12);
    expect(agentRiskPct(nifty.sizing!.p, b1.payoff.b).riskPct).toBe(0);
    // The reflex's own call on the same record clears Kelly.
    const reflexP = sizingProbability(0.88, await h.store.graded(addDays(DAY, -RETENTION_DAYS)), version).p;
    expect(agentRiskPct(reflexP, 1).riskPct).toBeGreaterThan(0);
  });

  it("sizes an escalation on the escalations' graded record once it has one", async () => {
    const h = harness({ answer: answerAll(lowConf), deep: deepAnswer });
    const version = (await h.brain.status()).instructionVersion;
    await seedHistory(h.store, 300, version);
    await seedHistory(h.store, 120, version, "ESCALATION");
    await step(h, 0);
    await step(h, 1);
    const nifty = (await h.store.batch(bar(1)))!.decisions.find((d) => d.finalistId === "gen:NIFTY")!;
    expect(nifty.source).toBe("ESCALATION");
    // 120 graded escalations an hour apart, 108 paid: the reflex's 300 are not in it.
    expect(nifty.sizing).toMatchObject({ mode: "pooled", n: 120 });
    expect(nifty.sizing!.p).toBeCloseTo(betaQuantile(0.2, 108 + 50, 12 + 50), 12);
  });

  it("keeps a fresher NEUTRAL reflex call in force over a directional escalation, which can then only close a position (C2)", async () => {
    let n = 0;
    const h = harness({ answer: (req) => (n++ === 0 ? answerAll(lowConf)(req) : answerAll()(req)), deep: deepAnswer });
    await step(h, 0);
    expect((await h.store.escalations(DAY))[0]).toMatchObject({ status: "DONE", decision: expect.objectContaining({ direction: "LONG" }) });
    await step(h, 1);
    const b1 = (await h.store.batch(bar(1)))!;
    expect(b1.status).toBe("OK");
    expect(b1.decisions.map((d) => [d.finalistId, d.source, d.effective, d.direction])).toEqual([
      ["gen:NIFTY", "REFLEX", true, "NEUTRAL"],
      ["gen:SENSEX", "REFLEX", true, "NEUTRAL"],
    ]);
    expect(b1.exitOnly.map((d) => [d.finalistId, d.source, d.effective, d.direction, d.barCloseMs])).toEqual([["gen:NIFTY", "ESCALATION", false, "LONG", bar(1)]]);
    expect((await h.store.escalations(DAY))[0].appliedBarMs).toBe(bar(1));
    // Nothing on bar 1 can open a position: no directional row in force, nothing sized.
    const rows = await h.store.decisionsForBar(bar(1));
    expect(rows.filter((d) => d.effective && d.direction !== "NEUTRAL")).toEqual([]);
    expect(rows.filter((d) => d.sizing !== null)).toEqual([]);
  });

  it("stores the NEUTRAL of a reflex/escalation disagreement as code-made, unsized (C8)", async () => {
    let n = 0;
    const h = harness({
      answer: (req) => (n++ === 0 ? answerAll(lowConf)(req) : answerAll({ "gen:NIFTY": { direction: "SHORT", directionConfidence: 0.9, setupQuality: 3 } })(req)),
      deep: deepAnswer,
    });
    await step(h, 0);
    await step(h, 1);
    const nifty = (await h.store.batch(bar(1)))!.decisions.find((d) => d.finalistId === "gen:NIFTY")!;
    expect(nifty).toMatchObject({ source: "ESCALATION", effective: true, direction: "NEUTRAL", directionConfidence: 0.5, codeMade: true, sizing: null });
    expect((await h.store.decisionsForBar(bar(1))).find((d) => d.id === nifty.id)?.codeMade).toBe(true);
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
    expect(h.deep.calls[0]).toMatchObject({ effort: "high", maxTokens: 16_000, abortMs: REVIEW_CALL.abortMs });

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
    // The same window the AgentDO and the Agent page name: approving at 15:31 would still be refused.
    const when = "before 09:15 IST, or after today's review and replay finish (about 16:20–16:45 IST), so one session is judged by one text";
    expect(await h.brain.decideCandidate(cand.id, "approve", "owner")).toEqual({ ok: false, message: `approve ${when}` });
    expect(await h.brain.revertToBuiltin("owner")).toEqual({ ok: false, message: `revert ${when}` });

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

// ---------------------------------------------------------------------------
// The cost ledger and the review's budget (review M1, M2, M3; their probes in review3/model-api)
// ---------------------------------------------------------------------------

/** A review that proposes nothing (no replay follows). */
const quietReview: ReviewOut = { summary: "A quiet day.", fills: [], misses: [], mistakes: [], lessons: [], candidate: null };
/** An escalation's typical usage (SPEC §8: 4.5K in, 3K out, 1.5K cache read): $0.078 at the deep model's rates. */
const ESC_USAGE: LlmUsage = { inputTokens: 4_500, outputTokens: 3_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 };
/** Idea i of a brief: NIFTY calls and SENSEX puts in turn. */
const ideaN = (i: number): AdvisorIdea =>
  idea(`i${i + 1}`, {
    contract:
      i % 2
        ? { index: "SENSEX", expiry: "2026-10-27", strike: 82_100 + 100 * i, optionType: "PE", tradingSymbol: `SENSEX26O27${82_100 + 100 * i}PE`, lotSize: 20, label: "SENSEX PE" }
        : { index: "NIFTY", expiry: "2026-10-27", strike: 25_100 + 50 * i, optionType: "CE", tradingSymbol: `NIFTY26O27${25_100 + 50 * i}CE`, lotSize: 65, label: "NIFTY CE" },
  });

/** Server-sent events of one complete streamed answer. */
function sseAnswer(text: string, usage = { input_tokens: 5_000, output_tokens: 3_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }): Response {
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: DEEP_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json", "retry-after-ms": "1" } });

describe("AgentBrain: the cost cap keeps tonight's review (M1)", () => {
  /** A session with `nIdeas` brief ideas and a low-confidence LONG on gen:NIFTY every 35 minutes from 09:30, `nEsc` times. */
  function busyDay(nIdeas: number, nEsc: number, failEsc = 0) {
    const trig = new Set(Array.from({ length: nEsc }, (_, i) => istAt(DAY, "09:30") + i * 7 * 5 * MINUTE_MS));
    let escalations = 0;
    const deep = new TestDeep((req) => {
      if (req.maxTokens === REVIEW_CALL.maxTokens) return quietReview;
      return ++escalations <= failEsc ? "fail" : { decision: dec("gen:NIFTY", { reason: "mixed" }), reason: "mixed" };
    }, ESC_USAGE);
    const h = harness({
      start: istAt(DAY, "09:00"),
      answer: (req) => req.finalists.map((f) => (trig.has(req.input.barCloseMs) && f.id === "gen:NIFTY" ? dec(f.id, { direction: "LONG", directionConfidence: 0.5, setupQuality: 2 }) : dec(f.id))),
      escalation: deep,
      review: deep,
    });
    h.briefs.latest = brief("b1", istAt(DAY, "09:25"), Array.from({ length: nIdeas }, (_, i) => ideaN(i)));
    return h;
  }

  async function reviewAt1621(h: Harness) {
    fillArchive(h);
    h.clock.set(istAt(DAY, "16:00"));
    await h.brain.scheduleReview(DAY);
    h.clock.set(istAt(DAY, "16:21"));
    await drain(h);
    return (await h.store.review(DAY))!;
  }

  it("a busy day still gets its review: 8 escalations with 2 ideas, 8 with 4 ideas, 2 failed ones booked at their worst", async () => {
    for (const [ideas, escs, fails] of [
      [2, 8, 0],
      [4, 8, 0],
      [2, 2, 2],
    ] as const) {
      const h = busyDay(ideas, escs, fails);
      await sessionOn(h, DAY);
      const esc = await h.store.escalations(DAY);
      expect(esc.filter((e) => e.status === "SKIPPED")).toEqual([]);
      expect(esc.filter((e) => e.status === "DONE")).toHaveLength(escs - fails);
      const review = await reviewAt1621(h);
      expect({ ideas, escs, fails, status: review.status, error: review.error }).toEqual({ ideas, escs, fails, status: "DONE", error: null });
      // Booked at its user message's size, not every token as a cache write: under half the old $2.4-$3.0.
      const call = (await h.store.calls(DAY)).find((c) => c.kind === "REVIEW")!;
      expect(call.status).toBe("OK");
    }
  });

  it("keeps the review's worst case back from escalations until today's review has run, and names it when it skips one", async () => {
    const lowConf = { "gen:NIFTY": { direction: "LONG" as const, directionConfidence: 0.55, setupQuality: 2 as const } };
    const esc = () => ({ decision: dec("gen:NIFTY", { reason: "mixed" }), reason: "mixed" });
    // $2: the escalation's worst case and the reflex reserve fit, the review's worst case on top does not.
    const pending = harness({ answer: answerAll(lowConf), deep: esc, settings: { dailyUsdCap: 2 } });
    await step(pending, 0);
    const [skipped] = await pending.store.escalations(DAY);
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.reason).toMatch(/kept for tonight's review/);
    const reserve = worstCaseUsd(DEEP_MODEL, { systemTokens: estimateProseTokens(REVIEW_SYSTEM), userTokens: REVIEW_CALL.userTokenBound }, REVIEW_CALL.maxTokens);
    expect(skipped.reason).toContain(`$${reserve.toFixed(3)} kept for tonight's review`);
    // About $1.13 at the fallback models' rates (the plan's budget).
    expect(reserve).toBeGreaterThan(1.1);
    expect(reserve).toBeLessThan(1.16);

    // Once today's review is DONE (a re-run, say), nothing is kept for it.
    const done = harness({ answer: answerAll(lowConf), deep: esc, settings: { dailyUsdCap: 2 } });
    await done.store.putReview(agentSample.review({ date: DAY, status: "DONE" }));
    await step(done, 0);
    expect((await done.store.escalations(DAY))[0].status).toBe("DONE");
    // Nor in mode off, nor without a review judge.
    const noReview = harness({ answer: answerAll(lowConf), deep: esc, settings: { dailyUsdCap: 2 }, review: null });
    await step(noReview, 0);
    expect((await noReview.store.escalations(DAY))[0].status).toBe("DONE");
  });

  it("sizes the review's call by its user message: the API's count when it gives one, else the prose estimate", async () => {
    const run = async (count: number | null) => {
      const counts: string[] = [];
      const deep = new TestDeep(() => quietReview);
      let booked: number | null = null;
      const review: DeepJudge = {
        model: DEEP_MODEL,
        countTokens: async (user) => {
          counts.push(user);
          return count;
        },
        structured: async (req) => {
          // The call record is written at its worst case before the request goes out.
          booked = (await h.store.calls(DAY)).find((c) => c.kind === "REVIEW")?.costUsd ?? null;
          return deep.structured(req);
        },
      };
      const h = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), escalation: null, review });
      for (let k = 0; k < 4; k++) await step(h, k);
      fillArchive(h);
      h.clock.set(istAt(DAY, "16:21"));
      await h.brain.scheduleReview(DAY);
      await drain(h);
      expect(counts).toHaveLength(1);
      expect(counts[0]).toBe(deep.calls[0].user);
      const call = (await h.store.calls(DAY)).find((c) => c.kind === "REVIEW")!;
      expect(call.costUsd).toBe(callCostUsd({ inputTokens: 5_000, outputTokens: 2_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 }, DEEP_MODEL));
      return { booked: booked as number | null, user: counts[0] };
    };
    const size = (userTokens: number) => worstCaseUsd(DEEP_MODEL, { systemTokens: estimateProseTokens(REVIEW_SYSTEM), userTokens }, REVIEW_CALL.maxTokens);
    const counted = await run(12_345);
    expect(counted.booked).toBe(size(12_345));
    const estimated = await run(null);
    expect(estimated.booked).toBe(size(estimateProseTokens(estimated.user)));
    // Either is well under every token priced as a cache write at the old 1.2 characters a token.
    expect(counted.booked!).toBeLessThan(worstCaseUsd(DEEP_MODEL, estimateTokens(REVIEW_SYSTEM) + estimateTokens(counted.user), REVIEW_CALL.maxTokens));
  });
});

describe("AgentBrain: no paid review of an empty day (M5)", () => {
  const proposing: ReviewOut = { ...quietReview, candidate: { guidance: "- Prefer LONG on any green candle.", rationale: "nothing happened", wouldBeWrongIf: "never" } };

  it("skips the review, with no model call and no candidate, when nothing was in force and nothing traded (off-mode-review, review-empty-day)", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const h = harness({ start: istAt(DAY, "16:00"), deep: () => proposing, settings: { mode } });
      // Shadow mode, paused all session: no bar was accepted.
      if (mode === "shadow") await h.brain.setPaused(true);
      expect(await h.brain.submitBar(input(bar(0)))).toMatchObject({ accepted: mode === "off" });
      fillArchive(h);
      await h.brain.scheduleReview(DAY);
      h.clock.set(istAt(DAY, "16:20"));
      await drain(h);
      const r = (await h.store.review(DAY))!;
      expect(r).toMatchObject({ status: "SKIPPED", error: `nothing to review: no decision was in force and no trade was made on ${DAY}; the day was graded and scored` });
      expect(r.calibration).not.toBeNull();
      expect(h.deep.calls).toHaveLength(0);
      expect(await h.store.calls(DAY)).toEqual([]);
      expect(await h.store.latestCandidate()).toBeNull();
    }
  });

  it("still reviews a day with a trade but no decision in force", async () => {
    const h = harness({ start: istAt(DAY, "16:00"), deep: () => quietReview });
    await h.store.putTrades([agentSample.trade({ date: DAY })]);
    fillArchive(h);
    await h.brain.scheduleReview(DAY);
    h.clock.set(istAt(DAY, "16:20"));
    await drain(h);
    expect((await h.store.review(DAY))?.status).toBe("DONE");
    expect(h.deep.calls).toHaveLength(1);
  });

  it("refuses to approve a candidate nothing was replayed for", async () => {
    const h = harness({ start: istAt("2026-10-21", "09:05") });
    await h.store.putCandidate(agentSample.candidate({ id: "none", status: "PENDING", replay: null }));
    expect(await h.brain.decideCandidate("none", "approve", "owner")).toEqual({ ok: false, message: "nothing was replayed for this candidate; reject it or re-run the review" });
    const zero = { bars: 0, graded: 0, brierCandidate: null, brierCurrentReplayed: null, brierCurrentLive: null, firesCandidate: 0, firesCurrent: 0, hitRateCandidate: null, hitRateCurrent: null, costUsd: 0, complete: true, cursorBarMs: null, label: "in-sample, not proof" as const };
    await h.store.putCandidate(agentSample.candidate({ id: "zero", status: "PENDING", replay: zero, createdMs: Date.parse("2026-10-21T00:00:00Z") }));
    expect(await h.brain.decideCandidate("zero", "approve", "owner")).toMatchObject({ ok: false, message: "nothing was replayed for this candidate; reject it or re-run the review" });
    expect(await h.brain.decideCandidate("zero", "reject", "owner")).toMatchObject({ ok: true });
  });
});

describe("AgentBrain: the approval window and the text the session ran with (O3)", () => {
  const D1 = "2026-10-16";
  const proposal = (n: number): ReviewOut => ({ ...quietReview, candidate: { guidance: `- Candidate text ${n}: prefer NEUTRAL unless the flow agrees.`, rationale: "r", wouldBeWrongIf: "w" } });

  /** Runs `day`'s review (archive filled) and its replay to the end. */
  async function reviewDay(h: Harness, day: string) {
    fillArchiveOn(h, day);
    h.clock.set(Math.max(h.clock.now(), istAt(day, "16:20")));
    await h.brain.scheduleReview(day);
    await drain(h);
  }

  it("refuses approve and revert from the close until the day's review and replay finish; allows them before the open", async () => {
    let n = 0;
    const h = harness({ start: istAt(D1, "10:00"), answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => proposal(++n) });
    // A candidate from an earlier day, replayed and pending.
    await sessionOn(h, D1, "10:00", "10:30");
    await reviewDay(h, D1);
    const c1 = (await h.store.latestCandidate())!;
    expect(c1).toMatchObject({ status: "PENDING", date: D1 });
    expect(c1.replay!.bars).toBeGreaterThan(0);

    // Today's session ran; at 15:45 its review has not run.
    await sessionOn(h, DAY, "10:00", "10:30");
    h.clock.set(istAt(DAY, "15:45"));
    const window = "after today's review and replay finish (about 16:20–16:45 IST)";
    expect(await h.brain.decideCandidate(c1.id, "approve", "owner")).toEqual({ ok: false, message: `approve ${window}; if no review runs today, approve before 09:15 tomorrow` });
    expect(await h.brain.revertToBuiltin("ops")).toEqual({ ok: false, message: `revert ${window}; if no review runs today, revert before 09:15 tomorrow` });
    // Queued, then running its replay: still refused.
    fillArchiveOn(h, DAY);
    await h.brain.scheduleReview(DAY);
    h.clock.set(istAt(DAY, "16:20"));
    expect((await h.brain.decideCandidate(c1.id, "approve", "owner")).ok).toBe(false);
    const wake = await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect((await h.store.review(DAY))?.status).toBe("DONE");
    const c2 = (await h.store.latestCandidate())!;
    if (c2.status === "SCORING") expect((await h.brain.decideCandidate(c2.id, "approve", "owner")).ok).toBe(false);
    h.clock.set(Math.max(wake ?? h.clock.now(), h.clock.now()));
    await drain(h);
    // Review DONE and replay finished: the new candidate can be approved.
    const ready = (await h.store.latestCandidate())!;
    expect(ready).toMatchObject({ status: "PENDING", date: DAY });
    expect(await h.brain.decideCandidate(ready.id, "approve", "owner")).toMatchObject({ ok: true });
    // Before the next open (09:05 the next session day), revert is allowed.
    h.clock.set(istAt("2026-10-21", "09:05"));
    expect(await h.brain.revertToBuiltin("ops")).toMatchObject({ ok: true });
    // A day with no batch has no window: a PENDING candidate can be approved after its close.
    const quiet = harness({ start: istAt(DAY, "15:45") });
    await quiet.store.putCandidate({ ...c1, id: "c-quiet" });
    expect(await quiet.brain.decideCandidate("c-quiet", "approve", "owner")).toMatchObject({ ok: true });
  });

  it("reviews and replays the text the session ran with, whatever is active by the evening (approve-window)", async () => {
    let n = 0;
    const h = harness({ start: istAt(D1, "10:00"), answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => proposal(++n) });
    await sessionOn(h, D1, "10:00", "10:30");
    await reviewDay(h, D1);
    const c1 = (await h.store.latestCandidate())!;
    const builtin = instructionVersion(BUILTIN_GUIDANCE);
    // Day 2 is judged with the built-in text; at 15:45 approving candidate 1 is refused.
    await sessionOn(h, DAY, "10:00", "10:30");
    expect(new Set((await h.store.decisions(DAY)).map((d) => d.instructionVersion))).toEqual(new Set([builtin]));
    h.clock.set(istAt(DAY, "15:45"));
    expect((await h.brain.decideCandidate(c1.id, "approve", "owner")).ok).toBe(false);
    // Candidate 1's text made active anyway (as an older deploy could): the review still reads the session's text.
    await h.store.putInstruction({ version: instructionVersion(c1.guidance), guidance: c1.guidance, createdMs: h.clock.now(), source: "CANDIDATE", candidateId: c1.id, active: true });
    const deepBefore = h.deep.calls.length;
    const reflexBefore = h.reflex.calls.length;
    await reviewDay(h, DAY);
    const reviewReq = h.deep.calls[deepBefore];
    expect(reviewReq.user).toContain(BUILTIN_GUIDANCE);
    expect(reviewReq.user).not.toContain(c1.guidance);
    expect((await h.store.calls(DAY)).find((c) => c.kind === "REVIEW")?.instructionVersion).toBe(builtin);
    expect((await h.store.review(DAY))?.note ?? null).toBeNull();
    // The new candidate is written against the built-in text, and the replay's current arm replays it.
    const c2 = (await h.store.latestCandidate())!;
    expect(c2).toMatchObject({ date: DAY, baseVersion: builtin, baseGuidance: BUILTIN_GUIDANCE, status: "PENDING" });
    const replayed = new Set(h.reflex.calls.slice(reflexBefore).map((c) => c.guidance));
    expect(replayed).toEqual(new Set([BUILTIN_GUIDANCE, c2.guidance]));
  });

  it("reviews an older date against that date's text, and says so when that text was never stored", async () => {
    let n = 0;
    const h = harness({ start: istAt(D1, "10:00"), answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => proposal(++n) });
    await sessionOn(h, D1, "10:00", "10:30");
    await reviewDay(h, D1);
    const c1 = (await h.store.latestCandidate())!;
    // Approved before the next open; day 2 runs with candidate 1's text.
    h.clock.set(istAt(DAY, "09:05"));
    expect(await h.brain.decideCandidate(c1.id, "approve", "owner")).toMatchObject({ ok: true });
    await sessionOn(h, DAY, "10:00", "10:30");
    expect(new Set((await h.store.decisions(DAY)).map((d) => d.instructionVersion))).toEqual(new Set([instructionVersion(c1.guidance)]));
    // The evening of day 2, day 1's review is re-run: it reads day 1's built-in text, not the active one.
    h.clock.set(istAt(DAY, "18:00"));
    const deepBefore = h.deep.calls.length;
    await h.brain.scheduleReview(D1, { force: true });
    await drain(h);
    expect(h.deep.calls[deepBefore].user).toContain(BUILTIN_GUIDANCE);
    expect(h.deep.calls[deepBefore].user).not.toContain(c1.guidance);

    // A session whose text is not stored anywhere: the active text, with a note in the record and the prompt.
    const lost = harness({ start: istAt(DAY, "10:00"), answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => quietReview });
    await sessionOn(lost, DAY, "10:00", "10:30");
    for (const b of await lost.store.batches(DAY)) await lost.store.putBatch({ ...b, instructionVersion: "core-2/0bad0bad" });
    await reviewDay(lost, DAY);
    const r = (await lost.store.review(DAY))!;
    expect(r.status).toBe("DONE");
    expect(r.note).toBe(`the session ran with guidance core-2/0bad0bad, whose text is not stored; this review read the active text ${instructionVersion(BUILTIN_GUIDANCE)} in its place`);
    expect(lost.deep.calls[0].user).toContain(`(Note: ${r.note}.)`);
  });
});

describe("AgentBrain: the replay's coverage, late labels and retention (D9, C7, O6)", () => {
  const proposing: ReviewOut = { ...quietReview, candidate: { guidance: "- Prefer NEUTRAL unless the flow agrees.", rationale: "r", wouldBeWrongIf: "w" } };

  it("says how many candles the replay set out to judge and why an incomplete one stopped", async () => {
    // Complete: every OK candle judged again; no stop reason.
    const full = harness({ answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => proposing });
    for (let k = 0; k < 4; k++) await step(full, k);
    fillArchive(full);
    full.clock.set(istAt(DAY, "16:21"));
    await full.brain.scheduleReview(DAY);
    await drain(full);
    expect((await full.store.latestCandidate())?.replay).toMatchObject({ bars: 4, barsTotal: 4, complete: true, stopReason: null });

    // The cost cap stops it: while the review runs, the rest of the day's money is spent elsewhere.
    const capped: Harness = harness({
      answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }),
      deep: () => {
        void capped.store.putCall(agentSample.call({ id: "filler", date: DAY, costUsd: 2.99 }));
        return proposing;
      },
    });
    for (let k = 0; k < 4; k++) await step(capped, k);
    fillArchive(capped);
    capped.clock.set(istAt(DAY, "16:21"));
    await capped.brain.scheduleReview(DAY);
    await drain(capped);
    expect((await capped.store.review(DAY))?.status).toBe("DONE");
    expect((await capped.store.latestCandidate())?.replay).toMatchObject({ bars: 0, complete: false, barsTotal: 4, stopReason: "cost_cap" });

    // Interrupted: the AgentDO restarted while the replay job was RUNNING (the review took most of its alarm).
    const start = istAt(DAY, "16:21");
    const cut: Harness = harness({
      answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }),
      deep: () => {
        cut.clock.set(start + 9 * MINUTE_MS);
        return proposing;
      },
    });
    for (let k = 0; k < 4; k++) await step(cut, k);
    fillArchive(cut);
    cut.clock.set(start);
    await cut.brain.scheduleReview(DAY);
    await cut.brain.runDue(start, start + 10 * MINUTE_MS);
    const job = (await cut.store.jobs()).find((j) => j.kind === "REPLAY")!;
    expect(job.status).toBe("QUEUED");
    await cut.store.putJob({ ...job, status: "RUNNING", startedMs: cut.clock.now() });
    await cut.brain.runDue(cut.clock.now(), cut.clock.now() + 10 * MINUTE_MS);
    expect((await cut.store.latestCandidate())?.replay).toMatchObject({ bars: 0, complete: false, barsTotal: 4, stopReason: "interrupted" });

    // No API key for the reflex model.
    const nokey = harness({ deep: () => proposing, noReflex: true });
    await nokey.store.putCandidate(agentSample.candidate({ id: "k1", status: "SCORING", date: DAY }));
    await nokey.store.putBatch(agentSample.batch(bar(0), { date: DAY, finalists: [{ id: "gen:NIFTY", kind: "GENERIC", index: "NIFTY", label: "g", side: null, contract: null, entryHigh: null, condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null }] }));
    await nokey.store.putJob({ id: "replay:k1", kind: "REPLAY", dueMs: istAt(DAY, "16:30"), status: "QUEUED", startedMs: null, payload: { candidateId: "k1" } });
    nokey.clock.set(istAt(DAY, "16:30"));
    await nokey.brain.runDue(nokey.clock.now(), nokey.clock.now() + 10 * MINUTE_MS);
    expect((await nokey.store.candidate("k1"))?.replay).toMatchObject({ bars: 0, barsTotal: 1, complete: false, stopReason: "no_key" });
  });

  it("gives the earlier days' decisions their labels once their closes arrive (C7)", async () => {
    const D1 = "2026-10-16";
    const h = harness({ start: istAt(D1, "10:00"), answer: answerAll({ "gen:NIFTY": { direction: "LONG", directionConfidence: 0.85, setupQuality: 2 } }), deep: () => quietReview });
    // Day 1: candles to 10:30 only, and the archive never arrived: the 10:00 calls end at 10:30 (stored), the later ones
    // have no closing price.
    await sessionOn(h, D1, "10:00", "10:30");
    h.clock.set(istAt(D1, "16:41"));
    await h.brain.scheduleReview(D1);
    await h.store.putJob({ id: `review:${D1}`, kind: "REVIEW", dueMs: h.clock.now(), status: "QUEUED", startedMs: null, payload: { date: D1, attempt: 2 } });
    await drain(h);
    const missing = (await h.store.decisions(D1)).filter((d) => d.outcome?.status === "MISSING");
    expect(missing.length).toBeGreaterThan(0);
    // Day 2's review, after day 1's archive was backfilled: day 1's missing labels are filled from it.
    fillArchiveOn(h, D1);
    await sessionOn(h, DAY, "10:00", "10:10");
    await (async () => {
      fillArchiveOn(h, DAY);
      h.clock.set(istAt(DAY, "16:21"));
      await h.brain.scheduleReview(DAY);
      await drain(h);
    })();
    const after = await h.store.decisions(D1);
    for (const m of missing) expect(after.find((d) => d.id === m.id)?.outcome).toMatchObject({ status: expect.stringMatching(/^(HIT|MISS|NEUTRAL)$/), source: "BARS_5M" });
  });

  it("prunes rows older than the retention window after a review (O6)", async () => {
    const h = harness({ start: istAt(DAY, "16:00"), deep: () => quietReview });
    const old = addDays(DAY, -(RETENTION_DAYS + 10));
    await h.store.putDecisions([agentSample.decision({ id: "ancient", date: old, barCloseMs: istAt(old, "10:00") })]);
    await h.store.putCall(agentSample.call({ id: "ancient-call", date: old }));
    const kept = addDays(DAY, -(RETENTION_DAYS - 10));
    await h.store.putDecisions([agentSample.decision({ id: "recent", date: kept, barCloseMs: istAt(kept, "10:00") })]);
    fillArchive(h);
    await h.brain.scheduleReview(DAY);
    h.clock.set(istAt(DAY, "16:20"));
    await drain(h);
    expect(await h.store.decisions(old)).toEqual([]);
    expect(await h.store.calls(old)).toEqual([]);
    expect((await h.store.decisions(kept)).map((d) => d.id)).toEqual(["recent"]);
  });
});

describe("AgentBrain: each attempt that may have been billed is charged, and nothing else (M2, M3)", () => {
  it("books escalations answered 529 twice at $0, so the 2-idea day keeps its review (overload-escalation)", async () => {
    let requests = 0;
    const fetch529 = (async () => {
      requests++;
      return overloaded();
    }) as unknown as typeof fetch;
    const escalation = new ClaudeDeepJudge({ apiKey: "sk-ant-test-not-a-key", model: DEEP_MODEL, fetch: fetch529 });
    const review = new TestDeep(() => quietReview);
    const trig = new Set([istAt(DAY, "09:30"), istAt(DAY, "10:55")]);
    const h = harness({
      start: istAt(DAY, "09:00"),
      answer: (req) => req.finalists.map((f) => (trig.has(req.input.barCloseMs) && f.id === "gen:NIFTY" ? dec(f.id, { direction: "LONG", directionConfidence: 0.5, setupQuality: 2 }) : dec(f.id))),
      escalation,
      review,
    });
    h.briefs.latest = brief("b1", istAt(DAY, "09:25"), [ideaN(0), ideaN(1)]);
    await sessionOn(h, DAY);
    expect(requests).toBe(4);
    const escCalls = (await h.store.calls(DAY)).filter((c) => c.kind === "ESCALATION");
    expect(escCalls.map((c) => [c.status, c.costUsd])).toEqual([
      ["ERROR", 0],
      ["ERROR", 0],
    ]);
    fillArchive(h);
    h.clock.set(istAt(DAY, "16:21"));
    await h.brain.scheduleReview(DAY);
    await drain(h);
    expect((await h.store.review(DAY))?.status).toBe("DONE");
  });

  it("charges a reflex attempt that got no answer and was retried, beside the usage of the one that answered (hidden-retry)", async () => {
    const seen: { system: string; user: string }[] = [];
    let attempts = 0;
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      seen.push({ system: body.system[0].text, user: body.messages[0].content });
      if (attempts === 1) throw new TypeError("fetch failed");
      const text = JSON.stringify({ decisions: body.messages[0].content.includes("gen:SENSEX") ? [dec("gen:NIFTY"), dec("gen:SENSEX")] : [dec("gen:NIFTY")] });
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 1_700, output_tokens: 1_200, cache_read_input_tokens: 1_300, cache_creation_input_tokens: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const h = harness({ reflexJudge: new ClaudeReflexJudge({ apiKey: "sk-ant-test-not-a-key", model: REFLEX_MODEL, fetch: fetchFake }), escalation: null, review: null });
    await step(h, 0);
    expect(attempts).toBe(2);
    expect((await h.store.batch(bar(0)))?.status).toBe("OK");
    const [call] = await h.store.calls(DAY);
    const priced = callCostUsd({ inputTokens: 1_700, outputTokens: 1_200, cacheReadTokens: 1_300, cacheCreationTokens: 0 }, REFLEX_MODEL);
    const oneAttempt = worstCaseUsd(REFLEX_MODEL, estimateTokens(seen[0].system) + estimateTokens(seen[0].user), REFLEX_CALL.maxTokens, 1);
    expect(call.costUsd).toBeCloseTo(priced + oneAttempt, 6);
    expect(call.costUsd).toBeGreaterThan(priced);
  });

  it("books a pre-open review answered 529 twice at $0: today's session and review run in full (morning-review-starves)", async () => {
    const D1 = "2026-10-16";
    let recovered = false;
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      if (!recovered) return overloaded();
      const body = JSON.parse(String(init?.body));
      return sseAnswer(JSON.stringify(body.max_tokens > 10_000 ? quietReview : { decision: dec("gen:NIFTY", { reason: "mixed" }), reason: "mixed" }));
    }) as unknown as typeof fetch;
    const deep = new ClaudeDeepJudge({ apiKey: "sk-ant-test-not-a-key", model: DEEP_MODEL, fetch: fetchFake });
    const trigger = istAt(DAY, "10:00");
    const h = harness({
      start: istAt(D1, "09:00"),
      answer: (req) => req.finalists.map((f) => (req.input.barCloseMs === trigger && f.id === "gen:NIFTY" ? dec(f.id, { direction: "LONG", directionConfidence: 0.5, setupQuality: 2 }) : dec(f.id))),
      escalation: deep,
      review: deep,
    });
    await sessionOn(h, D1);
    fillArchiveOn(h, D1);
    // 08:30 the next session day: the operator re-runs the last review; the API is overloaded.
    h.clock.set(istAt(DAY, "08:30"));
    await h.brain.scheduleReview(D1, { force: true });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect((await h.store.review(D1))?.status).toBe("FAILED");
    const reviewCall = (await h.store.calls(DAY)).find((c) => c.kind === "REVIEW")!;
    expect([reviewCall.status, reviewCall.costUsd]).toEqual(["ERROR", 0]);
    recovered = true;
    await sessionOn(h, DAY);
    expect((await h.store.batches(DAY)).filter((b) => b.status !== "OK")).toEqual([]);
    expect((await h.store.escalations(DAY)).map((e) => e.status)).toEqual(["DONE"]);
    fillArchiveOn(h, DAY);
    h.clock.set(istAt(DAY, "16:21"));
    await h.brain.scheduleReview(DAY);
    await drain(h);
    expect((await h.store.review(DAY))?.status).toBe("DONE");
  });

  it("a review run before the open leaves today's reflex calls their money (preopen-review-reflex)", async () => {
    const D1 = "2026-10-16";
    const h = harness({ start: istAt(D1, "10:00"), deep: () => quietReview, settings: { dailyUsdCap: 1.2 } });
    await sessionOn(h, D1, "10:00", "10:05");
    fillArchiveOn(h, D1);
    // Its worst case fits the cap alone, not after the reserve for today's 70 reflex calls.
    h.clock.set(istAt(DAY, "08:30"));
    await h.brain.scheduleReview(D1, { force: true });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    const skipped = (await h.store.review(D1))!;
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.error).toMatch(/^the day's cost cap \(\$1\.2\) leaves no room for the review \(worst case \$\d\.\d{3}\) after the \$0\.\d{3} kept for today's reflex calls; the day was graded and scored$/);
    expect(h.deep.calls).toHaveLength(0);
    // After 15:05 nothing is kept for the reflex: the same review runs.
    h.clock.set(istAt(DAY, "16:30"));
    await h.brain.scheduleReview(D1, { force: true });
    await h.brain.runDue(h.clock.now(), h.clock.now() + 10 * MINUTE_MS);
    expect((await h.store.review(D1))?.status).toBe("DONE");
  });
});
