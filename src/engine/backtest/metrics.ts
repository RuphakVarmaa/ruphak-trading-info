/** Backtest metrics: expectancy, hit rate, profit factor, Sharpe/Sortino on daily P&L, drawdown, attribution. */
import type { DayLedger, IndexId, SignalSource, TradeRecord } from "../types";
import { SIGNAL_SOURCES } from "../types";
import { mean, stdev } from "../util/math";

export interface Summary {
  trades: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  netPnl: number;
  grossPnl: number;
  charges: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  avgHoldingMin: number;
  tradesPerDay: number;
  /** Share of fills priced from real option data (vs the synthetic pricer). */
  realPriceShare: number;
  /** Charges as a share of gross profit on winning trades (friction). */
  costShare: number;
  days: number;
}

export interface SourceStats {
  source: SignalSource;
  index: IndexId | "ALL";
  trades: number;
  wins: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  tStat: number;
  /** P&L attributed by entry attribution shares (sums to net P&L across sources). */
  attributedPnl: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function profitFactor(pnls: number[]): number {
  const wins = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const losses = -pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0);
  if (losses === 0) return wins > 0 ? 99 : 0;
  return Math.min(99, wins / losses);
}

export function tStat(xs: number[]): number {
  if (xs.length < 2) return 0;
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / (sd / Math.sqrt(xs.length)) : 0;
}

/** Daily equity path from ledgers (sorted by date): start equity, then end-of-day equity per day. */
export function equityPath(ledgers: DayLedger[], startEquity: number): { date: string; equity: number; ret: number }[] {
  let equity = startEquity;
  return [...ledgers]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) => {
      const net = l.realized + l.unrealized - l.charges;
      const ret = equity > 0 ? net / equity : 0;
      equity += net;
      return { date: l.date, equity, ret };
    });
}

export function maxDrawdown(path: { equity: number }[], startEquity: number): { abs: number; pct: number } {
  let peak = startEquity;
  let abs = 0;
  let pct = 0;
  for (const p of path) {
    peak = Math.max(peak, p.equity);
    const dd = peak - p.equity;
    if (dd > abs) abs = dd;
    if (peak > 0 && dd / peak > pct) pct = dd / peak;
  }
  return { abs, pct };
}

export function summarize(trades: TradeRecord[], ledgers: DayLedger[], startEquity: number, realPriceShare = 0): Summary {
  const pnls = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.pnl > 0);
  const path = equityPath(ledgers, startEquity);
  const rets = path.map((p) => p.ret);
  const sd = stdev(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const dd = maxDrawdown(path, startEquity);
  const winGross = wins.reduce((s, t) => s + Math.max(0, t.grossPnl), 0);
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  return {
    trades: trades.length,
    hitRate: trades.length ? r4(wins.length / trades.length) : 0,
    expectancyPct: trades.length ? r2(mean(trades.map((t) => t.pnlPctPremium))) : 0,
    expectancyRupees: trades.length ? r2(mean(pnls)) : 0,
    netPnl: r2(pnls.reduce((s, p) => s + p, 0)),
    grossPnl: r2(trades.reduce((s, t) => s + t.grossPnl, 0)),
    charges: r2(charges),
    maxDrawdown: r2(dd.abs),
    maxDrawdownPct: r2(dd.pct * 100),
    profitFactor: r2(profitFactor(pnls)),
    sharpe: rets.length > 1 && sd > 0 ? r2((mean(rets) / sd) * Math.sqrt(252)) : 0,
    sortino: rets.length > 1 && downside > 0 ? r2((mean(rets) / downside) * Math.sqrt(252)) : 0,
    avgHoldingMin: trades.length ? Math.round(mean(trades.map((t) => t.holdingMin))) : 0,
    tradesPerDay: ledgers.length ? r2(trades.length / ledgers.length) : 0,
    realPriceShare: r4(realPriceShare),
    costShare: winGross > 0 ? r4(charges / winGross) : 0,
    days: ledgers.length,
  };
}

/** Per-source statistics by dominant source, plus P&L attributed by entry shares. */
export function attribution(trades: TradeRecord[]): SourceStats[] {
  const out: SourceStats[] = [];
  for (const source of SIGNAL_SOURCES) {
    const own = trades.filter((t) => t.dominantSource === source);
    const attributed = trades.reduce((s, t) => s + t.pnl * (t.attribution.find((a) => a.source === source)?.share ?? 0), 0);
    if (own.length === 0 && Math.abs(attributed) < 0.005) continue;
    const pct = own.map((t) => t.pnlPctPremium);
    const winsPct = pct.filter((p) => p > 0);
    const lossPct = pct.filter((p) => p <= 0);
    out.push({
      source,
      index: "ALL",
      trades: own.length,
      wins: own.filter((t) => t.pnl > 0).length,
      hitRate: own.length ? r4(own.filter((t) => t.pnl > 0).length / own.length) : 0,
      expectancyPct: own.length ? r2(mean(pct)) : 0,
      expectancyRupees: own.length ? r2(mean(own.map((t) => t.pnl))) : 0,
      avgWinPct: winsPct.length ? r2(mean(winsPct)) : 0,
      avgLossPct: lossPct.length ? r2(mean(lossPct)) : 0,
      profitFactor: r2(profitFactor(own.map((t) => t.pnl))),
      tStat: r2(tStat(pct)),
      attributedPnl: r2(attributed),
    });
  }
  return out;
}
