/** Types shared by the agent's engine modules, the AgentDO and the TE runner. No runtime code. */
import type { AdvisorHorizon, AgentAction, AgentDecisionSource, AgentDirection, AgentFinalistKind, AgentMode, AgentRegime, AgentRiskLevel } from "../api-types";
import type { LlmUsage } from "../ports";
import type { GateResult, IndexId, OptionType, TradeSide } from "../types";

export type { AgentAction, AgentDecisionSource, AgentDirection, AgentFinalistKind, AgentMode, AgentRegime, AgentRiskLevel };

export interface AgentSettings {
  mode: AgentMode;
  reflexModel: string;
  escalationModel: string;
  reviewModel: string;
  dailyUsdCap: number;
  escalationsPerDay: number;
}

/**
 * One index at one bar close (SPEC §3): the only market state the reflex model sees. Short keys on purpose:
 * this is the model's input. Returns and distances are integer basis points (r5: 12 means +0.12%); a
 * distance is level / c − 1, positive when the level is above the close. null means unknown, never 0.
 */
export interface IndexSnapshot {
  c: number;
  /** Log returns over 5, 15 and 60 minutes, and the return since today's open (bp). */
  r5: number; r15: number; r60: number; ro: number;
  /** Distance to VWAP (bp) and the VWAP z-score. */
  vw: number; vz: number;
  /** Distances to the opening-range high and low (bp); the range: F forming, I inside, U broke up, D broke down. */
  orh: number | null; orl: number | null; ors: "F" | "I" | "U" | "D";
  /** Distances to the previous day's high, low and close (bp). */
  pdh: number | null; pdl: number | null; pdc: number | null;
  rsi: number; adx: number; di: number; st: -1 | 0 | 1; rv: number; atr: number;
  vix: number | null; vixc: number;
  o: OptionBlock | null;
  /** The engine's conviction and regime (TU trend up, TD trend down, RG range, HV high volatility, EV event). */
  cv: number; rg: "TU" | "TD" | "RG" | "HV" | "EV";
  pv: "C" | "A" | "X"; pn: string; ew: 0 | 1; dte: number; xd: 0 | 1;
  bk: BookBlock;
}
/** The ATM option block. mp, cw and pw are distances in bp; mp is max pain within the ±15 monitored strikes. */
export interface OptionBlock {
  k: number; cm: number | null; cs: number | null; pm: number | null; ps: number | null;
  iv: number | null; ivx: number | null; pcr: number | null; mp: number | null; cw: number | null; pw: number | null;
  bc: [number, number, number, number]; bp: [number, number, number, number]; oa: number;
}
export interface BookBlock { pos: "L" | "S" | "-"; lots: number; pnl: number | null; dd: number; dl: number }

export interface AgentBookPosition { index: IndexId; side: TradeSide; lots: number; avgEntry: number; markPremium: number; markMs: number }
/** The agent's own book as TE recorded it at time t (always ≤ the bar close it is used for). */
export interface AgentBookState { t: number; equity: number; peakEquity: number; ddPct: number; dayLossPct: number; positions: AgentBookPosition[] }

export interface Finalist {
  /** "gen:NIFTY" | "idea:<briefId>:<ideaId>". */
  id: string;
  kind: AgentFinalistKind;
  index: IndexId;
  label: string;
  /** Fixed for an IDEA (CE → LONG, PE → SHORT); null for GENERIC. */
  side: "LONG" | "SHORT" | null;
  contract: { expiry: string; strike: number; type: OptionType; tradingSymbol: string; lotSize: number } | null;
  /** The brief's buy-zone top (rupees); null for GENERIC. */
  entryHigh: number | null;
  condition: string | null;
  wrongIf: string | null;
  bearCase: string | null;
  why: string[];
  horizon: AdvisorHorizon | null;
  briefId: string | null;
}

/** The brief's headline and factors as the reflex model reads them (context, not data). */
export interface BriefContext { headline: string; factors: string[] }

export interface ReflexInput {
  barCloseMs: number;
  date: string;
  builtMs: number;
  snapshots: Partial<Record<IndexId, IndexSnapshot>>;
  tokensEst: Partial<Record<IndexId, number>>;
  /** Bar closes for grading (also for indices whose snapshot is missing). */
  closes: Partial<Record<IndexId, number>>;
  problems: string[];
}

export interface ReflexDecision {
  finalistId: string;
  regime: AgentRegime;
  direction: AgentDirection;
  directionConfidence: number;
  toxicFlow: boolean;
  setupQuality: 0 | 1 | 2 | 3;
  riskState: AgentRiskLevel;
  reason: string;
}

export type CallKind = "REFLEX" | "ESCALATION" | "REVIEW" | "REPLAY";
export type CallStatus = "OK" | "REFUSED" | "MAX_TOKENS" | "PARSE_ERROR" | "TIMEOUT" | "ERROR" | "SKIPPED_CAP" | "NO_KEY";
/**
 * One model call. `date` is the IST date the call was made (never a reviewed date). `costUsd` is priced from the
 * usage; a call that sent a request and ended without usage is recorded at its worst case.
 */
export interface CallRecord {
  id: string; date: string; kind: CallKind; barCloseMs: number | null; model: string; instructionVersion: string | null;
  startedMs: number; latencyMs: number | null; status: CallStatus; error: string | null; usage: LlmUsage | null; costUsd: number;
}

/**
 * The sizing probability for one decision (SPEC §5.4 as amended): p is the CALIBRATION.sizingQuantile quantile of the
 * Beta posterior of the `paid` label on graded directional reflex decisions, with the overlap weights. Never the
 * model's stated confidence.
 */
export interface SizingHint {
  p: number;
  mode: "pooled" | "buckets";
  /** Effective (weighted) number of graded decisions behind p. */
  n: number;
  /** The posterior mean of the paid rate, before the quantile. */
  mean: number;
}
export interface GateLine { gate: string; passed: boolean | null; detail: string }
export interface GateVerdict { fired: boolean; lines: GateLine[]; codeToxic: string[]; codeRisk: AgentRiskLevel; effectiveRisk: AgentRiskLevel }
export interface EdgeVerdict { passed: boolean; rows: GateResult[] }
export interface SizingTrace { p: number; b: number; kelly: number; quarterKelly: number; riskPct: number; lots: number; riskRupees: number; limitedBy: string }
export interface DecisionExecution {
  t: number; gate: GateVerdict; action: AgentAction; detail: string;
  planId: string | null; positionId: string | null; tradingSymbol: string | null;
  edge: EdgeVerdict | null; sizing: SizingTrace | null;
}
export type OutcomeStatus = "HIT" | "MISS" | "NEUTRAL" | "CENSORED" | "MISSING";
/** Where both closes of a label came from: the settled D1 archive (bars_5m) or the closes stored with each bar. */
export type OutcomeSource = "BARS_5M" | "STORED";
/**
 * A decision's 30-minute outcome. Directional (HIT/MISS): y = 1 when the index moved at least OUTCOME.deadbandPct in
 * the called direction; `paid` when it moved at least OUTCOME.payMovePct (the sizing label). NEUTRAL: y = 1 when the
 * index stayed within OUTCOME.neutralBandPct either way (its own Brier line, never used for sizing). CENSORED and
 * MISSING: y, paid and source are null.
 */
export interface DecisionOutcome { status: OutcomeStatus; y: 0 | 1 | null; ret30Pct: number | null; paid: boolean | null; source: OutcomeSource | null; gradedMs: number }

export interface DecisionRecord extends ReflexDecision {
  id: string; date: string; barCloseMs: number; index: IndexId; finalistKind: AgentFinalistKind;
  source: AgentDecisionSource; callId: string; instructionVersion: string;
  /** True for the row the code gated (the merged one when an escalation applied). */
  effective: boolean;
  sizing: SizingHint | null;
  execution: DecisionExecution | null;
  outcome: DecisionOutcome | null;
  /** True when code, not a model, set this row's direction and confidence (the NEUTRAL 0.5 of a reflex/escalation disagreement). Never scored. */
  codeMade?: boolean;
}

export type BatchStatus = "OK" | "FAILED" | "COST_CAP" | "OFF" | "NO_FINALISTS" | "STALE";
export interface ReflexBatch {
  barCloseMs: number; date: string; status: BatchStatus; error: string | null;
  callId: string | null; instructionVersion: string;
  finalists: Finalist[];
  /** The brief the finalists and context came from: created at or before the bar close, same IST date; null without one. */
  briefId: string | null;
  briefContext: BriefContext | null;
  /** Effective decisions (entries and exits). Empty unless status is OK. */
  decisions: DecisionRecord[];
  /** Escalation results usable for exits only (the reflex failed on this bar). */
  exitOnly: DecisionRecord[];
  payoff: { b: number; n: number };
  completedMs: number;
}

export type AgentExitReason = "AGENT_REDUCE" | "AGENT_CRISIS" | "AGENT_OPPOSITE";
export interface AgentPositionTag { finalistId: string; decisionId: string; index: IndexId; side: "LONG" | "SHORT" }
export interface AgentTradeRecord {
  positionId: string; date: string; index: IndexId; side: TradeSide; finalistId: string | null; decisionId: string | null;
  tradingSymbol: string; entryMs: number; exitMs: number; lots: number; pnlRupees: number; pnlPctPremium: number;
  exitReason: string; agentExit: AgentExitReason | null;
}
export interface AgentRiskSnapshot {
  t: number; date: string; equity: number; peakEquity: number; ddPct: number; dayLossPct: number; openPositions: number;
  killSwitch: boolean; killReason: string | null; mainKillSwitch: boolean; ddHalt: boolean; codeRisk: AgentRiskLevel;
}
export interface ExecutionRecord {
  barCloseMs: number; t: number;
  decisions: { decisionId: string; execution: DecisionExecution }[];
  exits: { positionId: string; decisionId: string | null; reason: AgentExitReason; status: string }[];
  trades: AgentTradeRecord[];
  risk: AgentRiskSnapshot;
}

export interface EscalationRecord {
  id: string; date: string; barCloseMs: number; index: IndexId; finalistId: string;
  trigger: "LOW_CONFIDENCE" | "CRISIS_FLIP";
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "LATE" | "SKIPPED";
  requestedMs: number; doneMs: number | null; reflexDecisionId: string;
  decision: ReflexDecision | null; reason: string | null; callId: string | null; appliedBarMs: number | null;
}

export interface StoredBar { barCloseMs: number; date: string; index: IndexId; close: number; snapshot: IndexSnapshot | null; tokensEst: number | null; builtMs: number }

export interface ReviewOut {
  summary: string; fills: string[]; misses: string[]; mistakes: string[]; lessons: string[];
  candidate: { guidance: string; rationale: string; wouldBeWrongIf: string } | null;
}
export interface CalibrationBucket { from: number; to: number; n: number; statedMean: number | null; hitRate: number | null; paidRate: number | null }
export interface CalibrationSummary {
  asOfMs: number; graded: number; brier: number | null; baselineBrier: number | null;
  byIndex: { index: IndexId; n: number; brier: number | null }[];
  byKind: { kind: AgentFinalistKind; n: number; brier: number | null }[];
  byVersion: { version: string; n: number; brier: number | null }[];
  /** REFLEX and ESCALATION scored apart; only REFLEX rows feed sizing. */
  bySource: { source: AgentDecisionSource; n: number; brier: number | null }[];
  /** NEUTRAL decisions on their own Brier line (y = 1 when the index stayed within OUTCOME.neutralBandPct). */
  neutral: { n: number; brier: number | null; baselineBrier: number | null };
  buckets: CalibrationBucket[]; sizingMode: "pooled" | "buckets"; sizingP: number | null;
  /** Effective (weighted) number of graded decisions behind sizingP. */
  sizingN: number;
  paidRate: number | null;
}
export interface ReviewRecord {
  date: string; status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED"; dueMs: number;
  startedMs: number | null; doneMs: number | null; model: string | null; callId: string | null;
  report: ReviewOut | null; calibration: CalibrationSummary | null; error: string | null;
}
/**
 * Both texts replayed fresh on identical inputs (stored snapshots, finalists and brief context). brierCurrentLive scores
 * the stored live decisions on the same bars; its gap to brierCurrentReplayed measures run-to-run noise. firesCurrent
 * and hitRateCurrent are the replayed current text's.
 */
export interface ReplayResult {
  bars: number; graded: number;
  brierCandidate: number | null; brierCurrentReplayed: number | null; brierCurrentLive: number | null;
  firesCandidate: number; firesCurrent: number; hitRateCandidate: number | null; hitRateCurrent: number | null;
  costUsd: number; complete: boolean; cursorBarMs: number | null; label: "in-sample, not proof";
  /** The day's candles with an OK batch: what the replay set out to judge. Fallback: bars. */
  barsTotal?: number;
  /** Directional calls each run labelled HIT or MISS. Fallback for each: graded. */
  gradedCandidate?: number;
  gradedCurrent?: number;
  gradedLive?: number;
  /** Calls (candle and finalist) that all three runs labelled HIT or MISS; all three Brier scores are over exactly these. `graded` now equals this. */
  gradedCommon?: number;
  /** Why an incomplete replay stopped; null when complete. Absent on an incomplete replay: say "stopped early" with no cause. */
  stopReason?: "cost_cap" | "interrupted" | "no_key" | null;
}
export interface CandidateRecord {
  id: string; date: string; createdMs: number; baseVersion: string; guidance: string; rationale: string; wouldBeWrongIf: string;
  status: "SCORING" | "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED" | "FAILED";
  replay: ReplayResult | null; decidedMs: number | null; decidedBy: string | null;
}
export interface InstructionRecord { version: string; guidance: string; createdMs: number; source: "BUILTIN" | "CANDIDATE"; candidateId: string | null; active: boolean }
/** A queued model job. It is marked RUNNING before its call; a RUNNING job found after a restart becomes FAILED, never re-run. */
export interface AgentJob { id: string; kind: CallKind; dueMs: number; status: "QUEUED" | "RUNNING"; startedMs: number | null; payload: Record<string, unknown> }
/** A graded directional decision (outcome HIT or MISS), for the Brier score and sizing. */
export interface GradedDecision {
  id: string; date: string; barCloseMs: number; index: IndexId; finalistKind: AgentFinalistKind; source: AgentDecisionSource;
  instructionVersion: string; effective: boolean;
  direction: Exclude<AgentDirection, "NEUTRAL">; directionConfidence: number; y: 0 | 1; paid: boolean;
}
/** A graded NEUTRAL decision: y = 1 when the index stayed within OUTCOME.neutralBandPct either way over 30 minutes. */
export interface GradedNeutral {
  id: string; date: string; barCloseMs: number; index: IndexId; finalistKind: AgentFinalistKind; source: AgentDecisionSource;
  instructionVersion: string; effective: boolean; directionConfidence: number; y: 0 | 1;
}

/** Storage for the AgentDO; MemoryAgentStore (tests) and SqlAgentStore (worker) pass agentStoreContract. */
export interface AgentStore {
  putBar(row: StoredBar): Promise<void>;
  bars(date: string): Promise<StoredBar[]>;
  barsForIndex(index: IndexId, fromMs: number, toMs: number): Promise<StoredBar[]>;
  putBatch(b: ReflexBatch): Promise<void>;
  batch(barCloseMs: number): Promise<ReflexBatch | null>;
  batches(date: string): Promise<ReflexBatch[]>;
  /** The newest batch with barCloseMs > afterBarMs, or null. */
  latestBatchAfter(afterBarMs: number): Promise<ReflexBatch | null>;
  putDecisions(rows: DecisionRecord[]): Promise<void>;
  decisions(date: string): Promise<DecisionRecord[]>;
  decisionsForBar(barCloseMs: number): Promise<DecisionRecord[]>;
  updateExecution(id: string, e: DecisionExecution): Promise<void>;
  updateOutcomes(rows: { id: string; outcome: DecisionOutcome }[]): Promise<void>;
  /** Graded directional decisions (outcome HIT or MISS) dated on or after fromDate; never a codeMade row. */
  graded(fromDate: string): Promise<GradedDecision[]>;
  /** Graded NEUTRAL decisions (outcome NEUTRAL with y set) dated on or after fromDate; never a codeMade row. */
  gradedNeutral(fromDate: string): Promise<GradedNeutral[]>;
  putCall(c: CallRecord): Promise<void>;
  calls(date: string): Promise<CallRecord[]>;
  spentUsd(date: string): Promise<number>;
  putEscalation(e: EscalationRecord): Promise<void>;
  escalations(date: string): Promise<EscalationRecord[]>;
  escalation(id: string): Promise<EscalationRecord | null>;
  putTrades(rows: AgentTradeRecord[]): Promise<void>;
  trades(fromDate: string, toDate: string): Promise<AgentTradeRecord[]>;
  putRisk(r: AgentRiskSnapshot): Promise<void>;
  latestRisk(): Promise<AgentRiskSnapshot | null>;
  putReview(r: ReviewRecord): Promise<void>;
  review(date: string): Promise<ReviewRecord | null>;
  latestReview(onOrBefore: string): Promise<ReviewRecord | null>;
  putCandidate(c: CandidateRecord): Promise<void>;
  candidate(id: string): Promise<CandidateRecord | null>;
  latestCandidate(): Promise<CandidateRecord | null>;
  putInstruction(i: InstructionRecord): Promise<void>;
  activeInstruction(): Promise<InstructionRecord | null>;
  /** The stored text of one guidance version, active or not; null when it was never stored. */
  instruction?(version: string): Promise<InstructionRecord | null>;
  setActiveInstruction(version: string): Promise<void>;
  /** Inserts or replaces a job by id (also how a job is marked RUNNING). */
  putJob(j: AgentJob): Promise<void>;
  /** QUEUED jobs with dueMs ≤ nowMs, oldest due first. */
  dueJobs(nowMs: number): Promise<AgentJob[]>;
  /** Every job, any status (restart recovery and duplicate checks). */
  jobs(): Promise<AgentJob[]>;
  deleteJob(id: string): Promise<void>;
  /** The earliest dueMs among QUEUED jobs, or null. */
  nextJobMs(): Promise<number | null>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** Deletes bars, batches, decisions, calls, escalations and risk rows dated before `beforeDate`; returns rows deleted. */
  prune(beforeDate: string): Promise<number>;
}
