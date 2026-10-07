import { describe, expect, it } from "vitest";
import { computeCharges, roundTripChargesPerUnit, scheduleFor } from "../broker/charges";
import { limitFill, marketableLimit, marketFill, quoteProblem } from "../broker/fillModel";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import type { Conviction, EventPressure, MarketFeatures, OptionContract, Position, Quote, ScoredEvent, SignalPerformance } from "../types";
import { combineConviction, dominantSource, effectiveWeight, attributionShares } from "./conviction";
import { evaluateExits, markPosition, trailPrice } from "./exits";
import { evaluateEdge } from "./gates";
import { classifyRegime } from "./regime";
import { gapSignal, globalBetaSignal, momentumSignal, rawComponents, relativeValueSignal, volRegimeSignal } from "./signals";
import { kellyFraction, sizePosition } from "./sizing";
import { defaultSettings } from "../settings";

const cfg = DEFAULT_CONFIG;
const T = istAt("2026-10-07", "11:00");

export function features(over: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    index: "NIFTY",
    t: T,
    spot: 22600,
    dataAgeSec: 30,
    ret5m: 0,
    ret15m: 0,
    ret60m: 0,
    retFromOpen: 0,
    vwapDistPct: 0,
    barsSameSideOfVwap: 0,
    openingRange: { high: 22650, low: 22550, state: "INSIDE" },
    efficiencyRatio60m: 0.3,
    atrPct5m: 0.08,
    atrPctile20d: 50,
    gapPct: 0,
    expectedGapPct: 0,
    gapResidualPct: 0,
    vix: 14,
    vixChangePct: 0,
    realizedVol2h: 12,
    realizedVol20d: 13,
    rvIvRatio: 0.9,
    divergence: { vsOtherIndexZ: 0, vsBankNiftyZ: 0, otherIndexRet30m: 0, bankNiftyRet15m: 0, selfRet30m: 0 },
    global: { ES: 0, NQ: 0, CL: 0, BZ: 0, GC: 0, DXY: 0, USDINR: 0, US10Y: 0, VIXUS: 0, N225: 0, HSI: 0, SSE: 0 },
    minutesSinceOpen: 105,
    minutesToClose: 270,
    isExpiryDay: false,
    tradingDaysToExpiry: 4,
    nextScheduledEvent: null,
    recentScheduledEvent: null,
    ...over,
  };
}

const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1322600CE",
  growwSymbol: "NSE-NIFTY-13Oct26-22600-CE",
  exchangeToken: "1",
  expiry: "2026-10-13",
  strike: 22600,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
  freezeQty: 1755,
};

function quote(over: Partial<Quote> = {}): Quote {
  return { symbol: contract.tradingSymbol, t: T, ltp: 150, bid: 149.8, ask: 150.2, bidQty: 650, askQty: 650, source: "groww", ...over };
}

describe("charges", () => {
  it("matches the worked example for one NIFTY lot at ₹150", () => {
    const buy = computeCharges("BUY", 150, 65, "NSE", "2026-10-07");
    const sell = computeCharges("SELL", 150, 65, "NSE", "2026-10-07");
    expect(buy.total).toBeCloseTo(28, 0);
    expect(sell.total).toBeCloseTo(42.3, 0);
    expect(sell.stt).toBeCloseTo(14.63, 2); // 0.15% of ₹9,750
    expect(buy.stt).toBe(0);
    expect(buy.stampDuty).toBeCloseTo(0.29, 2);
    expect(roundTripChargesPerUnit(150, 65, "NSE", "2026-10-07")).toBeCloseTo(70.3 / 65, 2);
  });

  it("uses the schedule in force on the trade date", () => {
    expect(scheduleFor("2026-03-31").sttSellPct).toBe(0.1);
    expect(scheduleFor("2026-04-01").sttSellPct).toBe(0.15);
  });
});

describe("fill model", () => {
  const fp = { tickSize: 0.05, slippageTicksMarket: 2, depthLevels: 5, maxQuoteAgeMs: 180_000 };
  it("walks depth and pays extra ticks for the remainder", () => {
    const q = quote({ depth: { buy: [], sell: [{ price: 150.2, qty: 65 }, { price: 150.4, qty: 65 }] } });
    const f = marketFill("BUY", 195, q, fp);
    expect(f.filledQty).toBe(195);
    // 65 @150.2, 65 @150.4, 65 @ (150.4 + 2 ticks = 150.5)
    expect(f.avgPrice).toBeCloseTo((150.2 + 150.4 + 150.5) / 3, 2);
  });

  it("fills limits only when the opposite side touches", () => {
    expect(limitFill("BUY", 65, 150.1, quote(), fp).filledQty).toBe(0);
    expect(limitFill("BUY", 65, 150.3, quote(), fp).avgPrice).toBe(150.2);
    expect(limitFill("SELL", 65, 149.8, quote(), fp).avgPrice).toBe(149.8);
  });

  it("rejects stale or one-sided quotes and builds marketable limits", () => {
    expect(quoteProblem(quote({ bid: 0 }), T, fp)).toMatch(/two-sided/);
    expect(quoteProblem(quote({ t: T - 600_000 }), T, fp)).toMatch(/stale/);
    expect(quoteProblem(quote(), T, fp)).toBeNull();
    expect(marketableLimit("BUY", quote(), 0.05)).toBeCloseTo(150.3, 2);
    expect(marketableLimit("SELL", quote(), 0.05)).toBeCloseTo(149.7, 2);
  });
});

describe("sizing", () => {
  const settings = { ...defaultSettings(cfg, T), maxLotsPerOrder: 10 };
  it("sizes from the default risk budget and caps", () => {
    // ₹5L × 0.75% = ₹3,750; one lot risks 30% of ₹9,750 = ₹2,925 -> 1 lot
    const s = sizePosition({ premium: 150, contract, perf: undefined, sizeMult: 1, capitalRupees: 500_000, openPremiumRupees: 0, settings }, cfg);
    expect(s.lots).toBe(1);
    expect(s.qty).toBe(65);
    expect(s.limitedBy).toBe("risk budget");
  });

  it("refuses a negative Kelly edge once a source has history", () => {
    const perf = { windowTrades: 30, hitRate: 0.3, avgWinPct: 40, avgLossPct: -30 } as SignalPerformance;
    expect(kellyFraction(0.3, 40, -30)).toBeLessThan(0);
    expect(sizePosition({ premium: 150, contract, perf, sizeMult: 1, capitalRupees: 500_000, openPremiumRupees: 0, settings }, cfg).lots).toBe(0);
  });

  it("allows one lot slightly over a small budget but never over the hard cap", () => {
    // premium 195: one lot risks ₹3,802 vs a ₹3,750 budget (hard cap ₹5,000)
    const s1 = sizePosition({ premium: 195, contract, perf: undefined, sizeMult: 1, capitalRupees: 500_000, openPremiumRupees: 0, settings }, cfg);
    expect(s1.lots).toBe(1);
    expect(s1.limitedBy).toMatch(/minimum one lot/);
    // premium 300: one lot risks ₹5,850 > hard cap
    expect(sizePosition({ premium: 300, contract, perf: undefined, sizeMult: 1, capitalRupees: 500_000, openPremiumRupees: 0, settings }, cfg).lots).toBe(0);
    // rich options halve the budget: no rounding up past 1.5x of the halved budget
    expect(sizePosition({ premium: 190, contract, perf: undefined, sizeMult: 0.5, capitalRupees: 500_000, openPremiumRupees: 0, settings }, cfg).lots).toBe(0);
  });

  it("respects the combined premium cap", () => {
    const s = sizePosition({ premium: 150, contract, perf: undefined, sizeMult: 3, capitalRupees: 500_000, openPremiumRupees: 25_000, settings }, cfg);
    expect(s.limitedBy).toBe("combined premium cap");
    expect(s.lots).toBe(0);
  });
});

function position(over: Partial<Position> = {}): Position {
  return {
    id: "p1",
    planId: "plan",
    index: "NIFTY",
    side: "BULL",
    contract,
    mode: "PAPER",
    qty: 65,
    avgEntry: 150,
    entryMs: T,
    entryCharges: 28,
    status: "OPEN",
    markPremium: 150,
    markMs: T,
    peakPremium: 150,
    unrealized: 0,
    stops: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: T + 120 * 60_000, squareOffMs: istAt("2026-10-07", "15:05") },
    horizonMin: 120,
    convictionAtEntry: 0.6,
    regimeAtEntry: "TREND_UP",
    dominantSource: "MOMENTUM",
    attribution: [],
    eventKeysAtEntry: [],
    maePct: 0,
    mfePct: 0,
    ...over,
  };
}

describe("exits", () => {
  it("applies stop, target, trail, time stop and square-off in priority order", () => {
    const p = position();
    expect(evaluateExits(p, quote({ bid: 104, ask: 104.4, ltp: 104 }), { nowMs: T + 60_000 }, cfg)?.reason).toBe("STOP");
    expect(evaluateExits(p, quote({ bid: 226, ask: 227, ltp: 226 }), { nowMs: T + 60_000 }, cfg)?.reason).toBe("TARGET");
    const peaked = position({ peakPremium: 200 });
    expect(trailPrice(peaked)).toBe(175);
    expect(evaluateExits(peaked, quote({ bid: 174, ask: 175, ltp: 174 }), { nowMs: T + 60_000 }, cfg)?.reason).toBe("TRAIL");
    expect(evaluateExits(p, quote(), { nowMs: T + 121 * 60_000 }, cfg)?.reason).toBe("TIME_STOP");
    expect(evaluateExits(p, quote({ bid: 104 }), { nowMs: istAt("2026-10-07", "15:06") }, cfg)?.reason).toBe("SQUARE_OFF");
    expect(evaluateExits(p, quote({ bid: 226 }), { nowMs: T, haltReason: { reason: "KILL_SWITCH", detail: "x" } }, cfg)?.reason).toBe("KILL_SWITCH");
    expect(evaluateExits(p, quote(), { nowMs: T + 60_000 }, cfg)).toBeNull();
  });

  it("exits on a signal flip and on event invalidation", () => {
    const c = { score: -0.3, threshold: 0.4 } as Conviction;
    expect(evaluateExits(position(), quote(), { nowMs: T + 60_000, conviction: c }, cfg)?.reason).toBe("SIGNAL_FLIP");
    const ev = { numeric: { NIFTY: 0.0, SENSEX: 0 }, pricedIn: "LOW", title: "x" } as unknown as ScoredEvent;
    const p = position({ dominantSource: "EVENT", eventKeysAtEntry: ["k"] });
    expect(evaluateExits(p, quote(), { nowMs: T + 60_000, eventsByKey: new Map([["k", ev]]) }, cfg)?.reason).toBe("EVENT_INVALIDATION");
  });

  it("marks at the bid and tracks excursions", () => {
    const m = markPosition(position(), quote({ bid: 160, ltp: 161 }), T + 1);
    expect(m.markPremium).toBe(160);
    expect(m.unrealized).toBe(650);
    expect(m.mfePct).toBeCloseTo(6.67, 1);
  });
});

describe("signals", () => {
  it("momentum follows vol-normalized returns, VWAP and the opening range", () => {
    const up = momentumSignal(features({ ret15m: 0.3, ret60m: 0.6, barsSameSideOfVwap: 8, openingRange: { high: 1, low: 0, state: "BROKE_UP" } }), cfg);
    const down = momentumSignal(features({ ret15m: -0.3, ret60m: -0.6, barsSameSideOfVwap: -8, openingRange: { high: 1, low: 0, state: "BROKE_DOWN" } }), cfg);
    expect(up.value).toBeGreaterThan(0.7);
    expect(down.value).toBeLessThan(-0.7);
    expect(momentumSignal(features({ minutesSinceOpen: 2, ret15m: 1 }), cfg).value).toBe(0);
  });

  it("gap extends or fades and switches off after 90 minutes", () => {
    expect(gapSignal(features({ minutesSinceOpen: 20, gapPct: 0.8, retFromOpen: 0.3 })).value).toBeGreaterThan(0);
    expect(gapSignal(features({ minutesSinceOpen: 20, gapPct: 0.8, retFromOpen: -0.3 })).value).toBeLessThan(0);
    expect(gapSignal(features({ minutesSinceOpen: 120, gapPct: 0.8, retFromOpen: 0.3 })).value).toBe(0);
  });

  it("global beta expects catch-up when India lags global moves", () => {
    const f = features({ global: { ES: 1.5, NQ: 1.5, CL: -2, BZ: -2, GC: 0, DXY: -0.5, USDINR: -0.3, US10Y: -5, VIXUS: -5, N225: 1, HSI: 1, SSE: 0.5 }, gapPct: 0.1, retFromOpen: 0 });
    expect(globalBetaSignal(f, cfg).value).toBeGreaterThan(0.3);
    expect(globalBetaSignal(features({ global: { ES: null, NQ: null, CL: null, BZ: null, GC: null, DXY: null, USDINR: null, US10Y: null, VIXUS: null, N225: null, HSI: null, SSE: null } }), cfg).value).toBe(0);
  });

  it("relative value mean-reverts large Nifty-Sensex spreads and follows Bank Nifty", () => {
    expect(relativeValueSignal(features({ divergence: { vsOtherIndexZ: -2.5, vsBankNiftyZ: 0, otherIndexRet30m: 0.2, bankNiftyRet15m: 0, selfRet30m: -0.1 } })).value).toBeGreaterThan(0);
    expect(relativeValueSignal(features({ divergence: { vsOtherIndexZ: 1, vsBankNiftyZ: 2, otherIndexRet30m: 0, bankNiftyRet15m: 0.4, selfRet30m: 0 } })).value).toBeGreaterThan(0);
    expect(relativeValueSignal(features({ divergence: { vsOtherIndexZ: 1, vsBankNiftyZ: 1, otherIndexRet30m: 0, bankNiftyRet15m: 0, selfRet30m: 0 } })).value).toBe(0);
  });

  it("vol regime only modifies thresholds and size", () => {
    const cheap = volRegimeSignal(features({ rvIvRatio: 1.4 }));
    expect(cheap.value).toBe(0);
    expect(cheap.modifiers).toEqual({ thresholdDelta: -0.05, sizeMult: 1.25 });
    expect(volRegimeSignal(features({ rvIvRatio: 0.6 })).modifiers?.thresholdDelta).toBe(0.1);
  });
});

describe("regime", () => {
  const p = (abs: number, age: number | null): EventPressure => ({ index: "NIFTY", t: T, epi: -abs, absPressure: abs, activeClusters: 1, freshestEventAgeMin: age, topContributors: [] });
  it("classifies event, high-vol, trend and range in order", () => {
    expect(classifyRegime(features({ nextScheduledEvent: { id: "x", name: "RBI", impact: "HIGH", minutesAway: 10 } }), null, cfg.regime).regime).toBe("EVENT");
    expect(classifyRegime(features(), p(0.6, 20), cfg.regime).regime).toBe("EVENT");
    expect(classifyRegime(features(), p(0.6, 200), cfg.regime).regime).toBe("RANGE");
    expect(classifyRegime(features({ vix: 21 }), null, cfg.regime).regime).toBe("HIGH_VOL");
    expect(classifyRegime(features({ ret60m: 0.5, efficiencyRatio60m: 0.7, barsSameSideOfVwap: 8 }), null, cfg.regime).regime).toBe("TREND_UP");
    expect(classifyRegime(features({ ret60m: -0.5, efficiencyRatio60m: 0.7, barsSameSideOfVwap: -8 }), null, cfg.regime).regime).toBe("TREND_DOWN");
    expect(classifyRegime(features(), null, cfg.regime).regime).toBe("RANGE");
  });
});

describe("conviction", () => {
  it("shrinks weights toward the prior and zeroes disabled sources", () => {
    expect(effectiveWeight("EVENT", undefined, cfg.conviction).weight).toBe(0.35);
    const good = { windowTrades: 30, expectancyPct: 20, enabled: true } as SignalPerformance;
    expect(effectiveWeight("EVENT", good, cfg.conviction).weight).toBeCloseTo((30 * 0.7 + 30 * 0.35) / 60, 6);
    expect(effectiveWeight("EVENT", { ...good, enabled: false }, cfg.conviction)).toEqual({ weight: 0, enabled: false });
  });

  it("lets only event and gap vote in the EVENT regime", () => {
    const p: EventPressure = { index: "NIFTY", t: T, epi: -0.6, absPressure: 0.6, activeClusters: 1, freshestEventAgeMin: 10, topContributors: [] };
    const f = features({ ret15m: 0.5, ret60m: 1, barsSameSideOfVwap: 10 });
    const ev = combineConviction("NIFTY", T, rawComponents(f, p, cfg), "EVENT", [], cfg);
    expect(ev.components.find((c) => c.source === "MOMENTUM")!.weight).toBe(0);
    expect(ev.score).toBeLessThan(0);
    expect(dominantSource(ev)).toBe("EVENT");
    const range = combineConviction("NIFTY", T, rawComponents(f, p, cfg), "RANGE", [], cfg);
    expect(range.score).toBeGreaterThan(ev.score);
    const shares = attributionShares(range);
    expect(shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
  });

  it("raises the bar for counter-trend trades", () => {
    const p: EventPressure = { index: "NIFTY", t: T, epi: -0.9, absPressure: 0.9, activeClusters: 1, freshestEventAgeMin: 200, topContributors: [] };
    const c = combineConviction("NIFTY", T, rawComponents(features(), p, cfg), "TREND_UP", [], cfg);
    expect(c.score).toBeLessThan(0);
    expect(c.threshold).toBe(cfg.conviction.counterTrendThreshold);
  });
});

describe("theta gate", () => {
  const base = { spot: 25_000, contract: { ...contract, strike: 25_000 }, tYears: (3 * 375) / (252 * 375), vol: 0.14, horizonMin: 120, t: T };
  it("passes a strong conviction and rejects a weak one (design worked example)", () => {
    const strong = evaluateEdge({ ...base, premium: 153, bid: 152.6, score: 0.6 }, cfg);
    const weak = evaluateEdge({ ...base, premium: 153, bid: 152.6, score: 0.4 }, cfg);
    expect(strong.delta).toBeGreaterThan(0.45);
    expect(strong.edgeRatio).toBeGreaterThan(weak.edgeRatio);
    expect(strong.edgeRatio).toBeGreaterThan(cfg.gates.minEdgeRatio);
    expect(weak.edgeRatio).toBeLessThan(cfg.gates.minEdgeRatio);
    expect(strong.impliedMovePct).toBeCloseTo(0.14 * 100 * Math.sqrt(120 / (252 * 375)) * 1.1, 6);
  });

  it("gets harder with less time to expiry (more theta)", () => {
    const far = evaluateEdge({ ...base, premium: 153, bid: 152.6, score: 0.6 }, cfg);
    const near = evaluateEdge({ ...base, tYears: 0.4 / 252, premium: 60, bid: 59.6, score: 0.6 }, cfg);
    expect(near.thetaOverHorizon / 60).toBeGreaterThan(far.thetaOverHorizon / 153);
  });
});

describe("config", () => {
  it("validates overrides", () => {
    expect(() => makeConfig({ exits: { stopPct: 10 } })).toThrow(/stopPct/);
    expect(makeConfig({ capitalRupees: 1_000_000 }).capitalRupees).toBe(1_000_000);
  });
});
