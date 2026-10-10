/**
 * Order execution and position bookkeeping shared by the trading and position cycles.
 * Every order and fill is persisted; positions and the day ledger are updated from fills.
 */
import { addCharges, ZERO_CHARGES } from "../broker/charges";
import { attributionShares } from "../strategy/conviction";
import type { EngineDeps, OrderResult } from "../ports";
import type { EventPressure, ExitDecision, Fill, Order, OrderReason, Position, TradePlan, TradeRecord } from "../types";
import { makeRefId } from "../util/refId";
import { loadDayLedger } from "./riskState";

export async function persistResult(deps: EngineDeps, res: OrderResult): Promise<void> {
  await deps.repo.orders.save(res.order);
  for (const f of res.fills) await deps.repo.fills.append(f);
}

async function bumpLedger(deps: EngineDeps, mutate: (l: Awaited<ReturnType<typeof loadDayLedger>>) => void): Promise<void> {
  const l = await loadDayLedger(deps.repo, deps.cfg, deps.clock.now(), deps.mode);
  mutate(l);
  l.updatedMs = deps.clock.now();
  await deps.repo.ledger.save(l);
}

const sumCharges = (fills: Fill[]) => fills.reduce((s, f) => s + f.charges.total, 0);

/** Opens (or grows) a position from entry fills. */
export async function openPositionFromFills(deps: EngineDeps, plan: TradePlan, order: Order, fills: Fill[], pressure: EventPressure | null): Promise<Position | null> {
  if (fills.length === 0) return null;
  const qty = fills.reduce((s, f) => s + f.qty, 0);
  const avg = fills.reduce((s, f) => s + f.price * f.qty, 0) / qty;
  const charges = sumCharges(fills);
  const existing = order.positionId ? await deps.repo.positions.get(order.positionId) : null;
  let pos: Position;
  if (existing && existing.status === "OPEN") {
    const totalQty = existing.qty + qty;
    pos = {
      ...existing,
      qty: totalQty,
      avgEntry: (existing.avgEntry * existing.qty + avg * qty) / totalQty,
      entryCharges: existing.entryCharges + charges,
    };
  } else {
    pos = {
      id: order.positionId ?? deps.newId(),
      planId: plan.id,
      index: plan.index,
      side: plan.side,
      contract: plan.contract,
      mode: deps.mode,
      qty,
      avgEntry: Math.round(avg * 100) / 100,
      entryMs: fills[0].t,
      entryCharges: charges,
      status: "OPEN",
      markPremium: avg,
      markMs: fills[0].t,
      peakPremium: avg,
      unrealized: 0,
      stops: plan.stops,
      horizonMin: plan.horizonMin,
      convictionAtEntry: plan.conviction.score,
      regimeAtEntry: plan.conviction.regime,
      dominantSource: plan.dominantSource,
      attribution: attributionShares(plan.conviction),
      eventKeysAtEntry: plan.dominantSource === "EVENT" ? (pressure?.topContributors ?? []).slice(0, 3).map((x) => x.clusterKey) : [],
      maePct: 0,
      mfePct: 0,
    };
  }
  await deps.repo.positions.save(pos);
  await bumpLedger(deps, (l) => {
    l.charges += charges;
  });
  return pos;
}

/** Submits the entry order for a plan; opens the position if it fills immediately. */
export async function submitEntry(deps: EngineDeps, plan: TradePlan, pressure: EventPressure | null): Promise<{ order: Order; position: Position | null }> {
  await deps.repo.plans.save(plan);
  const positionId = deps.newId();
  const res = await deps.broker.placeOrder({
    refId: makeRefId(deps.clock.now()),
    contract: plan.contract,
    side: "BUY",
    qty: plan.qty,
    type: plan.entryType,
    limitPrice: plan.limitPrice,
    product: deps.cfg.broker.product,
    reason: "ENTRY",
    planId: plan.id,
    positionId,
  });
  await persistResult(deps, res);
  await bumpLedger(deps, (l) => {
    l.ordersPlaced += 1;
  });
  const position = res.fills.length > 0 ? await openPositionFromFills(deps, plan, res.order, res.fills, pressure) : null;
  await deps.repo.audit.append({
    ts: deps.clock.now(),
    actor: "engine",
    action: "entry_order",
    entity: "order",
    entityId: res.order.id,
    detail: { planId: plan.id, symbol: plan.contract.tradingSymbol, qty: plan.qty, status: res.order.status, error: res.order.error },
  });
  return { order: res.order, position };
}

/** Applies exit fills to a position; closes it (with a trade record) when fully exited. */
export async function applyExitFills(deps: EngineDeps, position: Position, fills: Fill[], reason: OrderReason): Promise<Position> {
  if (fills.length === 0) return position;
  const qty = fills.reduce((s, f) => s + f.qty, 0);
  const avgExitNow = fills.reduce((s, f) => s + f.price * f.qty, 0) / qty;
  const exitCharges = sumCharges(fills);
  const exitedBefore = position.exitedQty ?? 0;
  const exitedQty = exitedBefore + qty;
  const avgExit = ((position.avgExit ?? 0) * exitedBefore + avgExitNow * qty) / exitedQty;
  const gross = (avgExitNow - position.avgEntry) * qty;
  const remaining = position.qty - qty;
  const now = fills[fills.length - 1].t;
  const updated: Position = {
    ...position,
    qty: Math.max(0, remaining),
    avgExit: Math.round(avgExit * 100) / 100,
    realized: (position.realized ?? 0) + gross,
    exitCharges: (position.exitCharges ?? 0) + exitCharges,
    exitedQty,
  };
  if (remaining <= 0) {
    updated.status = "CLOSED";
    updated.exitMs = now;
    updated.exitReason = reason;
    updated.unrealized = 0;
    updated.qty = exitedQty; // report the full traded quantity on the closed position
  }
  await deps.repo.positions.save(updated);
  const totalCharges = position.entryCharges + (updated.exitCharges ?? 0);
  await bumpLedger(deps, (l) => {
    l.realized += gross;
    l.charges += exitCharges;
    if (updated.status === "CLOSED") {
      const net = (updated.realized ?? 0) - totalCharges;
      l.trades += 1;
      if (net >= 0) {
        l.wins += 1;
        l.consecutiveLosses = 0;
      } else {
        l.losses += 1;
        l.consecutiveLosses += 1;
      }
    }
  });
  if (updated.status === "CLOSED") {
    const grossPnl = updated.realized ?? 0;
    const net = grossPnl - totalCharges;
    const trade: TradeRecord = {
      positionId: updated.id,
      index: updated.index,
      side: updated.side,
      mode: updated.mode,
      tradingSymbol: updated.contract.tradingSymbol,
      entryMs: updated.entryMs,
      exitMs: now,
      holdingMin: Math.round((now - updated.entryMs) / 60_000),
      entryPremium: updated.avgEntry,
      exitPremium: updated.avgExit ?? avgExitNow,
      qty: exitedQty,
      pnl: Math.round(net * 100) / 100,
      grossPnl: Math.round(grossPnl * 100) / 100,
      pnlPctPremium: (net / (updated.avgEntry * exitedQty)) * 100,
      charges: Math.round(totalCharges * 100) / 100,
      maePct: updated.maePct,
      mfePct: updated.mfePct,
      regime: updated.regimeAtEntry,
      exitReason: reason,
      convictionAtEntry: updated.convictionAtEntry,
      dominantSource: updated.dominantSource,
      attribution: updated.attribution,
    };
    await deps.repo.trades.append(trade);
    await deps.repo.audit.append({ ts: now, actor: "engine", action: "position_closed", entity: "position", entityId: updated.id, detail: { reason, pnl: trade.pnl } });
  }
  return updated;
}

/** Sends the exit order for a position (MARKET, or a LIMIT at the bid for targets). */
export async function submitExit(deps: EngineDeps, position: Position, decision: ExitDecision): Promise<{ order: Order; position: Position }> {
  const res = await deps.broker.placeOrder({
    refId: makeRefId(deps.clock.now(), "X"),
    contract: position.contract,
    side: "SELL",
    qty: position.qty,
    type: decision.orderType,
    limitPrice: decision.limitPrice,
    product: deps.cfg.broker.product,
    reason: decision.reason,
    planId: position.planId,
    positionId: position.id,
  });
  await persistResult(deps, res);
  await bumpLedger(deps, (l) => {
    l.ordersPlaced += 1;
  });
  const updated = await applyExitFills(deps, position, res.fills, decision.reason);
  await deps.repo.audit.append({
    ts: deps.clock.now(),
    actor: "engine",
    action: "exit_order",
    entity: "order",
    entityId: res.order.id,
    detail: { positionId: position.id, reason: decision.reason, detail: decision.detail, status: res.order.status },
  });
  return { order: res.order, position: updated };
}

export function chargesOf(fills: Fill[]) {
  return fills.reduce((acc, f) => addCharges(acc, f.charges), ZERO_CHARGES);
}

