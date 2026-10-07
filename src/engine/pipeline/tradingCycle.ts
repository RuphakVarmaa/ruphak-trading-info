/**
 * One tick of the trading loop. Identical in backtest, paper and live: only the injected
 * dependencies (clock, market data, quotes, broker, repository) differ.
 */
import { HOUR_MS, MINUTE_MS, istDate } from "../clock";
import { computePressure } from "../events/pressure";
import { computeFeatures } from "../market/features";
import type { EngineDeps } from "../ports";
import { combineConviction } from "../strategy/conviction";
import { planEntry } from "../strategy/planner";
import { classifyRegime } from "../strategy/regime";
import { rawComponents } from "../strategy/signals";
import type {
  Conviction,
  EventPressure,
  IndexId,
  MarketFeatures,
  MarketSnapshot,
  PlanDecision,
  QuoteRow,
  Regime,
  ScoredEvent,
  SessionPhase,
  SnapshotRecord,
} from "../types";
import { MARKET_SYMBOLS } from "../types";
import { haltReason } from "../risk/limits";
import { submitEntry } from "./execution";
import { loadRiskState } from "./riskState";

export interface TradingCycleOptions {
  /** Disable the event layer (no-events baseline in backtests). */
  noEvents?: boolean;
  /** Persist a decision at least this often per index even when nothing changes. */
  decisionEveryMs?: number;
  /** Persist a snapshot at most this often. */
  snapshotEveryMs?: number;
  /** Pre-loaded events (backtests); otherwise read from the repository. */
  events?: ScoredEvent[];
  /** Evaluate and persist decisions but submit no entries (DEGRADED engine, unhealthy relay). */
  noEntries?: string | null;
}

export interface CycleReport {
  t: number;
  phase: SessionPhase;
  features: Partial<Record<IndexId, MarketFeatures>>;
  convictions: Partial<Record<IndexId, Conviction>>;
  pressure: Partial<Record<IndexId, EventPressure>>;
  decisions: PlanDecision[];
  entries: { planId: string; orderId: string; status: string; positionId: string | null }[];
  halted: string | null;
  errors: string[];
  snapshot: MarketSnapshot | null;
}

const QUOTE_ROWS: { key: string; label: string; symbol: string }[] = [
  { key: "NIFTY", label: "NIFTY 50", symbol: MARKET_SYMBOLS.NIFTY },
  { key: "SENSEX", label: "SENSEX", symbol: MARKET_SYMBOLS.SENSEX },
  { key: "INDIAVIX", label: "INDIA VIX", symbol: MARKET_SYMBOLS.INDIAVIX },
  { key: "BANKNIFTY", label: "BANK NIFTY", symbol: MARKET_SYMBOLS.BANKNIFTY },
  { key: "USDINR", label: "USDINR", symbol: MARKET_SYMBOLS.USDINR },
  { key: "BRENT", label: "BRENT", symbol: MARKET_SYMBOLS.BZ },
  { key: "SPFUT", label: "S&P FUT", symbol: MARKET_SYMBOLS.ES },
];

/** Price, change versus the previous daily close, and observation time for the dashboard ticker. */
export function quoteRows(snap: MarketSnapshot): QuoteRow[] {
  const out: QuoteRow[] = [];
  for (const r of QUOTE_ROWS) {
    const intraday = snap.candles[r.symbol] ?? [];
    const daily = snap.daily[r.symbol] ?? [];
    const last = intraday[intraday.length - 1];
    const ltp = r.key === "NIFTY" || r.key === "SENSEX" || r.key === "BANKNIFTY" ? snap.ltp[r.key as "NIFTY"] : undefined;
    const price = ltp ?? last?.c ?? daily[daily.length - 1]?.c;
    if (price === undefined) continue;
    // Previous close: the last daily bar from an IST date before the latest observation's date.
    const obsDate = istDate(last ? last.t : snap.t);
    let prev: number | undefined;
    for (let i = daily.length - 1; i >= 0; i--) {
      if (istDate(daily[i].t) < obsDate) {
        prev = daily[i].c;
        break;
      }
    }
    const change = prev !== undefined ? price - prev : 0;
    const asOf = last ? Math.min(snap.t, last.t + 5 * MINUTE_MS) : snap.t;
    out.push({ key: r.key, label: r.label, price, change, changePct: prev ? (change / prev) * 100 : 0, asOf });
  }
  return out;
}

async function shouldPersistDecision(deps: EngineDeps, d: PlanDecision, everyMs: number): Promise<boolean> {
  const key = `decision:last:${d.index}`;
  const last = await deps.repo.state.get<{ t: number; stance: string }>(key);
  const persist = d.plan !== null || !last || last.stance !== d.conviction.stance || d.t - last.t >= everyMs;
  if (persist) await deps.repo.state.set(key, { t: d.t, stance: d.conviction.stance });
  return persist;
}

export async function runTradingCycle(deps: EngineDeps, opts: TradingCycleOptions = {}): Promise<CycleReport> {
  const { cfg, repo, logger } = deps;
  const now = deps.clock.now();
  const settings = await repo.settings.get();
  const calendar = settings.holidayOverrides.length > 0 ? deps.calendar.withOverrides(settings.holidayOverrides) : deps.calendar;
  const phase = calendar.sessionPhase(now);
  const report: CycleReport = { t: now, phase, features: {}, convictions: {}, pressure: {}, decisions: [], entries: [], halted: null, errors: [], snapshot: null };
  if (phase !== "OPEN" && phase !== "PRE_OPEN") return report;

  const snap = await deps.market.snapshot(now);
  report.snapshot = snap;
  const events = opts.events ?? (await repo.events.active(now - cfg.events.staleAfterHours * HOUR_MS));
  const perf = await repo.perf.all(deps.mode);
  const risk = await loadRiskState(repo, cfg, settings, now, deps.mode);
  const halt = haltReason(risk, cfg);
  report.halted = halt?.detail ?? opts.noEntries ?? null;
  const regimes: Partial<Record<IndexId, Regime>> = {};

  for (const index of cfg.indices) {
    try {
      const f = computeFeatures(index, snap, calendar, cfg);
      report.features[index] = f;
      deps.marketContext.set(index, { spot: f.spot, vix: f.vix, t: now });
      const p = opts.noEvents ? null : computePressure(events, index, now, cfg.events);
      if (p) report.pressure[index] = p;
      const regime = classifyRegime(f, p, cfg.regime).regime;
      regimes[index] = regime;
      const conviction = combineConviction(index, now, rawComponents(f, p, cfg, { noEvents: opts.noEvents }), regime, perf, cfg);
      report.convictions[index] = conviction;
      const decision = await planEntry({ index, t: now, features: f, pressure: p, conviction, risk, perf }, { ...deps, calendar });
      report.decisions.push(decision);
      if (await shouldPersistDecision(deps, decision, opts.decisionEveryMs ?? 5 * MINUTE_MS)) await repo.decisions.append(decision);

      if (decision.plan && phase === "OPEN" && !halt && !opts.noEntries) {
        const { order, position } = await submitEntry(deps, decision.plan, p);
        report.entries.push({ planId: decision.plan.id, orderId: order.id, status: order.status, positionId: position?.id ?? null });
        risk.ordersToday += 1;
        if (position) {
          risk.openPositions.push(position);
          risk.entriesToday[index] += 1;
        }
        logger.info("entry", { index, symbol: decision.plan.contract.tradingSymbol, qty: decision.plan.qty, status: order.status });
      }
    } catch (err) {
      const msg = `${index}: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(msg);
      logger.error("trading cycle error", { error: msg });
    }
  }

  const lastSnapKey = "snapshot:lastMs";
  const lastSnap = (await repo.state.get<number>(lastSnapKey)) ?? 0;
  if (now - lastSnap >= (opts.snapshotEveryMs ?? 55_000)) {
    const record: SnapshotRecord = {
      t: now,
      quotes: quoteRows(snap),
      features: report.features,
      regimes,
      pressure: Object.fromEntries(Object.entries(report.pressure).map(([k, v]) => [k, v!.epi])),
    };
    await repo.snapshots.append(record);
    await repo.state.set(lastSnapKey, now);
  }
  return report;
}
