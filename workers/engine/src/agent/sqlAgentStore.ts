/**
 * The AgentDO's store on the Durable Object's own SQLite (ctx.storage.sql): bars, reflex batches, decisions,
 * model calls, escalations, trades, risk, reviews, candidates, instructions, jobs and meta.
 *
 * Every row keeps the record as JSON in `body`; the other columns are copies for the queries. Upserts use
 * ON CONFLICT ... DO UPDATE, so a row keeps its place (rowid) and lists come back in the order rows were
 * first written, as MemoryAgentStore returns them. Range queries include both ends, as the engine's
 * repositories do. One statement per exec() call: Durable Object SQL takes no transactions statements, and
 * every write between two awaits is committed together anyway.
 */
import type { IndexId } from "../../../../src/engine/types";
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
  GradedDecision,
  GradedNeutral,
  InstructionRecord,
  ReflexBatch,
  ReviewRecord,
  StoredBar,
} from "../../../../src/engine/agent/types";

export type AgentSqlValue = string | number | null;

/** The part of a Durable Object's SqlStorage this store uses (node:sqlite stands in for it in tests). */
export interface AgentSql {
  exec<T extends Record<string, AgentSqlValue>>(query: string, ...bindings: AgentSqlValue[]): { toArray(): T[] };
}

/** Schema version, recorded in meta under SCHEMA_KEY (a key the brain's own meta never uses). */
export const AGENT_SQL_VERSION = 1;
const SCHEMA_KEY = "sql:schema";

const DDL = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS bars (bar_ms INTEGER NOT NULL, idx TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
    snapshot TEXT, tokens_est INTEGER, built_ms INTEGER NOT NULL, PRIMARY KEY (bar_ms, idx))`,
  "CREATE INDEX IF NOT EXISTS bars_date ON bars(date)",
  "CREATE INDEX IF NOT EXISTS bars_idx ON bars(idx, bar_ms)",
  "CREATE TABLE IF NOT EXISTS batches (bar_ms INTEGER PRIMARY KEY, date TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS batches_date ON batches(date)",
  `CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, date TEXT NOT NULL, bar_ms INTEGER NOT NULL, idx TEXT NOT NULL,
    finalist_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, effective INTEGER NOT NULL,
    direction TEXT NOT NULL, confidence REAL NOT NULL, outcome_status TEXT, y INTEGER, body TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS decisions_date ON decisions(date, bar_ms)",
  "CREATE INDEX IF NOT EXISTS decisions_bar ON decisions(bar_ms)",
  "CREATE INDEX IF NOT EXISTS decisions_graded ON decisions(outcome_status, date)",
  `CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    cost_usd REAL NOT NULL, body TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS calls_date ON calls(date)",
  "CREATE TABLE IF NOT EXISTS escalations (id TEXT PRIMARY KEY, date TEXT NOT NULL, bar_ms INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS escalations_date ON escalations(date)",
  "CREATE TABLE IF NOT EXISTS trades (position_id TEXT PRIMARY KEY, date TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS trades_date ON trades(date)",
  "CREATE TABLE IF NOT EXISTS risk (t INTEGER PRIMARY KEY, date TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS reviews (date TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, date TEXT NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS instructions (version TEXT PRIMARY KEY, active INTEGER NOT NULL, created_ms INTEGER NOT NULL, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, due_ms INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due_ms)",
];

/** Creates the tables (idempotent) and records the schema version. Run once in the AgentDO's constructor. */
export function migrateAgentSql(sql: AgentSql): void {
  for (const statement of DDL) sql.exec(statement);
  const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", SCHEMA_KEY).toArray()[0];
  const version = row ? Number(JSON.parse(row.v)) : 0;
  if (version > AGENT_SQL_VERSION) throw new Error(`agent store schema ${version} is newer than this code (${AGENT_SQL_VERSION})`);
  if (version < AGENT_SQL_VERSION) sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", SCHEMA_KEY, JSON.stringify(AGENT_SQL_VERSION));
}

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(text: string): T => JSON.parse(text) as T;
const bodies = <T>(rows: { body: string }[]): T[] => rows.map((r) => parse<T>(r.body));

/** Tables whose rows carry a trading date and are pruned after the retention period. */
const PRUNED_TABLES = ["bars", "batches", "decisions", "calls", "escalations", "risk"] as const;

export class SqlAgentStore implements AgentStore {
  constructor(private readonly sql: AgentSql) {}

  private rows<T extends Record<string, AgentSqlValue>>(query: string, ...bindings: AgentSqlValue[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  private run(query: string, ...bindings: AgentSqlValue[]): void {
    this.sql.exec(query, ...bindings);
  }

  // -------------------------------------------------------------------------
  // Bars
  // -------------------------------------------------------------------------

  async putBar(row: StoredBar): Promise<void> {
    this.run(
      `INSERT INTO bars (bar_ms, idx, date, close, snapshot, tokens_est, built_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bar_ms, idx) DO UPDATE SET date = excluded.date, close = excluded.close, snapshot = excluded.snapshot,
         tokens_est = excluded.tokens_est, built_ms = excluded.built_ms`,
      row.barCloseMs,
      row.index,
      row.date,
      row.close,
      row.snapshot === null ? null : json(row.snapshot),
      row.tokensEst,
      row.builtMs,
    );
  }

  private barOf(r: { bar_ms: number; idx: string; date: string; close: number; snapshot: string | null; tokens_est: number | null; built_ms: number }): StoredBar {
    return {
      barCloseMs: Number(r.bar_ms),
      date: r.date,
      index: r.idx as IndexId,
      close: Number(r.close),
      snapshot: r.snapshot === null ? null : parse(r.snapshot),
      tokensEst: r.tokens_est === null ? null : Number(r.tokens_est),
      builtMs: Number(r.built_ms),
    };
  }

  async bars(date: string): Promise<StoredBar[]> {
    type Row = { bar_ms: number; idx: string; date: string; close: number; snapshot: string | null; tokens_est: number | null; built_ms: number };
    return this.rows<Row>("SELECT * FROM bars WHERE date = ? ORDER BY bar_ms, idx", date).map((r) => this.barOf(r));
  }

  async barsForIndex(index: IndexId, fromMs: number, toMs: number): Promise<StoredBar[]> {
    type Row = { bar_ms: number; idx: string; date: string; close: number; snapshot: string | null; tokens_est: number | null; built_ms: number };
    return this.rows<Row>("SELECT * FROM bars WHERE idx = ? AND bar_ms >= ? AND bar_ms <= ? ORDER BY bar_ms", index, fromMs, toMs).map((r) => this.barOf(r));
  }

  // -------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------

  async putBatch(b: ReflexBatch): Promise<void> {
    this.run(
      "INSERT INTO batches (bar_ms, date, status, body) VALUES (?, ?, ?, ?) ON CONFLICT(bar_ms) DO UPDATE SET date = excluded.date, status = excluded.status, body = excluded.body",
      b.barCloseMs,
      b.date,
      b.status,
      json(b),
    );
  }

  async batch(barCloseMs: number): Promise<ReflexBatch | null> {
    return bodies<ReflexBatch>(this.rows("SELECT body FROM batches WHERE bar_ms = ?", barCloseMs))[0] ?? null;
  }

  async batches(date: string): Promise<ReflexBatch[]> {
    return bodies<ReflexBatch>(this.rows("SELECT body FROM batches WHERE date = ? ORDER BY bar_ms", date));
  }

  async latestBatchAfter(afterBarMs: number): Promise<ReflexBatch | null> {
    return bodies<ReflexBatch>(this.rows("SELECT body FROM batches WHERE bar_ms > ? ORDER BY bar_ms DESC LIMIT 1", afterBarMs))[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  private writeDecision(d: DecisionRecord): void {
    this.run(
      `INSERT INTO decisions (id, date, bar_ms, idx, finalist_id, kind, source, version, effective, direction, confidence, outcome_status, y, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET date = excluded.date, bar_ms = excluded.bar_ms, idx = excluded.idx, finalist_id = excluded.finalist_id,
         kind = excluded.kind, source = excluded.source, version = excluded.version, effective = excluded.effective,
         direction = excluded.direction, confidence = excluded.confidence, outcome_status = excluded.outcome_status, y = excluded.y,
         body = excluded.body`,
      d.id,
      d.date,
      d.barCloseMs,
      d.index,
      d.finalistId,
      d.finalistKind,
      d.source,
      d.instructionVersion,
      d.effective ? 1 : 0,
      d.direction,
      d.directionConfidence,
      d.outcome?.status ?? null,
      d.outcome?.y ?? null,
      json(d),
    );
  }

  private decision(id: string): DecisionRecord | null {
    return bodies<DecisionRecord>(this.rows("SELECT body FROM decisions WHERE id = ?", id))[0] ?? null;
  }

  async putDecisions(rows: DecisionRecord[]): Promise<void> {
    for (const d of rows) this.writeDecision(d);
  }

  async decisions(date: string): Promise<DecisionRecord[]> {
    return bodies<DecisionRecord>(this.rows("SELECT body FROM decisions WHERE date = ? ORDER BY bar_ms, rowid", date));
  }

  async decisionsForBar(barCloseMs: number): Promise<DecisionRecord[]> {
    return bodies<DecisionRecord>(this.rows("SELECT body FROM decisions WHERE bar_ms = ? ORDER BY rowid", barCloseMs));
  }

  async updateExecution(id: string, e: DecisionExecution): Promise<void> {
    const d = this.decision(id);
    if (d) this.writeDecision({ ...d, execution: e });
  }

  async updateOutcomes(rows: { id: string; outcome: DecisionOutcome }[]): Promise<void> {
    for (const r of rows) {
      const d = this.decision(r.id);
      if (d) this.writeDecision({ ...d, outcome: r.outcome });
    }
  }

  async graded(fromDate: string): Promise<GradedDecision[]> {
    const rows = bodies<DecisionRecord>(this.rows("SELECT body FROM decisions WHERE outcome_status IN ('HIT', 'MISS') AND date >= ? ORDER BY date, bar_ms, rowid", fromDate));
    const out: GradedDecision[] = [];
    for (const d of rows) {
      const o = d.outcome;
      if (!o || (o.y !== 0 && o.y !== 1) || d.direction === "NEUTRAL") continue;
      out.push({
        id: d.id,
        date: d.date,
        barCloseMs: d.barCloseMs,
        index: d.index,
        finalistKind: d.finalistKind,
        source: d.source,
        instructionVersion: d.instructionVersion,
        effective: d.effective,
        direction: d.direction,
        directionConfidence: d.directionConfidence,
        y: o.y,
        paid: o.paid === true,
      });
    }
    return out;
  }

  async gradedNeutral(fromDate: string): Promise<GradedNeutral[]> {
    const rows = bodies<DecisionRecord>(this.rows("SELECT body FROM decisions WHERE outcome_status = 'NEUTRAL' AND y IS NOT NULL AND date >= ? ORDER BY date, bar_ms, rowid", fromDate));
    const out: GradedNeutral[] = [];
    for (const d of rows) {
      const y = d.outcome?.y;
      if (y !== 0 && y !== 1) continue;
      out.push({
        id: d.id,
        date: d.date,
        barCloseMs: d.barCloseMs,
        index: d.index,
        finalistKind: d.finalistKind,
        source: d.source,
        instructionVersion: d.instructionVersion,
        effective: d.effective,
        directionConfidence: d.directionConfidence,
        y,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Calls and cost
  // -------------------------------------------------------------------------

  async putCall(c: CallRecord): Promise<void> {
    this.run(
      "INSERT INTO calls (id, date, kind, status, cost_usd, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, kind = excluded.kind, status = excluded.status, cost_usd = excluded.cost_usd, body = excluded.body",
      c.id,
      c.date,
      c.kind,
      c.status,
      c.costUsd,
      json(c),
    );
  }

  async calls(date: string): Promise<CallRecord[]> {
    return bodies<CallRecord>(this.rows("SELECT body FROM calls WHERE date = ? ORDER BY rowid", date));
  }

  async spentUsd(date: string): Promise<number> {
    const r = this.rows<{ total: number | null }>("SELECT SUM(cost_usd) AS total FROM calls WHERE date = ?", date)[0];
    return Number(r?.total ?? 0);
  }

  // -------------------------------------------------------------------------
  // Escalations
  // -------------------------------------------------------------------------

  async putEscalation(e: EscalationRecord): Promise<void> {
    this.run(
      "INSERT INTO escalations (id, date, bar_ms, status, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, bar_ms = excluded.bar_ms, status = excluded.status, body = excluded.body",
      e.id,
      e.date,
      e.barCloseMs,
      e.status,
      json(e),
    );
  }

  async escalations(date: string): Promise<EscalationRecord[]> {
    return bodies<EscalationRecord>(this.rows("SELECT body FROM escalations WHERE date = ? ORDER BY bar_ms, rowid", date));
  }

  async escalation(id: string): Promise<EscalationRecord | null> {
    return bodies<EscalationRecord>(this.rows("SELECT body FROM escalations WHERE id = ?", id))[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Trades and risk
  // -------------------------------------------------------------------------

  async putTrades(rows: AgentTradeRecord[]): Promise<void> {
    for (const t of rows) {
      this.run("INSERT INTO trades (position_id, date, body) VALUES (?, ?, ?) ON CONFLICT(position_id) DO UPDATE SET date = excluded.date, body = excluded.body", t.positionId, t.date, json(t));
    }
  }

  async trades(fromDate: string, toDate: string): Promise<AgentTradeRecord[]> {
    const rows = bodies<AgentTradeRecord>(this.rows("SELECT body FROM trades WHERE date >= ? AND date <= ? ORDER BY date, rowid", fromDate, toDate));
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.exitMs - b.exitMs);
  }

  async putRisk(r: AgentRiskSnapshot): Promise<void> {
    this.run("INSERT INTO risk (t, date, body) VALUES (?, ?, ?) ON CONFLICT(t) DO UPDATE SET date = excluded.date, body = excluded.body", r.t, r.date, json(r));
  }

  async latestRisk(): Promise<AgentRiskSnapshot | null> {
    return bodies<AgentRiskSnapshot>(this.rows("SELECT body FROM risk ORDER BY t DESC LIMIT 1"))[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Reviews, candidates and instructions
  // -------------------------------------------------------------------------

  async putReview(r: ReviewRecord): Promise<void> {
    this.run("INSERT INTO reviews (date, status, body) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET status = excluded.status, body = excluded.body", r.date, r.status, json(r));
  }

  async review(date: string): Promise<ReviewRecord | null> {
    return bodies<ReviewRecord>(this.rows("SELECT body FROM reviews WHERE date = ?", date))[0] ?? null;
  }

  async latestReview(onOrBefore: string): Promise<ReviewRecord | null> {
    return bodies<ReviewRecord>(this.rows("SELECT body FROM reviews WHERE date <= ? ORDER BY date DESC LIMIT 1", onOrBefore))[0] ?? null;
  }

  async putCandidate(c: CandidateRecord): Promise<void> {
    this.run(
      "INSERT INTO candidates (id, date, status, created_ms, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, status = excluded.status, created_ms = excluded.created_ms, body = excluded.body",
      c.id,
      c.date,
      c.status,
      c.createdMs,
      json(c),
    );
  }

  async candidate(id: string): Promise<CandidateRecord | null> {
    return bodies<CandidateRecord>(this.rows("SELECT body FROM candidates WHERE id = ?", id))[0] ?? null;
  }

  async latestCandidate(): Promise<CandidateRecord | null> {
    return bodies<CandidateRecord>(this.rows("SELECT body FROM candidates ORDER BY created_ms DESC, rowid DESC LIMIT 1"))[0] ?? null;
  }

  async putInstruction(i: InstructionRecord): Promise<void> {
    this.run(
      "INSERT INTO instructions (version, active, created_ms, body) VALUES (?, ?, ?, ?) ON CONFLICT(version) DO UPDATE SET active = excluded.active, created_ms = excluded.created_ms, body = excluded.body",
      i.version,
      i.active ? 1 : 0,
      i.createdMs,
      json(i),
    );
    // At most one active text: making one active retires the others.
    if (i.active) this.retireOthers(i.version);
  }

  private retireOthers(version: string): void {
    for (const other of bodies<InstructionRecord>(this.rows("SELECT body FROM instructions WHERE active = 1 AND version <> ?", version))) {
      this.run("UPDATE instructions SET active = 0, body = ? WHERE version = ?", json({ ...other, active: false }), other.version);
    }
  }

  async activeInstruction(): Promise<InstructionRecord | null> {
    return bodies<InstructionRecord>(this.rows("SELECT body FROM instructions WHERE active = 1 ORDER BY created_ms DESC LIMIT 1"))[0] ?? null;
  }

  async setActiveInstruction(version: string): Promise<void> {
    const target = bodies<InstructionRecord>(this.rows("SELECT body FROM instructions WHERE version = ?", version))[0];
    if (!target) throw new Error(`unknown instruction version ${version}`);
    this.run("UPDATE instructions SET active = 1, body = ? WHERE version = ?", json({ ...target, active: true }), version);
    this.retireOthers(version);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async putJob(j: AgentJob): Promise<void> {
    this.run(
      "INSERT INTO jobs (id, kind, due_ms, status, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, due_ms = excluded.due_ms, status = excluded.status, body = excluded.body",
      j.id,
      j.kind,
      j.dueMs,
      j.status,
      json(j),
    );
  }

  async dueJobs(nowMs: number): Promise<AgentJob[]> {
    return bodies<AgentJob>(this.rows("SELECT body FROM jobs WHERE status = 'QUEUED' AND due_ms <= ? ORDER BY due_ms, rowid", nowMs));
  }

  async jobs(): Promise<AgentJob[]> {
    return bodies<AgentJob>(this.rows("SELECT body FROM jobs ORDER BY due_ms, rowid"));
  }

  async deleteJob(id: string): Promise<void> {
    this.run("DELETE FROM jobs WHERE id = ?", id);
  }

  async nextJobMs(): Promise<number | null> {
    const r = this.rows<{ due: number | null }>("SELECT MIN(due_ms) AS due FROM jobs WHERE status = 'QUEUED'")[0];
    return r && r.due !== null ? Number(r.due) : null;
  }

  // -------------------------------------------------------------------------
  // Meta and retention
  // -------------------------------------------------------------------------

  async getMeta<T>(key: string): Promise<T | null> {
    const r = this.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)[0];
    return r ? parse<T>(r.v) : null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    if (key === SCHEMA_KEY) throw new Error(`meta key ${key} is reserved`);
    this.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, json(value ?? null));
  }

  async prune(beforeDate: string): Promise<number> {
    let deleted = 0;
    for (const table of PRUNED_TABLES) {
      const r = this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE date < ?`, beforeDate)[0];
      const n = Number(r?.n ?? 0);
      if (n > 0) this.run(`DELETE FROM ${table} WHERE date < ?`, beforeDate);
      deleted += n;
    }
    return deleted;
  }
}
