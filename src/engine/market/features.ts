/**
 * MarketFeatures for one traded index at snapshot time `snap.t`.
 *
 * Point-in-time: only 5m session bars CLOSED at `snap.t` feed the bar-based features; the snapshot
 * source is responsible for not exposing anything newer (ReplayMarketDataSource guarantees it).
 * Never throws on sparse data: missing inputs yield neutral values (0, 50 for percentiles,
 * FORMING for the opening range) and no NaN/Infinity ever leaves this module. If something
 * unexpected throws anyway, a neutral feature set with dataAgeSec = NO_DATA_AGE_SEC is returned so
 * the engine's staleness gate blocks trading.
 *
 * Deviations from the plain spec, on purpose:
 * - atrPctile20d compares today's mean true-range % with the SAME time-of-day window of prior sessions
 *   (intraday volatility is U-shaped; comparing a morning with full days would read as high vol every
 *   morning) and needs at least 5 prior sessions, else 50.
 * - realizedVol2h uses per-bar returns inside each session (a session's first bar contributes open->close),
 *   so bridging to the previous session never includes the overnight gap as a 5-minute return.
 * - gapResidualPct is 0 until today's open is known (pre-market there is no gap to explain).
 * - Divergence returns are measured over the same clock window for both legs (ending at the latest bar
 *   closed in both series) so a late-arriving bar in one series cannot fake a divergence.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { DAY_MS, MINUTE_MS, SESSION, istAt, istDate, istMidnight } from "../clock";
import type { EngineConfig } from "../config";
import {
  GLOBAL_KEYS,
  MARKET_SYMBOLS,
  type Candle,
  type GlobalKey,
  type IndexId,
  type IndicatorView,
  type Indicators,
  type MarketFeatures,
  type MarketSnapshot,
  type OpeningRange,
} from "../types";
import { logRetPct, percentileRank } from "../util/math";
import { BAR_5M_MS, isTradingDayCached, istDateOf, istMinuteOfDay } from "./candles";
import { dailyFinalAfterMs, expectedGapPct, globalMoves, pricePointAtOrBefore } from "./crossAsset";
import {
  annualizedVolPct,
  atr,
  barsSameSideOfVwap,
  bollinger,
  dmi,
  efficiencyRatio,
  ema,
  realizedVolPct,
  rsi,
  supertrend,
  trueRanges,
  vwap,
  vwapBands,
  zScore,
} from "./indicators";

/** dataAgeSec used when nothing is known: far above any staleness gate. */
export const NO_DATA_AGE_SEC = 999_999;

const ER_BARS = 12;
const ATR_BARS = 12;
const MIN_ATR_HISTORY_SESSIONS = 5;
const MIN_TODAY_BARS_FOR_RV = 6;
const DIVERGENCE_HISTORY_SESSIONS = 20;
const BANK_WINDOW_BARS = 3;
const DAILY_RV_CLOSES = 21;
/** Closed 5-minute bars (across sessions) the classic indicators are computed on: about 1.6 sessions. */
const INDICATOR_BARS = 120;
/** Daily closes needed for the EMA20/EMA50 daily bias. */
const DAILY_BIAS_CLOSES = 50;
const SESSION_SLOTS = (SESSION.close - SESSION.open) / 5;

interface Series {
  /** Session bars with open time <= t (the newest may still be forming in live data). */
  visible: Candle[];
  /** Session bars closed at t. */
  closed: Candle[];
  /** Closed bars grouped by IST date. */
  byDate: Map<string, Candle[]>;
  /** Closed bars of today's IST date. */
  today: Candle[];
  /** Open of today's first visible bar (closed or forming), null before the first bar. */
  todayOpen: number | null;
  /** Dates before today that have closed bars, ascending. */
  prevDates: string[];
  /** Daily bars with t <= snap.t. */
  daily: Candle[];
}

/**
 * Calendar days of 5m history the features need: enough prior sessions for the ATR percentile
 * (sessionLookbackDays), divergence z-scores (20) and daily realized vol (21 closes), plus slack for
 * weekends and holidays. Older bars are skipped without being touched.
 */
function historyWindowDays(cfg: EngineConfig): number {
  const sessions = Math.max(cfg.features.sessionLookbackDays, DIVERGENCE_HISTORY_SESSIONS, DAILY_RV_CLOSES);
  return Math.ceil((sessions * 7) / 5) + 14;
}

/**
 * Prepared series are cached per snapshot object, keyed by symbol, time and window, so computing
 * NIFTY and SENSEX features from one snapshot prepares each series once. Snapshots are treated as
 * immutable apart from `t`.
 */
const seriesCache = new WeakMap<MarketSnapshot, WeakMap<TradingCalendar, Map<string, Series>>>();

function firstIndexAtOrAfter(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One pass over the history window: session filter, closed/visible split and grouping by date. */
function prepare(
  snap: MarketSnapshot,
  symbol: string,
  calendar: TradingCalendar,
  t: number,
  today: string,
  windowDays: number,
): Series {
  let byCal = seriesCache.get(snap);
  if (!byCal) seriesCache.set(snap, (byCal = new WeakMap()));
  let byKey = byCal.get(calendar);
  if (!byKey) byCal.set(calendar, (byKey = new Map()));
  const key = `${symbol}|${t}|${windowDays}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  const raw = snap.candles[symbol] ?? [];
  const fromMs = istMidnight(today) - windowDays * DAY_MS;
  const visible: Candle[] = [];
  const closed: Candle[] = [];
  const byDate = new Map<string, Candle[]>();
  let todayOpen: number | null = null;
  // Candles are sorted by open time (MarketSnapshot contract), so the window is a contiguous range.
  for (let i = firstIndexAtOrAfter(raw, fromMs); i < raw.length; i++) {
    const c = raw[i];
    if (c.t > t) break;
    if (!(Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))) continue;
    const m = istMinuteOfDay(c.t);
    if (m < SESSION.open || m >= SESSION.close) continue;
    const d = istDateOf(c.t);
    if (!isTradingDayCached(calendar, d)) continue;
    visible.push(clipWicks(c));
    if (d === today && todayOpen === null) todayOpen = c.o > 0 ? c.o : null;
    if (c.t + BAR_5M_MS <= t) {
      const clean = visible[visible.length - 1];
      closed.push(clean);
      const arr = byDate.get(d);
      if (arr) arr.push(clean);
      else byDate.set(d, [clean]);
    }
  }
  const series: Series = {
    visible,
    closed,
    byDate,
    today: byDate.get(today) ?? [],
    todayOpen,
    prevDates: [...byDate.keys()].filter((d) => d < today).sort(),
    daily: (snap.daily[symbol] ?? []).filter((c) => c.t <= t && Number.isFinite(c.c)),
  };
  byKey.set(key, series);
  return series;
}

/**
 * Largest wick, in percent of price, a 5-minute bar may show beyond its open/close body. Yahoo's
 * index bars occasionally carry a bad print (SENSEX on 7 Oct 2026, 15:20: high 73,477 on a
 * 72,570 -> 72,768 bar, a 0.97% spike), which would distort ATR, ADX, Supertrend and the
 * previous-day high for more than a session.
 */
export const MAX_WICK_PCT = 0.3;

/** The bar with any wick beyond MAX_WICK_PCT of its body clipped back to that limit. */
export function clipWicks(c: Candle): Candle {
  const top = Math.max(c.o, c.c);
  const bottom = Math.min(c.o, c.c);
  const hiCap = top * (1 + MAX_WICK_PCT / 100);
  const loCap = bottom * (1 - MAX_WICK_PCT / 100);
  if (c.h <= hiCap && c.l >= loCap) return c;
  return { ...c, h: Math.min(c.h, hiCap), l: Math.max(c.l, loCap) };
}

/** Close of the previous session: 5m bars of `prevDate`, its daily bar, else the latest earlier data. */
function prevSessionClose(s: Series, prevDate: string | null, today: string): number | null {
  if (prevDate) {
    const bars = s.byDate.get(prevDate);
    if (bars && bars.length > 0) return bars[bars.length - 1].c;
    for (let i = s.daily.length - 1; i >= 0; i--) if (istDateOf(s.daily[i].t) === prevDate) return s.daily[i].c;
  }
  if (s.prevDates.length > 0) {
    const bars = s.byDate.get(s.prevDates[s.prevDates.length - 1]) ?? [];
    if (bars.length > 0) return bars[bars.length - 1].c;
  }
  for (let i = s.daily.length - 1; i >= 0; i--) if (istDateOf(s.daily[i].t) < today) return s.daily[i].c;
  return null;
}

/** Per-bar log returns (percent) inside one session; the first bar contributes open -> close. */
function sessionReturns(bars: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) out.push(logRetPct(i === 0 ? bars[0].o : bars[i - 1].c, bars[i].c));
  return out;
}

function meanTrPct(bars: Candle[]): number {
  const trs = trueRanges(bars);
  let s = 0;
  let k = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].c > 0) {
      s += (trs[i] / bars[i].c) * 100;
      k++;
    }
  }
  return k > 0 ? s / k : 0;
}

/** Price at a 5-minute boundary T within one session's closed bars (lenient: last bar closed by T). */
function priceAtBoundary(bars: Candle[], T: number): number | null {
  if (bars.length === 0) return null;
  if (T <= bars[0].t) return bars[0].o;
  let p: number | null = null;
  for (const b of bars) {
    if (b.t + BAR_5M_MS <= T) p = b.c;
    else break;
  }
  return p ?? bars[0].o;
}

/** Session bars indexed by 5-minute slot from 09:15 (slot k opens at 09:15 + 5k minutes). */
function slotIndex(bars: Candle[], openMs: number): (Candle | undefined)[] {
  const slots: (Candle | undefined)[] = new Array(SESSION_SLOTS);
  for (const c of bars) {
    const k = (c.t - openMs) / BAR_5M_MS;
    if (Number.isInteger(k) && k >= 0 && k < SESSION_SLOTS) slots[k] = c;
  }
  return slots;
}

/** Strict boundary price: the bar ending exactly at T (or the open of the bar starting at the session open). */
function strictBoundaryPrice(slots: (Candle | undefined)[], T: number, openMs: number): number | null {
  const k = (T - openMs) / BAR_5M_MS;
  if (k === 0) return slots[0]?.o ?? null;
  return slots[k - 1]?.c ?? null;
}

/** Log return over the last `nBars` bars of one series (from the session open when fewer). */
function ownWindowRet(bars: Candle[], nBars: number, openMs: number): number {
  if (bars.length === 0) return 0;
  const end = bars[bars.length - 1].t + BAR_5M_MS;
  const start = Math.max(end - nBars * BAR_5M_MS, openMs);
  const p0 = priceAtBoundary(bars, start);
  const p1 = priceAtBoundary(bars, end);
  return p0 !== null && p1 !== null ? logRetPct(p0, p1) : 0;
}

/** Returns of two series over the same clock window ending at the latest bar closed in both. */
function alignedWindowRets(a: Candle[], b: Candle[], nBars: number, openMs: number): { a: number; b: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const end = Math.min(a[a.length - 1].t, b[b.length - 1].t) + BAR_5M_MS;
  const start = Math.max(end - nBars * BAR_5M_MS, openMs);
  const a0 = priceAtBoundary(a, start);
  const a1 = priceAtBoundary(a, end);
  const b0 = priceAtBoundary(b, start);
  const b1 = priceAtBoundary(b, end);
  if (a0 === null || a1 === null || b0 === null || b1 === null) return null;
  return { a: logRetPct(a0, a1), b: logRetPct(b0, b1) };
}

/** Non-overlapping `nBars`-bar window spreads f(retA, retB) over past sessions present in both series. */
function historicalSpreads(
  aByDate: Map<string, Candle[]>,
  bByDate: Map<string, Candle[]>,
  dates: string[],
  nBars: number,
  spread: (ra: number, rb: number) => number,
): number[] {
  const out: number[] = [];
  const w = nBars * BAR_5M_MS;
  for (const d of dates) {
    const A = aByDate.get(d);
    const B = bByDate.get(d);
    if (!A || !B || A.length === 0 || B.length === 0) continue;
    const open = istAt(d, SESSION.open);
    const close = istAt(d, SESSION.close);
    const aSlots = slotIndex(A, open);
    const bSlots = slotIndex(B, open);
    for (let s = open; s + w <= close; s += w) {
      const a0 = strictBoundaryPrice(aSlots, s, open);
      const a1 = strictBoundaryPrice(aSlots, s + w, open);
      const b0 = strictBoundaryPrice(bSlots, s, open);
      const b1 = strictBoundaryPrice(bSlots, s + w, open);
      if (a0 === null || a1 === null || b0 === null || b1 === null) continue;
      out.push(spread(logRetPct(a0, a1), logRetPct(b0, b1)));
    }
  }
  return out;
}

function fin(x: number, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sanitizeGlobal(g: Record<GlobalKey, number | null>): Record<GlobalKey, number | null> {
  const out = {} as Record<GlobalKey, number | null>;
  for (const k of GLOBAL_KEYS) {
    const v = g[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

function snapshotAge(snap: MarketSnapshot): number {
  const a = snap.dataAgeSec;
  if (typeof a !== "number" || !Number.isFinite(a)) return NO_DATA_AGE_SEC;
  return Math.max(0, a);
}

function calendarFields(index: IndexId, t: number, today: string, calendar: TradingCalendar) {
  const openMs = istAt(today, SESSION.open);
  const closeMs = istAt(today, SESSION.close);
  const next = safe(() => calendar.nextScheduledEvent(t, ["HIGH", "MED"]), null);
  const recent = safe(() => calendar.recentScheduledEvent(t, 30), null);
  return {
    minutesSinceOpen: fin(Math.max(0, (t - openMs) / MINUTE_MS)),
    minutesToClose: fin(Math.max(0, (closeMs - t) / MINUTE_MS)),
    isExpiryDay: safe(() => calendar.isExpiryDay(index, today), false),
    tradingDaysToExpiry: fin(safe(() => calendar.tradingDaysBetween(today, calendar.nextExpiry(index, t)), 0)),
    nextScheduledEvent: next
      ? { id: next.id, name: next.title, impact: next.impact, minutesAway: fin((next.at - t) / MINUTE_MS) }
      : null,
    recentScheduledEvent: recent
      ? { id: recent.id, name: recent.title, impact: recent.impact, minutesAgo: fin((t - recent.at) / MINUTE_MS) }
      : null,
  };
}

/** Indicator values while nothing is known (all finite). */
export const NEUTRAL_INDICATORS: Indicators = {
  rsi14: 50,
  adx14: 0,
  plusDi14: 0,
  minusDi14: 0,
  ema9: 0,
  ema21: 0,
  ema9SlopePct: 0,
  supertrendDir: 0,
  supertrendLine: 0,
  bbPctB: 0.5,
  bbWidthPct: 0,
  vwap: 0,
  vwapZ: 0,
  dailyBias: 0,
  dailyEmaGapPct: 0,
  prevDayHigh: 0,
  prevDayLow: 0,
  prevDayClose: 0,
};

export const NEUTRAL_OPENING_RANGE: OpeningRange = {
  high: 0,
  low: 0,
  state: "FORMING",
  strengthAtr: 0,
  barsOutside: 0,
  lastBreak: null,
  barsSinceReentry: 0,
};

/** The indicator readings behind a decision, for the dashboard. */
export function indicatorView(f: MarketFeatures): IndicatorView {
  return { ...f.indicators, spot: f.spot, atrPct5m: f.atrPct5m, vwapDistPct: f.vwapDistPct, openingRange: f.openingRange };
}

function emptyGlobal(): Record<GlobalKey, number | null> {
  const out = {} as Record<GlobalKey, number | null>;
  for (const k of GLOBAL_KEYS) out[k] = null;
  return out;
}

/** Neutral features (used when the build fails unexpectedly): stale by construction. */
export function neutralFeatures(index: IndexId, snap: MarketSnapshot, calendar: TradingCalendar): MarketFeatures {
  const t = fin(snap.t);
  const today = istDate(t);
  const ltp = snap.ltp?.[index];
  return {
    index,
    t,
    spot: typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0,
    dataAgeSec: NO_DATA_AGE_SEC,
    ret5m: 0,
    ret15m: 0,
    ret60m: 0,
    retFromOpen: 0,
    vwapDistPct: 0,
    barsSameSideOfVwap: 0,
    openingRange: { ...NEUTRAL_OPENING_RANGE },
    efficiencyRatio60m: 0,
    atrPct5m: 0,
    atrPctile20d: 50,
    gapPct: 0,
    expectedGapPct: 0,
    gapResidualPct: 0,
    vix: 0,
    vixChangePct: 0,
    realizedVol2h: 0,
    realizedVol20d: 0,
    rvIvRatio: 0,
    divergence: { vsOtherIndexZ: 0, vsBankNiftyZ: 0, otherIndexRet30m: 0, bankNiftyRet15m: 0, selfRet30m: 0 },
    global: emptyGlobal(),
    ...safe(() => calendarFields(index, t, today, calendar), {
      minutesSinceOpen: 0,
      minutesToClose: 0,
      isExpiryDay: false,
      tradingDaysToExpiry: 0,
      nextScheduledEvent: null,
      recentScheduledEvent: null,
    }),
    indicators: { ...NEUTRAL_INDICATORS },
  };
}

export function computeFeatures(
  index: IndexId,
  snap: MarketSnapshot,
  calendar: TradingCalendar,
  cfg: EngineConfig,
): MarketFeatures {
  try {
    return buildFeatures(index, snap, calendar, cfg);
  } catch {
    return neutralFeatures(index, snap, calendar);
  }
}

function buildFeatures(index: IndexId, snap: MarketSnapshot, calendar: TradingCalendar, cfg: EngineConfig): MarketFeatures {
  const t = snap.t;
  const today = istDate(t);
  const otherIndex: IndexId = index === "NIFTY" ? "SENSEX" : "NIFTY";
  const windowDays = historyWindowDays(cfg);
  const self = prepare(snap, MARKET_SYMBOLS[index], calendar, t, today, windowDays);
  const other = prepare(snap, MARKET_SYMBOLS[otherIndex], calendar, t, today, windowDays);
  const bank = prepare(snap, MARKET_SYMBOLS.BANKNIFTY, calendar, t, today, windowDays);
  const vixS = prepare(snap, MARKET_SYMBOLS.INDIAVIX, calendar, t, today, windowDays);
  const openMs = istAt(today, SESSION.open);

  // --- Spot -------------------------------------------------------------------------------
  const ltpRaw = snap.ltp?.[index];
  const hasLtp = typeof ltpRaw === "number" && Number.isFinite(ltpRaw) && ltpRaw > 0;
  let spot = 0;
  if (hasLtp) spot = ltpRaw;
  else if (self.closed.length > 0) spot = self.closed[self.closed.length - 1].c;
  else {
    // Daily fallback: only completed sessions (today's daily bar may be running or, in a careless
    // snapshot, final).
    for (let i = self.daily.length - 1; i >= 0; i--) {
      if (istDateOf(self.daily[i].t) < today) {
        spot = self.daily[i].c;
        break;
      }
    }
  }
  if (!(spot > 0)) spot = 0;

  // --- Returns ----------------------------------------------------------------------------
  const tb = self.today;
  const n = tb.length;
  const retBack = (k: number): number => {
    if (n === 0 || spot <= 0) return 0;
    const ref = n - 1 - k >= 0 ? tb[n - 1 - k].c : tb[0].o;
    return logRetPct(ref, spot);
  };
  const ret5m = retBack(1);
  const ret15m = retBack(3);
  const ret60m = retBack(12);
  let retFromOpen = 0;
  if (n > 0 && spot > 0) retFromOpen = logRetPct(tb[0].o, spot);
  else if (hasLtp && self.todayOpen !== null) retFromOpen = logRetPct(self.todayOpen, spot);

  // --- VWAP -------------------------------------------------------------------------------
  const vw = n > 0 ? vwap(tb) : 0;
  const vwapDistPct = vw > 0 && spot > 0 ? (spot / vw - 1) * 100 : 0;
  const sameSide = barsSameSideOfVwap(tb);

  // --- Opening range ----------------------------------------------------------------------
  const orEnd = openMs + cfg.features.openingRangeMin * MINUTE_MS;
  const orBars = tb.filter((b) => b.t < orEnd);
  let orHigh = 0;
  let orLow = 0;
  if (orBars.length > 0) {
    orHigh = Math.max(...orBars.map((b) => b.h));
    orLow = Math.min(...orBars.map((b) => b.l));
  }
  let orState: MarketFeatures["openingRange"]["state"] = "FORMING";
  const orComplete = t >= orEnd && n > 0 && tb[n - 1].t + BAR_5M_MS >= orEnd;
  let orStrengthAtr = 0;
  let orBarsOutside = 0;
  let orLastBreak: OpeningRange["lastBreak"] = null;
  let orBarsSinceReentry = 0;
  if (orComplete && orBars.length > 0) {
    const lc = tb[n - 1].c;
    orState = lc > orHigh ? "BROKE_UP" : lc < orLow ? "BROKE_DOWN" : "INSIDE";
    // Walk the bars after the range: how long the current break has lasted, and failed breaks.
    for (const b of tb) {
      if (b.t < orEnd) continue;
      const side = b.c > orHigh ? "UP" : b.c < orLow ? "DOWN" : null;
      if (side) {
        orBarsOutside = side === orLastBreak && orBarsSinceReentry === 0 ? orBarsOutside + 1 : 1;
        orLastBreak = side;
        orBarsSinceReentry = 0;
      } else {
        orBarsOutside = 0;
        if (orLastBreak) orBarsSinceReentry++;
      }
    }
    const atrPts = atr(tb, ATR_BARS);
    if (atrPts > 0 && orState === "BROKE_UP") orStrengthAtr = Math.min(10, (lc - orHigh) / atrPts);
    else if (atrPts > 0 && orState === "BROKE_DOWN") orStrengthAtr = Math.min(10, (orLow - lc) / atrPts);
  }

  // --- Efficiency, ATR ------------------------------------------------------------------------
  const erCloses = tb.slice(-ER_BARS).map((b) => b.c);
  const efficiencyRatio60m = erCloses.length >= 3 ? efficiencyRatio(erCloses) : 0;
  const atrPct5m = n > 0 && spot > 0 ? (atr(tb, ATR_BARS) / spot) * 100 : 0;
  let atrPctile20d = 50;
  if (n > 0) {
    const cutMin = istMinuteOfDay(tb[n - 1].t);
    const hist: number[] = [];
    for (const d of self.prevDates.slice(-cfg.features.sessionLookbackDays)) {
      const bars = (self.byDate.get(d) ?? []).filter((b) => istMinuteOfDay(b.t) <= cutMin);
      if (bars.length > 0) hist.push(meanTrPct(bars));
    }
    if (hist.length >= MIN_ATR_HISTORY_SESSIONS) atrPctile20d = percentileRank(hist, meanTrPct(tb));
  }

  // --- Gap ----------------------------------------------------------------------------------
  const prevDate = safe<string | null>(() => calendar.prevTradingDay(today), null);
  const prevCloseMs = prevDate !== null ? calendar.closeMs(prevDate) : safe(() => calendar.prevCloseMs(t), t);
  const prevClose = prevSessionClose(self, prevDate, today);
  const openKnown = self.todayOpen !== null && prevClose !== null && prevClose > 0;
  const gapPct = openKnown ? ((self.todayOpen as number) / (prevClose as number) - 1) * 100 : 0;
  const expGap = expectedGapPct(globalMoves(snap, prevCloseMs, openMs), cfg.features.gapBetas);
  const gapResidualPct = openKnown ? gapPct - expGap : 0;

  // --- VIX ----------------------------------------------------------------------------------
  const vixFinal = dailyFinalAfterMs(MARKET_SYMBOLS.INDIAVIX);
  const vixPoint = pricePointAtOrBefore(vixS.visible, vixS.daily, t, vixFinal);
  const vix = vixPoint && vixPoint.price > 0 ? vixPoint.price : 0;
  // Previous close = the latest VIX observation before today's open, chosen by the same rule as the
  // current value (Yahoo's official daily close can differ from the last 5m bar), so the change is 0
  // pre-market.
  const vixBeforeToday = vixS.closed.filter((c) => c.t < openMs);
  const vixPrev =
    pricePointAtOrBefore(vixBeforeToday, vixS.daily, Math.min(openMs, t), vixFinal)?.price ?? prevSessionClose(vixS, prevDate, today);
  const vixChangePct = vix > 0 && vixPrev !== null && vixPrev > 0 ? (vix / vixPrev - 1) * 100 : 0;

  // --- Realized volatility ----------------------------------------------------------------------
  const rvBars = Math.max(2, cfg.features.rvBars);
  let rets = sessionReturns(tb).slice(-rvBars);
  if (n < MIN_TODAY_BARS_FOR_RV && self.prevDates.length > 0) {
    const prevBars = self.byDate.get(self.prevDates[self.prevDates.length - 1]) ?? [];
    const need = rvBars - rets.length;
    if (need > 0) rets = [...sessionReturns(prevBars).slice(-need), ...rets];
  }
  const barsPerDay = cfg.pricing.tradingMinutesPerDay / 5;
  const realizedVol2h = annualizedVolPct(rets, barsPerDay * cfg.pricing.tradingDaysPerYear);

  const closeByDate = new Map<string, number>();
  for (const d of self.prevDates) {
    const bars = self.byDate.get(d) ?? [];
    if (bars.length > 0) closeByDate.set(d, bars[bars.length - 1].c);
  }
  for (const c of self.daily) {
    const d = istDateOf(c.t);
    if (d < today) closeByDate.set(d, c.c);
  }
  const dailyCloses = [...closeByDate.keys()]
    .sort()
    .slice(-DAILY_RV_CLOSES)
    .map((d) => closeByDate.get(d) as number);
  const realizedVol20d = realizedVolPct(dailyCloses, cfg.pricing.tradingDaysPerYear);
  const rvIvRatio = vix > 0 ? realizedVol2h / vix : 0;

  // --- Divergence ---------------------------------------------------------------------------
  const nDiv = Math.max(1, cfg.features.divergenceBars);
  const pairOther = alignedWindowRets(tb, other.today, nDiv, openMs);
  const selfRet30m = pairOther ? pairOther.a : ownWindowRet(tb, nDiv, openMs);
  const otherIndexRet30m = pairOther ? pairOther.b : ownWindowRet(other.today, nDiv, openMs);
  let vsOtherIndexZ = 0;
  if (pairOther) {
    const dates = self.prevDates.filter((d) => other.byDate.has(d)).slice(-DIVERGENCE_HISTORY_SESSIONS);
    const spreads = historicalSpreads(self.byDate, other.byDate, dates, nDiv, (ra, rb) => ra - rb);
    vsOtherIndexZ = zScore(pairOther.a - pairOther.b, spreads);
  }
  const pairBank = alignedWindowRets(tb, bank.today, BANK_WINDOW_BARS, openMs);
  const bankNiftyRet15m = pairBank ? pairBank.b : ownWindowRet(bank.today, BANK_WINDOW_BARS, openMs);
  let vsBankNiftyZ = 0;
  if (index === "NIFTY" && pairBank) {
    const dates = self.prevDates.filter((d) => bank.byDate.has(d)).slice(-DIVERGENCE_HISTORY_SESSIONS);
    const spreads = historicalSpreads(self.byDate, bank.byDate, dates, BANK_WINDOW_BARS, (rs, rb) => rb - rs);
    vsBankNiftyZ = zScore(pairBank.b - pairBank.a, spreads);
  }

  // --- Global moves since the previous Indian close ---------------------------------------------
  const global = sanitizeGlobal(globalMoves(snap, prevCloseMs, t));

  // --- Classic indicators -----------------------------------------------------------------------
  const hist = self.closed.slice(-INDICATOR_BARS);
  const histCloses = hist.map((b) => b.c);
  const dm = dmi(hist, 14);
  const st = supertrend(hist, 10, 3);
  const e9 = histCloses.length >= 9 ? ema(histCloses, 9) : [];
  const e21 = histCloses.length >= 21 ? ema(histCloses, 21) : [];
  const ema9 = e9.at(-1) ?? 0;
  const ema9Back = e9.length >= 4 ? e9[e9.length - 4] : 0;
  const bb = bollinger(histCloses, 20, 2);
  const vb = vwapBands(tb, spot);
  const allDaily = [...closeByDate.keys()].sort().map((d) => closeByDate.get(d) as number);
  let dailyEmaGapPct = 0;
  if (allDaily.length >= DAILY_BIAS_CLOSES) {
    const d20 = ema(allDaily, 20).at(-1) ?? 0;
    const d50 = ema(allDaily, 50).at(-1) ?? 0;
    dailyEmaGapPct = d50 > 0 ? (d20 / d50 - 1) * 100 : 0;
  }
  const prevBars = prevDate !== null ? (self.byDate.get(prevDate) ?? []) : [];
  const prevDaily = prevDate !== null ? self.daily.find((c) => istDateOf(c.t) === prevDate) : undefined;
  const prevDayHigh = prevBars.length > 0 ? Math.max(...prevBars.map((b) => b.h)) : (prevDaily?.h ?? 0);
  const prevDayLow = prevBars.length > 0 ? Math.min(...prevBars.map((b) => b.l)) : (prevDaily?.l ?? 0);
  const prevDayClose = prevClose ?? 0;
  const indicators: Indicators = {
    rsi14: fin(rsi(histCloses, 14), 50),
    adx14: fin(dm.adx),
    plusDi14: fin(dm.plusDi),
    minusDi14: fin(dm.minusDi),
    ema9: fin(ema9),
    ema21: fin(e21.at(-1) ?? 0),
    ema9SlopePct: fin(ema9Back > 0 ? (ema9 / ema9Back - 1) * 100 : 0),
    supertrendDir: fin(st.dir),
    supertrendLine: fin(st.line),
    bbPctB: fin(bb.pctB, 0.5),
    bbWidthPct: fin(bb.bandwidthPct),
    vwap: fin(vb.vwap),
    vwapZ: fin(vb.z),
    dailyBias: fin(Math.sign(dailyEmaGapPct)),
    dailyEmaGapPct: fin(dailyEmaGapPct),
    prevDayHigh: fin(prevDayHigh),
    prevDayLow: fin(prevDayLow),
    prevDayClose: fin(prevDayClose),
  };

  return {
    index,
    t,
    spot: fin(spot),
    dataAgeSec: snapshotAge(snap),
    ret5m: fin(ret5m),
    ret15m: fin(ret15m),
    ret60m: fin(ret60m),
    retFromOpen: fin(retFromOpen),
    vwapDistPct: fin(vwapDistPct),
    barsSameSideOfVwap: fin(sameSide),
    openingRange: {
      high: fin(orHigh),
      low: fin(orLow),
      state: orState,
      strengthAtr: fin(orStrengthAtr),
      barsOutside: fin(orBarsOutside),
      lastBreak: orLastBreak,
      barsSinceReentry: fin(orBarsSinceReentry),
    },
    efficiencyRatio60m: fin(efficiencyRatio60m),
    atrPct5m: fin(atrPct5m),
    atrPctile20d: fin(atrPctile20d, 50),
    gapPct: fin(gapPct),
    expectedGapPct: fin(expGap),
    gapResidualPct: fin(gapResidualPct),
    vix: fin(vix),
    vixChangePct: fin(vixChangePct),
    realizedVol2h: fin(realizedVol2h),
    realizedVol20d: fin(realizedVol20d),
    rvIvRatio: fin(rvIvRatio),
    divergence: {
      vsOtherIndexZ: fin(vsOtherIndexZ),
      vsBankNiftyZ: fin(vsBankNiftyZ),
      otherIndexRet30m: fin(otherIndexRet30m),
      bankNiftyRet15m: fin(bankNiftyRet15m),
      selfRet30m: fin(selfRet30m),
    },
    global,
    ...calendarFields(index, t, today, calendar),
    indicators,
  };
}
