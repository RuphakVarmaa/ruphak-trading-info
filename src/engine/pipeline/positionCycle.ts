/** Manages resting orders and open positions: chase/cancel, mark-to-market, exits, ledger. */
import { HOUR_MS } from "../clock";
import type { EngineDeps } from "../ports";
import { haltReason } from "../risk/limits";
import { evaluateExits, markPosition } from "../strategy/exits";
import type { Conviction, IndexId, Order, Position, Quote, ScoredEvent } from "../types";
import type { IndexContext } from "./marketContext";
import { applyExitFills, openPositionFromFills, persistResult, submitExit } from "./execution";
import { loadDayLedger, loadRiskState } from "./riskState";

export interface PositionCycleOptions {
  convictions?: Partial<Record<IndexId, Conviction>>;
  /** Pre-loaded events (backtests); otherwise read from the repository. */
  events?: ScoredEvent[];
}

export interface PositionReport {
  t: number;
  marked: number;
  exits: { positionId: string; reason: string; status: string }[];
  ordersRefreshed: number;
  ordersCancelled: number;
  errors: string[];
}

function eventsByKey(events: ScoredEvent[]): Map<string, ScoredEvent> {
  const m = new Map<string, ScoredEvent>();
  for (const e of events) {
    const cur = m.get(e.clusterKey);
    if (!cur || cur.scoredAtMs < e.scoredAtMs) m.set(e.clusterKey, e);
  }
  return m;
}

async function manageOpenOrders(deps: EngineDeps, report: PositionReport): Promise<void> {
  const now = deps.clock.now();
  const chaseMs = deps.cfg.broker.limitChaseTimeoutSec * 1000;
  for (const order of await deps.repo.orders.open(deps.mode)) {
    try {
      let res = await deps.broker.refreshOrder(order);
      report.ordersRefreshed++;
      let current: Order = res.order;
      const stale = now - order.createdMs >= chaseMs;
      if ((current.status === "OPEN" || current.status === "PARTIAL") && stale) {
        const cancelled = await deps.broker.cancelOrder(current);
        res = { order: cancelled.order, fills: [...res.fills, ...cancelled.fills] };
        current = cancelled.order;
        report.ordersCancelled++;
      }
      await persistResult(deps, res);
      if (current.reason === "ENTRY") {
        const plan = current.planId ? await deps.repo.plans.get(current.planId) : null;
        if (plan && res.fills.length > 0) await openPositionFromFills(deps, plan, current, res.fills, null);
      } else if (current.positionId) {
        const pos = await deps.repo.positions.get(current.positionId);
        if (pos && pos.status === "OPEN") {
          const updated = await applyExitFills(deps, pos, res.fills, current.reason);
          // An exit limit that timed out is replaced by a market order for the remainder.
          if (updated.status === "OPEN" && current.status === "CANCELLED") {
            await submitExit(deps, updated, { reason: current.reason, orderType: "MARKET", detail: "exit limit timed out; sending market order" });
          }
        }
      }
    } catch (err) {
      report.errors.push(`order ${order.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Why a quote must not drive exits right now, or null when it is usable: synthetic quotes need a
 * real spot and VIX, and every quote needs a positive bid or last price.
 */
export function exitPriceProblem(ctx: IndexContext, q: Quote): string | null {
  if (q.source === "synthetic" && !(ctx.spot > 0 && ctx.vix > 0)) return `no market data to price it (spot ${ctx.spot}, VIX ${ctx.vix})`;
  if (!(q.bid > 0 || q.ltp > 0)) return "the quote has no bid or last price";
  return null;
}

export async function runPositionCycle(deps: EngineDeps, opts: PositionCycleOptions = {}): Promise<PositionReport> {
  const { cfg, repo, logger } = deps;
  const now = deps.clock.now();
  const report: PositionReport = { t: now, marked: 0, exits: [], ordersRefreshed: 0, ordersCancelled: 0, errors: [] };
  await manageOpenOrders(deps, report);

  const settings = await repo.settings.get();
  const positions = await repo.positions.open(deps.mode);
  const pendingExit = new Set((await repo.orders.open(deps.mode)).filter((o) => o.reason !== "ENTRY").map((o) => o.positionId));
  const risk = await loadRiskState(repo, cfg, settings, now, deps.mode);
  const halt = haltReason(risk, cfg);
  const evByKey = eventsByKey(opts.events ?? (await repo.events.active(now - cfg.events.staleAfterHours * HOUR_MS)));
  let unrealized = 0;

  for (const p of positions) {
    try {
      const ctx = deps.marketContext.get(p.index);
      if (!ctx) {
        report.errors.push(`${p.index}: no market context to price ${p.contract.tradingSymbol}`);
        unrealized += p.unrealized;
        continue;
      }
      const q = await deps.optionQuotes.quote(p.contract, { t: now, spot: ctx.spot, vix: ctx.vix });
      const problem = exitPriceProblem(ctx, q);
      if (problem && !halt) {
        // Never mark or exit on a nonsense price (e.g. a synthetic quote priced off spot 0 after a
        // restart while market data is down): puts would look like jackpots and calls worthless.
        report.errors.push(`${p.contract.tradingSymbol}: exits paused, ${problem}`);
        unrealized += p.unrealized;
        continue;
      }
      const marked: Position = markPosition(p, q, now);
      report.marked++;
      if (pendingExit.has(p.id)) {
        await repo.positions.save(marked);
        unrealized += marked.unrealized;
        continue;
      }
      const decision = evaluateExits(marked, q, { nowMs: now, conviction: opts.convictions?.[p.index], eventsByKey: evByKey, haltReason: halt }, cfg);
      if (decision) {
        const { order, position } = await submitExit(deps, marked, decision);
        report.exits.push({ positionId: p.id, reason: decision.reason, status: order.status });
        if (position.status === "OPEN") unrealized += position.unrealized;
        logger.info("exit", { symbol: p.contract.tradingSymbol, reason: decision.reason, detail: decision.detail, status: order.status });
      } else {
        await repo.positions.save(marked);
        unrealized += marked.unrealized;
      }
    } catch (err) {
      report.errors.push(`${p.contract.tradingSymbol}: ${err instanceof Error ? err.message : String(err)}`);
      unrealized += p.unrealized;
    }
  }

  // Mark-to-market and intraday drawdown on the day ledger.
  const l = await loadDayLedger(repo, cfg, now, deps.mode);
  l.unrealized = unrealized;
  const equity = l.startEquity + l.realized + l.unrealized - l.charges;
  l.peakEquity = Math.max(l.peakEquity, equity);
  l.maxIntradayDrawdown = Math.max(l.maxIntradayDrawdown, l.peakEquity - equity);
  l.updatedMs = now;
  await repo.ledger.save(l);
  return report;
}
