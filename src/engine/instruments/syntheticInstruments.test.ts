import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import type { IndexId } from "../types";
import { readInstrumentFixtureText } from "../__fixtures__/market/loadFixtures";
import { InstrumentMaster, isIndexOptionRow, parseInstrumentCsv } from "./instrumentMaster";
import { isMonthlyExpiry, optionGrowwSymbol, optionTradingSymbol, syntheticInstrumentRows } from "./syntheticInstruments";

const cfg = DEFAULT_CONFIG;

function regenerate(index: IndexId, expiry: string, strike: number, type: "CE" | "PE") {
  const spec = cfg.indexSpecs[index];
  return {
    tradingSymbol: optionTradingSymbol(spec.underlying, expiry, strike, type, isMonthlyExpiry(index, expiry, cfg)),
    growwSymbol: optionGrowwSymbol(spec.exchange, spec.underlying, expiry, strike, type),
  };
}

describe("Groww symbol formats", () => {
  it("matches the sampled live rows", () => {
    expect(regenerate("NIFTY", "2026-10-13", 19250, "CE")).toEqual({
      tradingSymbol: "NIFTY26O1319250CE",
      growwSymbol: "NSE-NIFTY-13Oct26-19250-CE",
    });
    expect(regenerate("SENSEX", "2026-10-15", 66600, "CE")).toEqual({
      tradingSymbol: "SENSEX26O1566600CE",
      growwSymbol: "BSE-SENSEX-15Oct26-66600-CE",
    });
  });

  it("reproduces every option symbol in the recorded fixture", () => {
    const options = parseInstrumentCsv(readInstrumentFixtureText()).filter((r) => isIndexOptionRow(r));
    expect(options.length).toBe(42);
    for (const r of options) {
      const index = r.underlyingSymbol as IndexId;
      expect(regenerate(index, r.expiryDate, r.strikePrice, r.instrumentType as "CE" | "PE")).toEqual({
        tradingSymbol: r.tradingSymbol,
        growwSymbol: r.growwSymbol,
      });
    }
  });

  it("matches more symbols seen in the live file (holiday-shifted, monthly, quarterly)", () => {
    const seen: [IndexId, string, number, "CE" | "PE", string, string][] = [
      ["NIFTY", "2026-11-03", 17700, "CE", "NIFTY26N0317700CE", "NSE-NIFTY-03Nov26-17700-CE"],
      ["NIFTY", "2026-11-09", 18150, "CE", "NIFTY26N0918150CE", "NSE-NIFTY-09Nov26-18150-CE"], // Mon, Tue holiday
      ["NIFTY", "2026-11-23", 17900, "PE", "NIFTY26NOV17900PE", "NSE-NIFTY-23Nov26-17900-PE"], // monthly, moved to Mon
      ["NIFTY", "2026-12-29", 13500, "PE", "NIFTY26DEC13500PE", "NSE-NIFTY-29Dec26-13500-PE"],
      ["NIFTY", "2027-03-30", 30000, "PE", "NIFTY27MAR30000PE", "NSE-NIFTY-30Mar27-30000-PE"],
      ["NIFTY", "2029-12-24", 6000, "CE", "NIFTY29DEC6000CE", "NSE-NIFTY-24Dec29-6000-CE"], // Christmas-shifted
      ["SENSEX", "2026-11-05", 65500, "CE", "SENSEX26N0565500CE", "BSE-SENSEX-05Nov26-65500-CE"],
      ["SENSEX", "2026-11-26", 67400, "CE", "SENSEX26NOV67400CE", "BSE-SENSEX-26Nov26-67400-CE"],
      ["SENSEX", "2026-12-31", 66500, "CE", "SENSEX26DEC66500CE", "BSE-SENSEX-31Dec26-66500-CE"],
    ];
    for (const [index, expiry, strike, type, ts, gs] of seen) {
      expect(regenerate(index, expiry, strike, type)).toEqual({ tradingSymbol: ts, growwSymbol: gs });
    }
  });

  it("detects monthly expiries by the nominal weekday", () => {
    expect(isMonthlyExpiry("NIFTY", "2026-10-27", cfg)).toBe(true);
    expect(isMonthlyExpiry("NIFTY", "2026-10-19", cfg)).toBe(false);
    expect(isMonthlyExpiry("NIFTY", "2026-11-23", cfg)).toBe(true);
    expect(isMonthlyExpiry("SENSEX", "2026-10-29", cfg)).toBe(true);
    expect(isMonthlyExpiry("SENSEX", "2026-10-22", cfg)).toBe(false);
  });
});

describe("syntheticInstrumentRows", () => {
  it("fabricates CE/PE rows around the ATM strike for past expiries", async () => {
    const rows = syntheticInstrumentRows("NIFTY", ["2026-09-29", "2026-10-06"], 22603, 2, cfg);
    expect(rows.length).toBe(2 * 5 * 2);
    expect([...new Set(rows.map((r) => r.strikePrice))]).toEqual([22500, 22550, 22600, 22650, 22700]);
    const sep = rows.find((r) => r.expiryDate === "2026-09-29" && r.strikePrice === 22600 && r.instrumentType === "CE")!;
    expect(sep).toMatchObject({
      exchange: "NSE",
      tradingSymbol: "NIFTY26SEP22600CE", // last Tuesday of September: monthly format
      growwSymbol: "NSE-NIFTY-29Sep26-22600-CE",
      segment: "FNO",
      underlyingSymbol: "NIFTY",
      lotSize: 65,
      tickSize: 0.05,
      freezeQuantity: 3511,
      buyAllowed: true,
      sellAllowed: true,
    });
    expect(sep.exchangeToken.startsWith("SYN-")).toBe(true);
    const oct = rows.find((r) => r.expiryDate === "2026-10-06" && r.strikePrice === 22700 && r.instrumentType === "PE")!;
    expect(oct.tradingSymbol).toBe("NIFTY26O0622700PE");
    expect(rows.every((r) => isIndexOptionRow(r))).toBe(true);

    const master = new InstrumentMaster(rows, cfg);
    expect(await master.expiries("NIFTY")).toEqual(["2026-09-29", "2026-10-06"]);
    expect((await master.resolve("NIFTY", "2026-10-06", 22600, "PE"))?.growwSymbol).toBe("NSE-NIFTY-06Oct26-22600-PE");
  });

  it("uses SENSEX's step, exchange and lot size", () => {
    const rows = syntheticInstrumentRows("SENSEX", ["2026-10-01"], 72638.7, 1, cfg);
    expect(rows.map((r) => r.tradingSymbol)).toEqual([
      "SENSEX26O0172500CE",
      "SENSEX26O0172500PE",
      "SENSEX26O0172600CE",
      "SENSEX26O0172600PE",
      "SENSEX26O0172700CE",
      "SENSEX26O0172700PE",
    ]);
    expect(rows.every((r) => r.exchange === "BSE" && r.lotSize === 20 && r.freezeQuantity === 1001)).toBe(true);
    expect(syntheticInstrumentRows("SENSEX", [], 72600, 3, cfg)).toEqual([]);
  });
});
