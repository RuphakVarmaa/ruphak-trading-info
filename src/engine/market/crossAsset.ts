/**
 * Cross-asset moves (US futures, crude, dollar, yields, Asia) and the overnight-gap model
 * `expectedGapPct = sum(beta_k * move_k)`, re-fit by ridge regression on past sessions.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { DAY_MS, HOUR_MS } from "../clock";
import { GLOBAL_KEYS, MARKET_SYMBOLS, type Candle, type GlobalKey, type IndexId, type MarketSnapshot } from "../types";
import { BAR_5M_MS, groupByDate, isTradingDayCached, istDateOf, lastIndexAtOrBefore, sessionBars } from "./candles";
import { ridgeRegression } from "./indicators";

export const GLOBAL_SYMBOL: Record<GlobalKey, string> = {
  ES: MARKET_SYMBOLS.ES,
  NQ: MARKET_SYMBOLS.NQ,
  CL: MARKET_SYMBOLS.CL,
  BZ: MARKET_SYMBOLS.BZ,
  GC: MARKET_SYMBOLS.GC,
  DXY: MARKET_SYMBOLS.DXY,
  USDINR: MARKET_SYMBOLS.USDINR,
  US10Y: MARKET_SYMBOLS.US10Y,
  VIXUS: MARKET_SYMBOLS.VIXUS,
  N225: MARKET_SYMBOLS.N225,
  HSI: MARKET_SYMBOLS.HSI,
  SSE: MARKET_SYMBOLS.SSE,
};

/**
 * How long after a Yahoo DAILY bar's timestamp its close is final, per symbol (with a margin).
 * Yahoo stamps daily bars at the session start in exchange time: Indian indices 09:15 IST
 * (close 15:30), CME/ICE futures and DXY 00:00 New York (settle by 17:00), ^TNX ~08:20 New York
 * (close 16:00), ^VIX 03:00 New York (close 16:15), Tokyo 09:00 JST (close 15:30), Hong Kong
 * 09:30 HKT (close 16:10), Shanghai 09:30 CST (close 15:00), FX 00:00 London (24 h day).
 * Unknown symbols get a full day, which can never look ahead.
 */
const DAILY_FINAL_AFTER_MS: Record<string, number> = {
  [MARKET_SYMBOLS.NIFTY]: 6.5 * HOUR_MS,
  [MARKET_SYMBOLS.SENSEX]: 6.5 * HOUR_MS,
  [MARKET_SYMBOLS.BANKNIFTY]: 6.5 * HOUR_MS,
  [MARKET_SYMBOLS.INDIAVIX]: 6.5 * HOUR_MS,
  [MARKET_SYMBOLS.ES]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.NQ]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.CL]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.BZ]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.GC]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.DXY]: 18 * HOUR_MS,
  [MARKET_SYMBOLS.USDINR]: 24 * HOUR_MS,
  [MARKET_SYMBOLS.US10Y]: 9 * HOUR_MS,
  [MARKET_SYMBOLS.VIXUS]: 14 * HOUR_MS,
  [MARKET_SYMBOLS.N225]: 7 * HOUR_MS,
  [MARKET_SYMBOLS.HSI]: 7 * HOUR_MS,
  [MARKET_SYMBOLS.SSE]: 6 * HOUR_MS,
};

/** Delay after a daily bar's timestamp at which its close may be used (point-in-time rule). */
export function dailyFinalAfterMs(symbol: string): number {
  return DAILY_FINAL_AFTER_MS[symbol] ?? DAY_MS;
}

export interface PricePoint {
  price: number;
  /** When this price was (conservatively) observable. */
  obsMs: number;
  source: "5m" | "daily";
}

/**
 * Latest price observable at time T:
 * - 5m: close of the last bar closed by T (t + 5 min <= T); when the newest bar of the series is
 *   still forming at T (t <= T < t + 5 min, live data), its running close is used instead;
 * - daily: close of the last daily bar with t + dailyFinalAfterMs <= T;
 * whichever was observable later wins (5m on ties). Null when neither exists.
 */
export function pricePointAtOrBefore(
  intraday: Candle[] | undefined,
  daily: Candle[] | undefined,
  T: number,
  finalAfterMs = DAY_MS,
): PricePoint | null {
  let best: PricePoint | null = null;
  if (intraday && intraday.length > 0) {
    const i = lastIndexAtOrBefore(intraday, T - BAR_5M_MS);
    if (i >= 0) best = { price: intraday[i].c, obsMs: intraday[i].t + BAR_5M_MS, source: "5m" };
    const last = intraday[intraday.length - 1];
    if (last.t <= T && T < last.t + BAR_5M_MS) best = { price: last.c, obsMs: T, source: "5m" };
  }
  if (daily && daily.length > 0) {
    const j = lastIndexAtOrBefore(daily, T - finalAfterMs);
    if (j >= 0) {
      const obsMs = daily[j].t + finalAfterMs;
      if (!best || obsMs > best.obsMs) best = { price: daily[j].c, obsMs, source: "daily" };
    }
  }
  return best && Number.isFinite(best.price) ? best : null;
}

/** Convenience wrapper over pricePointAtOrBefore for a snapshot symbol. */
export function priceAtOrBefore(snap: MarketSnapshot, symbol: string, T: number): number | null {
  return pricePointAtOrBefore(snap.candles[symbol], snap.daily[symbol], T, dailyFinalAfterMs(symbol))?.price ?? null;
}

function moveBetween(key: GlobalKey, from: number, to: number): number | null {
  if (key === "US10Y") {
    // ^TNX quotes the yield in percent (5.30 = 5.30%): report the change in basis points.
    const bp = (to - from) * 100;
    return Number.isFinite(bp) ? bp : null;
  }
  if (!(from > 0) || !(to > 0)) return null;
  const pct = (to / from - 1) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Percent change of each global asset from its last price at/before `fromMs` to its price at/before
 * `toMs` (5m candles, daily as fallback). US10Y is a change in basis points. Null when data is missing.
 * Assets that did not trade in between (holidays, e.g. Shanghai's Golden Week) report 0.
 */
export function globalMoves(snap: MarketSnapshot, fromMs: number, toMs: number): Record<GlobalKey, number | null> {
  const out = {} as Record<GlobalKey, number | null>;
  for (const key of GLOBAL_KEYS) {
    const sym = GLOBAL_SYMBOL[key];
    const finalAfter = dailyFinalAfterMs(sym);
    const a = pricePointAtOrBefore(snap.candles[sym], snap.daily[sym], fromMs, finalAfter);
    const b = pricePointAtOrBefore(snap.candles[sym], snap.daily[sym], toMs, finalAfter);
    out[key] = a && b ? moveBetween(key, a.price, b.price) : null;
  }
  return out;
}

/** Sum of beta * move over the keys present in `betas` whose move is known. */
export function expectedGapPct(moves: Record<GlobalKey, number | null>, betas: Record<string, number>): number {
  let s = 0;
  for (const [key, beta] of Object.entries(betas)) {
    const m = (moves as Record<string, number | null | undefined>)[key];
    if (typeof m === "number" && Number.isFinite(m) && Number.isFinite(beta)) s += beta * m;
  }
  return s;
}

export interface GapObservation {
  date: string;
  gapPct: number;
  moves: Record<GlobalKey, number | null>;
}

/**
 * One observation per past session visible in the snapshot: the index's opening gap
 * (first 5m open, else daily open, versus the prior session's last 5m close, else daily close)
 * and the global moves from the prior session's 15:30 IST close to that day's 09:15 IST open.
 * Returns the most recent `sessions` observations, oldest first.
 */
export function overnightObservations(
  snap: MarketSnapshot,
  index: IndexId,
  calendar: TradingCalendar,
  sessions: number,
): GapObservation[] {
  if (!(sessions > 0)) return [];
  const sym = MARKET_SYMBOLS[index];
  const intraday = sessionBars((snap.candles[sym] ?? []).filter((c) => c.t <= snap.t), calendar);
  const byDate = groupByDate(intraday);
  const dailyByDate = new Map<string, Candle>();
  for (const c of snap.daily[sym] ?? []) if (c.t <= snap.t) dailyByDate.set(istDateOf(c.t), c);
  const dates = [...new Set([...byDate.keys(), ...dailyByDate.keys()])]
    .filter((d) => isTradingDayCached(calendar, d))
    .sort();
  const out: GapObservation[] = [];
  for (const date of dates) {
    let prior: string;
    try {
      prior = calendar.prevTradingDay(date);
    } catch {
      continue;
    }
    const priorBars = byDate.get(prior);
    const prevClose = priorBars && priorBars.length > 0 ? priorBars[priorBars.length - 1].c : dailyByDate.get(prior)?.c;
    const dayBars = byDate.get(date);
    const open = dayBars && dayBars.length > 0 ? dayBars[0].o : dailyByDate.get(date)?.o;
    if (prevClose === undefined || open === undefined || !(prevClose > 0) || !(open > 0)) continue;
    out.push({
      date,
      gapPct: (open / prevClose - 1) * 100,
      moves: globalMoves(snap, calendar.closeMs(prior), calendar.openMs(date)),
    });
  }
  return out.slice(-Math.floor(sessions));
}

/**
 * Ridge fit of gapPct on the given keys' moves (no intercept), using only rows where every key is known.
 * Columns are scaled to unit RMS before the penalty so percent and basis-point inputs are treated alike;
 * the returned betas are in original units (gap % per 1% move, per 1 bp for US10Y).
 * Returns {} with fewer than 20 complete rows.
 */
export function fitGapBetas(obs: GapObservation[], keys: GlobalKey[], lambda: number): Record<string, number> {
  if (keys.length === 0) return {};
  const rows = obs.filter(
    (o) =>
      Number.isFinite(o.gapPct) &&
      keys.every((k) => {
        const v = o.moves[k];
        return typeof v === "number" && Number.isFinite(v);
      }),
  );
  if (rows.length < 20) return {};
  const X = rows.map((o) => keys.map((k) => o.moves[k] as number));
  const y = rows.map((o) => o.gapPct);
  const scale = keys.map((_, j) => {
    const rms = Math.sqrt(X.reduce((s, r) => s + r[j] * r[j], 0) / X.length);
    return rms > 0 ? rms : 1;
  });
  const beta = ridgeRegression(
    X.map((r) => r.map((v, j) => v / scale[j])),
    y,
    lambda,
  );
  const out: Record<string, number> = {};
  keys.forEach((k, j) => {
    out[k] = (beta[j] ?? 0) / scale[j];
  });
  return out;
}
