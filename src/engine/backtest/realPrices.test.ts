import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  bhavcopyCsvFromZip,
  bhavcopyUrl,
  cachePath,
  dayRangeCheck,
  detectBhavFormat,
  gunzip,
  inferHolidays,
  loadRealPriceBook,
  nearestStrike,
  parityForward,
  parseBse,
  parseCompactCsv,
  parseExchangeDate,
  parseNseLegacy,
  parseNseUdiff,
  parseOptionSymbol,
  RealPriceBook,
  resolveOptionRow,
  settledClose,
  shortSessions,
  toCompactCsv,
  type BhavRow,
} from "./realPrices";

const FIX = resolve(import.meta.dirname, "../__fixtures__/bhavcopy");
const text = (name: string) => readFileSync(resolve(FIX, name), "utf8");

function row(p: Partial<BhavRow>): BhavRow {
  return {
    date: "2024-01-08",
    exchange: "NSE",
    symbol: "NIFTY",
    kind: "OPT",
    expiry: "2024-01-11",
    strike: 21500,
    type: "CE",
    open: 100,
    high: 120,
    low: 80,
    close: 110,
    last: null,
    settle: null,
    prevClose: null,
    underlying: null,
    contracts: 10,
    oi: null,
    lot: 50,
    vwap: 100,
    flags: "",
    ...p,
  };
}

describe("bhavcopy URLs and cache paths", () => {
  it("uses UDiFF from 2024-01-08, the legacy archive before, and BSE's dd-mm-yy name", () => {
    expect(bhavcopyUrl("NSE", "2024-01-08")).toMatchObject({
      format: "nse-udiff",
      url: "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20240108_F_0000.csv.zip",
    });
    expect(bhavcopyUrl("NSE", "2024-01-05")).toMatchObject({
      format: "nse-legacy",
      url: "https://nsearchives.nseindia.com/content/historical/DERIVATIVES/2024/JAN/fo05JAN2024bhav.csv.zip",
    });
    const bse = bhavcopyUrl("BSE", "2026-10-07");
    expect(bse.url).toBe("https://www.bseindia.com/download/Bhavcopy/Derivative/bhavcopy07-10-26.zip");
    expect(bse.headers.Referer).toBe("https://www.bseindia.com/");
    expect(cachePath("BSE", "2026-10-07")).toBe("bse/2026/20261007.csv.gz");
  });

  it("parses the exchanges' date spellings", () => {
    expect(parseExchangeDate("11-Jan-2024")).toBe("2024-01-11");
    expect(parseExchangeDate("05-JAN-2024")).toBe("2024-01-05");
    expect(parseExchangeDate("08 Oct 2026")).toBe("2026-10-08");
    expect(parseExchangeDate("2024-01-11")).toBe("2024-01-11");
    expect(parseExchangeDate("31/12/2024")).toBeNull();
  });
});

describe("NSE UDiFF parser", () => {
  const rows = parseNseUdiff(text("nse-udiff-20240108.csv"));

  it("keeps NIFTY and BANKNIFTY index options and futures only", () => {
    expect(rows.map((r) => r.symbol).sort()).toEqual(["BANKNIFTY", "NIFTY", "NIFTY", "NIFTY", "NIFTY", "NIFTY"]);
    expect(rows.filter((r) => r.kind === "FUT")).toHaveLength(1);
  });

  it("reads prices, lot size, the underlying close and a VWAP inside the day's range", () => {
    const c = rows.find((r) => r.strike === 21600 && r.type === "CE")!;
    expect(c).toMatchObject({ date: "2024-01-08", expiry: "2024-01-11", open: 187.7, high: 203.4, low: 62.05, close: 69.25, last: 64.8, prevClose: 193.85, underlying: 21513, lot: 50, contracts: 2885421 });
    // Turnover is reported on strike + premium: 3,131,282,742,777.50 / (2,885,421 x 50) - 21,600.
    expect(c.vwap).toBeCloseTo(104.1655, 3);
    expect(c.vwap!).toBeGreaterThan(c.low!);
    expect(c.vwap!).toBeLessThan(c.high!);
    // The closing price is not the last trade.
    expect(c.close).not.toBe(c.last);
    const fut = rows.find((r) => r.kind === "FUT")!;
    expect(fut).toMatchObject({ strike: 0, type: null, expiry: "2024-01-25", close: 21579.55 });
    expect(fut.vwap!).toBeGreaterThan(fut.low!);
  });

  it("detects the format from the header", () => {
    expect(detectBhavFormat("NSE", text("nse-udiff-20240108.csv"))).toBe("nse-udiff");
    expect(detectBhavFormat("NSE", text("nse-legacy-20240105.csv"))).toBe("nse-legacy");
    expect(detectBhavFormat("BSE", "anything")).toBe("bse");
    expect(() => detectBhavFormat("NSE", "<!DOCTYPE html>")).toThrow(/unrecognised/);
  });
});

describe("NSE legacy parser", () => {
  const rows = parseNseLegacy(text("nse-legacy-20240105.csv"));

  it("derives the lot size and VWAP from turnover and drops stock options", () => {
    expect(rows).toHaveLength(5);
    const c = rows.find((r) => r.strike === 21600 && r.type === "CE")!;
    expect(c).toMatchObject({ date: "2024-01-05", expiry: "2024-01-11", close: 193.85, settle: 193.85, lot: 50, last: null });
    expect(c.vwap!).toBeGreaterThanOrEqual(c.low!);
    expect(c.vwap!).toBeLessThanOrEqual(c.high!);
    expect(rows.find((r) => r.kind === "FUT")!.lot).toBe(50);
  });

  it("agrees with the next UDiFF file's previous close for the same contract", () => {
    const next = parseNseUdiff(text("nse-udiff-20240108.csv"));
    for (const r of rows.filter((x) => x.kind === "OPT")) {
      const n = next.find((x) => x.kind === "OPT" && x.strike === r.strike && x.type === r.type && x.expiry === r.expiry)!;
      expect(n.prevClose).toBe(r.close);
    }
  });
});

describe("BSE parser", () => {
  const rows = parseBse(text("bse-20240105.csv"), "2024-01-05");

  it("keeps SENSEX only and derives lot size and VWAP", () => {
    expect(new Set(rows.map((r) => r.symbol))).toEqual(new Set(["SENSEX"]));
    expect(rows).toHaveLength(6);
    const c = rows.find((r) => r.expiry === "2024-01-12" && r.type === "CE")!;
    expect(c).toMatchObject({ strike: 72000, open: 500, high: 685, low: 368.25, close: 500.75, lot: 10 });
    expect(c.vwap).toBeCloseTo(470.3186, 4);
  });

  it("turns the expiry-day 'Close' (the index settlement level) into the intrinsic value", () => {
    const c = rows.find((r) => r.expiry === "2024-01-05" && r.type === "CE")!;
    const p = rows.find((r) => r.expiry === "2024-01-05" && r.type === "PE")!;
    expect(c).toMatchObject({ settle: 72026.15, flags: "S" });
    expect(c.close).toBeCloseTo(26.15, 6);
    expect(p.close).toBe(0);
    expect(settledClose(c)).toBeCloseTo(26.15, 6);
  });

  it("marks untraded contracts: no open/high/low, stale close kept", () => {
    const u = rows.find((r) => r.expiry === "2024-01-25" && r.kind === "OPT")!;
    expect(u).toMatchObject({ contracts: 0, open: null, high: null, low: null, close: 872.45, vwap: null, lot: 10 });
  });
});

describe("zip, gzip and the compact cache", () => {
  it("unzips a deflated bhavcopy", async () => {
    const csv = await bhavcopyCsvFromZip(new Uint8Array(readFileSync(resolve(FIX, "bse-20240105.zip"))));
    expect(csv).toBe(text("bse-20240105.csv"));
  });

  it("rejects bytes that are not a zip (BSE answers a missing file with its HTML home page)", async () => {
    await expect(bhavcopyCsvFromZip(new TextEncoder().encode("<!DOCTYPE html><html></html>"))).rejects.toThrow(/not a zip/);
  });

  it("round-trips rows through the compact CSV and gzip", async () => {
    const rows = [...parseNseUdiff(text("nse-udiff-20240108.csv")), ...parseBse(text("bse-20240105.csv"), "2024-01-05")];
    const back = parseCompactCsv(new TextDecoder().decode(await gunzip(new Uint8Array(gzipSync(toCompactCsv(rows))))));
    expect(back).toEqual(rows);
  });

  it("loads a book from cached extracts through a reader", async () => {
    const files: Record<string, Uint8Array> = {
      "nse/2024/20240108.csv.gz": new Uint8Array(gzipSync(toCompactCsv(parseNseUdiff(text("nse-udiff-20240108.csv"))))),
      "bse/2024/20240105.csv.gz": new Uint8Array(gzipSync(toCompactCsv(parseBse(text("bse-20240105.csv"), "2024-01-05")))),
    };
    const { book, loaded } = await loadRealPriceBook({ read: async (p) => files[p] ?? null }, { from: "2024-01-01", to: "2024-01-10", filter: (r) => r.symbol !== "BANKNIFTY" });
    expect(loaded).toEqual({ NSE: ["2024-01-08"], BSE: ["2024-01-05"] });
    expect(book.dates("NIFTY")).toEqual(["2024-01-08"]);
    expect(book.dates("BANKNIFTY")).toEqual([]);
    expect(book.option("SENSEX", "2024-01-05", "2024-01-12", 72000, "PE")?.close).toBe(358.2);
  });
});

describe("RealPriceBook and research helpers", () => {
  const book = new RealPriceBook();
  book.add([
    row({ date: "2024-01-08", strike: 21500, type: "CE", close: 110 }),
    row({ date: "2024-01-08", strike: 21500, type: "PE", close: 60 }),
    row({ date: "2024-01-08", strike: 21550, type: "CE", close: 80 }),
    row({ date: "2024-01-08", strike: 21550, type: "PE", close: 80 }),
    row({ date: "2024-01-08", strike: 21600, type: "CE", close: 55 }),
    row({ date: "2024-01-08", strike: 21600, type: "PE", close: 105 }),
    row({ date: "2024-01-08", expiry: "2024-01-25", strike: 21550, type: "CE" }),
    row({ date: "2024-01-08", expiry: "2024-01-25", strike: 21600, type: "PE" }),
    row({ date: "2024-01-08", kind: "FUT", expiry: "2024-01-25", strike: 0, type: null }),
    row({ date: "2024-01-09", strike: 21500, type: "CE" }),
    row({ date: "2024-01-11", strike: 21500, type: "CE" }),
  ]);

  it("lists dates, expiries and strikes and counts sessions to expiry", () => {
    expect(book.dates("NIFTY")).toEqual(["2024-01-08", "2024-01-09", "2024-01-11"]);
    expect(book.expiries("NIFTY", "2024-01-08")).toEqual(["2024-01-11", "2024-01-25"]);
    expect(book.strikes("NIFTY", "2024-01-08", "2024-01-11")).toEqual([21500, 21550, 21600]);
    expect(book.nextDate("NIFTY", "2024-01-09")).toBe("2024-01-11");
    expect(book.futures("NIFTY", "2024-01-08")).toHaveLength(1);
    // 2024-01-10 has no data (treated as a holiday): sessions after the 8th up to the 11th = 9th, 11th.
    expect(book.sessionsToExpiry("NIFTY", "2024-01-08", "2024-01-11")).toBe(2);
    expect(book.sessionsToExpiry("NIFTY", "2024-01-11", "2024-01-11")).toBe(0);
  });

  it("finds the parity forward where call and put prices are closest", () => {
    const f = parityForward(book, "NIFTY", "2024-01-08", "2024-01-11", "close", { r: 0, tYears: 0.01 })!;
    // Strikes 21500/21550/21600 give 21550, 21550, 21550.
    expect(f).toEqual({ forward: 21550, strike: 21550 });
    expect(nearestStrike([21500, 21550, 21600], 21574)).toBe(21550);
    expect(nearestStrike([], 1)).toBeNull();
  });

  it("parses weekly and monthly engine symbols and resolves monthly ones to the month's last expiry", () => {
    expect(parseOptionSymbol("NIFTY26O1322600CE")).toEqual({ underlying: "NIFTY", expiry: "2026-10-13", year: 2026, month: 10, strike: 22600, type: "CE" });
    expect(parseOptionSymbol("SENSEX2671473000PE")).toMatchObject({ underlying: "SENSEX", expiry: "2026-07-14", strike: 73000, type: "PE" });
    expect(parseOptionSymbol("NIFTY26JUL23950CE")).toMatchObject({ expiry: null, year: 2026, month: 7, strike: 23950 });
    expect(parseOptionSymbol("garbage")).toBeNull();
    expect(resolveOptionRow(book, "NIFTY24JAN21600PE", "2024-01-08")?.expiry).toBe("2024-01-25");
    expect(resolveOptionRow(book, "NIFTY2411121500CE", "2024-01-08")?.close).toBe(110);
  });

  it("checks a price against the traded day range", () => {
    const r = row({ low: 80, high: 120, vwap: 100 });
    expect(dayRangeCheck(r, 100)).toMatchObject({ inRange: true, position: 0.5, vsVwap: 0 });
    expect(dayRangeCheck(r, 120.02).inRange).toBe(true);
    expect(dayRangeCheck(r, 121)).toMatchObject({ inRange: false });
    expect(dayRangeCheck(r, 121).position!).toBeGreaterThan(1);
    expect(dayRangeCheck(row({ contracts: 0, low: null, high: null }), 100).inRange).toBeNull();
    expect(dayRangeCheck(undefined, 100).inRange).toBeNull();
  });

  it("values an expiring option at the settlement level on expiry day only", () => {
    expect(settledClose(row({ date: "2024-01-11", expiry: "2024-01-11", strike: 21500, type: "PE", close: 3.2, settle: 21480 }))).toBe(20);
    expect(settledClose(row({ close: 42, settle: 42 }))).toBe(42);
  });

  it("finds short sessions and infers holidays", () => {
    const b = new RealPriceBook();
    const days = ["2024-10-28", "2024-10-29", "2024-10-30", "2024-10-31", "2024-11-01", "2024-11-04", "2024-11-05", "2024-11-06"];
    b.add(days.map((d) => row({ date: d, expiry: "2024-11-07", contracts: d === "2024-11-01" ? 50 : 1000 })));
    expect(shortSessions(b, "NIFTY")).toEqual(["2024-11-01"]);
    expect(inferHolidays(["2024-01-08", "2024-01-10"], "2024-01-06", "2024-01-10")).toEqual(["2024-01-09"]);
  });
});
