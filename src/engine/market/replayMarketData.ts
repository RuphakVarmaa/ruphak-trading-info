/**
 * Point-in-time MarketDataSource for backtests: the guarantee against look-ahead.
 *
 * snapshot(t) exposes
 * - 5m bars only when CLOSED and published: bar.t + 5 min <= t - lagMs (lagMs models Yahoo's delay);
 * - daily bars only for IST dates before t's IST date, and only once their close is final
 *   (bar.t + dailyFinalAfterMs(symbol) <= t, which matters for 24-hour assets around midnight IST);
 *   daily bars are built from the intraday bars when not supplied;
 * - ltp = the last visible 5m close of NIFTY / SENSEX / BANKNIFTY;
 * - dataAgeSec = t - close time of the freshest visible NIFTY/SENSEX bar.
 */
import { MINUTE_MS, istDate, istMidnight } from "../clock";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type FeatureIndexId, type MarketSnapshot } from "../types";
import { BAR_5M_MS, dailyFromIntraday, lastIndexAtOrBefore, normalizeCandles } from "./candles";
import { dailyFinalAfterMs } from "./crossAsset";
import { NO_DATA_AGE_SEC } from "./features";

const LTP_SYMBOLS: Record<FeatureIndexId, string> = {
  NIFTY: MARKET_SYMBOLS.NIFTY,
  SENSEX: MARKET_SYMBOLS.SENSEX,
  BANKNIFTY: MARKET_SYMBOLS.BANKNIFTY,
};
const FRESHNESS_SYMBOLS = [MARKET_SYMBOLS.NIFTY, MARKET_SYMBOLS.SENSEX];

export interface ReplayData {
  /** 5m bars keyed by MARKET_SYMBOLS value, any order (sorted and de-duplicated on construction). */
  candles: Record<string, Candle[]>;
  /** Daily bars keyed by symbol; symbols missing here get daily bars built from their 5m bars. */
  daily?: Record<string, Candle[]>;
}

export class ReplayMarketDataSource implements MarketDataSource {
  private readonly candles: Record<string, Candle[]> = {};
  private readonly daily: Record<string, Candle[]> = {};
  private readonly lagMs: number;

  constructor(data: ReplayData, opts: { lagMs?: number } = {}) {
    for (const [sym, arr] of Object.entries(data.candles)) this.candles[sym] = normalizeCandles(arr ?? []);
    for (const [sym, arr] of Object.entries(data.daily ?? {})) this.daily[sym] = normalizeCandles(arr ?? []);
    for (const [sym, arr] of Object.entries(this.candles)) {
      if (!this.daily[sym]) this.daily[sym] = dailyFromIntraday(arr);
    }
    this.lagMs = Math.max(0, opts.lagMs ?? 0);
  }

  /** Earliest and latest 5m bar open time across all symbols (for driving a backtest loop). */
  range(): { fromMs: number; toMs: number } | null {
    let from = Infinity;
    let to = -Infinity;
    for (const arr of Object.values(this.candles)) {
      if (arr.length === 0) continue;
      from = Math.min(from, arr[0].t);
      to = Math.max(to, arr[arr.length - 1].t);
    }
    return Number.isFinite(from) ? { fromMs: from, toMs: to } : null;
  }

  async snapshot(t: number): Promise<MarketSnapshot> {
    return this.snapshotSync(t);
  }

  /** Synchronous variant of snapshot() for tight backtest loops. */
  snapshotSync(t: number): MarketSnapshot {
    const cutoff = t - this.lagMs;
    const candles: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(this.candles)) {
      // Visible iff bar.t + 5m <= cutoff  <=>  bar.t <= cutoff - 5m.
      candles[sym] = arr.slice(0, lastIndexAtOrBefore(arr, cutoff - BAR_5M_MS) + 1);
    }
    const todayStart = istMidnight(istDate(t));
    const daily: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(this.daily)) {
      const finalAfter = dailyFinalAfterMs(sym);
      // Both conditions are monotone in bar.t, so the visible bars form a prefix.
      const limit = Math.min(todayStart - 1, t - finalAfter);
      daily[sym] = arr.slice(0, lastIndexAtOrBefore(arr, limit) + 1);
    }
    const ltp: Partial<Record<FeatureIndexId, number>> = {};
    for (const id of Object.keys(LTP_SYMBOLS) as FeatureIndexId[]) {
      const arr = candles[LTP_SYMBOLS[id]];
      if (arr && arr.length > 0) ltp[id] = arr[arr.length - 1].c;
    }
    let freshest = -Infinity;
    for (const sym of FRESHNESS_SYMBOLS) {
      const arr = candles[sym];
      if (arr && arr.length > 0) freshest = Math.max(freshest, arr[arr.length - 1].t + BAR_5M_MS);
    }
    const dataAgeSec = Number.isFinite(freshest) ? Math.max(0, (t - freshest) / 1000) : NO_DATA_AGE_SEC;
    return { t, candles, daily, ltp, dataAgeSec };
  }
}

/** 90 seconds: typical Yahoo publication delay to model in replays. */
export const YAHOO_LAG_MS = 1.5 * MINUTE_MS;
