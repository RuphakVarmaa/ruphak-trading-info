/**
 * Conservative fill simulation shared by the paper broker and the backtester:
 * buys pay the offer, sells receive the bid, market orders walk visible depth and pay
 * extra ticks for the remainder, limits fill only when the opposite side touches them.
 */
import type { Quote, Side } from "../types";
import { roundToTick } from "../util/math";

export interface FillResult {
  filledQty: number;
  /** Volume-weighted average fill price (0 when nothing filled). */
  avgPrice: number;
  /** Ticks paid beyond the touch on average (for reporting). */
  slippageTicks: number;
  reason?: string;
}

export interface FillParams {
  tickSize: number;
  slippageTicksMarket: number;
  depthLevels: number;
  /** Quotes older than this are treated as unusable. */
  maxQuoteAgeMs: number;
}

export function quoteProblem(q: Quote, nowMs: number, p: FillParams): string | null {
  if (!(q.bid > 0) || !(q.ask > 0)) return "no two-sided quote";
  if (q.ask < q.bid) return "crossed quote";
  if (nowMs - q.t > p.maxQuoteAgeMs) return `stale quote (${Math.round((nowMs - q.t) / 1000)} s old)`;
  return null;
}

export function marketFill(side: Side, qty: number, q: Quote, p: FillParams): FillResult {
  const levels = (side === "BUY" ? q.depth?.sell : q.depth?.buy)?.filter((l) => l.price > 0 && l.qty > 0).slice(0, p.depthLevels) ?? [];
  const touch = side === "BUY" ? q.ask : q.bid;
  let remaining = qty;
  let cost = 0;
  let lastPrice = touch;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.qty);
    cost += take * l.price;
    remaining -= take;
    lastPrice = l.price;
  }
  if (remaining > 0) {
    const dir = side === "BUY" ? 1 : -1;
    const px = Math.max(p.tickSize, roundToTick(lastPrice + dir * p.slippageTicksMarket * p.tickSize, p.tickSize));
    cost += remaining * px;
    remaining = 0;
  }
  const avg = cost / qty;
  return { filledQty: qty, avgPrice: Math.round(avg * 100) / 100, slippageTicks: Math.abs(avg - touch) / p.tickSize };
}

/** A limit order fills (fully, at its limit or better touch) only when the opposite side reaches it. */
export function limitFill(side: Side, qty: number, limit: number, q: Quote): FillResult {
  if (side === "BUY" && q.ask > 0 && q.ask <= limit) return { filledQty: qty, avgPrice: q.ask, slippageTicks: 0 };
  if (side === "SELL" && q.bid > 0 && q.bid >= limit) return { filledQty: qty, avgPrice: q.bid, slippageTicks: 0 };
  return { filledQty: 0, avgPrice: 0, slippageTicks: 0, reason: "limit not reached" };
}

/** Marketable limit price: touch plus a couple of ticks, capped relative to LTP (SEBI market-price protection style). */
export function marketableLimit(side: Side, q: Quote, tickSize: number, ticks = 2, capPct = 0.5): number {
  if (side === "BUY") {
    const px = roundToTick(q.ask + ticks * tickSize, tickSize, "up");
    const cap = q.ltp > 0 ? roundToTick(q.ltp * (1 + capPct / 100) + ticks * tickSize, tickSize, "up") : px;
    return Math.max(q.ask, Math.min(px, cap));
  }
  const px = roundToTick(q.bid - ticks * tickSize, tickSize, "down");
  const floor = q.ltp > 0 ? roundToTick(q.ltp * (1 - capPct / 100) - ticks * tickSize, tickSize, "down") : px;
  return Math.max(tickSize, Math.min(q.bid, Math.max(px, floor)));
}
