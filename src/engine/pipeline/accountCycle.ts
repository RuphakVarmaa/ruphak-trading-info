/**
 * Entries for an account that follows main's signals. Main's trading cycle has already computed
 * features, event pressure and conviction for this tick; the follower plans its own contract and
 * size against its own risk state, settings and book, and submits through its own broker. It never
 * recomputes signals, so both accounts act on the same view at the same moment.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS } from "../clock";
import type { EngineDeps } from "../ports";
import { haltReason } from "../risk/limits";
import { planEntry } from "../strategy/planner";
import type { PlanDecision } from "../types";
import { submitEntry } from "./execution";
import { loadRiskState } from "./riskState";
import { shouldPersistDecision, type CycleReport } from "./tradingCycle";

export interface FollowerOptions {
  /** Main's calendar with its holiday overrides applied. */
  calendar?: TradingCalendar;
  /** Evaluate but submit no entries (main is degraded). */
  noEntries?: string | null;
  decisionEveryMs?: number;
}

export interface FollowerReport {
  t: number;
  decisions: PlanDecision[];
  entries: { planId: string; orderId: string; status: string; positionId: string | null }[];
  halted: string | null;
  errors: string[];
}

export async function runFollowerEntries(deps: EngineDeps, signals: CycleReport, opts: FollowerOptions = {}): Promise<FollowerReport> {
  const { cfg, repo, logger } = deps;
  const now = signals.t;
  const report: FollowerReport = { t: now, decisions: [], entries: [], halted: null, errors: [] };
  if (signals.phase !== "OPEN" && signals.phase !== "PRE_OPEN") return report;

  const calendar = opts.calendar ?? deps.calendar;
  const settings = await repo.settings.get();
  const risk = await loadRiskState(repo, cfg, settings, now, deps.mode);
  const halt = haltReason(risk, cfg);
  report.halted = halt?.detail ?? opts.noEntries ?? null;
  const perf = signals.perf ?? [];

  for (const index of cfg.indices) {
    const features = signals.features[index];
    const conviction = signals.convictions[index];
    if (!features || !conviction) continue;
    try {
      const pressure = signals.pressure[index] ?? null;
      const decision = await planEntry({ index, t: now, features, pressure, conviction, risk, perf }, { ...deps, calendar });
      report.decisions.push(decision);
      if (await shouldPersistDecision(deps, decision, opts.decisionEveryMs ?? 5 * MINUTE_MS)) await repo.decisions.append(decision);

      if (decision.plan && signals.phase === "OPEN" && !halt && !opts.noEntries) {
        const { order, position } = await submitEntry(deps, decision.plan, pressure);
        report.entries.push({ planId: decision.plan.id, orderId: order.id, status: order.status, positionId: position?.id ?? null });
        risk.ordersToday += 1;
        if (position) {
          risk.openPositions.push(position);
          risk.entriesToday[index] += 1;
        }
        logger.info("follower entry", { index, symbol: decision.plan.contract.tradingSymbol, qty: decision.plan.qty, status: order.status });
      }
    } catch (err) {
      const msg = `${index}: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(msg);
      logger.error("follower cycle error", { error: msg });
    }
  }
  return report;
}
