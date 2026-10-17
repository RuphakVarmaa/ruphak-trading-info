/**
 * Loads backtest market history from Yahoo chart v8: 5-minute bars (Yahoo keeps ~60 days) for the
 * Indian indices and VIX, 5-minute bars for the last few days of cross-assets, and 6 months of
 * daily bars for everything. Runs in Workers and Node.
 */
import { MARKET_SYMBOLS, type Candle } from "../types";
import { fetchYahooChart } from "../market/yahooClient";
import { CROSS_ASSET_SYMBOLS, INDIAN_SYMBOLS } from "../market/yahooMarketData";
import type { FetchLike } from "../util/http";

export interface MarketHistory {
  candles: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
  errors: string[];
}

export async function loadYahooHistory(o: { fetchImpl?: FetchLike; intradayRange?: string; dailyRange?: string; concurrency?: number } = {}): Promise<MarketHistory> {
  const out: MarketHistory = { candles: {}, daily: {}, errors: [] };
  const tasks: (() => Promise<void>)[] = [];
  const add = (symbol: string, interval: "5m" | "1d", range: string, into: Record<string, Candle[]>) =>
    tasks.push(async () => {
      try {
        const chart = await fetchYahooChart(symbol, { interval, range, fetchImpl: o.fetchImpl as typeof fetch | undefined, timeoutMs: 20_000 });
        into[symbol] = chart.candles;
      } catch (err) {
        out.errors.push(`${symbol} ${interval}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  for (const s of INDIAN_SYMBOLS) add(s, "5m", o.intradayRange ?? "60d", out.candles);
  for (const s of CROSS_ASSET_SYMBOLS) add(s, "5m", "5d", out.candles);
  for (const s of [...INDIAN_SYMBOLS, ...CROSS_ASSET_SYMBOLS]) add(s, "1d", o.dailyRange ?? "6mo", out.daily);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  if (!out.candles[MARKET_SYMBOLS.NIFTY]?.length) out.errors.unshift("no NIFTY 5-minute history");
  return out;
}
