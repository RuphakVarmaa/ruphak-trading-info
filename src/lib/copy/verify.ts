/**
 * Checks on everything a person types into Groww from a copy ticket: the strike, CE or PE, the expiry
 * (NIFTY weekly on Tuesday, SENSEX on Thursday, moved to the trading day before when that day is a
 * holiday, and never the contract expiring the day it was bought), lots × lot size = quantity, and the
 * ₹0.05 tick of every price shown. The calendar and contract rules are the engine's own. Pure.
 */
import type { CopyTicketView } from "@/engine/api-types";
import { defaultCalendar, type TradingCalendar } from "@/engine/calendar/calendar";
import { DEFAULT_CONFIG } from "@/engine/config";
import { addDays, weekdayOf } from "@/lib/ist";
import { copyLimit, exitLevels, expiryLong } from "./action";
import { stopLossLimit } from "./script";
import { isOnTick } from "./prices";

export interface Check {
  id: "strike" | "type" | "search" | "expiry" | "expiry_next" | "qty" | "lot_size" | "tick";
  ok: boolean;
  text: string;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The weekly expiry the engine's calendar expects for a trade opened at `entryMs`: the nearest one after the entry day. */
export function expectedExpiry(t: CopyTicketView, cal: TradingCalendar = defaultCalendar): string {
  const entryMs = Date.parse(t.entry.at);
  const entryDate = t.entry.at.slice(0, 10);
  const next = cal.nextExpiry(t.index, entryMs);
  return next === entryDate ? cal.followingExpiry(t.index, next) : next;
}

export function verifyTicket(t: CopyTicketView, cal: TradingCalendar = defaultCalendar): Check[] {
  const c = t.contract;
  const spec = DEFAULT_CONFIG.indexSpecs[t.index];
  const out: Check[] = [];

  const onGrid = Number.isInteger(c.strike) && c.strike > 0 && c.strike % spec.strikeStep === 0;
  out.push({ id: "strike", ok: onGrid, text: onGrid ? `Strike ${c.strike} is on ${t.index}'s ${spec.strikeStep}-point grid` : `Strike ${c.strike} is not on ${t.index}'s ${spec.strikeStep}-point grid: check it in Groww` });

  const wantType = t.side === "BULL" ? "CE" : "PE";
  out.push({
    id: "type",
    ok: c.optionType === wantType,
    text: c.optionType === wantType ? `${c.optionType} for a ${t.side === "BULL" ? "bullish" : "bearish"} trade` : `${c.optionType} does not match a ${t.side === "BULL" ? "bullish" : "bearish"} trade (expected ${wantType})`,
  });

  const search = `${t.index} ${c.strike} ${c.optionType}`;
  out.push({ id: "search", ok: t.searchText === search, text: t.searchText === search ? `Search text "${search}"` : `Search text "${t.searchText}" does not match ${search}` });

  // Expiry: the index's weekly weekday, or the trading day before it when that day is a holiday.
  const nominal = spec.weeklyExpiryWeekday;
  const entryDate = t.entry.at.slice(0, 10);
  const wd = weekdayOf(c.expiry);
  const label = expiryLong(c.expiry);
  if (cal.isTradingDay(c.expiry) && cal.expiryOnOrAfter(t.index, c.expiry) === c.expiry) {
    if (wd === nominal) out.push({ id: "expiry", ok: true, text: `${label} is a ${t.index} weekly expiry (${WEEKDAY_NAMES[nominal - 1]})` });
    else {
      const nominalDate = addDays(c.expiry, (nominal - wd + 7) % 7);
      const why = cal.holidayName(nominalDate) ?? "a holiday";
      out.push({ id: "expiry", ok: true, text: `${label}: ${expiryLong(nominalDate).replace(/ \d{4}$/, "")} is a holiday (${why}), so ${t.index} expires the trading day before` });
    }
  } else {
    out.push({ id: "expiry", ok: false, text: `${label} is not a ${t.index} weekly expiry (${WEEKDAY_NAMES[nominal - 1]}, or the trading day before a ${WEEKDAY_NAMES[nominal - 1]} holiday): check it in Groww` });
  }
  if (c.expiry <= entryDate) {
    out.push({ id: "expiry_next", ok: false, text: c.expiry === entryDate ? "This contract expires the day it was bought: the engine never buys those. Check it in Groww" : "This contract had already expired when it was bought: check it in Groww" });
  } else {
    const want = expectedExpiry(t, cal);
    out.push({
      id: "expiry_next",
      ok: want === c.expiry,
      text: want === c.expiry ? "The nearest weekly expiry after the trade day" : `The calendar expects ${expiryLong(want)}, the nearest weekly expiry: pick the expiry Groww lists for ${t.searchText} carefully`,
    });
  }

  const qtyOk = t.lots >= 1 && t.lots * c.lotSize === t.qty;
  out.push({ id: "qty", ok: qtyOk, text: qtyOk ? `${t.lots} lot${t.lots === 1 ? "" : "s"} × ${c.lotSize} = ${t.qty} qty` : `${t.lots} lot${t.lots === 1 ? "" : "s"} × ${c.lotSize} is not ${t.qty} qty: check the quantity in Groww` });

  const lotOk = c.lotSize === spec.lotSize;
  out.push({ id: "lot_size", ok: lotOk, text: lotOk ? `Lot size ${c.lotSize} (${t.index})` : `Lot size ${c.lotSize} differs from the ${spec.lotSize} the engine expects for ${t.index}: use the lot size Groww shows` });

  // Every price this page asks you to type, as shown.
  const x = exitLevels(t);
  const typed = [copyLimit(t).price, x.stop, stopLossLimit(x.stop), x.target, x.trailFrom, x.timeStopKeep, ...(x.trail != null ? [x.trail] : [])];
  const tickOk = typed.every(isOnTick);
  const fillNote = isOnTick(t.entry.premium) ? "" : ` (the engine's fill ₹${t.entry.premium.toFixed(2)} is not, so it is rounded)`;
  out.push({
    id: "tick",
    ok: tickOk,
    text: tickOk ? `Every price to type is on the ₹0.05 tick${fillNote}: limit and target rounded up, stop down` : "A price to type is off the ₹0.05 tick: round it before typing",
  });
  return out;
}

/** The failed checks only (empty when everything matches). */
export function problems(t: CopyTicketView, cal: TradingCalendar = defaultCalendar): Check[] {
  return verifyTicket(t, cal).filter((c) => !c.ok);
}
