import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { InstrumentMaster } from "../instruments/instrumentMaster";
import { syntheticInstrumentRows } from "../instruments/syntheticInstruments";
import type { Quote } from "../types";
import {
  QUOTE_COLUMNS,
  QUOTE_ROWS_PER_STATEMENT,
  QUOTE_SOURCE,
  afterSnapshot,
  compactDepth,
  dueSlot,
  fetchOrder,
  freshDay,
  inRecordingWindow,
  insertQuotesSql,
  isEntrySnapshot,
  nearestStrike,
  planIndexSnapshot,
  quoteRowFromDb,
  quoteRowParams,
  quotesPageSql,
  recordedExpiries,
  strikeWindow,
  toQuoteRow,
  type RecorderDay,
} from "./quoteRecorder";

const cal = new TradingCalendar();
const MON = "2026-10-12"; // a trading Monday
const at = (time: string, sec = 0, date = MON) => istAt(date, time) + sec * 1000;

/** NIFTY and SENSEX weeklies around 12-23 Oct 2026, as the instrument master lists them (NIFTY 20 Oct is Dussehra: that week's contract expires Monday 19 Oct). */
function master(center = { NIFTY: 24_500, SENSEX: 81_000 }): InstrumentMaster {
  const rows = [
    ...syntheticInstrumentRows("NIFTY", ["2026-10-13", "2026-10-19", "2026-10-27"], center.NIFTY, 20, DEFAULT_CONFIG),
    ...syntheticInstrumentRows("SENSEX", ["2026-10-15", "2026-10-22"], center.SENSEX, 20, DEFAULT_CONFIG),
  ];
  return new InstrumentMaster(rows, DEFAULT_CONFIG);
}

describe("slot scheduling", () => {
  it("takes every tick from 09:15:00 to 09:31:00 IST, at least 20 s apart", () => {
    expect(dueSlot(at("09:14", 59), null, cal)).toEqual({ slot: null, reason: "outside the recording slots" });
    expect(dueSlot(at("09:15"), null, cal)).toEqual({ slot: "open", reason: null });
    expect(dueSlot(at("09:31"), null, cal).slot).toBe("open");
    expect(dueSlot(at("09:31", 1), null, cal).slot).toBeNull();
    const day: RecorderDay = { ...freshDay(MON), lastSnapshotMs: at("09:20") };
    expect(dueSlot(at("09:20", 10), day, cal)).toEqual({ slot: null, reason: "last snapshot 10 s ago" });
    expect(dueSlot(at("09:20", 25), day, cal).slot).toBe("open");
    // A day left over from yesterday does not count.
    expect(dueSlot(at("09:20", 10), { ...day, date: "2026-10-09" }, cal).slot).toBe("open");
  });

  it("takes each fixed slot once, within five minutes of its time", () => {
    for (const s of ["09:45", "10:15", "11:15", "15:00", "15:20"]) {
      expect(dueSlot(at(s), null, cal).slot).toBe(s);
      expect(dueSlot(at(s) + 4 * 60_000 + 59_000, null, cal).slot).toBe(s);
      expect(dueSlot(at(s) + 5 * 60_000, null, cal).slot).toBeNull();
      expect(dueSlot(at(s) - 1, null, cal).slot).toBeNull();
    }
    const done: RecorderDay = { ...freshDay(MON), slotsDone: ["11:15"] };
    expect(dueSlot(at("11:16"), done, cal)).toEqual({ slot: null, reason: "slot 11:15 already recorded" });
    expect(dueSlot(at("10:20"), null, cal).slot).toBeNull();
    expect(dueSlot(at("15:31"), null, cal).slot).toBeNull();
  });

  it("records nothing on weekends and exchange holidays, and follows the dashboard's overrides", () => {
    expect(dueSlot(at("09:20", 0, "2026-10-20"), null, cal)).toEqual({ slot: null, reason: "not a trading day (Dussehra)" });
    expect(dueSlot(at("09:20", 0, "2026-10-10"), null, cal)).toEqual({ slot: null, reason: "not a trading day (Weekend)" });
    expect(dueSlot(at("09:20", 0, "2026-10-02"), null, cal).reason).toMatch(/Gandhi Jayanti/);
    const special = cal.withOverrides([{ date: "2026-10-10", open: true, note: "special session" }]);
    expect(dueSlot(at("09:20", 0, "2026-10-10"), null, special).slot).toBe("open");
    const closed = cal.withOverrides([{ date: MON, open: false, note: "exchange outage" }]);
    expect(dueSlot(at("09:20"), null, closed)).toEqual({ slot: null, reason: "not a trading day (exchange outage)" });
  });

  it("pre-checks the clock without a calendar", () => {
    expect(inRecordingWindow(at("09:15"))).toBe(true);
    expect(inRecordingWindow(at("09:31"))).toBe(true);
    expect(inRecordingWindow(at("09:32"))).toBe(false);
    expect(inRecordingWindow(at("15:24", 59))).toBe(true);
    expect(inRecordingWindow(at("15:25"))).toBe(false);
    expect(inRecordingWindow(at("12:00"))).toBe(false);
  });

  it("keeps the at-the-money strikes of entry snapshots only, and marks fixed slots done", () => {
    let day = freshDay(MON);
    day = afterSnapshot(day, "open", at("09:15", 25), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_500 }]);
    day = afterSnapshot(day, "open", at("09:16", 40), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_550 }]);
    day = afterSnapshot(day, "open", at("09:25"), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_650 }]); // not an entry
    day = afterSnapshot(day, "open", at("09:30", 5), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_500 }]);
    day = afterSnapshot(day, "11:15", at("11:15", 3), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_400 }]);
    day = afterSnapshot(day, "manual", at("12:00"), [{ index: "NIFTY", expiry: "2026-10-13", atm: 24_100 }]);
    expect(day.entryStrikes).toEqual({ "NIFTY|2026-10-13": [24_400, 24_500, 24_550] });
    expect(day.slotsDone).toEqual(["11:15"]);
    expect(day.lastSnapshotMs).toBe(at("11:15", 3)); // a manual snapshot does not move the open-window spacing
    expect(isEntrySnapshot("open", at("09:20", 59))).toBe(true);
    expect(isEntrySnapshot("open", at("09:21"))).toBe(false);
    expect(isEntrySnapshot("open", at("09:31"))).toBe(true);
    expect(isEntrySnapshot("09:45", at("09:45"))).toBe(false);
  });
});

describe("expiries and expiry-day labelling", () => {
  const nifty = ["2026-10-13", "2026-10-19", "2026-10-27"];

  it("records the nearest expiry that is not today's, and today's expiring contract as well", () => {
    expect(recordedExpiries(nifty, MON)).toEqual([{ kind: "next", expiry: "2026-10-13" }]);
    expect(recordedExpiries(nifty, "2026-10-13")).toEqual([
      { kind: "next", expiry: "2026-10-19" },
      { kind: "expiring", expiry: "2026-10-13" },
    ]);
    // The holiday-shifted weekly (Tuesday 20 Oct is Dussehra) expires on Monday 19 Oct.
    expect(recordedExpiries(nifty, "2026-10-19")).toEqual([
      { kind: "next", expiry: "2026-10-27" },
      { kind: "expiring", expiry: "2026-10-19" },
    ]);
    expect(recordedExpiries(["2026-10-01"], MON)).toEqual([]);
    expect(recordedExpiries([], MON)).toEqual([]);
  });

  it("labels each contract with its expiry kind on an expiry day", async () => {
    const plan = await planIndexSnapshot({ index: "NIFTY", spot: 24_512.3, today: "2026-10-13", instruments: master() });
    expect(plan.problems).toEqual([]);
    expect(plan.expiries).toEqual([
      { kind: "next", expiry: "2026-10-19", atm: 24_500 },
      { kind: "expiring", expiry: "2026-10-13", atm: 24_500 },
    ]);
    expect(plan.contracts).toHaveLength(20);
    expect(plan.contracts.filter((c) => c.kind === "expiring").every((c) => c.contract.expiry === "2026-10-13")).toBe(true);
    expect(plan.contracts.filter((c) => c.kind === "next").every((c) => c.contract.expiry === "2026-10-19")).toBe(true);
    const sensex = await planIndexSnapshot({ index: "SENSEX", spot: 81_049, today: "2026-10-13", instruments: master() });
    expect(sensex.expiries).toEqual([{ kind: "next", expiry: "2026-10-15", atm: 81_000 }]);
    expect(sensex.contracts).toHaveLength(10);
    expect(sensex.contracts[0].contract).toMatchObject({ exchange: "BSE", lotSize: 20 });
  });

  it("says why when the instrument master has nothing for today", async () => {
    const plan = await planIndexSnapshot({ index: "NIFTY", spot: 24_500, today: "2026-11-02", instruments: master() });
    expect(plan.contracts).toEqual([]);
    expect(plan.problems).toEqual(["NIFTY: no listed expiry after 2026-11-02 in the instrument master"]);
  });
});

describe("at-the-money strike selection", () => {
  const listed = Array.from({ length: 21 }, (_, i) => 24_000 + 50 * i); // 24,000 .. 25,000

  it("takes the listed strike nearest the spot, a tie going to the lower strike", () => {
    expect(nearestStrike(listed, 24_512.3)).toBe(24_500);
    expect(nearestStrike(listed, 24_537.6)).toBe(24_550);
    expect(nearestStrike(listed, 24_525)).toBe(24_500);
    expect(nearestStrike([], 24_500)).toBeNull();
  });

  it("adds two listed strikes on each side, fewer at the edge of the listing", () => {
    expect(strikeWindow(listed, 24_512.3)).toEqual({ atm: 24_500, strikes: [24_400, 24_450, 24_500, 24_550, 24_600] });
    expect(strikeWindow(listed, 23_000)).toEqual({ atm: 24_000, strikes: [24_000, 24_050, 24_100] });
    expect(strikeWindow(listed, 26_000).strikes).toEqual([24_900, 24_950, 25_000]);
    // Uneven listing: neighbours by rank, not by a fixed step.
    expect(strikeWindow([81_000, 81_100, 81_200, 81_500, 82_000], 81_480)).toEqual({ atm: 81_500, strikes: [81_100, 81_200, 81_500, 82_000] });
    expect(strikeWindow([], 24_500)).toEqual({ atm: null, strikes: [] });
  });

  it("resolves ten contracts per index and expiry from the instrument master, the money first", async () => {
    const m = master();
    const nifty = await planIndexSnapshot({ index: "NIFTY", spot: 24_512.3, today: MON, instruments: m });
    expect(nifty.contracts.map((c) => `${c.contract.strike}${c.contract.type}:${c.priority}`)).toEqual([
      "24500CE:0",
      "24500PE:0",
      "24450CE:1",
      "24450PE:1",
      "24550CE:1",
      "24550PE:1",
      "24400CE:2",
      "24400PE:2",
      "24600CE:2",
      "24600PE:2",
    ]);
    expect(nifty.contracts[0].contract.tradingSymbol).toBe("NIFTY26O1324500CE");
    const sensex = await planIndexSnapshot({ index: "SENSEX", spot: 81_010, today: MON, instruments: m });
    const order = fetchOrder([nifty, sensex]);
    expect(order.slice(0, 4).map((c) => c.contract.tradingSymbol)).toEqual(["NIFTY26O1324500CE", "NIFTY26O1324500PE", "SENSEX26O1581000CE", "SENSEX26O1581000PE"]);
    expect(order).toHaveLength(20);
  });

  it("adds the morning's strikes at the exit slots, fetched with the money", async () => {
    const plan = await planIndexSnapshot({ index: "NIFTY", spot: 24_812, today: MON, instruments: master(), held: () => [24_500, 24_550, 99_999] });
    const strikes = [...new Set(plan.contracts.map((c) => c.contract.strike))];
    expect(strikes).toEqual([24_500, 24_550, 24_800, 24_750, 24_850, 24_700, 24_900]);
    expect(plan.contracts.filter((c) => c.priority === 0)).toHaveLength(6);
    expect(plan.contracts).toHaveLength(14); // the strike not listed is skipped
  });
});

describe("rows", () => {
  const quote: Quote = {
    symbol: "NIFTY26O1324500CE",
    t: at("09:15", 21),
    ltp: 142.5,
    bid: 142.3,
    ask: 142.7,
    bidQty: 650,
    askQty: 1300,
    oi: 1_250_000,
    volume: 40_000,
    source: "groww",
    depth: {
      buy: [1, 2, 3, 4, 5, 6].map((i) => ({ price: 142.35 - i * 0.05, qty: 65 * i })),
      sell: [{ price: 142.7, qty: 1300 }, { price: 0, qty: 10 }],
    },
  };

  it("builds a row: zeros become NULL, the depth keeps five levels a side", async () => {
    const [planned] = (await planIndexSnapshot({ index: "NIFTY", spot: 24_500, today: MON, instruments: master() })).contracts;
    const row = toQuoteRow({ snapshotMs: at("09:15", 20), slot: "open", planned, quote, lastTradeMs: at("09:15", 19), spot: 24_512.3 });
    expect(row).toMatchObject({
      snapshotMs: at("09:15", 20),
      slot: "open",
      indexId: "NIFTY",
      expiry: "2026-10-13",
      expiryKind: "next",
      strike: 24_500,
      optionType: "CE",
      tradingSymbol: "NIFTY26O1324500CE",
      lotSize: 65,
      bid: 142.3,
      ask: 142.7,
      bidQty: 650,
      askQty: 1300,
      ltp: 142.5,
      lastTradeMs: at("09:15", 19),
      volume: 40_000,
      oi: 1_250_000,
      spot: 24_512.3,
      fetchedMs: at("09:15", 21),
      source: QUOTE_SOURCE,
      schemaV: 1,
    });
    const depth = JSON.parse(row.depth!);
    expect(depth.b).toHaveLength(5);
    expect(depth.a).toEqual([[142.7, 1300]]);
    const empty = toQuoteRow({ snapshotMs: 1, slot: "open", planned, quote: { ...quote, bid: 0, ask: 0, ltp: 0, depth: undefined, oi: undefined, volume: undefined }, lastTradeMs: null, spot: null });
    expect(empty).toMatchObject({ bid: null, ask: null, bidQty: null, askQty: null, ltp: null, lastTradeMs: null, depth: null, oi: null, volume: null, spot: null });
    expect(compactDepth({ buy: [], sell: [] })).toBeNull();
  });

  it("binds columns in order and reads them back", async () => {
    const [planned] = (await planIndexSnapshot({ index: "NIFTY", spot: 24_500, today: MON, instruments: master() })).contracts;
    const row = toQuoteRow({ snapshotMs: 5, slot: "15:20", planned, quote, lastTradeMs: null, spot: 24_500 });
    const params = quoteRowParams(row);
    expect(params).toHaveLength(QUOTE_COLUMNS.length);
    const db = Object.fromEntries(QUOTE_COLUMNS.map((c, i) => [c, params[i]]));
    expect(quoteRowFromDb(db)).toEqual(row);
    expect(QUOTE_ROWS_PER_STATEMENT * QUOTE_COLUMNS.length).toBeLessThanOrEqual(100);
    expect(insertQuotesSql(2)).toMatch(/^INSERT OR IGNORE INTO option_quotes \(snapshot_ms,.*schema_v\) VALUES \(\?(,\?){21}\),\(\?(,\?){21}\)$/);
  });

  it("pages in key order and leaves manual snapshots out", () => {
    expect(quotesPageSql(null, { limit: 100 })).toBe(`SELECT ${QUOTE_COLUMNS.join(",")} FROM option_quotes WHERE slot != 'manual' ORDER BY snapshot_ms, trading_symbol LIMIT 100`);
    expect(quotesPageSql({ snapshotMs: 7, symbol: "A'B" }, { fromMs: 1, toMs: 9, limit: 5, includeManual: true })).toBe(
      `SELECT ${QUOTE_COLUMNS.join(",")} FROM option_quotes WHERE (snapshot_ms > 7 OR (snapshot_ms = 7 AND trading_symbol > 'A''B')) AND snapshot_ms >= 1 AND snapshot_ms < 9 ORDER BY snapshot_ms, trading_symbol LIMIT 5`,
    );
  });
});
