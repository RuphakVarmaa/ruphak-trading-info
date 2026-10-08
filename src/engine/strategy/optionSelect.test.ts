import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
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
