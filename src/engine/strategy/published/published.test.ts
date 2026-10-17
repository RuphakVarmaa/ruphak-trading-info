import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../../calendar/calendar";
import { MINUTE_MS, istAt } from "../../clock";
import { DEFAULT_CONFIG, makeConfig, validateConfig, withOverrides } from "../../config";
import { ReplayMarketDataSource } from "../../market/replayMarketData";
import { MARKET_SYMBOLS, type Candle, type Conviction, type OptionContract, type Position, type Quote } from "../../types";
import { evaluateExits, publishedIndexExit } from "../exits";
import {
  groupSessions,
  idleSignal,
  noiseAreaDecision,
  noiseSigma,
  orb5Plan,
  orb5State,
  previousClose,
  publishedConviction,
  publishedSignal,
  sessionsAt,
  volTargetMultiplier,
  type PublishedSignal,
  type SessionBars,
} from "./index";
import { isDecisionMinute, noiseBands, noiseParams, type NoiseAreaParams } from "./noiseArea";
import type { Orb5Params } from "./orb5";

const BAR = 5 * MINUTE_MS;
const calendar = new TradingCalendar();

/** 5-minute bars for one IST date from per-bar closes, starting at 09:15 (bar k opens at 09:15 + 5k). */
function dayBars(date: string, open: number, closes: number[], wick = 0.5): Candle[] {
  const out: Candle[] = [];
  let prev = open;
  closes.forEach((c, k) => {
    out.push({ t: istAt(date, "09:15") + k * BAR, o: prev, h: Math.max(prev, c) + wick, l: Math.min(prev, c) - wick, c, v: 0 });
    prev = c;
  });
  return out;
}

/** Trading days before `date` (most recent last). */
function tradingDaysBefore(date: string, n: number): string[] {
  const out: string[] = [];
  let d = date;
  while (out.length < n) {
    d = calendar.prevTradingDay(d);
    out.unshift(d);
  }
  return out;
}

const params: NoiseAreaParams = { ...noiseParams(DEFAULT_CONFIG), lookbackSessions: 14 };
const DAY = "2026-09-30";

/** 14 flat-ish history sessions whose bar ending at 10:00 (slot 8) moved `movePct` from a 100 open. */
function history(movePcts: number[]): SessionBars[] {
  const days = tradingDaysBefore(DAY, movePcts.length);
  return days.map((d, i) => {
    const closes = Array.from({ length: 75 }, (_, k) => (k === 8 ? 100 * (1 + movePcts[i] / 100) : 100));
    return groupSessions(dayBars(d, 100, closes))[0];
  });
}

describe("noise area (Zarattini, Aziz & Barbon)", () => {
  it("decides only at HH:00 and HH:30 on the paper's grid", () => {
    expect(isDecisionMinute(9 * 60 + 30, params)).toBe(true);
    expect(isDecisionMinute(10 * 60, params)).toBe(true);
    expect(isDecisionMinute(9 * 60 + 35, params)).toBe(false);
    expect(isDecisionMinute(9 * 60 + 15, params)).toBe(false);
    expect(isDecisionMinute(10 * 60 + 15, { decisionEveryMin: 60, anchorMin: 15 })).toBe(true);
  });

  it("sigma is the mean absolute move from the open at that time of day over the lookback", () => {
    const h = history([0.2, -0.4, 0.6, -0.2, 0.2, -0.4, 0.6, -0.2, 0.2, -0.4, 0.6, -0.2, 0.2, -0.4]);
    expect(noiseSigma(h, 10 * 60, BAR, 14)).toBeCloseTo(4.8 / 14 / 100, 9);
    // Another time of day saw no move at all.
    expect(noiseSigma(h, 10 * 60 + 30, BAR, 14)).toBe(0);
    // Only the last 14 sessions count.
    expect(noiseSigma([...history([5]), ...h], 10 * 60, BAR, 14)).toBeCloseTo(4.8 / 14 / 100, 9);
  });

  it("tolerates one missing session at a time of day but not two", () => {
    const h = history(Array(14).fill(0.3));
    const drop = (s: SessionBars) => ({ ...s, bars: s.bars.filter((b) => b.t !== istAt(s.date, "09:55")) });
    const one = h.map((s, i) => (i === 3 ? drop(s) : s));
    expect(noiseSigma(one, 10 * 60, BAR, 14)).toBeCloseTo(0.003, 9);
    const two = one.map((s, i) => (i === 7 ? drop(s) : s));
    expect(noiseSigma(two, 10 * 60, BAR, 14)).toBeNull();
    // A session whose 09:15 bar is missing has no known open and does not count.
    const noOpen = h.map((s, i) => (i < 2 ? { ...s, open: null } : s));
    expect(noiseSigma(noOpen, 10 * 60, BAR, 14)).toBeNull();
  });

  it("widens the bands by an overnight gap, as the paper prescribes", () => {
    expect(noiseBands(100, 100, 0.01, 1)).toEqual({ upper: 101, lower: 99 });
    const gapDown = noiseBands(98, 100, 0.01, 1);
    expect(gapDown.upper).toBeCloseTo(101, 9);
    expect(gapDown.lower).toBeCloseTo(97.02, 9);
    const gapUp = noiseBands(102, 100, 0.01, 1);
    expect(gapUp.upper).toBeCloseTo(103.02, 9);
    expect(gapUp.lower).toBeCloseTo(99, 9);
    expect(noiseBands(100, 100, 0.01, 1.2).upper).toBeCloseTo(101.2, 9);
  });

  const h = history(Array(14).fill(0.5));
  const today = (closes: number[]) => groupSessions(dayBars(DAY, 100, closes))[0];

  it("base model: long above the upper band, short below the lower band, exits on the opposite band", () => {
    // Bands at 10:00 (bar index 8): open 100, previous close 100, sigma 0.5% -> 99.5 / 100.5.
    const up = noiseAreaDecision(today([...Array(8).fill(100.2), 100.6]), h, 100, params, BAR)!;
    expect(up.levels.upper).toBeCloseTo(100.5, 9);
    expect(up.levels.lower).toBeCloseTo(99.5, 9);
    expect(up.entry).toBe("BULL");
    expect(up.exitBear?.reason).toBe("SIGNAL_FLIP");
    expect(up.exitBull).toBeNull();
    expect(up.decisionBarEndMs).toBe(istAt(DAY, "10:00"));
    const down = noiseAreaDecision(today([...Array(8).fill(100), 99.4]), h, 100, params, BAR)!;
    expect(down.entry).toBe("BEAR");
    expect(down.exitBull?.reason).toBe("SIGNAL_FLIP");
    expect(down.exitBear).toBeNull();
    const inside = noiseAreaDecision(today([...Array(8).fill(100), 100.4]), h, 100, params, BAR)!;
    expect(inside.entry).toBeNull();
    expect(inside.exitBull).toBeNull();
    expect(inside.exitBear).toBeNull();
    // 09:55 is not a decision time.
    expect(noiseAreaDecision(today([...Array(7).fill(100), 101]), h, 100, params, BAR)).toBeNull();
    // A gap down lifts the upper band to the previous close: 100.6 is no longer a breakout.
    const gap = noiseAreaDecision(groupSessions(dayBars(DAY, 99, [...Array(8).fill(99.5), 100.6]))[0], h, 100.3, params, BAR)!;
    expect(gap.levels.upper).toBeCloseTo(100.3 * 1.005, 9);
    expect(gap.entry).toBeNull();
  });

  it("VWAP refinement: enters beyond max(upper, VWAP), trails at the band or VWAP", () => {
    const vw = { ...params, stop: "BAND_VWAP" as const };
    // Price ran to 103 and fell back to 100.6 at 10:00: above the upper band (100.5) but below VWAP.
    const faded = noiseAreaDecision(today([101, 102, 103, 103, 103, 103, 102, 101, 100.6]), h, 100, vw, BAR)!;
    expect(faded.levels.vwap).toBeGreaterThan(100.6);
    expect(faded.entry).toBeNull();
    expect(faded.exitBull?.reason).toBe("TRAIL");
    expect(faded.exitBear?.reason).toBe("TRAIL");
    // Steady climb: above both, enter long; a short would be stopped.
    const climb = noiseAreaDecision(today([100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7, 100.8, 101]), h, 100, vw, BAR)!;
    expect(climb.entry).toBe("BULL");
    expect(climb.exitBull).toBeNull();
    expect(climb.exitBear?.reason).toBe("TRAIL");
  });

  it("reads only bars up to the decision bar (no look-ahead)", () => {
    const base = [100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7, 100.8, 101];
    const a = noiseAreaDecision(today([...base, 90, 90, 90]), h, 100, { ...params, stop: "BAND_VWAP" }, BAR, 8)!;
    const b = noiseAreaDecision(today([...base, 120, 120, 120]), h, 100, { ...params, stop: "BAND_VWAP" }, BAR, 8)!;
    expect(a).toEqual(b);
  });

  it("vol-target multiplier is min(cap, target / 14-day sample sd of daily returns)", () => {
    const closes = [100];
    for (let i = 0; i < 14; i++) closes.push(closes[i] * (i % 2 === 0 ? 1.01 : 0.99));
    const m = volTargetMultiplier(closes, 2, 4);
    const rets = closes.slice(1).map((c, i) => (c / closes[i] - 1) * 100);
    const mean = rets.reduce((a, b) => a + b, 0) / 14;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / 13);
    expect(m).toBeCloseTo(2 / sd, 9);
    expect(volTargetMultiplier(closes.slice(0, 10), 2, 4)).toBe(1);
    expect(volTargetMultiplier(Array.from({ length: 15 }, (_, i) => 100 * 1.0001 ** i * (i % 2 ? 1.00001 : 1)), 2, 4)).toBe(4);
  });
});

const orbP: Orb5Params = { rangeMin: 5, targetR: 10, entry: "PUBLISHED", windowStartMin: 9 * 60 + 25 };
const OPEN = istAt(DAY, "09:15");

describe("5-minute ORB (Zarattini & Aziz)", () => {
  // First candle 100 -> 101 (low 99.5 with the 0.5 wick): long, stop 99.5, entry 101, R 1.5, target 116.
  const bars = dayBars(DAY, 100, [101, 101.4, 101.2, 101.8]);

  it("takes the side of the first candle with the stop at its other extreme and a 10R target", () => {
    const plan = orb5Plan(bars, OPEN, orbP, BAR);
    expect(plan).toMatchObject({ side: "BULL", stop: 99.5, entryLevel: 101, r: 1.5, target: 116, entryBarT: OPEN });
    const down = orb5Plan(dayBars(DAY, 100, [99, 98.8]), OPEN, orbP, BAR);
    expect(down).toMatchObject({ side: "BEAR", stop: 100.5, entryLevel: 99, r: 1.5, target: 84 });
    const doji = orb5Plan(dayBars(DAY, 100, [100, 101]), OPEN, orbP, BAR);
    expect(doji.side).toBeNull();
    expect(doji.skipped).toBe(true);
    expect(orb5Plan([], OPEN, orbP, BAR).reason).toBe("opening range not complete");
  });

  it("enters once, on the entry bar only", () => {
    expect(orb5State(bars.slice(0, 1), OPEN, orbP, BAR).entry).toBe("BULL");
    expect(orb5State(bars.slice(0, 2), OPEN, orbP, BAR).entry).toBeNull();
    // With the engine's 09:25 window the entry moves to the 09:20 bar (closes 09:25) and R is measured from there.
    const win = { ...orbP, entry: "ENGINE_WINDOW" as const };
    expect(orb5State(bars.slice(0, 1), OPEN, win, BAR).entry).toBeNull();
    const s = orb5State(bars.slice(0, 2), OPEN, win, BAR);
    expect(s.entry).toBe("BULL");
    expect(s.levels.entryLevel).toBe(101.4);
    expect(s.levels.r).toBeCloseTo(1.9, 9);
  });

  it("skips the day when the stop traded before the engine's window opened", () => {
    const win = { ...orbP, entry: "ENGINE_WINDOW" as const };
    const dipped = dayBars(DAY, 100, [101, 99.8], 0.5); // second bar's low 99.3 < stop 99.5
    const plan = orb5Plan(dipped, OPEN, win, BAR);
    expect(plan.side).toBeNull();
    expect(plan.skipped).toBe(true);
    expect(orb5State(dipped, OPEN, win, BAR).entry).toBeNull();
  });

  it("exits at the index stop or target, the stop first when one bar reaches both", () => {
    const stopped = dayBars(DAY, 100, [101, 101.2, 99.6], 0.5); // third bar low 99.1 <= 99.5
    const st = orb5State(stopped, OPEN, orbP, BAR);
    expect(st.exitBull?.reason).toBe("STOP");
    expect(st.exitBear).toBeNull();
    const ran = dayBars(DAY, 100, [101, 105, 110, 115.8], 0.5); // last bar high 116.3 >= 116
    expect(orb5State(ran, OPEN, orbP, BAR).exitBull?.reason).toBe("TARGET");
    const both: Candle[] = [...bars.slice(0, 1), { t: OPEN + BAR, o: 101, h: 117, l: 99, c: 101, v: 0 }];
    expect(orb5State(both, OPEN, orbP, BAR).exitBull?.reason).toBe("STOP");
    // Before any bar after the entry: nothing to exit.
    expect(orb5State(bars.slice(0, 1), OPEN, orbP, BAR).exitBull).toBeNull();
  });
});

describe("published signal from a point-in-time snapshot", () => {
  const days = [...tradingDaysBefore(DAY, 3), DAY];
  const candles: Candle[] = [];
  for (const d of days) {
    // History days: flat at 100 apart from a 0.5% move at every bar ending HH:00/HH:30.
    if (d !== DAY) candles.push(...dayBars(d, 100, Array.from({ length: 75 }, (_, k) => ((k + 1) % 6 === 3 ? 100.5 : 100))));
  }
  // Today: breaks out above 100.5 at 10:00 (bar 8) and stays there.
  candles.push(...dayBars(DAY, 100, Array.from({ length: 75 }, (_, k) => (k < 8 ? 100.1 : 101))));
  const daily = days.slice(0, -1).map((d) => ({ t: istAt(d, "09:15"), o: 100, h: 100.5, l: 100, c: 100, v: 0 }));
  const market = new ReplayMarketDataSource({ candles: { [MARKET_SYMBOLS.NIFTY]: candles }, daily: { [MARKET_SYMBOLS.NIFTY]: daily } }, { lagMs: 90_000 });
  const cfg = makeConfig({ strategy: { mode: "NOISE_AREA", noiseArea: { lookbackSessions: 3 } }, sizing: { maxOpenPerIndex: 1 } });
  const at = (hhmm: string) => {
    const t = istAt(DAY, hhmm) + 90_000;
    return publishedSignal("NIFTY", t, market.snapshotSync(t), calendar, cfg);
  };

  it("enters at the 10:00 decision, carries the entry one bar, then only decides at HH:00/HH:30", () => {
    expect(at("09:30").entry).toBeNull();
    const ten = at("10:00");
    expect(ten.entry).toBe("BULL");
    expect(ten.decisionBarEndMs).toBe(istAt(DAY, "10:00"));
    const carried = at("10:05");
    expect(carried.entry).toBe("BULL");
    expect(carried.exitBear).toBeNull();
    expect(carried.note).toContain("carried");
    expect(at("10:10").entry).toBeNull();
    expect(at("10:30").entry).toBe("BULL");
  });

  it("needs the previous close and a forming day, and never throws", () => {
    const empty = publishedSignal("NIFTY", istAt(DAY, "09:16"), market.snapshotSync(istAt(DAY, "09:16")), calendar, cfg);
    expect(empty.entry).toBeNull();
    expect(empty.note).toBe("no bars yet today");
    const noData = publishedSignal("SENSEX", istAt(DAY, "10:01"), market.snapshotSync(istAt(DAY, "10:01")), calendar, cfg);
    expect(noData.entry).toBeNull();
    expect(noData.exitBull).toBeNull();
  });

  it("previous close prefers the official daily close, else the last 5-minute bar", () => {
    const { today: s, history } = sessionsAt(candles, calendar, istAt(DAY, "10:01"), BAR, 3);
    expect(history.map((x) => x.date)).toEqual(days.slice(0, 3));
    expect(s?.bars.length).toBe(9);
    expect(s?.open).toBe(100);
    // The history sessions' last bar (ending 15:30) closed at 100.5.
    expect(previousClose(history, [], DAY)).toBe(100.5);
    expect(previousClose(history, [{ t: istAt(days[2], "09:15"), o: 0, h: 0, l: 0, c: 99.7, v: 0 }], DAY)).toBe(99.7);
    // A daily bar older than the latest 5-minute session does not override it.
    expect(previousClose(history, [{ t: istAt(days[0], "09:15"), o: 0, h: 0, l: 0, c: 98, v: 0 }], DAY)).toBe(100.5);
  });

  it("carries the signal on a conviction the planner and the follower accounts understand", () => {
    const c = publishedConviction("NIFTY", istAt(DAY, "10:01"), at("10:00"), "RANGE", cfg);
    expect(c).toMatchObject({ score: 1, passes: true, threshold: 1, stance: "BULLISH", sizeMult: 1 });
    expect(c.components[0]).toMatchObject({ source: "MOMENTUM", value: 1, weight: 1 });
    expect(c.published?.strategy).toBe("NOISE_AREA");
    const idle = publishedConviction("NIFTY", istAt(DAY, "10:11"), at("10:10"), "RANGE", cfg);
    expect(idle).toMatchObject({ score: 0, passes: false, stance: "NEUTRAL" });
  });
});

describe("published index-level exits in evaluateExits", () => {
  const T = istAt(DAY, "11:01");
  const contract: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "NIFTY26O0624500CE", growwSymbol: "", exchangeToken: "", expiry: "2026-10-06", strike: 24500, type: "CE", lotSize: 65, tickSize: 0.05 };
  const pos: Position = {
    id: "p", planId: "x", index: "NIFTY", side: "BULL", contract, mode: "BACKTEST", qty: 65, avgEntry: 100, entryMs: T - 60 * MINUTE_MS, entryCharges: 30, status: "OPEN",
    markPremium: 100, markMs: T, peakPremium: 100, unrealized: 0,
    stops: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: T - MINUTE_MS, squareOffMs: istAt(DAY, "15:05") },
    horizonMin: 60, convictionAtEntry: 1, regimeAtEntry: "RANGE", dominantSource: "MOMENTUM", attribution: [], eventKeysAtEntry: [], maePct: 0, mfePct: 0,
  };
  const q = (bid: number): Quote => ({ symbol: "x", t: T, ltp: bid, bid, ask: bid + 0.5, bidQty: 1000, askQty: 1000, source: "synthetic" });
  const noise = makeConfig({ strategy: { mode: "NOISE_AREA" }, sizing: { maxOpenPerIndex: 1 } });
  const sig = (over: Partial<PublishedSignal>): PublishedSignal => ({ ...idleSignal(noise, "test"), ...over });
  const conv = (s: PublishedSignal): Conviction => publishedConviction("NIFTY", T, s, "RANGE", noise);
  const flip = { reason: "SIGNAL_FLIP" as const, detail: "crossover" };

  it("is inert in CONVICTION mode, even with a published signal on the conviction", () => {
    const c = conv(sig({ exitBull: flip }));
    expect(publishedIndexExit(pos, q(120), { nowMs: T, conviction: c }, DEFAULT_CONFIG)).toBeUndefined();
    // The engine's own exits run unchanged: the time stop has passed with P&L under +10%.
    expect(evaluateExits(pos, q(105), { nowMs: T }, DEFAULT_CONFIG)?.reason).toBe("TIME_STOP");
  });

  it("holds a published position through the premium target, trail and time stop, and exits on the index rule", () => {
    const hold = conv(sig({}));
    expect(evaluateExits(pos, q(160), { nowMs: T, conviction: hold }, noise)).toBeNull(); // +60%: no premium target
    expect(evaluateExits({ ...pos, peakPremium: 150 }, q(118), { nowMs: T, conviction: hold }, noise)).toBeNull(); // no premium trail
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: hold }, noise)).toBeNull(); // no time stop
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: conv(sig({ exitBull: flip })) }, noise)).toMatchObject({ reason: "SIGNAL_FLIP", orderType: "MARKET" });
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: conv(sig({ exitBear: flip })) }, noise)).toBeNull();
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: conv(sig({ exitBull: { reason: "TARGET", detail: "10R" } })) }, noise)).toMatchObject({ reason: "TARGET", orderType: "LIMIT", limitPrice: 105 });
  });

  it("keeps the premium stop, square-off and halts ahead of the index rule", () => {
    const c = conv(sig({ exitBull: flip }));
    expect(evaluateExits(pos, q(69), { nowMs: T, conviction: c }, noise)?.reason).toBe("STOP");
    expect(evaluateExits(pos, q(105), { nowMs: istAt(DAY, "15:06"), conviction: c }, noise)?.reason).toBe("SQUARE_OFF");
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: c, haltReason: { reason: "DAILY_LOSS_CAP", detail: "cap" } }, noise)?.reason).toBe("DAILY_LOSS_CAP");
  });

  it("falls back to the engine's exits when the index has no published signal", () => {
    const other = { ...conv(sig({ exitBull: flip })), index: "SENSEX" as const };
    expect(evaluateExits(pos, q(105), { nowMs: T, conviction: other }, noise)?.reason).toBe("TIME_STOP");
  });
});

describe("strategy config", () => {
  it("defaults to the conviction model with the published parameters", () => {
    expect(DEFAULT_CONFIG.strategy.mode).toBe("CONVICTION");
    expect(DEFAULT_CONFIG.strategy.noiseArea).toMatchObject({ lookbackSessions: 14, bandMult: 1, decisionEveryMin: 30, stop: "OPPOSITE_BAND", sizing: "ENGINE" });
    expect(DEFAULT_CONFIG.strategy.orb5).toMatchObject({ rangeMin: 5, targetR: 10, entry: "ENGINE_WINDOW" });
    expect(DEFAULT_CONFIG.gates.noEntryBeforeIst).toBe("09:25");
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it("rejects settings the published rules cannot run with", () => {
    expect(() => makeConfig({ strategy: { mode: "NOISE_AREA" }, sizing: { maxOpenPerIndex: 2 } })).toThrow(/one position per index/);
    expect(() => makeConfig({ strategy: { mode: "ORB5", orb5: { entry: "PUBLISHED" } }, sizing: { maxOpenPerIndex: 1 } })).toThrow(/noEntryBeforeIst/);
    expect(makeConfig({ strategy: { mode: "ORB5", orb5: { entry: "PUBLISHED" } }, sizing: { maxOpenPerIndex: 1 }, gates: { noEntryBeforeIst: "09:20" } }).gates.noEntryBeforeIst).toBe("09:20");
    expect(() => withOverrides(DEFAULT_CONFIG, { strategy: { noiseArea: { decisionEveryMin: 7 } } })).toThrow(/decisionEveryMin/);
    expect(() => withOverrides(DEFAULT_CONFIG, { strategy: { noiseArea: { lookbackSessions: 1 } } })).toThrow(/lookbackSessions/);
    expect(() => withOverrides(DEFAULT_CONFIG, { strategy: { mode: "NOPE" as never } })).toThrow(/strategy.mode/);
  });
});
