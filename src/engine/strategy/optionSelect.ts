/** Contract selection: nearest weekly expiry that is not expiring today, ATM strike. */
import type { TradingCalendar } from "../calendar/calendar";
import { istDate } from "../clock";
import type { EngineConfig } from "../config";
import { atmStrike, nearestListedStrike } from "../instruments/instrumentMaster";
import type { InstrumentProvider } from "../ports";
import type { IndexId, OptionContract, TradeSide } from "../types";

export async function chooseExpiry(index: IndexId, t: number, instruments: InstrumentProvider, calendar: TradingCalendar): Promise<string> {
  const today = istDate(t);
  const listed = (await instruments.expiries(index)).filter((e) => e >= today).sort();
  // Never buy the contract that expires today: gamma and theta are brutal into the close.
  const candidate = listed.find((e) => e > today);
  if (candidate) return candidate;
  const cal = calendar.nextExpiry(index, t);
  return cal === today ? calendar.followingExpiry(index, cal) : cal;
}

export async function chooseContract(
  index: IndexId,
  spot: number,
  side: TradeSide,
  t: number,
  instruments: InstrumentProvider,
  calendar: TradingCalendar,
  cfg: EngineConfig,
): Promise<OptionContract | null> {
  if (!(spot > 0)) return null;
  const expiry = await chooseExpiry(index, t, instruments, calendar);
  const strikes = await instruments.strikes(index, expiry);
  let strike = atmStrike(spot, cfg.indexSpecs[index].strikeStep);
  if (strikes.length > 0 && !strikes.includes(strike)) strike = nearestListedStrike(strikes, spot) ?? strike;
  return instruments.resolve(index, expiry, strike, side === "BULL" ? "CE" : "PE");
}
