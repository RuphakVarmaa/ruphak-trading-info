/**
 * A copy ticket as numbered steps a person can follow in any F&O (or paper-trading) order screen, and
 * a position-size check: what one lot costs, what the stop loses with charges, and whether it fits a
 * given capital. Charges come from the engine's own dated schedule (src/engine/broker/charges.ts). Pure.
 */
import type { CopyTicketView } from "@/engine/api-types";
import { computeCharges } from "@/engine/broker/charges";
import { ACCOUNT_IDS, accountConfig, type AccountId } from "@/engine/accounts";
import { DEFAULT_CONFIG } from "@/engine/config";
import { copyLimit, expiryLong, exitLevels, hm, skipRule } from "./action";
import { floorTick, indexLevel, LIMIT_SLIPPAGE_PCT, rupees, wholeRupees } from "./prices";

/** The capital most people copying by hand start with; every ticket is also checked against it. */
export const SMALL_CAPITAL = 5_000;

/**
 * Room between a stop-loss trigger and its limit. Brokers often block stop-loss-market (SL-M) orders on
 * index options, so the stop is an SL order: it triggers at the engine's stop and may fill down to 2 %
 * under it, enough for a fast fall without selling at any price.
 */
export const SL_LIMIT_ROOM_PCT = 2;

/** The limit of the stop-loss (SL) sell order: 2 % under the trigger, at least one tick, rounded down. */
export function stopLossLimit(trigger: number): number {
  return floorTick(Math.min(trigger * (1 - SL_LIMIT_ROOM_PCT / 100), trigger - 0.05));
}

const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)}%`;

/** Numbered steps (without the numbers) for placing and managing this trade by hand. */
export function paperScript(t: CopyTicketView): string[] {
  const c = t.contract;
  const x = exitLevels(t);
  const lv = t.levels;
  const lim = copyLimit(t);
  const limit = lim.price;
  const skip = skipRule(t);
  const call = c.optionType === "CE";
  const model = t.entry.priceSource === "model";
  const stopFactor = (1 + lv.stopPct / 100).toFixed(2);
  // The trailing stop at the moment it turns on, as a worked example of the giveback rule.
  const trailAtStart = floorTick(x.trailFrom - (x.trailFrom - t.entry.premium) * (lv.trailGivebackPct / 100));
  return [
    `Open the F&O (options) order screen and search "${t.searchText}".`,
    `Pick the expiry ${expiryLong(c.expiry)} (${t.index} weekly).`,
    `Choose strike ${c.strike} ${call ? "CE (call)" : "PE (put)"} and tap BUY.`,
    `Quantity: ${t.lots} lot${t.lots === 1 ? "" : "s"} = ${t.qty} (lot size ${c.lotSize}).`,
    `Order type LIMIT at ${rupees(limit)} or less: the engine paid ${rupees(t.entry.premium)} at ${hm(t.entry.at)} IST${model ? " (a model price: Groww's will differ)" : ""}; the limit is the ${lim.baseLabel} plus ${LIMIT_SLIPPAGE_PCT}% room.${skip ? ` Don't place it if ${t.index} is already ${skip.above ? "above" : "below"} ${indexLevel(skip.level)}.` : ""}`,
    "If it is not filled within about a minute, cancel it — don't chase (the engine cancels its own unfilled entry after 30 s).",
    `Once filled, place the stop-loss: SELL ${t.qty} qty, stop-loss (SL) order, trigger ${rupees(x.stop)}, limit ${rupees(stopLossLimit(x.stop))} (${pct(lv.stopPct)} on the engine's fill; from your own fill F the trigger is F × ${stopFactor}). The limit sits ${SL_LIMIT_ROOM_PCT}% under the trigger so the order fills in a fast fall.`,
    `Target ${rupees(x.target)} (${pct(lv.targetPct)}): sell there. Keep one exit order per lot: when the premium nears the target, change the stop-loss into a LIMIT SELL at ${rupees(x.target)}, or use an OCO order if your app has one. Two open SELL orders for one lot can leave you short.`,
    `Trail: once the premium reaches ${rupees(x.trailFrom)} (${pct(lv.trailActivatePct)}), raise the stop so it gives back at most ${lv.trailGivebackPct}% of the gain from the peak: at ${rupees(x.trailFrom)} the stop goes to ${rupees(trailAtStart)}, and it rises with every new high.`,
    `Time stop ${hm(x.timeStopAt)} IST: sell then unless the premium is at least ${rupees(x.timeStopKeep)} (${pct(lv.timeStopMinPnlPct)}).`,
    `Latest exit ${hm(x.squareOffAt)} IST: sell whatever is left.`,
    "Whenever this page shows EXIT NOW for this trade: first cancel your stop-loss and target orders (if the stop-loss already filled, you are out — do nothing more), then sell at market.",
  ];
}

/** The steps as one numbered text block, for "Copy all steps". */
export function scriptText(t: CopyTicketView): string {
  const head = `${t.headline} · ${t.account.shortLabel} · ${expiryLong(t.contract.expiry)}`;
  return [head, ...paperScript(t).map((s, i) => `${i + 1}. ${s}`)].join("\n");
}

export interface SizeCheck {
  /** "₹10k account" or "₹5,000". */
  label: string;
  capital: number;
  lots: number;
  qty: number;
  /** The buy at the limit price (what has to be paid at most). */
  entry: number;
  stop: number;
  /** Premium paid. */
  cost: number;
  buyCharges: number;
  /** Premium plus buy charges: the cash the order needs. */
  needs: number;
  /** Loss if the stop is hit after buying at the limit: the price move plus buy and sell charges. */
  maxLoss: number;
  costPctOfCapital: number;
  lossPctOfCapital: number;
  fits: boolean;
  /** The most one trade may lose: the account's per-trade risk cap or daily loss cap, whichever is lower. */
  lossCap: number;
  lossCapPct: number;
  /** The loss at the stop (with charges) is above that cap. */
  overLossCap: boolean;
  /** A plain warning when it does not fit, or loses more than the cap at its stop; else null. */
  warning: string | null;
}

/** The most one trade may lose on `capital` under an account's rules (unknown accounts: the main account's). */
export function lossCapFor(accountId: string, capital: number): { rupees: number; pct: number } {
  const id: AccountId = (ACCOUNT_IDS as readonly string[]).includes(accountId) ? (accountId as AccountId) : "main";
  const cfg = accountConfig(DEFAULT_CONFIG, id);
  const pct = Math.min(cfg.sizing.maxRiskPctPerTrade, cfg.risk.dailyLossCapPct);
  return { rupees: Math.round((capital * pct) / 100), pct };
}

/**
 * What `lots` of the ticket's contract cost against `capital`, bought at the copy limit (the worst
 * fill the page allows) and stopped out at the engine's stop. Charges on both orders included.
 */
export function sizeCheck(t: CopyTicketView, capital: number, lots: number, label: string, capAccount = t.account.id): SizeCheck {
  const exchange = DEFAULT_CONFIG.indexSpecs[t.index].exchange;
  const date = t.entry.at.slice(0, 10);
  const qty = lots * t.contract.lotSize;
  const entry = copyLimit(t).price;
  const stop = exitLevels(t).stop;
  const cost = entry * qty;
  const buyCharges = computeCharges("BUY", entry, qty, exchange, date).total;
  const sellCharges = computeCharges("SELL", stop, qty, exchange, date).total;
  const needs = cost + buyCharges;
  const maxLoss = (entry - stop) * qty + buyCharges + sellCharges;
  const fits = needs <= capital;
  const cap = lossCapFor(capAccount, capital);
  const overLossCap = maxLoss > cap.rupees;
  const lotWord = `${lots} lot${lots === 1 ? "" : "s"}`;
  return {
    label,
    capital,
    lots,
    qty,
    entry,
    stop,
    cost,
    buyCharges,
    needs,
    maxLoss,
    costPctOfCapital: capital > 0 ? (cost / capital) * 100 : Infinity,
    lossPctOfCapital: capital > 0 ? (maxLoss / capital) * 100 : Infinity,
    fits,
    lossCap: cap.rupees,
    lossCapPct: cap.pct,
    overLossCap,
    warning: !fits
      ? `${lotWord} needs ${wholeRupees(needs)} (premium at the ${rupees(entry)} limit plus charges): more than ${wholeRupees(capital)}. This trade does not fit ${label}.`
      : overLossCap
        ? `The loss at the stop, ${wholeRupees(maxLoss)} with charges, is more than the ${wholeRupees(cap.rupees)} one trade may lose on ${wholeRupees(capital)} (${cap.pct}%). Too big for ${label}.`
        : null,
  };
}

/** The account's own size and one lot against ₹5,000 (one row when the account is ₹5,000 itself). */
export function sizeChecks(t: CopyTicketView): SizeCheck[] {
  const out = [sizeCheck(t, t.account.capitalRupees, t.lots, t.account.label)];
  if (Math.round(t.account.capitalRupees) !== SMALL_CAPITAL || t.lots !== 1) out.push(sizeCheck(t, SMALL_CAPITAL, 1, wholeRupees(SMALL_CAPITAL), "small5k"));
  return out;
}
