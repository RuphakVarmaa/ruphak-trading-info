/** NIFTY 50 live feed for the Live P&L page: today's 1-minute bars from Yahoo plus the model option chain. */
import type { TradingCalendar } from "@/engine/calendar/calendar";
import { istDate, istIso } from "@/engine/clock";
import type { YahooChart } from "@/engine/market/yahooClient";
import type { Candle } from "@/engine/types";
import { buildNiftyChain, niftyExpiries, type NiftyChain } from "./niftyChain";

export interface NiftyFeed {
  spot: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** IST ISO time of the last trade Yahoo reports. */
  asOf: string;
  /** IST date of the bars (the previous session before the open). */
  session: string;
  /** 1-minute closes; `t` is the bar's open time in epoch ms. */
  bars: { t: number; c: number }[];
  open: number | null;
  high: number | null;
  low: number | null;
  vix: number | null;
  vixAsOf: string | null;
  chain: NiftyChain | null;
}

function lastPrice(chart: YahooChart): { price: number; ms: number } | null {
  const last = chart.candles[chart.candles.length - 1];
  const price = chart.meta.regularMarketPrice ?? last?.c ?? null;
  const ms = chart.meta.regularMarketTime != null ? chart.meta.regularMarketTime * 1000 : (last?.t ?? null);
  return price != null && price > 0 && ms != null ? { price, ms } : null;
}

/** IST date of the session in a 1-minute chart: its last bar's day (the previous session before the open). */
export function niftySession(chart: YahooChart): string | null {
  const last = chart.candles[chart.candles.length - 1];
  if (last) return istDate(last.t);
  return chart.meta.regularMarketTime != null ? istDate(chart.meta.regularMarketTime * 1000) : null;
}

/**
 * Close of the session before `session` from Yahoo's daily chart: the last daily bar dated before it,
 * rounded to the index's 2 decimals. (On the 1-minute chart `meta.previousClose` can be the close from
 * two sessions back, so it is not used.)
 * Yahoo leaves an Indian index's latest daily close empty for hours after the session (the parser drops
 * that bar), so the bar found can be a session too old. Given a calendar, a bar dated before the
 * previous trading day gives null rather than a wrong prior close.
 */
export function prevSessionClose(daily: YahooChart, session: string, calendar?: TradingCalendar): number | null {
  let bar: Candle | undefined;
  for (let i = daily.candles.length - 1; i >= 0; i--) {
    if (istDate(daily.candles[i].t) < session) {
      bar = daily.candles[i];
      break;
    }
  }
  if (!bar || !(bar.c > 0)) return null;
  if (calendar) {
    let expected: string | null = null;
    try {
      expected = calendar.prevTradingDay(session);
    } catch {
      expected = null; // no trading day within 30 days: nothing to check against
    }
    if (expected !== null && istDate(bar.t) < expected) return null;
  }
  return Math.round(bar.c * 100) / 100;
}

/**
 * Fallback for prevSessionClose while Yahoo's daily chart lacks the close: the last bar dated before
 * `session` in an intraday chart (5-minute, range 5d; the 15:30 closing print or the finalized 15:25 bar,
 * as the engine's features read it), only when that bar's IST date is the calendar's previous trading day.
 * A bar from two sessions back gives null. Rounded to `decimals` (2 for an index, 4 for India VIX).
 * For NIFTY this has matched the daily close; India VIX's last bar can differ from its daily close
 * (2026-10-07: 13.8975 against 13.89), so the daily close is preferred whenever Yahoo has it.
 */
export function prevCloseFromBars(chart: YahooChart, session: string, calendar: TradingCalendar, decimals = 2): number | null {
  let expected: string;
  try {
    expected = calendar.prevTradingDay(session);
  } catch {
    return null; // no trading day within 30 days
  }
  for (let i = chart.candles.length - 1; i >= 0; i--) {
    const bar = chart.candles[i];
    const day = istDate(bar.t);
    if (day >= session) continue;
    if (day !== expected || !(bar.c > 0)) return null;
    const f = 10 ** decimals;
    return Math.round(bar.c * f) / f;
  }
  return null;
}

/** Yahoo's own day high and low (chart meta regularMarketDayHigh/Low, which the shared parser drops). */
export interface DayRange {
  high: number | null;
  low: number | null;
}

/**
 * Yahoo's day range when it agrees with the session it is meant for: it holds the last price and every
 * bar's close. Null otherwise (or when absent). Preferred over the bars' extremes, which can carry a bad
 * print (SENSEX on 2026-10-08: a 15:25 bar low of 71,188.60 under a day low of 71,327.75).
 */
export function checkedDayRange(range: DayRange | null | undefined, closes: readonly number[], price: number): { high: number; low: number } | null {
  const hi = range?.high;
  const lo = range?.low;
  if (hi == null || lo == null || !Number.isFinite(hi) || !Number.isFinite(lo) || !(lo > 0) || lo > hi) return null;
  const EPS = 0.01;
  const inside = (x: number) => x >= lo - EPS && x <= hi + EPS;
  return inside(price) && closes.every(inside) ? { high: hi, low: lo } : null;
}

/**
 * `prevClose` is the previous session's close (see prevSessionClose); null leaves the change unknown.
 * `dayRange` (Yahoo's day high and low for the last trade's day) is used when it agrees with the bars.
 */
export function buildNiftyFeed(nifty: YahooChart, vix: YahooChart | null, prevClose: number | null, nowMs: number, wantExpiry: string | null, dayRange?: DayRange | null): NiftyFeed | null {
  const spot = lastPrice(nifty);
  if (!spot) return null;
  const session = niftySession(nifty) ?? istDate(spot.ms);
  const today = nifty.candles.filter((c) => istDate(c.t) === session);
  const v = vix ? lastPrice(vix) : null;
  const expiries = niftyExpiries(nowMs);
  const expiry = wantExpiry && expiries.includes(wantExpiry) ? wantExpiry : expiries[0];
  const range = istDate(spot.ms) === session ? checkedDayRange(dayRange, today.map((c) => c.c), spot.price) : null;
  return {
    spot: spot.price,
    prevClose,
    change: prevClose != null ? spot.price - prevClose : null,
    changePct: prevClose ? ((spot.price - prevClose) / prevClose) * 100 : null,
    asOf: istIso(spot.ms),
    session,
    bars: today.map((c) => ({ t: c.t, c: c.c })),
    open: today[0]?.o ?? null,
    high: range?.high ?? (today.length ? Math.max(...today.map((c) => c.h)) : null),
    low: range?.low ?? (today.length ? Math.min(...today.map((c) => c.l)) : null),
    vix: v?.price ?? null,
    vixAsOf: v ? istIso(v.ms) : null,
    chain: v ? buildNiftyChain({ spot: spot.price, vix: v.price, nowMs, expiry, expiries }) : null,
  };
}
