/**
 * Contract selection: nearest weekly expiry that is not expiring today; the ATM strike, or (small
 * accounts) the strike nearest the money whose premium is within a band and fits the sizing rules.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { istDate } from "../clock";
import { premiumBand, type EngineConfig } from "../config";
import { atmStrike, nearestListedStrike } from "../instruments/instrumentMaster";
import { syntheticQuote } from "../pricing/syntheticOptionPricer";
import type { InstrumentProvider, OptionQuoteSource } from "../ports";
import type { GateResult, IndexId, OptionContract, Quote, TradeSide } from "../types";
import { minSessionsLeft } from "./rules";

export async function chooseExpiry(index: IndexId, t: number, instruments: InstrumentProvider, calendar: TradingCalendar): Promise<string> {
  const today = istDate(t);
  const listed = (await instruments.expiries(index)).filter((e) => e >= today).sort();
  // Never buy the contract that expires today: gamma and theta are brutal into the close.
  const candidate = listed.find((e) => e > today);
  if (candidate) return candidate;
  const cal = calendar.nextExpiry(index, t);
  return cal === today ? calendar.followingExpiry(index, cal) : cal;
}

// --- WP9b N4 (begin) ---
/**
 * The expiry to buy under the config: chooseExpiry, or with rules.n4 on the nearest weekly with at
 * least minSessionsLeft sessions after today (the next week's contract on the day before an expiry),
 * null when no listed contract qualifies (skip).
 */
export async function chooseExpiryFor(index: IndexId, t: number, instruments: InstrumentProvider, calendar: TradingCalendar, cfg: EngineConfig): Promise<string | null> {
  const min = minSessionsLeft(cfg);
  if (min <= 1) return chooseExpiry(index, t, instruments, calendar);
  const today = istDate(t);
  const enough = (e: string) => e > today && calendar.tradingDaysBetween(today, e) >= min;
  const listed = (await instruments.expiries(index)).filter((e) => e >= today).sort();
  if (listed.length > 0) return listed.find(enough) ?? null;
  let e = calendar.nextExpiry(index, t);
  for (let i = 0; i < 4 && !enough(e); i++) e = calendar.followingExpiry(index, e);
  return enough(e) ? e : null;
}
// --- WP9b N4 (end) ---

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
  const expiry = await chooseExpiryFor(index, t, instruments, calendar, cfg);
  if (expiry === null) return null;
  const strikes = await instruments.strikes(index, expiry);
  const step = cfg.indexSpecs[index].strikeStep;
  let strike = atmStrike(spot, step);
  if (strikes.length > 0 && !strikes.includes(strike)) strike = nearestListedStrike(strikes, spot) ?? strike;
  // WP9b (off by default): selection.itmSteps strikes in the money (calls below, puts above the ATM strike).
  const itm = cfg.selection.itmSteps ?? 0;
  if (itm > 0) {
    const ladder = strikeLadder(strikes, strike, side === "BULL" ? "BEAR" : "BULL", itm, step);
    if (ladder.length <= itm) return null;
    strike = ladder[itm];
  }
  return instruments.resolve(index, expiry, strike, side === "BULL" ? "CE" : "PE");
}

/**
 * Strikes from ATM outward in the out-of-the-money direction: upward for calls (BULL), downward for
 * puts (BEAR). The ATM strike comes first, then up to `steps` more. Listed strikes are used when
 * known; otherwise the strike grid is generated from `step`.
 */
export function strikeLadder(listed: number[], atm: number, side: TradeSide, steps: number, step: number): number[] {
  const up = side === "BULL";
  if (listed.length === 0) return Array.from({ length: steps + 1 }, (_, k) => atm + (up ? k : -k) * step);
  const sorted = [...new Set(listed)].sort((a, b) => a - b);
  const out = up ? sorted.filter((s) => s >= atm) : sorted.filter((s) => s <= atm).reverse();
  return out.slice(0, steps + 1);
}

export interface PremiumBandArgs {
  index: IndexId;
  spot: number;
  vix: number;
  side: TradeSide;
  t: number;
  instruments: InstrumentProvider;
  optionQuotes: OptionQuoteSource;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  /** Whether a quote is usable (two-sided, fresh); unusable ones are skipped. */
  quoteOk: (q: Quote, contract: OptionContract) => boolean;
  /** Whether one lot at this premium fits the sizing rules (the single affordability check). */
  affordable: (premium: number, contract: OptionContract) => boolean;
}

export interface PremiumBandPick {
  /** The chosen contract, or the nearest in-band candidate for display when nothing fits. */
  contract: OptionContract | null;
  /** Quote of the chosen contract (null when nothing fits). */
  quote: Quote | null;
  gate: GateResult;
}

/**
 * Picks the strike nearest the money whose ask is within [minPremium, maxPremium] and for which one
 * lot is affordable. Premiums are first estimated with the synthetic pricer so that at most
 * `maxQuotes` real quotes are fetched, starting one strike nearer the money than the first estimate
 * under the maximum. Premium falls as strikes move out of the money, so the walk stops below the band.
 */
export async function choosePremiumBandContract(a: PremiumBandArgs): Promise<PremiumBandPick> {
  const { cfg, index } = a;
  const band = { ...premiumBand(cfg, index), maxQuotes: cfg.selection.maxQuotes };
  const label = "Strike in the premium band";
  const range = `₹${band.minPremium}–${band.maxPremium}`;
  const fail = (contract: OptionContract | null, detail: string): PremiumBandPick => ({ contract, quote: null, gate: { gate: "premium_band", label, passed: false, detail } });
  if (!(a.spot > 0)) return fail(null, "no spot price");

  const expiry = await chooseExpiryFor(index, a.t, a.instruments, a.calendar, cfg);
  if (expiry === null) return fail(null, `no listed contract with at least ${minSessionsLeft(cfg)} sessions to expiry (N4)`);
  const listed = await a.instruments.strikes(index, expiry);
  const step = cfg.indexSpecs[index].strikeStep;
  let atm = atmStrike(a.spot, step);
  if (listed.length > 0 && !listed.includes(atm)) atm = nearestListedStrike(listed, a.spot) ?? atm;
  const type = a.side === "BULL" ? "CE" : "PE";
  const candidates: OptionContract[] = [];
  for (const strike of strikeLadder(listed, atm, a.side, band.maxOtmSteps, step)) {
    const c = await a.instruments.resolve(index, expiry, strike, type);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) return fail(null, "no listed strikes near the money");

  const ctx = { t: a.t, spot: a.spot, vix: a.vix };
  const estimates = candidates.map((c) => syntheticQuote(c, ctx, a.calendar, cfg).ask);
  const firstUnderMax = estimates.findIndex((ask) => ask <= band.maxPremium);
  if (firstUnderMax < 0) return fail(candidates[candidates.length - 1], `every strike within ${band.maxOtmSteps} steps costs more than ₹${band.maxPremium}`);

  const tried: string[] = [];
  const start = Math.max(0, firstUnderMax - 1);
  for (let i = start; i < candidates.length && i < start + band.maxQuotes; i++) {
    const c = candidates[i];
    const q = await a.optionQuotes.quote(c, ctx);
    if (!a.quoteOk(q, c)) {
      tried.push(`${c.strike} no usable quote`);
      continue;
    }
    if (q.ask > band.maxPremium) {
      tried.push(`${c.strike} ₹${q.ask}`);
      continue;
    }
    if (q.ask < band.minPremium) {
      tried.push(`${c.strike} ₹${q.ask} below the band`);
      break;
    }
    if (!a.affordable(q.ask, c)) {
      tried.push(`${c.strike} ₹${q.ask} too large for the limits`);
      continue;
    }
    const lot = Math.round(q.ask * c.lotSize);
    return { contract: c, quote: q, gate: { gate: "premium_band", label, passed: true, detail: `${i} strike(s) out of the money, ask ₹${q.ask}, one lot ₹${lot.toLocaleString("en-IN")}` } };
  }
  return fail(candidates[firstUnderMax], `no strike within ${range} fits (${tried.join("; ") || "nothing quoted"})`);
}
