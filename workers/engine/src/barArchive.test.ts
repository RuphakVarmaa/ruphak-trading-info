/**
 * The nightly bar archive, the back-fill SQL and the export, against a real local D1 and KV (Miniflare via
 * wrangler's getPlatformProxy) with the committed migrations applied.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { TradingCalendar } from "../../../src/engine/calendar/calendar";
import { istAt, istIso } from "../../../src/engine/clock";
import { sessionFromCloses } from "../../../src/engine/__fixtures__/market/loadFixtures";
import { backfillRows, backfillSqlFiles, BACKFILL_SOURCE, ENGINE_SOURCE, historySnapshot, readArchivedBars, type SqlRunner } from "../../../src/engine/market/barArchive";
import { BAR_5M_MS } from "../../../src/engine/market/candles";
import { CROSS_ASSET_SYMBOLS } from "../../../src/engine/market/yahooMarketData";
import type { Logger } from "../../../src/engine/ports";
import type { Candle } from "../../../src/engine/types";
import { BAR_ARCHIVE_STATUS_KEY, recordBarArchiveFailure, runBarArchive, type BarArchiveDeps, type BarArchiveStatus, type BarSource } from "./barArchive";

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; KV: KVNamespace }>>>;
let proxy: Proxy;
let db: D1Database;
let kv: KVNamespace;

const migrationsDir = new URL("../../../migrations/", import.meta.url);

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database; KV: KVNamespace }>({ configPath: "workers/engine/wrangler.jsonc", persist: false, remoteBindings: false });
  db = retryClosedSocket(proxy.env.DB);
  kv = proxy.env.KV;
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, migrationsDir), "utf8"))
    .join("\n");
  for (const st of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

/**
 * Miniflare's proxy keeps an idle socket for 1 s and workerd closes it after 5 s. Its prepare() and bind()
 * are synchronous round trips that block this thread, so on a loaded machine the ~240 statements a first
 * run prepares can hold the event loop past 5 s; the next batch then goes out on a socket workerd has
 * already closed ("fetch failed", cause UND_ERR_SOCKET "other side closed") before D1 has read it. Only
 * that error is retried; any other error, and any wrong result, still fails the test.
 */
function retryClosedSocket(d1: D1Database): D1Database {
  const closedSocket = (err: unknown) => (err as { cause?: { code?: unknown } } | null)?.cause?.code === "UND_ERR_SOCKET";
  const batch: D1Database["batch"] = async (statements) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await d1.batch(statements);
      } catch (err) {
        if (attempt >= 3 || !closedSocket(err)) throw err;
        console.warn(`local D1: batch retried after workerd closed an idle socket (attempt ${attempt})`);
      }
    }
  };
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "batch") return batch;
      const v: unknown = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bars_5m").run();
  await kv.delete(BAR_ARCHIVE_STATUS_KEY);
});

const cal = new TradingCalendar();
const RUN = istAt("2026-10-07", "16:15"); // Wednesday, a trading day; bars that closed by 15:45 are settled

/** A full 09:15-15:25 session of 75 bars. */
const session = (date: string, level: number) => sessionFromCloses(date, Array.from({ length: 75 }, (_, i) => level + (i % 7) - 3 + i * 0.25), level, 1);

/** Around-the-clock 5-minute bars in [fromMs, toMs), like ES=F. */
function roundTheClock(fromMs: number, toMs: number, level: number): Candle[] {
  const out: Candle[] = [];
  for (let t = fromMs, i = 0; t < toMs; t += BAR_5M_MS, i++) out.push({ t, o: level + i * 0.25, h: level + i * 0.25 + 1, l: level + i * 0.25 - 1, c: level + i * 0.25 + 0.5, v: 100 + i });
  return out;
}

const NIFTY = [...session("2026-10-05", 24_000), ...session("2026-10-06", 24_100), ...session("2026-10-07", 24_200)];
const ES_HELD = roundTheClock(istAt("2026-10-05", "00:00"), istAt("2026-10-07", "16:15"), 7_000);
const ES_60D = roundTheClock(istAt("2026-10-01", "00:00"), istAt("2026-10-07", "16:15"), 6_990); // differs from the held copy where both have a bar

function fakeSource(held: Record<string, Candle[]>, opts: { failRefresh?: string } = {}) {
  let refreshes = 0;
  const source: BarSource = {
    refresh: async () => {
      refreshes++;
      if (opts.failRefresh) throw new Error(opts.failRefresh);
    },
    heldBars: () => held,
  };
  return { source, refreshes: () => refreshes };
}

function chartBody(symbol: string, candles: Candle[]): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { symbol, regularMarketTime: null, regularMarketPrice: null, gmtoffset: 19800, dataGranularity: "5m" },
          timestamp: candles.map((c) => c.t / 1000),
          indicators: { quote: [{ open: candles.map((c) => c.o), high: candles.map((c) => c.h), low: candles.map((c) => c.l), close: candles.map((c) => c.c), volume: candles.map((c) => c.v) }] },
        },
      ],
      error: null,
    },
  });
}

/** Fake Yahoo for the 60-day catch-up: serves `charts`, an empty chart for other symbols, errors for `fail`. */
function fakeYahoo(charts: Record<string, Candle[]>, fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const symbol = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    calls.push(`${symbol} ${url.searchParams.get("interval")} ${url.searchParams.get("range")}`);
    if (fail.has(symbol)) return new Response("upstream error", { status: 500 });
    return new Response(chartBody(symbol, charts[symbol] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function captureLogger() {
  const lines: { level: string; msg: string; data?: unknown }[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg, data) => lines.push({ level: "info", msg, data }),
    warn: (msg, data) => lines.push({ level: "warn", msg, data }),
    error: (msg, data) => lines.push({ level: "error", msg, data }),
  };
  return { logger, lines };
}

function deps(source: BarSource, over: Partial<BarArchiveDeps> = {}): BarArchiveDeps {
  return { db, kv, source, calendar: cal, logger: captureLogger().logger, now: () => RUN, fetchImpl: fakeYahoo({}).fetchImpl, ...over };
}

async function archived(symbol: string): Promise<(Candle & { source: string; firstSeenMs: number })[]> {
  const { results } = await db.prepare("SELECT t,o,h,l,c,v,oi,source,first_seen_ms FROM bars_5m WHERE symbol = ? ORDER BY t").bind(symbol).all<Record<string, number | string | null>>();
  return results.map((r) => {
    const c: Candle & { source: string; firstSeenMs: number } = { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v), source: String(r.source), firstSeenMs: Number(r.first_seen_ms) };
    if (r.oi !== null) c.oi = Number(r.oi);
    return c;
  });
}
const plain = (rows: (Candle & { source?: string; firstSeenMs?: number })[]): Candle[] => rows.map(({ t, o, h, l, c, v, oi }) => (oi === undefined ? { t, o, h, l, c, v } : { t, o, h, l, c, v, oi }));
const settledBy = (bars: Candle[], at: number) => bars.filter((c) => c.t + BAR_5M_MS <= at - 30 * 60_000);
const countRows = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM bars_5m").first<{ n: number }>())?.n ?? 0);
const kvStatus = async () => (await kv.get(BAR_ARCHIVE_STATUS_KEY, "json")) as BarArchiveStatus | null;

describe("runBarArchive (nightly job)", () => {
  it("first run writes every settled bar the source holds, a cross asset gets Yahoo's 60 days; a second run changes nothing", async () => {
    const { source } = fakeSource({ "^NSEI": NIFTY, "ES=F": ES_HELD });
    const yahoo = fakeYahoo({ "ES=F": ES_60D });
    const first = await runBarArchive(deps(source, { fetchImpl: yahoo.fetchImpl }));

    expect(first.errors).toEqual([]);
    expect(first.ok).toBe(true);
    expect(await archived("^NSEI")).toEqual(NIFTY.map((c) => ({ ...c, source: ENGINE_SOURCE, firstSeenMs: RUN })));
    // ES=F: 60-day bars before the held window, the held copy where both exist, nothing that closed after 15:45.
    const esExpected = settledBy([...ES_60D.filter((c) => c.t < ES_HELD[0].t), ...ES_HELD], RUN);
    expect(plain(await archived("ES=F"))).toEqual(esExpected);
    expect(first.symbols["ES=F"]).toMatchObject({ new: esExpected.length, added: esExpected.length, revisions: 0, lastBar: "2026-10-07 15:40:00 IST" });
    expect(first.symbols["^NSEI"]).toMatchObject({ new: 225, added: 225, lastBar: "2026-10-07 15:25:00 IST" });
    expect(first.new).toBe(225 + esExpected.length);
    expect(first.added).toBe(first.new);
    // Every cross asset had nothing archived, so each got one 60-day request.
    expect([...first.fetched60d].sort()).toEqual([...CROSS_ASSET_SYMBOLS].sort());
    expect(yahoo.calls.filter((c) => c === "ES=F 5m 60d")).toHaveLength(1);
    expect(first.settledBefore).toBe(istIso(RUN - 30 * 60_000));
    expect(await kvStatus()).toEqual(first);

    const rows = await countRows();
    const second = await runBarArchive(deps(source, { fetchImpl: yahoo.fetchImpl }));
    expect(second).toMatchObject({ ok: true, new: 0, added: 0, revisions: 0, gaps: [] });
    expect(second.fetched60d).not.toContain("ES=F"); // its archive now reaches into the held window
    expect(await countRows()).toBe(rows);
    expect(second.lastOkAt).toBe(second.ranAt);
  });

  it("never rewrites an archived bar: a fresh copy that differs is counted and logged as a revision", async () => {
    const held: Record<string, Candle[]> = { "^NSEI": NIFTY.map((c) => ({ ...c })) };
    await runBarArchive(deps(fakeSource(held).source));
    const before = await archived("^NSEI");

    const i7 = 75 * 2 + 10; // 2026-10-07 10:05
    held["^NSEI"][i7] = { ...held["^NSEI"][i7], c: held["^NSEI"][i7].c + 1 };
    held["^NSEI"][i7 + 10] = { ...held["^NSEI"][i7 + 10], v: 5 };
    held["^NSEI"][3] = { ...held["^NSEI"][3], c: 1 }; // 2026-10-05: before the comparison window
    const { logger, lines } = captureLogger();
    const later = await runBarArchive(deps(fakeSource(held).source, { logger, now: () => RUN + 10 * 60_000 }));
    expect(later).toMatchObject({ ok: true, new: 0, added: 0, revisions: 2 });
    expect(await archived("^NSEI")).toEqual(before);
    const warn = lines.find((l) => l.msg.startsWith("bar archive: revised bars"));
    expect(warn?.data).toMatchObject({ symbol: "^NSEI", count: 2 });

    // full: compares everything the source holds, so the older revision is found too; still nothing rewritten.
    const full = await runBarArchive(deps(fakeSource(held).source), { full: true });
    expect(full).toMatchObject({ ok: true, full: true, added: 0, revisions: 3 });
    expect(await archived("^NSEI")).toEqual(before);
  });

  it("leaves still-forming bars for the next run and catches up a missed night", async () => {
    const mon = istAt("2026-10-05", "16:15");
    const first = await runBarArchive(deps(fakeSource({ "^NSEI": session("2026-10-05", 24_000), "ES=F": ES_HELD.filter((c) => c.t < mon) }).source, { now: () => mon, fetchImpl: fakeYahoo({ "ES=F": [] }).fetchImpl }));
    expect(first.symbols["^NSEI"].added).toBe(75);
    expect((await archived("ES=F")).at(-1)!.t).toBe(istAt("2026-10-05", "15:40"));

    // Tuesday's run never happened; Wednesday's writes Tuesday and Wednesday.
    const wed = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY, "ES=F": ES_HELD }).source));
    expect(wed.symbols["^NSEI"]).toMatchObject({ new: 150, added: 150, revisions: 0 });
    expect(plain(await archived("^NSEI"))).toEqual(NIFTY);
    expect(plain(await archived("ES=F"))).toEqual(settledBy(ES_HELD, RUN));
    expect(wed.fetched60d).not.toContain("ES=F");
  });

  it("skips non-trading days unless forced", async () => {
    for (const day of ["2026-10-02", "2026-10-10"]) {
      const src = fakeSource({ "^NSEI": NIFTY });
      const s = await runBarArchive(deps(src.source, { now: () => istAt(day, "16:15") }));
      expect(s.ok).toBe(true);
      expect(s.skipped).toMatch(/not a trading day/);
      expect(src.refreshes()).toBe(0);
      expect(await countRows()).toBe(0);
      expect((await kvStatus())?.skipped).toBe(s.skipped);
    }
    const forced = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY }).source, { now: () => istAt("2026-10-10", "16:15") }), { force: true });
    expect(forced).toMatchObject({ ok: true, skipped: null, added: 225 });
  });

  it("contains every failure: logged, recorded in KV with the last success kept, never thrown", async () => {
    const ok = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY }).source));
    expect(ok.lastOkAt).toBe(ok.ranAt);

    // The market-data refresh fails.
    const a = captureLogger();
    const s1 = await runBarArchive(deps(fakeSource({}, { failRefresh: "yahoo down" }).source, { logger: a.logger, now: () => RUN + 60_000 }));
    expect(s1).toMatchObject({ ok: false, errors: ["yahoo down"], lastOkAt: ok.ranAt });
    expect(a.lines.some((l) => l.level === "error" && l.msg === "bar archive failed")).toBe(true);
    expect(await kvStatus()).toEqual(s1);

    // D1 fails mid-run.
    const brokenDb = { prepare: (q: string) => db.prepare(q), batch: async () => Promise.reject(new Error("D1_ERROR: database unavailable")) } as unknown as D1Database;
    const s2 = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY }).source, { db: brokenDb }));
    expect(s2).toMatchObject({ ok: false, errors: ["D1_ERROR: database unavailable"], lastOkAt: ok.ranAt });

    // KV fails: the run still completes and says so in the logs.
    const b = captureLogger();
    const brokenKv = { get: async () => Promise.reject(new Error("kv down")), put: async () => Promise.reject(new Error("kv down")) } as unknown as KVNamespace;
    const s3 = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY }).source, { kv: brokenKv, logger: b.logger }));
    expect(s3.ok).toBe(true);
    expect(b.lines.some((l) => l.level === "error" && l.msg === "bar archive: status not saved")).toBe(true);

    // One cross asset's catch-up fetch fails: the others are still written.
    const yahoo = fakeYahoo({ "GC=F": ES_60D }, new Set(["ES=F"]));
    const s4 = await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY }).source, { fetchImpl: yahoo.fetchImpl }));
    expect(s4.ok).toBe(false);
    expect(s4.errors).toHaveLength(1);
    expect(s4.errors[0]).toMatch(/^ES=F 60d fetch: /);
    expect(s4.symbols["GC=F"].added).toBe(settledBy(ES_60D, RUN).length);

    // The cron's fallback when the DO call itself fails.
    await recordBarArchiveFailure(kv, "engine DO call failed: overloaded", RUN + 120_000, captureLogger().logger);
    expect(await kvStatus()).toMatchObject({ ok: false, errors: ["engine DO call failed: overloaded"], lastOkAt: s4.lastOkAt });
  });
});

describe("back-fill SQL and export against D1", () => {
  const run: SqlRunner = async (statements) => (await db.batch(statements.map((s) => db.prepare(s)))).map((r) => (r.results ?? []) as Record<string, unknown>[]);
  /** Splits a generated SQL file into statements (each ends with ";" at the end of a line). */
  const statementsOf = (sql: string) =>
    sql
      .split(/;\n/)
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);

  it("inserts exactly the settled bars of a JSON archive, again and again, without touching archived ones", async () => {
    // The engine archived one bar first, with different values.
    const engineCopy = { ...NIFTY[80], c: NIFTY[80].c + 7 };
    await db.prepare("INSERT INTO bars_5m (symbol,t,o,h,l,c,v,oi,source,first_seen_ms) VALUES (?,?,?,?,?,?,?,?,?,?)").bind("^NSEI", engineCopy.t, engineCopy.o, engineCopy.h, engineCopy.l, engineCopy.c, 0, null, ENGINE_SOURCE, 1).run();

    const savedAt = new Date(RUN).toISOString();
    const es = roundTheClock(istAt("2026-10-07", "12:00"), istAt("2026-10-07", "16:00"), 7_000).map((c, i) => (i === 2 ? { ...c, oi: 12_345 } : c));
    const plan = backfillRows({ source: "yahoo 5m archive", savedAt, candles: { "^NSEI": NIFTY, "ES=F": es }, archive: { captures: [{ fetchedAt: savedAt }] } });
    const files = backfillSqlFiles(plan.rows, { rowsPerFile: 100, rowsPerStatement: 17 });
    expect(files.length).toBe(Math.ceil(plan.rows.length / 100));

    let changes = 0;
    for (const f of files) for (const s of statementsOf(f.sql)) changes += (await db.prepare(s).run()).meta.changes;
    expect(changes).toBe(plan.rows.length - 1); // the engine's bar was ignored
    const got = await readArchivedBars(run);
    expect(got["^NSEI"]).toEqual(NIFTY.map((c) => (c.t === engineCopy.t ? { ...engineCopy, v: 0 } : c)));
    expect(got["ES=F"]).toEqual(settledBy(es, RUN));
    expect((await archived("^NSEI")).filter((r) => r.source === BACKFILL_SOURCE)).toHaveLength(224);

    let again = 0;
    for (const f of files) for (const s of statementsOf(f.sql)) again += (await db.prepare(s).run()).meta.changes;
    expect(again).toBe(0);
    expect(await countRows()).toBe(plan.rows.length);
  });

  it("exports what the nightly job archived, page by page, in the snapshot format the backtest replays", async () => {
    await runBarArchive(deps(fakeSource({ "^NSEI": NIFTY, "ES=F": ES_HELD }).source, { fetchImpl: fakeYahoo({ "ES=F": [] }).fetchImpl }));
    const all = await readArchivedBars(run, { pageRows: 40, statementsPerCall: 3 });
    expect(Object.keys(all).sort()).toEqual(["ES=F", "^NSEI"]);
    expect(all["^NSEI"]).toEqual(NIFTY);
    expect(all["ES=F"]).toEqual(settledBy(ES_HELD, RUN));

    const oneDay = await readArchivedBars(run, { symbols: ["^NSEI"], fromMs: istAt("2026-10-06", "00:00"), toMs: istAt("2026-10-07", "00:00") });
    expect(oneDay).toEqual({ "^NSEI": NIFTY.slice(75, 150) });

    const snap = JSON.parse(JSON.stringify(historySnapshot(all, { source: "d1 bars_5m archive (local)", savedAt: new Date(RUN).toISOString() })));
    expect(snap).toEqual({ source: "d1 bars_5m archive (local)", savedAt: new Date(RUN).toISOString(), candles: { "ES=F": all["ES=F"], "^NSEI": NIFTY }, daily: {}, errors: [] });
  });
});
