/**
 * Prices a person types into a broker app. NSE and BSE index options trade on a ₹0.05 tick, so every
 * price shown for copying is snapped to it, in the direction that matches how the engine acts on it:
 * a buy limit and a target round up (the first tick at or above), a stop rounds down (the engine sells
 * when its mark is at or below the stop). Whole-tick arithmetic avoids floating-point drift. Pure.
 */

export const TICK = 0.05;
const TICKS_PER_RUPEE = 20;
const EPS = 1e-6;

const fromTicks = (ticks: number) => Math.round(ticks * 5) / 100;

/** The first 0.05 tick at or above `x`. */
export function ceilTick(x: number): number {
  return fromTicks(Math.ceil(x * TICKS_PER_RUPEE - EPS));
}

/** The last 0.05 tick at or below `x`. */
export function floorTick(x: number): number {
  return fromTicks(Math.floor(x * TICKS_PER_RUPEE + EPS));
}

/** The nearest 0.05 tick. */
export function nearestTick(x: number): number {
  return fromTicks(Math.round(x * TICKS_PER_RUPEE));
}

export function isOnTick(x: number): boolean {
  if (!Number.isFinite(x)) return false;
  const ticks = x * TICKS_PER_RUPEE;
  return Math.abs(ticks - Math.round(ticks)) < 1e-5;
}

/** Slippage allowed over the engine's fill when a person copies the buy (see buyLimit). */
export const LIMIT_SLIPPAGE_PCT = 2;
/** At least this many ticks of room, so very cheap options still get a usable limit. */
export const MIN_SLIPPAGE_TICKS = 2;

/**
 * The most a copier should pay: the engine's fill plus 2 % (at least two ticks), rounded up to the tick.
 *
 * Why not exactly the engine's fill: the paper fill is the ask at the engine's decision, and a person
 * copies seconds to minutes later on index data that is a minute or two late, so a limit at the fill
 * would miss about half the time. Why 2 %: it covers the bid-ask spread the engine itself accepts (its
 * spread gate allows up to 1.5 %) plus a small drift, while a bigger allowance eats the trade: against
 * the engine's −30 % stop and +50 % target, paying 2 % more raises the loss to the stop by about 7 % and
 * trims the gain to the target by 4 % (reward to risk 1.67 → 1.50); paying 5 % more drops it to 1.29.
 * Above the limit the move has already run: don't chase.
 */
export function buyLimit(fill: number): number {
  return ceilTick(Math.max(fill * (1 + LIMIT_SLIPPAGE_PCT / 100), fill + MIN_SLIPPAGE_TICKS * TICK));
}

const rupeeFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeRupeeFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const levelFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** ₹146.65 / ₹9,448.25 (en-IN grouping, two decimals): an option premium or an order value. */
export function rupees(x: number): string {
  return `${x < 0 ? "−" : ""}₹${rupeeFormat.format(Math.abs(x))}`;
}

/** ₹9,448 / −₹2,555: whole rupees, for costs and P&L. `sign` adds "+" to gains. */
export function wholeRupees(x: number, sign = false): string {
  const r = Math.round(x);
  const prefix = r < 0 ? "−" : sign && r > 0 ? "+" : "";
  return `${prefix}₹${wholeRupeeFormat.format(Math.abs(r))}`;
}

/** 22,631 / 81,234: an index level, whole points with en-IN grouping. */
export function indexLevel(x: number): string {
  return levelFormat.format(x);
}

const priceFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 22,631.20: an index price as quoted. */
export function indexPrice(x: number): string {
  return priceFormat.format(x);
}
