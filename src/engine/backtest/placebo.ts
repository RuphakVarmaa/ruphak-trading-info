/**
 * Random-entry placebo: what zero directional edge costs under the engine's own contract choice,
 * sizing, synthetic option prices, fill model, charges and exit rules.
 *
 * Each draw picks a session, a decision time on the backtest's 5-minute grid inside the engine's
 * entry window, an index and a side at random; buys what the engine would buy there (ATM of the
 * nearest weekly not expiring today, or the account's premium band), sized by the account's rules;
 * and manages it with the mechanical exits (stop, target, trail, time stop, square-off) checked every
 * 5 minutes on closed bars with the data lag, as the backtest checks them. Signal-flip and event
 * exits are left out: they depend on the signal being tested. Draws are independent (no account
 * path, loss caps or position limits), so the mean is the cost of one zero-edge trade.
 *
 * Ported from the planning script (PLAN §1.2, random_baseline.ts). With sizing "uncapped", a fixed
 * 90-minute horizon and slots 09:25–14:30 it reproduces that script draw for draw; the defaults
 * follow the engine instead (settings cap of one lot per order, entry-window gate, regime horizon).
 */
import { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, addDays, istAt, istDate, parseHHMM } from "../clock";
import type { EngineConfig } from "../config";
import { computeCharges, roundTripChargesPerUnit } from "../broker/charges";
import { limitFill, marketFill, marketableLimit, quoteProblem, type FillParams } from "../broker/fillModel";
import { YAHOO_LAG_MS } from "../market/replayMarketData";
import { defaultSettings } from "../settings";
import { evaluateExits, markPosition } from "../strategy/exits";
import { liquidityGates, squareOffMs } from "../strategy/gates";
import { chooseContract, choosePremiumBandContract } from "../strategy/optionSelect";
import { sizePosition } from "../strategy/sizing";
import { createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type IndexId, type OptionContract, type OrderReason, type Position, type Quote, type Regime, type TradeSide } from "../types";
import { mean, stdev } from "../util/math";
import { clusteredSe, profitFactor, seededRandom } from "./metrics";
import { ClosedBars, CopyDelayQuotes, copyDelayOf, describeCopyDelay, type SignalTapeEntry } from "./runBacktest";

/** "engine": the account's sizing rules and settings caps, as the backtest sizes. "uncapped": risk budget and premium cap only, at least one lot (the planning script). */
export type PlaceboSizing = "engine" | "uncapped";

export interface RandomPlaceboInput {
  /** The strategy's config: indices, entry window, contract selection, sizing and exits all come from it. */
  cfg: EngineConfig;
  candles: Record<string, Candle[]>;
  daily?: Record<string, Candle[]>;
  /** IST dates, inclusive (used when `days` is not given). */
  from: string;
  to: string;
  /** Sessions to draw from; default: trading days in [from, to] with 5-minute bars for every index. */
  days?: string[];
  draws: number;
  seed: number;
  calendar?: TradingCalendar;
  /** Market data publication lag (default Yahoo's ~90 s). */
  lagMs?: number;
  /** Decision and exit-check step (default 5 minutes). */
  stepMs?: number;
  /** Fixed planned horizon (time stop) in minutes; default: the regime's horizon via `regimeAt`, else RANGE's. */
  horizonMin?: number;
  /** The regime the engine classified for an index at a decision time (see regimeLookup()). */
  regimeAt?: (index: IndexId, t: number) => Regime | null;
  /** Entry slots as bar-close times (HH:MM, inclusive); default: the slots whose decision passes the engine's entry window. */
  window?: { from: string; to: string };
  sizing?: PlaceboSizing;
  /** Copy-delay penalty, as in BacktestInput (fills only; exit triggers use the engine's view). */
  fillDelayBars?: number;
  extraTicks?: number;
}

export interface PlaceboTrade {
  day: string;
  index: IndexId;
  side: TradeSide;
  tradingSymbol: string;
  expiry: string;
  strike: number;
  entryMs: number;
  exitMs: number;
  holdingMin: number;
  /** Regime at entry (null with a fixed horizon or without a signal tape). */
  regime: Regime | null;
  horizonMin: number;
  lots: number;
  qty: number;
  entryPremium: number;
  exitPremium: number;
  grossPnl: number;
  charges: number;
  pnl: number;
  exitReason: OrderReason;
}

export interface PlaceboSummary {
  n: number;
  mean: number;
  sd: number;
  /** i.i.d. standard error of the mean. */
  se: number;
  /** Standard error clustered by session (draws on the same day share that day's market). */
  seDay: number;
  hitRate: number;
  profitFactor: number;
  grossPerTrade: number;
  chargesPerTrade: number;
  avgWin: number;
  avgLoss: number;
  avgHoldingMin: number;
  byExit: Record<string, { n: number; avg: number }>;
  byIndex: Record<string, { n: number; avg: number }>;
  /** Draws by number of lots. */
  lots: Record<string, number>;
}

export interface PlaceboResult {
  settings: {
    draws: number;
    seed: number;
    sizing: PlaceboSizing;
    horizon: string;
    window: string;
    copyDelay: string;
    sessions: number;
    slots: number;
    indices: IndexId[];
    exits: { stopPct: number; targetPct: number; trailActivatePct: number; trailGivebackPct: number; timeStopMinPnlPct: number; squareOffIst: string };
  };
  /** Draws attempted (untradable draws are redrawn). */
  attempts: number;
  /** Untradable draws by reason. */
  rejected: Record<string, number>;
  trades: PlaceboTrade[];
  summary: PlaceboSummary;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Trading days in [from, to] with 5-minute bars for every index, as the backtest selects its sessions. */
export function sessionsWithData(candles: Record<string, Candle[]>, indices: readonly IndexId[], from: string, to: string, calendar: TradingCalendar): string[] {
  const have = indices.map((i) => new Set((candles[MARKET_SYMBOLS[i]] ?? []).map((c) => istDate(c.t))));
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (calendar.isTradingDay(d) && have.every((s) => s.has(d))) out.push(d);
  return out;
}

/**
 * Entry slots as bar-close minutes on the decision grid from the 09:15 open. A slot m is decided at
 * m + lag (when its bar is published). Default: the slots whose decision minute passes the engine's
 * entry-window gate (09:26:30 … 14:26:30 with the defaults); `window` gives bar-close bounds instead.
 */
export function entrySlots(cfg: EngineConfig, lagMs: number, stepMs = 5 * MINUTE_MS, window?: { from: string; to: string }): number[] {
  const step = Math.max(1, Math.round(stepMs / MINUTE_MS));
  const before = parseHHMM(cfg.gates.noEntryBeforeIst);
  const after = parseHHMM(cfg.gates.noEntryAfterIst);
  const out: number[] = [];
  for (let m = parseHHMM("09:15"); m <= parseHHMM("15:30"); m += step) {
    if (window) {
      if (m >= parseHHMM(window.from) && m <= parseHHMM(window.to)) out.push(m);
      continue;
    }
    const decision = Math.floor(m + lagMs / MINUTE_MS);
    if (decision >= before && decision <= after) out.push(m);
  }
  return out;
}

/** Regime lookup from a backtest's signal tape (BacktestOutput.signals). */
export function regimeLookup(signals: readonly SignalTapeEntry[]): (index: IndexId, t: number) => Regime | null {
  const m = new Map<string, Regime>();
  for (const s of signals) m.set(`${s.index}@${s.t}`, s.regime);
  return (index, t) => m.get(`${index}@${t}`) ?? null;
}

/** The planning script's sizing: risk budget and premium cap of the config, at least one lot, at most maxLots. */
function uncappedLots(premium: number, c: OptionContract, cfg: EngineConfig): number {
  const unit = premium * c.lotSize;
  const perLotRisk = (Math.abs(cfg.exits.stopPct) / 100) * unit;
  if (!(unit > 0) || !(perLotRisk > 0)) return 0;
  const budget = Math.floor((cfg.capitalRupees * cfg.sizing.defaultRiskPct) / 100 / perLotRisk);
  const premiumCap = Math.floor((cfg.capitalRupees * cfg.sizing.maxPremiumPctPerTrade) / 100 / unit);
  return Math.max(1, Math.min(budget, premiumCap, cfg.sizing.maxLots));
}

interface DrawContext {
  cfg: EngineConfig;
  calendar: TradingCalendar;
  deps: ReplayDeps;
  bars: ClosedBars;
  fillQuotes: CopyDelayQuotes | null;
  lagMs: number;
  stepMs: number;
  sizing: PlaceboSizing;
  horizonMin?: number;
  regimeAt?: (index: IndexId, t: number) => Regime | null;
}

/** One random entry managed to its exit, or the reason it could not be traded. */
async function simulateDraw(x: DrawContext, day: string, index: IndexId, side: TradeSide, slot: number): Promise<PlaceboTrade | string> {
  const { cfg, calendar, deps, bars } = x;
  const t0 = istAt(day, slot) + x.lagMs;
  const sym = MARKET_SYMBOLS[index];
  const spot0 = bars.closeAt(sym, t0, true);
  const vix0 = bars.closeAt(MARKET_SYMBOLS.INDIAVIX, t0);
  if (spot0 === null || vix0 === null) return "no market data";
  // The engine's expiry-day cutoff (the other session gates hold by construction of the slots).
  if (calendar.isExpiryDay(index, day) && (calendar.closeMs(day) - t0) / MINUTE_MS <= cfg.gates.expiryDayNoEntryMinBeforeClose) return "expiry-day cutoff";

  const fp = (c: OptionContract): FillParams => ({
    tickSize: c.tickSize,
    slippageTicksMarket: cfg.broker.slippageTicksMarket,
    depthLevels: cfg.broker.partialFillDepthLevels,
    maxQuoteAgeMs: cfg.gates.maxDataAgeSec * 1000,
  });
  const settings = defaultSettings(cfg, t0);
  const cash = cfg.sizing.useCurrentEquity ? cfg.capitalRupees : undefined;
  const lotsFor = (premium: number, c: OptionContract): number =>
    x.sizing === "uncapped"
      ? uncappedLots(premium, c, cfg)
      : sizePosition(
          {
            premium,
            contract: c,
            perf: undefined,
            sizeMult: 1,
            capitalRupees: cfg.capitalRupees,
            openPremiumRupees: 0,
            settings,
            cashRupees: cash,
            chargeReservePerLot: cash === undefined ? 0 : roundTripChargesPerUnit(premium, c.lotSize, c.exchange, day) * c.lotSize,
          },
          cfg,
        ).lots;

  const ctx0 = { t: t0, spot: spot0, vix: vix0 };
  let contract: OptionContract | null;
  let q0: Quote | null;
  if (cfg.selection.mode === "PREMIUM_BAND") {
    const pick = await choosePremiumBandContract({
      index,
      spot: spot0,
      vix: vix0,
      side,
      t: t0,
      instruments: deps.instruments,
      optionQuotes: deps.optionQuotes,
      calendar,
      cfg,
      quoteOk: (q, c) => quoteProblem(q, t0, fp(c)) === null,
      affordable: (premium, c) => lotsFor(premium, c) >= 1,
    });
    contract = pick.quote ? pick.contract : null;
    q0 = pick.quote;
  } else {
    contract = await chooseContract(index, spot0, side, t0, deps.instruments, calendar, cfg);
    q0 = contract ? await deps.optionQuotes.quote(contract, ctx0) : null;
  }
  if (!contract || !q0) return "no contract";
  if (quoteProblem(q0, t0, fp(contract))) return "no usable quote";
  if (liquidityGates(q0, contract, cfg).some((g) => g.passed === false)) return "liquidity gate";
  const lots = lotsFor(q0.ask, contract);
  if (lots < 1) return "sized to zero lots";
  const qty = lots * contract.lotSize;

  // Entry: the engine's marketable limit (fills at the ask), or the copier at market on the delayed quote.
  let entryPx: number;
  if (x.fillQuotes) {
    entryPx = marketFill("BUY", qty, await x.fillQuotes.quote(contract, ctx0), fp(contract)).avgPrice;
  } else {
    const f = limitFill("BUY", qty, marketableLimit("BUY", q0, contract.tickSize), q0);
    if (f.filledQty < qty) return "entry limit not filled";
    entryPx = f.avgPrice;
  }
  const entryCharges = computeCharges("BUY", entryPx, qty, contract.exchange, day).total;

  // Planned horizon exactly as the planner sets it: the regime's horizon, capped by the square-off.
  const regime = x.horizonMin === undefined ? (x.regimeAt?.(index, t0) ?? null) : null;
  const planned = x.horizonMin ?? cfg.exits.horizonMinByRegime[regime ?? "RANGE"];
  const squareOff = squareOffMs(t0, cfg);
  const horizonMin = Math.max(5, Math.min(planned, Math.floor((squareOff - t0) / MINUTE_MS)));
  let pos: Position = {
    id: "placebo",
    planId: "placebo",
    index,
    side,
    contract,
    mode: "BACKTEST",
    qty,
    avgEntry: entryPx,
    entryMs: t0,
    entryCharges,
    status: "OPEN",
    markPremium: entryPx,
    markMs: t0,
    peakPremium: entryPx,
    unrealized: 0,
    stops: {
      stopPct: cfg.exits.stopPct,
      targetPct: cfg.exits.targetPct,
      trailActivatePct: cfg.exits.trailActivatePct,
      trailGivebackPct: cfg.exits.trailGivebackPct,
      timeStopMs: t0 + horizonMin * MINUTE_MS,
      squareOffMs: squareOff,
    },
    horizonMin,
    convictionAtEntry: 0,
    regimeAtEntry: regime ?? "RANGE",
    dominantSource: "MOMENTUM",
    attribution: [],
    eventKeysAtEntry: [],
    maePct: 0,
    mfePct: 0,
  };

  // Exits: checked from the entry tick on, every step, on the engine's (undelayed) view of the market.
  const lastCheck = calendar.closeMs(day) + x.lagMs;
  for (let t = t0; t <= lastCheck; t += x.stepMs) {
    const spot = bars.closeAt(sym, t, true);
    if (spot === null) continue;
    const ctx = { t, spot, vix: bars.closeAt(MARKET_SYMBOLS.INDIAVIX, t) ?? vix0 };
    const q = await deps.optionQuotes.quote(contract, ctx);
    pos = markPosition(pos, q, t);
    const d = evaluateExits(pos, q, { nowMs: t }, cfg);
    if (!d) continue;
    let exitPx: number;
    if (x.fillQuotes) exitPx = marketFill("SELL", qty, await x.fillQuotes.quote(contract, ctx), fp(contract)).avgPrice;
    else if (d.orderType === "LIMIT") {
      const f = limitFill("SELL", qty, d.limitPrice ?? q.bid, q);
      exitPx = f.filledQty >= qty ? f.avgPrice : marketFill("SELL", qty, q, fp(contract)).avgPrice;
    } else exitPx = marketFill("SELL", qty, q, fp(contract)).avgPrice;
    const charges = entryCharges + computeCharges("SELL", exitPx, qty, contract.exchange, day).total;
    const gross = (exitPx - entryPx) * qty;
    return {
      day,
      index,
      side,
      tradingSymbol: contract.tradingSymbol,
      expiry: contract.expiry,
      strike: contract.strike,
      entryMs: t0,
      exitMs: t,
      holdingMin: Math.round((t - t0) / MINUTE_MS),
      regime,
      horizonMin,
      lots,
      qty,
      entryPremium: entryPx,
      exitPremium: exitPx,
      grossPnl: r2(gross),
      charges: r2(charges),
      pnl: r2(gross - charges),
      exitReason: d.reason,
    };
  }
  return "never exited";
}

export function summarizePlacebo(trades: readonly PlaceboTrade[]): PlaceboSummary {
  const pnls = trades.map((t) => t.pnl);
  const n = pnls.length;
  const sd = stdev(pnls);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const group = (key: (t: PlaceboTrade) => string) => {
    const m = new Map<string, number[]>();
    for (const t of trades) {
      const k = key(t);
      const list = m.get(k) ?? [];
      list.push(t.pnl);
      m.set(k, list);
    }
    return m;
  };
  const avgBy = (key: (t: PlaceboTrade) => string) => Object.fromEntries([...group(key)].map(([k, v]) => [k, { n: v.length, avg: Math.round(mean(v)) }]));
  return {
    n,
    mean: r2(mean(pnls)),
    sd: r2(sd),
    se: n > 0 ? r2(sd / Math.sqrt(n)) : 0,
    seDay: r2(clusteredSe([...group((t) => t.day).values()])),
    hitRate: n > 0 ? Math.round((wins.length / n) * 10_000) / 10_000 : 0,
    profitFactor: r2(profitFactor(pnls)),
    grossPerTrade: r2(mean(trades.map((t) => t.grossPnl))),
    chargesPerTrade: r2(mean(trades.map((t) => t.charges))),
    avgWin: Math.round(mean(wins)),
    avgLoss: Math.round(mean(losses)),
    avgHoldingMin: Math.round(mean(trades.map((t) => t.holdingMin))),
    byExit: avgBy((t) => t.exitReason),
    byIndex: avgBy((t) => t.index),
    lots: Object.fromEntries([...group((t) => String(t.lots))].map(([k, v]) => [k, v.length])),
  };
}

/** Runs the random-entry placebo. Deterministic for a seed: draws are made in the order session, index, side, slot. */
export async function randomEntryPlacebo(input: RandomPlaceboInput): Promise<PlaceboResult> {
  const { cfg } = input;
  if (!(Number.isInteger(input.draws) && input.draws >= 1)) throw new Error("random-entry placebo: draws must be a positive integer");
  const calendar = input.calendar ?? new TradingCalendar();
  const lagMs = input.lagMs ?? YAHOO_LAG_MS;
  const stepMs = Math.max(MINUTE_MS, input.stepMs ?? 5 * MINUTE_MS);
  const sizing = input.sizing ?? "engine";
  const copy = copyDelayOf(input);
  const days = input.days ?? sessionsWithData(input.candles, cfg.indices, input.from, input.to, calendar);
  if (days.length === 0) throw new Error("random-entry placebo: no session with data in the range");
  const slots = entrySlots(cfg, lagMs, stepMs, input.window);
  if (slots.length === 0) throw new Error("random-entry placebo: no entry slot in the window");
  const bars = new ClosedBars(input.candles, lagMs);
  // The same synthetic instruments and option quotes the backtest builds.
  const deps = createReplayDeps({ cfg, startMs: istAt(days[0], "09:00"), candles: input.candles, daily: input.daily, calendar, lagMs });
  const x: DrawContext = {
    cfg,
    calendar,
    deps,
    bars,
    fillQuotes: copy ? new CopyDelayQuotes(deps.optionQuotes, bars, copy) : null,
    lagMs,
    stepMs,
    sizing,
    horizonMin: input.horizonMin,
    regimeAt: input.regimeAt,
  };
  const rnd = seededRandom(input.seed);
  const trades: PlaceboTrade[] = [];
  const rejected: Record<string, number> = {};
  const maxAttempts = Math.max(1_000, input.draws * 20);
  let attempts = 0;
  while (trades.length < input.draws) {
    if (attempts >= maxAttempts) throw new Error(`random-entry placebo: only ${trades.length} of ${input.draws} draws tradable after ${attempts} attempts (${JSON.stringify(rejected)})`);
    attempts++;
    const day = days[Math.floor(rnd() * days.length)];
    const index = cfg.indices[Math.floor(rnd() * cfg.indices.length)];
    const side: TradeSide = rnd() < 0.5 ? "BULL" : "BEAR";
    const slot = slots[Math.floor(rnd() * slots.length)];
    const r = await simulateDraw(x, day, index, side, slot);
    if (typeof r === "string") rejected[r] = (rejected[r] ?? 0) + 1;
    else trades.push(r);
  }
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const e = cfg.exits;
  return {
    settings: {
      draws: input.draws,
      seed: input.seed,
      sizing,
      horizon: input.horizonMin !== undefined ? `fixed ${input.horizonMin} min` : input.regimeAt ? "the regime's horizon at entry (signal tape)" : `RANGE ${e.horizonMinByRegime.RANGE} min (no signal tape)`,
      window: `bar closes ${hhmm(slots[0])}–${hhmm(slots[slots.length - 1])} (${slots.length} slots, decisions ${Math.round(lagMs / 1000)} s later)`,
      copyDelay: describeCopyDelay(copy),
      sessions: days.length,
      slots: slots.length,
      indices: [...cfg.indices],
      exits: { stopPct: e.stopPct, targetPct: e.targetPct, trailActivatePct: e.trailActivatePct, trailGivebackPct: e.trailGivebackPct, timeStopMinPnlPct: e.timeStopMinPnlPct, squareOffIst: e.squareOffIst },
    },
    attempts,
    rejected,
    trades,
    summary: summarizePlacebo(trades),
  };
}
