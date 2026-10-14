/**
 * A synthetic option chain for the mock engine: Black-Scholes premiums on a mild put skew, open interest
 * that peaks near round strikes (calls above the spot, puts below), a quoted spread around the price and a
 * little jitter every few seconds so the dashboard's live updates are visible. PCR and max pain are worked
 * out from the rows the way a real chain's are.
 */
import type { IndexId, OptionChainRowView, OptionChainView, OptionSideView } from "@/engine/api-types";
import { bsGreeks, bsPrice, normCdf } from "@/engine/pricing/blackScholes";
import { DAY_MS, HOUR_MS, istAt, nextWeeklyExpiry, SESSION, toIstIso, type HolidayCheck } from "@/lib/ist";
import { hashString, mulberry32, round2 } from "./random";

export const CHAIN_SPEC: Record<IndexId, { step: number; lotSize: number; atmIv: number; oiPeak: number; round: [number, number] }> = {
  NIFTY: { step: 50, lotSize: 65, atmIv: 0.118, oiPeak: 9_000_000, round: [500, 100] },
  SENSEX: { step: 100, lotSize: 20, atmIv: 0.124, oiPeak: 2_200_000, round: [1000, 500] },
};

/** Strikes either side of the ATM strike. */
export const CHAIN_HALF_WIDTH = 25;
const RATE = 0.065;
const JITTER_BUCKET_MS = 3_000;
const OI_SCALE_BY_EXPIRY = [1, 0.45, 0.26, 0.16];

const tick05 = (n: number) => Math.max(0.05, Math.round(n * 20) / 20);

/** The next `count` weekly expiries (nearest first), holiday-adjusted. */
export function weeklyExpiries(index: IndexId, nowMs: number, isHoliday: HolidayCheck, count = 4): string[] {
  const out: string[] = [];
  let ms = nowMs;
  for (let i = 0; i < count; i++) {
    const e = nextWeeklyExpiry(index, ms, isHoliday);
    out.push(e);
    ms = istAt(e, SESSION.close) + 60_000;
  }
  return out;
}

/** Put-call ratio on open interest; null when there is no call OI. */
export function chainPcr(rows: OptionChainRowView[]): number | null {
  let ce = 0;
  let pe = 0;
  for (const r of rows) {
    ce += r.ce?.oi ?? 0;
    pe += r.pe?.oi ?? 0;
  }
  return ce > 0 ? round2(pe / ce) : null;
}

/** The strike at which option buyers' total payoff at expiry (and so writers' payout) is smallest; null without OI. */
export function chainMaxPain(rows: OptionChainRowView[]): number | null {
  if (!rows.some((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0)) return null;
  let best: number | null = null;
  let bestPain = Infinity;
  for (const at of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += (r.ce?.oi ?? 0) * Math.max(at.strike - r.strike, 0) + (r.pe?.oi ?? 0) * Math.max(r.strike - at.strike, 0);
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = at.strike;
    }
  }
  return best;
}

export interface MockChainInput {
  index: IndexId;
  spot: number;
  prevSpot: number;
  nowMs: number;
  expiries: string[];
  /** Requested expiry; the nearest one when missing or not listed. */
  expiry?: string;
}

/** Implied vol (decimal) at a strike: a mild put skew (higher vol below the spot) and a small smile. */
export function skewIv(atmIv: number, spot: number, strike: number, expiryRank: number): number {
  const m = Math.log(strike / spot);
  return (atmIv + 0.003 * expiryRank) * (1 - 1.6 * m + 6 * m * m);
}

export function buildMockChain(input: MockChainInput): OptionChainView {
  const { index, spot, prevSpot, nowMs, expiries } = input;
  const spec = CHAIN_SPEC[index];
  const expiry = input.expiry && expiries.includes(input.expiry) ? input.expiry : expiries[0];
  const rank = Math.max(0, expiries.indexOf(expiry));
  const closeMs = istAt(expiry, SESSION.close);
  const tYears = Math.max(closeMs - nowMs, HOUR_MS / 4) / (365 * DAY_MS);
  const tPrev = tYears + 1 / 365;
  const atmStrike = Math.round(spot / spec.step) * spec.step;
  const bucket = Math.floor(nowMs / JITTER_BUCKET_MS);
  const oiScale = OI_SCALE_BY_EXPIRY[rank] ?? 0.12;

  const side = (strike: number, type: "CE" | "PE", ivDec: number): OptionSideView => {
    const stable = mulberry32(hashString(`${index}|${expiry}|${strike}|${type}`));
    const live = mulberry32(hashString(`${index}|${expiry}|${strike}|${type}|${bucket}`));
    const iv = ivDec * (1 + (live() - 0.5) * 0.01);
    const g = bsGreeks({ spot, strike, tYears, vol: iv, r: RATE, type });
    const ltp = tick05(g.price);
    const close = tick05(bsPrice({ spot: prevSpot, strike, tYears: tPrev, vol: ivDec * 1.02, r: RATE, type }));
    const change = round2(ltp - close);
    const spread = Math.max(0.05, tick05(ltp * 0.0025));
    const bid = Math.max(0.05, tick05(ltp - spread / 2 - (live() < 0.5 ? 0.05 : 0)));
    const ask = tick05(bid + spread + (live() < 0.3 ? 0.05 : 0));

    // OI: calls build above the spot, puts below; round strikes draw more.
    const dist = (strike - spot) / spec.step;
    const centre = type === "CE" ? 4 : -4;
    const shape = Math.exp(-(((dist - centre) / 9) ** 2));
    const roundBonus = strike % spec.round[0] === 0 ? 1.9 : strike % spec.round[1] === 0 ? 1.35 : 1;
    const noise = 0.75 + stable() * 0.5;
    const lots = Math.max(1, Math.round((spec.oiPeak * oiScale * shape * roundBonus * noise) / spec.lotSize));
    const intraday = 1 + (live() - 0.5) * 0.004;
    const oi = Math.round(lots * intraday) * spec.lotSize;
    const prevOi = Math.round(lots * (0.7 + stable() * 0.5)) * spec.lotSize;
    const volume = Math.round((lots * (1.5 + stable() * 3) * (0.3 + Math.exp(-((dist / 6) ** 2)))) * (0.98 + live() * 0.04)) * spec.lotSize;

    // Buyer's probability of profit: the index past the breakeven at expiry.
    const sdT = iv * Math.sqrt(tYears);
    const be = type === "CE" ? strike + ltp : Math.max(strike - ltp, 1);
    const z = Math.log(spot / be) / sdT - sdT / 2;
    const pop = round2((type === "CE" ? normCdf(z) : normCdf(-z)) * 100);

    return {
      instrumentKey: `${index === "NIFTY" ? "NSE_FO" : "BSE_FO"}|${hashString(`${index}${expiry}${strike}${type}`) % 900_000 + 100_000}`,
      ltp,
      close,
      change,
      changePct: close > 0 ? round2((change / close) * 100) : null,
      bid,
      ask,
      bidQty: (1 + Math.floor(live() * 40)) * spec.lotSize,
      askQty: (1 + Math.floor(live() * 40)) * spec.lotSize,
      volume,
      oi,
      prevOi,
      oiChange: oi - prevOi,
      iv: round2(iv * 100),
      delta: Math.round(g.delta * 10000) / 10000,
      gamma: Math.round(g.gamma * 1e6) / 1e6,
      theta: round2(g.thetaPerYear / 365),
      vega: round2(g.vega / 100),
      pop,
    };
  };

  const rows: OptionChainRowView[] = [];
  for (let k = -CHAIN_HALF_WIDTH; k <= CHAIN_HALF_WIDTH; k++) {
    const strike = atmStrike + k * spec.step;
    const iv = skewIv(spec.atmIv, spot, strike, rank);
    rows.push({ strike, ce: side(strike, "CE", iv), pe: side(strike, "PE", iv) });
  }

  return {
    index,
    expiry,
    expiries: [...expiries],
    lotSize: spec.lotSize,
    spot,
    atmStrike,
    pcr: chainPcr(rows),
    maxPain: chainMaxPain(rows),
    rows,
    fetchedAt: toIstIso(nowMs),
    source: "mock",
    error: null,
  };
}
