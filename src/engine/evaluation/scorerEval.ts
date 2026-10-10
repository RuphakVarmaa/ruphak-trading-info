/**
 * Event-scorer evaluation: scores a labelled set of story clusters and measures direction
 * accuracy on directional labels, how often noise is (correctly) left neutral, rank correlation
 * with observed returns when labels carry them, and self-agreement between two runs.
 * Must pass before any rubric or model change ships (npm run eval:scorer).
 */
import type { EngineConfig } from "../config";
import { scoreClusters } from "../events/llm/scorer";
import type { ScoringContext } from "../events/llm/digest";
import type { LlmClient, LlmUsage } from "../ports";
import type { ArticleCluster, IndexId, ScoredEvent } from "../types";

export interface LabeledCluster {
  id: string;
  category: string;
  /** Expected NIFTY direction: -1 bearish, 0 neutral/noise, +1 bullish. */
  expected: -1 | 0 | 1;
  headlines: string[];
  /** Observed NIFTY return over the next session, when known. */
  ret1dPct?: number;
}

export interface EvalResult {
  n: number;
  directional: number;
  directionAccuracy: number;
  /** Share of neutral labels scored neutral. */
  neutralRate: number;
  /** Share of neutral labels given a directional score (false signals). */
  falseSignalRate: number;
  /** Spearman rank correlation between numeric score and ret1dPct (null without returns). */
  spearman: number | null;
  perCategory: Record<string, { n: number; correct: number }>;
  misses: { id: string; expected: number; got: number; numeric: number }[];
}

/** Scores with |numeric| below this are treated as neutral. */
export const NEUTRAL_BAND = 0.02;

export function toCluster(l: LabeledCluster, t: number): ArticleCluster {
  return {
    id: l.id,
    articleIds: l.headlines.map((_, i) => `${l.id}-${i}`),
    representativeTitle: l.headlines[0],
    headlines: l.headlines,
    urls: [],
    firstSeenMs: t,
    lastSeenMs: t,
    articleCount: Math.max(3, l.headlines.length * 3),
    sources: ["eval"],
    status: "UNSCORED",
  };
}

/** Direction the scorer assigned: the impact enum unless the story is irrelevant or immaterial. */
export function directionOf(e: ScoredEvent, index: IndexId = "NIFTY"): -1 | 0 | 1 {
  const imp = e.impact[index];
  if (e.indiaRelevance === "NONE" || imp.magnitude === "NONE") return 0;
  const d = imp.direction;
  if (d === "BULL" || d === "STRONG_BULL") return 1;
  if (d === "BEAR" || d === "STRONG_BEAR") return -1;
  const x = e.numeric[index];
  return x > NEUTRAL_BAND ? 1 : x < -NEUTRAL_BAND ? -1 : 0;
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((s, x) => s + x, 0) / rx.length;
  const my = ry.reduce((s, y) => s + y, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

export function evaluate(labels: LabeledCluster[], events: ScoredEvent[]): EvalResult {
  const byId = new Map(events.map((e) => [e.clusterId, e]));
  const perCategory: EvalResult["perCategory"] = {};
  const misses: EvalResult["misses"] = [];
  let directional = 0;
  let correct = 0;
  let neutralLabels = 0;
  let neutralKept = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const l of labels) {
    const e = byId.get(l.id);
    if (!e) continue;
    const got = directionOf(e);
    const cat = (perCategory[l.category] ??= { n: 0, correct: 0 });
    cat.n++;
    if (got === l.expected) cat.correct++;
    else misses.push({ id: l.id, expected: l.expected, got, numeric: Math.round(e.numeric.NIFTY * 1000) / 1000 });
    if (l.expected === 0) {
      neutralLabels++;
      if (got === 0) neutralKept++;
    } else {
      directional++;
      if (got === l.expected) correct++;
    }
    if (l.ret1dPct !== undefined) {
      xs.push(e.numeric.NIFTY);
      ys.push(l.ret1dPct);
    }
  }
  return {
    n: labels.length,
    directional,
    directionAccuracy: directional ? correct / directional : 0,
    neutralRate: neutralLabels ? neutralKept / neutralLabels : 0,
    falseSignalRate: neutralLabels ? 1 - neutralKept / neutralLabels : 0,
    spearman: spearman(xs, ys),
    perCategory,
    misses,
  };
}

/** Share of clusters given the same direction in two runs. */
export function selfAgreement(a: ScoredEvent[], b: ScoredEvent[]): number {
  const byId = new Map(b.map((e) => [e.clusterId, e]));
  let n = 0;
  let same = 0;
  for (const e of a) {
    const o = byId.get(e.clusterId);
    if (!o) continue;
    n++;
    if (directionOf(e) === directionOf(o)) same++;
  }
  return n ? same / n : 0;
}

/** Scores the labelled set with the production scorer (LLM when given, lexicon otherwise). */
export async function scoreLabeled(labels: LabeledCluster[], llm: LlmClient | null, cfg: EngineConfig, t: number): Promise<{ events: ScoredEvent[]; usage: LlmUsage; errors: string[] }> {
  const ctx: ScoringContext = {
    nowMs: t,
    market: { niftyRetTodayPct: null, sensexRetTodayPct: null, vix: null, vixChangePct: null },
    upcomingEvents: [],
    knownClusters: [],
  };
  const res = await scoreClusters(labels.map((l) => toCluster(l, t)), ctx, llm, cfg);
  return { events: res.events, usage: res.usage, errors: res.errors };
}
