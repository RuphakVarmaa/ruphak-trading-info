import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import type { Candle, Indicators, OpeningRange, OptionContract } from "../types";
import {
  buildSetupContext,
  detectOrb,
  detectPrevDay,
  detectRangeReversal,
  detectVwapPullback,
  evaluateSetups,
  floorPivots,
  mergeZones,
  optionPlan,
  premiumAt,
  rawLevels,
  sessionBlock,
  setupStatus,
  setupStrike,
  stopAndTargets,
  type ContextInputs,
  type StatusInput,
} from "./setups";

const DAY = "2026-10-14";
const at = (hm: string) => istAt(DAY, hm);

function ind(o: Partial<Indicators> = {}): Indicators {
  return {
    rsi14: 60, adx14: 26, plusDi14: 28, minusDi14: 14, ema9: 22500, ema21: 22470, ema9SlopePct: 0.05,
    supertrendDir: 1, supertrendLine: 22420, bbPctB: 0.7, bbWidthPct: 0.5, vwap: 22480, vwapZ: 0.8,
    dailyBias: 1, dailyEmaGapPct: 0.4, prevDayHigh: 22600, prevDayLow: 22300, prevDayClose: 22450, ...o,
  };
}
const OR: OpeningRange = { high: 22540, low: 22430, state: "INSIDE", strengthAtr: 0, barsOutside: 0, lastBreak: null, barsSinceReentry: 0 };

/** Bars from 09:15 every 5 minutes, each closing at the given price with a small range. */
function bars(closes: number[], start = "09:15", wick = 6): Candle[] {
  const t0 = at(start);
  return closes.map((c, i) => {
    const o = i > 0 ? closes[i - 1] : c;
    return { t: t0 + i * 300_000, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 0 };
  });
}

function ctxAt(hm: string, closes: number[], o: Partial<ContextInputs> = {}) {
  return buildSetupContext({
    index: "NIFTY", t: at(hm), spot: closes[closes.length - 1], atrPct5m: 0.1, ind: ind(), or: OR, regime: "TREND_UP",
    candles: bars(closes), isExpiryDay: false, ...o,
  });
}

describe("key levels", () => {
  it("computes classic floor pivots from the previous day", () => {
    const p = floorPivots(22600, 22300, 22450);
    expect(p.p).toBeCloseTo(22450, 6);
    expect(p.r1).toBeCloseTo(22600, 6);
    expect(p.s1).toBeCloseTo(22300, 6);
    expect(p.r2).toBeCloseTo(22750, 6);
    expect(p.s2).toBeCloseTo(22150, 6);
  });

  it("merges levels within 0.05% into one labelled zone, strongest first", () => {
    const z = mergeZones([
      { price: 22600, kind: "R1", weight: 2 },
      { price: 22605, kind: "PDH", weight: 3 },
      { price: 22700, kind: "22700", weight: 1 },
    ]);
    expect(z).toHaveLength(2);
    expect(z[0]).toMatchObject({ label: "PDH + R1", strength: 5 });
    expect(z[0].price).toBeCloseTo(22603, 0);
    expect(z[1].label).toBe("22700");
  });

  it("lists the opening range only after 09:30 and round numbers on the index's step", () => {
    const base = { index: "SENSEX" as const, spot: 74120, ind: ind({ prevDayHigh: 0, prevDayLow: 0, prevDayClose: 0, vwap: 0, supertrendDir: 0 }), or: { high: 74200, low: 74000 }, sessionHigh: 0, sessionLow: 0, vwapSigma: 0 };
    expect(rawLevels({ ...base, minutes: 9 * 60 + 25 }).some((l) => l.kind === "ORH")).toBe(false);
    const after = rawLevels({ ...base, minutes: 10 * 60 });
    expect(after.some((l) => l.kind === "ORH")).toBe(true);
    expect(after.filter((l) => /^\d+$/.test(l.kind)).map((l) => l.price)).toEqual([73500, 74000, 74500, 75000]);
  });
});

describe("session rules", () => {
  it("allows new setups 09:25–14:30, and not after 13:00 on expiry day", () => {
    expect(sessionBlock(9 * 60 + 20, false)).toMatch(/09:25/);
    expect(sessionBlock(9 * 60 + 25, false)).toBeNull();
    expect(sessionBlock(14 * 60 + 30, false)).toBeNull();
    expect(sessionBlock(14 * 60 + 31, false)).toMatch(/14:30/);
    expect(sessionBlock(13 * 60 + 1, true)).toMatch(/Expiry/);
    expect(sessionBlock(12 * 60 + 59, true)).toBeNull();
  });

  it("shows no new setup outside the window, with the reason", () => {
    const closes = [22450, 22470, 22490, 22500, 22510, 22520, 22525, 22530];
    const ctx = ctxAt("14:45", closes, { candles: bars(closes, "14:05") });
    const r = evaluateSetups(ctx, null);
    expect(r.setups).toEqual([]);
    expect(r.note).toMatch(/14:30/);
  });
});

describe("detectors", () => {
  it("a. opening-range breakout with the trend filters, and none before 09:30", () => {
    const ctx = ctxAt("10:00", [22450, 22480, 22500, 22510, 22520, 22528, 22532]);
    const [bull, bear] = detectOrb(ctx);
    expect(bull).toMatchObject({ kind: "ORB", side: "BULL", trigger: 22540, ok: true });
    expect(bull.score).toBeGreaterThan(70);
    expect(bull.evidence.some((e) => e.supports && /ADX 26.0/.test(e.text))).toBe(true);
    expect(bear.ok).toBe(false);
    expect(detectOrb(ctxAt("09:25", [22450, 22460]))).toEqual([]);
  });

  it("b. previous-day high breakout needs price above VWAP and EMAs aligned", () => {
    const ctx = ctxAt("11:00", [22550, 22570, 22580, 22590]);
    const [bull] = detectPrevDay(ctx);
    expect(bull).toMatchObject({ kind: "PDH_PDL", trigger: 22600, ok: true });
    const weak = ctxAt("11:00", [22550, 22570, 22580, 22590], { ind: ind({ ema9: 22400, ema21: 22450 }) });
    expect(detectPrevDay(weak)[0].ok).toBe(false);
  });

  it("c. VWAP pullback in an uptrend with RSI 40–55 turning up", () => {
    const closes = [22500, 22520, 22540, 22530, 22510, 22495, 22486];
    const ctx = ctxAt("10:30", closes, { ind: ind({ rsi14: 48, vwap: 22482 }) });
    const c = detectVwapPullback(ctx).find((x) => x.side === "BULL")!;
    expect(c).toMatchObject({ kind: "VWAP_PULLBACK", style: "REVERSAL", ok: true });
    expect(c.level.label).toBe("VWAP");
    expect(c.trigger).toBeCloseTo(22482 + 0.2 * ctx.atr, 6);
    // No trend and no Supertrend support: nothing.
    expect(detectVwapPullback(ctxAt("10:30", closes, { regime: "RANGE", ind: ind({ supertrendDir: -1, vwap: 22482 }) })).some((x) => x.side === "BULL")).toBe(false);
  });

  it("d. support bounce in a range needs RSI < 35 at a strong zone", () => {
    const closes = [22400, 22380, 22350, 22330, 22315, 22306];
    const base = { regime: "RANGE" as const, ind: ind({ rsi14: 31, bbPctB: 0.05, vwap: 22380, adx14: 14, supertrendDir: 0 }) };
    const c = detectRangeReversal(ctxAt("11:30", closes, base)).find((x) => x.side === "BULL")!;
    expect(c.level.label).toMatch(/PDL/);
    expect(c.ok).toBe(true);
    expect(c.evidence.find((e) => /%B/.test(e.text))?.supports).toBe(true);
    const noRsi = detectRangeReversal(ctxAt("11:30", closes, { ...base, ind: ind({ ...base.ind, rsi14: 45 }) })).find((x) => x.side === "BULL")!;
    expect(noRsi.ok).toBe(false);
    expect(detectRangeReversal(ctxAt("11:30", closes, { ...base, regime: "TREND_UP" }))).toEqual([]);
  });
});

describe("status", () => {
  const atr = 22;
  const base = (o: Partial<StatusInput>): StatusInput => ({ side: "BULL", style: "BREAKOUT", level: 22540, trigger: 22540, stop: 22506, atr, spot: 22530, bars: bars([22500, 22515, 22525]), forming: null, prev: null, ok: true, ...o });

  it("WATCHING near the trigger and moving toward it; nothing when far", () => {
    expect(setupStatus(base({ spot: 22530 }))).toBe("WATCHING");
    expect(setupStatus(base({ spot: 22400 }))).toBeNull();
    expect(setupStatus(base({ spot: 22520 }))).toBeNull();
  });

  it("READY when crossed intrabar, TRIGGERED on a 5-minute close beyond, MISSED past 0.5 ATR", () => {
    const forming = { t: at("09:30"), o: 22525, h: 22546, l: 22522, c: 22544, v: 0 };
    expect(setupStatus(base({ spot: 22544, forming }))).toBe("READY");
    const closed = bars([22500, 22515, 22525, 22545]);
    expect(setupStatus(base({ spot: 22546, bars: closed, prev: "READY" }))).toBe("TRIGGERED");
    expect(setupStatus(base({ spot: 22546 + atr, bars: closed, prev: "READY" }))).toBe("MISSED");
    expect(setupStatus(base({ spot: 22560, bars: closed, prev: "TRIGGERED" }))).toBe("MISSED");
    expect(setupStatus(base({ spot: 22545, bars: closed, prev: "MISSED" }))).toBe("MISSED");
  });

  it("INVALID when the stop trades after the trigger, or the conditions fail", () => {
    const closed = bars([22500, 22515, 22525, 22545]);
    expect(setupStatus(base({ spot: 22500, bars: closed, prev: "TRIGGERED" }))).toBe("INVALID");
    expect(setupStatus(base({ spot: 22530, ok: false, prev: "WATCHING" }))).toBe("INVALID");
    expect(setupStatus(base({ spot: 22530, ok: false }))).toBeNull();
    // A close back inside after the break: failed breakout.
    expect(setupStatus(base({ spot: 22532, bars: bars([22500, 22515, 22525, 22545, 22532]), prev: "READY" }))).toBe("INVALID");
    expect(setupStatus(base({ spot: 22560, prev: "INVALID" }))).toBe("INVALID");
  });

  it("a reversal needs a candle that tests the level and closes back beyond the trigger", () => {
    const r = (o: Partial<StatusInput>) => base({ style: "REVERSAL", level: 22482, trigger: 22486.4, stop: 22448, ...o });
    expect(setupStatus(r({ spot: 22495, bars: bars([22520, 22505, 22498]) }))).toBe("WATCHING");
    const tested = [...bars([22520, 22505, 22490]), { t: at("09:30"), o: 22490, h: 22495, l: 22481, c: 22492, v: 0 }];
    expect(setupStatus(r({ spot: 22493, bars: tested, prev: "WATCHING" }))).toBe("TRIGGERED");
  });

  it("carries status and its start time across ticks, and ends a TRIGGERED setup as MISSED", () => {
    const closes = [22450, 22480, 22500, 22510, 22520, 22528, 22532];
    const c1 = ctxAt("10:00", closes);
    const r1 = evaluateSetups(c1, null);
    const orb = r1.setups.find((s) => s.kind === "ORB" && s.side === "BULL")!;
    expect(orb.status).toBe("WATCHING");
    const rec = { t: c1.t, index: "NIFTY" as const, session: DAY, spot: c1.spot, setups: r1.setups, levels: [], note: null };
    const closes2 = [...closes, 22548];
    const c2 = ctxAt("10:05", closes2, { spot: 22549 });
    const r2 = evaluateSetups(c2, rec);
    const orb2 = r2.setups.find((s) => s.id === orb.id)!;
    expect(orb2.status).toBe("TRIGGERED");
    expect(orb2.firstSeen).toBe(orb.firstSeen);
    expect(orb2.statusSince).not.toBe(orb.statusSince);
    const rec2 = { ...rec, t: c2.t, setups: r2.setups };
    const c3 = ctxAt("10:06", closes2, { spot: 22549 + c2.atr });
    expect(evaluateSetups(c3, rec2).setups.find((s) => s.id === orb.id)?.status).toBe("MISSED");
  });
});

describe("stop, targets, R:R", () => {
  const zones = mergeZones([
    { price: 22600, kind: "PDH", weight: 3 },
    { price: 22650, kind: "R1", weight: 2 },
  ]);

  it("stop beyond the level by 0.25 ATR or the swing, whichever is closer, at least 0.15%", () => {
    const a = stopAndTargets("BULL", 22540, 22540, 40, 22480, zones);
    expect(a.stop).toBe(22506.19); // 0.25 ATR = 10 → 22530 is closer than 0.15% allows: 22540 − 33.81
    const b = stopAndTargets("BULL", 22540, 22540, 200, 22500, zones);
    expect(b.stop).toBe(22500); // the swing is closer than 22490
  });

  it("T1 the next zone at least 1R away, T2 the zone after or 2R, and R:R", () => {
    const l = stopAndTargets("BULL", 22540, 22540, 40, null, zones);
    const risk = 22540 - l.stop;
    expect(l).toMatchObject({ t1: 22600, t1Label: "PDH", t2: 22650, t2Label: "R1" });
    expect(l.rr1).toBeCloseTo(60 / risk, 2);
    // A wall within 1R: T1 forced to 1R, R:R 1.0 (dropped by the 1.2 filter).
    const near = stopAndTargets("BULL", 22580, 22580, 40, null, zones);
    expect(near).toMatchObject({ t1Label: "1R", rr1: 1 });
    const bear = stopAndTargets("BEAR", 22300, 22300, 40, null, []);
    expect(bear).toMatchObject({ t1Label: "1.5R", t2Label: "2R", rr1: 1.5, rr2: 2 });
    expect(bear.stop).toBeGreaterThan(22300);
  });
});

describe("the option", () => {
  const contract: OptionContract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "NIFTY26O2022500CE", growwSymbol: "", exchangeToken: "1", expiry: "2026-10-20", strike: 22500, type: "CE", lotSize: 65, tickSize: 0.05 };

  it("strike ATM, one in the money at score 75+", () => {
    expect(setupStrike(22512, 50, "BULL", 60)).toBe(22500);
    expect(setupStrike(22512, 50, "BULL", 80)).toBe(22450);
    expect(setupStrike(22512, 50, "BEAR", 80)).toBe(22550);
    expect(setupStrike(74120, 100, "BEAR", 50)).toBe(74100);
  });

  it("maps premium with delta, gamma and theta, on the tick", () => {
    const g = { delta: 0.5, gamma: 0.001, thetaPerMin: -0.05 };
    // 100 + 0.5·40 + ½·0.001·1600 − 0.05·30 = 119.3
    expect(premiumAt(100, g, 40, 30)).toBe(119.3);
    expect(premiumAt(100, g, -33, 0)).toBeCloseTo(84.05, 6);
    expect(premiumAt(1, g, -500, 0)).toBe(0.05);
  });

  it("builds the premium plan with risk and reward per lot, capping the stop at −30%", () => {
    const p = optionPlan({ contract, premiumNow: 110, priceSource: "broker", iv: 13, spot: 22512, greeks: { delta: 0.55, gamma: 0.0012, thetaPerMin: -0.04 }, trigger: 22540, stop: 22506, t1: 22600, t2: 22650, maxStopPct: -30, minutesLeft: 200 });
    expect(p.entry).toBe(125.85); // 110 + 0.55·28 + ½·0.0012·784 = 125.87 → tick
    expect(p.stop).toBeLessThan(p.entry);
    expect(p.stopCapped).toBe(false);
    expect(p.t1).toBeGreaterThan(p.entry);
    expect(p.t2).toBeGreaterThan(p.t1);
    expect(p.riskPerLot).toBe(Math.round((p.entry - p.stop) * 65));
    expect(p.contract.label).toBe("NIFTY 22500 CE 2026-10-20");
    const wide = optionPlan({ contract, premiumNow: 40, priceSource: "model", iv: 13, spot: 22512, greeks: { delta: 0.55, gamma: 0.0012, thetaPerMin: -0.04 }, trigger: 22540, stop: 22400, t1: 22700, t2: 22800, maxStopPct: -30, minutesLeft: 200 });
    expect(wide.stopCapped).toBe(true);
    expect(wide.stopPct).toBeCloseTo(-30, 0);
  });
});
