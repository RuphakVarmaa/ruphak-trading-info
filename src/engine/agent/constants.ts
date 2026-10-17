/** Every threshold of the options agent. The code owns these; model outputs never change them. */
import { MINUTE_MS } from "../clock";

/** The code gate (SPEC §5.1). Model outputs never change these. */
export const AGENT_POLICY = {
  minSetupQuality: 2,
  /** directionConfidence must be strictly greater. */
  minConfidenceExclusive: 0.8,
  oppositeExitConfidenceExclusive: 0.8,
  /** A batch older than this after its bar close is not executed. */
  maxDecisionAgeMs: 4 * MINUTE_MS,
  maxOptionAgeSec: 180,
  maxSnapshotSpreadPct: 1.5,
  /** The book's quantity imbalance (summed depth when the quote has it) above which quoteGateLines calls it one-sided: information only (passed null), never a block. */
  oneSidedBookImbalance: 0.85,
  /** An idea is bought only at an ask ≤ the brief's buy-zone top × this. */
  ideaPremiumTolerance: 1.05,
  reflexFirstBarIst: "09:20",
  /** Bars closing after this are stored for grading only, with no model call. */
  reflexLastBarIst: "15:05",
  /** Submit a bar with an incomplete index this long after the close (that index then has no snapshot). */
  incompleteBarWaitMs: 2 * MINUTE_MS,
  maxIdeas: 4,
} as const;

/** The risk layer (SPEC §5.5). The ACCOUNTS.agent pins must agree (risk.test.ts asserts it). */
export const AGENT_LIMITS = {
  capitalRupees: 500_000,
  maxDrawdownPct: 15,
  dailyLossCapPct: 3,
  weeklyLossCapPct: 6,
  maxOpenTotal: 2,
  maxOpenPerIndex: 1,
  maxLotsPerPosition: 3,
  maxRiskPctPerTrade: 1,
  kellyFraction: 0.25,
  /** The code's own risk state (SPEC §5.1). */
  nearDrawdownPct: 10,
  reduceDrawdownPct: 13.5,
  nearDayLossFrac: 0.5,
  reduceDayLossFrac: 0.8,
} as const;

/**
 * Sizing probability (SPEC §5.4 as amended). p is the `sizingQuantile` quantile of
 * Beta(Σw·paid + 0.5·N0, Σw·(1 − paid) + 0.5·N0), N0 = pooledPriorN, over graded directional decisions of the
 * decision's own source (reflex or escalation) with confidence above fireMinConfidence; each row is weighted by
 * 1 / (the rows, on either index, whose 30-minute windows overlap it). With no such row (Σw = 0) the agent does not
 * trade. switchMinGraded counts every window once (Σ_all w), whatever bucket it fell in.
 */
export const CALIBRATION = {
  fireMinConfidence: 0.8,
  pooledPriorN: 100,
  sizingQuantile: 0.2,
  switchMinGraded: 300,
  bucketMinN: 30,
  bucketPriorN: 30,
  oldVersionWeight: 0.5,
  bucketEdges: [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001],
  payoffPriorB: 1,
  payoffPriorN: 20,
  /** Until this many agent trades have closed, b = min(b, payoffPriorB). */
  payoffMinTradesForMeasuredB: 30,
} as const;

/**
 * Outcome labels (SPEC §6). Directional: HIT when the move in the called direction is ≥ deadbandPct; `paid` when it
 * is ≥ payMovePct. NEUTRAL is right when |move| < neutralBandPct.
 */
export const OUTCOME = { horizonBars: 6, deadbandPct: 0.03, payMovePct: 0.15, neutralBandPct: 0.15, lastGradableBarIst: "15:00" } as const;

/** Escalation to the deep model (SPEC §4.6). */
export const ESCALATION = {
  belowConfidence: 0.6,
  minSetupQuality: 2,
  perIndexGapMs: 30 * MINUTE_MS,
  lastBarIst: "15:00",
  startWithinMs: 170_000,
  effort: "medium",
  maxTokens: 8_000,
  timeoutMs: 75_000,
  abortMs: 160_000,
  contextBars: 6,
} as const;

export const REFLEX_CALL = { effort: "low", maxTokens: 4_096, timeoutMs: 20_000, maxRetries: 1, abortMs: 45_000 } as const;
/**
 * The nightly review is streamed. It runs at dueIst and again at retryIst when the bar archive is not complete.
 * maxTokens is SPEC §4.7's 16K. userTokenBound bounds its user message in estimateProseTokens units (prompt.ts
 * reviewUser folds rows until it fits), so the review's worst case is known before the day ends and escalations can
 * leave room for it.
 */
export const REVIEW_CALL = {
  effort: "high",
  maxTokens: 16_000,
  userTokenBound: 28_000,
  timeoutMs: 300_000,
  maxRetries: 1,
  abortMs: 540_000,
  replayBarsPerAlarm: 15,
  dueIst: "16:20",
  retryIst: "16:40",
} as const;

/**
 * The TE runner's step, inside TE's tick after main's exit polls. It runs under a time budget of
 * clamp(tickStart + fromTickStartMs − now, minMs, maxMs); exits always run first. While main or a follower account holds
 * a position or an order, main's two exit-poll waits run the rest of the step but the decisions: the kill coupling and
 * the code exits always run (but before 09:15 a wait runs only the code exits, and a wait does nothing while earlier
 * agent work, such as a step, is still running, at most 2 minutes); each later part starts, and each call to another
 * Durable Object is sent, only before the wait ends (the book always follows the risk row).
 */
export const AGENT_STEP = {
  fromTickStartMs: 27_000,
  minMs: 4_000,
  maxMs: 12_000,
  /** Unsent execution records kept for the next tick. Gate-only records are dropped first, never trades. */
  outboxMax: 10,
  /**
   * Recorded books kept for bookAsOf. A book is recorded at each step and each exit-poll wait (three a tick while main
   * or a follower account holds a position or an order), and a bar may wait up to AGENT_POLICY.maxDecisionAgeMs for its
   * submission: 36 cover 6 minutes.
   */
  bookRing: 36,
} as const;

/** Timeouts of the runner's calls to other Durable Objects. */
export const AGENT_RPC_MS = { flowAsOf: 1_500, submitBar: 2_000, takeDecisions: 1_500, recordExecution: 2_000 } as const;

/** The runner's own option-quote budget, separate from main's (UpstoxOptionQuotesOptions). */
export const AGENT_QUOTES = { maxRequestsPerMinute: 4, pauseAfterErrorMs: 30_000 } as const;

export const SNAPSHOT_TOKEN_LIMIT = 400;
/** A typical snapshot (SPEC §3.2's example) must estimate at or below this. */
export const SNAPSHOT_TYPICAL_TOKEN_TARGET = 340;
export const USER_MESSAGE_TOKEN_LIMIT = 4_500;
/** Conservative bound for dense numeric JSON; /ops/agent-count-tokens checks it against the API's own count. */
export const CHARS_PER_TOKEN_BOUND = 1.2;
/** Prose (finalist text and the brief) is estimated at ceil(length / this). */
export const PROSE_CHARS_PER_TOKEN = 3;
export const RETENTION_DAYS = 120;

export const AGENT_HONESTY =
  "A measured experiment on paper, not advice. This project's research found no edge for option buyers " +
  "(3,303 rule variants and 98 option-flow rules on real prices). The model's confidence is not a probability " +
  "until the nightly scoring shows it is calibrated; sizing uses measured results only, and every limit is enforced in code.";
