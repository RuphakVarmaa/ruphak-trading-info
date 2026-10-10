/**
 * Per-source edge measurement and decay control. A source whose rolling expectancy turns
 * negative (with enough trades) is disabled; it keeps producing shadow views, and is re-enabled
 * on PROBATION once its shadow record recovers.
 */
import type { EngineConfig } from "../config";
import { attributionShares } from "../strategy/conviction";
import type {
  IndexId,
  PlanDecision,
  SignalOutcome,
  SignalPerformance,
  SignalSource,
  TradeRecord,
  TradingMode,
} from "../types";
import { DIRECTIONAL_SOURCES, SIGNAL_SOURCES } from "../types";
import { mean, stdev } from "../util/math";

export interface TradeStats {
  n: number;
  wins: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  tStat: number;
}

export function tradeStats(trades: TradeRecord[]): TradeStats {
  const n = trades.length;
  if (n === 0) return { n: 0, wins: 0, hitRate: 0, expectancyPct: 0, expectancyRupees: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, tStat: 0 };
  const pct = trades.map((t) => t.pnlPctPremium);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const sd = stdev(pct);
  return {
    n,
    wins: wins.length,
    hitRate: wins.length / n,
    expectancyPct: mean(pct),
    expectancyRupees: mean(trades.map((t) => t.pnl)),
    avgWinPct: wins.length ? mean(wins.map((t) => t.pnlPctPremium)) : 0,
    avgLossPct: losses.length ? mean(losses.map((t) => t.pnlPctPremium)) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    tStat: sd > 0 ? (mean(pct) / sd) * Math.sqrt(n) : 0,
  };
}

/**
 * Shadow record from graded decisions: for each decision where the source held a clear view
 * (|value| >= 0.3), the underlying 60-minute return signed by that view. Measures whether a
 * disabled source would have been right, without needing counterfactual option trades.
 */
export function shadowStats(source: SignalSource, decisions: PlanDecision[], outcomes: Map<string, SignalOutcome>): { n: number; meanSignedRetPct: number } {
  const xs: number[] = [];
  for (const d of decisions) {
    const o = outcomes.get(d.id);
    if (!o || o.ret60m === null) continue;
    const comp = d.conviction.components.find((c) => c.source === source);
    if (!comp || Math.abs(comp.value) < 0.3) continue;
    xs.push(Math.sign(comp.value) * o.ret60m);
  }
  return { n: xs.length, meanSignedRetPct: mean(xs) };
}

export interface PerformanceInput {
  mode: TradingMode;
  nowMs: number;
  /** Recent closed trades, most recent first (at least windowTrades per source if available). */
  trades: TradeRecord[];
  /** Recent decisions and their graded outcomes, for shadow tracking. */
  decisions: PlanDecision[];
  outcomes: SignalOutcome[];
  previous: SignalPerformance[];
}

/** Recomputes performance rows for every (source, index) and (source, ALL) and applies decay rules. */
export function updatePerformance(input: PerformanceInput, cfg: EngineConfig): SignalPerformance[] {
  const d = cfg.decay;
  const outcomes = new Map(input.outcomes.map((o) => [o.decisionId, o]));
  const rows: SignalPerformance[] = [];
  const scopes: (IndexId | "ALL")[] = [...cfg.indices, "ALL"];
  for (const source of DIRECTIONAL_SOURCES) {
    for (const scope of scopes) {
      const trades = input.trades
        .filter((t) => t.dominantSource === source && (scope === "ALL" || t.index === scope))
        .slice(0, d.windowTrades);
      const st = tradeStats(trades);
      const prev = input.previous.find((p) => p.source === source && p.index === scope && p.mode === input.mode);
      const decisions = input.decisions.filter((x) => scope === "ALL" || x.index === scope);
      const shadow = shadowStats(source, decisions, outcomes);
      let status = prev?.status ?? "ACTIVE";
      let enabled = prev?.enabled ?? true;
      let disabledSinceMs = prev?.disabledSinceMs;
      let disabledReason = prev?.disabledReason;
      let probationSinceMs = prev?.probationSinceMs;
      const disable = (reason: string) => {
        enabled = false;
        status = "DISABLED";
        disabledSinceMs = input.nowMs;
        disabledReason = reason;
        probationSinceMs = undefined;
      };
      if (enabled && status === "PROBATION" && probationSinceMs !== undefined) {
        // On probation: judge only the trades taken since re-enabling.
        const since = trades.filter((t) => t.exitMs > probationSinceMs!);
        if (since.length >= d.probationTrades) {
          const ps = tradeStats(since);
          if (ps.expectancyPct >= 0) {
            status = "ACTIVE";
            probationSinceMs = undefined;
          } else {
            disable(`failed probation: expectancy ${ps.expectancyPct.toFixed(1)}% over ${ps.n} trades`);
          }
        }
      } else if (enabled && st.n >= d.disableMinTrades && (st.expectancyPct < d.disableIfExpectancyPctBelow || st.tStat < d.disableIfTStatBelow)) {
        disable(`expectancy ${st.expectancyPct.toFixed(1)}% and t-stat ${st.tStat.toFixed(2)} over ${st.n} trades`);
      } else if (!enabled && shadow.n >= d.reenableShadowTrades && shadow.meanSignedRetPct > 0) {
        enabled = true;
        status = "PROBATION";
        probationSinceMs = input.nowMs;
        disabledReason = undefined;
        disabledSinceMs = undefined;
      }
      rows.push({
        source,
        index: scope,
        mode: input.mode,
        windowTrades: st.n,
        hitRate: st.hitRate,
        expectancyPct: st.expectancyPct,
        expectancyRupees: st.expectancyRupees,
        avgWinPct: st.avgWinPct,
        avgLossPct: st.avgLossPct,
        profitFactor: Number.isFinite(st.profitFactor) ? st.profitFactor : 99,
        tStat: st.tStat,
        status,
        enabled,
        disabledSinceMs,
        disabledReason,
        probationSinceMs,
        shadowTrades: shadow.n,
        shadowExpectancyPct: shadow.meanSignedRetPct,
        weight: enabled ? cfg.conviction.priorWeights[source] : 0,
        lastTradeMs: trades[0]?.exitMs ?? prev?.lastTradeMs,
        updatedMs: input.nowMs,
      });
    }
  }
  return rows;
}

/** Splits a trade's net P&L across sources by its attribution shares (for reports). */
export function attributePnl(trades: TradeRecord[]): Record<SignalSource, number> {
  const out = Object.fromEntries(SIGNAL_SOURCES.map((s) => [s, 0])) as Record<SignalSource, number>;
  for (const t of trades) for (const a of t.attribution) out[a.source] += t.pnl * a.share;
  return out;
}

export { attributionShares };
