/** In-memory AgentStore for tests: deep-clones on read and write, like the memory repository. */
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
import { notImplemented } from "./notImplemented";

export class MemoryAgentStore implements AgentStore {
  putBar(row: StoredBar): Promise<void> {
    return notImplemented(row);
  }
  bars(date: string): Promise<StoredBar[]> {
    return notImplemented(date);
  }
  barsForIndex(index: IndexId, fromMs: number, toMs: number): Promise<StoredBar[]> {
    return notImplemented(index, fromMs, toMs);
  }
  putBatch(b: ReflexBatch): Promise<void> {
    return notImplemented(b);
  }
  batch(barCloseMs: number): Promise<ReflexBatch | null> {
    return notImplemented(barCloseMs);
  }
  batches(date: string): Promise<ReflexBatch[]> {
    return notImplemented(date);
  }
  latestBatchAfter(afterBarMs: number): Promise<ReflexBatch | null> {
    return notImplemented(afterBarMs);
  }
  putDecisions(rows: DecisionRecord[]): Promise<void> {
    return notImplemented(rows);
  }
  decisions(date: string): Promise<DecisionRecord[]> {
    return notImplemented(date);
  }
  decisionsForBar(barCloseMs: number): Promise<DecisionRecord[]> {
    return notImplemented(barCloseMs);
  }
  updateExecution(id: string, e: DecisionExecution): Promise<void> {
    return notImplemented(id, e);
  }
  updateOutcomes(rows: { id: string; outcome: DecisionOutcome }[]): Promise<void> {
    return notImplemented(rows);
  }
  graded(fromDate: string): Promise<GradedDecision[]> {
    return notImplemented(fromDate);
  }
  gradedNeutral(fromDate: string): Promise<GradedNeutral[]> {
    return notImplemented(fromDate);
  }
  putCall(c: CallRecord): Promise<void> {
    return notImplemented(c);
  }
  calls(date: string): Promise<CallRecord[]> {
    return notImplemented(date);
  }
  spentUsd(date: string): Promise<number> {
    return notImplemented(date);
  }
  putEscalation(e: EscalationRecord): Promise<void> {
    return notImplemented(e);
  }
  escalations(date: string): Promise<EscalationRecord[]> {
    return notImplemented(date);
  }
  escalation(id: string): Promise<EscalationRecord | null> {
    return notImplemented(id);
  }
  putTrades(rows: AgentTradeRecord[]): Promise<void> {
    return notImplemented(rows);
  }
  trades(fromDate: string, toDate: string): Promise<AgentTradeRecord[]> {
    return notImplemented(fromDate, toDate);
  }
  putRisk(r: AgentRiskSnapshot): Promise<void> {
    return notImplemented(r);
  }
  latestRisk(): Promise<AgentRiskSnapshot | null> {
    return notImplemented();
  }
  putReview(r: ReviewRecord): Promise<void> {
    return notImplemented(r);
  }
  review(date: string): Promise<ReviewRecord | null> {
    return notImplemented(date);
  }
  latestReview(onOrBefore: string): Promise<ReviewRecord | null> {
    return notImplemented(onOrBefore);
  }
  putCandidate(c: CandidateRecord): Promise<void> {
    return notImplemented(c);
  }
  candidate(id: string): Promise<CandidateRecord | null> {
    return notImplemented(id);
  }
  latestCandidate(): Promise<CandidateRecord | null> {
    return notImplemented();
  }
  putInstruction(i: InstructionRecord): Promise<void> {
    return notImplemented(i);
  }
  activeInstruction(): Promise<InstructionRecord | null> {
    return notImplemented();
  }
  setActiveInstruction(version: string): Promise<void> {
    return notImplemented(version);
  }
  putJob(j: AgentJob): Promise<void> {
    return notImplemented(j);
  }
  dueJobs(nowMs: number): Promise<AgentJob[]> {
    return notImplemented(nowMs);
  }
  jobs(): Promise<AgentJob[]> {
    return notImplemented();
  }
  deleteJob(id: string): Promise<void> {
    return notImplemented(id);
  }
  nextJobMs(): Promise<number | null> {
    return notImplemented();
  }
  getMeta<T>(key: string): Promise<T | null> {
    return notImplemented(key);
  }
  setMeta(key: string, value: unknown): Promise<void> {
    return notImplemented(key, value);
  }
  prune(beforeDate: string): Promise<number> {
    return notImplemented(beforeDate);
  }
}
