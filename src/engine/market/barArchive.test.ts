import { describe, expect, it } from "vitest";
import { DAY_MS, MINUTE_MS, istAt, istMidnight } from "../clock";
import type { Candle } from "../types";
import { sessionFromCloses } from "../__fixtures__/market/loadFixtures";
import {
  ARCHIVE_SETTLE_MS,
  archiveWindowStart,
  BACKFILL_SOURCE,
  backfillRows,
  backfillSqlFiles,
  candleFromRow,
  compareBars,
  dailyRangeFor,
  historySnapshot,
  INSERT_OR_IGNORE_SQL,
  insertStatements,
  LIST_SYMBOLS_SQL,
  planBars,
  readArchivedBars,
  sqlNumber,
  sqlString,
  toBarRow,
  type BarRow,
  type HistoryFile,
  type SqlRunner,
} from "./barArchive";
import { BAR_5M_MS } from "./candles";
import { ReplayMarketDataSource } from "./replayMarketData";

const bar = (t: number, c: number, extra: Partial<Candle> = {}): Candle => ({ t, o: c - 1, h: c + 2, l: c - 2, c, v: 0, ...extra });
const rowsOf = (symbol: string, bars: Candle[], seen = 1): BarRow[] => bars.map((c) => toBarRow(symbol, c, "test", seen));

describe("SQL literals", () => {
  it("formats numbers so they read back as the same double, and refuses non-finite ones", () => {
    // Yahoo prices are float32 values widened to doubles: they print with every digit.
    expect(sqlNumber(Math.fround(12345.678))).toBe("12345.677734375");
    expect(sqlNumber(Math.fround(0.103))).toBe("0.10300000011920929");
    expect(sqlNumber(1784173500000)).toBe("1784173500000");
    expect(sqlNumber(1e-7)).toBe("1e-7");
    expect(sqlNumber(-0)).toBe("0");
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => sqlNumber(bad)).toThrow(/finite/);
    expect(sqlString("O'Hare")).toBe("'O''Hare'");
  });

  it("builds multi-row INSERT OR IGNORE statements within the row and byte limits", () => {
    const rows = rowsOf("^NSEI", sessionFromCloses("2026-10-07", Array.from({ length: 23 }, (_, i) => 24000 + i), 24000));
    rows[3] = { ...rows[3], oi: 1234 };
    const byRows = insertStatements(rows, { maxRows: 10 });
    expect(byRows).toHaveLength(3);
    for (const s of byRows) {
      expect(s.startsWith(`${INSERT_OR_IGNORE_SQL}\n`)).toBe(true);
      expect(s.endsWith(";")).toBe(true);
    }
    expect(INSERT_OR_IGNORE_SQL).toBe("INSERT OR IGNORE INTO bars_5m (symbol,t,o,h,l,c,v,oi,source,first_seen_ms) VALUES");
    const all = byRows.join("\n");
    for (const r of rows) expect(all.split(`('^NSEI',${r.t},`).length - 1).toBe(1);
    expect(all).toContain(",1234,'test',1)");
    expect(all).toContain(",NULL,'test',1)");

    const byBytes = insertStatements(rows, { maxRows: 1000, maxBytes: 600 });
    expect(byBytes.length).toBeGreaterThan(3);
    for (const s of byBytes) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(600);
    expect(byBytes.join("\n").split("('^NSEI',").length - 1).toBe(rows.length);
  });

  it("splits the back-fill into numbered files with comment headers that cannot break out of the comment", () => {
    const rows = [...rowsOf("^BSESN", sessionFromCloses("2026-10-06", [1, 2, 3, 4], 1)), ...rowsOf("^NSEI", sessionFromCloses("2026-10-06", [5, 6, 7], 5))];
    const files = backfillSqlFiles(rows, { rowsPerFile: 3, rowsPerStatement: 2, header: ["source: x.json\nDROP TABLE bars_5m;"] });
    expect(files.map((f) => f.name)).toEqual(["bars-0001.sql", "bars-0002.sql", "bars-0003.sql"]);
    expect(files.map((f) => f.rows)).toEqual([3, 3, 1]);
    expect(files[0].statements).toBe(2);
    expect(files[1].symbols).toEqual({
      "^BSESN": { rows: 1, fromMs: rows[3].t, toMs: rows[3].t },
      "^NSEI": { rows: 2, fromMs: rows[4].t, toMs: rows[5].t },
    });
    for (const f of files) {
      const lines = f.sql.trimEnd().split("\n");
      const comments = lines.filter((l) => l.startsWith("--"));
      expect(comments.length).toBe(3);
      expect(lines.slice(0, 3)).toEqual(comments); // the header comes first, one line each
      expect(lines.filter((l) => l.includes("DROP TABLE")).every((l) => l.startsWith("--"))).toBe(true);
    }
  });
});

describe("backfillRows", () => {
  const savedAt = "2026-10-07T10:30:00.000Z"; // 16:00 IST
  const savedAtMs = Date.parse(savedAt);
  const nifty = sessionFromCloses("2026-10-07", Array.from({ length: 75 }, (_, i) => 100 + i), 100);
  const capture1 = "2026-10-07T05:00:00.000Z"; // 10:30 IST
  const file = (extra: Partial<HistoryFile> = {}): HistoryFile => ({
    source: "yahoo 5m archive",
    savedAt,
    candles: { "^NSEI": nifty, "ES=F": [bar(istAt("2026-10-07", "15:20"), 7000), bar(istAt("2026-10-07", "15:25"), 7001), bar(istAt("2026-10-07", "15:30"), 7002)] },
    archive: { captures: [{ fetchedAt: capture1 }, { fetchedAt: savedAt }] },
    ...extra,
  });

  it("keeps bars that closed 30 minutes before savedAt, sorted by symbol then time, with first_seen from the captures", () => {
    const plan = backfillRows(file());
    expect(plan.settledBeforeMs).toBe(savedAtMs - ARCHIVE_SETTLE_MS); // 15:30 IST
    // ES=F 15:30 bar closes at 15:35: not settled. NIFTY 15:25 closes at 15:30: settled.
    expect(plan.skipped).toEqual({ unsettled: 1, invalid: 0, outOfRange: 0, duplicates: 0 });
    expect(plan.rows.map((r) => r.symbol)).toEqual([...Array(2).fill("ES=F"), ...Array(75).fill("^NSEI")]);
    expect(plan.rows.every((r) => r.source === BACKFILL_SOURCE && r.oi === null)).toBe(true);
    const n = plan.rows.filter((r) => r.symbol === "^NSEI");
    expect(n.map((r) => r.t)).toEqual(nifty.map((c) => c.t));
    // 09:15 bar closes 09:20: the 10:30 capture (>= 09:50) could archive it; the 10:00 bar (closes 10:05) too;
    // the 10:05 bar closes 10:10 and needs a capture at 10:40 or later: the 16:00 one.
    const seen = (hhmm: string) => n.find((r) => r.t === istAt("2026-10-07", hhmm))!.firstSeenMs;
    expect(seen("09:15")).toBe(Date.parse(capture1));
    expect(seen("09:55")).toBe(Date.parse(capture1));
    expect(seen("10:00")).toBe(savedAtMs);
    expect(plan.symbols["^NSEI"]).toEqual({ rows: 75, fromMs: nifty[0].t, toMs: nifty[74].t });
  });

  it("filters symbols and dates, drops invalid and duplicate bars, and uses savedAt without a capture log", () => {
    const dup = { ...nifty[1] };
    const plan = backfillRows(file({ archive: undefined, candles: { "^NSEI": [nifty[0], dup, ...nifty.slice(1, 5), { ...nifty[5], c: NaN }], "ES=F": [bar(1, 1)] } }), {
      symbols: ["^NSEI"],
      fromMs: nifty[1].t,
      toMs: nifty[4].t,
    });
    expect(plan.rows.map((r) => r.t)).toEqual([nifty[1].t, nifty[2].t, nifty[3].t]);
    expect(plan.rows.every((r) => r.firstSeenMs === savedAtMs)).toBe(true);
    expect(plan.skipped).toEqual({ unsettled: 0, invalid: 1, outOfRange: 2, duplicates: 1 });
  });

  it("needs a savedAt (or an explicit cutoff) and Yahoo-style symbol names", () => {
    expect(() => backfillRows({ candles: { "^NSEI": nifty } })).toThrow(/savedAt/);
    // Bars that closed by the open of bar 10: bars 0..9.
    expect(backfillRows({ candles: { "^NSEI": nifty } }, { settledBeforeMs: nifty[10].t }).rows).toHaveLength(10);
    expect(() => backfillRows({ savedAt, candles: { "x');DROP TABLE bars_5m;--": nifty } })).toThrow(/symbol/);
  });
});

describe("planBars", () => {
  const day1 = sessionFromCloses("2026-10-06", [1, 2, 3], 1);
  const day2 = sessionFromCloses("2026-10-07", [4, 5, 6, 7], 3);

  it("compares from IST midnight of the last archived bar's day", () => {
    expect(archiveWindowStart(null)).toBe(-Infinity);
    expect(archiveWindowStart(istAt("2026-10-07", "15:25"))).toBe(istMidnight("2026-10-07"));
    expect(archiveWindowStart(istAt("2026-10-07", "00:00"))).toBe(istMidnight("2026-10-07"));
  });

  it("returns the settled bars not archived yet and the revised ones, ignoring bars before the window", () => {
    const archived = [day2[0], day2[1]];
    const fresh = [{ ...day1[0], c: 99 }, ...day1.slice(1), { ...day2[0], c: 4.5 }, day2[1], day2[2], day2[3]];
    const settled = day2[2].t + BAR_5M_MS; // day2[3] still forming
    const plan = planBars(fresh, archived, settled, istMidnight("2026-10-07"));
    expect(plan.bars).toEqual([day2[2]]);
    expect(plan.revisions).toEqual([{ archived: day2[0], fetched: { ...day2[0], c: 4.5 } }]);
    expect(plan.unsettled).toBe(1);
    // Without a window (first run) everything settled and new is written, day 1 included.
    expect(planBars(fresh, [], settled).bars.map((c) => c.c)).toEqual([99, 2, 3, 4.5, 5, 6]);
  });
});

describe("export", () => {
  const symbols: Record<string, Candle[]> = {
    "^NSEI": sessionFromCloses("2026-10-07", Array.from({ length: 30 }, (_, i) => 100 + i), 100),
    "ES=F": Array.from({ length: 12 }, (_, i) => bar(istAt("2026-10-07", "00:00") + i * BAR_5M_MS, 7000 + i, { v: i, oi: i === 3 ? 42 : undefined })),
  };

  /** Answers LIST_SYMBOLS_SQL and pageSql() from memory, like D1 would. */
  function memoryRunner(data: Record<string, Candle[]>) {
    const calls: string[][] = [];
    const run: SqlRunner = async (statements) => {
      calls.push(statements);
      return statements.map((sql) => {
        if (sql === LIST_SYMBOLS_SQL) return Object.keys(data).sort().map((symbol) => ({ symbol }));
        const m = /symbol = '(.+?)' AND t > (-?\d+)(?: AND t < (\d+))? ORDER BY t LIMIT (\d+)$/.exec(sql);
        if (!m) throw new Error(`unexpected SQL ${sql}`);
        const [, sym, after, before, limit] = m;
        return (data[sym] ?? [])
          .filter((c) => c.t > Number(after) && (before === undefined || c.t < Number(before)))
          .slice(0, Number(limit))
          .map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, oi: c.oi ?? null }));
      });
    };
    return { run, calls };
  }

  it("reads every symbol page by page, several statements per call", async () => {
    const { run, calls } = memoryRunner(symbols);
    const got = await readArchivedBars(run, { pageRows: 7, statementsPerCall: 2 });
    expect(got).toEqual(symbols);
    expect(calls[0]).toEqual([LIST_SYMBOLS_SQL]);
    expect(calls.slice(1).every((c) => c.length <= 2)).toBe(true);
    // Pages: ^NSEI 7+7+7+7+2, ES=F 7+5; a full page queues the next one behind the other symbols.
    expect(calls.slice(1).map((c) => c.length)).toEqual([2, 2, 1, 1, 1]);
  });

  it("filters by symbol and bar time", async () => {
    const { run } = memoryRunner(symbols);
    const from = symbols["^NSEI"][5].t;
    const to = symbols["^NSEI"][9].t;
    const got = await readArchivedBars(run, { symbols: ["^NSEI", "^BSESN"], fromMs: from, toMs: to, pageRows: 2 });
    expect(Object.keys(got)).toEqual(["^NSEI"]);
    expect(got["^NSEI"]).toEqual(symbols["^NSEI"].slice(5, 9));
  });

  it("writes the snapshot shape the backtest replays", () => {
    const snap = historySnapshot({ "ES=F": [...symbols["ES=F"]].reverse(), "^NSEI": [symbols["^NSEI"][1], symbols["^NSEI"][0], symbols["^NSEI"][1]], "^BSESN": [] }, {
      source: "d1 bars_5m archive (local)",
      savedAt: "2026-10-09T12:00:00.000Z",
    });
    const json = JSON.parse(JSON.stringify(snap));
    expect(Object.keys(json).sort()).toEqual(["candles", "daily", "errors", "savedAt", "source"]);
    expect(Object.keys(json.candles)).toEqual(["ES=F", "^NSEI"]);
    expect(json.candles["ES=F"]).toEqual(symbols["ES=F"]);
    expect(json.candles["^NSEI"]).toEqual(symbols["^NSEI"].slice(0, 2));
    expect(json.candles["ES=F"][3].oi).toBe(42);
    expect("oi" in json.candles["ES=F"][2]).toBe(false);
    expect(json.daily).toEqual({});
    expect(json.errors).toEqual([]);
    const replay = new ReplayMarketDataSource(json);
    expect(replay.range()).toEqual({ fromMs: symbols["ES=F"][0].t, toMs: symbols["^NSEI"][1].t });
    expect(replay.snapshotSync(symbols["^NSEI"][1].t + BAR_5M_MS).candles["^NSEI"]).toEqual(symbols["^NSEI"].slice(0, 2));
  });

  it("maps rows with and without open interest", () => {
    expect(candleFromRow({ t: 1, o: 2, h: 3, l: 4, c: 5, v: 6, oi: null })).toEqual({ t: 1, o: 2, h: 3, l: 4, c: 5, v: 6 });
    expect(candleFromRow({ t: 1, o: 2, h: 3, l: 4, c: 5, v: 6, oi: 7 })).toEqual({ t: 1, o: 2, h: 3, l: 4, c: 5, v: 6, oi: 7 });
    expect(toBarRow("^NSEI", { t: 1, o: 2, h: 3, l: 4, c: 5, v: 6 }, "s", 9)).toEqual({ symbol: "^NSEI", t: 1, o: 2, h: 3, l: 4, c: 5, v: 6, oi: null, source: "s", firstSeenMs: 9 });
  });

  it("picks a daily range that reaches back past the archive", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    expect(dailyRangeFor(now - 60 * DAY_MS, now)).toBe("2y");
    expect(dailyRangeFor(now - 700 * DAY_MS, now)).toBe("5y");
    expect(dailyRangeFor(now - 3000 * DAY_MS, now)).toBe("10y");
    expect(dailyRangeFor(now - 4000 * DAY_MS, now)).toBe("max");
  });

  it("compares archived bars with a file value for value", () => {
    const a = symbols["^NSEI"].slice(0, 4);
    const cmp = compareBars({ "^NSEI": a }, { "^NSEI": [a[0], { ...a[1], c: a[1].c + 0.05 }, a[3], bar(a[3].t + 5 * MINUTE_MS, 1)] });
    expect({ ...cmp, examples: cmp.examples.length }).toEqual({ same: 2, missing: 1, different: 1, extra: 1, examples: 2 });
  });
});
