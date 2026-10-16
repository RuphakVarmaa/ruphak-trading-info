/**
 * The behaviour every AgentStore must show, as a vitest describe block: MemoryAgentStore and the worker's
 * SqlAgentStore both run it (the pattern of src/engine/repo/contract.ts).
 *
 * Every put is an upsert on the record's key, so a retried write (an alarm that runs again, an execution record
 * sent twice from TE's outbox) never duplicates a row (AMENDMENTS #8, #25). Lists keep the order rows were first
 * written in, after the sort each method names; ranges include both ends.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentJob,
  AgentRiskSnapshot,
  AgentStore,
  AgentTradeRecord,
  CallRecord,
  CandidateRecord,
  DecisionExecution,
  DecisionOutcome,
  DecisionRecord,
  EscalationRecord,
  IndexSnapshot,
  InstructionRecord,
  ReflexBatch,
  ReviewRecord,
  StoredBar,
} from "./types";

const D1 = "2026-10-16";
const D2 = "2026-10-19";
const D3 = "2026-10-21";
/** 09:35 IST on D2. */
const T = Date.parse("2026-10-19T04:05:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Record builders with every field set (the SQL store keeps JSON, so a field left undefined would not round-trip). */
export const agentSample = {
  bar: (o: Partial<StoredBar> = {}): StoredBar => ({ barCloseMs: T, date: D2, index: "NIFTY", close: 25_012, snapshot: null, tokensEst: null, builtMs: T + 40_000, ...o }),
  batch: (barCloseMs: number, o: Partial<ReflexBatch> = {}): ReflexBatch => ({
    barCloseMs,
    date: D2,
    status: "OK",
    error: null,
    callId: "call-1",
    instructionVersion: "core-1/aaaa0000",
    finalists: [],
    briefId: null,
    briefContext: null,
    decisions: [],
    exitOnly: [],
    payoff: { b: 1, n: 0 },
    completedMs: barCloseMs + 50_000,
    ...o,
  }),
  decision: (o: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: "d1",
    date: D2,
    barCloseMs: T,
    index: "NIFTY",
    finalistId: "gen:NIFTY",
    finalistKind: "GENERIC",
    source: "REFLEX",
    callId: "call-1",
    instructionVersion: "core-1/aaaa0000",
    effective: true,
    regime: "TRENDING",
    direction: "LONG",
    directionConfidence: 0.85,
    toxicFlow: false,
    setupQuality: 2,
    riskState: "SAFE",
    reason: "r5 and r15 agree above VWAP",
    sizing: null,
    execution: null,
    outcome: null,
    ...o,
  }),
  outcome: (o: Partial<DecisionOutcome> = {}): DecisionOutcome => ({ status: "HIT", y: 1, ret30Pct: 0.2, paid: true, source: "BARS_5M", gradedMs: T + 7 * 60 * MIN, ...o }),
  execution: (o: Partial<DecisionExecution> = {}): DecisionExecution => ({
    t: T + 70_000,
    gate: { fired: false, lines: [{ gate: "confidence", passed: false, detail: "0.72 is not above 0.80" }], codeToxic: [], codeRisk: "SAFE", effectiveRisk: "SAFE" },
    action: "NO_ENTRY",
    detail: "confidence 0.72 is not above 0.80",
    planId: null,
    positionId: null,
    tradingSymbol: null,
    edge: null,
    sizing: null,
    ...o,
  }),
  call: (o: Partial<CallRecord> = {}): CallRecord => ({
    id: "call-1",
    date: D2,
    kind: "REFLEX",
    barCloseMs: T,
    model: "reflex-model",
    instructionVersion: "core-1/aaaa0000",
    startedMs: T + 31_000,
    latencyMs: 4_200,
    status: "OK",
    error: null,
    usage: { inputTokens: 1_700, outputTokens: 900, cacheReadTokens: 1_300, cacheCreationTokens: 0 },
    costUsd: 0.0006,
    ...o,
  }),
  escalation: (o: Partial<EscalationRecord> = {}): EscalationRecord => ({
    id: "e1",
    date: D2,
    barCloseMs: T,
    index: "NIFTY",
    finalistId: "gen:NIFTY",
    trigger: "LOW_CONFIDENCE",
    status: "QUEUED",
    requestedMs: T + 40_000,
    doneMs: null,
    reflexDecisionId: "d1",
    decision: null,
    reason: null,
    callId: null,
    appliedBarMs: null,
    ...o,
  }),
  trade: (o: Partial<AgentTradeRecord> = {}): AgentTradeRecord => ({
    positionId: "p1",
    date: D2,
    index: "NIFTY",
    side: "BULL",
    finalistId: "gen:NIFTY",
    decisionId: "d1",
    tradingSymbol: "NIFTY26O2025000CE",
    entryMs: T + 70_000,
    exitMs: T + 40 * MIN,
    lots: 1,
    pnlRupees: -1_250.5,
    pnlPctPremium: -12.8,
    exitReason: "STOP",
    agentExit: null,
    ...o,
  }),
  risk: (o: Partial<AgentRiskSnapshot> = {}): AgentRiskSnapshot => ({
    t: T,
    date: D2,
    equity: 498_000,
    peakEquity: 500_000,
    ddPct: 0.4,
    dayLossPct: 0.4,
    openPositions: 0,
    killSwitch: false,
    killReason: null,
    mainKillSwitch: false,
    ddHalt: false,
    codeRisk: "SAFE",
    ...o,
  }),
  review: (o: Partial<ReviewRecord> = {}): ReviewRecord => ({
    date: D2,
    status: "PENDING",
    dueMs: T + 7 * 60 * MIN,
    startedMs: null,
    doneMs: null,
    model: null,
    callId: null,
    report: null,
    calibration: null,
    error: null,
    ...o,
  }),
  candidate: (o: Partial<CandidateRecord> = {}): CandidateRecord => ({
    id: "cand-1",
    date: D2,
    createdMs: T + 8 * 60 * MIN,
    baseVersion: "core-1/aaaa0000",
    guidance: "- Prefer NEUTRAL when the returns disagree.",
    rationale: "two false alarms against the flow",
    wouldBeWrongIf: "the next sessions show more misses",
    status: "SCORING",
    replay: null,
    decidedMs: null,
    decidedBy: null,
    ...o,
  }),
  instruction: (o: Partial<InstructionRecord> = {}): InstructionRecord => ({
    version: "core-1/aaaa0000",
    guidance: "- Prefer NEUTRAL.",
    createdMs: T - DAY,
    source: "BUILTIN",
    candidateId: null,
    active: true,
    ...o,
  }),
  job: (o: Partial<AgentJob> = {}): AgentJob => ({ id: "job-1", kind: "REFLEX", dueMs: T + 1_000, status: "QUEUED", startedMs: null, payload: { barCloseMs: T }, ...o }),
};

export function agentStoreContract(name: string, make: () => Promise<AgentStore>): void {
  const s = agentSample;

  describe(`AgentStore contract: ${name}`, () => {
    it("stores bars per bar and index, upserts them, and lists them by date and by index range (both ends included)", async () => {
      const st = await make();
      await st.putBar(s.bar({ barCloseMs: T + 5 * MIN, index: "SENSEX", close: 81_900 }));
      await st.putBar(s.bar({ barCloseMs: T + 5 * MIN, index: "NIFTY", close: 25_020 }));
      await st.putBar(s.bar({ barCloseMs: T, index: "NIFTY", close: 25_012, snapshot: null }));
      await st.putBar(s.bar({ barCloseMs: T + 10 * MIN, index: "NIFTY", close: 25_030 }));
      await st.putBar(s.bar({ barCloseMs: T - DAY * 3, date: D1, index: "NIFTY", close: 24_800 }));
      // A second write of the same bar replaces it (a resubmitted bar never duplicates).
      await st.putBar(s.bar({ barCloseMs: T + 5 * MIN, index: "NIFTY", close: 25_021, tokensEst: 300 }));

      const today = await st.bars(D2);
      expect(today.map((b) => [b.barCloseMs - T, b.index, b.close])).toEqual([
        [0, "NIFTY", 25_012],
        [5 * MIN, "NIFTY", 25_021],
        [5 * MIN, "SENSEX", 81_900],
        [10 * MIN, "NIFTY", 25_030],
      ]);
      expect(today[1].tokensEst).toBe(300);
      expect((await st.bars(D1)).map((b) => b.close)).toEqual([24_800]);
      expect(await st.bars(D3)).toEqual([]);
      expect((await st.barsForIndex("NIFTY", T, T + 5 * MIN)).map((b) => b.close)).toEqual([25_012, 25_021]);
      expect((await st.barsForIndex("SENSEX", T - DAY * 10, T + DAY)).map((b) => b.close)).toEqual([81_900]);
      expect(await st.barsForIndex("SENSEX", T, T + 4 * MIN)).toEqual([]);
    });

    it("round-trips a bar's snapshot", async () => {
      const st = await make();
      const snapshot: IndexSnapshot = {
        c: 25_012, r5: 12, r15: -8, r60: 31, ro: 45, vw: 18, vz: 0.9, orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
        rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
        o: { k: 25_000, cm: 112.4, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.4, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
        cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
        bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
      };
      await st.putBar(s.bar({ snapshot: structuredClone(snapshot), tokensEst: 290 }));
      const [b] = await st.bars(D2);
      expect(b.snapshot).toEqual(snapshot);
      expect(b.tokensEst).toBe(290);
    });

    it("upserts batches per bar close and finds the newest batch after a bar", async () => {
      const st = await make();
      expect(await st.latestBatchAfter(0)).toBeNull();
      await st.putBatch(s.batch(T + 5 * MIN, { status: "FAILED", error: "TIMEOUT" }));
      await st.putBatch(s.batch(T));
      await st.putBatch(s.batch(T - DAY * 3, { date: D1 }));
      // The same bar written again replaces the first write.
      await st.putBatch(s.batch(T + 5 * MIN, { status: "OK", error: null, briefId: "brief-1", briefContext: { headline: "Flat open", factors: ["FII flows: NEUTRAL — small"] } }));

      expect((await st.batches(D2)).map((b) => [b.barCloseMs - T, b.status])).toEqual([
        [0, "OK"],
        [5 * MIN, "OK"],
      ]);
      expect((await st.batch(T + 5 * MIN))?.briefContext).toEqual({ headline: "Flat open", factors: ["FII flows: NEUTRAL — small"] });
      expect(await st.batch(T + 10 * MIN)).toBeNull();
      expect((await st.latestBatchAfter(0))?.barCloseMs).toBe(T + 5 * MIN);
      expect((await st.latestBatchAfter(T))?.barCloseMs).toBe(T + 5 * MIN);
      expect(await st.latestBatchAfter(T + 5 * MIN)).toBeNull();
      expect((await st.batches(D1)).length).toBe(1);
    });

    it("upserts decisions by id and lists them by date (bar order) and by bar", async () => {
      const st = await make();
      await st.putDecisions([
        s.decision({ id: "b2-nifty", barCloseMs: T + 5 * MIN }),
        s.decision({ id: "b1-nifty", barCloseMs: T }),
        s.decision({ id: "b1-sensex", barCloseMs: T, index: "SENSEX", finalistId: "gen:SENSEX" }),
        s.decision({ id: "old", date: D1, barCloseMs: T - DAY * 3 }),
      ]);
      // Written again (an alarm that ran twice): still one row, with the newer values.
      await st.putDecisions([s.decision({ id: "b1-nifty", barCloseMs: T, directionConfidence: 0.9 })]);

      expect((await st.decisions(D2)).map((d) => d.id)).toEqual(["b1-nifty", "b1-sensex", "b2-nifty"]);
      expect((await st.decisions(D2)).find((d) => d.id === "b1-nifty")?.directionConfidence).toBe(0.9);
      expect((await st.decisionsForBar(T)).map((d) => d.id)).toEqual(["b1-nifty", "b1-sensex"]);
      expect(await st.decisionsForBar(T + 10 * MIN)).toEqual([]);
      expect((await st.decisions(D1)).map((d) => d.id)).toEqual(["old"]);
    });

    it("updates a decision's execution and outcome in place, idempotently, and ignores unknown ids", async () => {
      const st = await make();
      await st.putDecisions([s.decision({ id: "d1" }), s.decision({ id: "d2", index: "SENSEX" })]);
      const e = s.execution();
      await st.updateExecution("d1", e);
      await st.updateExecution("d1", e);
      await st.updateExecution("missing", e);
      await st.updateOutcomes([{ id: "d2", outcome: s.outcome({ status: "MISS", y: 0, paid: false, ret30Pct: -0.05 }) }]);
      await st.updateOutcomes([{ id: "d2", outcome: s.outcome({ status: "MISS", y: 0, paid: false, ret30Pct: -0.05 }) }, { id: "nope", outcome: s.outcome() }]);
      const rows = await st.decisions(D2);
      expect(rows).toHaveLength(2);
      expect(rows[0].execution).toEqual(e);
      expect(rows[0].outcome).toBeNull();
      expect(rows[1].outcome).toEqual(s.outcome({ status: "MISS", y: 0, paid: false, ret30Pct: -0.05 }));
      expect(rows[1].execution).toBeNull();
    });

    it("lists graded directional decisions (HIT or MISS) and graded NEUTRAL decisions from a date on", async () => {
      const st = await make();
      await st.putDecisions([
        s.decision({ id: "hit", outcome: s.outcome({ status: "HIT", y: 1, paid: false }) }),
        s.decision({ id: "miss", barCloseMs: T + 5 * MIN, direction: "SHORT", source: "ESCALATION", effective: false, outcome: s.outcome({ status: "MISS", y: 0, paid: false, source: "STORED" }) }),
        s.decision({ id: "neutral", barCloseMs: T + 10 * MIN, direction: "NEUTRAL", directionConfidence: 0.45, outcome: s.outcome({ status: "NEUTRAL", y: 1, paid: null }) }),
        s.decision({ id: "censored", barCloseMs: T + 15 * MIN, outcome: s.outcome({ status: "CENSORED", y: null, paid: null, source: null, ret30Pct: null }) }),
        s.decision({ id: "missing", barCloseMs: T + 20 * MIN, outcome: s.outcome({ status: "MISSING", y: null, paid: null, source: null, ret30Pct: null }) }),
        s.decision({ id: "ungraded", barCloseMs: T + 25 * MIN }),
        s.decision({ id: "old-hit", date: D1, barCloseMs: T - DAY * 3, outcome: s.outcome({ paid: true }) }),
        s.decision({ id: "old-neutral", date: D1, barCloseMs: T - DAY * 3 + MIN, direction: "NEUTRAL", outcome: s.outcome({ status: "NEUTRAL", y: 0, paid: null }) }),
      ]);
      const graded = await st.graded(D2);
      expect(graded).toEqual([
        {
          id: "hit", date: D2, barCloseMs: T, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: "core-1/aaaa0000",
          effective: true, direction: "LONG", directionConfidence: 0.85, y: 1, paid: false,
        },
        {
          id: "miss", date: D2, barCloseMs: T + 5 * MIN, index: "NIFTY", finalistKind: "GENERIC", source: "ESCALATION", instructionVersion: "core-1/aaaa0000",
          effective: false, direction: "SHORT", directionConfidence: 0.85, y: 0, paid: false,
        },
      ]);
      expect((await st.graded(D1)).map((g) => [g.id, g.paid])).toEqual([
        ["old-hit", true],
        ["hit", false],
        ["miss", false],
      ]);
      expect(await st.graded(D3)).toEqual([]);
      expect(await st.gradedNeutral(D2)).toEqual([
        {
          id: "neutral", date: D2, barCloseMs: T + 10 * MIN, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: "core-1/aaaa0000",
          effective: true, directionConfidence: 0.45, y: 1,
        },
      ]);
      expect((await st.gradedNeutral(D1)).map((g) => [g.id, g.y])).toEqual([
        ["old-neutral", 0],
        ["neutral", 1],
      ]);
    });

    it("upserts call records by id, so a call written before it runs and again after counts once", async () => {
      const st = await make();
      expect(await st.spentUsd(D2)).toBe(0);
      expect(await st.calls(D2)).toEqual([]);
      // Written before the call (AMENDMENTS #8), then with the outcome.
      await st.putCall(s.call({ id: "c1", status: "TIMEOUT", latencyMs: null, usage: null, costUsd: 0 }));
      await st.putCall(s.call({ id: "c2", kind: "ESCALATION", costUsd: 0.08 }));
      await st.putCall(s.call({ id: "c1", costUsd: 0.0006 }));
      await st.putCall(s.call({ id: "c3", date: D1, costUsd: 1.5 }));
      expect((await st.calls(D2)).map((c) => [c.id, c.status])).toEqual([
        ["c1", "OK"],
        ["c2", "OK"],
      ]);
      expect(await st.spentUsd(D2)).toBeCloseTo(0.0806, 9);
      expect(await st.spentUsd(D1)).toBeCloseTo(1.5, 9);
      expect(await st.spentUsd(D3)).toBe(0);
      expect((await st.calls(D2))[0].usage).toEqual(s.call().usage);
    });

    it("upserts escalations by id and lists them by date in bar order", async () => {
      const st = await make();
      await st.putEscalation(s.escalation({ id: "e2", barCloseMs: T + 10 * MIN, index: "SENSEX" }));
      await st.putEscalation(s.escalation({ id: "e1" }));
      await st.putEscalation(s.escalation({ id: "e0", date: D1, barCloseMs: T - DAY * 3 }));
      const decision = { finalistId: "gen:NIFTY", regime: "TRENDING", direction: "NEUTRAL", directionConfidence: 0.5, toxicFlow: false, setupQuality: 1, riskState: "SAFE", reason: "mixed returns" } as const;
      await st.putEscalation(s.escalation({ id: "e1", status: "DONE", doneMs: T + 100_000, decision, reason: "returns disagree", callId: "c9" }));
      expect((await st.escalations(D2)).map((e) => [e.id, e.status])).toEqual([
        ["e1", "DONE"],
        ["e2", "QUEUED"],
      ]);
      expect((await st.escalation("e1"))?.decision).toEqual(decision);
      expect(await st.escalation("zz")).toBeNull();
      expect((await st.escalations(D1)).map((e) => e.id)).toEqual(["e0"]);
    });

    it("upserts trades by position id (a re-sent day never duplicates) and lists a date range by exit time", async () => {
      const st = await make();
      await st.putTrades([s.trade({ positionId: "p2", exitMs: T + 90 * MIN }), s.trade({ positionId: "p1" })]);
      await st.putTrades([s.trade({ positionId: "p0", date: D1, entryMs: T - DAY * 3, exitMs: T - DAY * 3 + 30 * MIN })]);
      await st.putTrades([s.trade({ positionId: "p1", pnlRupees: -900 }), s.trade({ positionId: "p2", exitMs: T + 90 * MIN })]);
      expect((await st.trades(D2, D2)).map((t) => [t.positionId, t.pnlRupees])).toEqual([
        ["p1", -900],
        ["p2", -1_250.5],
      ]);
      expect((await st.trades(D1, D3)).map((t) => t.positionId)).toEqual(["p0", "p1", "p2"]);
      expect(await st.trades(D3, D3)).toEqual([]);
    });

    it("upserts risk snapshots by time and returns the latest", async () => {
      const st = await make();
      expect(await st.latestRisk()).toBeNull();
      await st.putRisk(s.risk({ t: T + MIN, equity: 497_000 }));
      await st.putRisk(s.risk({ t: T }));
      await st.putRisk(s.risk({ t: T + MIN, equity: 496_500, ddHalt: true }));
      expect(await st.latestRisk()).toEqual(s.risk({ t: T + MIN, equity: 496_500, ddHalt: true }));
    });

    it("upserts reviews by date and finds the latest on or before a date", async () => {
      const st = await make();
      expect(await st.latestReview(D2)).toBeNull();
      await st.putReview(s.review({ date: D1, status: "DONE" }));
      await st.putReview(s.review({ date: D2 }));
      await st.putReview(s.review({ date: D2, status: "RUNNING", startedMs: T + 7 * 60 * MIN }));
      expect((await st.review(D2))?.status).toBe("RUNNING");
      expect(await st.review(D3)).toBeNull();
      expect((await st.latestReview(D3))?.date).toBe(D2);
      expect((await st.latestReview(D2))?.date).toBe(D2);
      expect((await st.latestReview("2026-10-18"))?.date).toBe(D1);
      expect(await st.latestReview("2026-10-01")).toBeNull();
    });

    it("upserts candidates by id and returns the newest", async () => {
      const st = await make();
      expect(await st.latestCandidate()).toBeNull();
      await st.putCandidate(s.candidate({ id: "old", createdMs: T - DAY, status: "REJECTED" }));
      await st.putCandidate(s.candidate({ id: "new" }));
      await st.putCandidate(s.candidate({ id: "new", status: "PENDING", replay: { bars: 70, graded: 60, brierCandidate: 0.24, brierCurrentReplayed: 0.25, brierCurrentLive: 0.26, firesCandidate: 2, firesCurrent: 3, hitRateCandidate: 0.5, hitRateCurrent: 0.33, costUsd: 0.11, complete: true, cursorBarMs: null, label: "in-sample, not proof" } }));
      expect((await st.latestCandidate())?.id).toBe("new");
      expect((await st.candidate("new"))?.replay?.label).toBe("in-sample, not proof");
      expect((await st.candidate("old"))?.status).toBe("REJECTED");
      expect(await st.candidate("none")).toBeNull();
    });

    it("keeps at most one active instruction text", async () => {
      const st = await make();
      expect(await st.activeInstruction()).toBeNull();
      await st.putInstruction(s.instruction({ version: "v-builtin", active: true }));
      expect((await st.activeInstruction())?.version).toBe("v-builtin");
      // An approved candidate's text, stored inactive and then made active.
      await st.putInstruction(s.instruction({ version: "v-cand", source: "CANDIDATE", candidateId: "cand-1", active: false, createdMs: T }));
      expect((await st.activeInstruction())?.version).toBe("v-builtin");
      await st.setActiveInstruction("v-cand");
      expect(await st.activeInstruction()).toEqual(s.instruction({ version: "v-cand", source: "CANDIDATE", candidateId: "cand-1", active: true, createdMs: T }));
      // Back to the built-in text (a revert), and a put that is active retires the other.
      await st.setActiveInstruction("v-builtin");
      expect((await st.activeInstruction())?.version).toBe("v-builtin");
      await st.putInstruction(s.instruction({ version: "v-cand", source: "CANDIDATE", candidateId: "cand-1", active: true, createdMs: T }));
      expect((await st.activeInstruction())?.version).toBe("v-cand");
      await st.setActiveInstruction("v-builtin");
      expect((await st.activeInstruction())?.version).toBe("v-builtin");
      await expect(st.setActiveInstruction("unknown")).rejects.toThrow();
      expect((await st.activeInstruction())?.version).toBe("v-builtin");
    });

    it("queues jobs: due ones oldest first, RUNNING ones out of the queue but still listed, deleted ones gone", async () => {
      const st = await make();
      expect(await st.nextJobMs()).toBeNull();
      expect(await st.dueJobs(T + DAY)).toEqual([]);
      await st.putJob(s.job({ id: "review", kind: "REVIEW", dueMs: T + 7 * 60 * MIN, payload: { date: D2 } }));
      await st.putJob(s.job({ id: "reflex-2", dueMs: T + 5 * MIN }));
      await st.putJob(s.job({ id: "reflex-1", dueMs: T }));
      await st.putJob(s.job({ id: "esc", kind: "ESCALATION", dueMs: T, payload: { escalationId: "e1" } }));

      expect(await st.nextJobMs()).toBe(T);
      expect((await st.dueJobs(T)).map((j) => j.id)).toEqual(["reflex-1", "esc"]);
      expect((await st.dueJobs(T + 5 * MIN)).map((j) => j.id)).toEqual(["reflex-1", "esc", "reflex-2"]);
      expect(await st.dueJobs(T - 1)).toEqual([]);

      // Marked RUNNING before its call (AMENDMENTS #8): no longer due, still listed for restart recovery.
      await st.putJob(s.job({ id: "reflex-1", dueMs: T, status: "RUNNING", startedMs: T + 31_000 }));
      expect((await st.dueJobs(T + 5 * MIN)).map((j) => j.id)).toEqual(["esc", "reflex-2"]);
      expect(await st.nextJobMs()).toBe(T);
      await st.deleteJob("esc");
      expect(await st.nextJobMs()).toBe(T + 5 * MIN);
      const all = await st.jobs();
      expect(all.map((j) => [j.id, j.status]).sort()).toEqual([
        ["reflex-1", "RUNNING"],
        ["reflex-2", "QUEUED"],
        ["review", "QUEUED"],
      ]);
      expect(all.find((j) => j.id === "reflex-1")).toEqual(s.job({ id: "reflex-1", dueMs: T, status: "RUNNING", startedMs: T + 31_000 }));
      await st.deleteJob("reflex-1");
      await st.deleteJob("not-there");
      expect((await st.jobs()).map((j) => j.id).sort()).toEqual(["reflex-2", "review"]);
      expect((await st.dueJobs(T + DAY)).map((j) => j.payload)).toEqual([{ barCloseMs: T }, { date: D2 }]);
    });

    it("stores meta values by key", async () => {
      const st = await make();
      expect(await st.getMeta("calibration:current")).toBeNull();
      await st.setMeta("calibration:current", { graded: 12, brier: 0.24, buckets: [{ from: 0.8, to: 0.9, n: 3 }] });
      await st.setMeta("paused", true);
      await st.setMeta("calibration:current", { graded: 13, brier: 0.23, buckets: [] });
      expect(await st.getMeta("calibration:current")).toEqual({ graded: 13, brier: 0.23, buckets: [] });
      expect(await st.getMeta<boolean>("paused")).toBe(true);
      await st.setMeta("paused", false);
      expect(await st.getMeta<boolean>("paused")).toBe(false);
    });

    it("returns copies: changing a row after writing it or after reading it changes nothing stored", async () => {
      const st = await make();
      const d = s.decision({ id: "d1" });
      await st.putDecisions([d]);
      d.direction = "SHORT";
      const [read] = await st.decisions(D2);
      expect(read.direction).toBe("LONG");
      read.direction = "NEUTRAL";
      expect((await st.decisionsForBar(T))[0].direction).toBe("LONG");

      const b = s.batch(T, { finalists: [] });
      await st.putBatch(b);
      b.status = "FAILED";
      const got = await st.batch(T);
      expect(got?.status).toBe("OK");
      got!.decisions.push(s.decision());
      expect((await st.batch(T))?.decisions).toEqual([]);

      const meta = { list: [1, 2] };
      await st.setMeta("m", meta);
      meta.list.push(3);
      const m = await st.getMeta<{ list: number[] }>("m");
      expect(m?.list).toEqual([1, 2]);
      m!.list.push(4);
      expect((await st.getMeta<{ list: number[] }>("m"))?.list).toEqual([1, 2]);
    });

    it("prunes bars, batches, decisions, calls, escalations and risk rows dated before a date, and keeps the rest", async () => {
      const st = await make();
      const old = { date: D1 };
      await st.putBar(s.bar({ ...old, barCloseMs: T - DAY * 3 }));
      await st.putBar(s.bar());
      await st.putBatch(s.batch(T - DAY * 3, old));
      await st.putBatch(s.batch(T));
      await st.putDecisions([s.decision({ ...old, id: "old", barCloseMs: T - DAY * 3 }), s.decision({ id: "new" })]);
      await st.putCall(s.call({ ...old, id: "c-old" }));
      await st.putCall(s.call({ id: "c-new" }));
      await st.putEscalation(s.escalation({ ...old, id: "e-old", barCloseMs: T - DAY * 3 }));
      await st.putEscalation(s.escalation({ id: "e-new" }));
      await st.putRisk(s.risk({ ...old, t: T - DAY * 3 }));
      await st.putRisk(s.risk({ t: T }));
      // Kept whatever their date: trades, reviews, candidates, instructions, jobs and meta.
      await st.putTrades([s.trade({ ...old, positionId: "p-old" })]);
      await st.putReview(s.review({ date: D1 }));
      await st.putCandidate(s.candidate({ date: D1 }));
      await st.putInstruction(s.instruction());
      await st.putJob(s.job());
      await st.setMeta("k", 1);

      expect(await st.prune(D2)).toBe(6);
      expect(await st.bars(D1)).toEqual([]);
      expect(await st.batches(D1)).toEqual([]);
      expect(await st.decisions(D1)).toEqual([]);
      expect(await st.calls(D1)).toEqual([]);
      expect(await st.escalations(D1)).toEqual([]);
      expect((await st.latestRisk())?.t).toBe(T);
      expect((await st.bars(D2)).length).toBe(1);
      expect((await st.batches(D2)).length).toBe(1);
      expect((await st.decisions(D2)).map((d) => d.id)).toEqual(["new"]);
      expect((await st.calls(D2)).map((c) => c.id)).toEqual(["c-new"]);
      expect((await st.escalations(D2)).map((e) => e.id)).toEqual(["e-new"]);
      expect((await st.trades(D1, D1)).map((t) => t.positionId)).toEqual(["p-old"]);
      expect((await st.review(D1))?.date).toBe(D1);
      expect((await st.candidate("cand-1"))?.date).toBe(D1);
      expect(await st.activeInstruction()).not.toBeNull();
      expect(await st.jobs()).toHaveLength(1);
      expect(await st.getMeta("k")).toBe(1);
      // Nothing left to prune.
      expect(await st.prune(D2)).toBe(0);
    });
  });
}
