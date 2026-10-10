/**
 * Published intraday strategies, implemented exactly as published, that can replace the conviction
 * model's entries when `cfg.strategy.mode` is not "CONVICTION" (the default, which never reaches
 * this module):
 *
 *   NOISE_AREA  Zarattini, Aziz & Barbon (2024, rev. 2025), "Beat the Market: An Effective Intraday
 *               Momentum Strategy for S&P500 ETF (SPY)", SFI WP 24-97, SSRN 4824172 (noiseArea.ts).
 *   ORB5        Zarattini & Aziz (2023), "Can Day Trading Really Be Profitable?", SSRN 4416622: the
 *               5-minute opening-range breakout (orb5.ts).
 *
 * The trading cycle turns each tick's signal into a Conviction (score +1, -1 or 0) so the planner,
 * every gate, the sizing and the follower accounts work unchanged, and attaches the signal itself
 * (`conviction.published`) so evaluateExits can apply the strategy's index-level exits for main and
 * every follower. Adaptations our instrument forces (long = buy the ATM call, short = buy the ATM
 * put, the 15:05 square-off as "the close", the premium stop kept as a disaster stop) are listed in
 * reports/wp3-wp4-published.md. Paper replays and research only: the trading cycle takes no entries
 * in these modes when the book is LIVE.
 */
import type { TradingCalendar } from "../../calendar/calendar";
import { MINUTE_MS, SESSION, istAt, istDate } from "../../clock";
import { strategyMode, type EngineConfig } from "../../config";
import { isTradingDayCached, istDateOf, istMinuteOfDay } from "../../market/candles";
import { clipWicks } from "../../market/features";
import { MARKET_SYMBOLS, type Candle, type Conviction, type IndexId, type MarketSnapshot, type Regime, type SignalSource, type TradeSide } from "../../types";
import { firstCandleParams, firstCandleState } from "./firstCandle";
import { isDecisionMinute, noiseAreaDecision, noiseParams, volTargetMultiplier } from "./noiseArea";
import { orb5Params, orb5State } from "./orb5";

/** Why a published strategy closes a position now; the reason is one the engine already books. */
export interface ExitVerdict {
  /** SIGNAL_FLIP: crossover to the opposite band; TRAIL: band/VWAP trailing stop; STOP and TARGET: ORB index levels. */
  reason: "SIGNAL_FLIP" | "TRAIL" | "STOP" | "TARGET";
  detail: string;
}

/** A published strategy's view of one index at one tick. */
export interface PublishedSignal {
  strategy: "NOISE_AREA" | "ORB5" | "FIRST_CANDLE";
  /** Variant label, e.g. "OPPOSITE_BAND", "BAND_VWAP", "PUBLISHED", "ENGINE_WINDOW". */
  variant: string;
  /** End time (epoch ms) of the closed bar this tick acts on, null when the strategy has nothing to decide now. */
  decisionBarEndMs: number | null;
  /** Index level the decision used (that bar's close). */
  level: number | null;
  /** Side to enter for a book that is flat on this index, or null. */
  entry: TradeSide | null;
  /** Exit for an open call (BULL) / put (BEAR) position on this index now, or null to hold. */
  exitBull: ExitVerdict | null;
  exitBear: ExitVerdict | null;
  /** Size multiplier passed to the engine's sizing (1 unless the vol-target variant). */
  sizeMult: number;
  /** Levels behind the decision, for the dashboard and tests (bands, VWAP, sigma, ORB stop/target). */
  levels: Record<string, number>;
  note: string;
}

// The published signal travels with the index's conviction from the trading cycle to the position
// cycles of main and the follower accounts (positionCycle passes `conviction` into ExitContext).
declare module "../../types" {
  interface Conviction {
    /** Set only when cfg.strategy.mode is a published strategy (WP3/WP4). */
    published?: PublishedSignal;
  }
}

/** One session's closed bars (ascending) and its official open (the 09:15 bar's open, when present). */
export interface SessionBars {
  date: string;
  open: number | null;
  bars: Candle[];
}

/** IST minute of day at which a bar of length `barMs` ends. */
export function barEndMinute(c: Candle, barMs: number): number {
  return istMinuteOfDay(c.t + barMs);
}

/** Groups closed session bars (ascending) into sessions; `open` is set only when the 09:15 bar is there. */
export function groupSessions(bars: Candle[]): SessionBars[] {
  const out: SessionBars[] = [];
  for (const b of bars) {
    const d = istDateOf(b.t);
    let s = out[out.length - 1];
    if (!s || s.date !== d) {
      s = { date: d, open: istMinuteOfDay(b.t) === SESSION.open && b.o > 0 ? b.o : null, bars: [] };
      out.push(s);
    }
    s.bars.push(b);
  }
  return out;
}

/**
 * Today's closed bars and up to `prevSessions` earlier sessions, point in time: only bars that closed
 * by `t` (bar.t + barMs <= t), session hours [09:15, 15:30) on trading days, finite prices, wicks
 * clipped as the engine's features clip them.
 */
export function sessionsAt(candles: Candle[], calendar: TradingCalendar, t: number, barMs: number, prevSessions: number): { today: SessionBars | null; history: SessionBars[] } {
  const todayDate = istDate(t);
  const picked: Candle[] = [];
  const dates = new Set<string>();
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.t + barMs > t) continue;
    if (!(Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))) continue;
    const m = istMinuteOfDay(c.t);
    if (m < SESSION.open || m >= SESSION.close) continue;
    const d = istDateOf(c.t);
    if (!isTradingDayCached(calendar, d)) continue;
    if (d !== todayDate && !dates.has(d)) {
      if (dates.size >= prevSessions) break;
      dates.add(d);
    }
    picked.push(clipWicks(c));
  }
  picked.reverse();
  const sessions = groupSessions(picked);
  const today = sessions.length > 0 && sessions[sessions.length - 1].date === todayDate ? sessions[sessions.length - 1] : null;
  return { today, history: today ? sessions.slice(0, -1) : sessions };
}

/**
 * The previous session's official close: its daily bar when the daily series has it (Yahoo's daily
 * close is the exchange close), else the last closed 5-minute bar of the latest earlier session.
 */
export function previousClose(history: SessionBars[], daily: Candle[], today: string): number | null {
  const last = history[history.length - 1];
  let close: number | null = last && last.bars.length > 0 ? last.bars[last.bars.length - 1].c : null;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = istDateOf(daily[i].t);
    if (d >= today) continue;
    if (Number.isFinite(daily[i].c) && daily[i].c > 0 && (!last || d >= last.date)) close = daily[i].c;
    break;
  }
  return close !== null && close > 0 ? close : null;
}

/** Daily closes before `today` (ascending), for the vol-target size. */
function dailyClosesBefore(daily: Candle[], today: string): number[] {
  const out: number[] = [];
  for (const c of daily) if (istDateOf(c.t) < today && Number.isFinite(c.c) && c.c > 0) out.push(c.c);
  return out;
}

/** A signal that decides nothing (no entry, no exit). */
export function idleSignal(cfg: EngineConfig, note: string): PublishedSignal {
  const mode = strategyMode(cfg);
  if (mode === "FIRST_CANDLE") {
    const fc = cfg.strategy.firstCandle;
    return { strategy: "FIRST_CANDLE", variant: `${fc.rangeMin}min>${fc.minBodyPct}%`, decisionBarEndMs: null, level: null, entry: null, exitBull: null, exitBear: null, sizeMult: 1, levels: {}, note };
  }
  return {
    strategy: mode === "ORB5" ? "ORB5" : "NOISE_AREA",
    variant: mode === "ORB5" ? cfg.strategy.orb5.entry : cfg.strategy.noiseArea.stop,
    decisionBarEndMs: null,
    level: null,
    entry: null,
    exitBull: null,
    exitBear: null,
    sizeMult: 1,
    levels: {},
    note,
  };
}

const BAR_MS = 5 * MINUTE_MS;

/**
 * The published strategy's signal for `index` at `t` from a point-in-time snapshot of 5-minute bars.
 * Never throws: missing data yields an idle signal (no entries, no index exits; the premium stop and
 * square-off still run). `forceSide` (random-entry placebos only) makes ORB's stop and target those of
 * that side; the other rules' exits are given for both sides anyway.
 */
export function publishedSignal(index: IndexId, t: number, snap: MarketSnapshot, calendar: TradingCalendar, cfg: EngineConfig, forceSide?: TradeSide): PublishedSignal {
  try {
    const mode = strategyMode(cfg);
    const candles = snap.candles[MARKET_SYMBOLS[index]] ?? [];
    const today = istDate(t);
    if (mode === "ORB5") {
      const { today: s } = sessionsAt(candles, calendar, t, BAR_MS, 0);
      if (!s) return idleSignal(cfg, "no bars yet today");
      return orb5State(s.bars, istAt(today, SESSION.open), orb5Params(cfg), BAR_MS, forceSide);
    }
    // --- WP9b: plan §6 E2(a), the first 15-minute candle (begin) ---
    if (mode === "FIRST_CANDLE") {
      const { today: s } = sessionsAt(candles, calendar, t, BAR_MS, 0);
      if (!s) return idleSignal(cfg, "no bars yet today");
      return firstCandleState(s.bars, istAt(today, SESSION.open), firstCandleParams(cfg), BAR_MS);
    }
    // --- WP9b (end) ---
    const p = noiseParams(cfg);
    const { today: s, history } = sessionsAt(candles, calendar, t, BAR_MS, p.lookbackSessions);
    if (!s || s.bars.length === 0) return idleSignal(cfg, "no bars yet today");
    const daily = snap.daily[MARKET_SYMBOLS[index]] ?? [];
    const prevClose = previousClose(history, daily, today);
    if (prevClose === null) return idleSignal(cfg, "no previous close");
    const sizeMult = p.sizing === "VOL_TARGET" ? volTargetMultiplier(dailyClosesBefore(daily, today), p.volTargetPct, p.maxLeverage) : 1;
    const last = s.bars.length - 1;
    const now = noiseAreaDecision(s, history, prevClose, p, BAR_MS, last);
    if (now) return { ...now, sizeMult };
    // The engine books entries before exits within a tick, so a book reversing at a decision time
    // is still holding the old position then; the decision's entry stays valid for one more bar.
    const prev = last >= 1 ? noiseAreaDecision(s, history, prevClose, p, BAR_MS, last - 1) : null;
    if (prev && prev.entry) {
      return { ...prev, exitBull: null, exitBear: null, sizeMult, note: `${prev.note}; entry carried to the next bar` };
    }
    return { ...idleSignal(cfg, "not a decision time"), sizeMult };
  } catch (err) {
    return idleSignal(cfg, `signal failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- WP9b (begin) ---
/**
 * The 5-minute bar-close minutes (IST minute of day) at which the published rule in `cfg` can enter,
 * before the entry-window gates; null for the conviction model. For random-entry placebos.
 */
export function publishedEntrySlots(cfg: EngineConfig): number[] | null {
  const mode = strategyMode(cfg);
  if (mode === "CONVICTION") return null;
  const barEnd = (m: number) => SESSION.open + 5 * Math.max(1, Math.ceil((m - SESSION.open) / 5));
  if (mode === "NOISE_AREA") {
    const p = noiseParams(cfg);
    const out: number[] = [];
    for (let m = SESSION.open + 5; m <= SESSION.close; m += 5) if (isDecisionMinute(m, p)) out.push(m);
    return out;
  }
  if (mode === "ORB5") {
    const p = orb5Params(cfg);
    const rangeEnd = SESSION.open + p.rangeMin;
    return [barEnd(p.entry === "PUBLISHED" ? rangeEnd : Math.max(rangeEnd, p.windowStartMin))];
  }
  const p = firstCandleParams(cfg);
  return [barEnd(Math.max(SESSION.open + p.rangeMin, p.windowStartMin))];
}
// --- WP9b (end) ---

/** The conviction that carries a published signal: score +1 (calls), -1 (puts) or 0, threshold 1. */
export function publishedConviction(index: IndexId, t: number, sig: PublishedSignal, regime: Regime, cfg: EngineConfig): Conviction {
  const score = sig.entry === "BULL" ? 1 : sig.entry === "BEAR" ? -1 : 0;
  // The opening-range rules (ORB, the first candle) book as ORB, the noise area as MOMENTUM.
  const source: SignalSource = sig.strategy === "NOISE_AREA" ? "MOMENTUM" : "ORB";
  const toSquareOff = Math.max(0, Math.round((istAt(istDate(t), cfg.exits.squareOffIst) - t) / MINUTE_MS));
  return {
    index,
    t,
    score,
    components: [{ source, value: score, weight: 1, horizonMin: toSquareOff, enabled: true, notes: sig.note }],
    regime,
    threshold: 1,
    passes: score !== 0,
    sizeMult: sig.sizeMult,
    stance: score > 0 ? "BULLISH" : score < 0 ? "BEARISH" : "NEUTRAL",
    activeWeight: 1,
    note: `${sig.strategy} ${sig.variant}: ${sig.note}`,
    published: sig,
  };
}

export { noiseAreaDecision, noiseParams, noiseSigma, volTargetMultiplier } from "./noiseArea";
export { orb5Params, orb5Plan, orb5State } from "./orb5";
export { firstCandleParams, firstCandlePlan, firstCandleState } from "./firstCandle";
