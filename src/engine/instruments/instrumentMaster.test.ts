import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { readInstrumentFixtureText } from "../__fixtures__/market/loadFixtures";
import {
  atmStrike,
  fetchIndexOptionInstruments,
  INSTRUMENT_CSV_URL,
  InstrumentMaster,
  isIndexOptionRow,
  nearestListedStrike,
  parseInstrumentCsv,
  splitCsvRecord,
} from "./instrumentMaster";

const csv = readInstrumentFixtureText();
const rows = parseInstrumentCsv(csv);

describe("parseInstrumentCsv", () => {
  it("parses the real Groww sample by header", () => {
    expect(rows.length).toBe(45);
    expect(rows[0]).toEqual({
      exchange: "NSE",
      exchangeToken: "44612",
      tradingSymbol: "NIFTY26O1322500CE",
      growwSymbol: "NSE-NIFTY-13Oct26-22500-CE",
      name: "",
      instrumentType: "CE",
      segment: "FNO",
      underlyingSymbol: "NIFTY",
      expiryDate: "2026-10-13",
      strikePrice: 22500,
      lotSize: 65,
      tickSize: 0.05,
      freezeQuantity: 3511,
      buyAllowed: true,
      sellAllowed: true,
    });
    const idx = rows.find((r) => r.instrumentType === "IDX");
    expect(idx).toMatchObject({ name: "NIFTY 50", segment: "CASH", strikePrice: 0, lotSize: 0, expiryDate: "", buyAllowed: false });
    const fut = rows.find((r) => r.instrumentType === "FUT");
    expect(fut?.strikePrice).toBe(-0.01);
  });

  it("handles quotes, CRLF, a BOM, reordered columns and boolean spellings", () => {
    const text =
      "﻿trading_symbol,exchange,name,instrument_type,segment,underlying_symbol,expiry_date,strike_price,lot_size,tick_size,freeze_quantity,buy_allowed,sell_allowed,groww_symbol,exchange_token\r\n" +
      'NIFTY26O1322600CE,NSE,"Nifty, ""50"" index\nline two",CE,FNO,NIFTY,2026-10-13,22600,65,0.05,3511,true,0,NSE-NIFTY-13Oct26-22600-CE,44616\r\n' +
      "\r\n" +
      "SENSEX26O0872600PE,BSE,,PE,FNO,SENSEX,08-10-2026,72600.0,20,0.05,1001,TRUE,1,BSE-SENSEX-08Oct26-72600-PE,889307\r\n";
    const r = parseInstrumentCsv(text);
    expect(r.length).toBe(2);
    expect(r[0].name).toBe('Nifty, "50" index\nline two');
    expect(r[0].tradingSymbol).toBe("NIFTY26O1322600CE");
    expect(r[0].exchangeToken).toBe("44616");
    expect(r[0].buyAllowed).toBe(true);
    expect(r[0].sellAllowed).toBe(false);
    expect(r[1].expiryDate).toBe("2026-10-08");
    expect(r[1].strikePrice).toBe(72600);
    expect(r[1].buyAllowed).toBe(true);
  });

  it("splits records with RFC 4180 quoting", () => {
    expect(splitCsvRecord('a,"b,c",,"d""e"')).toEqual(["a", "b,c", "", 'd"e']);
    expect(splitCsvRecord("x,y")).toEqual(["x", "y"]);
  });
});

describe("isIndexOptionRow", () => {
  it("keeps NIFTY (NSE) and SENSEX (BSE) options only", () => {
    const kept = rows.filter((r) => isIndexOptionRow(r));
    expect(kept.length).toBe(42);
    expect(kept.every((r) => ["CE", "PE"].includes(r.instrumentType) && r.segment === "FNO")).toBe(true);
    expect(rows.filter((r) => !isIndexOptionRow(r)).map((r) => r.tradingSymbol)).toEqual([
      "NIFTY26OCTFUT",
      "NIFTY",
      "BANKNIFTY26OCT44500CE",
    ]);
    const wrongExchange = { ...kept.find((r) => r.underlyingSymbol === "SENSEX")!, exchange: "NSE" };
    expect(isIndexOptionRow(wrongExchange)).toBe(false);
    expect(isIndexOptionRow(rows.find((r) => r.underlyingSymbol === "BANKNIFTY")!, ["BANKNIFTY"])).toBe(true);
  });
});

describe("InstrumentMaster", () => {
  const master = new InstrumentMaster(rows, DEFAULT_CONFIG);

  it("indexes the index options by expiry and strike", async () => {
    expect(master.size).toBe(42);
    expect(await master.expiries("NIFTY")).toEqual(["2026-10-13", "2026-10-19", "2026-10-27"]);
    expect(await master.expiries("SENSEX")).toEqual(["2026-10-08", "2026-10-15", "2026-10-29"]);
    expect(await master.strikes("NIFTY", "2026-10-13")).toEqual([22500, 22550, 22600, 22650, 22700]);
    expect(await master.strikes("SENSEX", "2026-10-15")).toEqual([72400, 72500, 72600, 72700, 72800]);
    expect(await master.strikes("NIFTY", "2030-01-01")).toEqual([]);
  });

  it("resolves real contracts, including the holiday-shifted and monthly ones", async () => {
    expect(await master.resolve("NIFTY", "2026-10-13", 22600, "CE")).toEqual({
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
    });
    expect(await master.resolve("SENSEX", "2026-10-08", 72600, "PE")).toMatchObject({
      exchange: "BSE",
      tradingSymbol: "SENSEX26O0872600PE",
      growwSymbol: "BSE-SENSEX-08Oct26-72600-PE",
      exchangeToken: "889307",
      lotSize: 20,
      freezeQty: 1001,
    });
    // 2026-10-20 (Tuesday) is a holiday, so that week's NIFTY weekly expires on Monday the 19th.
    expect((await master.resolve("NIFTY", "2026-10-19", 22650, "PE"))?.tradingSymbol).toBe("NIFTY26O1922650PE");
    expect((await master.resolve("NIFTY", "2026-10-27", 22600, "CE"))?.tradingSymbol).toBe("NIFTY26OCT22600CE");
    expect((await master.resolve("SENSEX", "2026-10-29", 72600, "PE"))?.tradingSymbol).toBe("SENSEX26OCT72600PE");
    expect(await master.resolve("NIFTY", "2026-10-13", 22625, "CE")).toBeNull();
    expect(await master.resolve("SENSEX", "2026-10-13", 22600, "CE")).toBeNull();
    expect((await master.resolve("NIFTY", "2026-10-13", 22600.0000001, "PE"))?.tradingSymbol).toBe("NIFTY26O1322600PE");
  });

  it("resolves the ATM contract for a live spot", async () => {
    const strike = atmStrike(22603.05, DEFAULT_CONFIG.indexSpecs.NIFTY.strikeStep);
    const [nearest] = await master.expiries("NIFTY");
    expect((await master.resolve("NIFTY", nearest, strike, "CE"))?.tradingSymbol).toBe("NIFTY26O1322600CE");
    const sx = atmStrike(72638.7, DEFAULT_CONFIG.indexSpecs.SENSEX.strikeStep);
    expect((await master.resolve("SENSEX", "2026-10-08", sx, "PE"))?.tradingSymbol).toBe("SENSEX26O0872600PE");
  });

  it("ignores rows that are not configured index options", () => {
    const m = new InstrumentMaster(rows.filter((r) => !isIndexOptionRow(r)), DEFAULT_CONFIG);
    expect(m.size).toBe(0);
  });
});

describe("strike helpers", () => {
  it("atmStrike rounds to the strike step (NIFTY 50, SENSEX 100)", () => {
    expect(atmStrike(22603.05, 50)).toBe(22600);
    expect(atmStrike(22624.99, 50)).toBe(22600);
    expect(atmStrike(22625, 50)).toBe(22650);
    expect(atmStrike(22674.9, 50)).toBe(22650);
    expect(atmStrike(72638.7, 100)).toBe(72600);
    expect(atmStrike(72650, 100)).toBe(72700);
    expect(atmStrike(72549.99, 100)).toBe(72500);
    expect(atmStrike(123, 0)).toBe(123);
  });

  it("nearestListedStrike picks the closest listed strike", () => {
    expect(nearestListedStrike([22500, 22600, 22700], 22640)).toBe(22600);
    expect(nearestListedStrike([22500, 22600, 22700], 22650)).toBe(22700);
    expect(nearestListedStrike([22500], 30000)).toBe(22500);
    expect(nearestListedStrike([], 22600)).toBeNull();
  });
});

describe("fetchIndexOptionInstruments", () => {
  function streamingFetch(text: string, chunkSize: number, status = 200) {
    const urls: string[] = [];
    const bytes = new TextEncoder().encode(text);
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
          offset += chunkSize;
        },
      });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it("streams the CSV and keeps only index-option rows, whatever the chunking", async () => {
    // A multi-byte character inside a quoted name exercises chunk boundaries in the decoder.
    const text = csv.replace("NSE,NIFTY,NIFTY,NSE-NIFTY,NIFTY 50,", 'NSE,NIFTY,NIFTY,NSE-NIFTY,"NIFTY 50 ₹, index",');
    for (const chunk of [1, 7, 64, 100_000]) {
      const { fetchImpl, urls } = streamingFetch(text, chunk);
      const got = await fetchIndexOptionInstruments({ fetchImpl });
      expect(urls).toEqual([INSTRUMENT_CSV_URL]);
      expect(got.length).toBe(42);
      expect(got).toEqual(rows.filter((r) => isIndexOptionRow(r)));
    }
  });

  it("supports other underlyings and a file without a trailing newline", async () => {
    const { fetchImpl } = streamingFetch(csv.trimEnd(), 13);
    const got = await fetchIndexOptionInstruments({ fetchImpl, underlyings: ["BANKNIFTY", "SENSEX"] });
    expect(got.filter((r) => r.underlyingSymbol === "BANKNIFTY").length).toBe(1);
    expect(got.filter((r) => r.underlyingSymbol === "SENSEX").length).toBe(21);
    expect(got.some((r) => r.underlyingSymbol === "NIFTY")).toBe(false);
  });

  it("throws on HTTP errors", async () => {
    const { fetchImpl } = streamingFetch("AccessDenied", 100, 403);
    await expect(fetchIndexOptionInstruments({ fetchImpl })).rejects.toThrow(/HTTP 403: AccessDenied/);
  });
});
