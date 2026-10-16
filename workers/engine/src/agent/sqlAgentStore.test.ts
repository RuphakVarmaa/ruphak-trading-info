import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { agentStoreContract } from "../../../../src/engine/agent/storeContract";
import type { AgentJob, CallRecord, DecisionOutcome, DecisionRecord, InstructionRecord, ReflexBatch, StoredBar } from "../../../../src/engine/agent/types";
import { AGENT_SQL_VERSION, SqlAgentStore, migrateAgentSql, type AgentSql, type AgentSqlValue } from "./sqlAgentStore";

/**
 * node:sqlite in place of a Durable Object's SqlStorage: exec(query, ...bindings) runs one statement now; rows
 * come back for statements that return them (SELECT, WITH, RETURNING) and an empty list otherwise.
 */
function nodeSql(): AgentSql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec<T extends Record<string, AgentSqlValue>>(query: string, ...bindings: AgentSqlValue[]) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        const rows = stmt.all(...bindings) as T[];
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] as T[] };
    },
  };
}

function freshStore(): SqlAgentStore {
  const sql = nodeSql();
  migrateAgentSql(sql);
  return new SqlAgentStore(sql);
}

// The shared AgentStore contract (src/engine/agent/storeContract.ts), the same suite MemoryAgentStore passes.
agentStoreContract("sql (node:sqlite)", async () => freshStore());

const D = "2026-10-19";
const T0 = Date.parse("2026-10-19T04:05:00Z"); // 09:35 IST

const bar = (o: Partial<StoredBar> = {}): StoredBar => ({ barCloseMs: T0, date: D, index: "NIFTY", close: 25_000, snapshot: null, tokensEst: null, builtMs: T0 + 40_000, ...o });

const decision = (o: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: "d1",
  date: D,
  barCloseMs: T0,
  index: "NIFTY",
  finalistId: "gen:NIFTY",
  finalistKind: "GENERIC",
  source: "REFLEX",
  callId: "c1",
  instructionVersion: "core-1/abcdef01",
  effective: true,
  regime: "TRENDING",
  direction: "LONG",
  directionConfidence: 0.85,
  toxicFlow: false,
  setupQuality: 2,
  riskState: "SAFE",
  reason: "r5 and r15 agree",
  sizing: null,
  execution: null,
  outcome: null,
  ...o,
});

const outcome = (o: Partial<DecisionOutcome>): DecisionOutcome => ({ status: "HIT", y: 1, ret30Pct: 0.2, paid: true, source: "BARS_5M", gradedMs: T0 + 3_600_000, ...o });

const batch = (barCloseMs: number, o: Partial<ReflexBatch> = {}): ReflexBatch => ({
  barCloseMs,
  date: D,
  status: "OK",
  error: null,
  callId: null,
  instructionVersion: "core-1/abcdef01",
  finalists: [],
  briefId: null,
  briefContext: null,
  decisions: [],
  exitOnly: [],
  payoff: { b: 1, n: 0 },
  completedMs: barCloseMs + 60_000,
  ...o,
});

const call = (o: Partial<CallRecord>): CallRecord => ({
  id: "c1",
  date: D,
  kind: "REFLEX",
  barCloseMs: T0,
  model: "reflex",
  instructionVersion: null,
  startedMs: T0,
  latencyMs: 900,
  status: "OK",
  error: null,
  usage: null,
  costUsd: 0.001,
  ...o,
});

const job = (o: Partial<AgentJob>): AgentJob => ({ id: "j1", kind: "REFLEX", dueMs: T0, status: "QUEUED", startedMs: null, payload: {}, ...o });

const instruction = (o: Partial<InstructionRecord>): InstructionRecord => ({ version: "core-1/aaaa0000", guidance: "- prefer NEUTRAL", createdMs: T0, source: "BUILTIN", candidateId: null, active: true, ...o });

describe("migrateAgentSql", () => {
  it("is idempotent and records the schema version", () => {
    const sql = nodeSql();
    migrateAgentSql(sql);
    migrateAgentSql(sql);
    expect(sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'sql:schema'").toArray()).toEqual([{ v: String(AGENT_SQL_VERSION) }]);
  });

  it("refuses a database written by a newer schema", () => {
    const sql = nodeSql();
    migrateAgentSql(sql);
    sql.exec("UPDATE meta SET v = '99' WHERE k = 'sql:schema'");
    expect(() => migrateAgentSql(sql)).toThrow(/newer than this code/);
  });
});

describe("SqlAgentStore", () => {
  it("upserts bars by (bar, index) and returns them in bar order, inclusive ranges", async () => {
    const s = freshStore();
    await s.putBar(bar({ barCloseMs: T0 + 300_000, close: 25_010 }));
    await s.putBar(bar({ index: "SENSEX", close: 82_000 }));
    await s.putBar(bar({ close: 25_001, snapshot: { c: 25_001 } as never, tokensEst: 300 }));
    await s.putBar(bar({ close: 25_002, snapshot: { c: 25_002 } as never, tokensEst: 301 }));
    const rows = await s.bars(D);
    expect(rows.map((r) => [r.barCloseMs - T0, r.index, r.close])).toEqual([
      [0, "NIFTY", 25_002],
      [0, "SENSEX", 82_000],
      [300_000, "NIFTY", 25_010],
    ]);
    expect(rows[0].snapshot).toEqual({ c: 25_002 });
    expect(rows[1].snapshot).toBeNull();
    expect((await s.barsForIndex("NIFTY", T0, T0 + 300_000)).map((r) => r.close)).toEqual([25_002, 25_010]);
    expect(await s.barsForIndex("NIFTY", T0 + 1, T0 + 299_999)).toEqual([]);
  });

  it("finds the newest bar of an index that has a snapshot (the token count's sample)", async () => {
    const s = freshStore();
    expect(s.latestSnapshotBar("NIFTY")).toBeNull();
    await s.putBar(bar({ snapshot: { c: 25_000 } as never, tokensEst: 300 }));
    await s.putBar(bar({ barCloseMs: T0 + 300_000, snapshot: null }));
    await s.putBar(bar({ index: "SENSEX", barCloseMs: T0 + 600_000, snapshot: { c: 82_000 } as never }));
    expect(s.latestSnapshotBar("NIFTY")).toMatchObject({ barCloseMs: T0, snapshot: { c: 25_000 }, tokensEst: 300 });
    expect(s.latestSnapshotBar("SENSEX")?.barCloseMs).toBe(T0 + 600_000);
  });

  it("keeps one batch per bar and finds the newest after a bar", async () => {
    const s = freshStore();
    await s.putBatch(batch(T0));
    await s.putBatch(batch(T0 + 300_000, { status: "FAILED", error: "TIMEOUT" }));
    await s.putBatch(batch(T0 + 300_000, { status: "OK" }));
    expect((await s.batches(D)).map((b) => [b.barCloseMs - T0, b.status])).toEqual([
      [0, "OK"],
      [300_000, "OK"],
    ]);
    expect((await s.latestBatchAfter(T0))?.barCloseMs).toBe(T0 + 300_000);
    expect(await s.latestBatchAfter(T0 + 300_000)).toBeNull();
    expect((await s.batch(T0))?.status).toBe("OK");
    expect(await s.batch(T0 + 1)).toBeNull();
  });

  it("stores decisions, their executions and outcomes, and lists the graded ones", async () => {
    const s = freshStore();
    await s.putDecisions([
      decision({ id: "a" }),
      decision({ id: "b", direction: "SHORT", directionConfidence: 0.3 }),
      decision({ id: "n", direction: "NEUTRAL", directionConfidence: 0.45 }),
      decision({ id: "e", source: "ESCALATION", effective: false, barCloseMs: T0 + 300_000 }),
    ]);
    // An upsert keeps the row's place.
    await s.putDecisions([decision({ id: "a", reason: "changed" })]);
    expect((await s.decisions(D)).map((d) => d.id)).toEqual(["a", "b", "n", "e"]);
    expect((await s.decisionsForBar(T0)).map((d) => d.id)).toEqual(["a", "b", "n"]);
    expect((await s.decisions(D))[0].reason).toBe("changed");

    const exec = { t: T0 + 60_000, gate: { fired: false, lines: [], codeToxic: [], codeRisk: "SAFE" as const, effectiveRisk: "SAFE" as const }, action: "NO_ENTRY" as const, detail: "setup 1 of 3", planId: null, positionId: null, tradingSymbol: null, edge: null, sizing: null };
    await s.updateExecution("a", exec);
    await s.updateExecution("missing", exec);
    expect((await s.decisionsForBar(T0))[0].execution).toEqual(exec);

    await s.updateOutcomes([
      { id: "a", outcome: outcome({}) },
      { id: "b", outcome: outcome({ status: "MISS", y: 0, paid: false }) },
      { id: "n", outcome: outcome({ status: "NEUTRAL", y: 1, paid: null }) },
      { id: "e", outcome: outcome({ status: "CENSORED", y: null, paid: null, source: null }) },
    ]);
    expect(await s.graded(D)).toEqual([
      { id: "a", date: D, barCloseMs: T0, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: "core-1/abcdef01", effective: true, direction: "LONG", directionConfidence: 0.85, y: 1, paid: true },
      { id: "b", date: D, barCloseMs: T0, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", instructionVersion: "core-1/abcdef01", effective: true, direction: "SHORT", directionConfidence: 0.3, y: 0, paid: false },
    ]);
    expect(await s.graded("2026-10-20")).toEqual([]);
    expect((await s.gradedNeutral(D)).map((n) => [n.id, n.y, n.directionConfidence])).toEqual([["n", 1, 0.45]]);
  });

  it("sums the day's spend over every call", async () => {
    const s = freshStore();
    await s.putCall(call({ id: "c1", costUsd: 0.001 }));
    await s.putCall(call({ id: "c2", kind: "ESCALATION", costUsd: 0.19 }));
    await s.putCall(call({ id: "c3", date: "2026-10-16", costUsd: 5 }));
    await s.putCall(call({ id: "c1", costUsd: 0.002 }));
    expect(await s.spentUsd(D)).toBeCloseTo(0.192, 10);
    expect(await s.spentUsd("2026-10-21")).toBe(0);
    expect((await s.calls(D)).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("returns only queued jobs as due, and a RUNNING job never as the next wake", async () => {
    const s = freshStore();
    await s.putJob(job({ id: "late", dueMs: T0 + 60_000 }));
    await s.putJob(job({ id: "now", dueMs: T0 }));
    await s.putJob(job({ id: "review", kind: "REVIEW", dueMs: T0 + 3_600_000 }));
    expect((await s.dueJobs(T0 + 60_000)).map((j) => j.id)).toEqual(["now", "late"]);
    await s.putJob(job({ id: "now", dueMs: T0, status: "RUNNING", startedMs: T0 + 1 }));
    expect((await s.dueJobs(T0 + 60_000)).map((j) => j.id)).toEqual(["late"]);
    expect(await s.nextJobMs()).toBe(T0 + 60_000);
    expect((await s.jobs()).map((j) => [j.id, j.status])).toEqual([
      ["now", "RUNNING"],
      ["late", "QUEUED"],
      ["review", "QUEUED"],
    ]);
    await s.deleteJob("late");
    await s.deleteJob("review");
    expect(await s.nextJobMs()).toBeNull();
  });

  it("keeps one active instruction", async () => {
    const s = freshStore();
    expect(await s.activeInstruction()).toBeNull();
    await s.putInstruction(instruction({ version: "v1" }));
    await s.putInstruction(instruction({ version: "v2", source: "CANDIDATE", candidateId: "cand-1", createdMs: T0 + 1, active: false }));
    expect((await s.activeInstruction())?.version).toBe("v1");
    await s.setActiveInstruction("v2");
    expect(await s.activeInstruction()).toMatchObject({ version: "v2", active: true });
    await s.putInstruction(instruction({ version: "v1", createdMs: T0 + 2, active: true }));
    expect((await s.activeInstruction())?.version).toBe("v1");
    await expect(s.setActiveInstruction("nope")).rejects.toThrow(/unknown instruction/);
    expect((await s.activeInstruction())?.version).toBe("v1");
  });

  it("keeps the latest review, candidate and risk", async () => {
    const s = freshStore();
    const review = (date: string) => ({ date, status: "DONE" as const, dueMs: 0, startedMs: null, doneMs: null, model: null, callId: null, report: null, calibration: null, error: null });
    await s.putReview(review("2026-10-16"));
    await s.putReview(review(D));
    expect((await s.latestReview("2026-10-18"))?.date).toBe("2026-10-16");
    expect((await s.latestReview(D))?.date).toBe(D);
    const cand = (id: string, createdMs: number) => ({ id, date: D, createdMs, baseVersion: "v1", guidance: "g", rationale: "r", wouldBeWrongIf: "w", status: "PENDING" as const, replay: null, decidedMs: null, decidedBy: null });
    await s.putCandidate(cand("old", T0));
    await s.putCandidate(cand("new", T0 + 1));
    expect((await s.latestCandidate())?.id).toBe("new");
    const risk = (t: number) => ({ t, date: D, equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, openPositions: 0, killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, codeRisk: "SAFE" as const });
    await s.putRisk(risk(T0 + 30_000));
    await s.putRisk(risk(T0));
    expect((await s.latestRisk())?.t).toBe(T0 + 30_000);
  });

  it("round-trips meta and reserves the schema key", async () => {
    const s = freshStore();
    expect(await s.getMeta("calibration:current")).toBeNull();
    await s.setMeta("calibration:current", { p: 0.42 });
    await s.setMeta("paused", false);
    expect(await s.getMeta("calibration:current")).toEqual({ p: 0.42 });
    expect(await s.getMeta("paused")).toBe(false);
    await expect(s.setMeta("sql:schema", 2)).rejects.toThrow(/reserved/);
  });

  it("prunes dated rows before the cut-off and keeps trades, reviews and instructions", async () => {
    const s = freshStore();
    const old = "2026-06-01";
    await s.putBar(bar({ date: old, barCloseMs: 1 }));
    await s.putBatch(batch(1, { date: old }));
    await s.putDecisions([decision({ id: "old", date: old, barCloseMs: 1 }), decision({ id: "new" })]);
    await s.putCall(call({ id: "old", date: old }));
    await s.putTrades([{ positionId: "p1", date: old, index: "NIFTY", side: "BULL", finalistId: null, decisionId: null, tradingSymbol: "X", entryMs: 1, exitMs: 2, lots: 1, pnlRupees: -10, pnlPctPremium: -5, exitReason: "STOP", agentExit: null }]);
    await s.putInstruction(instruction({}));
    expect(await s.prune("2026-07-01")).toBe(4);
    expect(await s.bars(old)).toEqual([]);
    expect((await s.decisions(D)).map((d) => d.id)).toEqual(["new"]);
    expect(await s.trades(old, D)).toHaveLength(1);
    expect(await s.activeInstruction()).not.toBeNull();
    expect(await s.prune("2026-07-01")).toBe(0);
  });

  it("returns copies: changing a returned record does not change the store", async () => {
    const s = freshStore();
    await s.putDecisions([decision({})]);
    const [d] = await s.decisions(D);
    d.reason = "mutated";
    expect((await s.decisions(D))[0].reason).toBe("r5 and r15 agree");
  });
});
