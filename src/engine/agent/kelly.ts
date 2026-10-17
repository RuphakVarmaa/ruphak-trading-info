/**
 * Fractional Kelly for the agent (SPEC §5.3 as amended, #4): f* = p − (1 − p) / b, a quarter of it at most, then
 * capped at AGENT_LIMITS.maxRiskPctPerTrade of equity; f* ≤ 0 means no trade. p is the cautious calibrated chance of
 * a move that pays for an option (calibration.ts), never the model's stated confidence. b is the agent's own
 * measured win/loss ratio, shrunk toward the prior and held at or below it until enough trades have closed.
 */
import { kellyFraction } from "../strategy/sizing";
import { AGENT_LIMITS, CALIBRATION } from "./constants";
import type { AgentTradeRecord } from "./types";

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
/** A Kelly fraction this close to zero is zero: at the exact breakeven 0.4 − 0.6 / 1.5 leaves 5.6e-17. */
const KELLY_FLOOR = 1e-12;
const num = (x: number) => (Number.isFinite(x) ? String(Number(x.toFixed(4))) : String(x));

/**
 * The payoff ratio b from the agent's closed trades (net of charges, % of premium):
 * - measured = mean win % / mean |loss %|, null until there is at least one win and one loss;
 * - shrunk toward CALIBRATION.payoffPriorB with weight n / (n + payoffPriorN);
 * - held at min(b, payoffPriorB) until payoffMinTradesForMeasuredB trades have closed.
 * n is the number of closed trades (one per position).
 */
export function payoffRatio(trades: AgentTradeRecord[]): { b: number; n: number; measured: number | null } {
  const byPosition = new Map<string, number>();
  for (const t of trades) if (Number.isFinite(t.pnlPctPremium)) byPosition.set(t.positionId, t.pnlPctPremium);
  const pnl = [...byPosition.values()];
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x < 0).map((x) => -x);
  const n = pnl.length;
  const measured = wins.length > 0 && losses.length > 0 ? mean(wins) / mean(losses) : null;
  const prior = CALIBRATION.payoffPriorB;
  const shrunk = measured === null ? prior : (n * measured + CALIBRATION.payoffPriorN * prior) / (n + CALIBRATION.payoffPriorN);
  const b = n < CALIBRATION.payoffMinTradesForMeasuredB ? Math.min(shrunk, prior) : shrunk;
  return { b, n, measured };
}

/**
 * The share of equity to risk on one trade. kelly is the full Kelly fraction f*, quarterKelly a quarter of it (both
 * fractions); riskPct = min(quarterKelly × 100, AGENT_LIMITS.maxRiskPctPerTrade), in percent of equity, and 0 when
 * f* ≤ 0 (within floating-point noise) or an input is not a usable number.
 */
export function agentRiskPct(p: number, b: number): { kelly: number; quarterKelly: number; riskPct: number; reason: string } {
  if (!(p >= 0 && p <= 1) || !(b > 0 && Number.isFinite(b))) {
    return { kelly: 0, quarterKelly: 0, riskPct: 0, reason: `no trade: unusable sizing inputs (p=${num(p)}, b=${num(b)})` };
  }
  const kelly = kellyFraction(p, b, -1);
  if (!(kelly > KELLY_FLOOR)) return { kelly, quarterKelly: 0, riskPct: 0, reason: `Kelly ≤ 0: past calls have not cleared break-even (p=${num(p)}, b=${num(b)})` };
  const quarterKelly = AGENT_LIMITS.kellyFraction * kelly;
  const uncapped = quarterKelly * 100;
  const cap = AGENT_LIMITS.maxRiskPctPerTrade;
  if (uncapped > cap) return { kelly, quarterKelly, riskPct: cap, reason: `quarter Kelly ${num(uncapped)}% of equity, capped at ${cap}% (p=${num(p)}, b=${num(b)})` };
  return { kelly, quarterKelly, riskPct: uncapped, reason: `quarter Kelly ${num(uncapped)}% of equity (p=${num(p)}, b=${num(b)})` };
}
