/**
 * The models' instructions and messages (SPEC §4.2, §4.3, §4.6, §4.7 as amended). The reflex's system prompt is a
 * fixed core with one marker where the judgement guidance goes; only the guidance ever changes, and only through a
 * candidate the operator approves. instructionVersion names the core and the guidance together, so calibration can
 * tell the texts apart. The legend describes the snapshot exactly as encodeSnapshot writes it, keys and units
 * (prompt.test checks the keys and their order); a change to the core means a new REFLEX_CORE_VERSION.
 */
import { ACCOUNTS } from "../accounts";
import { SESSION, formatHHMM, istMinutes } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { INDEX_IDS, type IndexId } from "../types";
import { fnv1aHex } from "../util/hash";
import { CHARS_PER_TOKEN_BOUND, ESCALATION, OUTCOME, PROSE_CHARS_PER_TOKEN } from "./constants";
import { FINALIST_TEXT } from "./finalists";
import { encodeSnapshot } from "./snapshot";
import type { AgentTradeRecord, BriefContext, CalibrationSummary, CallRecord, DecisionRecord, Finalist, IndexSnapshot, ReflexDecision, ReflexInput, StoredBar } from "./types";
import { cleanText } from "./validate";

export const GUIDANCE_MARKER = "<<GUIDANCE>>";
/** core-2: the legend in encodeSnapshot's final units (percent spreads, ATR and book; bps for returns and distances only). */
export const REFLEX_CORE_VERSION = "core-2";

/** The agent account's entry window, square-off and the opening range the snapshot measures (its pins, else the defaults). */
const AGENT_PATCH = ACCOUNTS.agent.configPatch;
const ENTRY_FROM_IST = AGENT_PATCH.gates?.noEntryBeforeIst ?? DEFAULT_CONFIG.gates.noEntryBeforeIst;
const ENTRY_TO_IST = AGENT_PATCH.gates?.noEntryAfterIst ?? DEFAULT_CONFIG.gates.noEntryAfterIst;
const SQUARE_OFF_IST = AGENT_PATCH.exits?.squareOffIst ?? DEFAULT_CONFIG.exits.squareOffIst;
const OPENING_RANGE_MIN = AGENT_PATCH.features?.openingRangeMin ?? DEFAULT_CONFIG.features.openingRangeMin;
const OPENING_RANGE = `${formatHHMM(SESSION.open)} to ${formatHHMM(SESSION.open + OPENING_RANGE_MIN)}`;
const HORIZON_MIN = OUTCOME.horizonBars * 5;

/** One legend line: the keys it explains, in the order encodeSnapshot writes them, and what they mean. */
export interface LegendEntry {
  keys: readonly string[];
  text: string;
}

/** The snapshot's top-level keys. */
export const SNAPSHOT_LEGEND: readonly LegendEntry[] = [
  { keys: ["c"], text: "the candle's close (index points)" },
  { keys: ["r5", "r15", "r60"], text: "log return over the last 5, 15 and 60 minutes (bps)" },
  { keys: ["ro"], text: "return since today's open (bps)" },
  { keys: ["vw"], text: "distance to VWAP (bps; positive when VWAP is above the close)" },
  { keys: ["vz"], text: "z-score of the close against VWAP (positive when the close is above VWAP, so its sign is the opposite of vw's)" },
  {
    keys: ["orh", "orl"],
    text:
      `distance to today's opening-range high and low (bps); the range forms from ${OPENING_RANGE} and is still forming before then; ` +
      "after that, orh below 0 means the close is above the range, orl above 0 that it is below it, and otherwise it is inside",
  },
  { keys: ["pdh", "pdl", "pdc"], text: "distance to the previous session's high, low and close (bps)" },
  { keys: ["rsi"], text: "RSI(14)" },
  { keys: ["adx"], text: "ADX(14)" },
  { keys: ["di"], text: "+DI minus -DI" },
  { keys: ["st"], text: "Supertrend direction (1 up, -1 down, 0 none)" },
  { keys: ["rv"], text: "realized volatility over 2 hours (annualized %)" },
  { keys: ["atr"], text: "5-minute ATR (% of the close)" },
  { keys: ["vix"], text: "India VIX" },
  { keys: ["vixc"], text: "India VIX's change today (%)" },
  { keys: ["o"], text: "the at-the-money option block (keys below); null when there was no option data" },
  { keys: ["cv"], text: "the engine's conviction, -1 to 1 (it has no measured edge)" },
  { keys: ["rg"], text: "the engine's regime: TU trend up, TD trend down, RG range, HV high volatility, EV event" },
  {
    keys: ["pn"],
    text: "today's plan rules N1 N2 N4 N7 N9, in that order: k clear, c caution, b block, u unknown; any b means the plan says no new trades on this index today, all k means it is clear, anything else caution",
  },
  { keys: ["dte"], text: "trading sessions to the expiry of the contract the account would buy (never one that expires today)" },
  { keys: ["xd"], text: "1 on the index's own expiry day, else 0" },
  {
    keys: ["bk"],
    text: "the account's own book on this index: [position (L call held, S put held, - none), lots, open P&L (% of premium; null when flat), account drawdown from its peak (%), today's loss used (% of equity)]",
  },
];

/** The option block's keys. */
export const OPTION_LEGEND: readonly LegendEntry[] = [
  { keys: ["k"], text: "ATM strike" },
  { keys: ["cm", "cs"], text: "call mid (rupees) and its bid-ask spread (% of the mid)" },
  { keys: ["pm", "ps"], text: "put mid (rupees) and its bid-ask spread (% of the mid)" },
  { keys: ["iv"], text: "ATM implied volatility (%)" },
  { keys: ["ivx"], text: "iv minus India VIX (volatility points)" },
  { keys: ["pcr"], text: "put-call ratio on open interest" },
  { keys: ["mp"], text: "distance to max pain within the ±15 monitored strikes (bps)" },
  { keys: ["cw", "pw"], text: "distance to the strikes with the most call and the most put open interest, the call and put walls (bps)" },
  { keys: ["bc", "bp"], text: "how many call and put strikes within 5 strikes of ATM showed each build-up over the last 5 minutes, as [long build-up, short build-up, short covering, long unwinding]" },
  { keys: ["oa"], text: "age of the option data at the candle close (seconds)" },
];

const legendLines = (entries: readonly LegendEntry[]) => entries.map((e) => `- ${e.keys.join(" ")}: ${e.text}`);

const REFLEX_ROLE = [
  "You are the reflex of a paper-trading experiment on Indian index options (NIFTY on NSE, SENSEX on BSE).",
  "Every 5 minutes, just after a 5-minute candle closes, you receive one compact numeric snapshot per index and a",
  "list of finalists. Return exactly one judgement for every finalist id you are given, and no others.",
].join("\n");

/** The rules, fields and legend: the reflex's, and quoted to the deep model for escalations and the review. */
const SHARED_RULES = [
  "You only judge: code owns every threshold, size, order and exit, and it ignores you whenever its own checks disagree.",
  "",
  "What the account can do: buy a call (direction LONG) or buy a put (direction SHORT) and hold it intraday. It buys",
  `only from ${ENTRY_FROM_IST} to ${ENTRY_TO_IST} IST, and everything is closed by ${SQUARE_OFF_IST} IST. It never sells options.`,
  "NEUTRAL means no trade. A bought option loses value every minute (theta) and pays a spread and charges both ways,",
  "so a small or slow move in the right direction still loses money.",
  "This project's research on real prices found no rule that beat those costs for option buyers. NEUTRAL is the right",
  "answer most of the time; use LONG or SHORT only when the snapshot shows that a clear, quick move is likely within",
  `about ${HORIZON_MIN} minutes.`,
  "",
  "Finalists:",
  "- GENERIC (one per index): that index's best long or short right now, or NEUTRAL.",
  "- IDEA: an idea from today's brief by a slower research model, with a fixed side, a contract, buyZoneTop (the most",
  "  the brief would pay, in rupees), a condition (what must be true before buying; null when the brief gave none), a",
  "  wrongIf (what proves it wrong), a bearCase (the strongest argument against it) and why. Judge the condition",
  "  against the numbers in the snapshot now. If the condition is not met, return NEUTRAL. If the wrongIf is met,",
  "  return NEUTRAL with riskState REDUCE. Never return the side opposite to the idea's side.",
  "",
  "Fields:",
  "- regime: TRENDING (directional, persistent), MEAN_REVERTING (range-bound, moves fade), HIGH_VOL (large two-way",
  "  swings), CRISIS (disorderly: gaps, a VIX spike, data that looks broken or one-sided). CRISIS stops new trades and",
  "  closes open ones.",
  "- direction: LONG, SHORT or NEUTRAL.",
  "- directionConfidence: your probability, 0 to 1.",
  `  For LONG or SHORT: that the index moves at least ${OUTCOME.deadbandPct}% further in your direction over the next ${HORIZON_MIN} minutes.`,
  `  For NEUTRAL: that it stays within ${OUTCOME.neutralBandPct}% either way over the next ${HORIZON_MIN} minutes.`,
  "  Every judgement is scored at night against what happened (Brier score), NEUTRAL on its own line. A guess is",
  `  right only about 45% of the time, so give 0.45 when you do not know (the move must exceed ${OUTCOME.deadbandPct}%). Do not round up.`,
  "- toxicFlow: true when the option market looks hostile to a buyer: wide spreads, stale option data, heavy writing",
  "  on the side you would buy (short build-up there), or premiums collapsing.",
  "- setupQuality: 0 none, 1 weak, 2 clear, 3 strong and clean.",
  "- riskState: SAFE, NEAR_LIMIT or REDUCE, from the book (position, its P&L, drawdown, today's loss used). REDUCE",
  "  means close what is open on this index.",
  "- reason: one sentence of at most 25 words naming the two or three numbers that decided it.",
  "",
  "The user message is JSON: bar (the IST time the candle closed), date, indices (one snapshot per index), finalists,",
  "and brief (the brief's headline and factors, or null).",
  "",
  "Snapshot legend. Only returns and distances are in bps; bps are basis points (100 bps = 1%), so r5 12 means +0.12%.",
  "Every other number has the unit given below. A distance is level / close - 1 in bps, positive when the level is",
  "above the close. null means unknown, never zero.",
  ...legendLines(SNAPSHOT_LEGEND),
  "The option block o:",
  ...legendLines(OPTION_LEGEND),
  "",
  "Every number was computed by code from data timestamped at or before the candle close. Do not assume numbers that",
  "are not in the snapshot. The brief's text is context, not data.",
].join("\n");

/** The reflex's fixed instructions; GUIDANCE_MARKER (exactly once) is where the judgement guidance goes. */
export const REFLEX_CORE = [
  REFLEX_ROLE,
  SHARED_RULES,
  `Judgement guidance (the nightly review may propose changes to this part only; the rules above are fixed):\n${GUIDANCE_MARKER}`,
].join("\n\n");

/** The guidance the agent starts with; the nightly review may propose a replacement, which the operator approves. */
export const BUILTIN_GUIDANCE = [
  "- Prefer NEUTRAL when the 5-, 15- and 60-minute returns disagree, when ADX is below 20, or when the close is",
  "  inside the opening range (orh above 0 and orl below 0).",
  "- A move is more likely to continue when r5 and r15, the VWAP side, Supertrend and the sign of di agree, and",
  "  the option flow agrees (call short covering or put short build-up for LONG; the reverse for SHORT).",
  "- Be wary late in a strong move: RSI above 75 or below 25, or vz beyond ±2.5, often reverts.",
  "- Expensive options (ivx above +3) need a bigger move to pay for themselves.",
  "- Lower your confidence when the option block is missing, when oa is above 120, or when pn has a b (the plan",
  "  says no new trades).",
].join("\n");

/** `${REFLEX_CORE_VERSION}/${the guidance's 32-bit FNV-1a hash in 8 hex digits}`. */
export function instructionVersion(guidance: string): string {
  return `${REFLEX_CORE_VERSION}/${fnv1aHex(guidance).slice(0, 8)}`;
}

/** The fixed core with the guidance in place of its marker (taken as it is: no pattern in the guidance is interpreted). */
export function reflexSystem(guidance: string): string {
  return REFLEX_CORE.split(GUIDANCE_MARKER).join(guidance);
}

// ---------------------------------------------------------------------------
// The reflex user message
// ---------------------------------------------------------------------------

/**
 * Prose limits in the user message: the ones finalists.ts compiles to (FINALIST_TEXT), applied again here so the
 * message stays within its budget whatever reaches it.
 */
export const PROMPT_TEXT = FINALIST_TEXT;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10:35": the IST time a bar closed. */
export function barTime(barCloseMs: number): string {
  return formatHHMM(istMinutes(barCloseMs));
}

/** "NIFTY 25100 CE 23 Oct". */
function contractText(index: IndexId, c: NonNullable<Finalist["contract"]>): string {
  const [, m, d] = c.expiry.split("-").map(Number);
  const when = m >= 1 && m <= 12 && d >= 1 ? `${d} ${MONTHS[m - 1]}` : c.expiry;
  return `${index} ${c.strike} ${c.type} ${when}`;
}

const prose = (s: string | null | undefined, max: number): string | null => (typeof s === "string" ? cleanText(s, max) || null : null);

/**
 * A finalist as the model reads it (SPEC §4.3): a generic's id, kind and index; an idea adds its fixed side, the
 * contract, the buy-zone top (rupees, 2 decimals), the condition, wrongIf, bear case and up to two reasons. Its prose
 * fields are listed apart for the token estimate.
 */
function finalistParts(f: Finalist): { json: Record<string, unknown>; prose: string[] } {
  if (f.kind === "GENERIC") return { json: { id: f.id, kind: f.kind, index: f.index }, prose: [] };
  const condition = prose(f.condition, PROMPT_TEXT.condition);
  const wrongIf = prose(f.wrongIf, PROMPT_TEXT.wrongIf);
  const bearCase = prose(f.bearCase, PROMPT_TEXT.bearCase);
  const why = f.why
    .map((w) => prose(w, PROMPT_TEXT.why))
    .filter((w): w is string => w !== null)
    .slice(0, PROMPT_TEXT.whyItems);
  return {
    json: {
      id: f.id,
      kind: f.kind,
      index: f.index,
      side: f.side,
      contract: f.contract ? contractText(f.index, f.contract) : null,
      buyZoneTop: f.entryHigh === null ? null : Math.round(f.entryHigh * 100) / 100,
      condition,
      wrongIf,
      bearCase,
      why,
    },
    prose: [condition, wrongIf, bearCase, ...why].filter((s): s is string => s !== null),
  };
}

/** A finalist as the model reads it (SPEC §4.3). */
export function promptFinalist(f: Finalist): Record<string, unknown> {
  return finalistParts(f).json;
}

function briefParts(brief: BriefContext | null): { json: { headline: string; factors: string[] } | null; prose: string[] } {
  if (!brief) return { json: null, prose: [] };
  const headline = cleanText(brief.headline, PROMPT_TEXT.headline);
  const factors = brief.factors
    .map((f) => cleanText(f, PROMPT_TEXT.factor))
    .filter(Boolean)
    .slice(0, PROMPT_TEXT.factors);
  return { json: { headline, factors }, prose: [headline, ...factors] };
}

/** The finalists a reflex call asks about: those on an index with a snapshot, each id once, in the order given. */
export function promptFinalists(input: ReflexInput, finalists: readonly Finalist[]): Finalist[] {
  const seen = new Set<string>();
  return finalists.filter((f) => {
    if (!input.snapshots[f.index] || seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

/** The indices' snapshots as one JSON object, each written by encodeSnapshot. */
function snapshotsJson(snapshots: Partial<Record<IndexId, IndexSnapshot>>): string {
  const parts = INDEX_IDS.flatMap((i) => {
    const s = snapshots[i];
    return s ? [`${JSON.stringify(i)}:${encodeSnapshot(s)}`] : [];
  });
  return `{${parts.join(",")}}`;
}

function buildReflexUser(input: ReflexInput, finalists: readonly Finalist[], brief: BriefContext | null): { text: string; prose: string[] } {
  const asked = promptFinalists(input, finalists).map(finalistParts);
  const b = briefParts(brief);
  const text =
    `{"bar":${JSON.stringify(barTime(input.barCloseMs))},"date":${JSON.stringify(input.date)},` +
    `"indices":${snapshotsJson(input.snapshots)},` +
    `"finalists":${JSON.stringify(asked.map((a) => a.json))},` +
    `"brief":${JSON.stringify(b.json)}}`;
  return { text, prose: [...asked.flatMap((a) => a.prose), ...b.prose] };
}

/**
 * The user message (SPEC §4.3): JSON with the bar time, the date, each index's snapshot, the finalists and the
 * brief's context. An index without a snapshot is left out, and so are its finalists.
 */
export function reflexUser(input: ReflexInput, finalists: Finalist[], brief: BriefContext | null): string {
  return buildReflexUser(input, finalists, brief).text;
}

/**
 * A conservative token estimate of the user message: its prose (finalist and brief text, JSON-quoted) at
 * PROSE_CHARS_PER_TOKEN and everything else, the numeric JSON, at CHARS_PER_TOKEN_BOUND.
 */
export function estimateReflexUserTokens(input: ReflexInput, finalists: readonly Finalist[], brief: BriefContext | null): number {
  const { text, prose: texts } = buildReflexUser(input, finalists, brief);
  const proseChars = texts.reduce((n, s) => n + JSON.stringify(s).length, 0);
  return Math.ceil((text.length - proseChars) / CHARS_PER_TOKEN_BOUND) + Math.ceil(proseChars / PROSE_CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Escalation (deep model)
// ---------------------------------------------------------------------------

/** The deep model's instructions for an escalation: fixed (cacheable); the guidance in force goes in the user message. */
export const ESCALATION_SYSTEM = [
  [
    "You are the slow, careful second opinion for a paper-trading experiment on Indian index options (NIFTY on NSE,",
    "SENSEX on BSE). A fast model, the reflex, judged one finalist on the latest 5-minute candle and was escalated to",
    "you for the reason the user message names:",
    `LOW_CONFIDENCE (its confidence was below ${ESCALATION.belowConfidence.toFixed(2)} on a setup of ${ESCALATION.minSetupQuality} or more) or`,
    "CRISIS_FLIP (it called the regime CRISIS where its judgement on the previous candle did not).",
    "Re-read the snapshots at this candle and the previous candles of this index, and give your own judgement of that",
    "one finalist in the same fields (decision, with finalistId exactly as given). Your answer is used for the next",
    "candle only, and code applies the same checks to it as to the reflex. Be calibrated: directionConfidence is",
    "scored against what happens. NEUTRAL is the right answer most of the time. reason (beside the decision): at most",
    "60 words, the decisive numbers and what would change your mind.",
  ].join("\n"),
  "The reflex's rules, fields and snapshot legend follow; they apply to you too. Where they say every finalist, judge only the one you are given.",
  SHARED_RULES,
  "The judgement guidance in force is in the user message.",
].join("\n\n");

const TRIGGER_WORDS: Record<string, string> = {
  LOW_CONFIDENCE: `the reflex's confidence was below ${ESCALATION.belowConfidence.toFixed(2)} on a setup of ${ESCALATION.minSetupQuality} or more`,
  CRISIS_FLIP: "the reflex called the regime CRISIS where its judgement on the previous candle did not",
};

function judgement(d: ReflexDecision): Record<string, unknown> {
  return { regime: d.regime, direction: d.direction, directionConfidence: d.directionConfidence, toxicFlow: d.toxicFlow, setupQuality: d.setupQuality, riskState: d.riskState, reason: d.reason };
}

/**
 * The escalation's user message: the trigger, the finalist, the reflex's judgement, both indices' snapshots at the
 * candle, the index's previous ESCALATION.contextBars stored snapshots (oldest first) and the guidance in force.
 */
export function escalationUser(a: { finalist: Finalist; reflex: DecisionRecord; trigger: string; snapshots: Partial<Record<IndexId, IndexSnapshot>>; history: StoredBar[]; guidance: string }): string {
  const index = a.finalist.index;
  const history = a.history
    .filter((b) => b.index === index && b.barCloseMs < a.reflex.barCloseMs)
    .sort((x, y) => x.barCloseMs - y.barCloseMs)
    .slice(-ESCALATION.contextBars)
    .map((b) => (b.snapshot ? `{"bar":${JSON.stringify(barTime(b.barCloseMs))},"snapshot":${encodeSnapshot(b.snapshot)}}` : `{"bar":${JSON.stringify(barTime(b.barCloseMs))},"close":${JSON.stringify(b.close)},"snapshot":null}`));
  const why = TRIGGER_WORDS[a.trigger];
  return [
    `Trigger: ${a.trigger}${why ? ` (${why})` : ""}.`,
    `The candle closed at ${barTime(a.reflex.barCloseMs)} IST on ${a.reflex.date}.`,
    `Finalist: ${JSON.stringify(promptFinalist(a.finalist))}`,
    `The reflex's judgement: ${JSON.stringify(judgement(a.reflex))}`,
    `Snapshots at this candle: ${snapshotsJson(a.snapshots)}`,
    `The previous ${history.length} candles of ${index}, oldest first: [${history.join(",")}]`,
    "",
    "Judgement guidance in force:",
    a.guidance,
    "",
    `Give your judgement of finalist ${a.finalist.id}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The nightly review (deep model)
// ---------------------------------------------------------------------------

/** The deep model's instructions for the nightly review: fixed (cacheable). */
export const REVIEW_SYSTEM = [
  [
    "You review one session of a paper-trading experiment in which a fast model (the reflex) judged each 5-minute",
    "candle on NIFTY and SENSEX options and code decided every trade. Read every decision, its 30-minute outcome, every",
    "trade and the calibration. Write, in plain English: summary (at most 80 words); fills (what each trade did and why",
    "it ended); misses (moves the decisions missed, and false alarms); mistakes (patterns such as overconfidence,",
    "ignoring a missing option block, calling direction against the flow); lessons. Then, only if the evidence supports",
    "it, propose a revised judgement guidance text (plain bullet points, at most 2,500 characters) in candidate.guidance,",
    "with the rationale and what result over the next sessions would show it was wrong (candidate.wouldBeWrongIf);",
    "otherwise candidate is null. The guidance replaces the reflex's current guidance word for word, inside the",
    "instructions quoted below.",
  ].join("\n"),
  [
    "Rules: you may not change thresholds, sizes, limits, the output fields or the snapshot legend; code owns them and",
    "ignores any number in the guidance as a rule for itself. One session is a small sample: prefer small, general",
    "changes; never tune to a single move; never promise profit. The research behind this project found no edge for",
    "option buyers; say so if the session is consistent with that.",
  ].join("\n"),
  "The reflex's instructions (addressed to it), for reference:",
  SHARED_RULES,
].join("\n\n");

const num = (x: number | null | undefined, digits: number) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "-");
const cell = (s: string, max = 80) => cleanText(s, max).replace(/\|/g, "/");
const hhmmOf = (t: string) => /(\d{2}:\d{2})/.exec(t)?.[1] ?? t;

function gateCell(d: DecisionRecord): string {
  const g = d.execution?.gate;
  if (!g) return "-";
  if (g.fired) return "fired";
  const line = g.lines.find((l) => l.passed === false);
  return line ? cell(`${line.gate}: ${line.detail}`) : "not fired";
}

function decisionRow(d: DecisionRecord): string {
  return [
    barTime(d.barCloseMs),
    d.index,
    cell(d.finalistId, 120),
    d.source === "ESCALATION" ? "E" : "R",
    d.effective ? "y" : "n",
    d.direction,
    num(d.directionConfidence, 2),
    String(d.setupQuality),
    d.regime,
    d.riskState,
    d.toxicFlow ? "y" : "n",
    gateCell(d),
    d.execution?.action ?? "-",
    d.outcome?.status ?? "PENDING",
    num(d.outcome?.ret30Pct, 2),
  ].join("|");
}

function tradeLine(t: AgentTradeRecord): string {
  const side = t.side === "BULL" ? "call (LONG)" : "put (SHORT)";
  return (
    `- ${barTime(t.entryMs)} to ${barTime(t.exitMs)} ${t.index} ${side} ${cell(t.tradingSymbol, 40)}, ${t.lots} lot${t.lots === 1 ? "" : "s"}: ` +
    `net ₹${Math.round(t.pnlRupees).toLocaleString("en-IN")} (${num(t.pnlPctPremium, 1)}% of premium), exit ${cell(t.exitReason, 40)}` +
    `${t.agentExit ? ` (${t.agentExit})` : ""}, finalist ${t.finalistId ? cell(t.finalistId, 120) : "unknown"}`
  );
}

function calibrationLines(c: CalibrationSummary): string[] {
  const line = (label: string, n: number, brier: number | null) => `${label} n ${n} Brier ${num(brier, 3)}`;
  return [
    `Calibration of directional calls (y = 1 when the index moved at least ${OUTCOME.deadbandPct}% the called way within ${HORIZON_MIN} minutes;`,
    "Brier: lower is better; the baseline always forecasts the observed rate):",
    `- all: n ${c.graded}, Brier ${num(c.brier, 3)}, baseline ${num(c.baselineBrier, 3)}`,
    `- by index: ${c.byIndex.map((r) => line(r.index, r.n, r.brier)).join("; ") || "-"}`,
    `- by kind: ${c.byKind.map((r) => line(r.kind, r.n, r.brier)).join("; ") || "-"}`,
    `- by source: ${c.bySource.map((r) => line(r.source, r.n, r.brier)).join("; ") || "-"}`,
    `- by instruction version: ${c.byVersion.map((r) => line(r.version, r.n, r.brier)).join("; ") || "-"}`,
    `- NEUTRAL calls (y = 1 when the index stayed within ${OUTCOME.neutralBandPct}%): n ${c.neutral.n}, Brier ${num(c.neutral.brier, 3)}, baseline ${num(c.neutral.baselineBrier, 3)}`,
    `- buckets (stated confidence, then hit rate and paid rate): ${
      c.buckets.map((b) => `${num(b.from, 2)} to ${num(Math.min(1, b.to), 2)}: n ${b.n}, stated ${num(b.statedMean, 2)}, hit ${num(b.hitRate, 2)}, paid ${num(b.paidRate, 2)}`).join("; ") || "-"
    }`,
    `- sizing probability: ${num(c.sizingP, 3)} (${c.sizingMode}, effective n ${num(c.sizingN, 1)}); paid rate (moves of ${OUTCOME.payMovePct}% or more): ${num(c.paidRate, 2)}`,
  ];
}

function callLines(calls: readonly CallRecord[]): string[] {
  if (calls.length === 0) return ["Model calls: none."];
  const kinds = [...new Set(calls.map((c) => c.kind))];
  const total = calls.reduce((s, c) => s + c.costUsd, 0);
  return [
    `Model calls (total $${total.toFixed(4)}):`,
    ...kinds.map((k) => {
      const of = calls.filter((c) => c.kind === k);
      const statuses = [...new Set(of.map((c) => c.status))].map((s) => `${s} ${of.filter((c) => c.status === s).length}`).join(", ");
      return `- ${k}: ${of.length} (${statuses}), $${of.reduce((s, c) => s + c.costUsd, 0).toFixed(4)}`;
    }),
  ];
}

/**
 * The review's user message (SPEC §4.7): the guidance in force, the calibration, the calls and their cost, every
 * trade, every decision as a compact row (effective ones and the reflex rows an escalation superseded) and the index
 * closes per bar.
 */
export function reviewUser(a: {
  date: string;
  decisions: DecisionRecord[];
  trades: AgentTradeRecord[];
  calibration: CalibrationSummary;
  calls: CallRecord[];
  guidance: string;
  closes: Partial<Record<IndexId, { t: string; c: number }[]>>;
}): string {
  const decisions = [...a.decisions].sort((x, y) => x.barCloseMs - y.barCloseMs || x.index.localeCompare(y.index) || x.finalistId.localeCompare(y.finalistId) || Number(y.effective) - Number(x.effective));
  const trades = [...a.trades].sort((x, y) => x.entryMs - y.entryMs);
  return [
    `Session ${a.date} (all times IST).`,
    "",
    "Judgement guidance in force during the session:",
    a.guidance,
    "",
    ...calibrationLines(a.calibration),
    "",
    ...callLines(a.calls),
    "",
    `Trades (${trades.length}):`,
    ...(trades.length ? trades.map(tradeLine) : ["- none"]),
    "",
    `Decisions (${decisions.length}; src R reflex, E escalation; eff n marks a reflex row an escalation replaced; conf is directionConfidence; ret30 is the index move over the next ${HORIZON_MIN} minutes in %):`,
    "bar|index|finalist|src|eff|dir|conf|setup|regime|risk|toxic|gate|action|outcome|ret30",
    ...decisions.map(decisionRow),
    "",
    "Index closes per bar:",
    ...INDEX_IDS.flatMap((i) => {
      const rows = a.closes[i];
      return rows?.length ? [`${i}: ${rows.map((r) => `${hhmmOf(r.t)} ${r.c}`).join(", ")}`] : [];
    }),
    "",
    "Write the review.",
  ].join("\n");
}
