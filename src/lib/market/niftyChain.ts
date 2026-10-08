/**
 * NIFTY option chain priced by the engine's own model: Black-Scholes on India VIX with the
 * modelled spread (src/engine/pricing/syntheticOptionPricer.ts). These are the prices paper
 * trades fill at; they are not exchange quotes.
 */
import { defaultCalendar, type TradingCalendar } from "@/engine/calendar/calendar";
import { istDate } from "@/engine/clock";
import { DEFAULT_CONFIG, type EngineConfig } from "@/engine/config";
import { syntheticQuote, syntheticVol } from "@/engine/pricing/syntheticOptionPricer";
import type { OptionContract, OptionType } from "@/engine/types";

export interface ChainSide {
  ltp: number;
  bid: number;
  ask: number;
}

export interface ChainRow {
  strike: number;
  ce: ChainSide;
  pe: ChainSide;
}

export interface NiftyChain {
  expiry: string;
  /** Selectable expiries, nearest first; never the contract expiring today (the engine never buys it). */
  expiries: string[];
  atm: number;
  /** Implied vol used for every strike, in percent. */
  ivPct: number;
  rows: ChainRow[];
  source: "model";
}

/** The next `n` NIFTY weekly expiries after today, holiday-adjusted. */
export function niftyExpiries(nowMs: number, n = 3, calendar: TradingCalendar = defaultCalendar): string[] {
  const today = istDate(nowMs);
  let e = calendar.nextExpiry("NIFTY", nowMs);
  if (e <= today) e = calendar.followingExpiry("NIFTY", e);
  const out = [e];
  while (out.length < n) out.push(calendar.followingExpiry("NIFTY", out[out.length - 1]));
  return out;
}

function contract(expiry: string, strike: number, type: OptionType, cfg: EngineConfig): OptionContract {
  const spec = cfg.indexSpecs.NIFTY;
  return {
    index: "NIFTY",
    exchange: spec.exchange,
    tradingSymbol: `NIFTY ${expiry} ${strike} ${type}`,
    growwSymbol: "",
    exchangeToken: "",
    expiry,
    strike,
    type,
    lotSize: spec.lotSize,
    tickSize: spec.tickSize,
  };
}

/** `width` strikes either side of the at-the-money strike, priced at `nowMs`. */
export function buildNiftyChain(o: {
  spot: number;
  vix: number;
  nowMs: number;
  expiry: string;
  expiries: string[];
  width?: number;
  calendar?: TradingCalendar;
  cfg?: EngineConfig;
}): NiftyChain {
  const cfg = o.cfg ?? DEFAULT_CONFIG;
  const calendar = o.calendar ?? defaultCalendar;
  const step = cfg.indexSpecs.NIFTY.strikeStep;
  const width = o.width ?? 10;
  const atm = Math.round(o.spot / step) * step;
  const ctx = { t: o.nowMs, spot: o.spot, vix: o.vix };
  const side = (strike: number, type: OptionType): ChainSide => {
    const q = syntheticQuote(contract(o.expiry, strike, type, cfg), ctx, calendar, cfg);
    return { ltp: q.ltp, bid: q.bid, ask: q.ask };
  };
  const rows: ChainRow[] = [];
  for (let k = -width; k <= width; k++) {
    const strike = atm + k * step;
    if (strike > 0) rows.push({ strike, ce: side(strike, "CE"), pe: side(strike, "PE") });
  }
  return { expiry: o.expiry, expiries: o.expiries, atm, ivPct: syntheticVol("NIFTY", o.vix, cfg) * 100, rows, source: "model" };
}
