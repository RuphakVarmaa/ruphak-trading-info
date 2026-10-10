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

/**
 * Implied vol of real weekly options relative to India VIX, fitted to exchange end-of-day premiums
 * (NSE and BSE bhavcopies, 2 Jan 2024 - 30 Jun 2026, about 650 sessions per index; script
 * scripts/research/real_prices.ts calibrate, results in reports/wp6-real-prices.md). Used only when
 * cfg.pricing.ivSource is "calibrated".
 *
 * atmByDte: ATM straddle implied vol / India VIX by sessions left after today until expiry
 * (index 0 = 1 session, last entry = 6 or more); the mean of the open- and close-based medians, which
 * differ by at most 0.03. Out of sample (Jul-Oct 2026) the default VIX x 1.00 / 1.05 priced ATM
 * straddles 7.5% (NIFTY) and 9.8% (SENSEX) above the real ones (medians); these constants -3.2% / -3.3%.
 * putWing / callWing: OTM smile IV / ATM IV = 1 + a z + b z^2 with z = ln(K / F) / (atmVol sqrt(t)),
 * fitted separately below (puts) and above (calls) the forward; z is clamped to [zMin, zMax].
 */
export const CALIBRATED_IV: Record<IndexId, { atmByDte: readonly number[]; putWing: { a: number; b: number }; callWing: { a: number; b: number } }> = {
  NIFTY: { atmByDte: [0.865, 0.885, 0.895, 0.908, 0.902, 0.925], putWing: { a: -0.0467, b: 0.0525 }, callWing: { a: -0.1172, b: 0.0986 } },
  SENSEX: { atmByDte: [0.908, 0.923, 0.929, 0.927, 0.92, 0.926], putWing: { a: -0.0573, b: 0.0398 }, callWing: { a: -0.0847, b: 0.092 } },
};
const CALIBRATED_Z_RANGE = { zMin: -2.5, zMax: 1.5 } as const;

/** Where the contract sits: years of trading time to expiry and moneyness (calibrated IV only). */
export interface VolContext {
  spot: number;
  strike: number;
  tYears: number;
}

/**
 * Synthetic implied vol as a decimal (0 when VIX is missing). Default ("vix"): vix / 100 *
 * vixMultiplier[index]. With pricing.ivSource "calibrated": vix / 100 * CALIBRATED_IV multiplier for
 * the sessions left to expiry, times the smile for the strike; without a contract context the
 * 3-session ATM multiplier is used.
 */
export function syntheticVol(index: IndexId, vix: number, cfg: EngineConfig, ctx?: VolContext): number {
  const cal = cfg.pricing.ivSource === "calibrated" ? CALIBRATED_IV[index] : undefined;
  let v: number;
  if (!cal) {
    v = (vix / 100) * (cfg.pricing.vixMultiplier[index] ?? 1);
  } else {
    // During a session with d whole sessions left after it, tYears in sessions = d + (fraction of today left).
    const d = ctx ? Math.min(cal.atmByDte.length, Math.max(1, Math.ceil(ctx.tYears * cfg.pricing.tradingDaysPerYear - 1e-9) - 1)) : 3;
    const atm = (vix / 100) * cal.atmByDte[d - 1];
    v = atm;
    if (ctx && ctx.spot > 0 && ctx.strike > 0 && ctx.tYears > 0 && atm > 0) {
      const fwd = ctx.spot * Math.exp(cfg.pricing.r * ctx.tYears);
      const z = Math.min(CALIBRATED_Z_RANGE.zMax, Math.max(CALIBRATED_Z_RANGE.zMin, Math.log(ctx.strike / fwd) / (atm * Math.sqrt(ctx.tYears))));
      const w = z < 0 ? cal.putWing : cal.callWing;
      v = atm * (1 + w.a * z + w.b * z * z);
    }
  }
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
  const tYears = yearsToExpiry(ctx.t, contract.expiry, calendar, cfg);
  const vol = syntheticVol(contract.index, ctx.vix, cfg, { spot: ctx.spot, strike: contract.strike, tYears });
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
