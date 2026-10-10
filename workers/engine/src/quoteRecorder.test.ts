/**
 * The quote recorder against a real local D1 and KV (Miniflare via wrangler's getPlatformProxy) with the
 * committed migrations applied, and a mocked Groww client: the real GrowwDataClient and parsers over a fake
 * transport, on a fake clock.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { GrowwDataClient, GrowwError, type GrowwTransport, type RequestOptions } from "../../../src/engine/broker/groww";
import { TradingCalendar } from "../../../src/engine/calendar/calendar";
import { istAt } from "../../../src/engine/clock";
import { DEFAULT_CONFIG } from "../../../src/engine/config";
import { InstrumentMaster } from "../../../src/engine/instruments/instrumentMaster";
import { syntheticInstrumentRows } from "../../../src/engine/instruments/syntheticInstruments";
import { quoteRowFromDb, type QuoteRow } from "../../../src/engine/market/quoteRecorder";
import type { Logger } from "../../../src/engine/ports";
import { QUOTE_RECORDER_STATUS_KEY, QuoteRecorder, writeQuoteRows, type QuoteRecorderDeps, type QuoteRecorderStatus, type RecorderState } from "./quoteRecorder";

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; KV: KVNamespace }>>>;
let proxy: Proxy;
let db: D1Database;
let kv: KVNamespace;

const migrationsDir = new URL("../../../migrations/", import.meta.url);

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database; KV: KVNamespace }>({ configPath: "workers/engine/wrangler.jsonc", persist: false, remoteBindings: false });
  db = proxy.env.DB;
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

beforeEach(async () => {
  await db.prepare("DELETE FROM option_quotes").run();
  await kv.delete(QUOTE_RECORDER_STATUS_KEY);
});

const cal = new TradingCalendar();
const MON = "2026-10-12";

const instrumentRows = [
  ...syntheticInstrumentRows("NIFTY", ["2026-10-13", "2026-10-19", "2026-10-27"], 24_500, 30, DEFAULT_CONFIG),
  ...syntheticInstrumentRows("SENSEX", ["2026-10-15", "2026-10-22"], 81_000, 30, DEFAULT_CONFIG),
];
const instruments = new InstrumentMaster(instrumentRows, DEFAULT_CONFIG);
const contractOf = new Map(instrumentRows.map((r) => [r.tradingSymbol, r]));

/** A fake clock that sleep() advances, and a fake Groww behind the real GrowwDataClient. */
function harness(startMs: number) {
  const g = {
    t: startMs,
    spot: { NIFTY: 24_512.3, SENSEX: 81_049.5 } as Record<string, number>,
    ltpError: null as Error | null,
    quoteError: null as Error | null,
    failSymbols: new Set<string>(),
    /** Fake time each quote call takes. */
    latencyMs: 40,
    calls: [] as { path: string; symbol: string | null; at: number }[],
    sleeps: [] as number[],
  };
  const transport: GrowwTransport = {
    request: async <T,>(_method: "GET" | "POST", path: string, o: RequestOptions = {}): Promise<T> => {
      const symbol = (o.query?.trading_symbol as string | undefined) ?? null;
      g.calls.push({ path, symbol, at: g.t });
      if (path === "/live-data/ltp") {
        if (g.ltpError) throw g.ltpError;
        return { NSE_NIFTY: g.spot.NIFTY, BSE_SENSEX: g.spot.SENSEX, NSE_BANKNIFTY: 52_000 } as T;
      }
      g.t += g.latencyMs;
      if (g.quoteError) throw g.quoteError;
      if (symbol && g.failSymbols.has(symbol)) throw new GrowwError("Groww GET /live-data/quote: upstream error", "transient", 500);
      const c = contractOf.get(symbol ?? "")!;
      const spot = g.spot[c.underlyingSymbol];
      const price = Math.round((Math.max(0, c.instrumentType === "CE" ? spot - c.strikePrice : c.strikePrice - spot) + 100) * 20) / 20;
      return {
        last_price: price,
        bid_price: price - 0.25,
        offer_price: price + 0.25,
        bid_quantity: 650,
        offer_quantity: 975,
        volume: 123_450,
        open_interest: 2_500_000,
        last_trade_time: g.t - 700,
        depth: {
          buy: [0, 1, 2, 3, 4].map((i) => ({ price: price - 0.25 - i * 0.05, quantity: 650 + i })),
          sell: [0, 1, 2, 3, 4].map((i) => ({ price: price + 0.25 + i * 0.05, quantity: 975 + i })),
        },
      } as T;
    },
  };
  const data = new GrowwDataClient(transport, () => g.t);
  const lines: { level: string; msg: string; data?: unknown }[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg, d) => lines.push({ level: "info", msg, data: d }),
    warn: (msg, d) => lines.push({ level: "warn", msg, data: d }),
    error: (msg, d) => lines.push({ level: "error", msg, data: d }),
  };
  const box: { state: RecorderState | null } = { state: null };
  const alerts: string[] = [];
  const deps = (over: Partial<QuoteRecorderDeps> = {}): QuoteRecorderDeps => ({
    db,
    kv,
    state: {
      get: async () => (box.state ? structuredClone(box.state) : null),
      put: async (s) => {
        box.state = structuredClone(s);
      },
    },
    source: data,
    instruments,
    calendar: async () => cal,
    indices: ["NIFTY", "SENSEX"],
    logger,
    alert: async (text) => {
      alerts.push(text);
    },
    now: () => g.t,
    sleep: async (ms) => {
      g.sleeps.push(ms);
      g.t += ms;
    },
    ...over,
  });
  return { g, data, lines, box, alerts, deps };
}

async function rows(where = "1=1"): Promise<QuoteRow[]> {
  const { results } = await db.prepare(`SELECT * FROM option_quotes WHERE ${where} ORDER BY snapshot_ms, trading_symbol`).all<Record<string, unknown>>();
  return results.map(quoteRowFromDb);
}
const kvStatus = async () => (await kv.get(QUOTE_RECORDER_STATUS_KEY, "json")) as QuoteRecorderStatus | null;

describe("QuoteRecorder (read-only snapshots of Groww quotes)", () => {
  it("records an open-window snapshot: ATM and two strikes each side, calls and puts, both indices, calls 300 ms apart", async () => {
    const h = harness(istAt(MON, "09:15") + 20_000);
    const rec = new QuoteRecorder(h.deps());
    expect(rec.wants(h.g.t)).toBe(true);
    const started = h.g.t;
    const s = (await rec.run())!;
    expect(s).toMatchObject({ ok: true, configured: true, slot: "open", snapshotMs: started, planned: 20, quotes: 20, rowsWritten: 20, requests: 21, errors: [], errorCount: 0, consecutiveFailures: 0 });
    expect(s.spot).toEqual({ NIFTY: 24_512.3, SENSEX: 81_049.5 });
    expect(await kvStatus()).toEqual(s);

    const got = await rows();
    expect(got).toHaveLength(20);
    expect([...new Set(got.filter((r) => r.indexId === "NIFTY").map((r) => r.strike))]).toEqual([24_400, 24_450, 24_500, 24_550, 24_600]);
    expect([...new Set(got.filter((r) => r.indexId === "SENSEX").map((r) => r.strike))]).toEqual([80_800, 80_900, 81_000, 81_100, 81_200]);
    const ce = got.find((r) => r.tradingSymbol === "NIFTY26O1324500CE")!;
    expect(ce).toMatchObject({ snapshotMs: started, slot: "open", expiry: "2026-10-13", expiryKind: "next", optionType: "CE", lotSize: 65, bid: 112.05, ask: 112.55, ltp: 112.3, bidQty: 650, askQty: 975, volume: 123_450, oi: 2_500_000, spot: 24_512.3, source: "groww:live-data/quote", schemaV: 1 });
    expect(ce.lastTradeMs).toBe(ce.fetchedMs - 700);
    expect(JSON.parse(ce.depth!).b).toHaveLength(5);
    expect(got.find((r) => r.indexId === "SENSEX")).toMatchObject({ lotSize: 20, expiry: "2026-10-15" });

    // The at-the-money legs first; every quote call starts at least 300 ms after the one before.
    const quotes = h.g.calls.filter((c) => c.path === "/live-data/quote");
    expect(quotes.slice(0, 4).map((c) => c.symbol)).toEqual(["NIFTY26O1324500CE", "NIFTY26O1324500PE", "SENSEX26O1581000CE", "SENSEX26O1581000PE"]);
    for (let i = 1; i < quotes.length; i++) expect(quotes[i].at - quotes[i - 1].at).toBeGreaterThanOrEqual(300);
    expect(h.g.calls[0].path).toBe("/live-data/ltp");

    // The next tick 5 s later takes no snapshot (20 s spacing); the one 30 s later does.
    h.g.t = started + 5_000;
    expect(await rec.run()).toBeNull();
    h.g.t = started + 30_000;
    expect((await rec.run())?.rowsWritten).toBe(20);
    expect(await rows()).toHaveLength(40);
  });

  it("is idempotent: the same snapshot written again adds no row", async () => {
    const h = harness(istAt(MON, "09:16") + 10_000);
    const rec = new QuoteRecorder(h.deps());
    await rec.run();
    const first = await rows();
    expect(await writeQuoteRows(db, first)).toBe(0);
    // A manual snapshot at the very same instant has the same keys: nothing is written twice.
    h.g.t = first[0].snapshotMs;
    const again = (await rec.run({ manual: true }))!;
    expect(again).toMatchObject({ slot: "manual", quotes: 20, rowsWritten: 0 });
    expect(await rows()).toEqual(first);
  });

  it("on an expiry day records the contract expiring today as well, labelled", async () => {
    const h = harness(istAt("2026-10-13", "09:20") + 5_000); // NIFTY's weekly expires on Tuesday 13 Oct
    const s = (await new QuoteRecorder(h.deps()).run())!;
    expect(s).toMatchObject({ ok: true, planned: 30, rowsWritten: 30 });
    const got = await rows();
    const count = (index: string, kind: string, expiry: string) => got.filter((r) => r.indexId === index && r.expiryKind === kind && r.expiry === expiry).length;
    expect(count("NIFTY", "expiring", "2026-10-13")).toBe(10);
    expect(count("NIFTY", "next", "2026-10-19")).toBe(10);
    expect(count("SENSEX", "next", "2026-10-15")).toBe(10);
  });

  it("records the morning's strikes again at 15:00 and 15:20 for the buy-back, and each fixed slot once", async () => {
    const h = harness(istAt(MON, "09:15") + 30_000);
    const rec = new QuoteRecorder(h.deps());
    await rec.run(); // entry snapshot: NIFTY at the money 24,500
    h.g.spot.NIFTY = 24_830; // the market rallied
    h.g.t = istAt(MON, "15:00") + 8_000;
    const s = (await rec.run())!;
    expect(s.slot).toBe("15:00");
    const nifty = await rows(`slot = '15:00' AND index_id = 'NIFTY'`);
    expect([...new Set(nifty.map((r) => r.strike))].sort()).toEqual([24_500, 24_750, 24_800, 24_850, 24_900, 24_950]);
    expect(nifty).toHaveLength(12);
    expect(h.box.state?.day.slotsDone).toEqual(["15:00"]);
    h.g.t = istAt(MON, "15:02");
    expect(await rec.run()).toBeNull();
    h.g.t = istAt(MON, "15:20") + 3_000;
    expect((await rec.run())?.slot).toBe("15:20");
    expect((await rows(`slot = '15:20' AND index_id = 'NIFTY' AND strike = 24500`)).length).toBe(2);
  });

  it("isolates failures: a failed quote is skipped and counted, the rest is written", async () => {
    const h = harness(istAt(MON, "09:20") + 1_000);
    h.g.failSymbols.add("NIFTY26O1324550PE");
    const s = (await new QuoteRecorder(h.deps()).run())!;
    expect(s).toMatchObject({ ok: false, quotes: 19, rowsWritten: 19, errorCount: 1, consecutiveFailures: 0 });
    expect(s.errors[0]).toMatch(/^NIFTY26O1324550PE: Groww GET \/live-data\/quote: upstream error/);
    expect(s.today).toMatchObject({ snapshots: 1, rowsWritten: 19, errors: 1, requests: 21 });
    expect(s.lastError?.message).toMatch(/NIFTY26O1324550PE/);
    expect(await rows()).toHaveLength(19);
  });

  it("stops a snapshot on an auth failure, counts failed snapshots and alerts once a day after three", async () => {
    const h = harness(istAt(MON, "09:15") + 15_000);
    const rec = new QuoteRecorder(h.deps());
    h.g.ltpError = new GrowwError("Groww token: minting paused for 300 s after 1 failed attempt(s): bad TOTP", "auth", 0);
    for (let i = 1; i <= 4; i++) {
      const s = (await rec.run())!;
      expect(s).toMatchObject({ ok: false, rowsWritten: 0, requests: 1, consecutiveFailures: i });
      expect(s.errors.at(-1)).toMatch(/minting paused/);
      h.g.t += 30_000;
    }
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatch(/Quote recorder \(recording only, no orders\): 3 snapshots in a row failed/);
    expect(h.lines.some((l) => l.level === "error" && l.msg === "quote snapshot failed")).toBe(true);

    // An auth failure in the middle of a snapshot stops it: the other calls would fail the same way.
    h.g.ltpError = null;
    h.g.quoteError = new GrowwError("Groww GET /live-data/quote: unauthorised (GA005)", "auth", 401);
    const mid = (await rec.run())!;
    expect(mid).toMatchObject({ rowsWritten: 0, requests: 2, consecutiveFailures: 5 });
    expect(mid.errors).toEqual([expect.stringMatching(/unauthorised/), "snapshot stopped: 19 contract(s) not quoted"]);
    h.g.quoteError = null;
    h.g.t += 30_000;
    expect(await rec.run()).toMatchObject({ ok: true, consecutiveFailures: 0, rowsWritten: 20 });
  });

  it("never throws: D1, KV and its own storage can all fail", async () => {
    const h = harness(istAt(MON, "09:25"));
    const brokenDb = { prepare: (q: string) => db.prepare(q), batch: async () => Promise.reject(new Error("D1_ERROR: database unavailable")) } as unknown as D1Database;
    const s1 = (await new QuoteRecorder(h.deps({ db: brokenDb })).run())!;
    expect(s1).toMatchObject({ ok: false, quotes: 20, rowsWritten: 0, consecutiveFailures: 1 });
    expect(s1.errors).toEqual(["D1_ERROR: database unavailable"]);

    const brokenKv = { get: async () => Promise.reject(new Error("kv down")), put: async () => Promise.reject(new Error("kv down")) } as unknown as KVNamespace;
    const brokenState = { get: async () => Promise.reject(new Error("storage down")), put: async () => Promise.reject(new Error("storage down")) };
    const h2 = harness(istAt(MON, "09:26"));
    const s2 = (await new QuoteRecorder(h2.deps({ kv: brokenKv, state: brokenState })).run())!;
    expect(s2).toMatchObject({ ok: true, rowsWritten: 20 });
    expect(h2.lines.filter((l) => l.level !== "info").map((l) => l.msg)).toEqual(["quote recorder: state unavailable, starting fresh", "quote recorder: state not saved", "quote recorder: status not saved"]);

    const h3 = harness(istAt(MON, "09:27"));
    const s3 = (await new QuoteRecorder(h3.deps({ calendar: async () => Promise.reject(new Error("settings read failed")) })).run())!;
    expect(s3.rowsWritten).toBe(20); // the bundled holiday calendar is used instead
  });

  it("without a Groww client records nothing and says why, once a day (and on a manual call)", async () => {
    const h = harness(istAt(MON, "09:15") + 10_000);
    const rec = new QuoteRecorder(h.deps({ source: null }));
    const s = (await rec.run())!;
    expect(s).toMatchObject({ ok: true, configured: false, slot: "open", rowsWritten: 0, requests: 0 });
    expect(s.skipped).toMatch(/^Groww is not configured \(GROWW_API_KEY and GROWW_TOTP_SECRET are not set\)/);
    expect(await kvStatus()).toEqual(s);
    h.g.t += 30_000;
    expect(await rec.run()).toBeNull();
    expect((await rec.run({ manual: true }))?.skipped).toMatch(/not configured/);
    expect(await rows()).toEqual([]);
    expect(h.g.calls).toEqual([]);
  });

  it("does nothing on holidays or between slots", async () => {
    const h = harness(istAt("2026-10-20", "09:20")); // Dussehra
    const rec = new QuoteRecorder(h.deps());
    expect(rec.wants(h.g.t)).toBe(true); // the clock pre-check only knows the time of day
    expect(await rec.run()).toBeNull();
    h.g.t = istAt(MON, "12:00");
    expect(rec.wants(h.g.t)).toBe(false);
    expect(await rec.run()).toBeNull();
    expect(h.g.calls).toEqual([]);
    expect(await kvStatus()).toBeNull();
  });

  it("stops asking Groww when a snapshot runs past its time budget", async () => {
    const h = harness(istAt(MON, "09:28"));
    h.g.latencyMs = 2_000;
    const s = (await new QuoteRecorder(h.deps()).run())!;
    // Calls start at 0.3, 2.3, ... 24.3 s: thirteen fit before 25 s.
    expect(s.quotes).toBe(13);
    expect(s.rowsWritten).toBe(13);
    expect(s.errors).toEqual(["time budget of 25 s reached: 7 contract(s) not quoted"]);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("runs one snapshot at a time: concurrent calls share it", async () => {
    const h = harness(istAt(MON, "09:29"));
    const rec = new QuoteRecorder(h.deps());
    const a = rec.run();
    expect(rec.wants(h.g.t)).toBe(false);
    const b = rec.run({ manual: true });
    expect(b).toBe(a);
    await a;
    expect(await rows()).toHaveLength(20);
    expect(rec.wants(h.g.t)).toBe(true);
  });
});
