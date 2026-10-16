/**
 * The code gate and the agent's decision exits (SPEC §5.1, §5.7, as amended). The model only judges: every
 * threshold here is a code constant (constants.ts), every gate line is recorded with the decision, and nothing
 * the model returns can loosen one. The snapshot's option spreads (cs, ps) are percent of the mid and its option age
 * (oa) is seconds, as snapshot.ts writes them (only returns and distances are basis points).
 */
import type { Quote } from "../types";
import { AGENT_LIMITS, AGENT_POLICY } from "./constants";
import type {
  AgentExitReason,
  AgentPositionTag,
  AgentRiskLevel,
  AgentRiskSnapshot,
  BatchStatus,
  DecisionRecord,
  Finalist,
  GateLine,
  GateVerdict,
  IndexSnapshot,
  ReflexDecision,
} from "./types";

/** Comparisons at a limit allow for floating-point noise (0.8 × 3 is 2.4000000000000004). */
const EPS = 1e-9;

/** Plain-English names of the code gate's lines, in the order they are checked. */
export const GATE_LABELS = {
  fresh: "Fresh decision",
  batch_ok: "Reflex call succeeded",
  setup_quality: "Setup quality",
  confidence: "Confidence",
  direction: "Direction",
  regime: "Regime",
  idea_side: "Idea's side",
  toxic_model: "Option flow (model)",
  toxic_code: "Option data (code)",
  risk_state: "Risk state",
  entry_mode: "Entries allowed",
} as const;

const RISK_RANK: Record<AgentRiskLevel, number> = { SAFE: 0, NEAR_LIMIT: 1, REDUCE: 2 };
/** An unknown level counts as REDUCE. */
const rank = (r: AgentRiskLevel) => RISK_RANK[r] ?? 2;

/** The stricter of two risk levels (SAFE < NEAR_LIMIT < REDUCE). */
export function stricterRisk(a: AgentRiskLevel, b: AgentRiskLevel): AgentRiskLevel {
  const k = Math.max(rank(a), rank(b));
  return k >= 2 ? "REDUCE" : k === 1 ? "NEAR_LIMIT" : "SAFE";
}

/** x ≥ limit, allowing for float noise; a value that is not a number counts as at the limit (fail closed). */
const atLeast = (x: number, limit: number) => !(x < limit - EPS);
const num = (x: number, digits = 2) => (Number.isFinite(x) ? String(Number(x.toFixed(digits))) : "unknown");
const pct = (x: number) => `${num(x)}%`;

function ageWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/** The option the decision would buy: an idea's own side, else the call's direction; null for NEUTRAL. */
export function buySide(d: Pick<ReflexDecision, "direction">, f: Pick<Finalist, "kind" | "side">): "LONG" | "SHORT" | null {
  if (f.kind === "IDEA") return f.side;
  return d.direction === "LONG" || d.direction === "SHORT" ? d.direction : null;
}

/**
 * The code's own toxicity flags on the snapshot: NO_OPTION_DATA (no snapshot or option block), STALE_OPTIONS (option
 * data older than AGENT_POLICY.maxOptionAgeSec at the close) and WIDE_SPREAD (the spread of the option to buy is
 * unknown or above AGENT_POLICY.maxSnapshotSpreadPct; both options are checked when there is no side).
 */
export function codeToxicity(s: IndexSnapshot | null, side: "LONG" | "SHORT" | null): string[] {
  if (s == null || s.o == null) return ["NO_OPTION_DATA"];
  const flags: string[] = [];
  if (!(s.o.oa <= AGENT_POLICY.maxOptionAgeSec)) flags.push("STALE_OPTIONS");
  const spreads = side === "LONG" ? [s.o.cs] : side === "SHORT" ? [s.o.ps] : [s.o.cs, s.o.ps];
  if (spreads.some((x) => x === null || !(x >= 0 && x <= AGENT_POLICY.maxSnapshotSpreadPct))) flags.push("WIDE_SPREAD");
  return flags;
}

const qty = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);

/**
 * Quantities on each side of the live quote: a side's summed depth levels when the quote lists any, else that side's
 * top-of-book quantity.
 */
export function bookQuantities(q: Quote): { bid: number; ask: number; from: "depth" | "top" } {
  const sum = (levels: { qty: number }[] | undefined, top: number) => (levels && levels.length > 0 ? levels.reduce((s, l) => s + qty(l.qty), 0) : qty(top));
  const bid = sum(q.depth?.buy, q.bidQty);
  const ask = sum(q.depth?.sell, q.askQty);
  return { bid, ask, from: (q.depth?.buy.length ?? 0) + (q.depth?.sell.length ?? 0) > 0 ? "depth" : "top" };
}

/** |bid − ask| / (bid + ask) over bookQuantities; null when the book shows no quantity. */
export function quoteImbalance(q: Quote): number | null {
  const { bid, ask } = bookQuantities(q);
  return bid + ask > 0 ? Math.abs(bid - ask) / (bid + ask) : null;
}

/**
 * Flags on the live quote that block an entry (after planning): NO_QUOTE, SYNTHETIC_QUOTE (a model price, unless
 * acceptSyntheticQuotes, which only tests set) and NO_DEPTH (no quantity on either side). A one-sided book is
 * information only (#27) and never appears here: quoteGateLines records it with passed null.
 */
export function quoteToxicity(q: Quote | null, opts: { acceptSyntheticQuotes?: boolean } = {}): string[] {
  if (q == null) return ["NO_QUOTE"];
  const flags: string[] = [];
  if (q.source === "synthetic" && !opts.acceptSyntheticQuotes) flags.push("SYNTHETIC_QUOTE");
  const { bid, ask } = bookQuantities(q);
  if (!(bid + ask > 0)) flags.push("NO_DEPTH");
  return flags;
}

const QUOTE_FLAG_WORDS: Record<string, string> = {
  NO_QUOTE: "no live quote",
  SYNTHETIC_QUOTE: "the quote is a model price, not the market's",
  NO_DEPTH: "no quantity bid or offered",
};

/**
 * The live-quote checks as gate lines: `quote_toxic` blocks on any quoteToxicity flag; `one_sided_book` is
 * information only (passed null) until recorded quotes show what imbalance matters.
 */
export function quoteGateLines(q: Quote | null, opts: { acceptSyntheticQuotes?: boolean } = {}): GateLine[] {
  const flags = quoteToxicity(q, opts);
  const toxic: GateLine = {
    gate: "quote_toxic",
    passed: flags.length === 0,
    detail: flags.length === 0 && q ? `Live quote usable (${q.source} bid ${q.bid} / ask ${q.ask})` : `Live quote not usable: ${flags.map((f) => QUOTE_FLAG_WORDS[f] ?? f).join("; ")}`,
  };
  if (q == null) return [toxic, { gate: "one_sided_book", passed: null, detail: "Information only: no quote" }];
  const { bid, ask, from } = bookQuantities(q);
  const imb = quoteImbalance(q);
  const where = from === "depth" ? "summed depth" : "top of book";
  const lopsided = imb !== null && imb > AGENT_POLICY.oneSidedBookImbalance;
  const detail =
    imb === null
      ? "Information only: the book shows no quantity"
      : `Information only: ${lopsided ? "one-sided book" : "book balance"} ${num(imb)} (${bid} bid vs ${ask} offered, ${where}; ` +
        `${AGENT_POLICY.oneSidedBookImbalance} would count as one-sided)`;
  return [toxic, { gate: "one_sided_book", passed: null, detail }];
}

interface RiskAssessment {
  level: AgentRiskLevel;
  why: string[];
}

/** The code's own risk level with its reasons (codeRiskState). */
export function codeRiskAssessment(r: AgentRiskSnapshot, openOnIndex: number, entriesToday: number, maxTradesPerDay: number): RiskAssessment {
  const L = AGENT_LIMITS;
  const reduceLoss = L.reduceDayLossFrac * L.dailyLossCapPct;
  const reduce: string[] = [];
  if (atLeast(r.ddPct, L.reduceDrawdownPct)) reduce.push(`drawdown ${pct(r.ddPct)} (reduce from ${L.reduceDrawdownPct}%)`);
  if (atLeast(r.dayLossPct, reduceLoss)) reduce.push(`today's loss ${pct(r.dayLossPct)} of equity (reduce from ${num(reduceLoss)}%)`);
  if (reduce.length > 0) return { level: "REDUCE", why: reduce };
  const nearLoss = L.nearDayLossFrac * L.dailyLossCapPct;
  const near: string[] = [];
  if (atLeast(r.ddPct, L.nearDrawdownPct)) near.push(`drawdown ${pct(r.ddPct)} (near from ${L.nearDrawdownPct}%)`);
  if (atLeast(r.dayLossPct, nearLoss)) near.push(`today's loss ${pct(r.dayLossPct)} of equity (near from ${num(nearLoss)}%)`);
  if (!(r.openPositions < L.maxOpenTotal)) near.push(`${r.openPositions} positions open (at most ${L.maxOpenTotal})`);
  if (!(openOnIndex < L.maxOpenPerIndex)) near.push("a position is already open on this index");
  if (!(entriesToday < maxTradesPerDay - 1)) near.push(`${entriesToday} entries today (at most ${maxTradesPerDay})`);
  return near.length > 0 ? { level: "NEAR_LIMIT", why: near } : { level: "SAFE", why: [] };
}

/**
 * The code's own risk state: REDUCE from a drawdown of AGENT_LIMITS.reduceDrawdownPct or a day's loss of
 * reduceDayLossFrac × the daily cap; otherwise NEAR_LIMIT from nearDrawdownPct, nearDayLossFrac × the cap, the
 * positions limit, a position already open on the index, or one entry short of the day's trades; otherwise SAFE.
 */
export function codeRiskState(r: AgentRiskSnapshot, openOnIndex: number, entriesToday: number, maxTradesPerDay: number): AgentRiskLevel {
  return codeRiskAssessment(r, openOnIndex, entriesToday, maxTradesPerDay).level;
}

/** A codeToxicity flag in plain English. */
function toxicWords(s: IndexSnapshot | null, side: "LONG" | "SHORT" | null, flag: string): string {
  const spread = (x: number | null, which: string) => `${which} spread ${x === null ? "unknown" : `${num(x)}%`}`;
  if (flag === "NO_OPTION_DATA") return "no option data in the snapshot";
  if (flag === "STALE_OPTIONS") return `option data ${num(s?.o?.oa ?? NaN, 0)} s old at the close (limit ${AGENT_POLICY.maxOptionAgeSec} s)`;
  if (flag === "WIDE_SPREAD") {
    const o = s?.o;
    const parts = side === "LONG" ? [spread(o?.cs ?? null, "call")] : side === "SHORT" ? [spread(o?.ps ?? null, "put")] : [spread(o?.cs ?? null, "call"), spread(o?.ps ?? null, "put")];
    return `${parts.join(", ")} (limit ${AGENT_POLICY.maxSnapshotSpreadPct}%)`;
  }
  return flag;
}

/**
 * The model-side lines of the gate, shared by codeGate and the replay's modelFires: setup quality, confidence,
 * direction, regime, the idea's side, the model's toxicity flag and the code's toxicity flags on the snapshot.
 */
export function modelGateLines(d: ReflexDecision, f: Finalist, s: IndexSnapshot | null): GateLine[] {
  const P = AGENT_POLICY;
  const side = buySide(d, f);
  const toxic = codeToxicity(s, side);
  const c = d.directionConfidence;
  const confOk = Number.isFinite(c) && c > P.minConfidenceExclusive && c <= 1;
  const dirWords = d.direction === "LONG" ? "LONG: buy a call" : d.direction === "SHORT" ? "SHORT: buy a put" : `${d.direction}: no trade`;
  let ideaSide: GateLine;
  if (f.kind !== "IDEA") ideaSide = { gate: "idea_side", passed: true, detail: "Generic finalist: either side" };
  else if (f.side === null) ideaSide = { gate: "idea_side", passed: false, detail: "The idea has no side" };
  else if (d.direction === f.side) ideaSide = { gate: "idea_side", passed: true, detail: `The idea and the call are both ${f.side}` };
  else ideaSide = { gate: "idea_side", passed: false, detail: `The idea is ${f.side} but the call is ${d.direction}` };
  const o = s?.o ?? null;
  const toxicOk = toxic.length === 0;
  const spreadNow = side === "LONG" ? o?.cs : side === "SHORT" ? o?.ps : null;
  return [
    { gate: "setup_quality", passed: d.setupQuality >= P.minSetupQuality, detail: `Setup quality ${d.setupQuality} of 3 (needs ${P.minSetupQuality})` },
    { gate: "confidence", passed: confOk, detail: `Confidence ${num(c, 6)} (needs above ${P.minConfidenceExclusive.toFixed(2)})` },
    { gate: "direction", passed: d.direction === "LONG" || d.direction === "SHORT", detail: `Direction ${dirWords}` },
    { gate: "regime", passed: d.regime !== "CRISIS", detail: d.regime === "CRISIS" ? "Regime CRISIS: no new trades" : `Regime ${d.regime}` },
    ideaSide,
    {
      gate: "toxic_model",
      passed: d.toxicFlow === false,
      detail: d.toxicFlow === false ? "The model saw no hostile option flow" : "The model flagged the option flow as hostile to a buyer",
    },
    {
      gate: "toxic_code",
      passed: toxicOk,
      detail: toxicOk
        ? `Option data ${o?.oa ?? "?"} s old${typeof spreadNow === "number" ? `, spread ${num(spreadNow)}%` : ""} (limits ${P.maxOptionAgeSec} s, ${P.maxSnapshotSpreadPct}%)`
        : `Option data not usable: ${toxic.map((t) => toxicWords(s, side, t)).join("; ")}`,
    },
  ];
}

/** The gate's context beyond the decision: the clock, the book on this index and the tick's entry mode. */
export interface GateContext {
  nowMs: number;
  /** Agent positions (and working entry orders) open on the decision's index. */
  openOnIndex: number;
  entriesToday: number;
  maxTradesPerDay: number;
  /** The batch's status. Only an OK batch carries decisions, so it defaults to OK. */
  batchStatus?: BatchStatus;
  /** Why no entries are allowed on this tick (main degraded), or null. */
  noEntries?: string | null;
}

/**
 * The code gate (SPEC §5.1), every line recorded in order: fresh, batch_ok, setup_quality, confidence (strictly
 * above 0.80), direction, regime, idea_side, toxic_model, toxic_code, risk_state (the stricter of the model's and
 * the code's must be SAFE) and entry_mode (main not degraded, no drawdown halt, no kill switch). It fires only when
 * every line passes.
 */
export function codeGate(d: DecisionRecord, f: Finalist, s: IndexSnapshot | null, risk: AgentRiskSnapshot, ctx: GateContext): GateVerdict {
  const P = AGENT_POLICY;
  const age = ctx.nowMs - d.barCloseMs;
  const fresh: GateLine = {
    gate: "fresh",
    passed: age >= 0 && age <= P.maxDecisionAgeMs,
    detail:
      age < 0
        ? "The candle closes after now (clock error)"
        : age <= P.maxDecisionAgeMs
          ? `Decided ${ageWords(age)} after the candle closed (limit ${ageWords(P.maxDecisionAgeMs)})`
          : `Too old: ${ageWords(age)} after the candle closed (limit ${ageWords(P.maxDecisionAgeMs)})`,
  };
  const status = ctx.batchStatus ?? "OK";
  let batch: GateLine;
  if (status !== "OK") batch = { gate: "batch_ok", passed: false, detail: `The reflex call for this candle did not succeed (${status})` };
  else if (d.finalistId !== f.id || d.index !== f.index) batch = { gate: "batch_ok", passed: false, detail: `The decision is for ${d.finalistId} on ${d.index}, not ${f.id}` };
  else if (!d.effective) batch = { gate: "batch_ok", passed: false, detail: "Not the decision in force for this candle" };
  else batch = { gate: "batch_ok", passed: true, detail: d.source === "ESCALATION" ? "The escalation's answer is in force for this candle" : "The reflex call succeeded" };

  const assessed = codeRiskAssessment(risk, ctx.openOnIndex, ctx.entriesToday, ctx.maxTradesPerDay);
  const effectiveRisk = stricterRisk(d.riskState, assessed.level);
  const riskLine: GateLine = {
    gate: "risk_state",
    passed: effectiveRisk === "SAFE",
    detail: `Risk ${effectiveRisk} (model ${d.riskState}, code ${assessed.level}${assessed.why.length > 0 ? `: ${assessed.why.join("; ")}` : ""})`,
  };
  const blocks: string[] = [];
  if (ctx.noEntries) blocks.push(`no entries this tick: ${ctx.noEntries}`);
  if (risk.ddHalt) blocks.push(`drawdown halt (${AGENT_LIMITS.maxDrawdownPct}%): re-arm on the Agent page`);
  if (risk.killSwitch) blocks.push(`agent kill switch engaged${risk.killReason ? ` (${risk.killReason})` : ""}`);
  if (risk.mainKillSwitch) blocks.push("main kill switch engaged");
  const entryMode: GateLine = { gate: "entry_mode", passed: blocks.length === 0, detail: blocks.length === 0 ? "Entries allowed" : `Entries off: ${blocks.join("; ")}` };

  const lines = [fresh, batch, ...modelGateLines(d, f, s), riskLine, entryMode];
  return {
    fired: lines.every((l) => l.passed === true),
    lines,
    codeToxic: codeToxicity(s, buySide(d, f)),
    codeRisk: assessed.level,
    effectiveRisk,
  };
}

/** One line for the record: "Fired: …" or the failing lines' details. */
export function gateSummary(v: GateVerdict): string {
  if (v.fired) return `Fired: all ${v.lines.length} checks passed`;
  const failed = v.lines.filter((l) => l.passed !== true && l.passed !== null);
  if (failed.length === 0) return "Not fired: a check could not be evaluated";
  const shown = failed.slice(0, 3).map((l) => l.detail);
  return `Blocked: ${shown.join("; ")}${failed.length > 3 ? ` (and ${failed.length - 3} more)` : ""}`;
}

/**
 * Exits from a new batch of decisions (SPEC §5.7), first match wins:
 * 1. AGENT_CRISIS: a decision on the position's index calls the regime CRISIS;
 * 2. AGENT_REDUCE: the code's risk is REDUCE, or the position's own finalist's risk (the stricter of the model's
 *    and the code's) is REDUCE;
 * 3. AGENT_OPPOSITE: a decision on the index calls the opposite direction with confidence above 0.80.
 * `effective` is the batch's decisions in force plus its exit-only escalations. When the position's finalist has no
 * decision (the brief changed), rules 1 and 3 still apply through the index's other decisions.
 */
export function agentExitTriggers(
  tag: AgentPositionTag,
  effective: DecisionRecord[],
  codeRisk: AgentRiskLevel,
): { reason: AgentExitReason; decisionId: string | null; detail: string } | null {
  const onIndex = effective.filter((d) => d.index === tag.index);
  const own = onIndex.find((d) => d.finalistId === tag.finalistId);
  const crisis = (own && own.regime === "CRISIS" ? own : undefined) ?? onIndex.find((d) => d.regime === "CRISIS");
  if (crisis) return { reason: "AGENT_CRISIS", decisionId: crisis.id, detail: `${crisis.finalistId} calls a CRISIS regime on ${tag.index}` };
  if (codeRisk === "REDUCE") return { reason: "AGENT_REDUCE", decisionId: own?.id ?? null, detail: "the code's risk state is REDUCE (drawdown or today's loss near its limit)" };
  if (own && stricterRisk(own.riskState, codeRisk) === "REDUCE") return { reason: "AGENT_REDUCE", decisionId: own.id, detail: `${own.finalistId} sets risk to REDUCE` };
  const opposite = tag.side === "LONG" ? "SHORT" : "LONG";
  const against = onIndex
    .filter((d) => d.direction === opposite && Number.isFinite(d.directionConfidence) && d.directionConfidence > AGENT_POLICY.oppositeExitConfidenceExclusive)
    .sort((a, b) => b.directionConfidence - a.directionConfidence)[0];
  if (against) {
    return {
      reason: "AGENT_OPPOSITE",
      decisionId: against.id,
      detail: `${against.finalistId} calls ${opposite} with confidence ${num(against.directionConfidence, 6)} (above ${AGENT_POLICY.oppositeExitConfidenceExclusive.toFixed(2)})`,
    };
  }
  return null;
}
