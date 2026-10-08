import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { roundTripChargesPerUnit } from "../broker/charges";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, withOverrides } from "../config";
import { SyntheticOptionQuotes, syntheticQuote } from "../pricing/syntheticOptionPricer";
import { InMemoryRepository } from "../repo/memory";
import { loadRiskState, newLedger } from "../pipeline/riskState";
import { defaultSettings } from "../settings";
import { syntheticInstruments } from "../testing/replayHarness";
import type { OptionContract, Quote } from "../types";
import { choosePremiumBandContract, strikeLadder, type PremiumBandArgs } from "./optionSelect";
import { sizePosition } from "./sizing";

const cfg = accountConfig(DEFAULT_CONFIG, "small10k");
const T = istAt("2026-10-08", "11:00");
const SPOT = 22_280;
const VIX = 15;
const instruments = syntheticInstruments(cfg, defaultCalendar, "2026-10-08", "2026-10-08", { NIFTY: SPOT });

function args(over: Partial<PremiumBandArgs> = {}): PremiumBandArgs & { calls: string[] } {
  const calls: string[] = [];
  const quotes = new SyntheticOptionQuotes(defaultCalendar, cfg);
  return {
    index: "NIFTY",
    spot: SPOT,
    vix: VIX,
    side: "BEAR",
    t: T,
    instruments,
    optionQuotes: {
      kind: "synthetic",
      quote: async (c: OptionContract, ctx: { t: number; spot: number; vix: number }) => {
        calls.push(`${c.strike}${c.type}`);
        return quotes.quote(c, ctx);
      },
    },
    calendar: defaultCalendar,
    cfg,
    quoteOk: () => true,
    affordable: () => true,
    calls,
    ...over,
  };
}

const ask = (c: OptionContract): number => syntheticQuote(c, { t: T, spot: SPOT, vix: VIX }, defaultCalendar, cfg).ask;

describe("strikeLadder", () => {
  const listed = [22100, 22150, 22200, 22250, 22300, 22350, 22400];
  it("walks puts downward and calls upward from ATM", () => {
    expect(strikeLadder(listed, 22300, "BEAR", 3, 50)).toEqual([22300, 22250, 22200, 22150]);
    expect(strikeLadder(listed, 22300, "BULL", 3, 50)).toEqual([22300, 22350, 22400]);
  });
  it("generates the grid when no strikes are listed", () => {
    expect(strikeLadder([], 22300, "BEAR", 2, 50)).toEqual([22300, 22250, 22200]);
    expect(strikeLadder([], 22300, "BULL", 2, 50)).toEqual([22300, 22350, 22400]);
  });
});

describe("choosePremiumBandContract", () => {
  it("picks the put nearest the money with an ask in the band", async () => {
    const a = args();
    const pick = await choosePremiumBandContract(a);
    expect(pick.gate.passed).toBe(true);
    expect(pick.contract!.type).toBe("PE");
    expect(pick.contract!.strike).toBeLessThan(SPOT);
    expect(pick.quote!.ask).toBeGreaterThanOrEqual(40);
    expect(pick.quote!.ask).toBeLessThanOrEqual(70);
    // The next strike toward the money costs more than the band allows.
    const nearer = await instruments.resolve("NIFTY", pick.contract!.expiry, pick.contract!.strike + 50, "PE");
    expect(ask(nearer!)).toBeGreaterThan(70);
    expect(a.calls.length).toBeLessThanOrEqual(cfg.selection.maxQuotes);
  });

  it("picks a call above the money for a bullish view", async () => {
    const pick = await choosePremiumBandContract(args({ side: "BULL" }));
    expect(pick.contract!.type).toBe("CE");
    expect(pick.contract!.strike).toBeGreaterThan(SPOT);
    expect(pick.quote!.ask).toBeLessThanOrEqual(70);
  });

  it("walks further out of the money when one lot does not fit the limits", async () => {
    const first = await choosePremiumBandContract(args());
    const pick = await choosePremiumBandContract(args({ affordable: (premium) => premium <= first.quote!.ask - 5 }));
    expect(pick.gate.passed).toBe(true);
    expect(pick.contract!.strike).toBeLessThan(first.contract!.strike);
  });

  it("skips strikes without a usable quote", async () => {
    const first = await choosePremiumBandContract(args());
    const pick = await choosePremiumBandContract(args({ quoteOk: (_q: Quote, c: OptionContract) => c.strike !== first.contract!.strike }));
    expect(pick.contract!.strike).not.toBe(first.contract!.strike);
  });

  it("fails with a display contract when nothing fits", async () => {
    const pick = await choosePremiumBandContract(args({ affordable: () => false }));
    expect(pick.gate.passed).toBe(false);
    expect(pick.quote).toBeNull();
    expect(pick.contract).not.toBeNull();
    expect(pick.gate.detail).toMatch(/too large for the limits/);
  });

  it("stops at the quote budget", async () => {
    const a = args({ affordable: () => false });
    await choosePremiumBandContract(a);
    expect(a.calls.length).toBeLessThanOrEqual(cfg.selection.maxQuotes);
  });
});

describe("small-account sizing", () => {
  const settings = defaultSettings(cfg, T);
  const contract = { index: "NIFTY", exchange: "NSE", tradingSymbol: "X", growwSymbol: "X", exchangeToken: "1", expiry: "2026-10-13", strike: 22050, type: "PE", lotSize: 65, tickSize: 0.05 } as OptionContract;
  const base = { contract, perf: undefined, sizeMult: 1, capitalRupees: 10_000, openPremiumRupees: 0, settings };

  it("sizes one lot at ₹40 and ₹70 with the ₹10k settings", () => {
    expect(sizePosition({ ...base, premium: 40 }, cfg).lots).toBe(1);
    expect(sizePosition({ ...base, premium: 70 }, cfg).lots).toBe(1);
  });

  it("caps by free cash, keeping a reserve for charges", () => {
    // One lot is 60 x 65 = ₹3,900 of premium plus ₹70 of charges.
    const r = sizePosition({ ...base, premium: 60, cashRupees: 3_970, chargeReservePerLot: 70 }, cfg);
    expect(r.lots).toBe(1);
    const short = sizePosition({ ...base, premium: 60, cashRupees: 3_969, chargeReservePerLot: 70 }, cfg);
    expect(short.lots).toBe(0);
    expect(short.limitedBy).toBe("cash available");
  });

  it("halves the budget in high volatility, so a ₹60 lot no longer fits but a ₹40 one does", () => {
    expect(sizePosition({ ...base, premium: 60, sizeMult: 0.5 }, cfg).lots).toBe(0);
    expect(sizePosition({ ...base, premium: 40, sizeMult: 0.5 }, cfg).lots).toBe(1);
  });
});

describe("₹5k account sizing", () => {
  const cfg5 = accountConfig(DEFAULT_CONFIG, "small5k");
  const settings = defaultSettings(cfg5, T);
  const nifty = { index: "NIFTY", exchange: "NSE", tradingSymbol: "N", growwSymbol: "N", exchangeToken: "1", expiry: "2026-10-13", strike: 25100, type: "PE", lotSize: 65, tickSize: 0.05 } as OptionContract;
  const sensex = { index: "SENSEX", exchange: "BSE", tradingSymbol: "S", growwSymbol: "S", exchangeToken: "2", expiry: "2026-10-15", strike: 81500, type: "PE", lotSize: 20, tickSize: 0.05 } as OptionContract;
  const reserve = (premium: number, c: OptionContract) => roundTripChargesPerUnit(premium, c.lotSize, c.exchange, "2026-10-08") * c.lotSize;
  const size = (premium: number, c: OptionContract, over: Partial<Parameters<typeof sizePosition>[0]> = {}) =>
    sizePosition({ premium, contract: c, perf: undefined, sizeMult: 1, capitalRupees: 5_000, openPremiumRupees: 0, settings, cashRupees: 5_000, chargeReservePerLot: reserve(premium, c), ...over }, cfg5);

  it("lets exactly one lot through across the NIFTY band and the affordable part of the SENSEX band", () => {
    for (const p of [40, 50, 60]) expect(size(p, nifty)).toMatchObject({ lots: 1, qty: 65 });
    for (const p of [130, 170, 206, 214]) expect(size(p, sensex)).toMatchObject({ lots: 1, qty: 20 });
  });

  it("never buys a second lot, even with spare equity and cash", () => {
    const rich = { capitalRupees: 50_000, cashRupees: 50_000, settings: defaultSettings(withOverrides(cfg5, { capitalRupees: 50_000 }), T) };
    expect(size(40, nifty, rich)).toMatchObject({ lots: 1, qty: 65 });
    expect(size(130, sensex, rich)).toMatchObject({ lots: 1, qty: 20 });
  });

  it("caps by free cash including the round-trip charges", () => {
    // ₹50 x 65 = ₹3,250 plus about ₹55 of charges.
    const need = 3_250 + reserve(50, nifty);
    expect(size(50, nifty, { cashRupees: Math.ceil(need) }).lots).toBe(1);
    const short = size(50, nifty, { cashRupees: Math.floor(need) });
    expect(short.lots).toBe(0);
    expect(short.limitedBy).toBe("cash available");
    // The top of the band needs ₹3,900 plus charges.
    expect(size(60, nifty, { cashRupees: Math.floor(3_900 + reserve(60, nifty)) }).lots).toBe(0);
    expect(size(60, nifty, { cashRupees: Math.ceil(3_900 + reserve(60, nifty)) }).lots).toBe(1);
  });

  it("scales the caps with the day's starting equity", () => {
    // At ₹4,000 a stop-out may cost at most 30% (₹1,200): 35% of ₹52 x 65 is ₹1,183, of ₹53 x 65 ₹1,206.
    const poorer = { capitalRupees: 4_000, cashRupees: 4_000 };
    expect(size(52, nifty, poorer).lots).toBe(1);
    expect(size(53, nifty, poorer).lots).toBe(0);
    expect(size(60, nifty, poorer).lots).toBe(0);
    // The premium of one lot is capped at 90% of equity as well (₹4,500 at ₹5,000).
    expect(cfg5.sizing.maxPremiumPctPerTrade).toBe(90);
    expect(settings.maxPremiumPerTradeInr).toBe(4_500);
  });

  it("refuses a lot whose stop-out alone would cost more than ₹1,500", () => {
    // 35% of ₹215 x 20 = ₹1,505 is over the 30% hard cap; ₹214 (₹1,498) is the last that fits.
    expect(size(215, sensex).lots).toBe(0);
    expect(size(222, sensex).lots).toBe(0);
    expect(size(214, sensex).riskRupees).toBeLessThanOrEqual(1_500);
  });

  it("sits out half-size signals unless the lot is at the cheap end of the band", () => {
    expect(size(60, nifty, { sizeMult: 0.5 }).lots).toBe(0);
    expect(size(41, nifty, { sizeMult: 0.5 }).lots).toBe(1);
  });
});

describe("loadRiskState with current equity", () => {
  it("sizes from yesterday's ending equity and today's free cash only when the flag is on", async () => {
    const repo = new InMemoryRepository(cfg, T);
    const y = newLedger("2026-10-07", "PAPER", 10_000, T);
    y.realized = -2_000;
    y.charges = 100;
    await repo.ledger.save(y);
    const r = await loadRiskState(repo, cfg, await repo.settings.get(), T, "PAPER");
    expect(r.capitalRupees).toBe(7_900);
    expect(r.cashRupees).toBe(7_900);

    const main = await loadRiskState(repo, DEFAULT_CONFIG, await repo.settings.get(), T, "PAPER");
    expect(main.capitalRupees).toBe(DEFAULT_CONFIG.capitalRupees);
    expect(main.cashRupees).toBeUndefined();
  });
});
