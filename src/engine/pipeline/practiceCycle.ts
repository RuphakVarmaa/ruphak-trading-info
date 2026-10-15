/**
 * Practice quota (paper only, the owner's request for 15 Oct 2026): at most one paper trade per hour
 * window from 09:30 to 14:30 on the main account, so the book shows live trades while the measured-edge
 * check keeps the engine's own entries paused. Each practice trade takes the hour's best pick (the
 * strongest TRIGGERED / READY / WATCHING setup, else the side of the stronger conviction) through the
 * normal planner with the edge checks relaxed, and the losing-streak check raised to the number of
 * windows (the owner chose "raise it for paper today"). Everything else stays: the session windows,
 * data freshness, quote and liquidity checks, sizing, the daily and weekly loss caps, the stop-out
 * cooldown and kill switch, the stop, target, trail, time stop and square-off. Practice trades carry a "practice" gate and are attributed to no
 * directional signal (VOL_REGIME), so they never change the signal weights. The research says such
 * trades lose on average; they are for watching the system work, not for copying.
 */
import { istDate, istParts } from "../clock";
import type { EngineConfig } from "../config";
import type { EngineDeps } from "../ports";
import { planEntry } from "../strategy/planner";
import type { SetupsRecord } from "../strategy/setups";
import type { Conviction, EventPressure, IndexId, MarketFeatures, RiskState, SignalPerformance } from "../types";
import { submitEntry } from "./execution";

export const PRACTICE_WINDOWS: readonly [number, number][] = [
  [9 * 60 + 30, 10 * 60 + 30],
  [10 * 60 + 30, 11 * 60 + 30],
  [11 * 60 + 30, 12 * 60 + 30],
  [12 * 60 + 30, 13 * 60 + 30],
  [13 * 60 + 30, 14 * 60 + 30],
];

/**
 * The PRACTICE_QUOTA Worker var: "main" (every session), "main:YYYY-MM-DD" (that IST date only), or
 * anything else (off). The owner asked for 15 Oct 2026, so production runs "main:2026-10-15".
 */
export function practiceQuotaOn(setting: string | undefined, nowMs: number): boolean {
  const v = (setting ?? "").trim();
  if (v === "main") return true;
  const m = /^main:(\d{4}-\d{2}-\d{2})$/.exec(v);
  return m !== null && m[1] === istDate(nowMs);
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function practiceWindow(nowMs: number): [number, number] | null {
  const m = istParts(nowMs).minutesOfDay;
  return PRACTICE_WINDOWS.find(([a, b]) => m >= a && m < b) ?? null;
}

export const practiceKey = (nowMs: number, w: [number, number]) => `practice:${istDate(nowMs)}:${hm(w[0])}`;

const STATUS_RANK: Record<string, number> = { TRIGGERED: 3, READY: 2, WATCHING: 1 };

export interface PracticeCandidate {
  index: IndexId;
  side: 1 | -1;
  rank: number;
  why: string;
}

/** The hour's picks, best first: live setups by status then score, then the conviction's side. */
export function practiceCandidates(
  indices: readonly IndexId[],
  convictions: Partial<Record<IndexId, Conviction>>,
  setups: Partial<Record<IndexId, SetupsRecord | null>>,
): PracticeCandidate[] {
  const out: PracticeCandidate[] = [];
  for (const index of indices) {
    const best = (setups[index]?.setups ?? [])
      .filter((s) => STATUS_RANK[s.status])
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.score - a.score)[0];
    if (best) {
      out.push({ index, side: best.side === "BULL" ? 1 : -1, rank: 100 * STATUS_RANK[best.status] + best.score, why: `${best.name} (${best.status}, score ${Math.round(best.score)})` });
      continue;
    }
    const c = convictions[index];
    if (c && c.score !== 0) out.push({ index, side: c.score > 0 ? 1 : -1, rank: Math.abs(c.score) * 100, why: `conviction ${c.score >= 0 ? "+" : ""}${c.score.toFixed(2)} (${c.regime})` });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** The planner's config for a practice entry: the edge checks off, the losing streak raised, everything else as configured. */
export function practiceConfig(cfg: EngineConfig): EngineConfig {
  return {
    ...cfg,
    gates: { ...cfg.gates, expectedMoveModel: "legacy", minEdgeRatio: -1e9, minExpectedVsImplied: 0, volCheapness: { ...cfg.gates.volCheapness, enabled: false } },
    risk: { ...cfg.risk, maxConsecutiveLossesPerDay: Math.max(cfg.risk.maxConsecutiveLossesPerDay, PRACTICE_WINDOWS.length) },
  };
}

export interface PracticeInput {
  now: number;
  features: Partial<Record<IndexId, MarketFeatures>>;
  convictions: Partial<Record<IndexId, Conviction>>;
  pressure: Partial<Record<IndexId, EventPressure>>;
  setups: Partial<Record<IndexId, SetupsRecord | null>>;
  risk: RiskState;
  perf: SignalPerformance[];
}

/** Takes at most one practice trade for the current window; returns what happened (for the log), or null. */
export async function runPracticeQuota(deps: EngineDeps, a: PracticeInput): Promise<string | null> {
  const w = practiceWindow(a.now);
  if (!w || deps.mode !== "PAPER") return null;
  const key = practiceKey(a.now, w);
  if (await deps.repo.state.get(key)) return null;
  const cfg = practiceConfig(deps.cfg);
  const tried: string[] = [];
  for (const cand of practiceCandidates(deps.cfg.indices, a.convictions, a.setups)) {
    const f = a.features[cand.index];
    const c = a.convictions[cand.index];
    if (!f || !c) continue;
    const score = cand.side * Math.max(Math.abs(c.score), c.threshold);
    const conviction: Conviction = { ...c, score, passes: true, stance: cand.side > 0 ? "BULLISH" : "BEARISH" };
    const decision = await planEntry(
      { index: cand.index, t: a.now, features: f, pressure: a.pressure[cand.index] ?? null, conviction, risk: a.risk, perf: a.perf },
      { ...deps, cfg },
    );
    if (!decision.plan) {
      tried.push(`${cand.index}: ${decision.noPlanReason ?? "no plan"}`);
      continue;
    }
    const plan = {
      ...decision.plan,
      dominantSource: "VOL_REGIME" as const,
      gates: [...decision.plan.gates, { gate: "practice", label: "Practice quota (paper)", passed: true, detail: `window ${hm(w[0])}–${hm(w[1])} IST: ${cand.why}` }],
    };
    const { order, position } = await submitEntry(deps, plan, a.pressure[cand.index] ?? null);
    await deps.repo.state.set(key, { t: a.now, index: cand.index, planId: plan.id, orderId: order.id, positionId: position?.id ?? null, why: cand.why });
    if (position) {
      a.risk.openPositions.push(position);
      a.risk.entriesToday[cand.index] += 1;
    }
    a.risk.ordersToday += 1;
    return `practice entry ${cand.index} ${plan.contract.tradingSymbol} (${cand.why}) ${order.status}`;
  }
  if (!tried.length) return null;
  await deps.repo.state.set("practice:lastSkip", { t: a.now, window: hm(w[0]), tried });
  return `practice: no entry this tick (${tried.join("; ")})`;
}
