/**
 * Backtests replay real 5-minute index candles through the production trading and position
 * cycles (same code as paper and live) with a fixed clock, point-in-time market data,
 * point-in-time events (visible only `eventDelayMs` after first seen) and synthetic option
 * quotes priced from India VIX. Runs one trading day per step() so callers can chunk long runs.
 */
import { SIGNAL_SOURCE_LABELS, type BacktestParams, type BacktestResult, type BacktestTrade } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { accountConfig, type AccountId } from "../accounts";
import { MINUTE_MS, addDays, istAt, istDate, istIso } from "../clock";
import { makeConfig, withOverrides, type EngineConfig } from "../config";
import { YAHOO_LAG_MS } from "../market/replayMarketData";
import { runFollowerEntries } from "../pipeline/accountCycle";
import { runEndOfDay } from "../pipeline/dayLifecycle";
import { runPositionCycle } from "../pipeline/positionCycle";
import { runTradingCycle } from "../pipeline/tradingCycle";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import { MARKET_SYMBOLS, REGIMES, type Candle, type DayLedger, type IndexId, type Regime, type ScoredEvent, type TradeRecord } from "../types";
import { attribution, equityPath, summarize, type SourceStats, type Summary } from "./metrics";

export interface BacktestInput {
  cfg: EngineConfig;
  /** IST dates, inclusive. */
  from: string;
  to: string;
  /** 5-minute candles by Yahoo symbol, including warm-up history before `from`. */
  candles: Record<string, Candle[]>;
  daily?: Record<string, Candle[]>;
  /** Scored events (any time range); each becomes visible eventDelayMs after it was first seen. */
  events?: ScoredEvent[];
  noEvents?: boolean;
  /** Placebo: permute event first-seen times with this seed. */
  shuffleSeed?: number | null;
  /** Ingest + scoring latency before an event can be used (default 5 minutes). */
  eventDelayMs?: number;
  /** Decision step (default 5 minutes). */
  stepMs?: number;
  /** Market data publication lag (default Yahoo's ~90 s). */
  lagMs?: number;
  calendar?: TradingCalendar;
  /** Accounts that follow main's signals with their own config and book (e.g. the ₹10k account). */
  followers?: { account: AccountId; cfg: EngineConfig }[];
}

export interface BacktestOutput {
  from: string;
  to: string;
  days: string[];
  skippedDays: string[];
  trades: TradeRecord[];
  ledgers: DayLedger[];
  summary: Summary;
  attribution: SourceStats[];
  equityCurve: { t: number; equity: number }[];
  decisions: number;
  notes: string[];
}

/** Small seeded PRNG (mulberry32) for reproducible placebo shuffles. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Placebo: keeps every event but permutes when each was first seen. */
export function shuffleEventTimes(events: ScoredEvent[], seed: number): ScoredEvent[] {
  const rnd = seededRandom(seed);
  const times = events.map((e) => e.firstSeenMs);
  for (let i = times.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [times[i], times[j]] = [times[j], times[i]];
  }
  return events.map((e, i) => ({ ...e, firstSeenMs: times[i], scoredAtMs: times[i] }));
}

/** Engine config for dashboard backtest parameters. */
export function configForParams(base: EngineConfig, p: BacktestParams): EngineConfig {
  const thresholds = Object.fromEntries(REGIMES.map((r) => [r, Math.min(0.95, Math.max(0.05, base.conviction.thresholds[r] + (p.thresholdDelta || 0)))])) as Record<Regime, number>;
  return makeConfig({
    ...base,
    indices: p.index === "BOTH" ? base.indices : [p.index],
    conviction: { ...base.conviction, thresholds, counterTrendThreshold: Math.min(0.95, base.conviction.counterTrendThreshold + (p.thresholdDelta || 0)) },
    exits: { ...base.exits, stopPct: -Math.abs(p.stopPct || Math.abs(base.exits.stopPct)), targetPct: Math.abs(p.targetPct || base.exits.targetPct) },
  });
}

/**
 * Config for a follower account in a backtest: the account's config on top of `base`, with the
 * run's stop and target applied to the follower (main keeps its own exits).
 */
export function followerConfigForParams(base: EngineConfig, account: AccountId, p: BacktestParams): EngineConfig {
  const cfg = accountConfig(base, account);
  return withOverrides(cfg, { exits: { stopPct: -Math.abs(p.stopPct || Math.abs(cfg.exits.stopPct)), targetPct: Math.abs(p.targetPct || cfg.exits.targetPct) } });
}

export class BacktestRun {
  readonly days: string[];
  readonly skippedDays: string[] = [];
  private readonly deps: ReplayDeps;
  private readonly events: ScoredEvent[];
  private readonly calendar: TradingCalendar;
  private readonly stepMs: number;
  private readonly delayMs: number;
  private next = 0;
  private decisionCount = 0;
  private readonly followerDeps = new Map<AccountId, ReplayDeps>();

  constructor(private readonly input: BacktestInput) {
    this.calendar = input.calendar ?? new TradingCalendar();
    this.stepMs = Math.max(MINUTE_MS, input.stepMs ?? 5 * MINUTE_MS);
    this.delayMs = input.eventDelayMs ?? 5 * MINUTE_MS;
    const niftyDays = new Set((input.candles[MARKET_SYMBOLS.NIFTY] ?? []).map((c) => istDate(c.t)));
    const sensexDays = new Set((input.candles[MARKET_SYMBOLS.SENSEX] ?? []).map((c) => istDate(c.t)));
    const days: string[] = [];
    for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
      if (!this.calendar.isTradingDay(d)) continue;
      const needed = input.cfg.indices.every((i) => (i === "NIFTY" ? niftyDays : sensexDays).has(d));
      if (needed) days.push(d);
      else this.skippedDays.push(d);
    }
    this.days = days;
    let events = input.noEvents ? [] : [...(input.events ?? [])];
    if (input.shuffleSeed !== undefined && input.shuffleSeed !== null && events.length > 1) events = shuffleEventTimes(events, input.shuffleSeed);
    this.events = events.sort((a, b) => a.firstSeenMs - b.firstSeenMs);
    this.deps = createReplayDeps({
      cfg: input.cfg,
      startMs: istAt(days[0] ?? input.from, "09:00"),
      candles: input.candles,
      daily: input.daily,
      calendar: this.calendar,
      lagMs: input.lagMs ?? YAHOO_LAG_MS,
    });
    for (const f of input.followers ?? []) this.followerDeps.set(f.account, createFollowerDeps(this.deps, f.cfg, f.account));
  }

  get done(): boolean {
    return this.next >= this.days.length;
  }

  /** Fraction of trading days processed. */
  get progress(): number {
    return this.days.length === 0 ? 1 : this.next / this.days.length;
  }

  private visible(t: number): ScoredEvent[] {
    const out: ScoredEvent[] = [];
    for (const e of this.events) {
      if (e.firstSeenMs + this.delayMs > t) break;
      out.push(e);
    }
    return out;
  }

  /** Replays the next trading day. */
  async step(): Promise<string | null> {
    if (this.done) return null;
    const day = this.days[this.next++];
    const { deps } = this;
    // Decide just after each bar becomes visible (bar close + data lag), as the live loop would.
    const lag = this.input.lagMs ?? YAHOO_LAG_MS;
    const open = istAt(day, "09:15") + lag;
    const close = istAt(day, "15:30") + lag;
    for (let t = open; t <= close; t += this.stepMs) {
      deps.clock.set(t);
      const events = this.visible(t);
      const r = await runTradingCycle(deps, { events, noEvents: this.input.noEvents, decisionEveryMs: this.stepMs, snapshotEveryMs: 30 * MINUTE_MS });
      this.decisionCount += r.decisions.length;
      for (const f of this.followerDeps.values()) await runFollowerEntries(f, r, { decisionEveryMs: this.stepMs });
      await runPositionCycle(deps, { convictions: r.convictions, events });
      for (const f of this.followerDeps.values()) await runPositionCycle(f, { convictions: r.convictions, events });
    }
    deps.clock.set(istAt(day, "16:00"));
    await runEndOfDay(deps);
    for (const f of this.followerDeps.values()) await runEndOfDay(f, { grade: false, performance: false });
    return day;
  }

  async runAll(onDay?: (day: string, progress: number) => void): Promise<BacktestOutput> {
    while (!this.done) {
      const day = await this.step();
      if (day && onDay) onDay(day, this.progress);
    }
    return this.result();
  }

  /** Result for main, or for a follower account when `account` is given. */
  async result(account?: AccountId): Promise<BacktestOutput> {
    const { input } = this;
    const deps = account && account !== "main" ? this.followerDeps.get(account) : this.deps;
    if (!deps) throw new Error(`no follower account ${account} in this backtest`);
    const fromMs = istAt(input.from, "00:00");
    const toMs = istAt(addDays(input.to, 1), "00:00");
    const trades = (await deps.repo.trades.between(fromMs, toMs, "BACKTEST")).sort((a, b) => a.entryMs - b.entryMs);
    const ledgers = (await deps.repo.ledger.range(input.from, input.to, "BACKTEST")).sort((a, b) => a.date.localeCompare(b.date));
    const start = deps.cfg.capitalRupees;
    const path = equityPath(ledgers, start);
    const notes: string[] = [
      "Option prices are synthetic (Black-Scholes on India VIX with a modelled spread); real-price share is 0 until Groww option candles are wired in.",
      `Decisions every ${Math.round(this.stepMs / MINUTE_MS)} min on closed 5-minute bars with a ${Math.round((input.lagMs ?? YAHOO_LAG_MS) / 1000)} s data lag; exits are checked at the same cadence.`,
    ];
    if (deps !== this.deps) notes.push(`Account ${account}: follows main's signals with its own capital (₹${start.toLocaleString("en-IN")}), strike choice, sizing, loss caps and exits.`);
    if (input.noEvents) notes.push("No-events baseline: the event layer was disabled.");
    else if ((input.events ?? []).length === 0) notes.push("No scored events were supplied for this range, so the event layer contributed nothing.");
    else notes.push(`${this.events.length} scored events, each usable ${Math.round(this.delayMs / MINUTE_MS)} min after first seen.`);
    if (input.shuffleSeed !== undefined && input.shuffleSeed !== null) notes.push(`Placebo: event times shuffled (seed ${input.shuffleSeed}); a real edge should vanish here.`);
    if (this.skippedDays.length) notes.push(`Skipped ${this.skippedDays.length} trading day(s) without candles: ${this.skippedDays.slice(0, 5).join(", ")}${this.skippedDays.length > 5 ? "…" : ""}.`);
    return {
      from: input.from,
      to: input.to,
      days: this.days.slice(0, this.next),
      skippedDays: this.skippedDays,
      trades,
      ledgers,
      summary: summarize(trades, ledgers, start, 0),
      attribution: attribution(trades),
      equityCurve: [{ t: istAt(input.from, "09:15"), equity: start }, ...path.map((p) => ({ t: istAt(p.date, "15:30"), equity: Math.round(p.equity * 100) / 100 }))],
      decisions: this.decisionCount,
      notes,
    };
  }
}

export function runBacktest(input: BacktestInput, onDay?: (day: string, progress: number) => void): Promise<BacktestOutput> {
  return new BacktestRun(input).runAll(onDay);
}

/** Runs main and its follower accounts together; returns main's result and each follower's. */
export async function runBacktestAccounts(
  input: BacktestInput,
  onDay?: (day: string, progress: number) => void,
): Promise<{ main: BacktestOutput; followers: Partial<Record<AccountId, BacktestOutput>> }> {
  const run = new BacktestRun(input);
  const main = await run.runAll(onDay);
  const followers: Partial<Record<AccountId, BacktestOutput>> = {};
  for (const f of input.followers ?? []) followers[f.account] = await run.result(f.account);
  return { main, followers };
}

/** Converts a backtest output to the dashboard DTO. */
export function toBacktestResult(
  runId: string,
  params: BacktestParams,
  out: BacktestOutput | null,
  o: { startedMs: number; finishedMs: number | null; status: BacktestResult["status"]; progress: number; error?: string | null },
): BacktestResult {
  const trades: BacktestTrade[] = (out?.trades ?? []).map((t) => ({
    entryAt: istIso(t.entryMs),
    exitAt: istIso(t.exitMs),
    index: t.index as IndexId,
    contractLabel: t.tradingSymbol,
    side: t.side,
    entry: t.entryPremium,
    exit: t.exitPremium,
    qty: t.qty,
    pnl: t.pnl,
    pnlPct: Math.round(t.pnlPctPremium * 100) / 100,
    exitReason: t.exitReason,
    dominantSource: t.dominantSource,
    conviction: Math.round(t.convictionAtEntry * 1000) / 1000,
    priceSource: "synthetic",
  }));
  const s = out?.summary;
  return {
    runId,
    status: o.status,
    params,
    startedAt: istIso(o.startedMs),
    finishedAt: o.finishedMs ? istIso(o.finishedMs) : null,
    progress: Math.round(o.progress * 1000) / 1000,
    error: o.error ?? null,
    summary: s
      ? {
          trades: s.trades,
          hitRate: s.hitRate,
          expectancyPct: s.expectancyPct,
          expectancyRupees: s.expectancyRupees,
          netPnl: s.netPnl,
          grossPnl: s.grossPnl,
          charges: s.charges,
          maxDrawdown: s.maxDrawdown,
          maxDrawdownPct: s.maxDrawdownPct,
          profitFactor: s.profitFactor,
          sharpe: s.sharpe,
          sortino: s.sortino,
          avgHoldingMin: s.avgHoldingMin,
          tradesPerDay: s.tradesPerDay,
          realPriceShare: s.realPriceShare,
        }
      : null,
    equityCurve: (out?.equityCurve ?? []).map((p) => ({ t: istIso(p.t), equity: p.equity })),
    trades,
    attribution: (out?.attribution ?? []).map((a) => ({
      source: a.source,
      label: SIGNAL_SOURCE_LABELS[a.source],
      index: a.index,
      trades: a.trades,
      wins: a.wins,
      hitRate: a.hitRate,
      expectancyPct: a.expectancyPct,
      expectancyRupees: a.expectancyRupees,
      avgWinPct: a.avgWinPct,
      avgLossPct: a.avgLossPct,
      profitFactor: a.profitFactor,
      tStat: a.tStat,
      status: "ACTIVE",
      weight: 0,
      disabledReason: null,
      lastTradeAt: null,
    })),
    notes: out?.notes ?? [],
  };
}
