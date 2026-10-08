import { describe, expect, it } from "vitest";
import { accountConfig, accountStateKey, bookAccount, bookMode, parseAccountId, parseAccounts, unbookMode } from "./accounts";
import { DEFAULT_CONFIG, makeConfig, maxOpenTotal, premiumBand } from "./config";

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
    expect(parseAccountId("other")).toBeNull();
  });

  it("parses the enabled list with main always first", () => {
    expect(parseAccounts(undefined)).toEqual(["main"]);
    expect(parseAccounts("small10k")).toEqual(["main", "small10k"]);
    expect(parseAccounts("small10k, main ,small10k,bogus")).toEqual(["main", "small10k"]);
  });

  it("maps modes to stored book modes and back", () => {
    expect(bookMode("main", "PAPER")).toBe("PAPER");
    expect(bookMode("small10k", "PAPER")).toBe("PAPER@small10k");
    expect(unbookMode("PAPER@small10k")).toBe("PAPER");
    expect(unbookMode("LIVE")).toBe("LIVE");
    expect(bookAccount("PAPER@small10k")).toBe("small10k");
    expect(bookAccount("PAPER")).toBe("main");
  });

  it("prefixes state keys for accounts other than main", () => {
    expect(accountStateKey("main", "decision:last:NIFTY")).toBe("decision:last:NIFTY");
    expect(accountStateKey("small10k", "decision:last:NIFTY")).toBe("acct:small10k:decision:last:NIFTY");
  });
});
