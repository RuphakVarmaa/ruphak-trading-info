/** NIFTY 50 live feed for the Live P&L page: today's 1-minute bars from Yahoo plus the model option chain. */
import { istDate, istIso } from "@/engine/clock";
import type { YahooChart } from "@/engine/market/yahooClient";
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

export function buildNiftyFeed(nifty: YahooChart, vix: YahooChart | null, nowMs: number, wantExpiry: string | null): NiftyFeed | null {
  const spot = lastPrice(nifty);
  if (!spot) return null;
  const last = nifty.candles[nifty.candles.length - 1];
  const session = last ? istDate(last.t) : istDate(spot.ms);
  const today = nifty.candles.filter((c) => istDate(c.t) === session);
  const prevClose = nifty.meta.previousClose;
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
