/**
 * Wires EngineDeps for replays and backtests: fixed clock, replayed market data, synthetic option
 * quotes and instruments, and a paper broker in BACKTEST mode. The production cycles run unchanged.
 */
import type { AccountId } from "../accounts";
import { TradingCalendar } from "../calendar/calendar";
import { addDays, FixedClock, istDate } from "../clock";
import type { EngineConfig } from "../config";
import { PaperBroker } from "../broker/paperBroker";
import { InstrumentMaster } from "../instruments/instrumentMaster";
import { syntheticInstrumentRows } from "../instruments/syntheticInstruments";
import { ReplayMarketDataSource } from "../market/replayMarketData";
import { MarketContextStore } from "../pipeline/marketContext";
import type { EngineDeps, InstrumentProvider, Logger, OptionQuoteSource, Repository } from "../ports";
import { sequentialIds, silentLogger } from "../ports";
import { SyntheticOptionQuotes } from "../pricing/syntheticOptionPricer";
import { accountRepository } from "../repo/accountRepo";
import { InMemoryRepository } from "../repo/memory";
import type { Candle, IndexId } from "../types";
import { MARKET_SYMBOLS } from "../types";

export interface ReplayDepsOptions {
  cfg: EngineConfig;
  startMs: number;
  candles: Record<string, Candle[]>;
  daily?: Record<string, Candle[]>;
  calendar?: TradingCalendar;
  repo?: Repository;
  instruments?: InstrumentProvider;
  optionQuotes?: OptionQuoteSource;
  logger?: Logger;
  /** Simulated data lag (Yahoo is ~1-2 minutes behind). */
  lagMs?: number;
}

export type ReplayDeps = EngineDeps & { clock: FixedClock; market: ReplayMarketDataSource };

/** Synthetic instrument master covering every weekly expiry from `fromDate` to 5 weeks after `toDate`. */
export function syntheticInstruments(cfg: EngineConfig, calendar: TradingCalendar, fromDate: string, toDate: string, centers: Partial<Record<IndexId, number>>): InstrumentMaster {
  const rows = cfg.indices.flatMap((index) => {
    const center = centers[index];
    if (!center) return [];
    const expiries = calendar.expiriesBetween(index, fromDate, addDays(toDate, 35));
    // ±12% around the center covers large intraday moves.
    const count = Math.ceil((center * 0.12) / cfg.indexSpecs[index].strikeStep);
    return syntheticInstrumentRows(index, expiries, center, count, cfg);
  });
  return new InstrumentMaster(rows, cfg);
}

export function createReplayDeps(o: ReplayDepsOptions): ReplayDeps {
  const calendar = o.calendar ?? new TradingCalendar();
  const clock = new FixedClock(o.startMs);
  const repo = o.repo ?? new InMemoryRepository(o.cfg, o.startMs);
  const market = new ReplayMarketDataSource({ candles: o.candles, daily: o.daily }, { lagMs: o.lagMs ?? 0 });
  const range = market.range();
  const centers: Partial<Record<IndexId, number>> = {};
  for (const index of o.cfg.indices) {
    const arr = o.candles[MARKET_SYMBOLS[index]] ?? [];
    if (arr.length) centers[index] = arr[Math.floor(arr.length / 2)].c;
  }
  const instruments =
    o.instruments ??
    syntheticInstruments(o.cfg, calendar, istDate(range?.fromMs ?? o.startMs), istDate(range?.toMs ?? o.startMs), centers);
  const optionQuotes = o.optionQuotes ?? new SyntheticOptionQuotes(calendar, o.cfg);
  const marketContext = new MarketContextStore();
  const newId = sequentialIds("bt");
  const broker = new PaperBroker({
    cfg: o.cfg,
    clock,
    repo,
    quotes: optionQuotes,
    marketContext: (index) => marketContext.get(index),
    newId,
    mode: "BACKTEST",
    latencyMs: 0,
  });
  return {
    cfg: o.cfg,
    clock,
    calendar,
    repo,
    broker,
    market,
    optionQuotes,
    instruments,
    logger: o.logger ?? silentLogger,
    newId,
    mode: "BACKTEST",
    marketContext,
  };
}

/**
 * Deps for an account that follows `main` in a replay: same clock, calendar, market data, quotes,
 * instruments and market context; its own book (scoped on main's repository, as in production),
 * paper broker and id sequence, so main's ids and results do not change.
 */
export function createFollowerDeps(main: ReplayDeps, cfg: EngineConfig, account: AccountId): ReplayDeps {
  const repo = accountRepository(main.repo, account, cfg, () => main.clock.now());
  const newId = sequentialIds(`bt-${account}`);
  const broker = new PaperBroker({
    cfg,
    clock: main.clock,
    repo,
    quotes: main.optionQuotes,
    marketContext: (index) => main.marketContext.get(index),
    newId,
    mode: "BACKTEST",
    latencyMs: 0,
  });
  return { ...main, cfg, repo, broker, newId };
}
