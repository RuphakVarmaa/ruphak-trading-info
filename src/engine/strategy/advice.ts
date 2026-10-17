/**
 * Live entry advice while buying is paused: what the engine would buy right now, on its own signal
 * and its own trade checks, when the only checks failing are the measured-edge ones that pause its
 * book (EDGE_GATE=calibrated). The engine still books nothing; this is read by the dashboard's
 * "What to do now" strip so a person sees ENTER or WAIT live, with the contract and the levels.
 *
 * Kept in kv (`advice:latest:<index>`), not in the decisions table: that table is graded at the end
 * of the day and feeds the per-source performance, so writing to it more often would change the
 * signal weights. Written when the advice flips, when the contract changes, and at least every
 * ADVICE_REFRESH_MS while it says ENTER, so the premium and spot shown stay current.
 */
import type { EngineConfig } from "../config";
import { MINUTE_MS } from "../clock";
import type { Repository } from "../ports";
import type { GateResult, IndexId, OptionContract, PlanDecision, Quote, Regime, TradeSide } from "../types";
import { positionExitByMs } from "./rules";

/** The checks that pause the engine's own entries without saying anything against the signal. */
export const PAUSE_GATES: ReadonlySet<string> = new Set(["edge_calibrated", "move_calibrated"]);

/** While the advice says ENTER, it is re-written at least this often (the engine ticks every 30 s). */
export const ADVICE_REFRESH_MS = 60_000;
/** An ENTER older than this is not shown at all: the loop has stopped, or the session has moved on. */
export const ADVICE_MAX_AGE_MS = 15 * MINUTE_MS;

export const adviceKey = (index: IndexId) => `advice:latest:${index}`;

export interface SignalAdviceEnter {
  kind: "ENTER";
  /** When the engine's reading was made. */
  t: number;
  index: IndexId;
  decisionId: string;
  side: TradeSide;
  contract: OptionContract;
  /** The ask the reading saw. */
  premium: number;
  spot: number;
  regime: Regime;
  expectedMovePct: number | null;
  /** The engine's holding horizon for this regime, minutes (its time stop). */
  horizonMin: number;
  quoteSource: Quote["source"] | null;
  /** The checks pausing the engine's own entry (gate ids). */
  pausedBy: string[];
}

export interface SignalAdviceWait {
  kind: "WAIT";
  t: number;
  index: IndexId;
  decisionId: string;
}

export type SignalAdvice = SignalAdviceEnter | SignalAdviceWait;

/** Where the reading's premium came from, from the decision's quote gate ("groww bid 61.5 / ask 61.75"). */
export function decisionQuoteSource(gates: GateResult[]): Quote["source"] | null {
  const detail = gates.find((g) => g.gate === "quote")?.detail ?? "";
  const src = detail.split(" ")[0];
  return src === "groww" || src === "synthetic" || src === "upstox" || src === "groww-historical" || src === "replay" ? src : null;
}

/**
 * True when the engine would have entered but for the measured-edge pause: no plan, at least one
 * check failing, and every failing check one of PAUSE_GATES. A decision with no failing check has
 * a plan (the engine enters itself); one failing any other check is a WAIT with that reason.
 */
export function signalSaysEnter(d: Pick<PlanDecision, "plan" | "gates" | "contract" | "refPremium">): boolean {
  if (d.plan || !d.contract || d.refPremium === null || !(d.refPremium > 0)) return false;
  const failing = d.gates.filter((g) => g.passed === false);
  return failing.length > 0 && failing.every((g) => PAUSE_GATES.has(g.gate));
}

/** The engine's holding horizon from a reading, as the planner sets it on a plan. */
export function adviceHorizonMin(t: number, regime: Regime, cfg: EngineConfig): number {
  return Math.max(5, Math.min(cfg.exits.horizonMinByRegime[regime], Math.floor((positionExitByMs(t, cfg) - t) / MINUTE_MS)));
}

export function adviceOf(d: PlanDecision, spot: number, cfg: EngineConfig): SignalAdvice {
  if (!signalSaysEnter(d)) return { kind: "WAIT", t: d.t, index: d.index, decisionId: d.id };
  const c = d.conviction;
  return {
    kind: "ENTER",
    t: d.t,
    index: d.index,
    decisionId: d.id,
    side: c.score >= 0 ? "BULL" : "BEAR",
    contract: d.contract!,
    premium: d.refPremium!,
    spot,
    regime: c.regime,
    expectedMovePct: d.expectedMovePct,
    horizonMin: adviceHorizonMin(d.t, c.regime, cfg),
    quoteSource: decisionQuoteSource(d.gates),
    pausedBy: d.gates.filter((g) => g.passed === false).map((g) => g.gate),
  };
}

/** Writes the advice when it changed (or ENTER is due a refresh); returns what was written, else null. */
export async function recordAdvice(repo: Repository, d: PlanDecision, spot: number, cfg: EngineConfig): Promise<SignalAdvice | null> {
  const next = adviceOf(d, spot, cfg);
  const key = adviceKey(d.index);
  const last = await repo.state.get<SignalAdvice>(key);
  const changed =
    !last ||
    last.kind !== next.kind ||
    (last.kind === "ENTER" && next.kind === "ENTER" && (last.contract.tradingSymbol !== next.contract.tradingSymbol || next.t - last.t >= ADVICE_REFRESH_MS));
  if (!changed) return null;
  await repo.state.set(key, next);
  return next;
}
