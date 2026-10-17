/**
 * Fabricates instrument rows in Groww's format for expiries that are no longer in the live
 * instrument.csv (backtests). Formats match the real file:
 *   weekly  NIFTY26O1322600CE   (underlying + YY + month code 1-9/O/N/D + DD + strike + type)
 *   monthly NIFTY26OCT22600CE   (underlying + YY + MMM + strike + type; the last expiry of the month)
 *   groww   NSE-NIFTY-13Oct26-22600-CE
 */
import { addDays, weekdayOf } from "../clock";
import type { EngineConfig } from "../config";
import type { IndexId, OptionType } from "../types";
import { atmStrike, type InstrumentRow } from "./instrumentMaster";

const MONTH_CODES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];
const MONTH_UPPER = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_TITLE = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Freeze quantities seen in the live file (NIFTY 3511 = 54 lots + 1, SENSEX 1001 = 50 lots + 1). */
const DEFAULT_FREEZE_QTY: Record<IndexId, number> = { NIFTY: 3511, SENSEX: 1001 };

function parts(expiry: string): { yy: string; month: number; dd: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new Error(`Invalid expiry date: ${expiry}`);
  return { yy: m[1].slice(2), month: Number(m[2]), dd: m[3] };
}

function strikeText(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(Math.round(strike * 100) / 100);
}

/**
 * True when `expiry` is its month's last weekly expiry (the exchange's "monthly" contract):
 * the following week's nominal expiry weekday falls in the next month. Holiday-shifted expiries are
 * judged by their nominal weekday (NIFTY 2026-11-23, Monday before the 24th's holiday, is monthly).
 */
export function isMonthlyExpiry(index: IndexId, expiry: string, cfg: EngineConfig): boolean {
  const wd = cfg.indexSpecs[index].weeklyExpiryWeekday;
  const nominal = addDays(expiry, (wd - weekdayOf(expiry) + 7) % 7);
  return addDays(nominal, 7).slice(0, 7) !== nominal.slice(0, 7);
}

export function optionTradingSymbol(underlying: string, expiry: string, strike: number, type: OptionType, monthly: boolean): string {
  const { yy, month, dd } = parts(expiry);
  return monthly
    ? `${underlying}${yy}${MONTH_UPPER[month - 1]}${strikeText(strike)}${type}`
    : `${underlying}${yy}${MONTH_CODES[month - 1]}${dd}${strikeText(strike)}${type}`;
}

export function optionGrowwSymbol(exchange: string, underlying: string, expiry: string, strike: number, type: OptionType): string {
  const { yy, month, dd } = parts(expiry);
  return `${exchange}-${underlying}-${dd}${MONTH_TITLE[month - 1]}${yy}-${strikeText(strike)}-${type}`;
}

/**
 * Rows for `count` strikes on each side of the ATM strike nearest `center` (2 * count + 1 strikes),
 * CE and PE, for every expiry. Exchange tokens are synthetic ("SYN-...") and never sent to a broker.
 */
export function syntheticInstrumentRows(
  index: IndexId,
  expiries: string[],
  center: number,
  count: number,
  cfg: EngineConfig,
): InstrumentRow[] {
  const spec = cfg.indexSpecs[index];
  const atm = atmStrike(center, spec.strikeStep);
  const n = Math.max(0, Math.floor(count));
  const rows: InstrumentRow[] = [];
  for (const expiry of expiries) {
    const monthly = isMonthlyExpiry(index, expiry, cfg);
    for (let k = -n; k <= n; k++) {
      const strike = atm + k * spec.strikeStep;
      if (!(strike > 0)) continue;
      for (const type of ["CE", "PE"] as const) {
        const tradingSymbol = optionTradingSymbol(spec.underlying, expiry, strike, type, monthly);
        rows.push({
          exchange: spec.exchange,
          exchangeToken: `SYN-${tradingSymbol}`,
          tradingSymbol,
          growwSymbol: optionGrowwSymbol(spec.exchange, spec.underlying, expiry, strike, type),
          name: "",
          instrumentType: type,
          segment: "FNO",
          underlyingSymbol: spec.underlying,
          expiryDate: expiry,
          strikePrice: strike,
          lotSize: spec.lotSize,
          tickSize: spec.tickSize,
          freezeQuantity: DEFAULT_FREEZE_QTY[index] ?? 0,
          buyAllowed: true,
          sellAllowed: true,
        });
      }
    }
  }
  return rows;
}
