/**
 * The dashboard's AgentView, built from the AgentDO's records. Every label is plain English for someone new to
 * options: what the model said, what the code decided and why, the account's risk, how well the model's
 * confidence has matched what happened, and what it cost. Nothing here promises a profit.
 */
import type {
  AccountView,
  AgentCalibrationView,
  AgentCandidateView,
  AgentCostView,
  AgentDecisionView,
  AgentEscalationView,
  AgentFinalistView,
  AgentIndexCardView,
  AgentReviewView,
  AgentRiskView,
  AgentSnapshotFieldView,
  AgentView,
} from "../api-types";
import { defaultCalendar, type TradingCalendar } from "../calendar/calendar";
import { istDate, istIso } from "../clock";
import type { EngineSettings, IndexId } from "../types";
import { AGENT_HONESTY, AGENT_LIMITS, AGENT_POLICY } from "./constants";
import type {
  AgentRiskSnapshot,
  AgentSettings,
  AgentTradeRecord,
  CalibrationSummary,
  CallKind,
  CallRecord,
  CandidateRecord,
  DecisionRecord,
  EscalationRecord,
  Finalist,
  GateLine,
  IndexSnapshot,
  InstructionRecord,
  ReflexBatch,
  ReviewRecord,
  StoredBar,
} from "./types";

/** The indices the agent judges (the account's pinned list). */
const AGENT_INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
const CALL_KINDS: readonly CallKind[] = ["REFLEX", "ESCALATION", "REVIEW", "REPLAY"];
/** Shown before any text is stored: the agent starts from its built-in guidance. */
const BUILTIN_LABEL = "built-in";

export interface AgentViewInput {
  date: string;
  nowMs: number;
  settings: AgentSettings;
  /** The agent account is in the engine's ACCOUNTS list. */
  enabled: boolean;
  /** The operator paused the agent (/ops/agent-pause). */
  paused: boolean;
  account: AccountView | null;
  instruction: InstructionRecord | null;
  bars: StoredBar[];
  batches: ReflexBatch[];
  /** Every decision of the date (the store's rows carry the execution and outcome). */
  decisions: DecisionRecord[];
  escalations: EscalationRecord[];
  risk: AgentRiskSnapshot | null;
  calibration: CalibrationSummary | null;
  /** The payoff ratio b sizing uses, the trades behind it, and b as measured (null until a win and a loss). */
  payoff: { b: number; n: number; measured: number | null };
  /** The agent's closed trades over the calibration window (the totals on the calibration panel). */
  trades: AgentTradeRecord[];
  review: ReviewRecord | null;
  /** The review call's cost (it can be dated on another day than the view). */
  reviewCostUsd: number | null;
  candidate: CandidateRecord | null;
  /** The guidance text in use now (the candidate's "before"). */
  baseGuidance: string;
  /** The date's model calls (cost and latency). */
  calls: CallRecord[];
  calendar: TradingCalendar;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const signed = (x: number, dp: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(dp)}`;
const num = (x: number, dp = 0) => x.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** Integer basis points as a signed percent: 12 → "+0.12%". */
const bpPct = (bp: number) => `${signed(bp / 100, 2)}%`;
/** A level's distance from the close (bp, positive when the level is above): 18 → "0.18% above the close". */
const dist = (bp: number | null) => (bp === null ? "unknown" : bp === 0 ? "at the close" : `${Math.abs(bp / 100).toFixed(2)}% ${bp > 0 ? "above" : "below"} the close`);
const yesNo = (b: 0 | 1) => (b ? "yes" : "no");
const unknownOr = <T>(v: T | null, f: (x: T) => string) => (v === null ? "unknown" : f(v));
const iso = (ms: number | null) => (ms === null ? null : istIso(ms));

function percentile(sortedValues: number[], q: number): number | null {
  if (!sortedValues.length) return null;
  const i = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[i];
}

// ---------------------------------------------------------------------------
// Gate lines in plain words
// ---------------------------------------------------------------------------

const PCT = (x: number) => `${Math.round(x * 100)}%`;

/** What each check means, when it passes and when it blocks. Thresholds come from the code's constants. */
const GATE_WORDS: Record<string, { pass: string; fail: string }> = {
  fresh: {
    pass: "The decision is recent enough to act on",
    fail: `The decision is too old to act on (more than ${AGENT_POLICY.maxDecisionAgeMs / 60_000} minutes after the candle closed)`,
  },
  batch_ok: { pass: "The model's answer for this candle was complete and valid", fail: "The model's answer for this candle was missing or not valid" },
  setup_quality: { pass: `The model rated the setup at least ${AGENT_POLICY.minSetupQuality} out of 3`, fail: `The model rated the setup below ${AGENT_POLICY.minSetupQuality} out of 3` },
  confidence: {
    pass: `The model's confidence is above ${PCT(AGENT_POLICY.minConfidenceExclusive)}`,
    fail: `The model's confidence is not above ${PCT(AGENT_POLICY.minConfidenceExclusive)}`,
  },
  direction: { pass: "The model picked a direction (buy a call or buy a put)", fail: "The model said no trade (neutral)" },
  regime: { pass: "The model does not see a crisis", fail: "The model sees a crisis, so no new trades" },
  idea_side: { pass: "The call matches the idea's side", fail: "The call goes against the idea's fixed side" },
  toxic_model: { pass: "The model saw no warning signs in the option prices", fail: "The model saw warning signs in the option prices" },
  toxic_code: { pass: "The code's own option checks passed (fresh data, tight spread)", fail: "The code's own option checks failed (missing or stale data, or a wide spread)" },
  risk_state: { pass: "The account's risk is in the safe zone", fail: "The account's risk is not in the safe zone" },
  entry_mode: { pass: "New entries are allowed now", fail: "New entries are paused" },
  time_budget: { pass: "There was time left in this step", fail: "There was no time left in this step; the next one tries again" },
  kelly: { pass: "Sizing found a measured edge, so the size is above zero", fail: "No measured edge yet, so the size is zero" },
  plan: { pass: "The engine's own entry checks passed (time window, data, quote, spread, limits)", fail: "The engine's own entry checks blocked it" },
  kelly_cap: { pass: "The trade risks no more than the sizing allows", fail: "Even one lot would risk more than the sizing allows" },
  quote: { pass: "The live option price is real and has buyers and sellers", fail: "The live option price is not usable" },
  idea_contract: { pass: "The plan uses the idea's own contract", fail: "The plan did not use the idea's own contract" },
  idea_band: { pass: "The price is inside the brief's buy zone", fail: "The price is above the brief's buy zone" },
  kill_switch: { pass: "No kill switch or drawdown halt is on", fail: "A kill switch or the drawdown halt is on" },
  order: { pass: "The paper order was accepted", fail: "The paper order was not accepted" },
};

/** Labels for lines that only inform (passed: null). */
const INFO_WORDS: Record<string, string> = {
  book_imbalance: "Buyers versus sellers waiting at the best prices",
  one_sided_book: "The order book is lopsided (noted, not a block)",
  edge: "The measured-edge check this account skips",
};

/** One gate line in plain English, with the code's numbers in brackets. */
export function gateWords(line: GateLine): string {
  const detail = line.detail.trim();
  const tail = detail ? ` (${detail})` : "";
  const known = GATE_WORDS[line.gate];
  if (line.passed === null) return `For information: ${INFO_WORDS[line.gate] ?? (known ? known.pass : line.gate.replace(/_/g, " "))}${tail}`;
  if (known) return `${line.passed ? "Passed" : "Blocked"}: ${line.passed ? known.pass : known.fail}${tail}`;
  return `${line.passed ? "Passed" : "Blocked"}: ${line.gate.replace(/_/g, " ")}${tail}`;
}

/** The first blocking line in words, or a plain "every check passed". */
function gateSummaryWords(lines: GateLine[], fired: boolean): string {
  if (fired) return "Every check passed";
  const first = lines.find((l) => l.passed === false);
  return first ? gateWords(first) : "Not every check passed";
}

// ---------------------------------------------------------------------------
// The snapshot, field by field
// ---------------------------------------------------------------------------

const REGIME_WORDS: Record<IndexSnapshot["rg"], string> = { TU: "trend up", TD: "trend down", RG: "range", HV: "high volatility", EV: "event" };
const OR_WORDS: Record<IndexSnapshot["ors"], string> = { F: "still forming", I: "price inside it", U: "broke up", D: "broke down" };
const PLAN_WORDS: Record<IndexSnapshot["pv"], string> = { C: "clear", A: "caution", X: "no trade" };
const RULE_WORDS: Record<string, string> = { k: "clear", c: "caution", b: "block", u: "unknown" };
const PLAN_RULES = ["N1", "N2", "N4", "N7", "N9"] as const;
const POS_WORDS: Record<IndexSnapshot["bk"]["pos"], string> = { L: "a call held", S: "a put held", "-": "none" };
const counts = (c: readonly number[]) => c.join(" / ");

/** Every snapshot field with a plain label and value, in the order the model reads them. */
export function snapshotFields(s: IndexSnapshot): AgentSnapshotFieldView[] {
  const f = (key: string, label: string, value: string): AgentSnapshotFieldView => ({ key, label, value });
  const out: AgentSnapshotFieldView[] = [
    f("c", "Close of the candle", num(s.c)),
    f("r5", "Change over 5 minutes", bpPct(s.r5)),
    f("r15", "Change over 15 minutes", bpPct(s.r15)),
    f("r60", "Change over 60 minutes", bpPct(s.r60)),
    f("ro", "Change since today's open", bpPct(s.ro)),
    f("vw", "VWAP (the day's average traded price)", dist(s.vw)),
    f("vz", "Distance from VWAP in standard deviations", signed(s.vz, 1)),
    f("orh", "Opening-range high", dist(s.orh)),
    f("orl", "Opening-range low", dist(s.orl)),
    f("ors", "Opening range", OR_WORDS[s.ors]),
    f("pdh", "Previous day's high", dist(s.pdh)),
    f("pdl", "Previous day's low", dist(s.pdl)),
    f("pdc", "Previous day's close", dist(s.pdc)),
    f("rsi", "RSI (14): above 70 stretched up, below 30 stretched down", num(s.rsi)),
    f("adx", "ADX (14): above 20–25 means a trend", num(s.adx)),
    f("di", "+DI minus −DI (positive leans up)", signed(s.di, 0)),
    f("st", "Supertrend", s.st > 0 ? "up" : s.st < 0 ? "down" : "none"),
    f("rv", "Realized volatility over 2 hours (yearly %)", `${num(s.rv)}%`),
    f("atr", "Typical 5-minute range (ATR)", `${(s.atr / 100).toFixed(2)}% of the price`),
    f("vix", "India VIX (expected volatility)", unknownOr(s.vix, (v) => v.toFixed(1))),
    f("vixc", "India VIX change today", `${signed(s.vixc, 1)}%`),
  ];
  if (!s.o) out.push(f("o", "Option data", "missing (no entry without it)"));
  else {
    const o = s.o;
    out.push(
      f("o.k", "At-the-money strike", num(o.k)),
      f("o.cm", "Call price (mid)", unknownOr(o.cm, (v) => `₹${v.toFixed(1)}`)),
      f("o.cs", "Call bid-ask spread", unknownOr(o.cs, (v) => `${(v / 100).toFixed(2)}% of the price`)),
      f("o.pm", "Put price (mid)", unknownOr(o.pm, (v) => `₹${v.toFixed(1)}`)),
      f("o.ps", "Put bid-ask spread", unknownOr(o.ps, (v) => `${(v / 100).toFixed(2)}% of the price`)),
      f("o.iv", "Implied volatility at the money", unknownOr(o.iv, (v) => `${num(v)}%`)),
      f("o.ivx", "Implied volatility minus VIX (positive: options are dear)", unknownOr(o.ivx, (v) => signed(v, 1))),
      f("o.pcr", "Put-call ratio of open interest", unknownOr(o.pcr, (v) => v.toFixed(2))),
      f("o.mp", "Max pain within the ±15 monitored strikes", dist(o.mp)),
      f("o.cw", "Call wall (strike with the most call open interest)", dist(o.cw)),
      f("o.pw", "Put wall (strike with the most put open interest)", dist(o.pw)),
      f("o.bc", "Call strikes near the money in 5 min: long build-up / short build-up / short covering / long unwinding", counts(o.bc)),
      f("o.bp", "Put strikes near the money in 5 min: long build-up / short build-up / short covering / long unwinding", counts(o.bp)),
      f("o.oa", "Age of the option data at the close", `${num(o.oa)} s`),
    );
  }
  out.push(
    f("cv", "Engine conviction, −1 to +1 (it has no measured edge)", signed(s.cv, 2)),
    f("rg", "Engine regime", REGIME_WORDS[s.rg]),
    f("pv", "Today's plan", PLAN_WORDS[s.pv]),
    f("pn", "Plan rules", PLAN_RULES.map((r, i) => `${r} ${RULE_WORDS[s.pn[i] ?? "u"] ?? "unknown"}`).join(", ")),
    f("ew", "Inside the entry window", yesNo(s.ew)),
    f("dte", "Sessions to the contract's expiry", num(s.dte)),
    f("xd", "Expiry day for this index", yesNo(s.xd)),
    f("bk.pos", "Agent's position on this index", POS_WORDS[s.bk.pos]),
    f("bk.lots", "Lots held", num(s.bk.lots)),
    f("bk.pnl", "Open profit or loss (% of premium)", s.bk.pnl === null ? "flat" : `${signed(s.bk.pnl, 1)}%`),
    f("bk.dd", "Account drawdown from its peak", `${(s.bk.dd / 100).toFixed(2)}%`),
    f("bk.dl", "Today's loss used (% of equity)", `${(s.bk.dl / 100).toFixed(2)}%`),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Records → view parts
// ---------------------------------------------------------------------------

function decisionView(d: DecisionRecord): AgentDecisionView {
  const e = d.execution;
  return {
    id: d.id,
    barAt: istIso(d.barCloseMs),
    finalistId: d.finalistId,
    source: d.source,
    regime: d.regime,
    direction: d.direction,
    directionConfidence: d.directionConfidence,
    toxicFlow: d.toxicFlow,
    setupQuality: d.setupQuality,
    riskState: d.riskState,
    reason: d.reason,
    gate: e ? { fired: e.gate.fired, summary: gateSummaryWords(e.gate.lines, e.gate.fired), lines: e.gate.lines.map((l) => ({ gate: l.gate, passed: l.passed, words: gateWords(l) })) } : null,
    action: e?.action ?? null,
    actionDetail: e?.detail ?? null,
    edge: e?.edge ? { passed: e.edge.passed, detail: e.edge.rows.map((r) => `${r.label}: ${r.detail}`).join("; ") } : null,
    sizing: e?.sizing ? { p: e.sizing.p, b: e.sizing.b, kelly: e.sizing.kelly, riskPct: e.sizing.riskPct, lots: e.sizing.lots } : null,
    outcome: d.outcome ? { status: d.outcome.status, ret30Pct: d.outcome.ret30Pct } : { status: "PENDING", ret30Pct: null },
  };
}

function finalistView(f: Finalist): AgentFinalistView {
  return {
    id: f.id,
    kind: f.kind,
    index: f.index,
    label: f.label,
    side: f.side,
    contract: f.contract ? { tradingSymbol: f.contract.tradingSymbol, strike: f.contract.strike, optionType: f.contract.type, expiry: f.contract.expiry } : null,
    condition: f.condition,
    wrongIf: f.wrongIf,
    bearCase: f.bearCase,
    briefId: f.briefId,
  };
}

const latest = <T>(rows: readonly T[], at: (r: T) => number): T | null => rows.reduce<T | null>((best, r) => (best === null || at(r) > at(best) ? r : best), null);

/** Positions the agent entered that have no closed trade yet, per index (from the decisions' executions). */
function openEntries(decisions: readonly DecisionRecord[], trades: readonly AgentTradeRecord[], risk: AgentRiskSnapshot | null): Map<IndexId, DecisionRecord> {
  const closed = new Set(trades.map((t) => t.positionId));
  const out = new Map<IndexId, DecisionRecord>();
  if (risk && risk.openPositions === 0) return out;
  for (const d of decisions) {
    const e = d.execution;
    if (!e || e.action !== "ENTERED" || !e.positionId || closed.has(e.positionId)) continue;
    const cur = out.get(d.index);
    if (!cur || cur.barCloseMs < d.barCloseMs) out.set(d.index, d);
  }
  return out;
}

function indexCard(index: IndexId, a: AgentViewInput, okBatches: readonly ReflexBatch[], byId: Map<string, DecisionRecord>, open: Map<IndexId, DecisionRecord>): AgentIndexCardView {
  const bar = latest(
    a.bars.filter((b) => b.index === index),
    (b) => b.barCloseMs,
  );
  // The newest batch with decisions on this index; the stored rows carry what the code did with them.
  const batch = latest(
    okBatches.filter((b) => b.decisions.some((d) => d.index === index)),
    (b) => b.barCloseMs,
  );
  const decisions = (batch?.decisions ?? []).filter((d) => d.index === index).map((d) => decisionView(byId.get(d.id) ?? d));
  const entry = open.get(index);
  const side = entry && entry.direction !== "NEUTRAL" ? entry.direction : null;
  const bk = bar?.snapshot?.bk;
  return {
    index,
    barAt: bar ? istIso(bar.barCloseMs) : null,
    close: bar ? bar.close : null,
    snapshot: bar?.snapshot ? snapshotFields(bar.snapshot) : null,
    snapshotTokensEst: bar?.tokensEst ?? null,
    decisions,
    position:
      entry && side && entry.execution
        ? {
            side,
            tradingSymbol: entry.execution.tradingSymbol ?? "",
            lots: entry.execution.sizing?.lots ?? bk?.lots ?? 0,
            pnlPct: bk && bk.pos === (side === "LONG" ? "L" : "S") ? bk.pnl : null,
            finalistId: entry.finalistId,
          }
        : null,
  };
}

function escalationView(e: EscalationRecord, calls: ReadonlyMap<string, CallRecord>): AgentEscalationView {
  const d = e.decision;
  return {
    id: e.id,
    requestedAt: istIso(e.requestedMs),
    index: e.index,
    finalistId: e.finalistId,
    trigger: e.trigger,
    status: e.status,
    decision: d ? { direction: d.direction, directionConfidence: d.directionConfidence, setupQuality: d.setupQuality, regime: d.regime, riskState: d.riskState, reason: d.reason } : null,
    reason: e.reason,
    appliedToBarAt: iso(e.appliedBarMs),
    costUsd: e.callId ? (calls.get(e.callId)?.costUsd ?? null) : null,
  };
}

function riskView(r: AgentRiskSnapshot | null): AgentRiskView {
  return {
    asOf: r ? istIso(r.t) : null,
    equity: r?.equity ?? null,
    peakEquity: r?.peakEquity ?? null,
    drawdownPct: r ? round(r.ddPct, 2) : null,
    maxDrawdownPct: AGENT_LIMITS.maxDrawdownPct,
    dayLossPct: r ? round(r.dayLossPct, 2) : null,
    dailyLossCapPct: AGENT_LIMITS.dailyLossCapPct,
    openPositions: r?.openPositions ?? 0,
    maxOpenPositions: AGENT_LIMITS.maxOpenTotal,
    maxLotsPerPosition: AGENT_LIMITS.maxLotsPerPosition,
    killSwitch: r?.killSwitch ?? false,
    killReason: r?.killReason ?? null,
    mainKillSwitch: r?.mainKillSwitch ?? false,
    drawdownHalt: r?.ddHalt ?? false,
    codeRiskState: r?.codeRisk ?? "SAFE",
  };
}

function calibrationNote(c: CalibrationSummary | null, payoff: AgentViewInput["payoff"]): string {
  const parts: string[] = [];
  if (!c || c.graded === 0) parts.push("No graded calls yet: the first scores appear after the review that runs after the close.");
  else
    parts.push(
      `${c.graded} calls graded. Brier score: lower is better; always forecasting the observed hit rate scores ${c.baselineBrier === null ? "—" : c.baselineBrier.toFixed(3)}, so the model shows skill only below that.`,
    );
  parts.push(
    "A call is a hit when the index moves at least 0.03% its way in 30 minutes. Sizing uses only a cautious estimate of a 0.15% move (enough to pay for an option), never the model's own number; at or below 50% the agent does not trade.",
  );
  if (payoff.n < 30) parts.push(`The payoff ratio is capped at 1 until 30 agent trades have closed (${payoff.n} so far).`);
  return parts.join(" ");
}

function calibrationView(c: CalibrationSummary | null, payoff: AgentViewInput["payoff"], trades: readonly AgentTradeRecord[]): AgentCalibrationView {
  return {
    asOf: c ? istIso(c.asOfMs) : null,
    graded: c?.graded ?? 0,
    brier: c?.brier ?? null,
    baselineBrier: c?.baselineBrier ?? null,
    byIndex: c?.byIndex ?? [],
    byKind: c?.byKind ?? [],
    bySource: c?.bySource ?? [],
    neutral: c?.neutral ?? { n: 0, brier: null, baselineBrier: null },
    buckets: (c?.buckets ?? []).map((b) => ({ from: b.from, to: Math.min(1, b.to), n: b.n, statedMean: b.statedMean, hitRate: b.hitRate, paidRate: b.paidRate })),
    sizingMode: c?.sizingMode ?? "pooled",
    sizingP: c?.sizingP ?? null,
    sizingN: c?.sizingN ?? 0,
    payoffB: payoff.b,
    payoffMeasured: payoff.measured,
    payoffTrades: payoff.n,
    paidRate: c?.paidRate ?? null,
    trades: { n: trades.length, wins: trades.filter((t) => t.pnlRupees > 0).length, netRupees: round(trades.reduce((s, t) => s + t.pnlRupees, 0), 2) },
    note: calibrationNote(c, payoff),
  };
}

function reviewView(r: ReviewRecord | null, costUsd: number | null): AgentReviewView | null {
  if (!r) return null;
  return {
    date: r.date,
    status: r.status,
    writtenAt: iso(r.doneMs),
    model: r.model,
    costUsd,
    summary: r.report?.summary ?? "",
    fills: r.report?.fills ?? [],
    misses: r.report?.misses ?? [],
    mistakes: r.report?.mistakes ?? [],
    lessons: r.report?.lessons ?? [],
    error: r.error,
  };
}

function candidateView(c: CandidateRecord | null, currentGuidance: string): AgentCandidateView | null {
  if (!c) return null;
  const r = c.replay;
  return {
    id: c.id,
    date: c.date,
    createdAt: istIso(c.createdMs),
    status: c.status,
    baseVersion: c.baseVersion,
    guidance: c.guidance,
    currentGuidance,
    rationale: c.rationale,
    wouldBeWrongIf: c.wouldBeWrongIf,
    replay: r
      ? {
          bars: r.bars,
          graded: r.graded,
          brierCandidate: r.brierCandidate,
          brierCurrentReplayed: r.brierCurrentReplayed,
          brierCurrentLive: r.brierCurrentLive,
          firesCandidate: r.firesCandidate,
          firesCurrent: r.firesCurrent,
          complete: r.complete,
          label: r.label,
        }
      : null,
    decidedAt: iso(c.decidedMs),
    decidedBy: c.decidedBy,
  };
}

function costView(date: string, calls: readonly CallRecord[], capUsd: number, batches: readonly ReflexBatch[]): AgentCostView {
  const spent = calls.reduce((s, c) => s + c.costUsd, 0);
  const latencies = calls
    .filter((c) => c.kind === "REFLEX" && c.latencyMs !== null)
    .map((c) => c.latencyMs as number)
    .sort((x, y) => x - y);
  const capHit = spent >= capUsd - 1e-9 || calls.some((c) => c.status === "SKIPPED_CAP") || batches.some((b) => b.status === "COST_CAP");
  return {
    date,
    spentUsd: round(spent, 6),
    capUsd,
    capReached: capHit,
    byKind: CALL_KINDS.map((kind) => {
      const mine = calls.filter((c) => c.kind === kind);
      return { kind, calls: mine.length, usd: round(mine.reduce((s, c) => s + c.costUsd, 0), 6) };
    }),
    reflexLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

function statusOf(a: AgentViewInput, newestBatch: ReflexBatch | null, cost: AgentCostView): AgentView["status"] {
  const newestBar = latest(a.bars, (b) => b.barCloseMs);
  const lastBarMs = Math.max(newestBatch?.barCloseMs ?? -Infinity, newestBar?.barCloseMs ?? -Infinity);
  const lastBarAt = Number.isFinite(lastBarMs) ? istIso(lastBarMs) : null;
  const failed = newestBatch?.status === "FAILED" ? (newestBatch.error ?? "the model call failed") : null;
  const today = a.date === istDate(a.nowMs);
  let state: AgentView["status"]["state"];
  if (!a.enabled || a.settings.mode === "off") state = "OFF";
  else if (today && cost.capReached) state = "COST_CAP";
  else if (!today || a.calendar.sessionPhase(a.nowMs) !== "OPEN") state = "CLOSED";
  else if (failed) state = "ERROR";
  // A stored bar newer than the newest batch: its reflex job has not finished.
  else if (newestBar && (!newestBatch || newestBar.barCloseMs > newestBatch.barCloseMs)) state = "RUNNING";
  else state = "WAITING";
  return { state, lastBarAt, lastError: failed, paused: a.paused };
}

/** The whole Agent page for one IST date. */
export function buildAgentView(a: AgentViewInput): AgentView {
  const byId = new Map(a.decisions.map((d) => [d.id, d] as const));
  const callsById = new Map(a.calls.map((c) => [c.id, c] as const));
  const okBatches = a.batches.filter((b) => b.status === "OK");
  const newestBatch = latest(a.batches, (b) => b.barCloseMs);
  const finalistsFrom = latest(okBatches, (b) => b.barCloseMs) ?? newestBatch;
  const open = openEntries(a.decisions, a.trades, a.risk);
  const cost = costView(a.date, a.calls, a.settings.dailyUsdCap, a.batches);
  return {
    mode: a.settings.mode,
    enabled: a.enabled,
    date: a.date,
    generatedAt: istIso(a.nowMs),
    honesty: AGENT_HONESTY,
    account: a.account,
    models: { reflex: a.settings.reflexModel, escalation: a.settings.escalationModel, review: a.settings.reviewModel },
    instructionVersion: a.instruction?.version ?? BUILTIN_LABEL,
    status: statusOf(a, newestBatch, cost),
    indices: AGENT_INDICES.map((index) => indexCard(index, a, okBatches, byId, open)),
    finalists: (finalistsFrom?.finalists ?? []).map(finalistView),
    escalations: a.escalations.map((e) => escalationView(e, callsById)),
    risk: riskView(a.risk),
    calibration: calibrationView(a.calibration, a.payoff, a.trades),
    review: reviewView(a.review, a.reviewCostUsd),
    candidate: candidateView(a.candidate, a.baseGuidance),
    cost,
  };
}

/** The view before anything ran (or when the agent account is not enabled). */
export function emptyAgentView(nowMs: number, settings: AgentSettings, enabled: boolean, account: AccountView | null): AgentView {
  return buildAgentView({
    date: istDate(nowMs),
    nowMs,
    settings,
    enabled,
    paused: false,
    account,
    instruction: null,
    bars: [],
    batches: [],
    decisions: [],
    escalations: [],
    risk: null,
    calibration: null,
    payoff: { b: 1, n: 0, measured: null },
    trades: [],
    review: null,
    reviewCostUsd: null,
    candidate: null,
    baseGuidance: "",
    calls: [],
    calendar: defaultCalendar,
  });
}

/** Overlays the live kill switches (the agent account's and main's) on a view. */
export function withAccountSettings(v: AgentView, agent: Pick<EngineSettings, "killSwitch" | "killReason">, main: Pick<EngineSettings, "killSwitch">): AgentView {
  return { ...v, risk: { ...v.risk, killSwitch: agent.killSwitch, killReason: agent.killSwitch ? agent.killReason : null, mainKillSwitch: main.killSwitch } };
}
