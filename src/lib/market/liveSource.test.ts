import { beforeEach, describe, expect, it } from "vitest";
import { istAt } from "@/engine/clock";
import { bar, chartJson, RECORDED, recordedBars, type RawBar } from "./__fixtures__/liveFixtures";
import { __resetLiveSourceForTests, getLiveFeed, getNiftyCharts, IDLE_TTL_MS, LIVE_TTL_MS, plainReason, PREV_CLOSE_TTL_MS, STALE_OK_MS } from "./liveSource";

type Body = unknown | "fail" | "timeout" | "hang";

/** A fake Yahoo: responses keyed "<symbol> <interval>", replaceable between calls; logs every request. */
function fakeYahoo(initial: Record<string, Body> = RECORDED) {
  const routes = new Map<string, Body>(Object.entries(initial));
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const key = `${decodeURIComponent(url.pathname.split("/").pop()!)} ${url.searchParams.get("interval")}`;
    calls.push(key);
    await new Promise((r) => setTimeout(r, 5)); // overlapping requests really overlap
    const body = routes.get(key);
    if (body === "hang") return new Promise<Response>(() => {}); // never settles, not even on abort
    if (body === "timeout") throw new Error("The operation was aborted due to timeout");
    if (body === undefined || body === "fail") {
      return new Response(JSON.stringify({ chart: { result: null, error: { code: "Too Many Requests", description: "rate limited" } } }), { status: 429 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, routes };
}

const ist = (date: string, hm: string, s = 0) => istAt(date, hm) + s * 1000;

/**
 * The recorded 2026-10-08 session cut at `hm` and served as Yahoo would during the session. (The India VIX
 * recording keeps only its last bars, so its morning is one bar at its recorded 09:29 close, 14.0925.)
 */
function sessionAt(key: "^NSEI" | "^BSESN" | "^INDIAVIX", hm: string, s = 30) {
  const rows = key === "^INDIAVIX" ? [bar("2026-10-08", hm, 14.0925)] : recordedBars(`${key} 1m`).filter((b) => b.t <= istAt("2026-10-08", hm));
  const last = rows[rows.length - 1].c!;
  return chartJson(key, "1m", rows, {
    regularMarketPrice: last,
    regularMarketTime: Math.floor(ist("2026-10-08", hm, s) / 1000),
    regularMarketDayHigh: Math.max(...rows.map((b) => b.h!)),
    regularMarketDayLow: Math.min(...rows.map((b) => b.l!)),
  });
}

beforeEach(() => __resetLiveSourceForTests());

describe("getLiveFeed: payload", () => {
  it("before the 2026-10-09 open: the 2026-10-08 session, change against 2026-10-07, phase PRE_OPEN", async () => {
    const yahoo = fakeYahoo();
    const now = ist("2026-10-09", "09:05");
    const r = await getLiveFeed({ nowMs: now, fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    const f = r.feed;
    expect(f).toMatchObject({ marketPhase: "PRE_OPEN", stale: false, missing: [], holidayName: null, nextOpenAt: "2026-10-09T09:15:00+05:30" });
    expect(f.generatedAt).toBe(new Date(now).toISOString());
    expect(f.fetchedAt).toBe(new Date(now).toISOString());
    expect(f.source).toMatch(/Yahoo Finance/);
    expect(f.indices.map((i) => i.index)).toEqual(["NIFTY", "SENSEX"]);
    const [n, s] = f.indices;
    expect(n).toMatchObject({ session: "2026-10-08", price: 22231.8, prevClose: 22603.05, change: -371.25, changePct: -1.642, low: 22179.9, stale: false });
    expect(n.bars).toHaveLength(376);
    expect(n.openingRange).toEqual({ high: 22599.05, low: 22475.85 });
    expect(s).toMatchObject({ session: "2026-10-08", price: 71593.24, prevClose: 72638.7, change: -1045.46, high: 72693.97, low: 71327.75 });
    expect(f.vix).toMatchObject({ price: 15.275, prevClose: 13.89, change: 1.385, stale: false });
    // Three 1-minute charts and three daily charts.
    expect(yahoo.calls.sort()).toEqual(["^BSESN 1d", "^BSESN 1m", "^INDIAVIX 1d", "^INDIAVIX 1m", "^NSEI 1d", "^NSEI 1m"]);
  });

  it("in the session: today's bars so far, VWAP, the opening range once 09:30 is in", async () => {
    const yahoo = fakeYahoo({ ...RECORDED, "^NSEI 1m": sessionAt("^NSEI", "09:29"), "^BSESN 1m": sessionAt("^BSESN", "09:29"), "^INDIAVIX 1m": sessionAt("^INDIAVIX", "09:29") });
    const early = await getLiveFeed({ nowMs: ist("2026-10-08", "09:29", 50), fetchImpl: yahoo.fetchImpl });
    if (!early.ok) throw new Error(early.error);
    expect(early.feed.marketPhase).toBe("OPEN");
    const n = early.feed.indices[0];
    expect(n).toMatchObject({ session: "2026-10-08", price: 22504.1, prevClose: 22603.05, change: -98.95, openingRange: null, asOf: "2026-10-08T09:29:30+05:30" });
    expect(n.bars).toHaveLength(15);
    expect(n.vwap).not.toBeNull();

    for (const k of ["^NSEI", "^BSESN", "^INDIAVIX"] as const) yahoo.routes.set(`${k} 1m`, sessionAt(k, "09:31"));
    const later = await getLiveFeed({ nowMs: ist("2026-10-08", "09:31", 40), fetchImpl: yahoo.fetchImpl });
    if (!later.ok) throw new Error(later.error);
    expect(later.feed.indices[0].openingRange).toEqual({ high: 22599.05, low: 22475.85 });
    expect(later.feed.indices[1].openingRange).toEqual({ high: 72693.97, low: 72254.23 });
  });

  it("on an exchange holiday: phase HOLIDAY with its name, the last session against the one before it", async () => {
    // 2026-10-02 (Gandhi Jayanti): Yahoo still serves the 2026-10-01 session.
    const d1 = recordedBars("^NSEI 1d").filter((b) => b.t < istAt("2026-10-02", "00:00"));
    const day: RawBar[] = [bar("2026-10-01", "09:15", 22543.7, 22560, 22540, 22550), bar("2026-10-01", "15:30", 22421.95)];
    const meta = { regularMarketPrice: 22421.95, regularMarketTime: Math.floor(ist("2026-10-01", "15:31", 26) / 1000), regularMarketDayHigh: 22610.6, regularMarketDayLow: 22217.3 };
    const yahoo = fakeYahoo({ "^NSEI 1m": chartJson("^NSEI", "1m", day, meta), "^NSEI 1d": chartJson("^NSEI", "1d", d1) });
    const r = await getLiveFeed({ nowMs: ist("2026-10-02", "11:00"), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    expect(r.feed).toMatchObject({ marketPhase: "HOLIDAY", holidayName: "Mahatma Gandhi Jayanti", nextOpenAt: "2026-10-05T09:15:00+05:30", missing: ["SENSEX"], vix: null });
    expect(r.feed.indices[0]).toMatchObject({ session: "2026-10-01", price: 22421.95, prevClose: 22620.45, change: -198.5 });
  });

  it("the Monday after a Friday holiday: the previous close is Thursday's", async () => {
    const d1 = recordedBars("^NSEI 1d").filter((b) => b.t < istAt("2026-10-05", "00:00")); // ..., 10-01, 10-02 (null row)
    const day = [bar("2026-10-05", "09:15", 22532.4, 22560, 22500, 22520), bar("2026-10-05", "09:16", 22520, 22530, 22510, 22525)];
    const meta = { regularMarketPrice: 22525, regularMarketTime: Math.floor(ist("2026-10-05", "09:16", 20) / 1000) };
    const yahoo = fakeYahoo({ "^NSEI 1m": chartJson("^NSEI", "1m", day, meta), "^NSEI 1d": chartJson("^NSEI", "1d", d1) });
    const r = await getLiveFeed({ nowMs: ist("2026-10-05", "09:16", 30), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    expect(r.feed.indices[0]).toMatchObject({ session: "2026-10-05", prevClose: 22421.95, change: 103.05 });
  });
});

describe("getLiveFeed: one shared upstream fetch", () => {
  it("serves concurrent requests from one fetch, reuses it for 1.5 s in the session, then fetches the 1-minute charts again", async () => {
    const yahoo = fakeYahoo();
    const t0 = ist("2026-10-08", "11:00");
    const [a, b, c] = await Promise.all([0, 0, 0].map(() => getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl })));
    expect(yahoo.calls).toHaveLength(6);
    expect(a).toEqual(b);
    expect(b).toEqual(c);

    await getLiveFeed({ nowMs: t0 + LIVE_TTL_MS - 1, fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls).toHaveLength(6);
    const again = await getLiveFeed({ nowMs: t0 + LIVE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    // Only the 1-minute charts: the previous closes are good for 10 minutes.
    expect(yahoo.calls.slice(6).sort()).toEqual(["^BSESN 1m", "^INDIAVIX 1m", "^NSEI 1m"]);
    if (!again.ok) throw new Error(again.error);
    expect(again.feed.fetchedAt).toBe(new Date(t0 + LIVE_TTL_MS).toISOString());
    expect(again.feed.indices[0].prevClose).toBe(22603.05);
  });

  it("reuses a fetch for 60 s while the market is closed", async () => {
    const yahoo = fakeYahoo();
    const t0 = ist("2026-10-09", "00:41");
    await getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl });
    const r = await getLiveFeed({ nowMs: t0 + IDLE_TTL_MS - 1, fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls).toHaveLength(6);
    if (!r.ok) throw new Error(r.error);
    expect(r.feed).toMatchObject({ marketPhase: "CLOSED", fetchedAt: new Date(t0).toISOString(), generatedAt: new Date(t0 + IDLE_TTL_MS - 1).toISOString() });
    await getLiveFeed({ nowMs: t0 + IDLE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls).toHaveLength(9);
  });

  it("re-reads the daily charts at once when the last price moves to a new day; with no close anywhere the change stays unknown", async () => {
    const yahoo = fakeYahoo({ ...RECORDED, "^NSEI 5m": "fail" });
    const t0 = ist("2026-10-09", "09:10");
    await getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl });
    // 09:15 on 2026-10-09: Yahoo's daily chart still lacks the 2026-10-08 close (null) and the 5-minute chart fails.
    yahoo.routes.set("^NSEI 1m", firstBar("^NSEI", 22260));
    const r = await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30), fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls.filter((c) => c === "^NSEI 1d")).toHaveLength(2);
    if (!r.ok) throw new Error(r.error);
    expect(r.feed.indices[0]).toMatchObject({ session: "2026-10-09", price: 22260, prevClose: null, change: null, open: 22250 });
    expect(r.feed.indices[0].prevCloseSource).toBeUndefined();

    // Once Yahoo fills in the 2026-10-08 close, the next read (a minute later while unknown) picks it up.
    const d1 = recordedBars("^NSEI 1d").map((b) => (b.t === istAt("2026-10-08", "09:15") ? { ...b, c: 22231.80078125 } : b));
    yahoo.routes.set("^NSEI 1d", chartJson("^NSEI", "1d", d1));
    const mid = await getLiveFeed({ nowMs: ist("2026-10-09", "09:16", 0), fetchImpl: yahoo.fetchImpl });
    if (!mid.ok) throw new Error(mid.error);
    expect(mid.feed.indices[0].prevClose).toBeNull(); // not re-read yet
    const later = await getLiveFeed({ nowMs: ist("2026-10-09", "09:16", 31), fetchImpl: yahoo.fetchImpl });
    if (!later.ok) throw new Error(later.error);
    expect(later.feed.indices[0]).toMatchObject({ prevClose: 22231.8, change: 28.2, prevCloseSource: "daily" });
  });
});

/** The first 1-minute bar of Friday 2026-10-09 (open 22250 for NIFTY), quoted at 09:15:20. */
function firstBar(key: "^NSEI" | "^BSESN" | "^INDIAVIX", price: number) {
  const open = key === "^NSEI" ? 22250 : price;
  return chartJson(key, "1m", [bar("2026-10-09", "09:15", open, Math.max(open, price) + 10, Math.min(open, price) - 10, price)], {
    regularMarketPrice: price,
    regularMarketTime: Math.floor(ist("2026-10-09", "09:15", 20) / 1000),
  });
}

/** Yahoo at Friday's open: the first bars of 2026-10-09, while the daily charts still lack Thursday's close. */
function fridayOpen(yahoo: ReturnType<typeof fakeYahoo>) {
  yahoo.routes.set("^NSEI 1m", firstBar("^NSEI", 22260));
  yahoo.routes.set("^BSESN 1m", firstBar("^BSESN", 71650));
  yahoo.routes.set("^INDIAVIX 1m", firstBar("^INDIAVIX", 15.1));
}

describe("previous close from the 5-minute chart while the daily close is missing", () => {
  it("uses Thursday's last 5-minute bar at Friday's open, reads it once per session, and labels the source", async () => {
    const yahoo = fakeYahoo();
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:10"), fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls.filter((c) => c.endsWith(" 5m"))).toHaveLength(0); // the daily close was there for Thursday's session
    fridayOpen(yahoo);
    const r = await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    const [n, s] = r.feed.indices;
    expect(n).toMatchObject({ session: "2026-10-09", price: 22260, prevClose: 22231.8, change: 28.2, changePct: 0.127, prevCloseSource: "intraday" });
    expect(s).toMatchObject({ price: 71650, prevClose: 71593.24, change: 56.76, prevCloseSource: "intraday" });
    expect(r.feed.vix).toMatchObject({ price: 15.1, prevClose: 15.275, change: -0.175, prevCloseSource: "intraday" });
    // Read beside the daily charts at the day turn, then kept for the session.
    expect(yahoo.calls.filter((c) => c.endsWith(" 5m")).sort()).toEqual(["^BSESN 5m", "^INDIAVIX 5m", "^NSEI 5m"]);
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30) + LIVE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30) + PREV_CLOSE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    expect(yahoo.calls.filter((c) => c.endsWith(" 5m"))).toHaveLength(3);
  });

  it("gives null when the 5-minute chart's last bar before the session is from two sessions back", async () => {
    const noThursday = recordedBars("^NSEI 5m").filter((b) => b.t < istAt("2026-10-08", "00:00"));
    const yahoo = fakeYahoo({ ...RECORDED, "^NSEI 5m": chartJson("^NSEI", "5m", noThursday) });
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:10"), fetchImpl: yahoo.fetchImpl });
    fridayOpen(yahoo);
    const r = await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    expect(r.feed.indices[0]).toMatchObject({ prevClose: null, change: null, changePct: null });
    expect(r.feed.indices[0].prevCloseSource).toBeUndefined();
    expect(r.feed.indices[1]).toMatchObject({ prevClose: 71593.24, prevCloseSource: "intraday" }); // SENSEX's chart was fine
  });

  it("prefers the daily close when Yahoo has it, even if the 5-minute bar differs", async () => {
    const filled = recordedBars("^NSEI 1d").map((b) => (b.t === istAt("2026-10-08", "09:15") ? { ...b, c: 22231.80078125 } : b));
    const offBar = recordedBars("^NSEI 5m").map((b, i, all) => (i === all.length - 1 ? { ...b, c: 22225 } : b));
    const yahoo = fakeYahoo({ ...RECORDED, "^NSEI 1d": chartJson("^NSEI", "1d", filled), "^NSEI 5m": chartJson("^NSEI", "5m", offBar) });
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:10"), fetchImpl: yahoo.fetchImpl });
    fridayOpen(yahoo);
    const r = await getLiveFeed({ nowMs: ist("2026-10-09", "09:15", 30), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    expect(r.feed.indices[0]).toMatchObject({ prevClose: 22231.8, change: 28.2, prevCloseSource: "daily" });
  });

  it("moves to the daily close once Yahoo fills it in (at the next 10-minute read)", async () => {
    const yahoo = fakeYahoo();
    await getLiveFeed({ nowMs: ist("2026-10-09", "09:10"), fetchImpl: yahoo.fetchImpl });
    fridayOpen(yahoo);
    const t1 = ist("2026-10-09", "09:15", 30);
    const first = await getLiveFeed({ nowMs: t1, fetchImpl: yahoo.fetchImpl });
    if (!first.ok) throw new Error(first.error);
    expect(first.feed.indices[0]).toMatchObject({ prevClose: 22231.8, prevCloseSource: "intraday" });

    const filled = recordedBars("^NSEI 1d").map((b) => (b.t === istAt("2026-10-08", "09:15") ? { ...b, c: 22231.80078125 } : b));
    yahoo.routes.set("^NSEI 1d", chartJson("^NSEI", "1d", filled));
    const later = await getLiveFeed({ nowMs: t1 + PREV_CLOSE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    if (!later.ok) throw new Error(later.error);
    expect(later.feed.indices[0]).toMatchObject({ prevClose: 22231.8, prevCloseSource: "daily" });
    expect(later.feed.indices[1]).toMatchObject({ prevClose: 71593.24, prevCloseSource: "intraday" }); // SENSEX's daily still lacks it
  });
});

describe("getNiftyCharts (for /api/market/nifty)", () => {
  it("hands over NIFTY and India VIX from the same shared fetch, with the calendar-checked previous close", async () => {
    const yahoo = fakeYahoo();
    const now = ist("2026-10-09", "00:41");
    const [shared, feed] = await Promise.all([getNiftyCharts({ nowMs: now, fetchImpl: yahoo.fetchImpl }), getLiveFeed({ nowMs: now, fetchImpl: yahoo.fetchImpl })]);
    expect(yahoo.calls).toHaveLength(6);
    expect(shared.prevClose).toBe(22603.05);
    expect(shared.dayRange).toEqual({ high: 22599.05, low: 22179.9 });
    expect(shared.nifty?.symbol).toBe("^NSEI");
    expect(shared.nifty?.meta.previousClose).toBe(22776.1); // still in the chart, never used
    expect(shared.vix?.meta.regularMarketPrice).toBe(15.275);
    expect(shared.error).toBeNull();
    expect(feed.ok).toBe(true);
  });

  it("gives no chart when NIFTY failed in the latest fetch, with the reason", async () => {
    const yahoo = fakeYahoo();
    const t0 = ist("2026-10-08", "11:00");
    await getNiftyCharts({ nowMs: t0, fetchImpl: yahoo.fetchImpl });
    yahoo.routes.set("^NSEI 1m", "fail");
    const r = await getNiftyCharts({ nowMs: t0 + LIVE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    expect(r.nifty).toBeNull();
    expect(r.vix).not.toBeNull();
    expect(r.error).toMatch(/HTTP 429/);
  });
});

describe("getLiveFeed: failures", () => {
  it("lists an index that never loaded in `missing`", async () => {
    const yahoo = fakeYahoo({ ...RECORDED, "^BSESN 1m": "fail" });
    const r = await getLiveFeed({ nowMs: ist("2026-10-08", "11:00"), fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    expect(r.feed.missing).toEqual(["SENSEX"]);
    expect(r.feed.indices.map((i) => i.index)).toEqual(["NIFTY"]);
    expect(r.feed.stale).toBe(false);
  });

  it("serves a symbol's last good value, marked stale, when only it fails", async () => {
    const yahoo = fakeYahoo();
    const t0 = ist("2026-10-08", "11:00");
    await getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl });
    yahoo.routes.set("^BSESN 1m", "timeout");
    const r = await getLiveFeed({ nowMs: t0 + 2000, fetchImpl: yahoo.fetchImpl });
    if (!r.ok) throw new Error(r.error);
    const [n, s] = r.feed.indices;
    expect(r.feed).toMatchObject({ stale: false, missing: [], fetchedAt: new Date(t0 + 2000).toISOString() });
    expect(n).toMatchObject({ stale: false, fetchedAt: new Date(t0 + 2000).toISOString() });
    expect(s).toMatchObject({ index: "SENSEX", price: 71593.24, stale: true, fetchedAt: new Date(t0).toISOString() });
  });

  it("serves the last good payload as stale for up to 2 minutes when everything fails, then gives a plain error", async () => {
    const yahoo = fakeYahoo();
    const t0 = ist("2026-10-08", "11:00");
    const good = await getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl });
    for (const key of Object.keys(RECORDED)) yahoo.routes.set(key, "fail");

    const stale = await getLiveFeed({ nowMs: t0 + STALE_OK_MS, fetchImpl: yahoo.fetchImpl });
    if (!stale.ok || !good.ok) throw new Error("expected a payload");
    expect(stale.feed).toMatchObject({ stale: true, missing: [], fetchedAt: new Date(t0).toISOString(), generatedAt: new Date(t0 + STALE_OK_MS).toISOString() });
    expect(stale.feed.indices.map((i) => [i.price, i.stale])).toEqual([
      [22231.8, true],
      [71593.24, true],
    ]);
    expect(stale.feed.vix).toMatchObject({ price: 15.275, stale: true });

    const gone = await getLiveFeed({ nowMs: t0 + STALE_OK_MS + LIVE_TTL_MS, fetchImpl: yahoo.fetchImpl });
    expect(gone).toEqual({ ok: false, error: "Yahoo Finance has not returned NIFTY 50 or SENSEX prices for over 2 minutes: it is limiting requests." });
  });

  it("gives up on a fetch that never settles and starts a new one after 15 s", async () => {
    const yahoo = fakeYahoo({ ...RECORDED, "^NSEI 1m": "hang" });
    const t0 = ist("2026-10-08", "11:00");
    const first = await getLiveFeed({ nowMs: t0, fetchImpl: yahoo.fetchImpl, waitMs: 30 });
    expect(first).toEqual({ ok: false, error: "Yahoo Finance did not return NIFTY 50 or SENSEX prices: it did not answer in time." });
    // Still within 15 s: requests wait on the same fetch, no new upstream calls.
    await getLiveFeed({ nowMs: t0 + 5000, fetchImpl: yahoo.fetchImpl, waitMs: 30 });
    expect(yahoo.calls.filter((c) => c === "^NSEI 1m")).toHaveLength(1);

    yahoo.routes.set("^NSEI 1m", RECORDED["^NSEI 1m"]);
    const later = await getLiveFeed({ nowMs: t0 + 15_001, fetchImpl: yahoo.fetchImpl, waitMs: 2000 });
    expect(yahoo.calls.filter((c) => c === "^NSEI 1m")).toHaveLength(2);
    if (!later.ok) throw new Error(later.error);
    expect(later.feed.indices.map((i) => i.index)).toEqual(["NIFTY", "SENSEX"]);
  });

  it("errors in plain words when nothing has loaded yet", async () => {
    const r = await getLiveFeed({ nowMs: ist("2026-10-08", "11:00"), fetchImpl: fakeYahoo({ "^NSEI 1m": "timeout", "^BSESN 1m": "timeout" }).fetchImpl });
    expect(r).toEqual({ ok: false, error: "Yahoo Finance did not return NIFTY 50 or SENSEX prices: it did not answer in time." });
  });

  it("describes upstream errors without codes", () => {
    expect(plainReason("Yahoo chart ^NSEI (1m): HTTP 503: down")).toBe("it reported a server error");
    expect(plainReason("Yahoo chart ^NSEI (1m): HTTP 404: Not Found")).toBe("it refused the request");
    expect(plainReason("Yahoo chart ^NSEI (1m): timed out after 5000 ms")).toBe("it did not answer in time");
    expect(plainReason("no price in the response")).toBe("its response had no price");
    expect(plainReason("Yahoo chart ^NSEI (1m): request failed: fetch failed")).toBe("the request failed");
  });
});
