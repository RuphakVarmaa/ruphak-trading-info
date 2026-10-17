/**
 * AgentBrain: the AgentDO's logic, kept out of the Durable Object so tests can run it. It stores bars, runs the
 * model jobs (reflex, escalation, review, replay) on the DO's alarm, keeps the cost ledger and builds the view.
 * It never places orders.
 *
 * Every model call runs from runDue, one at a time, on the alarm. A job is marked RUNNING and its call record is
 * written at the call's worst-case cost before the request goes out; a RUNNING job found later (the DO restarted
 * mid-call) is marked FAILED and never run again, so a retried alarm can never pay twice (AMENDMENTS #8, #11).
 */
import type { AccountView, AdvisorReport, AdvisorView, AgentView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { addDays, formatHHMM, istAt, istDate, istMinutes, MINUTE_MS } from "../clock";
import type { EngineConfig } from "../config";
import { BAR_5M_MS } from "../market/candles";
import type { LlmUsage, Logger } from "../ports";
import type { IndexId } from "../types";
import { calibrationSummary, sizingProbability } from "./calibration";
import { AGENT_POLICY, ESCALATION, REFLEX_CALL, RETENTION_DAYS, REVIEW_CALL, USER_MESSAGE_TOKEN_LIMIT } from "./constants";
import { capAllows, reflexReserveUsd, responseCostUsd, worstCaseUsd, type PromptSize } from "./cost";
import { costCapReason, escalationAllowed, escalationFits, escalationTriggers, mergeEscalation, type EscalationBudget } from "./escalation";
import { briefContext, compileFinalists } from "./finalists";
import type { DeepJudge, DeepRequest, DeepResponse, ReflexJudge, ReflexRequest, ReflexResponse } from "./judge";
import { payoffRatio } from "./kelly";
import { archiveClosesMap } from "./outcomes";
import { BUILTIN_GUIDANCE, ESCALATION_SYSTEM, escalationUser, instructionVersion, REVIEW_SYSTEM, reflexSystem, reflexUser, reviewUser } from "./prompt";
import { candidateFrom, gradeDay, replayScore, type ReplayBar } from "./review";
import { EscalationSchema, ReviewSchema } from "./schema";
import { estimateProseTokens, estimateTokens } from "./snapshot";
import type {
  AgentExitReason,
  AgentJob,
  AgentMode,
  AgentSettings,
  AgentStore,
  BatchStatus,
  CalibrationSummary,
  CallKind,
  CallRecord,
  CallStatus,
  CandidateRecord,
  DecisionRecord,
  EscalationRecord,
  ExecutionRecord,
  Finalist,
  GradedDecision,
  InstructionRecord,
  ReflexBatch,
  ReflexDecision,
  ReflexInput,
  ReplayResult,
  StoredBar,
} from "./types";
import { validateEscalation } from "./validate";
import { buildAgentView } from "./view";

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

/** Keys of the store's meta table. */
export const AGENT_META = {
  paused: "paused",
  calibration: "calibration:current",
  briefs: "briefs",
  exits: "exits",
  replay: (candidateId: string) => `replay:${candidateId}`,
} as const;

const JOB_ORDER: Record<CallKind, number> = { REFLEX: 0, ESCALATION: 1, REVIEW: 2, REPLAY: 3 };
/** The longest one job's calls can run: a replay bar makes two reflex calls (the current text and the candidate's). */
const JOB_ABORT_MS: Record<CallKind, number> = { REFLEX: REFLEX_CALL.abortMs, ESCALATION: ESCALATION.abortMs, REVIEW: REVIEW_CALL.abortMs, REPLAY: 2 * REFLEX_CALL.abortMs };
const reflexJobId = (barCloseMs: number) => `reflex:${barCloseMs}`;
const reviewJobId = (date: string) => `review:${date}`;
const replayJobId = (candidateId: string) => `replay:${candidateId}`;
/** Briefs kept for the "created at or before the bar close" rule (AMENDMENTS #6). */
const MAX_CACHED_BRIEFS = 5;
/** A bound on an escalation's prompt at queue time (its real size is checked again when it runs). */
const ESCALATION_INPUT_BOUND = 2 * USER_MESSAGE_TOKEN_LIMIT;
const INTERRUPTED = "interrupted: the agent restarted while this call was running; it is not run again";
/** A replay's next slice starts on a later alarm (REVIEW_CALL.replayBarsPerAlarm bars per alarm). */
const REPLAY_NEXT_SLICE_MS = 1_000;
/** The review regrades the decisions of this many earlier trading days still missing a label (their closes can arrive late). */
const REGRADE_TRADING_DAYS = 5;
/** Approve and revert are refused from the close until the day's review and replay finish (O3). */
const APPROVAL_WINDOW_TEXT = "after today's review and replay finish (about 16:20–16:45 IST)";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (x: number) => Math.round(x * 1e6) / 1e6;

/** The worst case of a call (every attempt) and of one attempt of it, for openCall and closeCall. */
interface CallWorst {
  /** worstCaseUsd over every attempt: booked before the request goes out. */
  all: number;
  /** One attempt (worstCaseUsd with attempts 1): what each attempt that may have been billed beyond the usage adds. */
  one: number;
}
const callWorst = (model: string, size: number | PromptSize, maxTokens: number): CallWorst => ({ all: worstCaseUsd(model, size, maxTokens), one: worstCaseUsd(model, size, maxTokens, 1) });

/** The review's prompt by block: its fixed system text and a user message of `userTokens`. */
const reviewSize = (userTokens: number): PromptSize => ({ systemTokens: estimateProseTokens(REVIEW_SYSTEM), userTokens });

interface BriefCache {
  date: string;
  briefs: AdvisorReport[];
}

/** A candidate's replay in progress: both texts' answers per bar, kept between alarms. */
interface ReplayState {
  baseGuidance: string;
  done: number[];
  candidate: Record<string, ReflexDecision[]>;
  current: Record<string, ReflexDecision[]>;
  failedCalls: number;
  costUsd: number;
}

/** What a model call returned, for the cost ledger; a deep call may list each billed attempt (usage.iterations). */
interface CallResult {
  status: CallStatus;
  usage: LlmUsage | null;
  model: string;
  latencyMs: number;
  error: string | null;
  iterations?: readonly { model: string; usage: LlmUsage }[] | null;
  /** HTTP attempts that may have been billed beyond the usage (judge.ts); undefined when the judge cannot say. */
  possiblyBilledAttempts?: number;
}

/** A job either finished, or asks to run again at requeueAt (with a new payload when given). */
type JobResult = { requeueAt: number | null; payload?: Record<string, unknown> };
const DONE: JobResult = { requeueAt: null };

export class AgentBrain {
  /** Graded rows for sizing, loaded once a day and per instruction version (they only change at the review). */
  private sizingCache: { key: string; rows: GradedDecision[] } | null = null;
  private running = false;

  constructor(private readonly d: AgentBrainDeps) {}

  // -------------------------------------------------------------------------
  // TE-facing RPCs
  // -------------------------------------------------------------------------

  /**
   * Stores the bar and queues its reflex job; idempotent per barCloseMs (a resubmitted bar is a "duplicate"); refused
   * while paused. Bars after the reflex window (15:05) or outside it are stored for grading only, with no model call.
   */
  async submitBar(input: ReflexInput): Promise<{ accepted: boolean; reason: string | null }> {
    const { store } = this.d;
    if (await this.paused()) return { accepted: false, reason: "paused: the operator paused the agent" };
    const T = input.barCloseMs;
    const date = istDate(T);
    if (!Number.isFinite(T) || T % BAR_5M_MS !== 0) return { accepted: false, reason: "not a 5-minute bar close" };
    if (await this.barKnown(T)) return { accepted: true, reason: "duplicate" };

    for (const index of this.d.cfg.indices) {
      const snapshot = input.snapshots[index] ?? null;
      const close = input.closes[index] ?? snapshot?.c;
      if (close === undefined) continue;
      await store.putBar({ barCloseMs: T, date, index, close, snapshot, tokensEst: input.tokensEst[index] ?? null, builtMs: input.builtMs });
    }
    if (!this.inReflexWindow(T)) return { accepted: true, reason: "stored for grading only (outside the 09:20–15:05 reflex window)" };
    await store.putJob({ id: reflexJobId(T), kind: "REFLEX", dueMs: this.d.now(), status: "QUEUED", startedMs: null, payload: { barCloseMs: T, problems: input.problems.slice(0, 10) } });
    return { accepted: true, reason: null };
  }

  /** The newest batch after `afterBarMs` (TE executes it when it is fresh), or null. */
  takeDecisions(afterBarMs: number): Promise<ReflexBatch | null> {
    return this.d.store.latestBatchAfter(afterBarMs);
  }

  /**
   * Idempotent by (barCloseMs, decisionId): an execution is stored only when it is newer than the one already there,
   * so a record replayed from TE's outbox changes nothing. Trades are keyed by position and risk rows by time.
   */
  async recordExecution(rec: ExecutionRecord): Promise<void> {
    const { store } = this.d;
    const rows = new Map((await store.decisionsForBar(rec.barCloseMs)).map((d) => [d.id, d] as const));
    for (const { decisionId, execution } of rec.decisions) {
      const cur = rows.get(decisionId);
      if (!cur || (cur.execution && cur.execution.t >= execution.t)) continue;
      await store.updateExecution(decisionId, execution);
    }
    const exits = await this.rememberExits(rec);
    if (rec.trades.length) await store.putTrades(rec.trades.map((t) => (t.agentExit ? t : { ...t, agentExit: exits[t.positionId] ?? null })));
    await store.putRisk(rec.risk);
  }

  /**
   * Queues the nightly review for `date` at 16:20 IST (or now, if later). A review already queued, running or done is
   * left alone unless `force` (the ops route re-runs one on purpose).
   */
  async scheduleReview(date: string, opts: { force?: boolean } = {}): Promise<void> {
    const { store } = this.d;
    const now = this.d.now();
    if ((await store.jobs()).some((j) => j.id === reviewJobId(date))) return;
    const existing = await store.review(date);
    if (existing && !opts.force && (existing.status === "DONE" || existing.status === "RUNNING")) return;
    const dueMs = Math.max(now, istAt(date, REVIEW_CALL.dueIst));
    await store.putReview({
      date,
      status: "PENDING",
      dueMs,
      startedMs: null,
      doneMs: null,
      model: existing?.model ?? null,
      callId: existing?.callId ?? null,
      report: existing?.report ?? null,
      calibration: existing?.calibration ?? null,
      error: null,
    });
    await store.putJob({ id: reviewJobId(date), kind: "REVIEW", dueMs, status: "QUEUED", startedMs: null, payload: { date, attempt: 1 } });
  }

  /** Runs due jobs (REFLEX first, then ESCALATION, REVIEW, REPLAY) until deadlineMs; never throws; returns the next wake time. */
  async runDue(nowMs: number, deadlineMs: number): Promise<number | null> {
    void nowMs;
    if (this.running) return null;
    this.running = true;
    let busyLeft = false;
    try {
      await this.recoverInterrupted();
      for (;;) {
        const now = this.d.now();
        const due = (await this.d.store.dueJobs(now)).sort((a, b) => JOB_ORDER[a.kind] - JOB_ORDER[b.kind] || a.dueMs - b.dueMs);
        const job = due.find((j) => this.phaseAllows(j, now));
        if (!job) break;
        if (now + JOB_ABORT_MS[job.kind] > deadlineMs) {
          // Not enough of this alarm left to finish the call: the next alarm starts it.
          busyLeft = true;
          break;
        }
        await this.d.store.putJob({ ...job, status: "RUNNING", startedMs: now });
        let result: JobResult = DONE;
        try {
          result = await this.runJob(job, deadlineMs);
        } catch (err) {
          this.d.logger.error("agent job failed", { job: job.id, error: errText(err) });
          await this.failJob(job, `error: ${errText(err)}`).catch(() => undefined);
        } finally {
          await this.d.store.deleteJob(job.id);
        }
        if (result.requeueAt !== null) await this.d.store.putJob({ ...job, dueMs: result.requeueAt, status: "QUEUED", startedMs: null, payload: result.payload ?? job.payload });
      }
    } catch (err) {
      this.d.logger.error("agent runDue failed", { error: errText(err) });
    } finally {
      this.running = false;
    }
    try {
      return await this.nextWake(busyLeft);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Dashboard and operator actions
  // -------------------------------------------------------------------------

  async view(date: string, account: AccountView | null): Promise<AgentView> {
    const { store } = this.d;
    const now = this.d.now();
    const from = addDays(date, -RETENTION_DAYS);
    const [instruction, bars, batches, decisions, escalations, risk, calibration, trades, review, candidate, calls, paused] = await Promise.all([
      this.instruction(),
      store.bars(date),
      store.batches(date),
      store.decisions(date),
      store.escalations(date),
      store.latestRisk(),
      store.getMeta<CalibrationSummary>(AGENT_META.calibration),
      store.trades(from, date),
      store.latestReview(date),
      store.latestCandidate(),
      store.calls(date),
      this.paused(),
    ]);
    let reviewCostUsd: number | null = null;
    if (review?.callId) {
      const sameDay = review.date === date ? calls : await store.calls(review.date);
      reviewCostUsd = sameDay.find((c) => c.id === review.callId)?.costUsd ?? null;
    }
    return buildAgentView({
      date,
      nowMs: now,
      settings: this.d.settings,
      enabled: true,
      paused,
      account,
      instruction,
      bars,
      batches,
      decisions,
      escalations,
      risk,
      calibration,
      payoff: payoffRatio(trades),
      trades,
      review,
      reviewCostUsd,
      candidate,
      baseGuidance: instruction.guidance,
      calls,
      calendar: this.d.calendar,
    });
  }

  /**
   * Approves or rejects the PENDING candidate. Rejection is allowed any time. Approval is refused during the session
   * (one session is judged by one text), from the close until that day's review and replay finish (they judge the text
   * the session ran with; approvalRefusal), and for a candidate nothing was replayed for.
   */
  async decideCandidate(id: string, decision: "approve" | "reject", actor: string): Promise<{ ok: boolean; message: string }> {
    const { store } = this.d;
    const now = this.d.now();
    const c = await store.candidate(id);
    if (!c) return { ok: false, message: `no candidate ${id}` };
    if (c.status !== "PENDING") return { ok: false, message: `the candidate is ${c.status}; only a PENDING one can be decided` };
    if (decision === "reject") {
      await store.putCandidate({ ...c, status: "REJECTED", decidedMs: now, decidedBy: actor });
      return { ok: true, message: "rejected: the current guidance stays" };
    }
    const refusal = await this.approvalRefusal(now, "approve");
    if (refusal) return { ok: false, message: refusal };
    if (!c.replay || c.replay.bars === 0) return { ok: false, message: "nothing was replayed for this candidate; reject it or re-run the review" };
    const version = instructionVersion(c.guidance);
    await store.putInstruction({ version, guidance: c.guidance, createdMs: now, source: "CANDIDATE", candidateId: c.id, active: true });
    await store.setActiveInstruction(version);
    await store.putCandidate({ ...c, status: "APPROVED", decidedMs: now, decidedBy: actor });
    await this.recomputeCalibration(version, now);
    return { ok: true, message: `approved: the reflex uses guidance ${version} from its next call` };
  }

  /** Makes the built-in guidance active again (/ops/agent-revert); refused when approval would be (approvalRefusal). */
  async revertToBuiltin(actor: string): Promise<{ ok: boolean; message: string }> {
    const now = this.d.now();
    const refusal = await this.approvalRefusal(now, "revert");
    if (refusal) return { ok: false, message: refusal };
    const version = instructionVersion(BUILTIN_GUIDANCE);
    const active = await this.d.store.activeInstruction();
    if (active?.version === version) return { ok: true, message: `the built-in guidance ${version} is already active` };
    await this.d.store.putInstruction({ version, guidance: BUILTIN_GUIDANCE, createdMs: now, source: "BUILTIN", candidateId: null, active: true });
    await this.recomputeCalibration(version, now);
    this.d.logger.info("agent guidance reverted to the built-in text", { actor, version });
    return { ok: true, message: `reverted to the built-in guidance ${version}` };
  }

  /** Pauses or resumes the agent (/ops/agent-pause): while paused no bar is accepted. */
  async setPaused(on: boolean): Promise<void> {
    await this.d.store.setMeta(AGENT_META.paused, on);
  }

  async status(): Promise<AgentStatus> {
    const { store } = this.d;
    const now = this.d.now();
    const [paused, nextJobMs, spentUsd, last, instruction] = await Promise.all([this.paused(), store.nextJobMs(), store.spentUsd(istDate(now)), store.latestBatchAfter(0), this.instruction()]);
    return {
      mode: this.d.settings.mode,
      paused,
      nextJobMs,
      spentUsd,
      capUsd: this.d.settings.dailyUsdCap,
      lastBatch: last ? { barCloseMs: last.barCloseMs, status: last.status } : null,
      instructionVersion: instruction.version,
    };
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private async runJob(job: AgentJob, deadlineMs: number): Promise<JobResult> {
    switch (job.kind) {
      case "REFLEX":
        await this.runReflex(Number(job.payload.barCloseMs), (job.payload.problems as string[] | undefined) ?? []);
        return DONE;
      case "ESCALATION":
        await this.runEscalation(String(job.payload.escalationId));
        return DONE;
      case "REVIEW":
        return this.runReview(String(job.payload.date), Number(job.payload.attempt ?? 1));
      case "REPLAY":
        return this.runReplay(String(job.payload.candidateId), deadlineMs);
    }
  }

  /** The reflex call for one bar: finalists, the cost cap, one call for every finalist, the escalation merge, sizing. */
  private async runReflex(T: number, problems: string[]): Promise<void> {
    const { store, settings } = this.d;
    if (await store.batch(T)) return;
    const now = this.d.now();
    const date = istDate(T);
    const instruction = await this.instruction();
    const payoff = await this.payoff(date);
    const batch: ReflexBatch = {
      barCloseMs: T,
      date,
      status: "OK",
      error: null,
      callId: null,
      instructionVersion: instruction.version,
      finalists: [],
      briefId: null,
      briefContext: null,
      decisions: [],
      exitOnly: [],
      payoff: { b: payoff.b, n: payoff.n },
      completedMs: now,
    };
    const finish = async (status: BatchStatus, error: string | null, exitOnly: DecisionRecord[] = []) => {
      await store.putBatch({ ...batch, status, error, exitOnly, completedMs: this.d.now() });
    };

    if (settings.mode === "off") return finish("OFF", "the agent is off (AGENT_MODE)");
    if (await this.paused()) return finish("OFF", "paused by the operator");
    if (now - T > AGENT_POLICY.maxDecisionAgeMs) return finish("STALE", `the bar was ${Math.round((now - T) / 1000)} s old when its turn came (limit ${AGENT_POLICY.maxDecisionAgeMs / 1000} s)`);

    const input = await this.storedInput(T, problems);
    const brief = await this.briefFor(T);
    const context = briefContext(brief, T);
    // An index without a snapshot is left out, and so are its finalists.
    const finalists: Finalist[] = compileFinalists({ indices: this.d.cfg.indices, nowMs: T, brief }).filter((f: Finalist) => input.snapshots[f.index]);
    batch.finalists = finalists;
    batch.briefId = context && brief ? brief.id : null;
    batch.briefContext = context;
    if (!finalists.length) return finish("NO_FINALISTS", input.problems.length ? input.problems.join("; ") : "no index had a complete candle", await this.exitOnly(T, finalists, instruction));
    const reflex = this.d.reflex;
    if (!reflex) return finish("FAILED", "NO_KEY: no API key, so no model call", await this.exitOnly(T, finalists, instruction));

    const user = reflexUser(input, finalists, context);
    const inputEst = estimateTokens(reflexSystem(instruction.guidance)) + estimateTokens(user);
    const worst = callWorst(reflex.model, inputEst, REFLEX_CALL.maxTokens);
    const spent = await store.spentUsd(istDate(now));
    if (!capAllows(spent, worst.all, settings.dailyUsdCap)) {
      await this.skippedCall("REFLEX", T, reflex.model, instruction.version, now);
      return finish("COST_CAP", `the day's cost cap ($${settings.dailyUsdCap}) leaves no room for this call`, await this.exitOnly(T, finalists, instruction));
    }

    const call = await this.openCall("REFLEX", T, reflex.model, instruction.version, worst.all);
    const res = await this.callReflex(reflex, { input, finalists, brief: context, guidance: instruction.guidance }, REFLEX_CALL.abortMs);
    await this.closeCall(call, res, worst);
    const callId = call.id;
    batch.callId = callId;
    if (res.status !== "OK") return finish("FAILED", `${res.status}: ${res.error ?? "the call did not return valid decisions"}`, await this.exitOnly(T, finalists, instruction));

    const byId = new Map(finalists.map((f) => [f.id, f] as const));
    const reflexRows: DecisionRecord[] = [];
    for (const dec of res.decisions) {
      const f = byId.get(dec.finalistId);
      if (!f) continue;
      reflexRows.push({ ...dec, id: this.d.newId(), date, barCloseMs: T, index: f.index, finalistKind: f.kind, source: "REFLEX", callId, instructionVersion: instruction.version, effective: true, sizing: null, execution: null, outcome: null });
    }

    // The previous bar's finished escalations become this bar's effective decisions for their finalists (SPEC §4.6).
    const prevMs = T - BAR_5M_MS;
    const escalations = await store.escalations(date);
    const effective: DecisionRecord[] = [];
    for (const r of reflexRows) {
      const esc = escalations.find((e) => e.barCloseMs === prevMs && e.finalistId === r.finalistId && e.status === "DONE" && e.appliedBarMs === null);
      const merged = esc ? mergeEscalation(r, esc, this.d.newId) : undefined;
      // An escalation that cannot be merged comes back as the reflex row itself, and so does a directional one when
      // this bar's reflex call is NEUTRAL (the fresher call stays in force); exitOnly below then takes it in.
      if (esc && merged && merged !== r) {
        r.effective = false;
        effective.push({ ...merged, date, barCloseMs: T, index: r.index, finalistKind: r.finalistKind, instructionVersion: instruction.version, effective: true, execution: null, outcome: null });
        await store.putEscalation({ ...esc, appliedBarMs: T });
      } else effective.push(r);
    }
    // A finished escalation no decision of this bar took in (no decision for its finalist, or a NEUTRAL one) can still
    // close a position, never open one.
    const exitOnly = await this.exitOnly(T, finalists, instruction);

    // Sizing hints from measured results only (calibration.ts); never the model's stated confidence. Each row is sized
    // on its own source's record: an escalation on graded escalations, never on the reflex's.
    const sizingRows = await this.sizingRows(date, instruction.version);
    for (const e of effective) if (e.direction !== "NEUTRAL") e.sizing = sizingProbability(e.directionConfidence, sizingRows, instruction.version, e.source);

    await store.putDecisions([...reflexRows.filter((r) => !r.effective), ...effective]);
    await this.queueEscalations(T, reflexRows, now);
    await store.putBatch({ ...batch, status: "OK", error: res.dropped.length ? `dropped: ${res.dropped.join("; ")}` : null, decisions: effective, exitOnly, completedMs: this.d.now() });
  }

  /**
   * The previous bar's finished escalations that no decision of this bar took in (its reflex failed or was skipped,
   * gave no decision for that finalist, or called it NEUTRAL against a directional escalation): exit-only records
   * that may close positions, never open one.
   */
  private async exitOnly(T: number, finalists: Finalist[], instruction: InstructionRecord): Promise<DecisionRecord[]> {
    const { store } = this.d;
    const date = istDate(T);
    const byId = new Map(finalists.map((f) => [f.id, f] as const));
    const prevBatch = await store.batch(T - BAR_5M_MS);
    const prevFinalists = new Map((prevBatch?.finalists ?? []).map((f) => [f.id, f] as const));
    const out: DecisionRecord[] = [];
    for (const esc of await store.escalations(date)) {
      if (esc.barCloseMs !== T - BAR_5M_MS || esc.status !== "DONE" || !esc.decision || esc.appliedBarMs !== null) continue;
      const f = byId.get(esc.finalistId) ?? prevFinalists.get(esc.finalistId);
      out.push({
        ...esc.decision,
        finalistId: esc.finalistId,
        id: this.d.newId(),
        date,
        barCloseMs: T,
        index: esc.index,
        finalistKind: f?.kind ?? "GENERIC",
        source: "ESCALATION",
        callId: esc.callId ?? "",
        instructionVersion: instruction.version,
        effective: false,
        sizing: null,
        execution: null,
        outcome: null,
      });
      await store.putEscalation({ ...esc, appliedBarMs: T });
    }
    if (out.length) await store.putDecisions(out);
    return out;
  }

  /**
   * Escalation triggers on this bar's reflex rows: queued when allowed (rate, daily cap, start deadline, and the cost:
   * spent plus the rest of the day's reflex reserve plus tonight's review reserve plus this escalation's worst case
   * under the cap; escalationAllowed's budget), else SKIPPED. Escalations queued on this bar count against the budget
   * of the next.
   */
  private async queueEscalations(T: number, reflexRows: DecisionRecord[], now: number): Promise<void> {
    const { store, settings } = this.d;
    const date = istDate(T);
    const previous = (await store.decisionsForBar(T - BAR_5M_MS)).filter((d) => d.source === "REFLEX");
    const triggers = escalationTriggers(reflexRows, previous);
    if (!triggers.length) return;
    const today = await store.escalations(date);
    const worstUsd = worstCaseUsd(this.d.escalation?.model ?? settings.escalationModel, ESCALATION_INPUT_BOUND, ESCALATION.maxTokens);
    const reflexReserve = await this.reflexReserve(now);
    const reviewReserve = await this.reviewReserve(now);
    let spentUsd = await store.spentUsd(istDate(now));
    for (const t of triggers) {
      const budget: EscalationBudget = { spentUsd, worstUsd, reflexReserveUsd: reflexReserve, reviewReserveUsd: reviewReserve, capUsd: settings.dailyUsdCap };
      const allowed = escalationAllowed(t.decision.index, T, now, today, settings.escalationsPerDay, this.d.calendar, budget);
      let reason = allowed.ok ? null : (allowed.reason ?? "not allowed");
      if (!reason && !this.d.escalation) reason = "no API key for the deep model";
      if (!reason) spentUsd += worstUsd;
      const rec: EscalationRecord = {
        id: this.d.newId(),
        date,
        barCloseMs: T,
        index: t.decision.index,
        finalistId: t.decision.finalistId,
        trigger: t.trigger,
        status: reason ? "SKIPPED" : "QUEUED",
        requestedMs: now,
        doneMs: reason ? now : null,
        reflexDecisionId: t.decision.id,
        decision: null,
        reason,
        callId: null,
        appliedBarMs: null,
      };
      await store.putEscalation(rec);
      today.push(rec);
      if (!reason) await store.putJob({ id: `esc:${rec.id}`, kind: "ESCALATION", dueMs: now, status: "QUEUED", startedMs: null, payload: { escalationId: rec.id } });
    }
  }

  /** The deep model's second opinion on one finalist; used for the next bar only, through the same code gates. */
  private async runEscalation(id: string): Promise<void> {
    const { store } = this.d;
    const esc = await store.escalation(id);
    if (!esc || esc.status !== "QUEUED") return;
    const now = this.d.now();
    const nextBar = esc.barCloseMs + BAR_5M_MS;
    const put = (o: Partial<EscalationRecord>) => store.putEscalation({ ...esc, doneMs: this.d.now(), ...o });
    if (await this.paused()) return put({ status: "SKIPPED", reason: "paused by the operator" });
    if (await store.batch(nextBar)) return put({ status: "LATE", reason: "the next bar's reflex already ran" });
    if (now > esc.barCloseMs + ESCALATION.startWithinMs) return put({ status: "LATE", reason: `could not start within ${ESCALATION.startWithinMs / 1000} s of the bar close` });
    const judge = this.d.escalation;
    if (!judge) return put({ status: "FAILED", reason: "NO_KEY: no API key for the deep model" });

    const batch = await store.batch(esc.barCloseMs);
    const finalist = batch?.finalists.find((f) => f.id === esc.finalistId);
    const reflexRow = (await store.decisionsForBar(esc.barCloseMs)).find((d) => d.id === esc.reflexDecisionId);
    if (!finalist || !reflexRow) return put({ status: "FAILED", reason: "the bar's finalist or reflex decision is missing" });
    const instruction = await this.instruction();
    const snapshots: Partial<Record<IndexId, NonNullable<StoredBar["snapshot"]>>> = {};
    for (const b of (await store.bars(esc.date)).filter((x) => x.barCloseMs === esc.barCloseMs)) if (b.snapshot) snapshots[b.index] = b.snapshot;
    const history = (await store.barsForIndex(esc.index, esc.barCloseMs - ESCALATION.contextBars * BAR_5M_MS, esc.barCloseMs - BAR_5M_MS)).filter((b) => b.snapshot);
    const user = escalationUser({ finalist, reflex: reflexRow, trigger: esc.trigger, snapshots, history, guidance: instruction.guidance });
    const inputEst = estimateTokens(ESCALATION_SYSTEM) + estimateTokens(user);
    const worst = callWorst(judge.model, inputEst, ESCALATION.maxTokens);
    const noRoom = await this.escalationRoom(worst.all, now);
    if (noRoom) return put({ status: "SKIPPED", reason: noRoom });

    await store.putEscalation({ ...esc, status: "RUNNING" });
    const call = await this.openCall("ESCALATION", esc.barCloseMs, judge.model, instruction.version, worst.all);
    const res = await this.callDeep(judge, { system: ESCALATION_SYSTEM, user, effort: ESCALATION.effort, maxTokens: ESCALATION.maxTokens, timeoutMs: ESCALATION.timeoutMs, schema: EscalationSchema }, ESCALATION.abortMs);
    await this.closeCall(call, res, worst);
    const callId = call.id;
    if (res.status !== "OK" || !res.parsed) return put({ status: "FAILED", callId, reason: `${res.status}: ${res.error ?? "no answer"}` });
    // Checked like a reflex decision (validate.ts): this finalist's id, a confidence within 0..1, cleaned text.
    const out = validateEscalation(res.parsed, finalist);
    if (!out.ok) return put({ status: "FAILED", callId, reason: `the answer was not a valid decision: ${out.error}` });
    // Finished after the next bar's reflex ran: recorded, never applied.
    const late = (await store.batch(nextBar)) !== null;
    await put({ status: late ? "LATE" : "DONE", callId, decision: out.decision, reason: out.reason });
  }

  /**
   * The nightly review (16:20 IST, again at 16:40 when the bar archive is not complete): grade the day's decisions
   * from one price source per label (and the earlier days' still unlabelled ones), the calibration, the deep model's
   * written review and an optional candidate text. The review, its candidate and the replay's current arm all judge
   * the text the session ran with (sessionInstruction), whatever is active by the evening.
   */
  private async runReview(date: string, attempt: number): Promise<JobResult> {
    const { store, settings } = this.d;
    const now = this.d.now();
    const review = (await store.review(date)) ?? { date, status: "PENDING", dueMs: now, startedMs: null, doneMs: null, model: null, callId: null, report: null, calibration: null, error: null };
    const closes = await this.closesFor(date);
    if (!closes.archiveReady && attempt < 2) {
      const retry = Math.max(now + MINUTE_MS, istAt(date, REVIEW_CALL.retryIst));
      await store.putReview({ ...review, status: "PENDING", dueMs: retry, error: "the 5-minute bar archive is not complete yet; trying again" });
      return { requeueAt: retry, payload: { date, attempt: attempt + 1 } };
    }
    await store.putReview({ ...review, status: "RUNNING", startedMs: now, error: null, note: null });

    // 1. Grade every decision whose window has ended (review.ts gradeDay): both ends from the archive when both rows
    //    exist, otherwise the stored closes for both; a regrade never downgrades a label. Then the earlier days'
    //    decisions still without a label, whose closes may have arrived since (a late archive).
    await store.updateOutcomes(gradeDay(await store.decisions(date), closes.stored, this.d.calendar, now, closes.archive));
    await this.regradeEarlierDays(date, now);

    // 2. Calibration over the retention window, weighted to the active text (sizing goes forward with it); then
    //    the rows older than the retention window go.
    const active = await this.instruction();
    const calibration = await this.recomputeCalibration(active.version, now);
    await this.pruneBefore(addDays(date, -RETENTION_DAYS));

    // 3. The written review and an optional candidate guidance text: not on a day with nothing to read.
    const base = { ...review, startedMs: now, calibration, note: null };
    const decisions = (await store.decisions(date)).filter((d) => d.effective);
    const trades = await store.trades(date, date);
    if (decisions.length === 0 && trades.length === 0) {
      await store.putReview({ ...base, status: "SKIPPED", doneMs: this.d.now(), error: `nothing to review: no decision was in force and no trade was made on ${date}; the day was graded and scored` });
      return DONE;
    }
    const judge = this.d.review;
    if (!judge) {
      await store.putReview({ ...base, status: "SKIPPED", doneMs: this.d.now(), error: "NO_KEY: no API key for the deep model; the day was graded and scored" });
      return DONE;
    }
    const { instruction: session, note } = await this.sessionInstruction(date, active);
    const calls = await store.calls(date);
    const user = reviewUser({ date, decisions, trades, calibration, calls, guidance: session.guidance, guidanceNote: note, closes: closes.forPrompt });
    // The system block may be written to the cache; the user message is billed at the input rate (M1).
    const worst = callWorst(judge.model, reviewSize(await this.countUserTokens(judge, user)), REVIEW_CALL.maxTokens);
    const spent = await store.spentUsd(istDate(this.d.now()));
    // A review run before the open (a forced one) leaves today's reflex calls their money; after 15:05 the reserve is 0.
    const reflexReserve = await this.reflexReserve(this.d.now());
    if (!capAllows(spent + reflexReserve, worst.all, settings.dailyUsdCap)) {
      await this.skippedCall("REVIEW", null, judge.model, session.version, this.d.now());
      const kept = reflexReserve > 0 ? ` after the $${reflexReserve.toFixed(3)} kept for today's reflex calls` : "";
      await store.putReview({ ...base, note, status: "SKIPPED", doneMs: this.d.now(), error: `the day's cost cap ($${settings.dailyUsdCap}) leaves no room for the review (worst case $${worst.all.toFixed(3)})${kept}; the day was graded and scored` });
      return DONE;
    }
    const call = await this.openCall("REVIEW", null, judge.model, session.version, worst.all);
    const res = await this.callDeep(judge, { system: REVIEW_SYSTEM, user, effort: REVIEW_CALL.effort, maxTokens: REVIEW_CALL.maxTokens, timeoutMs: REVIEW_CALL.timeoutMs, schema: ReviewSchema }, REVIEW_CALL.abortMs);
    await this.closeCall(call, res, worst);
    const callId = call.id;
    if (res.status !== "OK" || !res.parsed) {
      await store.putReview({ ...base, note, status: "FAILED", doneMs: this.d.now(), model: res.model, callId, error: `${res.status}: ${res.error ?? "no answer"}` });
      return DONE;
    }
    const report = res.parsed;
    await store.putReview({ ...base, note, status: "DONE", doneMs: this.d.now(), model: res.model, callId, report, error: null });

    const cand = candidateFrom(report, session, date, this.d.now(), this.d.newId);
    if (cand) {
      const prev = await store.latestCandidate();
      if (prev && (prev.status === "PENDING" || prev.status === "SCORING")) await store.putCandidate({ ...prev, status: "SUPERSEDED" });
      // Scored first: it can be decided only once the replay is done.
      await store.putCandidate({ ...cand, status: "SCORING", replay: null, decidedMs: null, decidedBy: null });
      const state: ReplayState = { baseGuidance: session.guidance, done: [], candidate: {}, current: {}, failedCalls: 0, costUsd: 0 };
      await store.setMeta(AGENT_META.replay(cand.id), state);
      await store.putJob({ id: replayJobId(cand.id), kind: "REPLAY", dueMs: this.d.now(), status: "QUEUED", startedMs: null, payload: { candidateId: cand.id } });
    }
    return DONE;
  }

  /**
   * The text the session of `date` ran with: the instruction version most of its OK batches carry (on a tie, the one
   * that ran last), read from the store. When that text was never stored: the built-in text if the version is the
   * built-in one's, else the active text, with a note saying so. A day with no OK batch: the active text.
   */
  private async sessionInstruction(date: string, active: InstructionRecord): Promise<{ instruction: InstructionRecord; note: string | null }> {
    const { store } = this.d;
    const tally = new Map<string, { n: number; last: number }>();
    for (const b of await store.batches(date)) {
      if (b.status !== "OK") continue;
      const t = tally.get(b.instructionVersion) ?? { n: 0, last: -Infinity };
      tally.set(b.instructionVersion, { n: t.n + 1, last: Math.max(t.last, b.barCloseMs) });
    }
    const top = [...tally.entries()].sort((x, y) => y[1].n - x[1].n || y[1].last - x[1].last)[0];
    if (!top || top[0] === active.version) return { instruction: active, note: null };
    const version = top[0];
    let stored: InstructionRecord | null = null;
    try {
      stored = await store.instruction(version);
    } catch (err) {
      this.d.logger.warn("agent: the session's guidance text could not be read", { version, error: errText(err) });
    }
    if (stored) return { instruction: stored, note: null };
    if (version === instructionVersion(BUILTIN_GUIDANCE)) {
      return { instruction: { version, guidance: BUILTIN_GUIDANCE, createdMs: this.d.now(), source: "BUILTIN", candidateId: null, active: false }, note: null };
    }
    const note = `the session ran with guidance ${version}, whose text is not stored; this review read the active text ${active.version} in its place`;
    this.d.logger.warn("agent: the session's guidance text is not stored", { date, version, active: active.version });
    return { instruction: active, note };
  }

  /** The API's token count of the review's user message when the judge can give one, else the local prose estimate. */
  private async countUserTokens(judge: DeepJudge, user: string): Promise<number> {
    let counted: number | null = null;
    try {
      counted = (await judge.countTokens?.(user)) ?? null;
    } catch {
      counted = null;
    }
    return counted !== null && Number.isFinite(counted) && counted > 0 ? counted : estimateProseTokens(user);
  }

  /**
   * Regrades the previous REGRADE_TRADING_DAYS trading days' decisions that have no label or a MISSING one, from each
   * day's closes as they are now (gradeDay never downgrades a label). Never throws: a failure waits for tomorrow's review.
   */
  private async regradeEarlierDays(date: string, now: number): Promise<void> {
    const { store, calendar } = this.d;
    let day = date;
    for (let found = 0, tries = 0; found < REGRADE_TRADING_DAYS && tries < 4 * REGRADE_TRADING_DAYS; tries++) {
      day = addDays(day, -1);
      if (!calendar.isTradingDay(day)) continue;
      found++;
      try {
        const open = (await store.decisions(day)).filter((d) => !d.outcome || d.outcome.status === "MISSING");
        if (!open.length) continue;
        const c = await this.closesFor(day);
        const rows = gradeDay(open, c.stored, calendar, now, c.archive);
        if (rows.length) await store.updateOutcomes(rows);
      } catch (err) {
        this.d.logger.warn("agent: regrading an earlier day failed", { day, error: errText(err) });
      }
    }
  }

  /** Deletes the stored rows dated before `beforeDate` (the retention window); never throws. */
  private async pruneBefore(beforeDate: string): Promise<void> {
    try {
      const n = await this.d.store.prune(beforeDate);
      if (n > 0) this.d.logger.info("agent: pruned rows older than the retention window", { beforeDate, rows: n });
    } catch (err) {
      this.d.logger.warn("agent: prune failed", { beforeDate, error: errText(err) });
    }
  }

  /**
   * One slice of a candidate's replay: today's bars with an OK batch judged again with the current text and with
   * the candidate text on identical inputs (stored snapshots, finalists and brief context). Each call checks the
   * cost cap and the alarm's deadline first. When every bar is done (or the cap stops it) the candidate is PENDING.
   */
  private async runReplay(candidateId: string, deadlineMs: number): Promise<JobResult> {
    const { store, settings } = this.d;
    const cand = await store.candidate(candidateId);
    if (!cand || cand.status !== "SCORING") return DONE;
    const reflex = this.d.reflex;
    const state = (await store.getMeta<ReplayState>(AGENT_META.replay(candidateId))) ?? { baseGuidance: BUILTIN_GUIDANCE, done: [], candidate: {}, current: {}, failedCalls: 0, costUsd: 0 };
    const batches = (await store.batches(cand.date)).filter((b) => b.status === "OK" && b.finalists.length > 0);
    const todo = batches.filter((b) => !state.done.includes(b.barCloseMs));
    if (!reflex) return this.finishReplay(cand, state, batches, false, "no API key for the reflex model", "no_key");

    let processed = 0;
    let stop: "cap" | "deadline" | null = null;
    const arms = [
      { arm: "current" as const, guidance: state.baseGuidance },
      { arm: "candidate" as const, guidance: cand.guidance },
    ];
    for (const b of todo) {
      if (processed >= REVIEW_CALL.replayBarsPerAlarm) break;
      const input = await this.storedInput(b.barCloseMs, []);
      const finalists = b.finalists.filter((f) => input.snapshots[f.index]);
      const user = reflexUser(input, finalists, b.briefContext);
      const worst = arms.map((a) => callWorst(reflex.model, estimateTokens(reflexSystem(a.guidance)) + estimateTokens(user), REFLEX_CALL.maxTokens));
      // Both texts or neither: a bar judged by one text only would make the comparison uneven.
      const start = this.d.now();
      if (start + 2 * REFLEX_CALL.abortMs > deadlineMs) {
        stop = "deadline";
        break;
      }
      // A replay never spends the money kept for today's remaining reflex calls (none are left after 15:05).
      if (!capAllows((await store.spentUsd(istDate(start))) + (await this.reflexReserve(start)), worst[0].all + worst[1].all, settings.dailyUsdCap)) {
        await this.skippedCall("REPLAY", b.barCloseMs, reflex.model, instructionVersion(cand.guidance), start);
        stop = "cap";
        break;
      }
      const answers: Record<"candidate" | "current", ReflexDecision[]> = { candidate: [], current: [] };
      for (const [i, a] of arms.entries()) {
        const call = await this.openCall("REPLAY", b.barCloseMs, reflex.model, instructionVersion(a.guidance), worst[i].all);
        const res = await this.callReflex(reflex, { input, finalists, brief: b.briefContext, guidance: a.guidance }, REFLEX_CALL.abortMs);
        state.costUsd += await this.closeCall(call, res, worst[i]);
        if (res.status === "OK") answers[a.arm] = res.decisions;
        else state.failedCalls++;
      }
      state.candidate[String(b.barCloseMs)] = answers.candidate;
      state.current[String(b.barCloseMs)] = answers.current;
      state.done.push(b.barCloseMs);
      processed++;
    }
    await store.setMeta(AGENT_META.replay(candidateId), state);
    if (stop === "cap") return this.finishReplay(cand, state, batches, false, "the cost cap stopped the replay early", "cost_cap");
    // One slice per alarm: the next slice runs on the next alarm, a second from now.
    if (state.done.length < batches.length) return { requeueAt: this.d.now() + REPLAY_NEXT_SLICE_MS };
    return this.finishReplay(cand, state, batches, true, null, null);
  }

  /**
   * Scores the bars replayed so far and makes the candidate PENDING. `batches` are the day's candles with an OK batch
   * (what the replay set out to judge: barsTotal); `stopReason` says why an incomplete replay stopped.
   */
  private async finishReplay(cand: CandidateRecord, state: ReplayState, batches: ReflexBatch[], complete: boolean, note: string | null, stopReason: NonNullable<ReplayResult["stopReason"]> | null): Promise<JobResult> {
    const { store } = this.d;
    const done = batches.filter((b) => state.done.includes(b.barCloseMs)).sort((a, b) => a.barCloseMs - b.barCloseMs);
    const stored = await store.bars(cand.date);
    const bars: ReplayBar[] = done.map((b) => {
      const snapshots: ReplayBar["snapshots"] = {};
      for (const r of stored) if (r.barCloseMs === b.barCloseMs && r.snapshot) snapshots[r.index] = r.snapshot;
      return { barCloseMs: b.barCloseMs, snapshots, finalists: b.finalists };
    });
    const decisions = await store.decisions(cand.date);
    const live = done.map((b) => decisions.filter((d) => d.barCloseMs === b.barCloseMs && d.source === "REFLEX"));
    const closes = await this.closesFor(cand.date);
    const result: ReplayResult = replayScore({
      bars,
      candidate: done.map((b) => state.candidate[String(b.barCloseMs)] ?? []),
      current: live,
      currentReplayed: done.map((b) => state.current[String(b.barCloseMs)] ?? []),
      // Each label from one source: the archive when it has both bars, else the stored closes.
      closes: closes.stored,
      archive: closes.archive,
      calendar: this.d.calendar,
      nowMs: this.d.now(),
      costUsd: state.costUsd,
      complete,
    });
    const notes = [note, state.failedCalls ? `${state.failedCalls} replay call(s) failed and count as no answer` : null].filter(Boolean).join("; ");
    const replay: ReplayResult = { ...result, complete, cursorBarMs: complete ? null : (done[done.length - 1]?.barCloseMs ?? null), barsTotal: batches.length, stopReason: complete ? null : stopReason };
    await store.putCandidate({ ...cand, status: "PENDING", replay, rationale: notes ? `${cand.rationale}\n(Replay: ${notes}.)` : cand.rationale });
    await store.setMeta(AGENT_META.replay(cand.id), null);
    return DONE;
  }

  // -------------------------------------------------------------------------
  // Model calls and the cost ledger
  // -------------------------------------------------------------------------

  /**
   * Writes the call record at its worst-case cost before the request goes out, dated by the IST date of the call
   * (#11), so a crash mid-call is never counted as free. worstCaseUsd covers every billed attempt (the retry) at the
   * dearest model that can serve the request (a refusal's fallback included).
   */
  private async openCall(kind: CallKind, barCloseMs: number | null, model: string, version: string | null, worstUsd: number): Promise<CallRecord> {
    const now = this.d.now();
    const rec: CallRecord = { id: this.d.newId(), date: istDate(now), kind, barCloseMs, model, instructionVersion: version, startedMs: now, latencyMs: null, status: "ERROR", error: INTERRUPTED, usage: null, costUsd: worstUsd };
    await this.d.store.putCall(rec);
    return rec;
  }

  /**
   * Records the outcome, priced from the usage: each billed attempt at its own model when the response lists them
   * (usage.iterations), never less than the whole usage at the model that answered. Every HTTP attempt that may have
   * been billed beyond that usage (no response, or a 200 whose body broke before the message was read; judge.ts
   * possiblyBilledAttempts) adds one attempt's worst case; an attempt answered with an error status adds nothing.
   * When the judge cannot say how many attempts went out (a fake, or one that threw), a call with no usage is booked
   * at its whole worst case (#11: never under-counted). NO_KEY sent nothing.
   */
  private async closeCall(rec: CallRecord, res: CallResult, worst: CallWorst): Promise<number> {
    const model = res.model || rec.model;
    const priced = responseCostUsd({ usage: res.usage, model, iterations: res.iterations ?? null });
    const n = res.possiblyBilledAttempts;
    const extra = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    let costUsd: number;
    if (res.status === "NO_KEY") costUsd = 0;
    else if (priced !== null) costUsd = usd(priced + (extra ?? 0) * worst.one);
    else if (extra !== null) costUsd = usd(extra * worst.one);
    else costUsd = worst.all;
    await this.d.store.putCall({ ...rec, model, latencyMs: res.latencyMs, status: res.status, error: res.error, usage: res.usage, costUsd });
    return costUsd;
  }

  private async skippedCall(kind: CallKind, barCloseMs: number | null, model: string, version: string | null, now: number): Promise<void> {
    await this.d.store.putCall({ id: this.d.newId(), date: istDate(now), kind, barCloseMs, model, instructionVersion: version, startedMs: now, latencyMs: null, status: "SKIPPED_CAP", error: "the day's cost cap", usage: null, costUsd: 0 });
  }

  private async callReflex(judge: ReflexJudge, req: Omit<ReflexRequest, "signal">, abortMs: number): Promise<ReflexResponse> {
    const started = this.d.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), abortMs);
    try {
      return await judge.judge({ ...req, signal: ac.signal });
    } catch (err) {
      return { status: ac.signal.aborted ? "TIMEOUT" : "ERROR", decisions: [], dropped: [], usage: null, model: judge.model, latencyMs: this.d.now() - started, error: errText(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callDeep<T>(judge: DeepJudge, req: Omit<DeepRequest<T>, "signal">, abortMs: number): Promise<DeepResponse<T>> {
    const started = this.d.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), abortMs);
    try {
      // The judge's own deadline is the job's (its default would be longer than REVIEW_CALL.abortMs).
      return await judge.structured<T>({ ...req, abortMs, signal: ac.signal });
    } catch (err) {
      return { status: ac.signal.aborted ? "TIMEOUT" : "ERROR", parsed: null, usage: null, model: judge.model, latencyMs: this.d.now() - started, error: errText(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The worst case of the rest of today's reflex calls (cost.ts reflexReserveUsd: the bar closes still to come up to
   * 15:05), each at its largest input: escalations never eat it (#11). Nothing on a day without a session or a key.
   */
  private async reflexReserve(now: number): Promise<number> {
    if (!this.d.calendar.isTradingDay(istDate(now)) || !this.d.reflex) return 0;
    const instruction = await this.instruction();
    return reflexReserveUsd(now, worstCaseUsd(this.d.reflex.model, estimateTokens(reflexSystem(instruction.guidance)) + USER_MESSAGE_TOKEN_LIMIT, REFLEX_CALL.maxTokens));
  }

  /**
   * Tonight's review at its worst case, for a user message at REVIEW_CALL.userTokenBound (reviewUser keeps it there):
   * kept back from escalations so a busy day still gets its review (M1). Nothing on a day without a session, without a
   * review judge or in mode off, and nothing once today's review is DONE, FAILED or SKIPPED.
   */
  private async reviewReserve(now: number): Promise<number> {
    const today = istDate(now);
    const judge = this.d.review;
    if (!judge || this.d.settings.mode === "off" || !this.d.calendar.isTradingDay(today)) return 0;
    const r = await this.d.store.review(today);
    if (r && (r.status === "DONE" || r.status === "FAILED" || r.status === "SKIPPED")) return 0;
    return worstCaseUsd(judge.model, reviewSize(REVIEW_CALL.userTokenBound), REVIEW_CALL.maxTokens);
  }

  /**
   * An escalation about to run, with its real prompt: null when its worst case fits after the spend and the reflex
   * and review reserves (escalationFits), else why it does not.
   */
  private async escalationRoom(worstUsd: number, now: number): Promise<string | null> {
    const budget: EscalationBudget = {
      spentUsd: await this.d.store.spentUsd(istDate(now)),
      worstUsd,
      reflexReserveUsd: await this.reflexReserve(now),
      reviewReserveUsd: await this.reviewReserve(now),
      capUsd: this.d.settings.dailyUsdCap,
    };
    return escalationFits(budget) ? null : costCapReason(budget);
  }

  /**
   * Why approve or revert (`verb`) is refused now, or null. During the session, as always. On a trading day from the
   * close, while the day has a batch and its review or replay has not finished (the review missing, PENDING or
   * RUNNING, its job queued, or the day's candidate still SCORING): both judge the text the session ran with, and a
   * new text approved meanwhile would be compared with itself. Before the open and on holidays both are allowed.
   */
  private async approvalRefusal(now: number, verb: "approve" | "revert"): Promise<string | null> {
    const { store, calendar } = this.d;
    if (this.inSession(now)) return `${verb} before 09:15 IST, or ${APPROVAL_WINDOW_TEXT}, so one session is judged by one text`;
    const today = istDate(now);
    if (!calendar.isTradingDay(today) || now < calendar.closeMs(today)) return null;
    if ((await store.batches(today)).length === 0) return null;
    const review = await store.review(today);
    const queued = (await store.jobs()).some((j) => j.id === reviewJobId(today));
    const latest = await store.latestCandidate();
    const scoring = latest !== null && latest.status === "SCORING" && latest.date === today;
    if (!review || review.status === "PENDING" || review.status === "RUNNING" || queued || scoring) {
      return `${verb} ${APPROVAL_WINDOW_TEXT}; if no review runs today, ${verb} before 09:15 tomorrow`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** The active guidance text; the built-in one when none is stored or the code's built-in text changed. */
  private async instruction(): Promise<InstructionRecord> {
    const { store } = this.d;
    const active = await store.activeInstruction();
    const version = instructionVersion(BUILTIN_GUIDANCE);
    if (active && !(active.source === "BUILTIN" && active.version !== version)) return active;
    const builtin: InstructionRecord = { version, guidance: BUILTIN_GUIDANCE, createdMs: this.d.now(), source: "BUILTIN", candidateId: null, active: true };
    await store.putInstruction(builtin);
    return builtin;
  }

  private async paused(): Promise<boolean> {
    return (await this.d.store.getMeta<boolean>(AGENT_META.paused)) === true;
  }

  private inSession(now: number): boolean {
    return this.d.calendar.sessionPhase(now) === "OPEN";
  }

  private inReflexWindow(T: number): boolean {
    const date = istDate(T);
    return this.d.calendar.isTradingDay(date) && T >= istAt(date, AGENT_POLICY.reflexFirstBarIst) && T <= istAt(date, AGENT_POLICY.reflexLastBarIst);
  }

  /** A bar is known once its rows, its batch or its reflex job exist (submitBar's idempotency). */
  private async barKnown(T: number): Promise<boolean> {
    const { store } = this.d;
    if (await store.batch(T)) return true;
    if ((await store.jobs()).some((j) => j.id === reflexJobId(T))) return true;
    for (const index of this.d.cfg.indices) if ((await store.barsForIndex(index, T, T)).length) return true;
    return false;
  }

  /** REVIEW and REPLAY never start before or during the session (they would hold the alarm the reflex needs). */
  private phaseAllows(job: AgentJob, now: number): boolean {
    if (job.kind !== "REVIEW" && job.kind !== "REPLAY") return true;
    const phase = this.d.calendar.sessionPhase(now);
    return phase !== "PRE_OPEN" && phase !== "OPEN";
  }

  private async nextWake(busyLeft: boolean): Promise<number | null> {
    const now = this.d.now();
    if (busyLeft) return now;
    const queued = (await this.d.store.jobs()).filter((j) => j.status === "QUEUED");
    let next: number | null = null;
    for (const j of queued) {
      let at = j.dueMs;
      // A review or replay waiting for the session to end wakes at the close, not in a tight loop.
      if (!this.phaseAllows(j, Math.max(now, at))) at = Math.max(at, this.d.calendar.closeMs(istDate(Math.max(now, at))));
      if (next === null || at < next) next = at;
    }
    return next;
  }

  /** RUNNING jobs left by an interrupted alarm: their subject is marked FAILED and they are never run again (#8). */
  private async recoverInterrupted(): Promise<void> {
    for (const j of await this.d.store.jobs()) {
      if (j.status !== "RUNNING") continue;
      try {
        await this.failJob(j, INTERRUPTED);
      } catch (err) {
        this.d.logger.error("agent job recovery failed", { job: j.id, error: errText(err) });
      } finally {
        await this.d.store.deleteJob(j.id);
      }
    }
  }

  private async failJob(job: AgentJob, error: string): Promise<void> {
    const { store } = this.d;
    switch (job.kind) {
      case "REFLEX": {
        const T = Number(job.payload.barCloseMs);
        if (await store.batch(T)) return;
        const instruction = await this.instruction();
        await store.putBatch({ barCloseMs: T, date: istDate(T), status: "FAILED", error, callId: null, instructionVersion: instruction.version, finalists: [], briefId: null, briefContext: null, decisions: [], exitOnly: [], payoff: { b: 1, n: 0 }, completedMs: this.d.now() });
        return;
      }
      case "ESCALATION": {
        const esc = await store.escalation(String(job.payload.escalationId));
        if (esc && (esc.status === "QUEUED" || esc.status === "RUNNING")) await store.putEscalation({ ...esc, status: "FAILED", doneMs: this.d.now(), reason: error });
        return;
      }
      case "REVIEW": {
        const r = await store.review(String(job.payload.date));
        if (r && r.status !== "DONE") await store.putReview({ ...r, status: "FAILED", doneMs: this.d.now(), error });
        return;
      }
      case "REPLAY": {
        const cand = await store.candidate(String(job.payload.candidateId));
        if (!cand || cand.status !== "SCORING") return;
        const state = await store.getMeta<ReplayState>(AGENT_META.replay(cand.id));
        if (!state) {
          await store.putCandidate({ ...cand, status: "PENDING", replay: null });
          return;
        }
        const batches = (await store.batches(cand.date)).filter((b) => b.status === "OK" && b.finalists.length > 0);
        await this.finishReplay(cand, state, batches, false, "the replay was interrupted", "interrupted");
        return;
      }
    }
  }

  /** The bar's input as stored (snapshots, closes and token estimates per index). */
  private async storedInput(T: number, problems: string[]): Promise<ReflexInput> {
    const input: ReflexInput = { barCloseMs: T, date: istDate(T), builtMs: T, snapshots: {}, tokensEst: {}, closes: {}, problems };
    for (const index of this.d.cfg.indices) {
      const [row] = await this.d.store.barsForIndex(index, T, T);
      if (!row) continue;
      input.builtMs = row.builtMs;
      input.closes[index] = row.close;
      if (row.snapshot) {
        input.snapshots[index] = row.snapshot;
        if (row.tokensEst !== null) input.tokensEst[index] = row.tokensEst;
      }
    }
    return input;
  }

  /**
   * The newest same-day Advisor brief created at or before the bar close (AMENDMENTS #6). Briefs seen earlier are
   * kept, so a brief written just after a close never reaches that bar while the one before it still can.
   */
  private async briefFor(T: number): Promise<AdvisorReport | null> {
    const { store } = this.d;
    const date = istDate(T);
    const stored = await store.getMeta<BriefCache>(AGENT_META.briefs);
    const cache: BriefCache = stored && stored.date === date ? stored : { date, briefs: [] };
    let latest: AdvisorReport | null = null;
    try {
      latest = (await this.d.advisor())?.latest ?? null;
    } catch (err) {
      this.d.logger.warn("agent: the advisor did not answer", { error: errText(err) });
    }
    const created = (b: AdvisorReport) => Date.parse(b.createdAt);
    if (latest && Number.isFinite(created(latest)) && istDate(created(latest)) === date && !cache.briefs.some((b) => b.id === latest.id)) cache.briefs.push(latest);
    const usable = cache.briefs.filter((b) => created(b) <= T).sort((a, b) => created(b) - created(a));
    const chosen = usable[0] ?? null;
    // Older briefs than the chosen one can never be chosen again (bar closes only move forward).
    cache.briefs = cache.briefs.filter((b) => !chosen || created(b) >= created(chosen)).slice(-MAX_CACHED_BRIEFS);
    await store.setMeta(AGENT_META.briefs, cache);
    return chosen;
  }

  private async payoff(date: string): Promise<{ b: number; n: number; measured: number | null }> {
    return payoffRatio(await this.d.store.trades(addDays(date, -RETENTION_DAYS), date));
  }

  private async sizingRows(date: string, version: string): Promise<GradedDecision[]> {
    const key = `${date}|${version}`;
    if (this.sizingCache?.key !== key) this.sizingCache = { key, rows: await this.d.store.graded(addDays(date, -RETENTION_DAYS)) };
    return this.sizingCache.rows;
  }

  /** Recomputes meta["calibration:current"] for the active version (after grading, and after an approval or revert). */
  private async recomputeCalibration(version: string, now: number): Promise<CalibrationSummary> {
    const { store } = this.d;
    const from = addDays(istDate(now), -RETENTION_DAYS);
    const [rows, neutral] = await Promise.all([store.graded(from), store.gradedNeutral(from)]);
    const summary = calibrationSummary(rows, version, now, neutral);
    await store.setMeta(AGENT_META.calibration, summary);
    this.sizingCache = null;
    return summary;
  }

  /**
   * The day's closes per index from the D1 archive (bars_5m, settled) and from the bars TE stored, and whether the
   * archive has the whole session (its 15:25 bar on every index).
   */
  private async closesFor(date: string): Promise<{
    archive: Map<IndexId, Map<number, number>>;
    stored: Map<IndexId, Map<number, number>>;
    archiveReady: boolean;
    forPrompt: Partial<Record<IndexId, { t: string; c: number }[]>>;
  }> {
    const archive = new Map<IndexId, Map<number, number>>();
    const stored = new Map<IndexId, Map<number, number>>();
    const open = istAt(date, "09:15");
    const close = istAt(date, "15:30");
    let ready = true;
    for (const index of this.d.cfg.indices) {
      let rows: { t: number; c: number }[] = [];
      try {
        rows = await this.d.barsFallback(index, open, close);
      } catch (err) {
        this.d.logger.warn("agent: bar archive read failed", { index, error: errText(err) });
      }
      const m = archiveClosesMap(rows);
      archive.set(index, m);
      if (!m.has(close)) ready = false;
      stored.set(index, new Map());
    }
    for (const b of await this.d.store.bars(date)) stored.get(b.index)?.set(b.barCloseMs, b.close);
    const forPrompt: Partial<Record<IndexId, { t: string; c: number }[]>> = {};
    for (const index of this.d.cfg.indices) {
      const m = (archive.get(index)?.size ? archive.get(index) : stored.get(index)) ?? new Map<number, number>();
      forPrompt[index] = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t: formatHHMM(istMinutes(t)), c }));
    }
    return { archive, stored, archiveReady: ready, forPrompt };
  }

  /** The agent exit reason per position today (from TE's execution records), for the trade records. */
  private async rememberExits(rec: ExecutionRecord): Promise<Record<string, AgentExitReason>> {
    const { store } = this.d;
    const date = istDate(rec.barCloseMs);
    const stored = await store.getMeta<{ date: string; byPosition: Record<string, AgentExitReason> }>(AGENT_META.exits);
    const cur = stored && stored.date === date ? stored : { date, byPosition: {} as Record<string, AgentExitReason> };
    let changed = false;
    for (const e of rec.exits) {
      if (e.status === "EXIT_PENDING" || e.status === "SHADOW_EXIT" || e.status.startsWith("ERROR") || cur.byPosition[e.positionId]) continue;
      cur.byPosition[e.positionId] = e.reason;
      changed = true;
    }
    if (changed || !stored || stored.date !== date) await store.setMeta(AGENT_META.exits, cur);
    return cur.byPosition;
  }
}
