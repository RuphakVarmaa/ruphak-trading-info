/** Exit rules for an open long option position, evaluated in strict priority order. */
import type { EngineConfig } from "../config";
import type { Conviction, ExitDecision, Position, Quote, ScoredEvent } from "../types";

export interface ExitContext {
  nowMs: number;
  /** Latest conviction for the position's index. */
  conviction?: Conviction;
  /** Latest scores of the stories that drove the entry, by story key. */
  eventsByKey?: Map<string, ScoredEvent>;
  /** Engine-wide halt reason (kill switch, daily loss cap...). */
  haltReason?: { reason: "KILL_SWITCH" | "DAILY_LOSS_CAP"; detail: string } | null;
}

/** Updated mark, peak and excursions from a quote (marks at the bid: what we could sell for). */
export function markPosition(p: Position, q: Quote, nowMs: number): Position {
  const mark = q.bid > 0 ? q.bid : q.ltp;
  const peak = Math.max(p.peakPremium, mark);
  const pnlPct = ((mark - p.avgEntry) / p.avgEntry) * 100;
  return {
    ...p,
    markPremium: mark,
    markMs: nowMs,
    peakPremium: peak,
    unrealized: (mark - p.avgEntry) * p.qty,
    maePct: Math.min(p.maePct, pnlPct),
    mfePct: Math.max(p.mfePct, pnlPct),
  };
}

export function stopPrice(p: Position): number {
  return p.avgEntry * (1 + p.stops.stopPct / 100);
}

export function targetPrice(p: Position): number {
  return p.avgEntry * (1 + p.stops.targetPct / 100);
}

/** Trailing stop level once the trail is active, else null. */
export function trailPrice(p: Position): number | null {
  const activate = p.avgEntry * (1 + p.stops.trailActivatePct / 100);
  if (p.peakPremium < activate) return null;
  return p.peakPremium - (p.peakPremium - p.avgEntry) * (p.stops.trailGivebackPct / 100);
}

export function evaluateExits(p: Position, q: Quote, ctx: ExitContext, cfg: EngineConfig): ExitDecision | null {
  const mark = q.bid > 0 ? q.bid : q.ltp;
  if (ctx.haltReason) return { reason: ctx.haltReason.reason, orderType: "MARKET", detail: ctx.haltReason.detail };
  if (ctx.nowMs >= p.stops.squareOffMs) return { reason: "SQUARE_OFF", orderType: "MARKET", detail: "intraday square-off time" };
  if (mark <= stopPrice(p)) return { reason: "STOP", orderType: "MARKET", detail: `premium ${mark.toFixed(2)} at or below stop ${stopPrice(p).toFixed(2)}` };
  if (mark >= targetPrice(p)) return { reason: "TARGET", orderType: "LIMIT", limitPrice: q.bid, detail: `premium ${mark.toFixed(2)} reached target ${targetPrice(p).toFixed(2)}` };
  const trail = trailPrice({ ...p, peakPremium: Math.max(p.peakPremium, mark) });
  if (trail !== null && mark <= trail) return { reason: "TRAIL", orderType: "MARKET", detail: `gave back to ${mark.toFixed(2)} from peak ${p.peakPremium.toFixed(2)}` };
  const pnlPct = ((mark - p.avgEntry) / p.avgEntry) * 100;
  if (ctx.nowMs >= p.stops.timeStopMs && pnlPct < cfg.exits.timeStopMinPnlPct) {
    return { reason: "TIME_STOP", orderType: "MARKET", detail: `horizon elapsed with P&L ${pnlPct.toFixed(1)}%` };
  }
  const c = ctx.conviction;
  if (c) {
    const flip = c.threshold * cfg.exits.flipExitFraction;
    if ((p.side === "BULL" && c.score <= -flip) || (p.side === "BEAR" && c.score >= flip)) {
      return { reason: "SIGNAL_FLIP", orderType: "MARKET", detail: `conviction flipped to ${c.score.toFixed(2)}` };
    }
  }
  if (p.dominantSource === "EVENT" && p.eventKeysAtEntry.length > 0 && ctx.eventsByKey) {
    const want = p.side === "BULL" ? 1 : -1;
    const top = ctx.eventsByKey.get(p.eventKeysAtEntry[0]);
    if (top) {
      const n = top.numeric[p.index];
      if (Math.sign(n) !== want || Math.abs(n) < 0.02 || top.pricedIn === "MOSTLY") {
        return { reason: "EVENT_INVALIDATION", orderType: "MARKET", detail: `story "${top.title.slice(0, 60)}" re-scored to ${n.toFixed(2)}` };
      }
    }
  }
  return null;
}
