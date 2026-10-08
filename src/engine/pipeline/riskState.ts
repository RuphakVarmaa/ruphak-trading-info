/** Builds the RiskState (today's ledger, open positions, counters) from the repository. */
import { istDate, istMidnight, istWeekStart } from "../clock";
import type { EngineConfig } from "../config";
import type { Repository } from "../ports";
import type { DayLedger, EngineSettings, IndexId, Order, RiskState, TradingMode } from "../types";
import { TERMINAL_ORDER_STATUSES } from "../types";

type PendingEntry = NonNullable<RiskState["pendingEntries"]>[number];

/** The slot an unfilled entry order holds: its index and direction (calls are bullish). */
export function pendingEntry(o: Pick<Order, "contract">): PendingEntry {
  return { index: o.contract.index, side: o.contract.type === "CE" ? "BULL" : "BEAR" };
}

/** True when an entry order was accepted but has no fill yet, so it may still fill. */
export function isPendingEntry(o: Pick<Order, "reason" | "status" | "filledQty">): boolean {
  return o.reason === "ENTRY" && o.filledQty === 0 && !TERMINAL_ORDER_STATUSES.includes(o.status);
}

export function newLedger(date: string, mode: TradingMode, startEquity: number, nowMs: number): DayLedger {
  return {
    date,
    mode,
    realized: 0,
    unrealized: 0,
    charges: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    ordersPlaced: 0,
    maxIntradayDrawdown: 0,
    peakEquity: startEquity,
    startEquity,
    updatedMs: nowMs,
  };
}

/** Equity at the start of `date`: capital plus all prior net P&L in this mode. */
export async function startingEquity(repo: Repository, cfg: EngineConfig, date: string, mode: TradingMode): Promise<number> {
  const prior = await repo.ledger.range("0000-01-01", date, mode);
  let eq = cfg.capitalRupees;
  for (const l of prior) if (l.date < date) eq += l.realized - l.charges;
  return eq;
}

export async function loadDayLedger(repo: Repository, cfg: EngineConfig, nowMs: number, mode: TradingMode): Promise<DayLedger> {
  const date = istDate(nowMs);
  const existing = await repo.ledger.get(date, mode);
  if (existing) return existing;
  return newLedger(date, mode, await startingEquity(repo, cfg, date, mode), nowMs);
}

export async function loadRiskState(repo: Repository, cfg: EngineConfig, settings: EngineSettings, nowMs: number, mode: TradingMode): Promise<RiskState> {
  const date = istDate(nowMs);
  const day = await loadDayLedger(repo, cfg, nowMs, mode);
  const week = await repo.ledger.range(istWeekStart(nowMs), date, mode);
  const weekRealized = week.filter((l) => l.date !== date).reduce((s, l) => s + l.realized - l.charges, 0) + (day.realized - day.charges);
  const openPositions = await repo.positions.open(mode);
  day.unrealized = openPositions.reduce((s, p) => s + p.unrealized, 0);
  const orders = await repo.orders.between(istMidnight(date), nowMs, mode);
  const entriesToday: Record<IndexId, number> = { NIFTY: 0, SENSEX: 0 };
  for (const o of orders) if (o.reason === "ENTRY" && o.filledQty > 0) entriesToday[o.contract.index]++;
  const closedToday = await repo.positions.closedBetween(istMidnight(date), nowMs, mode);
  const lastStopOutMs: Partial<Record<IndexId, number>> = {};
  for (const p of closedToday) {
    if (p.exitReason === "STOP" && p.exitMs !== undefined && (lastStopOutMs[p.index] ?? 0) < p.exitMs) lastStopOutMs[p.index] = p.exitMs;
  }
  // Entries still working without a fill: a partly filled one already has its position.
  const pendingEntries = (await repo.orders.open(mode)).filter(isPendingEntry).map(pendingEntry);
  const state: RiskState = {
    nowMs,
    settings,
    capitalRupees: cfg.capitalRupees,
    day,
    weekRealized,
    openPositions,
    ordersToday: orders.length,
    entriesToday,
    lastStopOutMs,
    pendingEntries,
  };
  if (cfg.sizing.useCurrentEquity) {
    // Small accounts size from what they have: capital plus prior net P&L, and only the cash not
    // already tied up in open premium (entry charges are already in today's charges).
    const openPremium = openPositions.reduce((s, p) => s + p.avgEntry * p.qty, 0);
    state.capitalRupees = day.startEquity;
    state.cashRupees = day.startEquity + day.realized - day.charges - openPremium;
  }
  return state;
}
