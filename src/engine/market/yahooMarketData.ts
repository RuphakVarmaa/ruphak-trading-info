/**
 * Live MarketDataSource backed by Yahoo chart v8 with in-memory caching. One instance lives inside
 * the trading Durable Object and is asked for a snapshot on every 30-second tick:
 * - ^NSEI ^BSESN ^NSEBANK ^INDIAVIX: 5m range=60d once per IST day, then range=1d at most every
 *   `intradayTtlMs` (default 60 s), spliced into the cache (fresh bars replace the window they cover);
 *   outside the session the incremental refresh stops once data fetched after the last close is in;
 * - cross-assets (US futures, crude, gold, DXY, USDINR, ^TNX, ^VIX, Nikkei, Hang Seng, Shanghai):
 *   5m range=5d at most every `crossTtlMs` (default 2 min), spliced the same way;
 * - daily range=6mo for every symbol once per IST day (or after `dailyTtlMs`); an Indian chart that
 *   does not have the last completed session yet is fetched again every 5 minutes until it does.
 * At most 4 requests run at once. A failing symbol never fails the snapshot: its stale data is kept
 * and the error is logged. An optional LtpProvider (Groww) overrides the index spot.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { DAY_MS, MINUTE_MS, istDate } from "../clock";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type FeatureIndexId, type MarketSnapshot } from "../types";
import { BAR_5M_MS, lastIndexAtOrBefore, spliceCandles } from "./candles";
import { NO_DATA_AGE_SEC } from "./features";
import { fetchYahooChart, type YahooChart, type YahooInterval } from "./yahooClient";

export interface LtpProvider {
  (): Promise<Partial<Record<FeatureIndexId, number>>>;
}

export const INDIAN_SYMBOLS: readonly string[] = [
  MARKET_SYMBOLS.NIFTY,
  MARKET_SYMBOLS.SENSEX,
  MARKET_SYMBOLS.BANKNIFTY,
  MARKET_SYMBOLS.INDIAVIX,
];

export const CROSS_ASSET_SYMBOLS: readonly string[] = [
  MARKET_SYMBOLS.ES,
  MARKET_SYMBOLS.NQ,
  MARKET_SYMBOLS.CL,
  MARKET_SYMBOLS.BZ,
  MARKET_SYMBOLS.GC,
  MARKET_SYMBOLS.DXY,
  MARKET_SYMBOLS.USDINR,
  MARKET_SYMBOLS.US10Y,
  MARKET_SYMBOLS.VIXUS,
  MARKET_SYMBOLS.N225,
  MARKET_SYMBOLS.HSI,
  MARKET_SYMBOLS.SSE,
];

const INDEX_SYMBOL: Record<FeatureIndexId, string> = {
  NIFTY: MARKET_SYMBOLS.NIFTY,
  SENSEX: MARKET_SYMBOLS.SENSEX,
  BANKNIFTY: MARKET_SYMBOLS.BANKNIFTY,
};

/** Indices whose freshness defines dataAgeSec (the traded ones). */
const FRESHNESS_INDICES: readonly FeatureIndexId[] = ["NIFTY", "SENSEX"];

const MAX_CONCURRENCY = 4;
const INDIAN_KEEP_MS = 70 * DAY_MS;
/** Yahoo publishes the last bars of a session within a few minutes of the 15:30 close. */
const CLOSE_SETTLE_MS = 10 * MINUTE_MS;
const CROSS_KEEP_MS = 10 * DAY_MS;
/** Retry interval for an Indian daily chart that does not have the last completed session yet. */
const DAILY_LAG_RETRY_MS = 5 * MINUTE_MS;

export interface YahooMarketDataOptions {
  calendar: TradingCalendar;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh interval for Indian 5m data (default 60 s). */
  intradayTtlMs?: number;
  /** Refresh interval for daily data (default 24 h; also refreshed when the IST date changes). */
  dailyTtlMs?: number;
  /** Refresh interval for cross-asset 5m data (default 2 min). */
  crossTtlMs?: number;
  /** Per-request timeout (default 10 s). */
  timeoutMs?: number;
  ltp?: LtpProvider;
  log?: (msg: string, data?: unknown) => void;
}

interface Task {
  symbol: string;
  interval: YahooInterval;
  range: string;
  apply: (chart: YahooChart) => void;
}

async function runPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export class YahooMarketDataSource implements MarketDataSource {
  private readonly calendar: TradingCalendar;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly intradayTtlMs: number;
  private readonly dailyTtlMs: number;
  private readonly crossTtlMs: number;
  private readonly timeoutMs: number;
  private readonly ltp?: LtpProvider;
  private readonly log: (msg: string, data?: unknown) => void;

  private readonly intraday = new Map<string, Candle[]>();
  private readonly daily = new Map<string, Candle[]>();
  /** Last regularMarketTime (epoch ms) per symbol, for honest freshness of forming bars. */
  private readonly marketTimeMs = new Map<string, number>();
  /** IST date of the last successful 60-day load per Indian symbol. */
  private readonly fullLoadDate = new Map<string, string>();
  private readonly lastIntradayAttempt = new Map<string, number>();
  /** Time of the last successful intraday fetch per symbol. */
  private readonly lastIntradayOk = new Map<string, number>();
  private readonly dailyLoadDate = new Map<string, string>();
  private readonly lastDailyAttempt = new Map<string, number>();
  private refreshing: Promise<void> | null = null;

  constructor(opts: YahooMarketDataOptions) {
    this.calendar = opts.calendar;
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? (() => Date.now());
    this.intradayTtlMs = opts.intradayTtlMs ?? 60_000;
    this.dailyTtlMs = opts.dailyTtlMs ?? DAY_MS;
    this.crossTtlMs = opts.crossTtlMs ?? 120_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.ltp = opts.ltp;
    this.log = opts.log ?? (() => {});
  }

  /** Refreshes whatever is due (single-flight: concurrent callers share one refresh). */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async snapshot(t: number): Promise<MarketSnapshot> {
    await this.refresh();
    const now = this.now();

    const candles: Record<string, Candle[]> = {};
    for (const [sym, arr] of this.intraday) candles[sym] = arr.slice(0, lastIndexAtOrBefore(arr, t) + 1);
    const daily: Record<string, Candle[]> = {};
    for (const [sym, arr] of this.daily) daily[sym] = arr.slice(0, lastIndexAtOrBefore(arr, t) + 1);

    // Default spot: Yahoo's latest price (the running close of the newest bar).
    const ltp: Partial<Record<FeatureIndexId, number>> = {};
    for (const id of Object.keys(INDEX_SYMBOL) as FeatureIndexId[]) {
      const arr = candles[INDEX_SYMBOL[id]];
      if (arr && arr.length > 0) ltp[id] = arr[arr.length - 1].c;
    }

    let freshest = -Infinity;
    if (this.ltp) {
      try {
        const live = await this.ltp();
        for (const id of Object.keys(INDEX_SYMBOL) as FeatureIndexId[]) {
          const v = live[id];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            ltp[id] = v;
            if (FRESHNESS_INDICES.includes(id)) freshest = now;
          }
        }
      } catch (err) {
        this.log("yahoo-market: LTP provider failed", { error: errMsg(err) });
      }
    }
    for (const id of FRESHNESS_INDICES) {
      const sym = INDEX_SYMBOL[id];
      const arr = candles[sym];
      if (!arr || arr.length === 0) continue;
      const last = arr[arr.length - 1];
      let obs = last.t + BAR_5M_MS;
      const mt = this.marketTimeMs.get(sym);
      if (mt !== undefined && mt >= last.t) obs = Math.min(obs, mt);
      obs = Math.min(obs, now);
      if (obs > freshest) freshest = obs;
    }
    const dataAgeSec = Number.isFinite(freshest) ? Math.max(0, (now - freshest) / 1000) : NO_DATA_AGE_SEC;

    return { t, candles, daily, ltp, dataAgeSec };
  }

  private async doRefresh(): Promise<void> {
    const now = this.now();
    const today = istDate(now);
    const tasks: Task[] = [];

    const sessionOpen = this.calendar.sessionPhase(now) === "OPEN";
    let settledAfter = Infinity;
    try {
      settledAfter = this.calendar.prevCloseMs(now) + CLOSE_SETTLE_MS;
    } catch {
      // No recent session in the calendar: keep refreshing on the TTL.
    }

    for (const sym of INDIAN_SYMBOLS) {
      const last = this.lastIntradayAttempt.get(sym);
      if (last !== undefined && now - last < this.intradayTtlMs) continue;
      const fullLoadDue = this.fullLoadDate.get(sym) !== today;
      const ok = this.lastIntradayOk.get(sym);
      // Market closed and we already hold everything published after the last close: nothing new can come.
      if (!fullLoadDue && !sessionOpen && ok !== undefined && ok >= settledAfter) continue;
      this.lastIntradayAttempt.set(sym, now);
      if (fullLoadDue) {
        // First load of the IST day (or a retry after a failed one): the full 60-day warm-up window.
        tasks.push({
          symbol: sym,
          interval: "5m",
          range: "60d",
          apply: (chart) => {
            this.mergeIntraday(sym, chart, now - INDIAN_KEEP_MS, now);
            this.fullLoadDate.set(sym, today);
          },
        });
      } else {
        tasks.push({ symbol: sym, interval: "5m", range: "1d", apply: (chart) => this.mergeIntraday(sym, chart, now - INDIAN_KEEP_MS, now) });
      }
    }

    for (const sym of CROSS_ASSET_SYMBOLS) {
      const last = this.lastIntradayAttempt.get(sym);
      if (last !== undefined && now - last < this.crossTtlMs) continue;
      this.lastIntradayAttempt.set(sym, now);
      tasks.push({ symbol: sym, interval: "5m", range: "5d", apply: (chart) => this.mergeIntraday(sym, chart, now - CROSS_KEEP_MS, now) });
    }

    // The last completed NSE/BSE session: an Indian daily chart without it is still incomplete.
    let prevSession: string | null = null;
    try {
      prevSession = this.calendar.prevTradingDay(today);
    } catch {
      // Outside the calendar's range: no completeness check.
    }
    for (const sym of [...INDIAN_SYMBOLS, ...CROSS_ASSET_SYMBOLS]) {
      const last = this.lastDailyAttempt.get(sym);
      const loadedToday = this.dailyLoadDate.get(sym) === today;
      const expired = last === undefined || now - last >= this.dailyTtlMs;
      // Failed daily loads are retried at the intraday cadence, successful ones once per day.
      const retryDue = last === undefined || now - last >= this.intradayTtlMs;
      // Yahoo can publish a session's daily close hours late (a null close is dropped), so an Indian
      // chart loaded before then is fetched again every few minutes until that session is in.
      const lastBar = this.daily.get(sym)?.at(-1);
      const lagging = INDIAN_SYMBOLS.includes(sym) && prevSession !== null && (!lastBar || istDate(lastBar.t) < prevSession);
      const laggingRetryDue = lagging && (last === undefined || now - last >= DAILY_LAG_RETRY_MS);
      if (loadedToday ? !expired && !laggingRetryDue : !retryDue) continue;
      this.lastDailyAttempt.set(sym, now);
      tasks.push({
        symbol: sym,
        interval: "1d",
        range: "6mo",
        apply: (chart) => {
          this.daily.set(sym, spliceCandles(this.daily.get(sym) ?? [], chart.candles));
          this.dailyLoadDate.set(sym, today);
        },
      });
    }

    if (tasks.length === 0) return;
    await runPool(
      tasks.map((task) => async () => {
        try {
          const chart = await fetchYahooChart(task.symbol, {
            interval: task.interval,
            range: task.range,
            fetchImpl: this.fetchImpl,
            timeoutMs: this.timeoutMs,
          });
          task.apply(chart);
        } catch (err) {
          this.log("yahoo-market: fetch failed, keeping cached data", {
            symbol: task.symbol,
            interval: task.interval,
            range: task.range,
            error: errMsg(err),
          });
        }
      }),
      MAX_CONCURRENCY,
    );
  }

  private mergeIntraday(sym: string, chart: YahooChart, keepFromMs: number, fetchedAt: number): void {
    this.lastIntradayOk.set(sym, fetchedAt);
    const merged = spliceCandles(this.intraday.get(sym) ?? [], chart.candles);
    let start = 0;
    while (start < merged.length && merged[start].t < keepFromMs) start++;
    this.intraday.set(sym, start > 0 ? merged.slice(start) : merged);
    const mt = chart.meta.regularMarketTime;
    if (mt !== null) this.marketTimeMs.set(sym, mt * 1000);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
