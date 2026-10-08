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

/** `prevClose` is the previous session's close (see prevSessionClose); null leaves the change unknown. */
export function buildNiftyFeed(nifty: YahooChart, vix: YahooChart | null, prevClose: number | null, nowMs: number, wantExpiry: string | null): NiftyFeed | null {
  const spot = lastPrice(nifty);
  if (!spot) return null;
  const session = niftySession(nifty) ?? istDate(spot.ms);
  const today = nifty.candles.filter((c) => istDate(c.t) === session);
  const v = vix ? lastPrice(vix) : null;
  const expiries = niftyExpiries(nowMs);
  const expiry = wantExpiry && expiries.includes(wantExpiry) ? wantExpiry : expiries[0];
  return {
    spot: spot.price,
    prevClose,
    change: prevClose != null ? spot.price - prevClose : null,
    changePct: prevClose ? ((spot.price - prevClose) / prevClose) * 100 : null,
    asOf: istIso(spot.ms),
    session,
    bars: today.map((c) => ({ t: c.t, c: c.c })),
    open: today[0]?.o ?? null,
    high: today.length ? Math.max(...today.map((c) => c.h)) : null,
    low: today.length ? Math.min(...today.map((c) => c.l)) : null,
    vix: v?.price ?? null,
    vixAsOf: v ? istIso(v.ms) : null,
    chain: v ? buildNiftyChain({ spot: spot.price, vix: v.price, nowMs, expiry, expiries }) : null,
  };
}
