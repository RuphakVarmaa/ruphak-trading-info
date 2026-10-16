/**
 * The 30-minute outcome of a decision (SPEC §6 as amended: #13, #23). For a decision at bar close T the move is
 * ret30 = (close[T + 30 min] / close[T] − 1) × 100, in percent.
 * - LONG and SHORT: HIT (y = 1) when the move in the called direction is at least OUTCOME.deadbandPct, else MISS (a
 *   flat move is a miss: a flat option loses theta); `paid` when it is at least OUTCOME.payMovePct, the move a bought
 *   option needs to cover its costs (the sizing label).
 * - NEUTRAL: y = 1 when the index stayed within OUTCOME.neutralBandPct either way; scored on its own line.
 * - CENSORED: T + 30 min is after the session close (decisions after 15:00). MISSING: a close is not available.
 * Both closes come from one source, so source noise cannot flip a label at the 0.03% deadband: the settled bar
 * archive (D1 bars_5m) when it has both bars, else the closes stored with each bar. The source is recorded.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { istDate } from "../clock";
import { BAR_5M_MS } from "../market/candles";
import { OUTCOME } from "./constants";
import type { DecisionOutcome, DecisionRecord, OutcomeSource } from "./types";

/** The outcome horizon: OUTCOME.horizonBars five-minute bars. */
export const OUTCOME_HORIZON_MS = OUTCOME.horizonBars * BAR_5M_MS;
/** Labels compare at their limits with room for floating-point noise (10_003 / 10_000 − 1 is not exactly 0.0003). */
const EPS = 1e-9;

/** Bar close (epoch ms) → close, skipping closes that are not positive numbers; a later row for the same bar wins. */
export function closesMap(bars: readonly { barCloseMs: number; close: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of bars) if (Number.isFinite(b.barCloseMs) && Number.isFinite(b.close) && b.close > 0) out.set(b.barCloseMs, b.close);
  return out;
}

/** The archive's rows (D1 bars_5m, `t` = the bar's open) keyed by bar close, like closesMap. */
export function archiveClosesMap(rows: readonly { t: number; c: number }[]): Map<number, number> {
  return closesMap(rows.map((r) => ({ barCloseMs: r.t + BAR_5M_MS, close: r.c })));
}

/** True when the decision's 30-minute window ends after its session's close, so it can never be graded. */
export function outcomeCensored(barCloseMs: number, calendar: TradingCalendar): boolean {
  return barCloseMs + OUTCOME_HORIZON_MS > calendar.closeMs(istDate(barCloseMs));
}

function closesFrom(closes: ReadonlyMap<number, number> | undefined, t0: number, t1: number, source: OutcomeSource): { c0: number; c1: number; source: OutcomeSource } | null {
  const c0 = closes?.get(t0);
  const c1 = closes?.get(t1);
  return typeof c0 === "number" && typeof c1 === "number" && c0 > 0 && c1 > 0 ? { c0, c1, source } : null;
}

/**
 * Labels one decision as of nowMs. `closes` are the closes stored with each bar; `archive` the settled bar archive's
 * (archiveClosesMap), preferred when it has both bars. A window that has not ended by nowMs reads MISSING; gradeDay
 * leaves such decisions ungraded instead.
 */
export function labelDecision(
  d: Pick<DecisionRecord, "barCloseMs" | "direction">,
  closes: ReadonlyMap<number, number>,
  calendar: TradingCalendar,
  nowMs: number,
  archive?: ReadonlyMap<number, number>,
): DecisionOutcome {
  const none = (status: "CENSORED" | "MISSING"): DecisionOutcome => ({ status, y: null, ret30Pct: null, paid: null, source: null, gradedMs: nowMs });
  const t0 = d.barCloseMs;
  const t1 = t0 + OUTCOME_HORIZON_MS;
  if (outcomeCensored(t0, calendar)) return none("CENSORED");
  if (t1 > nowMs) return none("MISSING");
  const pair = closesFrom(archive, t0, t1, "BARS_5M") ?? closesFrom(closes, t0, t1, "STORED");
  if (!pair) return none("MISSING");
  const ret30Pct = (pair.c1 / pair.c0 - 1) * 100;
  if (d.direction === "NEUTRAL") {
    return { status: "NEUTRAL", y: Math.abs(ret30Pct) < OUTCOME.neutralBandPct - EPS ? 1 : 0, ret30Pct, paid: null, source: pair.source, gradedMs: nowMs };
  }
  const r = d.direction === "SHORT" ? -ret30Pct : ret30Pct;
  const hit = r >= OUTCOME.deadbandPct - EPS;
  return { status: hit ? "HIT" : "MISS", y: hit ? 1 : 0, ret30Pct, paid: r >= OUTCOME.payMovePct - EPS, source: pair.source, gradedMs: nowMs };
}
