/**
 * AgentBrain: the AgentDO's logic, kept out of the Durable Object so tests can run it. It stores bars, runs the
 * model jobs (reflex, escalation, review, replay) on the DO's alarm, keeps the cost ledger and builds the view.
 * It never places orders.
 */
import type { AccountView, AdvisorView, AgentView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import type { EngineConfig } from "../config";
import type { Logger } from "../ports";
import type { IndexId } from "../types";
import type { DeepJudge, ReflexJudge } from "./judge";
import type { AgentMode, AgentSettings, AgentStore, BatchStatus, ExecutionRecord, ReflexBatch, ReflexInput } from "./types";
import { notImplemented } from "./notImplemented";

export interface AgentBrainDeps {
  store: AgentStore;
  settings: AgentSettings;
  /** null: no ANTHROPIC_API_KEY, so every batch is FAILED "NO_KEY". */
  reflex: ReflexJudge | null;
  escalation: DeepJudge | null;
  review: DeepJudge | null;
  advisor: () => Promise<AdvisorView | null>;
  barsFallback: (index: IndexId, fromMs: number, toMs: number) => Promise<{ t: number; c: number }[]>;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  now: () => number;
  newId: () => string;
  logger: Logger;
}

export interface AgentStatus {
  mode: AgentMode;
  /** The operator paused the agent: no bar is accepted. */
  paused: boolean;
  nextJobMs: number | null;
  spentUsd: number;
  capUsd: number;
  lastBatch: { barCloseMs: number; status: BatchStatus } | null;
  instructionVersion: string;
}

export class AgentBrain {
  constructor(private readonly d: AgentBrainDeps) {}

  /** Stores the bar and queues its reflex job; idempotent per barCloseMs; refused while paused. */
  submitBar(input: ReflexInput): Promise<{ accepted: boolean; reason: string | null }> {
    return notImplemented(this.d, input);
  }

  takeDecisions(afterBarMs: number): Promise<ReflexBatch | null> {
    return notImplemented(this.d, afterBarMs);
  }

  /** Idempotent by (barCloseMs, decisionId). */
  recordExecution(rec: ExecutionRecord): Promise<void> {
    return notImplemented(this.d, rec);
  }

  scheduleReview(date: string): Promise<void> {
    return notImplemented(this.d, date);
  }

  /** Runs due jobs (REFLEX first, then ESCALATION, REVIEW, REPLAY) until deadlineMs; never throws; returns the next wake time. */
  runDue(nowMs: number, deadlineMs: number): Promise<number | null> {
    return notImplemented(this.d, nowMs, deadlineMs);
  }

  view(date: string, account: AccountView | null): Promise<AgentView> {
    return notImplemented(this.d, date, account);
  }

  decideCandidate(id: string, decision: "approve" | "reject", actor: string): Promise<{ ok: boolean; message: string }> {
    return notImplemented(this.d, id, decision, actor);
  }

  revertToBuiltin(actor: string): Promise<{ ok: boolean; message: string }> {
    return notImplemented(this.d, actor);
  }

  /** Pauses or resumes the agent (/ops/agent-pause): while paused no bar is accepted. */
  setPaused(on: boolean): Promise<void> {
    return notImplemented(this.d, on);
  }

  status(): Promise<AgentStatus> {
    return notImplemented(this.d);
  }
}
