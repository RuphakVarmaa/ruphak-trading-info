/** End-of-day job: grade decisions, update per-source performance and decay, close the ledger. */
import { DAY_MS, istDate, istMidnight } from "../clock";
import { gradeDecisions } from "../evaluation/outcomes";
import { updatePerformance } from "../evaluation/signalPerformance";
import type { EngineDeps } from "../ports";
import { MARKET_SYMBOLS, type IndexId, type SignalOutcome, type SignalPerformance } from "../types";
import { loadDayLedger } from "./riskState";

export interface EodReport {
  date: string;
  graded: number;
  performance: SignalPerformance[];
  openPositionsLeft: number;
  newlyDisabled: string[];
  reEnabled: string[];
}

export interface EndOfDayOptions {
  lookbackDays?: number;
  /** Grade today's decisions (false for accounts that follow main's signals: main grades them). */
  grade?: boolean;
  /** Update per-source performance (false for accounts that follow main's signals). */
  performance?: boolean;
}

export async function runEndOfDay(deps: EngineDeps, opts: EndOfDayOptions = {}): Promise<EodReport> {
  const { cfg, repo } = deps;
  const now = deps.clock.now();
  const date = istDate(now);
  const dayStart = istMidnight(date);

  // 1) Grade today's decisions with the day's 5-minute candles.
  let graded: SignalOutcome[] = [];
  if (opts.grade !== false) {
    const snap = await deps.market.snapshot(now);
    const candles: Record<string, typeof snap.candles[string]> = {};
    for (const index of cfg.indices) candles[index] = snap.candles[MARKET_SYMBOLS[index as IndexId]] ?? [];
    const decisions = await repo.decisions.between(dayStart, now);
    graded = gradeDecisions(decisions, candles, deps.calendar, now);
    await repo.outcomes.upsertMany(graded);
  }

  // 2) Per-source performance over recent trades, with shadow records from graded decisions.
  const lookback = (opts.lookbackDays ?? 30) * DAY_MS;
  const previous = await repo.perf.all(deps.mode);
  let perf = previous;
  if (opts.performance !== false) {
    perf = updatePerformance(
      {
        mode: deps.mode,
        nowMs: now,
        trades: await repo.trades.recent(cfg.decay.windowTrades * 6, deps.mode),
        decisions: await repo.decisions.between(now - lookback, now),
        outcomes: await repo.outcomes.between(now - lookback, now),
        previous,
      },
      cfg,
    );
    await repo.perf.upsertMany(perf);
  }
  const was = new Map(previous.map((p) => [`${p.source}:${p.index}`, p.enabled]));
  const newlyDisabled = perf.filter((p) => was.get(`${p.source}:${p.index}`) !== false && !p.enabled).map((p) => `${p.source}/${p.index}`);
  const reEnabled = perf.filter((p) => was.get(`${p.source}:${p.index}`) === false && p.enabled).map((p) => `${p.source}/${p.index}`);

  // 3) Close the day: nothing should be open after the square-off.
  const open = await repo.positions.open(deps.mode);
  const l = await loadDayLedger(repo, cfg, now, deps.mode);
  l.unrealized = open.reduce((s, p) => s + p.unrealized, 0);
  l.updatedMs = now;
  await repo.ledger.save(l);
  if (open.length > 0) deps.logger.warn("positions still open at end of day", { count: open.length });
  await repo.audit.append({ ts: now, actor: "engine", action: "end_of_day", detail: { graded: graded.length, newlyDisabled, reEnabled, open: open.length } });
  return { date, graded: graded.length, performance: perf, openPositionsLeft: open.length, newlyDisabled, reEnabled };
}
