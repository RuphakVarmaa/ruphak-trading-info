/**
 * Pure builders for the continuous index feed (GET /api/market/live; contract in ./liveIndices): Yahoo
 * 1-minute charts in, LiveIndex and LiveVix entries out. No I/O; the shared upstream poll is ./liveSource.
 *
 * Yahoo facts these rely on (recorded 2026-10-08, see __fixtures__):
 * - Index bars carry no volume (always 0), so VWAP weighs every bar the same.
 * - Before the open, range=1d still returns the previous session's bars, ending with a 15:30 bar that holds
 *   the closing print (NIFTY 22,231.80 on 2026-10-08).
 * - The 1-minute chart's meta.previousClose is the close from two sessions back (22,776.10 that evening,
 *   the 2026-10-06 close), so the previous close comes from the daily chart instead (prevSessionClose).
 * - Single 1-minute bars can carry a bad print (SENSEX 15:25 low 71,188.60 under a day low of 71,327.75),
 *   so the day's high and low come from Yahoo's own day range (meta.regularMarketDayHigh/Low).
 */
import { istDate, istIso } from "@/engine/clock";
import type { YahooChart } from "@/engine/market/yahooClient";
import { MARKET_SYMBOLS } from "@/engine/types";
import { istTimeOn, openingRangeOf, runningVwap, type LiveIndex, type LiveIndexBar, type LiveIndexId, type LiveVix } from "./liveIndices";
import { checkedDayRange, niftySession } from "./niftyFeed";

export const LIVE_INDEX_SPECS: Record<LiveIndexId, { label: string; symbol: string }> = {
  NIFTY: { label: "NIFTY 50", symbol: MARKET_SYMBOLS.NIFTY },
  SENSEX: { label: "SENSEX", symbol: MARKET_SYMBOLS.SENSEX },
};
export const LIVE_INDEX_IDS: readonly LiveIndexId[] = ["NIFTY", "SENSEX"];
export const VIX_SYMBOL = MARKET_SYMBOLS.INDIAVIX;
export const LIVE_SOURCE = "Yahoo Finance 1-minute charts · may lag the exchange";

/** A parsed chart plus the meta fields the shared parser drops: Yahoo's day high and low for the day of the last trade. */
export interface LiveChart {
  chart: YahooChart;
  dayHigh: number | null;
  dayLow: number | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** India VIX moves in 0.0025 steps. */
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const positive = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Yahoo's last price and its time: the meta's last trade, else the last bar's close at its open time. */
export function lastQuote(chart: YahooChart): { price: number; ms: number } | null {
  const last = chart.candles[chart.candles.length - 1];
  const price = positive(chart.meta.regularMarketPrice) ? chart.meta.regularMarketPrice : last?.c;
  const ms = chart.meta.regularMarketTime != null ? chart.meta.regularMarketTime * 1000 : last?.t;
  return positive(price) && ms != null ? { price, ms } : null;
}

/**
 * IST date the last price belongs to. Its previous close is the close of the trading day before this
 * date (usually the bars' session too; they differ only if Yahoo quotes a new day before its first bar).
 */
export function quoteSession(chart: YahooChart): string | null {
  const q = lastQuote(chart);
  return q ? istDate(q.ms) : null;
}

/** IST date of the chart's bars: its last bar's day (the previous session before the open). */
export const barsSession = niftySession;

/** The session's 1-minute bars from 09:15 through the 15:30 closing print, rounded to the index's 2 decimals. */
export function sessionBars(chart: YahooChart, session: string): LiveIndexBar[] {
  const from = istTimeOn(session, "09:15");
  const to = istTimeOn(session, "15:30");
  return chart.candles
    .filter((c) => c.t >= from && c.t <= to && [c.o, c.h, c.l, c.c].every(positive))
    .map((c) => ({ t: c.t, o: round2(c.o), h: round2(c.h), l: round2(c.l), c: round2(c.c) }));
}

/** Session VWAP over `bars` (the last running value), 2 decimals; null without bars. */
export function sessionVwap(bars: readonly LiveIndexBar[]): number | null {
  const series = runningVwap(bars);
  return series.length > 0 ? round2(series[series.length - 1]) : null;
}

/**
 * The day's high and low. Yahoo's own day range when it is for the bars' session and agrees with them
 * (it holds the last price and every bar's close; see checkedDayRange), else the bars' extremes; null
 * without either.
 */
export function dayRange(src: LiveChart, bars: readonly LiveIndexBar[], price: number, sameDay: boolean): { high: number; low: number } | null {
  const checked = sameDay ? checkedDayRange({ high: src.dayHigh, low: src.dayLow }, bars.map((b) => b.c), price) : null;
  if (checked) return { high: round2(checked.high), low: round2(checked.low) };
  if (bars.length === 0) return null;
  return {
    high: round2(Math.max(...bars.map((b) => b.h), sameDay ? price : -Infinity)),
    low: round2(Math.min(...bars.map((b) => b.l), sameDay ? price : Infinity)),
  };
}

/**
 * One index from its 1-minute chart. `prevClose` is the close of the trading day before
 * quoteSession(chart) (see prevSessionClose); null leaves the change unknown. Null without a price.
 */
export function buildLiveIndex(id: LiveIndexId, src: LiveChart, prevClose: number | null): LiveIndex | null {
  const q = lastQuote(src.chart);
  if (!q) return null;
  const quoteDay = istDate(q.ms);
  const session = barsSession(src.chart) ?? quoteDay;
  const bars = sessionBars(src.chart, session);
  const price = round2(q.price);
  const prev = positive(prevClose) ? round2(prevClose) : null;
  const range = dayRange(src, bars, price, session === quoteDay);
  return {
    index: id,
    label: LIVE_INDEX_SPECS[id].label,
    symbol: LIVE_INDEX_SPECS[id].symbol,
    price,
    prevClose: prev,
    change: prev != null ? round2(price - prev) : null,
    changePct: prev != null ? round3(((price - prev) / prev) * 100) : null,
    open: bars[0]?.o ?? null,
    high: range?.high ?? null,
    low: range?.low ?? null,
    vwap: sessionVwap(bars),
    openingRange: openingRangeOf(bars, session),
    session,
    asOf: istIso(q.ms),
    bars,
  };
}

/** India VIX from its 1-minute chart (4 decimals); `prevClose` as for buildLiveIndex. Null without a value. */
export function buildLiveVix(chart: YahooChart, prevClose: number | null): LiveVix | null {
  const q = lastQuote(chart);
  if (!q) return null;
  const price = round4(q.price);
  const prev = positive(prevClose) ? round4(prevClose) : null;
  return {
    price,
    prevClose: prev,
    change: prev != null ? round4(price - prev) : null,
    changePct: prev != null ? round3(((price - prev) / prev) * 100) : null,
    asOf: istIso(q.ms),
  };
}
