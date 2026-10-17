/**
 * The nightly review's code (SPEC §4.7–4.8 as amended, #13, #14): grading the day's decisions, turning the deep
 * model's proposal into a candidate guidance text, and scoring a replay of the day's stored candles. The replay runs
 * both texts fresh on identical inputs, and its numbers are in-sample by construction: the reviewer has already seen
 * the day's outcomes. They are labelled "in-sample, not proof", and only the operator can approve a candidate.
 */
import type { TradingCalendar } from "../calendar/calendar";
import type { IndexId } from "../types";
import { brier } from "./calibration";
import { labelDecision, OUTCOME_HORIZON_MS, outcomeCensored } from "./outcomes";
import { modelGateLines } from "./policy";
import type { CandidateRecord, DecisionOutcome, DecisionRecord, Finalist, IndexSnapshot, InstructionRecord, ReflexDecision, ReplayResult, ReviewOut } from "./types";

/** The marker the fixed reflex instructions carry where the guidance goes (prompt.ts); a guidance text may not contain it. */
export const GUIDANCE_MARKER = "<<GUIDANCE>>";
/** GUIDANCE_MARKER in any letter case or spacing. */
const MARKER_LIKE = /<<\s*guidance\s*>>/i;
/** The longest guidance text a candidate may propose (trimmed). */
export const MAX_GUIDANCE_CHARS = 3_000;
const MAX_NOTE_CHARS = 2_000;
const REPLAY_LABEL = "in-sample, not proof" as const;
const EMPTY = new Map<number, number>();

/**
 * The day's outcome labels (labelDecision), for every decision whose 30-minute window has ended (or can never end:
 * CENSORED); younger decisions stay ungraded. Both closes come from `archive` (bars_5m) when it has both bars, else
 * from the stored `closes`. A regrade never replaces a label with MISSING, nor an archive label with a stored-close one.
 */
export function gradeDay(
  decisions: readonly DecisionRecord[],
  closes: ReadonlyMap<IndexId, ReadonlyMap<number, number>>,
  calendar: TradingCalendar,
  nowMs: number,
  archive?: ReadonlyMap<IndexId, ReadonlyMap<number, number>>,
): { id: string; outcome: DecisionOutcome }[] {
  const out: { id: string; outcome: DecisionOutcome }[] = [];
  for (const d of decisions) {
    if (!outcomeCensored(d.barCloseMs, calendar) && d.barCloseMs + OUTCOME_HORIZON_MS > nowMs) continue;
    const outcome = labelDecision(d, closes.get(d.index) ?? EMPTY, calendar, nowMs, archive?.get(d.index));
    const prev = d.outcome;
    if (prev && prev.status !== "MISSING" && outcome.status === "MISSING") continue;
    if (prev?.source === "BARS_5M" && outcome.source === "STORED") continue;
    out.push({ id: d.id, outcome });
  }
  return out;
}

/** Control characters other than tab and newline. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * The review's proposal as a candidate (status SCORING), or null when there is nothing to score: no candidate; a
 * guidance that is empty or longer than MAX_GUIDANCE_CHARS after trimming; the same text as the base (whitespace
 * aside); or a text containing the guidance marker. `base` is the text the reviewed session ran with; the candidate
 * keeps it (baseVersion, baseGuidance) as the "before" of its comparison.
 */
export function candidateFrom(out: ReviewOut, base: InstructionRecord, date: string, nowMs: number, newId: () => string): CandidateRecord | null {
  const c = out.candidate;
  if (!c) return null;
  const guidance = clean(c.guidance ?? "");
  if (guidance.length === 0 || guidance.length > MAX_GUIDANCE_CHARS) return null;
  if (sameText(guidance, base.guidance)) return null;
  if (MARKER_LIKE.test(guidance)) return null;
  return {
    id: newId(),
    date,
    createdMs: nowMs,
    baseVersion: base.version,
    baseGuidance: base.guidance,
    guidance,
    rationale: clean(c.rationale ?? "").slice(0, MAX_NOTE_CHARS),
    wouldBeWrongIf: clean(c.wouldBeWrongIf ?? "").slice(0, MAX_NOTE_CHARS),
    status: "SCORING",
    replay: null,
    decidedMs: null,
    decidedBy: null,
  };
}

/**
 * The model side of the code gate on a stored candle: setup quality ≥ 2, confidence above 0.80, a direction, no
 * CRISIS, the idea's own side, no toxic flow by the model or by the code's checks on the snapshot, and the model's
 * risk SAFE. Freshness and the book's limits are left out (a replay has no live book).
 */
export function modelFires(d: ReflexDecision, s: IndexSnapshot | null, f: Finalist): boolean {
  if (d.finalistId !== f.id || d.riskState !== "SAFE") return false;
  return modelGateLines(d, f, s).every((l) => l.passed === true);
}

/** One stored candle of the day: its snapshots and the finalists its batch judged. */
export interface ReplayBar {
  barCloseMs: number;
  snapshots: Partial<Record<IndexId, IndexSnapshot>>;
  finalists: Finalist[];
}

interface ArmScore {
  /** Each call the run labelled HIT or MISS, keyed `${barCloseMs}:${finalistId}`: its stated confidence and label. */
  labelled: Map<string, { p: number; y: 0 | 1 }>;
  fires: number;
  hitRate: number | null;
}

/** The key of one call in a replay: the candle and the finalist. */
const callKey = (barCloseMs: number, finalistId: string) => `${barCloseMs}:${finalistId}`;

function scoreArm(
  bars: readonly ReplayBar[],
  arm: readonly (readonly ReflexDecision[])[],
  closes: ReadonlyMap<IndexId, ReadonlyMap<number, number>>,
  archive: ReadonlyMap<IndexId, ReadonlyMap<number, number>> | undefined,
  calendar: TradingCalendar,
  nowMs: number,
): ArmScore {
  const labelled = new Map<string, { p: number; y: 0 | 1 }>();
  let fires = 0;
  let fireGraded = 0;
  let fireHits = 0;
  bars.forEach((bar, i) => {
    const seen = new Set<string>();
    for (const d of arm[i] ?? []) {
      const f = bar.finalists.find((x) => x.id === d.finalistId);
      if (!f || seen.has(d.finalistId)) continue;
      seen.add(d.finalistId);
      const o = labelDecision({ barCloseMs: bar.barCloseMs, direction: d.direction }, closes.get(f.index) ?? EMPTY, calendar, nowMs, archive?.get(f.index));
      const isLabelled = (o.status === "HIT" || o.status === "MISS") && o.y !== null;
      if (isLabelled) labelled.set(callKey(bar.barCloseMs, d.finalistId), { p: d.directionConfidence, y: o.y as 0 | 1 });
      if (modelFires(d, bar.snapshots[f.index] ?? null, f)) {
        fires++;
        if (isLabelled) {
          fireGraded++;
          fireHits += o.y as number;
        }
      }
    }
  });
  return { labelled, fires, hitRate: fireGraded > 0 ? fireHits / fireGraded : null };
}

/**
 * Scores a replay of the day's stored candles (SPEC §4.8 as amended, #14), bar by bar over `bars`:
 * - candidate: the candidate text, replayed; currentReplayed: the current text, replayed on the same inputs;
 *   current: the live decisions stored for those candles (reflex rows only, not escalations).
 * - All three Brier scores use the 30-minute hit label, over exactly the calls (candle and finalist) that all three
 *   runs labelled HIT or MISS: a text that answers NEUTRAL more, or a call that failed, can never win by being
 *   scored on fewer or easier calls. `graded` = gradedCommon is that number; gradedCandidate, gradedCurrent and
 *   gradedLive are each run's own labelled calls. brierCurrentLive against brierCurrentReplayed shows how much the
 *   score moves with no change of text, on the same calls.
 * - fires count the calls passing the model side of the gate (modelFires); hit rates are those fires' share of hits.
 *   firesCurrent and hitRateCurrent are the replayed current text's.
 */
export function replayScore(a: {
  bars: readonly ReplayBar[];
  candidate: readonly ReflexDecision[][];
  currentReplayed: readonly ReflexDecision[][];
  current: readonly DecisionRecord[][];
  closes: ReadonlyMap<IndexId, ReadonlyMap<number, number>>;
  archive?: ReadonlyMap<IndexId, ReadonlyMap<number, number>>;
  calendar: TradingCalendar;
  nowMs: number;
  costUsd: number;
  complete: boolean;
}): ReplayResult {
  const score = (arm: readonly (readonly ReflexDecision[])[]) => scoreArm(a.bars, arm, a.closes, a.archive, a.calendar, a.nowMs);
  const candidate = score(a.candidate);
  const replayed = score(a.currentReplayed);
  const live = score(a.current.map((rows) => rows.filter((d) => d.source === "REFLEX")));
  const common = [...candidate.labelled.keys()].filter((k) => replayed.labelled.has(k) && live.labelled.has(k));
  const brierOn = (arm: ArmScore) => brier(common.map((k) => arm.labelled.get(k)!));
  return {
    bars: a.bars.length,
    graded: common.length,
    brierCandidate: brierOn(candidate),
    brierCurrentReplayed: brierOn(replayed),
    brierCurrentLive: brierOn(live),
    firesCandidate: candidate.fires,
    firesCurrent: replayed.fires,
    hitRateCandidate: candidate.hitRate,
    hitRateCurrent: replayed.hitRate,
    costUsd: a.costUsd,
    complete: a.complete,
    cursorBarMs: a.bars.length > 0 ? a.bars[a.bars.length - 1].barCloseMs : null,
    label: REPLAY_LABEL,
    gradedCandidate: candidate.labelled.size,
    gradedCurrent: replayed.labelled.size,
    gradedLive: live.labelled.size,
    gradedCommon: common.length,
  };
}
