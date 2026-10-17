import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import type { OptionContract } from "../types";
import { bsPrice } from "./blackScholes";
import { SYNTHETIC_DEPTH_LOTS, SyntheticOptionQuotes, syntheticQuote, syntheticVol } from "./syntheticOptionPricer";
import { yearsToExpiry } from "./timeToExpiry";

const cal = new TradingCalendar();
const cfg = DEFAULT_CONFIG;
const atmCall: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1322600CE",
  growwSymbol: "NSE-NIFTY-13Oct26-22600-CE",
  exchangeToken: "44616",
  expiry: "2026-10-13",
  strike: 22600,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
  freezeQty: 3511,
};
const t = istAt("2026-10-07", "11:00");

const onTick = (x: number, tick = 0.05) => Math.abs(x / tick - Math.round(x / tick)) < 1e-9;

describe("syntheticVol", () => {
  it("scales India VIX by the per-index multiplier", () => {
    expect(syntheticVol("NIFTY", 14, cfg)).toBeCloseTo(0.14, 12);
    expect(syntheticVol("SENSEX", 14, cfg)).toBeCloseTo(0.147, 12);
    expect(syntheticVol("NIFTY", 0, cfg)).toBe(0);
    expect(syntheticVol("NIFTY", Number.NaN, cfg)).toBe(0);
  });
});

describe("syntheticQuote", () => {
  it("prices at Black-Scholes mid with a tick-rounded spread", () => {
    const q = syntheticQuote(atmCall, { t, spot: 22603.05, vix: 13.65 }, cal, cfg);
    const mid = bsPrice({
      spot: 22603.05,
      strike: 22600,
      tYears: yearsToExpiry(t, "2026-10-13", cal, cfg),
      vol: 0.1365,
      r: cfg.pricing.r,
      type: "CE",
    });
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(400);
    for (const p of [q.bid, q.ask, q.ltp]) expect(onTick(p)).toBe(true);
    const spread = q.ask - q.bid;
    // max(1 tick, 0.4% of premium), rounded up to whole ticks.
    expect(spread).toBeCloseTo(Math.ceil((0.004 * mid) / 0.05 - 1e-9) * 0.05, 9);
    expect(Math.abs((q.bid + q.ask) / 2 - mid)).toBeLessThanOrEqual(0.025 + 1e-9);
    expect(Math.abs(q.ltp - mid)).toBeLessThanOrEqual(0.025 + 1e-9);
    expect(q.iv).toBeCloseTo(13.65, 9);
    expect(q.source).toBe("synthetic");
    expect(q.symbol).toBe("NIFTY26O1322600CE");
    expect(q.t).toBe(t);
    expect(q.oi).toBeUndefined();
  });

  it("builds five depth levels per side, one tick apart, 20 lots and decreasing", () => {
    const q = syntheticQuote(atmCall, { t, spot: 22603.05, vix: 13.65 }, cal, cfg);
    expect(q.depth?.buy.length).toBe(5);
    expect(q.depth?.sell.length).toBe(5);
    expect(q.depth?.buy.map((l) => l.qty)).toEqual(SYNTHETIC_DEPTH_LOTS.map((n) => n * 65));
    expect(q.bidQty).toBe(20 * 65);
    expect(q.askQty).toBe(20 * 65);
    q.depth!.buy.forEach((l, k) => expect(l.price).toBeCloseTo(q.bid - k * 0.05, 9));
    q.depth!.sell.forEach((l, k) => expect(l.price).toBeCloseTo(q.ask + k * 0.05, 9));
  });

  it("uses the minimum tick spread on cheap options and never bids below one tick", () => {
    const farOtm: OptionContract = { ...atmCall, strike: 24500, tradingSymbol: "X" };
    const q = syntheticQuote(farOtm, { t, spot: 22603.05, vix: 13.65 }, cal, cfg);
    expect(q.bid).toBe(0.05);
    expect(q.ask).toBe(0.1);
    expect(q.ltp).toBe(0.05);
    expect(q.depth?.buy.length).toBe(1);
    expect(q.depth?.sell.length).toBe(5);
    // A missing VIX prices at intrinsic: an ITM call is still quoted around intrinsic.
    const itm = syntheticQuote({ ...atmCall, strike: 22000 }, { t, spot: 22603.05, vix: 0 }, cal, cfg);
    expect(itm.ltp).toBeCloseTo(603.05, 9);
    expect(itm.iv).toBe(0);
  });

  it("honours a wider spread model", () => {
    const wide = makeConfig({ pricing: { spreadModel: { minTicks: 4, pctOfPremium: 0.4 } } });
    const q = syntheticQuote({ ...atmCall, strike: 24000 }, { t, spot: 22603.05, vix: 13.65 }, cal, wide);
    expect(q.ask - q.bid).toBeCloseTo(0.2, 9);
  });

  it("is exposed through the OptionQuoteSource port", async () => {
    const src = new SyntheticOptionQuotes(cal, cfg);
    expect(src.kind).toBe("synthetic");
    const q = await src.quote(atmCall, { t, spot: 22603.05, vix: 13.65 });
    expect(q).toEqual(syntheticQuote(atmCall, { t, spot: 22603.05, vix: 13.65 }, cal, cfg));
  });
});

describe("calibrated implied vol (pricing.ivSource)", () => {
  const calibrated = makeConfig({ pricing: { ivSource: "calibrated" } });
  // 2026-10-07 11:00 to the 2026-10-13 expiry: 4 whole sessions left after today (8, 9, 12, 13 Oct).
  const tYears = yearsToExpiry(t, "2026-10-13", cal, cfg);
  const atTheForward = (spot: number, years: number) => spot * Math.exp(0.065 * years);

  it("defaults to the India VIX source and ignores the contract context", () => {
    expect(DEFAULT_CONFIG.pricing.ivSource).toBe("vix");
    expect(syntheticVol("NIFTY", 14, cfg, { spot: 22603.05, strike: 22000, tYears })).toBeCloseTo(0.14, 12);
    expect(syntheticVol("SENSEX", 14, cfg, { spot: 73000, strike: 74000, tYears })).toBeCloseTo(0.147, 12);
  });

  it("uses the per-index multiplier for the sessions left to expiry at the money", () => {
    expect(syntheticVol("NIFTY", 14, calibrated, { spot: 22600, strike: atTheForward(22600, tYears), tYears })).toBeCloseTo(0.14 * 0.908, 9);
    // One session left after today, and beyond the table (8 sessions) the last entry.
    expect(syntheticVol("SENSEX", 14, calibrated, { spot: 73000, strike: atTheForward(73000, 1.6 / 252), tYears: 1.6 / 252 })).toBeCloseTo(0.14 * 0.908, 9);
    expect(syntheticVol("SENSEX", 14, calibrated, { spot: 73000, strike: atTheForward(73000, 8.5 / 252), tYears: 8.5 / 252 })).toBeCloseTo(0.14 * 0.926, 9);
    // Without a contract: the 3-session multiplier.
    expect(syntheticVol("NIFTY", 14, calibrated)).toBeCloseTo(0.14 * 0.895, 12);
    expect(syntheticVol("NIFTY", 0, calibrated)).toBe(0);
  });

  it("adds the smile: OTM puts dearer than ATM, near OTM calls cheaper", () => {
    const atm = syntheticVol("NIFTY", 14, calibrated, { spot: 22600, strike: 22600, tYears });
    expect(syntheticVol("NIFTY", 14, calibrated, { spot: 22600, strike: 22200, tYears })).toBeGreaterThan(atm);
    expect(syntheticVol("NIFTY", 14, calibrated, { spot: 22600, strike: 22800, tYears })).toBeLessThan(atm);
  });

  it("makes ATM weekly quotes cheaper than the default model, as real premiums are", () => {
    const ctx = { t, spot: 22603.05, vix: 13.65 };
    const real = syntheticQuote(atmCall, ctx, cal, calibrated);
    const dflt = syntheticQuote(atmCall, ctx, cal, cfg);
    expect(real.ask).toBeLessThan(dflt.ask);
    expect(real.iv).toBeCloseTo(syntheticVol("NIFTY", 13.65, calibrated, { spot: 22603.05, strike: 22600, tYears }) * 100, 9);
    expect(dflt).toEqual(syntheticQuote(atmCall, ctx, cal, makeConfig({ pricing: { ivSource: "vix" } })));
  });

  it("rejects an unknown source", () => {
    expect(() => makeConfig({ pricing: { ivSource: "groww" as "vix" } })).toThrow(/ivSource/);
  });
});
