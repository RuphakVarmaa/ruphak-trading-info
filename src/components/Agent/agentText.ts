/**
 * Pure text helpers for the Agent page: plain words for the model's calls, the code's gate, sizing, actions,
 * outcomes, risk, modes and costs, and how far calibration is from letting sizing move. No React, so the
 * wording is unit-tested (agentText.test.ts). Thresholds come from the agent's constants, so the words cannot
 * drift from what the code enforces.
 */
import type {
  AgentAction,
  AgentCalibrationView,
  AgentCandidateView,
  AgentCostView,
  AgentDecisionView,
  AgentDirection,
  AgentEscalationView,
  AgentGateLineView,
  AgentIndexCardView,
  AgentMode,
  AgentRegime,
  AgentReviewView,
  AgentRiskLevel,
  AgentView,
} from "@/engine/api-types";
import { AGENT_LIMITS, AGENT_POLICY, CALIBRATION, ESCALATION, SNAPSHOT_TOKEN_LIMIT } from "@/engine/agent/constants";
import { modelName } from "@/components/Advisor/advisorText";
import { fmtIstDay, fmtIstHm, fmtPct, fmtSigned } from "@/components/shared/format";
import { istDate } from "@/lib/ist";

// ---------------------------------------------------------------------------
// The model's call
// ---------------------------------------------------------------------------

export const DIRECTION_META: Record<AgentDirection, { glyph: string; word: string; trade: string }> = {
  LONG: { glyph: "▲", word: "Up", trade: "buy a call (CE)" },
  SHORT: { glyph: "▼", word: "Down", trade: "buy a put (PE)" },
  NEUTRAL: { glyph: "▬", word: "No direction", trade: "no trade" },
};

/** "Up: buy a call (CE)", "Down: buy a put (PE)", "No direction: no trade". */
export function directionWords(d: AgentDirection): string {
  const m = DIRECTION_META[d];
  return `${m.word}: ${m.trade}`;
}

export const REGIME_WORDS: Record<AgentRegime, string> = {
  TRENDING: "Trending",
  MEAN_REVERTING: "Swinging back and forth",
  HIGH_VOL: "High volatility",
  CRISIS: "Crisis",
};

/** "Safe", "Near a limit", "Reduce: close positions". */
export function riskWords(r: AgentRiskLevel): string {
  if (r === "SAFE") return "Safe";
  if (r === "NEAR_LIMIT") return "Near a limit";
  return "Reduce: close positions";
}

/** A confidence or probability as two decimals ("0.86"). */
export function prob(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Mode, status and models
// ---------------------------------------------------------------------------

/** The mode's name and what it means. */
export function modeWords(m: AgentMode): { label: string; detail: string } {
  if (m === "shadow")
    return {
      label: "Shadow",
      detail: "The model judges every candle and the code checks each decision, but no order is placed: the actions say what paper mode would have done.",
    };
  if (m === "paper") return { label: "Paper", detail: "Orders go to the agent's own paper account: simulated fills, never real money." };
  return { label: "Off", detail: "The agent is switched off: no candle is judged and no order is placed." };
}

/** What the agent is doing now. */
export function stateWords(s: AgentView["status"]["state"]): string {
  switch (s) {
    case "OFF":
      return "Switched off";
    case "CLOSED":
      return `Not judging now: candles are judged from ${AGENT_POLICY.reflexFirstBarIst} to ${AGENT_POLICY.reflexLastBarIst} IST on trading days`;
    case "WAITING":
      return "Waiting for the next candle";
    case "RUNNING":
      return "Judging each 5-minute candle";
    case "COST_CAP":
      return "Stopped for today: the cost cap is reached, so no new entries";
    case "ERROR":
      return "Error: no new entries until it clears";
  }
}

/** A model id as people read it (the Advisor page's naming); other names are kept as they are. */
export function modelWords(model: string): string {
  return modelName(model);
}

/** One model for everything ("Model: demo (no model call)"), or which model does what. */
export function modelsWords(m: AgentView["models"]): string {
  const [r, e, v] = [modelWords(m.reflex), modelWords(m.escalation), modelWords(m.review)];
  if (r === e && e === v) return `Model: ${r}`;
  return `Each candle: ${r} · escalations: ${e} · nightly review: ${v}`;
}

// ---------------------------------------------------------------------------
// Money, percent and time
// ---------------------------------------------------------------------------

/** "$0.42", "under $0.01", "$0.00"; "—" when unknown. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "under $0.01";
  return `$${n.toFixed(2)}`;
}

/** "1.25%", or "+0.12%" with `sign`; "—" when unknown. */
export function pct(n: number | null | undefined, decimals = 2, sign = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return fmtPct(n, decimals, sign);
}

/** "11:40 IST"; "—" without a time. */
export function istTime(iso: string | null | undefined): string {
  return iso ? `${fmtIstHm(iso)} IST` : "—";
}

/** "11:40 IST" on the reference's IST day, else "Thu 15 Oct, 16:23 IST". */
export function dayTime(iso: string | null | undefined, refIso: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  const ref = Date.parse(refIso);
  if (!Number.isFinite(ms)) return "—";
  return Number.isFinite(ref) && istDate(ms) === istDate(ref) ? `${fmtIstHm(ms)} IST` : `${fmtIstDay(ms)}, ${fmtIstHm(ms)} IST`;
}

// ---------------------------------------------------------------------------
// The code's gate, sizing, action and outcome
// ---------------------------------------------------------------------------

/** Gate lines split into what blocked, what passed and what is recorded for information only. */
export function gateGroups(lines: readonly AgentGateLineView[]): { blocked: AgentGateLineView[]; passed: AgentGateLineView[]; info: AgentGateLineView[] } {
  return {
    blocked: lines.filter((l) => l.passed === false),
    passed: lines.filter((l) => l.passed === true),
    info: lines.filter((l) => l.passed === null),
  };
}

/** The gate's verdict in one line. */
export function gateHeadline(gate: AgentDecisionView["gate"]): { tone: "fired" | "blocked" | "pending"; words: string } {
  if (!gate) return { tone: "pending", words: "Not checked yet: the code runs its checks when the engine acts on this candle." };
  const { blocked, passed } = gateGroups(gate.lines);
  const total = blocked.length + passed.length;
  if (gate.fired) return { tone: "fired", words: total > 0 ? `All ${total} checks passed` : "Every check passed" };
  if (blocked.length === 0) return { tone: "blocked", words: gate.summary || "Blocked" };
  return { tone: "blocked", words: `Blocked by ${blocked.length} of ${total} check${total === 1 ? "" : "s"}` };
}

/** Kelly is above zero only when p > 1 / (1 + b): the chance sizing needs before any trade. */
export function breakEvenP(b: number): number {
  return b > 0 && Number.isFinite(b) ? 1 / (1 + b) : 1;
}

/**
 * Sizing in words: a short headline and the working. Risk 0 reads "no measured edge yet"; otherwise the
 * quarter-Kelly risk, the 1% cap when it applied, and the lots.
 */
export function sizingWords(s: NonNullable<AgentDecisionView["sizing"]>): { headline: string; detail: string } {
  const p = prob(s.p);
  const b = s.b.toFixed(2);
  const kelly = fmtSigned(s.kelly, 2);
  if (s.riskPct <= 0) {
    return {
      headline: "No measured edge yet: no trade",
      detail: `Sizing uses p = ${p} (a cautious estimate, from graded calls, of how often a move paid for an option; never the model's own confidence) and b = ${b} (what a win pays against what a loss costs). Kelly = p − (1 − p) / b = ${kelly}. It must be above zero, which needs p above ${prob(breakEvenP(s.b))}.`,
    };
  }
  const quarter = s.kelly * AGENT_LIMITS.kellyFraction * 100;
  const capped = quarter > AGENT_LIMITS.maxRiskPctPerTrade + 1e-9;
  const lots = s.lots === 0 ? "0 lots: one lot would risk more than that" : `${s.lots} lot${s.lots === 1 ? "" : "s"}`;
  return {
    headline: `Risk ${s.riskPct.toFixed(2)}% of equity → ${s.lots} lot${s.lots === 1 ? "" : "s"}`,
    detail: `Kelly = p − (1 − p) / b = ${kelly} from p = ${p} and b = ${b}. A quarter of it is ${quarter.toFixed(2)}% of equity${capped ? `, capped at ${AGENT_LIMITS.maxRiskPctPerTrade}% a trade` : ""}: ${lots}.`,
  };
}

/** What the code did with a decision. */
export function actionWords(a: AgentAction | null): string {
  switch (a) {
    case "ENTERED":
      return "Bought on paper";
    case "ENTRY_PENDING":
      return "Paper buy order sent, waiting for the fill";
    case "EXITED":
      return "Sold on paper: the code closed the position";
    case "EXIT_PENDING":
      return "Exit not sent again: an exit order is already waiting, or the position is closed";
    case "NO_ENTRY":
      return "No trade";
    case "SHADOW_ENTRY":
      return "Would have bought (shadow mode: no order placed)";
    case "SHADOW_EXIT":
      return "Would have sold (shadow mode: no order placed)";
    case "NOT_EXECUTED":
      return "Not acted on: the decision came too late, or the agent was off";
    case null:
      return "Not acted on yet: the engine acts on its next tick";
  }
}

/** The 30-minute grade of a decision. */
export function outcomeWords(o: AgentDecisionView["outcome"]): string {
  const moved = o.ret30Pct == null ? "an unknown amount" : fmtPct(o.ret30Pct, 2, true);
  switch (o.status) {
    case "PENDING":
      return "Graded in the nightly review, 30 minutes after the candle";
    case "HIT":
      return `Right: over the next 30 minutes the index moved ${moved}, the called way`;
    case "MISS":
      return `Wrong: over the next 30 minutes the index moved ${moved}`;
    case "NEUTRAL":
      return `No-direction call: the index moved ${moved} (scored on its own line)`;
    case "CENSORED":
      return "Not graded: under 30 minutes of trading were left";
    case "MISSING":
      return "Not graded: a price was missing";
  }
}

/** "37 numbers · about 312 tokens (limit 400)". */
export function snapshotNote(card: Pick<AgentIndexCardView, "snapshot" | "snapshotTokensEst">): string {
  const n = card.snapshot?.length ?? 0;
  const tokens = card.snapshotTokensEst != null ? ` · about ${card.snapshotTokensEst} tokens (limit ${SNAPSHOT_TOKEN_LIMIT})` : "";
  return `${n} number${n === 1 ? "" : "s"}${tokens}`;
}

// ---------------------------------------------------------------------------
// Escalations, review, candidate and cost
// ---------------------------------------------------------------------------

export function triggerWords(t: AgentEscalationView["trigger"]): string {
  return t === "LOW_CONFIDENCE"
    ? `Low confidence: below ${prob(ESCALATION.belowConfidence)} on a setup of ${ESCALATION.minSetupQuality} or more`
    : "The regime flipped to crisis";
}

export function escalationStatusWords(s: AgentEscalationView["status"]): string {
  switch (s) {
    case "QUEUED":
      return "Waiting to start";
    case "RUNNING":
      return "The deep model is re-reading";
    case "DONE":
      return "Done";
    case "FAILED":
      return "Failed: the fast model's decision stands";
    case "LATE":
      return "Too late: it finished after the next candle, so it was not used";
    case "SKIPPED":
      return "Skipped: rate limit, daily cap or cost cap";
  }
}

export function reviewStatusWords(s: AgentReviewView["status"]): string {
  switch (s) {
    case "PENDING":
      return "Runs after the close";
    case "RUNNING":
      return "Being written now";
    case "DONE":
      return "Written";
    case "FAILED":
      return "Failed";
    case "SKIPPED":
      return "Skipped";
  }
}

export function candidateStatusWords(s: AgentCandidateView["status"]): string {
  switch (s) {
    case "SCORING":
      return "Being replayed on the day's candles";
    case "PENDING":
      return "Waiting for your decision";
    case "APPROVED":
      return "Approved: in use from the next candle";
    case "REJECTED":
      return "Rejected: the current text stays";
    case "SUPERSEDED":
      return "Replaced by a newer candidate";
    case "FAILED":
      return "The replay failed";
  }
}

/** A guidance text as its points: a line opening with "-", "•" or "*" starts one; other lines continue the previous point. */
export function guidanceItems(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const point = /^[-•*]\s+(.*)$/.exec(line);
    if (point) items.push(point[1]);
    else if (items.length) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }
  return items;
}

export interface GuidancePoint {
  text: string;
  change: "same" | "added" | "removed";
}

/** The current and proposed texts point by point: what the proposal adds and drops (a reworded point is both). */
export function guidanceDiff(current: string, proposed: string): { current: GuidancePoint[]; proposed: GuidancePoint[]; added: string[]; removed: string[] } {
  const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const cur = guidanceItems(current);
  const pro = guidanceItems(proposed);
  const inCurrent = new Set(cur.map(key));
  const inProposed = new Set(pro.map(key));
  const currentPoints = cur.map((text): GuidancePoint => ({ text, change: inProposed.has(key(text)) ? "same" : "removed" }));
  const proposedPoints = pro.map((text): GuidancePoint => ({ text, change: inCurrent.has(key(text)) ? "same" : "added" }));
  return {
    current: currentPoints,
    proposed: proposedPoints,
    added: proposedPoints.filter((p) => p.change === "added").map((p) => p.text),
    removed: currentPoints.filter((p) => p.change === "removed").map((p) => p.text),
  };
}

export const COST_KIND_WORDS: Record<AgentCostView["byKind"][number]["kind"], string> = {
  REFLEX: "Each candle (fast model)",
  ESCALATION: "Escalations (deep model)",
  REVIEW: "Nightly review (deep model)",
  REPLAY: "Replays of the candidate",
};

// ---------------------------------------------------------------------------
// Calibration: is the stated confidence honest, and how far is sizing from moving?
// ---------------------------------------------------------------------------

/** The Brier score against always guessing the base rate (lower is better), in words. */
export function brierVerdict(brier: number | null, baseline: number | null, graded: number): { words: string; tone: "better" | "same" | "worse" | "none" } {
  if (brier == null || graded <= 0) return { words: "No graded calls yet.", tone: "none" };
  if (baseline == null || baseline <= 0) return { words: `Brier ${brier.toFixed(3)} (lower is better).`, tone: "none" };
  const skill = 1 - brier / baseline;
  const few = graded < CALIBRATION.switchMinGraded ? ` With ${graded} graded calls, a small difference can be luck.` : "";
  if (Math.abs(skill) < 0.02) return { words: `About the same as always guessing the base rate: no skill shown.${few}`, tone: "same" };
  const by = `${Math.abs(skill * 100).toFixed(1)}%`;
  if (skill > 0) return { words: `Better than always guessing the base rate, by ${by}.${few}`, tone: "better" };
  return { words: `Worse than always guessing the base rate, by ${by}.${few}`, tone: "worse" };
}

/** Standard normal quantile (Acklam's rational approximation; |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** The cautious p sizing uses, in the normal approximation: the quantile of a mean m over `total` (prior included) calls. */
function cautious(m: number, total: number, z: number): number {
  return m - z * Math.sqrt(Math.max(0, m * (1 - m)) / (total + 1));
}

export interface SizingOutlook {
  /** The p Kelly needs: above 1 / (1 + b). */
  needP: number;
  /** p is already above it: sizing can be above zero. */
  above: boolean;
  /** At least this many more graded calls, every one paying, before p could pass needP (an estimate); null when unknown. */
  bestCaseMore: number | null;
  /** The share of the calls behind p that paid; null when none. */
  ratePaid: number | null;
  /** At that rate p never passes needP. */
  rateTooLow: boolean;
  /** Closed agent trades still needed before b may rise above its prior. */
  tradesForB: number;
}

/**
 * How far sizing is from moving off zero. p is the CALIBRATION.sizingQuantile quantile of a Beta posterior on the
 * `paid` label with CALIBRATION.pooledPriorN prior calls at 50%; here it is approximated by a normal, the posterior
 * mean is recovered from p and its effective n, and paid calls are added one at a time until p passes 1 / (1 + b).
 */
export function sizingOutlook(cal: Pick<AgentCalibrationView, "sizingP" | "sizingN" | "sizingMode" | "payoffB" | "payoffTrades">): SizingOutlook {
  const needP = breakEvenP(cal.payoffB);
  const tradesForB = Math.max(0, CALIBRATION.payoffMinTradesForMeasuredB - cal.payoffTrades);
  const base = { needP, tradesForB };
  if (cal.sizingP == null) return { ...base, above: false, bestCaseMore: null, ratePaid: null, rateTooLow: false };
  if (cal.sizingP > needP) return { ...base, above: true, bestCaseMore: 0, ratePaid: null, rateTooLow: false };
  if (cal.sizingMode !== "pooled") return { ...base, above: false, bestCaseMore: null, ratePaid: null, rateTooLow: false };
  const z = -normalQuantile(CALIBRATION.sizingQuantile);
  const n = Math.max(0, cal.sizingN);
  const total = n + CALIBRATION.pooledPriorN;
  // The posterior mean behind p: cautious(m) = p, by bisection (cautious rises with m above p).
  let lo = Math.max(0, cal.sizingP);
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cautious(mid, total, z) < cal.sizingP) lo = mid;
    else hi = mid;
  }
  const m = (lo + hi) / 2;
  const ratePaid = n >= 1 ? Math.min(1, Math.max(0, (m * total - CALIBRATION.pooledPriorN / 2) / n)) : null;
  let bestCaseMore: number | null = null;
  for (let k = 1; k <= 10_000; k++) {
    if (cautious((m * total + k) / (total + k), total + k, z) > needP) {
      bestCaseMore = k;
      break;
    }
  }
  return { ...base, above: false, bestCaseMore, ratePaid, rateTooLow: ratePaid != null && ratePaid <= needP };
}

/** The outlook as sentences for the calibration panel. */
export function sizingOutlookWords(o: SizingOutlook, sizingP: number | null): string[] {
  const need = prob(o.needP);
  const out: string[] = [];
  if (sizingP == null) out.push(`Sizing stays at zero until there are graded calls to measure; p must then pass ${need} before any trade is sized.`);
  else if (o.above) out.push(`Sizing can be above zero now: p = ${prob(sizingP)} is above the ${need} Kelly needs.`);
  else {
    const more = o.bestCaseMore == null ? "many more graded calls" : `about ${o.bestCaseMore} more graded call${o.bestCaseMore === 1 ? "" : "s"}`;
    out.push(`Sizing stays at zero until p passes ${need} (now ${prob(sizingP)}). Even if every next call paid, that would take ${more}.`);
    if (o.rateTooLow && o.ratePaid != null) out.push(`At the rate so far it never would: about ${Math.round(o.ratePaid * 100)}% of the calls that count for sizing paid.`);
  }
  out.push(
    o.tradesForB > 0
      ? `b stays at most ${CALIBRATION.payoffPriorB.toFixed(2)} until ${CALIBRATION.payoffMinTradesForMeasuredB} agent trades have closed (${o.tradesForB} more).`
      : `b now comes from the agent's ${CALIBRATION.payoffMinTradesForMeasuredB} or more closed trades.`,
  );
  return out;
}
