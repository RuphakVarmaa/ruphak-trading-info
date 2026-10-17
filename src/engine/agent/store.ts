/**
 * In-memory AgentStore for tests: deep-clones on read and write, like the memory repository. Every put is an
 * upsert on the record's key; a Map keeps a row where it was first written, as SQLite keeps its rowid.
 */
import type { IndexId } from "../types";
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
} from "./types";

const clone = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

/** A stable sort (Array.prototype.sort is stable), so rows that tie keep the order they were written in. */
const sorted = <T>(rows: T[], cmp: (a: T, b: T) => number): T[] => [...rows].sort(cmp);

export class MemoryAgentStore implements AgentStore {
  private readonly _bars = new Map<string, StoredBar>();
  private readonly _batches = new Map<number, ReflexBatch>();
  private readonly _decisions = new Map<string, DecisionRecord>();
  private readonly _calls = new Map<string, CallRecord>();
  private readonly _escalations = new Map<string, EscalationRecord>();
  private readonly _trades = new Map<string, AgentTradeRecord>();
  private readonly _risk = new Map<number, AgentRiskSnapshot>();
  private readonly _reviews = new Map<string, ReviewRecord>();
  private readonly _candidates = new Map<string, CandidateRecord>();
  private readonly _instructions = new Map<string, InstructionRecord>();
  private readonly _jobs = new Map<string, AgentJob>();
  private readonly _meta = new Map<string, unknown>();

  async putBar(row: StoredBar): Promise<void> {
    this._bars.set(`${row.barCloseMs}|${row.index}`, clone(row));
  }

  async bars(date: string): Promise<StoredBar[]> {
    const rows = [...this._bars.values()].filter((b) => b.date === date);
    return sorted(rows, (a, b) => a.barCloseMs - b.barCloseMs || a.index.localeCompare(b.index)).map(clone);
  }

  async barsForIndex(index: IndexId, fromMs: number, toMs: number): Promise<StoredBar[]> {
    const rows = [...this._bars.values()].filter((b) => b.index === index && b.barCloseMs >= fromMs && b.barCloseMs <= toMs);
    return sorted(rows, (a, b) => a.barCloseMs - b.barCloseMs).map(clone);
  }

  async putBatch(b: ReflexBatch): Promise<void> {
    this._batches.set(b.barCloseMs, clone(b));
  }

  async batch(barCloseMs: number): Promise<ReflexBatch | null> {
    return clone(this._batches.get(barCloseMs) ?? null);
  }

  async batches(date: string): Promise<ReflexBatch[]> {
    const rows = [...this._batches.values()].filter((b) => b.date === date);
    return sorted(rows, (a, b) => a.barCloseMs - b.barCloseMs).map(clone);
  }

  async latestBatchAfter(afterBarMs: number): Promise<ReflexBatch | null> {
    let best: ReflexBatch | null = null;
    for (const b of this._batches.values()) if (b.barCloseMs > afterBarMs && (!best || b.barCloseMs > best.barCloseMs)) best = b;
    return clone(best);
  }

  async putDecisions(rows: DecisionRecord[]): Promise<void> {
    for (const d of rows) this._decisions.set(d.id, clone(d));
  }

  async decisions(date: string): Promise<DecisionRecord[]> {
    const rows = [...this._decisions.values()].filter((d) => d.date === date);
    return sorted(rows, (a, b) => a.barCloseMs - b.barCloseMs).map(clone);
  }

  async decisionsForBar(barCloseMs: number): Promise<DecisionRecord[]> {
    return [...this._decisions.values()].filter((d) => d.barCloseMs === barCloseMs).map(clone);
  }

  async updateExecution(id: string, e: DecisionExecution): Promise<void> {
    const d = this._decisions.get(id);
    if (d) this._decisions.set(id, { ...d, execution: clone(e) });
  }

  async updateOutcomes(rows: { id: string; outcome: DecisionOutcome }[]): Promise<void> {
    for (const r of rows) {
      const d = this._decisions.get(r.id);
      if (d) this._decisions.set(r.id, { ...d, outcome: clone(r.outcome) });
    }
  }

  /** Graded rows in date, then bar order; a code-made row (codeMade) is never one: it is not a forecast. */
  private gradedRows(fromDate: string): DecisionRecord[] {
    const rows = [...this._decisions.values()].filter((d) => d.date >= fromDate && d.codeMade !== true && d.outcome !== null && (d.outcome.y === 0 || d.outcome.y === 1));
    return sorted(rows, (a, b) => a.date.localeCompare(b.date) || a.barCloseMs - b.barCloseMs);
  }

  async graded(fromDate: string): Promise<GradedDecision[]> {
    const out: GradedDecision[] = [];
    for (const d of this.gradedRows(fromDate)) {
      const o = d.outcome!;
      if ((o.status !== "HIT" && o.status !== "MISS") || d.direction === "NEUTRAL") continue;
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
        y: o.y as 0 | 1,
        paid: o.paid === true,
      });
    }
    return out;
  }

  async gradedNeutral(fromDate: string): Promise<GradedNeutral[]> {
    const out: GradedNeutral[] = [];
    for (const d of this.gradedRows(fromDate)) {
      if (d.outcome!.status !== "NEUTRAL") continue;
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
        y: d.outcome!.y as 0 | 1,
      });
    }
    return out;
  }

  async putCall(c: CallRecord): Promise<void> {
    this._calls.set(c.id, clone(c));
  }

  async calls(date: string): Promise<CallRecord[]> {
    return [...this._calls.values()].filter((c) => c.date === date).map(clone);
  }

  async spentUsd(date: string): Promise<number> {
    let sum = 0;
    for (const c of this._calls.values()) if (c.date === date) sum += c.costUsd;
    return sum;
  }

  async putEscalation(e: EscalationRecord): Promise<void> {
    this._escalations.set(e.id, clone(e));
  }

  async escalations(date: string): Promise<EscalationRecord[]> {
    const rows = [...this._escalations.values()].filter((e) => e.date === date);
    return sorted(rows, (a, b) => a.barCloseMs - b.barCloseMs).map(clone);
  }

  async escalation(id: string): Promise<EscalationRecord | null> {
    return clone(this._escalations.get(id) ?? null);
  }

  async putTrades(rows: AgentTradeRecord[]): Promise<void> {
    for (const t of rows) this._trades.set(t.positionId, clone(t));
  }

  async trades(fromDate: string, toDate: string): Promise<AgentTradeRecord[]> {
    const rows = [...this._trades.values()].filter((t) => t.date >= fromDate && t.date <= toDate);
    return sorted(rows, (a, b) => a.date.localeCompare(b.date) || a.exitMs - b.exitMs).map(clone);
  }

  async putRisk(r: AgentRiskSnapshot): Promise<void> {
    this._risk.set(r.t, clone(r));
  }

  async latestRisk(): Promise<AgentRiskSnapshot | null> {
    let best: AgentRiskSnapshot | null = null;
    for (const r of this._risk.values()) if (!best || r.t > best.t) best = r;
    return clone(best);
  }

  async putReview(r: ReviewRecord): Promise<void> {
    this._reviews.set(r.date, clone(r));
  }

  async review(date: string): Promise<ReviewRecord | null> {
    return clone(this._reviews.get(date) ?? null);
  }

  async latestReview(onOrBefore: string): Promise<ReviewRecord | null> {
    let best: ReviewRecord | null = null;
    for (const r of this._reviews.values()) if (r.date <= onOrBefore && (!best || r.date > best.date)) best = r;
    return clone(best);
  }

  async putCandidate(c: CandidateRecord): Promise<void> {
    this._candidates.set(c.id, clone(c));
  }

  async candidate(id: string): Promise<CandidateRecord | null> {
    return clone(this._candidates.get(id) ?? null);
  }

  async latestCandidate(): Promise<CandidateRecord | null> {
    // Newest by creation time; on a tie, the one written last.
    let best: CandidateRecord | null = null;
    for (const c of this._candidates.values()) if (!best || c.createdMs >= best.createdMs) best = c;
    return clone(best);
  }

  async putInstruction(i: InstructionRecord): Promise<void> {
    this._instructions.set(i.version, clone(i));
    // At most one active text: making one active retires the others.
    if (i.active) this.retireOthers(i.version);
  }

  private retireOthers(version: string): void {
    for (const [v, other] of this._instructions) if (v !== version && other.active) this._instructions.set(v, { ...other, active: false });
  }

  async activeInstruction(): Promise<InstructionRecord | null> {
    for (const i of this._instructions.values()) if (i.active) return clone(i);
    return null;
  }

  async instruction(version: string): Promise<InstructionRecord | null> {
    return clone(this._instructions.get(version) ?? null);
  }

  async setActiveInstruction(version: string): Promise<void> {
    const target = this._instructions.get(version);
    if (!target) throw new Error(`unknown instruction version ${version}`);
    this._instructions.set(version, { ...target, active: true });
    this.retireOthers(version);
  }

  async putJob(j: AgentJob): Promise<void> {
    this._jobs.set(j.id, clone(j));
  }

  async dueJobs(nowMs: number): Promise<AgentJob[]> {
    const rows = [...this._jobs.values()].filter((j) => j.status === "QUEUED" && j.dueMs <= nowMs);
    return sorted(rows, (a, b) => a.dueMs - b.dueMs).map(clone);
  }

  async jobs(): Promise<AgentJob[]> {
    return sorted([...this._jobs.values()], (a, b) => a.dueMs - b.dueMs).map(clone);
  }

  async deleteJob(id: string): Promise<void> {
    this._jobs.delete(id);
  }

  async nextJobMs(): Promise<number | null> {
    let next: number | null = null;
    for (const j of this._jobs.values()) if (j.status === "QUEUED" && (next === null || j.dueMs < next)) next = j.dueMs;
    return next;
  }

  async getMeta<T>(key: string): Promise<T | null> {
    return this._meta.has(key) ? clone(this._meta.get(key) as T) : null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this._meta.set(key, clone(value ?? null));
  }

  async prune(beforeDate: string): Promise<number> {
    let deleted = 0;
    const drop = <K, V extends { date: string }>(m: Map<K, V>) => {
      for (const [k, v] of m) {
        if (v.date < beforeDate) {
          m.delete(k);
          deleted++;
        }
      }
    };
    drop(this._bars);
    drop(this._batches);
    drop(this._decisions);
    drop(this._calls);
    drop(this._escalations);
    drop(this._risk);
    return deleted;
  }
}
