/**
 * Deterministic fake backtest for the mock engine. Same params -> same numbers; changing
 * thresholdDelta, stops or the no-events switch changes trade count, hit rate and P&L in
 * the direction a real run would (stricter threshold: fewer, better trades).
 */
import {
  contractLabel,
  SIGNAL_SOURCE_LABELS,
  type BacktestParams,
  type BacktestResult,
  type BacktestTrade,
  type IndexId,
  type OrderReason,
  type SignalPerformanceRow,
  type SignalSource,
  type SourceStatus,
} from "@/engine/api-types";
import { addDays, istAt, nextWeeklyExpiry, toIstIso } from "@/lib/ist";
import { isMockHoliday, isMockTradingDay, LOT_SIZE, optionCharges, STRIKE_STEP } from "./fixtures";
import { clamp, gauss, hashString, mulberry32, round2 } from "./random";

const PRIOR_WEIGHTS: Record<SignalSource, number> = {
  EVENT: 0.3,
  TREND: 0,
  ORB: 0.15,
  MOMENTUM: 0.15,
  GAP: 0.1,
  MEAN_REVERSION: 0.15,
  RELATIVE_VALUE: 0.05,
  GLOBAL_BETA: 0.05,
  VOL_REGIME: 0,
};

const STARTING_EQUITY = 500_000;

function pickWeighted<T>(rand: () => number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function tradingDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 800; d = addDays(d, 1)) {
    if (isMockTradingDay(d)) days.push(d);
  }
  return days;
}

function attributionRow(source: SignalSource, trades: BacktestTrade[], noEvents: boolean): SignalPerformanceRow {
  const pcts = trades.map((t) => t.pnlPct);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const exp = mean(pcts);
  const t = trades.length > 1 && sd(pcts) > 0 ? exp / (sd(pcts) / Math.sqrt(trades.length)) : 0;
  let status: SourceStatus = "ACTIVE";
  let disabledReason: string | null = null;
  if (trades.length >= 20 && (exp < 0 || t < -1)) {
    status = "DISABLED";
    disabledReason = `Expectancy ${exp.toFixed(1)}% over ${trades.length} trades (t ${t.toFixed(2)})`;
  } else if (trades.length >= 10 && exp < 1) {
    status = "PROBATION";
    disabledReason = `Weak edge: expectancy ${exp.toFixed(1)}% over ${trades.length} trades`;
  }
  const last = trades.length ? trades[trades.length - 1].exitAt : null;
  return {
    source,
    label: SIGNAL_SOURCE_LABELS[source],
    index: "ALL",
    trades: trades.length,
    wins: wins.length,
    hitRate: trades.length ? round2(wins.length / trades.length) : 0,
    expectancyPct: round2(exp),
    expectancyRupees: round2(mean(trades.map((x) => x.pnl))),
    avgWinPct: round2(mean(wins.map((x) => x.pnlPct))),
    avgLossPct: round2(mean(losses.map((x) => x.pnlPct))),
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 99 : 0,
    tStat: round2(t),
    status,
    weight: source === "EVENT" && noEvents ? 0 : status === "DISABLED" ? 0 : PRIOR_WEIGHTS[source],
    disabledReason,
    lastTradeAt: last,
  };
}

export function simulateBacktest(runId: string, params: BacktestParams, startedAt: number, finishedAt: number): BacktestResult {
  const base: BacktestResult = {
    runId,
    status: "DONE",
    params,
    startedAt: toIstIso(startedAt),
    finishedAt: toIstIso(finishedAt),
    progress: 1,
    error: null,
    summary: null,
    equityCurve: [],
    trades: [],
    attribution: [],
    notes: [],
  };
  const days = tradingDaysBetween(params.from, params.to);
  if (days.length === 0) {
    return { ...base, status: "ERROR", error: "No trading days between the selected dates." };
  }

  const rand = mulberry32(hashString(JSON.stringify(params)));
  const indices: IndexId[] = params.index === "BOTH" ? ["NIFTY", "SENSEX"] : [params.index];
  const lambda = 0.55 * Math.exp(-3 * params.thresholdDelta) * (params.noEvents ? 0.8 : 1);
  const pWin = clamp(0.47 + 0.3 * params.thresholdDelta - (params.noEvents ? 0.05 : 0), 0.3, 0.65);
  const spot: Record<IndexId, number> = { NIFTY: 22100, SENSEX: 71050 };
  const sources: [SignalSource, number][] = params.noEvents
    ? [["MOMENTUM", 0.4], ["GAP", 0.2], ["GLOBAL_BETA", 0.25], ["RELATIVE_VALUE", 0.15]]
    : [["EVENT", 0.38], ["MOMENTUM", 0.27], ["GAP", 0.13], ["GLOBAL_BETA", 0.14], ["RELATIVE_VALUE", 0.08]];

  const trades: BacktestTrade[] = [];
  const equityCurve: { t: string; equity: number }[] = [];
  const dailyReturns: number[] = [];
  let equity = STARTING_EQUITY;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;
  let gross = 0;
  let charges = 0;
  let holdingTotal = 0;
  let realCount = 0;

  for (const day of days) {
    const dayStart = equity;
    for (const index of indices) {
      spot[index] *= 1 + 0.008 * gauss(rand);
      let n = 0;
      if (rand() < lambda) n++;
      if (rand() < lambda * 0.35) n++;
      for (let i = 0; i < n; i++) {
        const win = rand() < pWin;
        const side = rand() < 0.55 ? "BULL" : "BEAR";
        const step = STRIKE_STEP[index];
        const strike = Math.round(spot[index] / step) * step;
        const optionType = side === "BULL" ? "CE" : "PE";
        const expiry = nextWeeklyExpiry(index, istAt(day, "09:30"), isMockHoliday);
        const entry = Math.round((index === "NIFTY" ? 95 + 90 * rand() : 260 + 240 * rand()) * 20) / 20;
        let pct: number;
        let reason: OrderReason;
        if (win) {
          const r = rand();
          if (r < 0.38) [pct, reason] = [params.targetPct, "TARGET"];
          else if (r < 0.7) [pct, reason] = [params.targetPct * (0.25 + 0.45 * rand()), "TRAIL"];
          else if (r < 0.88) [pct, reason] = [8 + 20 * rand(), "TIME_STOP"];
          else [pct, reason] = [5 + 25 * rand(), "SQUARE_OFF"];
        } else {
          const r = rand();
          if (r < 0.55) [pct, reason] = [params.stopPct - 1.5 * rand(), "STOP"];
          else if (r < 0.75) [pct, reason] = [-(5 + 15 * rand()), "TIME_STOP"];
          else if (r < 0.9) [pct, reason] = [-(4 + 20 * rand()), "SIGNAL_FLIP"];
          else [pct, reason] = [-(6 + 18 * rand()), params.noEvents ? "SQUARE_OFF" : "EVENT_INVALIDATION"];
        }
        const exit = Math.max(0.05, Math.round(entry * (1 + pct / 100) * 20) / 20);
        const qty = LOT_SIZE[index];
        const tradeCharges = optionCharges("BUY", entry, qty, index).total + optionCharges("SELL", exit, qty, index).total;
        const tradeGross = (exit - entry) * qty;
        const pnl = round2(tradeGross - tradeCharges);
        const entryMin = 565 + Math.floor(rand() * 305);
        const hold = 15 + Math.floor(rand() * 165);
        const exitMin = Math.min(entryMin + hold, 905);
        const priceSource = rand() < 0.62 ? "real" : "synthetic";
        const conviction = (side === "BULL" ? 1 : -1) * Math.min(0.95, 0.36 + params.thresholdDelta + 0.4 * rand());
        trades.push({
          entryAt: toIstIso(istAt(day, entryMin)),
          exitAt: toIstIso(istAt(day, exitMin)),
          index,
          contractLabel: contractLabel({ index, expiry, strike, optionType }),
          side,
          entry,
          exit,
          qty,
          pnl,
          pnlPct: round2((pnl / (entry * qty)) * 100),
          exitReason: reason,
          dominantSource: pickWeighted(rand, sources),
          conviction: round2(conviction),
          priceSource,
        });
        equity = round2(equity + pnl);
        gross += tradeGross;
        charges += tradeCharges;
        holdingTotal += exitMin - entryMin;
        if (priceSource === "real") realCount++;
      }
    }
    dailyReturns.push((equity - dayStart) / dayStart);
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = (dd / peak) * 100;
    }
    equityCurve.push({ t: toIstIso(istAt(day, "15:30")), equity });
  }

  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const downside = dailyReturns.filter((r) => r < 0);
  const downsideDev = Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / Math.max(1, dailyReturns.length));
  const dailySd = sd(dailyReturns);

  const bySource = new Map<SignalSource, BacktestTrade[]>();
  for (const t of trades) bySource.set(t.dominantSource, [...(bySource.get(t.dominantSource) ?? []), t]);
  const attribution = (["EVENT", "MOMENTUM", "GAP", "RELATIVE_VALUE", "GLOBAL_BETA"] as SignalSource[])
    .filter((s) => !(params.noEvents && s === "EVENT"))
    .map((s) => attributionRow(s, bySource.get(s) ?? [], params.noEvents));

  const delta = params.thresholdDelta;
  const notes = [
    `Synthetic Black-Scholes prices (India VIX as IV proxy) for ${n ? Math.round(((n - realCount) / n) * 100) : 0}% of fills; the rest use Groww historical option candles.`,
    delta === 0
      ? "Regime thresholds at their defaults."
      : `Regime thresholds shifted by ${delta > 0 ? "+" : ""}${delta.toFixed(2)} in every regime.`,
    params.noEvents
      ? "Event layer disabled: no-events baseline. Compare against a run with events on to isolate the event edge."
      : "Event layer on: scored clusters become visible only 5 minutes after first publication (point-in-time).",
    `Stops ${params.stopPct}% / targets +${params.targetPct}% on premium; 15:05 IST square-off; charges per the 2026-04-01 Groww schedule.`,
    "Mock engine: a seeded, deterministic result for UI development, not a real replay.",
  ];

  return {
    ...base,
    summary: {
      trades: n,
      hitRate: n ? round2(wins.length / n) : 0,
      expectancyPct: round2(mean(trades.map((t) => t.pnlPct))),
      expectancyRupees: round2(mean(trades.map((t) => t.pnl))),
      netPnl: round2(equity - STARTING_EQUITY),
      grossPnl: round2(gross),
      charges: round2(charges),
      maxDrawdown: round2(maxDd),
      maxDrawdownPct: round2(maxDdPct),
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 99 : 0,
      sharpe: dailySd > 0 ? round2((mean(dailyReturns) / dailySd) * Math.sqrt(252)) : 0,
      sortino: downsideDev > 0 ? round2((mean(dailyReturns) / downsideDev) * Math.sqrt(252)) : 0,
      avgHoldingMin: n ? Math.round(holdingTotal / n) : 0,
      tradesPerDay: round2(n / days.length),
      realPriceShare: n ? round2(realCount / n) : 0,
    },
    equityCurve,
    trades,
    attribution,
    notes,
  };
}
