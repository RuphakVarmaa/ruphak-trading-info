/**
 * One session of 5-minute index candles for the copy-trade chart: Yahoo bars with the engine's own
 * wick clipping, the running VWAP the engine uses (equal-weighted typical price, since Yahoo's index
 * bars carry no volume) and the 09:15–09:30 opening range.
 */
import { istAt, istDate, istIso } from "@/engine/clock";
import { clipWicks } from "@/engine/market/features";
import { vwapSeries } from "@/engine/market/indicators";
import type { YahooChart } from "@/engine/market/yahooClient";
import type { IndexId } from "@/engine/types";

export interface IntradayCandle {
  /** Bar open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface IntradayFeed {
  index: IndexId;
  /** IST date of the bars. */
  session: string;
  candles: IntradayCandle[];
  /** Running VWAP at each candle's close. */
  vwap: number[];
  /** High and low of 09:15–09:30; `complete` once all three bars are in. */
  openingRange: { high: number; low: number; complete: boolean } | null;
  /** Last close of the session before, from the same bars. */
  prevClose: number | null;
  last: number;
  /** IST ISO time of the last price. */
  asOf: string;
}

const BAR_MS = 5 * 60_000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Builds the feed for `date` (an IST date), or for the latest session in the chart when `date` is null.
 * Null when the chart has no bars for that day.
 */
export function buildIntraday(index: IndexId, chart: YahooChart, date: string | null): IntradayFeed | null {
  const bars = chart.candles.filter((c) => [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0));
  if (bars.length === 0) return null;
  const session = date ?? istDate(bars[bars.length - 1].t);
  const day = bars.filter((c) => istDate(c.t) === session && c.t >= istAt(session, "09:15") && c.t < istAt(session, "15:30")).map(clipWicks);
  if (day.length === 0) return null;
  const before = bars.filter((c) => istDate(c.t) < session);
  const orEnd = istAt(session, "09:30");
  const orBars = day.filter((c) => c.t < orEnd);
  const vw = vwapSeries(day);
  const last = day[day.length - 1];
  const isToday = session === istDate(chart.meta.regularMarketTime != null ? chart.meta.regularMarketTime * 1000 : last.t);
  const lastPrice = isToday && chart.meta.regularMarketPrice != null && chart.meta.regularMarketPrice > 0 ? chart.meta.regularMarketPrice : last.c;
  const lastMs = isToday && chart.meta.regularMarketTime != null ? chart.meta.regularMarketTime * 1000 : last.t + BAR_MS;
  return {
    index,
    session,
    candles: day.map((c) => ({ t: c.t, o: round2(c.o), h: round2(c.h), l: round2(c.l), c: round2(c.c) })),
    vwap: vw.map(round2),
    openingRange: orBars.length > 0 ? { high: round2(Math.max(...orBars.map((c) => c.h))), low: round2(Math.min(...orBars.map((c) => c.l))), complete: orBars.length >= 3 } : null,
    prevClose: before.length > 0 ? before[before.length - 1].c : null,
    last: round2(lastPrice),
    asOf: istIso(lastMs),
  };
}
