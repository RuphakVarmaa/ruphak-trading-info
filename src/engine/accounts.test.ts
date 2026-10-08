import { describe, expect, it } from "vitest";
import { accountConfig, accountSpec, accountStateKey, bookAccount, bookMode, parseAccountId, parseAccounts, unbookMode } from "./accounts";
import { roundTripChargesPerUnit } from "./broker/charges";
import { DEFAULT_CONFIG, makeConfig, maxOpenTotal, premiumBand } from "./config";
import { defaultSettings } from "./settings";

describe("accountConfig", () => {
  it("returns the Worker config unchanged for main", () => {
    const base = makeConfig({ capitalRupees: 500_000 });
    expect(accountConfig(base, "main")).toBe(base);
  });

  it("pins the ₹10k account's values even when the Worker config differs", () => {
    const base = makeConfig({ indices: ["NIFTY"], sizing: { maxOpenPerIndex: 2, maxTradesPerDay: 8 } });
    const cfg = accountConfig(base, "small10k");
    expect(cfg.capitalRupees).toBe(10_000);
    expect(cfg.indices).toEqual(["NIFTY", "SENSEX"]);
    expect(cfg.sizing.maxOpenPerIndex).toBe(1);
    expect(maxOpenTotal(cfg)).toBe(1);
    expect(cfg.sizing.maxTradesPerDay).toBe(3);
    expect(cfg.sizing.maxLots).toBe(1);
    expect(cfg.sizing.useCurrentEquity).toBe(true);
    expect(cfg.selection.mode).toBe("PREMIUM_BAND");
    expect(cfg.risk.prospectiveLossCap).toBe(true);
    expect(cfg.exits.stopPct).toBe(-35);
    // Untouched groups keep the Worker config's values.
    expect(cfg.conviction).toEqual(base.conviction);
  });

  it("buys about the same rupees per lot on NIFTY and SENSEX", () => {
    const cfg = accountConfig(DEFAULT_CONFIG, "small10k");
    const nifty = premiumBand(cfg, "NIFTY");
    const sensex = premiumBand(cfg, "SENSEX");
    expect(nifty).toEqual({ minPremium: 40, maxPremium: 70, maxOtmSteps: 8 });
    expect(sensex).toEqual({ minPremium: 130, maxPremium: 210, maxOtmSteps: 20 });
    const lot = (b: { minPremium: number; maxPremium: number }, i: "NIFTY" | "SENSEX") => [b.minPremium * cfg.indexSpecs[i].lotSize, b.maxPremium * cfg.indexSpecs[i].lotSize];
    expect(lot(sensex, "SENSEX")[0]).toBe(lot(nifty, "NIFTY")[0]);
    expect(lot(sensex, "SENSEX")[1]).toBeLessThanOrEqual(lot(nifty, "NIFTY")[1]);
    // Main has no per-index band: both indices use the shared one.
    expect(premiumBand(DEFAULT_CONFIG, "SENSEX")).toEqual(premiumBand(DEFAULT_CONFIG, "NIFTY"));
  });

  it("pins the ₹5k account's values even when the Worker config differs", () => {
    const base = makeConfig({ capitalRupees: 900_000, indices: ["NIFTY"], sizing: { maxOpenPerIndex: 2, maxOpenTotal: 2, maxTradesPerDay: 8 } });
    const cfg = accountConfig(base, "small5k");
    expect(cfg.capitalRupees).toBe(5_000);
    expect(cfg.indices).toEqual(["NIFTY", "SENSEX"]);
    expect(cfg.sizing.maxLots).toBe(1);
    expect(cfg.sizing.maxOpenPerIndex).toBe(1);
    expect(maxOpenTotal(cfg)).toBe(1);
    expect(cfg.sizing.maxTradesPerDay).toBe(2);
    expect(cfg.sizing.useCurrentEquity).toBe(true);
    expect(cfg.selection.mode).toBe("PREMIUM_BAND");
    expect(cfg.risk.maxConsecutiveLossesPerDay).toBe(1);
    expect(cfg.risk.prospectiveLossCap).toBe(true);
    expect(cfg.exits.stopPct).toBe(-35);
    expect(cfg.exits.targetPct).toBe(60);
    // Caps derived from the account config: ₹1,500 a day, one position, the 2-entry day fits the order cap.
    const s = defaultSettings(cfg, 0);
    expect(s.dailyLossCapInr).toBe(1_500);
    expect(s.maxOpenPositions).toBe(1);
    expect(s.maxLotsPerOrder).toBe(1);
    expect(s.maxOrdersPerDay).toBeGreaterThanOrEqual(cfg.sizing.maxTradesPerDay * 2 + 2);
    expect(cfg.conviction).toEqual(base.conviction);
    expect(accountSpec("small5k")).toMatchObject({ label: "₹5k account", shortLabel: "₹5k", paperOnly: true });
  });

  it("sizes the ₹5k bands from the lot sizes and the Groww charge schedule", () => {
    const cfg = accountConfig(DEFAULT_CONFIG, "small5k");
    expect(premiumBand(cfg, "NIFTY")).toEqual({ minPremium: 40, maxPremium: 60, maxOtmSteps: 12 });
    expect(premiumBand(cfg, "SENSEX")).toEqual({ minPremium: 130, maxPremium: 222, maxOtmSteps: 20 });
    // Both ladders reach about 2.4% out of the money.
    const reach = (i: "NIFTY" | "SENSEX", spot: number) => (premiumBand(cfg, i).maxOtmSteps * cfg.indexSpecs[i].strikeStep) / spot;
    expect(reach("NIFTY", 25_000)).toBeCloseTo(reach("SENSEX", 82_000), 2);
    const lot = (i: "NIFTY" | "SENSEX") => cfg.indexSpecs[i].lotSize;
    // One lot plus buying and selling it at the same premium, at the charges in force today.
    const withCharges = (premium: number, i: "NIFTY" | "SENSEX") => premium * lot(i) + roundTripChargesPerUnit(premium, lot(i), cfg.indexSpecs[i].exchange, "2026-10-08") * lot(i);
    expect(premiumBand(cfg, "NIFTY").maxPremium * lot("NIFTY")).toBe(3_900);
    expect(withCharges(222, "SENSEX")).toBeLessThanOrEqual(4_500);
    expect(withCharges(223, "SENSEX")).toBeGreaterThan(4_500);
    // Two ticks over the band (the marketable limit) still fits.
    expect(withCharges(222.1, "SENSEX")).toBeLessThanOrEqual(4_500);
    // The cheapest lot costs the same ₹2,600 on both indices.
    expect(premiumBand(cfg, "SENSEX").minPremium * lot("SENSEX")).toBe(premiumBand(cfg, "NIFTY").minPremium * lot("NIFTY"));
  });

  it("caps open positions per index times indices unless a total is set", () => {
    expect(maxOpenTotal(makeConfig({ indices: ["NIFTY", "SENSEX"], sizing: { maxOpenPerIndex: 2 } }))).toBe(4);
    expect(maxOpenTotal(makeConfig({ indices: ["NIFTY", "SENSEX"], sizing: { maxOpenPerIndex: 2, maxOpenTotal: 2 } }))).toBe(2);
    expect(() => makeConfig({ sizing: { maxOpenTotal: 0 } })).toThrow(/maxOpenTotal/);
  });

  it("keeps the new flags off by default", () => {
    expect(DEFAULT_CONFIG.selection.mode).toBe("ATM");
    expect(DEFAULT_CONFIG.sizing.useCurrentEquity).toBe(false);
    expect(DEFAULT_CONFIG.risk.prospectiveLossCap).toBe(false);
  });

  it("rejects a premium band that is empty or inverted", () => {
    expect(() => makeConfig({ selection: { minPremium: 80, maxPremium: 70 } })).toThrow(/selection.minPremium/);
    expect(() => makeConfig({ selection: { maxOtmSteps: 25 } })).toThrow(/maxOtmSteps/);
    expect(() => makeConfig({ selection: { byIndex: { SENSEX: { minPremium: 200, maxPremium: 150 } } } })).toThrow(/selection.byIndex.SENSEX.minPremium/);
  });
});

describe("account ids and book modes", () => {
  it("parses account ids", () => {
    expect(parseAccountId(undefined)).toBe("main");
    expect(parseAccountId(" ")).toBe("main");
    expect(parseAccountId("small10k")).toBe("small10k");
    expect(parseAccountId("small5k")).toBe("small5k");
    expect(parseAccountId("other")).toBeNull();
    expect(parseAccountId("SMALL5K")).toBeNull();
  });

  it("parses the enabled list with main always first", () => {
    expect(parseAccounts(undefined)).toEqual(["main"]);
    expect(parseAccounts("small10k")).toEqual(["main", "small10k"]);
    expect(parseAccounts("small10k, main ,small10k,bogus")).toEqual(["main", "small10k"]);
    // The production and preview value in workers/engine/wrangler.jsonc.
    expect(parseAccounts("main,small10k,small5k")).toEqual(["main", "small10k", "small5k"]);
    expect(parseAccounts("small5k,small10k")).toEqual(["main", "small5k", "small10k"]);
  });

  it("maps modes to stored book modes and back", () => {
    expect(bookMode("main", "PAPER")).toBe("PAPER");
    expect(bookMode("small10k", "PAPER")).toBe("PAPER@small10k");
    expect(unbookMode("PAPER@small10k")).toBe("PAPER");
    expect(unbookMode("LIVE")).toBe("LIVE");
    expect(bookAccount("PAPER@small10k")).toBe("small10k");
    expect(bookAccount("PAPER")).toBe("main");
    expect(bookMode("small5k", "PAPER")).toBe("PAPER@small5k");
    expect(bookAccount("PAPER@small5k")).toBe("small5k");
    expect(unbookMode("PAPER@small5k")).toBe("PAPER");
  });

  it("prefixes state keys for accounts other than main", () => {
    expect(accountStateKey("main", "decision:last:NIFTY")).toBe("decision:last:NIFTY");
    expect(accountStateKey("small10k", "decision:last:NIFTY")).toBe("acct:small10k:decision:last:NIFTY");
    expect(accountStateKey("small5k", "settings")).toBe("acct:small5k:settings");
  });
});
