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
  AgentRiskView,
  AgentView,
} from "@/engine/api-types";
import { ACCOUNTS } from "@/engine/accounts";
import { AGENT_LIMITS, AGENT_POLICY, CALIBRATION, ESCALATION, SNAPSHOT_TOKEN_LIMIT } from "@/engine/agent/constants";
import { modelName } from "@/components/Advisor/advisorText";
import { fmtInr, fmtIstDay, fmtIstHm, fmtPct, fmtSigned } from "@/components/shared/format";
import { istDate } from "@/lib/ist";
import type { AgentReplayView, AgentSizingView } from "@/lib/engine/types";

// ---------------------------------------------------------------------------
// The model's call
// ---------------------------------------------------------------------------

/** The model's call is not an instruction: the code decides whether the agent buys anything. */
export const DIRECTION_META: Record<AgentDirection, { glyph: string; word: string; trade: string }> = {
  LONG: { glyph: "▲", word: "Up", trade: "the agent would buy a call (CE)" },
  SHORT: { glyph: "▼", word: "Down", trade: "the agent would buy a put (PE)" },
  NEUTRAL: { glyph: "▬", word: "No direction", trade: "no trade" },
};

/** "Up: the agent would buy a call (CE)", "Down: the agent would buy a put (PE)", "No direction: no trade". */
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
 * "about 21 calls": the count behind p is overlap-weighted, so it is rounded, and it reads at least 1 once any graded
 * call counts.
 */
export function aboutCalls(n: number): string {
  const k = n > 0 ? Math.max(1, Math.round(n)) : 0;
  return `about ${k} call${k === 1 ? "" : "s"}`;
}

/**
 * "1 lot", "2 lots", or 0 lots and why, from the decision's gate lines: the quarter-Kelly cap blocked one lot
 * (kelly_cap failed), or a check before the size blocked the entry (no market features from main's tick, or the
 * engine's own entry checks), so no lot was sized. Without the lines, just "0 lots".
 */
function lotWords(lots: number, lines: readonly Pick<AgentGateLineView, "gate" | "passed">[] | undefined): string {
  if (lots > 0) return `${lots} lot${lots === 1 ? "" : "s"}`;
  if (!lines) return "0 lots";
  return lines.some((l) => l.gate === "kelly_cap" && l.passed === false) ? "0 lots: one lot would risk more than that" : "0 lots: the entry was blocked before it was sized";
}

/**
 * Sizing in words: a headline, the size it allows (only when the risk is above zero) and the working. Nothing here
 * claims an edge: above zero means confident past calls cleared break-even in-sample, which proves nothing about the
 * sessions ahead. `n` is the number of graded calls behind p (0: none of this kind yet; absent: unknown). `lines`,
 * the decision's gate, says why a size above zero bought 0 lots.
 */
export function sizingWords(s: AgentSizingView, lines?: readonly Pick<AgentGateLineView, "gate" | "passed">[]): { headline: string; size: string | null; detail: string } {
  const p = prob(s.p);
  const b = s.b.toFixed(2);
  const kelly = fmtSigned(s.kelly, 2);
  const n = s.n ?? null;
  const none = n !== null && n <= 0;
  if (s.riskPct <= 0) {
    const from = none
      ? "with no graded calls of this kind yet, only the cautious starting estimate"
      : "a cautious estimate, from graded calls, of how often a move paid for an option";
    return {
      headline: none
        ? "Size zero: no graded calls of this kind yet"
        : `Size zero: confident past calls have not cleared break-even${n === null ? "" : ` (measured on ${aboutCalls(n)})`}`,
      size: null,
      // The engine never sizes a call with no graded call of its kind behind p, whatever Kelly gives.
      detail: `Sizing uses p = ${p} (${from}; never the model's own confidence) and b = ${b} (what a win pays against what a loss costs). Kelly = p − (1 − p) / b = ${kelly}. ${none ? "With no graded call of this kind behind p, no trade is sized, whatever Kelly gives." : `It must be above zero, which needs p above ${prob(breakEvenP(s.b))}.`}`,
    };
  }
  const quarter = s.kelly * AGENT_LIMITS.kellyFraction * 100;
  const capped = quarter > AGENT_LIMITS.maxRiskPctPerTrade + 1e-9;
  const measured = n !== null && n > 0 ? `measured on ${aboutCalls(n)}, ` : "";
  return {
    headline: `Small size allowed: confident past calls moved enough to pay often enough to clear break-even (${measured}in-sample; not proof of an edge)`,
    size: `Risk ${s.riskPct.toFixed(2)}% of equity → ${lotWords(s.lots, lines)}`,
    detail: `Kelly = p − (1 − p) / b = ${kelly} from p = ${p} and b = ${b}. A quarter of it is ${quarter.toFixed(2)}% of equity${capped ? `, capped at ${AGENT_LIMITS.maxRiskPctPerTrade}% a trade` : ""}: ${lotWords(s.lots, lines)}.`,
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

/**
 * A review's error as the page shows it: PENDING waits for its retry, SKIPPED ran no model call (both say why);
 * only FAILED is an error. Null when there is nothing to say.
 */
export function reviewNotice(r: Pick<AgentReviewView, "status" | "error">): { tone: "error" | "warn" | "neutral"; words: string } | null {
  if (!r.error) return null;
  if (r.status === "PENDING") return { tone: "warn", words: `Waiting: ${r.error}` };
  if (r.status === "SKIPPED") return { tone: "neutral", words: `Skipped: ${r.error}` };
  return { tone: "error", words: `The review failed: ${r.error}` };
}

/**
 * The candidate's status. An APPROVED candidate is "in use" only while its text is the active one (`inUse`; when the
 * view does not say, an approval is taken as still in use).
 */
export function candidateStatusWords(s: AgentCandidateView["status"], inUse?: boolean): string {
  switch (s) {
    case "SCORING":
      return "Being replayed on the day's candles";
    case "PENDING":
      return "Waiting for your decision";
    case "APPROVED":
      return inUse === false ? "Approved earlier; no longer in use" : "Approved: in use";
    case "REJECTED":
      return "Rejected: the current text stays";
    case "SUPERSEDED":
      return "Replaced by a newer candidate";
    case "FAILED":
      return "The replay failed";
  }
}

/** Fewer calls than this, labelled by every run, are too few for the replay's Brier scores to compare. */
export const REPLAY_MIN_COMMON_CALLS = 10;

/** "60 of the day's 75 candles were judged again with each text, on identical inputs." */
export function replayCoverageWords(r: Pick<AgentReplayView, "bars" | "barsTotal">): string {
  const total = r.barsTotal ?? r.bars;
  return `${r.bars} of the day's ${total} candle${total === 1 ? "" : "s"} ${r.bars === 1 ? "was" : "were"} judged again with each text, on identical inputs.`;
}

/**
 * What the replay's Brier scores are over. A replay that reports gradedCommon scored all three runs on the same calls;
 * an older one scored each run on its own calls, and says so instead of claiming a like-for-like comparison.
 */
export function replayScoredWords(r: Pick<AgentReplayView, "graded" | "gradedCandidate" | "gradedCurrent" | "gradedLive" | "gradedCommon">): string {
  if (r.gradedCommon == null)
    return `Scored on ${r.graded} graded call${r.graded === 1 ? "" : "s"} of the proposed text; this older replay scored each run on its own calls, so the three scores are not over the same calls.`;
  const common = r.gradedCommon;
  const counts = `proposed ${r.gradedCandidate ?? r.graded}, current ${r.gradedCurrent ?? r.graded}, live ${r.gradedLive ?? r.graded}`;
  const few = common < REPLAY_MIN_COMMON_CALLS ? ": too few to compare" : "";
  return `Scored on ${common} call${common === 1 ? "" : "s"} that all three runs labelled (${counts})${few}.`;
}

/** Why an incomplete replay stopped, and what it covers; null for a complete one. */
export function replayStopWords(r: Pick<AgentReplayView, "complete" | "stopReason" | "bars">): string | null {
  if (r.complete) return null;
  const covers = r.bars > 0 ? "so it covers only part of the day" : "so no candle was judged again";
  switch (r.stopReason) {
    case "cost_cap":
      return `The replay stopped early at the cost cap, ${covers}.`;
    case "interrupted":
      return `The replay was interrupted (the agent restarted), ${covers}.`;
    case "no_key":
      return `The replay could not run (no API key), ${covers}.`;
    default:
      return `The replay stopped early, ${covers}.`;
  }
}

// ---------------------------------------------------------------------------
// Risk headline and re-arm
// ---------------------------------------------------------------------------

/** The day loss and drawdown at which the code's risk state leaves Safe, so no new entries are made. */
export const ENTRY_STOP = {
  dayLossPct: AGENT_LIMITS.nearDayLossFrac * AGENT_LIMITS.dailyLossCapPct,
  drawdownPct: AGENT_LIMITS.nearDrawdownPct,
  /** Entries a day before the risk state leaves Safe (one short of the day's limit). */
  entriesToday: (ACCOUNTS.agent.configPatch.sizing?.maxTradesPerDay ?? 6) - 1,
} as const;

/** "Within every limit" in each mode's words: shadow mode places no order, and off judges no candle. */
const WITHIN_LIMITS: Record<AgentMode, string> = {
  paper: "Within every limit: new entries are allowed when a decision passes every check.",
  shadow: "Within every limit: paper mode would allow new entries when a decision passes every check (shadow mode places no order).",
  off: "Within every limit. The agent is off: no candle is judged, so no entry is made.",
};

/**
 * The risk panel's headline: the first of the halt, the kill switch, the day's loss cap and a risk state that is not
 * Safe, as the code blocks entries on each; "within every limit" only when none applies, in the agent mode's words.
 */
export function riskHeadline(r: AgentRiskView, mode: AgentMode): { tone: "stopped" | "blocked" | "ok"; words: string } {
  if (r.drawdownHalt) return { tone: "stopped", words: `Halted: the account fell ${pct(r.drawdownPct ?? 0)} from its peak (the limit is ${r.maxDrawdownPct}%). No new entries until you re-arm.` };
  if (r.killSwitch) return { tone: "stopped", words: `Kill switch on${r.killReason ? `: ${r.killReason}` : ""}. No new entries.` };
  if (r.dayLossPct != null && r.dayLossPct >= r.dailyLossCapPct)
    return {
      tone: "stopped",
      words: `Stopped for today: today's loss ${pct(r.dayLossPct)} reached the ${r.dailyLossCapPct}% cap; positions closed, no new entries until the next session.`,
    };
  if (r.codeRiskState !== "SAFE")
    return {
      tone: "blocked",
      words: `No new entries now: the code's risk state is ${riskWords(r.codeRiskState)}; entries need Safe (day loss under ${ENTRY_STOP.dayLossPct}%, drawdown under ${ENTRY_STOP.drawdownPct}%, fewer than ${r.maxOpenPositions} positions open and fewer than ${ENTRY_STOP.entriesToday} entries today).`,
    };
  return { tone: "ok", words: WITHIN_LIMITS[mode] };
}

/**
 * The re-arm button. During a drawdown halt it re-arms (the peak restarts); with only the kill switch on it clears
 * the switch (the peak stays). While main's kill switch is on the engine refuses either, so the button is off.
 */
export function rearmWords(r: Pick<AgentRiskView, "drawdownHalt" | "killSwitch" | "mainKillSwitch" | "peakEquity">): {
  label: string;
  enabled: boolean;
  note: string;
  confirmLabel: string;
  /** The peak restarts at today's equity: only after a halt. */
  peakRestarts: boolean;
} {
  const halted = r.drawdownHalt;
  const label = halted || !r.killSwitch ? "Re-arm the agent" : "Clear the kill switch";
  const confirmLabel = halted || !r.killSwitch ? "Re-arm" : "Clear it";
  if (!halted && !r.killSwitch) return { label, enabled: false, note: "Nothing to re-arm: no halt and the kill switch is off.", confirmLabel, peakRestarts: false };
  if (r.mainKillSwitch) return { label, enabled: false, note: "Reset main's kill switch first: the engine refuses until then.", confirmLabel, peakRestarts: false };
  if (halted) return { label, enabled: true, note: "Clears the halt and the agent's kill switch; the drawdown is then measured from today's equity (admin token needed).", confirmLabel, peakRestarts: true };
  const peak = r.peakEquity == null ? "the same peak" : `its peak of ${fmtInr(r.peakEquity)}`;
  return { label, enabled: true, note: `Clears the agent's kill switch; the drawdown is still measured from ${peak} (admin token needed).`, confirmLabel, peakRestarts: false };
}

/** "Decided on the 15:05 candle" when a decision's candle is not the one the card heads with; null when it is. */
export function decidedOnWords(decisionBarAt: string, cardBarAt: string | null): string | null {
  const d = Date.parse(decisionBarAt);
  if (!Number.isFinite(d)) return null;
  if (cardBarAt != null && Date.parse(cardBarAt) === d) return null;
  return `Decided on the ${fmtIstHm(d)} candle`;
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
