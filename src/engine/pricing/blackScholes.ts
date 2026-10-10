/**
 * Black-Scholes for European index options (no dividends; NIFTY/SENSEX options are European).
 * Volatility is a decimal (0.14 = 14%); time is in years of TRADING time (see timeToExpiry.ts).
 */
import type { OptionType } from "../types";

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Standard normal CDF, double-precision accurate (|err| ~ 1e-15): Hart's algorithm 5666
 * as given by G. West, "Better approximations to cumulative normal functions" (2005).
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  let c: number;
  if (ax > 37) {
    c = 0;
  } else {
    const e = Math.exp((-ax * ax) / 2);
    if (ax < 7.07106781186547) {
      let n = 3.52624965998911e-2 * ax + 0.700383064443688;
      n = n * ax + 6.37396220353165;
      n = n * ax + 33.912866078383;
      n = n * ax + 112.079291497871;
      n = n * ax + 221.213596169931;
      n = n * ax + 220.206867912376;
      let d = 8.83883476483184e-2 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207;
      d = d * ax + 86.7807322029461;
      d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831;
      d = d * ax + 793.826512519948;
      d = d * ax + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = ax + 0.65;
      b = ax + 4 / b;
      b = ax + 3 / b;
      b = ax + 2 / b;
      b = ax + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

export interface BsInput {
  spot: number;
  strike: number;
  /** Years to expiry (trading time). */
  tYears: number;
  /** Annualized volatility as a decimal, e.g. 0.14. */
  vol: number;
  /** Continuously compounded risk-free rate, annual decimal. */
  r: number;
  type: OptionType;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Price change per 1.00 (100 vol points) change in volatility. */
  vega: number;
  thetaPerYear: number;
  /** Per trading day: thetaPerYear / 252. */
  thetaPerDay: number;
}

const TRADING_DAYS_PER_YEAR = 252;

function intrinsic(i: BsInput): number {
  return i.type === "CE" ? Math.max(i.spot - i.strike, 0) : Math.max(i.strike - i.spot, 0);
}

function degenerate(i: BsInput): boolean {
  return !(i.tYears > 0) || !(i.vol > 0) || !(i.spot > 0) || !(i.strike > 0);
}

function d1d2(i: BsInput): { d1: number; d2: number; sqrtT: number } {
  const sqrtT = Math.sqrt(i.tYears);
  const d1 = (Math.log(i.spot / i.strike) + (i.r + (i.vol * i.vol) / 2) * i.tYears) / (i.vol * sqrtT);
  return { d1, d2: d1 - i.vol * sqrtT, sqrtT };
}

/** Option price; intrinsic value when tYears <= 0 or vol <= 0. */
export function bsPrice(i: BsInput): number {
  if (degenerate(i)) return intrinsic(i);
  const { d1, d2 } = d1d2(i);
  const df = Math.exp(-i.r * i.tYears);
  const p =
    i.type === "CE"
      ? i.spot * normCdf(d1) - i.strike * df * normCdf(d2)
      : i.strike * df * normCdf(-d2) - i.spot * normCdf(-d1);
  return Math.max(p, 0);
}

export function bsGreeks(i: BsInput): Greeks {
  if (degenerate(i)) {
    const price = intrinsic(i);
    const atm = i.spot === i.strike;
    const delta =
      i.type === "CE" ? (i.spot > i.strike ? 1 : atm ? 0.5 : 0) : i.spot < i.strike ? -1 : atm ? -0.5 : 0;
    return { price, delta, gamma: 0, vega: 0, thetaPerYear: 0, thetaPerDay: 0 };
  }
  const { d1, d2, sqrtT } = d1d2(i);
  const df = Math.exp(-i.r * i.tYears);
  const pdf = normPdf(d1);
  const price = bsPrice(i);
  const gamma = pdf / (i.spot * i.vol * sqrtT);
  const vega = i.spot * pdf * sqrtT;
  const decay = (-i.spot * pdf * i.vol) / (2 * sqrtT);
  let delta: number;
  let thetaPerYear: number;
  if (i.type === "CE") {
    delta = normCdf(d1);
    thetaPerYear = decay - i.r * i.strike * df * normCdf(d2);
  } else {
    delta = normCdf(d1) - 1;
    thetaPerYear = decay + i.r * i.strike * df * normCdf(-d2);
  }
  return { price, delta, gamma, vega, thetaPerYear, thetaPerDay: thetaPerYear / TRADING_DAYS_PER_YEAR };
}

const IV_MIN = 0.01;
const IV_MAX = 3;

/**
 * Implied volatility in [0.01, 3] (decimal) by safeguarded Newton-Raphson with bisection fallback.
 * Null when the price is outside the prices reachable within those bounds, or inputs are degenerate.
 */
export function impliedVol(price: number, i: Omit<BsInput, "vol">): number | null {
  if (!Number.isFinite(price) || !(i.tYears > 0) || !(i.spot > 0) || !(i.strike > 0)) return null;
  const at = (vol: number) => bsPrice({ ...i, vol });
  let lo = IV_MIN;
  let hi = IV_MAX;
  const pLo = at(lo);
  const pHi = at(hi);
  const tol = Math.max(1e-10, price * 1e-10);
  if (price < pLo - tol || price > pHi + tol) return null;
  if (Math.abs(price - pLo) <= tol) return lo;
  if (Math.abs(price - pHi) <= tol) return hi;
  let vol = 0.2;
  for (let k = 0; k < 100; k++) {
    const p = at(vol);
    const diff = p - price;
    if (Math.abs(diff) <= tol) return vol;
    if (diff > 0) hi = vol;
    else lo = vol;
    const vega = bsGreeks({ ...i, vol }).vega;
    let next = vega > 1e-12 ? vol - diff / vega : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - vol) < 1e-12) return next;
    vol = next;
  }
  return vol;
}
