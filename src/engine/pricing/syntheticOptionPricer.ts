/**
 * Synthetic option quotes for backtests and fallbacks: Black-Scholes mid with India VIX as the
 * implied-vol proxy, trading-time to the 15:30 IST expiry close, and a simple spread/depth model.
 * Synthetic quotes carry no open interest (oi is undefined).
 */
import type { TradingCalendar } from "../calendar/calendar";
import type { EngineConfig } from "../config";
import type { OptionQuoteSource } from "../ports";
import type { IndexId, Level, OptionContract, Quote } from "../types";
import { bsPrice } from "./blackScholes";
import { yearsToExpiry } from "./timeToExpiry";

/** Depth model: lots on each of the 5 levels per side, from the touch outwards. */
export const SYNTHETIC_DEPTH_LOTS: readonly number[] = [20, 16, 12, 8, 4];

/** Synthetic implied vol as a decimal: vix / 100 * vixMultiplier[index] (0 when VIX is missing). */
export function syntheticVol(index: IndexId, vix: number, cfg: EngineConfig): number {
  const mult = cfg.pricing.vixMultiplier[index] ?? 1;
  const v = (vix / 100) * mult;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Rounds to 2 decimals to strip floating-point noise from tick multiples. */
function px(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Black-Scholes quote: mid = BS price; spread = max(minTicks * tick, pctOfPremium% * mid) rounded up to
 * whole ticks; bid = mid - spread/2 rounded to the tick (never below one tick), ask = bid + spread;
 * five depth levels per side one tick apart with 20, 16, 12, 8, 4 lots; iv = vol * 100.
 */
export function syntheticQuote(
  contract: OptionContract,
  ctx: { t: number; spot: number; vix: number },
  calendar: TradingCalendar,
  cfg: EngineConfig,
): Quote {
  const tick = contract.tickSize > 0 ? contract.tickSize : cfg.indexSpecs[contract.index]?.tickSize ?? 0.05;
  const lot = contract.lotSize > 0 ? contract.lotSize : cfg.indexSpecs[contract.index]?.lotSize ?? 1;
  const vol = syntheticVol(contract.index, ctx.vix, cfg);
  const tYears = yearsToExpiry(ctx.t, contract.expiry, calendar, cfg);
  const rawMid = bsPrice({ spot: ctx.spot, strike: contract.strike, tYears, vol, r: cfg.pricing.r, type: contract.type });
  const mid = Number.isFinite(rawMid) && rawMid > 0 ? rawMid : 0;

  const { minTicks, pctOfPremium } = cfg.pricing.spreadModel;
  const spreadModel = Math.max(minTicks * tick, (pctOfPremium / 100) * mid);
  const spreadTicks = Math.max(1, Math.ceil(spreadModel / tick - 1e-9));
  const bidTicks = Math.max(1, Math.round((mid - (spreadTicks * tick) / 2) / tick));
  const bid = px(bidTicks * tick);
  const ask = px((bidTicks + spreadTicks) * tick);
  const ltp = px(Math.max(1, Math.round(mid / tick)) * tick);

  const buy: Level[] = [];
  const sell: Level[] = [];
  SYNTHETIC_DEPTH_LOTS.forEach((lots, k) => {
    if (bidTicks - k >= 1) buy.push({ price: px((bidTicks - k) * tick), qty: lots * lot });
    sell.push({ price: px((bidTicks + spreadTicks + k) * tick), qty: lots * lot });
  });

  return {
    symbol: contract.tradingSymbol,
    t: ctx.t,
    ltp,
    bid,
    ask,
    bidQty: buy[0]?.qty ?? 0,
    askQty: sell[0]?.qty ?? 0,
    depth: { buy, sell },
    iv: vol * 100,
    source: "synthetic",
  };
}

export class SyntheticOptionQuotes implements OptionQuoteSource {
  readonly kind = "synthetic" as const;

  constructor(
    private readonly calendar: TradingCalendar,
    private readonly cfg: EngineConfig,
  ) {}

  async quote(contract: OptionContract, ctx: { t: number; spot: number; vix: number }): Promise<Quote> {
    return syntheticQuote(contract, ctx, this.calendar, this.cfg);
  }
}
