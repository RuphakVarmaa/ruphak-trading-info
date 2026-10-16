/**
 * How well the reflex's stated confidence matches what happened, and the probability sizing uses (SPEC §5.4 and §6
 * as amended: #4, #15, #23).
 * - The Brier score and the buckets use the 0.03% hit label of every graded decision in force, both sources.
 * - Sizing never uses the model's confidence as a probability. p is the CALIBRATION.sizingQuantile quantile (the 20th
 *   percentile) of the Beta posterior of the `paid` label (a move of at least OUTCOME.payMovePct in the called
 *   direction) on graded directional reflex decisions, starting from a prior of 0.5 worth CALIBRATION.pooledPriorN
 *   calls. With no history p is below 0.5, so Kelly with b ≤ 1 is negative and the agent does not trade.
 * - Overlapping 30-minute windows share most of their move, so they are not independent evidence (#15): identical
 *   (index, bar, direction) rows count once, and each row weighs 1 / (the rows on its index whose windows overlap
 *   it). Older instruction versions weigh CALIBRATION.oldVersionWeight. Escalation rows are scored apart, never sized.
 * - NEUTRAL calls are scored on their own Brier line (#23) and never feed sizing.
 */
import { BAR_5M_MS } from "../market/candles";
import { INDEX_IDS } from "../types";
import { CALIBRATION, OUTCOME } from "./constants";
import type {
  AgentDecisionSource,
  AgentFinalistKind,
  CalibrationBucket,
  CalibrationSummary,
  DecisionRecord,
  GradedDecision,
  GradedNeutral,
  SizingHint,
} from "./types";

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// The Beta distribution: regularized incomplete beta and its inverse
// ---------------------------------------------------------------------------

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7: about 15 significant digits; reflection below 0.5). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const lnBeta = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);

/** The continued fraction of I_x(a, b), modified Lentz (Numerical Recipes betacf); converges fast for x < (a + 1) / (a + b + 2). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

const validShape = (a: number, b: number) => a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b);

/** The regularized incomplete beta function I_x(a, b): the CDF of Beta(a, b) at x. NaN for a, b ≤ 0. */
export function betaRegularized(x: number, a: number, b: number): number {
  if (!validShape(a, b) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b));
  // The fraction converges quickly below the mean; above it, use I_x(a, b) = 1 − I_{1−x}(b, a).
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * The q-quantile of Beta(a, b): the x with I_x(a, b) = q. Newton steps on the CDF, kept inside a shrinking bracket
 * and replaced by bisection whenever a step would leave it, so it always converges. NaN for a, b ≤ 0.
 */
export function betaQuantile(q: number, a: number, b: number): number {
  if (!validShape(a, b) || Number.isNaN(q)) return NaN;
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  const lb = lnBeta(a, b);
  let lo = 0;
  let hi = 1;
  let x = a / (a + b);
  for (let i = 0; i < 300; i++) {
    const f = betaRegularized(x, a, b) - q;
    if (f === 0) return x;
    if (f < 0) lo = x;
    else hi = x;
    const density = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lb);
    let next = x - f / density;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    // Relative to the nearer end of (0, 1), so a quantile near 0 or 1 keeps its precision too.
    const tol = 1e-15 * Math.min(next, 1 - next);
    if (Math.abs(next - x) <= tol || hi - lo <= tol) return next;
    x = next;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

const usable = (p: number) => Number.isFinite(p) && p >= 0 && p <= 1;

/** Mean squared error of stated probabilities against 0/1 outcomes (lower is better); null without rows. */
export function brier(rows: readonly { p: number; y: 0 | 1 }[]): number | null {
  const ok = rows.filter((r) => usable(r.p) && (r.y === 0 || r.y === 1));
  if (ok.length === 0) return null;
  return ok.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / ok.length;
}

/** The Brier score of always forecasting the observed base rate: ȳ(1 − ȳ). Null without rows. */
export function baselineBrier(rows: readonly { y: 0 | 1 }[]): number | null {
  const ok = rows.filter((r) => r.y === 0 || r.y === 1);
  if (ok.length === 0) return null;
  const ybar = ok.reduce((s, r) => s + r.y, 0) / ok.length;
  return ybar * (1 - ybar);
}

/**
 * Calibration buckets over [edges[i], edges[i + 1]): weight (n), mean stated probability, hit rate, and the paid rate
 * of the rows that carry `paid`. Rows weigh 1 unless given w.
 */
export function buckets(rows: readonly { p: number; y: 0 | 1; w?: number; paid?: boolean | null }[], edges: readonly number[] = CALIBRATION.bucketEdges): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    let n = 0;
    let sp = 0;
    let sy = 0;
    let paidN = 0;
    let paidSum = 0;
    for (const r of rows) {
      if (!(usable(r.p) && r.p >= from && r.p < to)) continue;
      const w = r.w ?? 1;
      if (!(w > 0 && Number.isFinite(w))) continue;
      n += w;
      sp += w * r.p;
      sy += w * r.y;
      if (typeof r.paid === "boolean") {
        paidN += w;
        if (r.paid) paidSum += w;
      }
    }
    out.push({ from, to: Math.min(to, 1), n, statedMean: n > 0 ? sp / n : null, hitRate: n > 0 ? sy / n : null, paidRate: paidN > 0 ? paidSum / paidN : null });
  }
  return out;
}

/**
 * Pool-adjacent-violators: the weighted least-squares fit to the values that never decreases. Weights ≤ 0 do not
 * pull a pool (a pool with no weight takes the plain mean of its values).
 */
export function pav(values: readonly { p: number; w: number }[]): number[] {
  const pools: { sum: number; w: number; plain: number; n: number; value: number }[] = [];
  for (const { p, w } of values) {
    const ww = Number.isFinite(w) && w > 0 ? w : 0;
    pools.push({ sum: ww * p, w: ww, plain: p, n: 1, value: p });
    while (pools.length > 1 && pools[pools.length - 2].value > pools[pools.length - 1].value) {
      const b = pools.pop()!;
      const a = pools.pop()!;
      const merged = { sum: a.sum + b.sum, w: a.w + b.w, plain: a.plain + b.plain, n: a.n + b.n, value: 0 };
      merged.value = merged.w > 0 ? merged.sum / merged.w : merged.plain / merged.n;
      pools.push(merged);
    }
  }
  return pools.flatMap((pool) => Array.from({ length: pool.n }, () => pool.value));
}

// ---------------------------------------------------------------------------
// Weights and the sizing probability
// ---------------------------------------------------------------------------

/** The outcome window of one call (30 minutes): two calls on one index overlap when their bars are closer than this. */
export const OUTCOME_WINDOW_MS = OUTCOME.horizonBars * BAR_5M_MS;

type WeightedFields = Pick<GradedDecision, "index" | "barCloseMs" | "direction" | "instructionVersion">;

/** The first index in sorted `xs` whose value is ≥ x. */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The #15 weights of a set of graded directional rows: identical (index, bar, direction) rows collapse to one (the
 * active version's when there is one), then each row weighs versionWeight / (the rows of the set on its index whose
 * 30-minute windows overlap it, itself included). versionWeight is 1 for the active instruction version and
 * CALIBRATION.oldVersionWeight otherwise. The weights of a run of mutually overlapping rows add up to at most 1.
 */
export function overlapWeights<T extends WeightedFields>(rows: readonly T[], activeVersion: string): { row: T; w: number }[] {
  const kept = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.index}|${r.barCloseMs}|${r.direction}`;
    const prev = kept.get(key);
    if (!prev || (prev.instructionVersion !== activeVersion && r.instructionVersion === activeVersion)) kept.set(key, r);
  }
  const unique = [...kept.values()].sort((a, b) => a.barCloseMs - b.barCloseMs || a.index.localeCompare(b.index) || a.direction.localeCompare(b.direction));
  const bars = new Map<string, number[]>();
  for (const r of unique) {
    const list = bars.get(r.index) ?? [];
    list.push(r.barCloseMs);
    bars.set(r.index, list);
  }
  return unique.map((r) => {
    const list = bars.get(r.index)!;
    // Windows [t, t + 30 min] overlap when the bars are less than 30 minutes apart.
    const overlapping = lowerBound(list, r.barCloseMs + OUTCOME_WINDOW_MS) - lowerBound(list, r.barCloseMs - OUTCOME_WINDOW_MS + 1);
    const version = r.instructionVersion === activeVersion ? 1 : CALIBRATION.oldVersionWeight;
    return { row: r, w: version / Math.max(1, overlapping) };
  });
}

/** A graded row that may feed sizing: a reflex call in force, directional, with a usable confidence and labels. */
function sizingRow(r: GradedDecision): boolean {
  return r.source === "REFLEX" && r.effective && (r.direction === "LONG" || r.direction === "SHORT") && usable(r.directionConfidence) && (r.y === 0 || r.y === 1) && typeof r.paid === "boolean";
}

interface Posterior {
  /** Effective (weighted) number of calls. */
  n: number;
  /** The posterior mean of the paid rate. */
  mean: number;
  /** Its CALIBRATION.sizingQuantile quantile. */
  p: number;
}

/** Beta(Σw·paid + 0.5·priorN, Σw·(1 − paid) + 0.5·priorN): its mean and its sizing quantile. */
function paidPosterior(weighted: readonly { row: GradedDecision; w: number }[], priorN: number): Posterior {
  let n = 0;
  let paid = 0;
  for (const { row, w } of weighted) {
    n += w;
    if (row.paid) paid += w;
  }
  const a = paid + 0.5 * priorN;
  const b = n - paid + 0.5 * priorN;
  return { n, mean: a / (a + b), p: betaQuantile(CALIBRATION.sizingQuantile, a, b) };
}

/** The bucket of a confidence among the edges, or −1. */
function bucketOf(conf: number, edges: readonly number[]): number {
  for (let i = 0; i + 1 < edges.length; i++) if (conf >= edges[i] && conf < edges[i + 1]) return i;
  return -1;
}

const failClosed = (h: SizingHint): SizingHint => (Number.isFinite(h.p) ? h : { ...h, p: 0 });

/**
 * The probability sizing uses for a decision stated at `conf` (SPEC §5.4 as amended).
 * - "pooled" (the default): the paid posterior over every sizing row with confidence above
 *   CALIBRATION.fireMinConfidence, prior CALIBRATION.pooledPriorN, whatever the decision's own confidence.
 * - "buckets": once the rows weigh CALIBRATION.switchMinGraded in all and the decision's confidence bucket weighs
 *   bucketMinN, each bucket's paid posterior (prior bucketPriorN) is taken at the same quantile, the buckets are made
 *   non-decreasing in confidence (pav, weighted by their weight) and the decision's bucket is used.
 * Each set's rows carry the #15 weights within that set. A probability that is not a number becomes 0 (no trade).
 */
export function sizingProbability(conf: number, graded: readonly GradedDecision[], activeVersion: string): SizingHint {
  const rows = graded.filter(sizingRow);
  const edges = CALIBRATION.bucketEdges;
  const k = usable(conf) ? bucketOf(conf, edges) : -1;
  if (k >= 0) {
    const perBucket: Posterior[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const inBucket = rows.filter((r) => r.directionConfidence >= edges[i] && r.directionConfidence < edges[i + 1]);
      perBucket.push(paidPosterior(overlapWeights(inBucket, activeVersion), CALIBRATION.bucketPriorN));
    }
    const total = perBucket.reduce((s, b) => s + b.n, 0);
    if (total >= CALIBRATION.switchMinGraded - EPS && perBucket[k].n >= CALIBRATION.bucketMinN - EPS) {
      const fitted = pav(perBucket.map((b) => ({ p: b.p, w: b.n })));
      return failClosed({ p: fitted[k], mode: "buckets", n: perBucket[k].n, mean: perBucket[k].mean });
    }
  }
  const high = rows.filter((r) => r.directionConfidence > CALIBRATION.fireMinConfidence);
  const pooled = paidPosterior(overlapWeights(high, activeVersion), CALIBRATION.pooledPriorN);
  return failClosed({ p: pooled.p, mode: "pooled", n: pooled.n, mean: pooled.mean });
}

// ---------------------------------------------------------------------------
// The summary the review stores and the dashboard shows
// ---------------------------------------------------------------------------

/** A decision's graded directional row (outcome HIT or MISS), or null. */
export function toGraded(d: DecisionRecord): GradedDecision | null {
  const o = d.outcome;
  if (!o || (o.status !== "HIT" && o.status !== "MISS") || (o.y !== 0 && o.y !== 1) || typeof o.paid !== "boolean") return null;
  if (d.direction !== "LONG" && d.direction !== "SHORT") return null;
  return {
    id: d.id,
    date: d.date,
    barCloseMs: d.barCloseMs,
    index: d.index,
    finalistKind: d.finalistKind,
    source: d.source,
    instructionVersion: d.instructionVersion,
    effective: d.effective,
    direction: d.direction,
    directionConfidence: d.directionConfidence,
    y: o.y,
    paid: o.paid,
  };
}

/** A decision's graded NEUTRAL row (outcome NEUTRAL with y set), or null. */
export function toGradedNeutral(d: DecisionRecord): GradedNeutral | null {
  const o = d.outcome;
  if (!o || o.status !== "NEUTRAL" || (o.y !== 0 && o.y !== 1) || d.direction !== "NEUTRAL") return null;
  return {
    id: d.id,
    date: d.date,
    barCloseMs: d.barCloseMs,
    index: d.index,
    finalistKind: d.finalistKind,
    source: d.source,
    instructionVersion: d.instructionVersion,
    effective: d.effective,
    directionConfidence: d.directionConfidence,
    y: o.y,
  };
}

const KINDS: readonly AgentFinalistKind[] = ["GENERIC", "IDEA"];
const SOURCES: readonly AgentDecisionSource[] = ["REFLEX", "ESCALATION"];
/** A confidence just above the firing threshold: the sizing probability the dashboard shows. */
const FIRING_CONFIDENCE = CALIBRATION.fireMinConfidence + 1e-6;

/**
 * The calibration of the decisions in force (both sources): Brier overall and by index, kind, version and source; the
 * base rate's Brier; the NEUTRAL line; buckets with hit and paid rates; and the sizing probability for a confidence
 * just above 0.80 with its effective n. Superseded reflex rows (effective false) are left out.
 */
export function calibrationSummary(graded: readonly GradedDecision[], activeVersion: string, nowMs: number, neutral: readonly GradedNeutral[] = []): CalibrationSummary {
  const inForce = graded.filter(
    (r) => r.effective && (r.direction === "LONG" || r.direction === "SHORT") && usable(r.directionConfidence) && (r.y === 0 || r.y === 1),
  );
  const py = (rows: readonly GradedDecision[]) => rows.map((r) => ({ p: r.directionConfidence, y: r.y }));
  const line = (rows: readonly GradedDecision[]) => ({ n: rows.length, brier: brier(py(rows)) });
  const versions = [...new Set(inForce.map((r) => r.instructionVersion))].sort();
  const neutralRows = neutral.filter((r) => r.effective && usable(r.directionConfidence) && (r.y === 0 || r.y === 1));
  const paidKnown = inForce.filter((r) => typeof r.paid === "boolean");
  const hint = sizingProbability(FIRING_CONFIDENCE, graded, activeVersion);
  return {
    asOfMs: nowMs,
    graded: inForce.length,
    brier: brier(py(inForce)),
    baselineBrier: baselineBrier(inForce),
    byIndex: INDEX_IDS.map((index) => ({ index, ...line(inForce.filter((r) => r.index === index)) })),
    byKind: KINDS.map((kind) => ({ kind, ...line(inForce.filter((r) => r.finalistKind === kind)) })),
    byVersion: versions.map((version) => ({ version, ...line(inForce.filter((r) => r.instructionVersion === version)) })),
    bySource: SOURCES.map((source) => ({ source, ...line(inForce.filter((r) => r.source === source)) })),
    neutral: {
      n: neutralRows.length,
      brier: brier(neutralRows.map((r) => ({ p: r.directionConfidence, y: r.y }))),
      baselineBrier: baselineBrier(neutralRows),
    },
    buckets: buckets(inForce.map((r) => ({ p: r.directionConfidence, y: r.y, paid: r.paid }))),
    sizingMode: hint.mode,
    sizingP: hint.p,
    sizingN: hint.n,
    paidRate: paidKnown.length > 0 ? paidKnown.filter((r) => r.paid).length / paidKnown.length : null,
  };
}
