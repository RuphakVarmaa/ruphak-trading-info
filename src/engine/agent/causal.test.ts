import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, istAt } from "../clock";
import { ReplayMarketDataSource } from "../market/replayMarketData";
import { UpstoxOverlayMarketData, type UpstoxMarketClient } from "../market/upstoxMarket";
import { UPSTOX_INDEX_KEYS } from "../market/upstoxQuotes";
import type { MarketDataSource } from "../ports";
import type { Candle, MarketSnapshot, ScoredEvent } from "../types";
import { LIVE_COMPLETE_AFTER_MS, REPLAY_COMPLETE_AFTER_MS, barCloseIst, barClosingAt, barComplete, causalEvents, causalMarketSnapshot, latestClosedBarMs } from "./causal";

const D = "2026-10-14"; // a Wednesday
const at = (hhmm: string, date = D) => istAt(date, hhmm);
const cal = new TradingCalendar();
const bar = (t: number, c: number): Candle => ({ t, o: c - 1, h: c + 2, l: c - 2, c, v: 0 });
/** 5-minute bars opening every 5 minutes from `from` to `last` (inclusive). */
function bars(from: number, last: number, base: number): Candle[] {
  const out: Candle[] = [];
  for (let t = from, i = 0; t <= last; t += 5 * MINUTE_MS, i++) out.push(bar(t, base + i));
  return out;
}

/** A live-looking snapshot taken at `t` (asOfMs present): the age is the index bars' own. */
function live(t: number, candles: Record<string, Candle[]>, ageSec: Partial<Record<"NIFTY" | "SENSEX", number>>): MarketSnapshot {
  return { t, candles, daily: {}, ltp: { NIFTY: 1 }, dataAgeSec: 0, dataAgeSecByIndex: ageSec, asOfMs: { "^NSEI": t } };
}

describe("causalMarketSnapshot", () => {
  const T = at("10:35");
  const input = (): MarketSnapshot => ({
    t: T + 40_000,
    candles: {
      // 10:35 is still forming at 10:35:40; ES trades on.
      "^NSEI": bars(at("09:15"), at("10:35"), 22_500),
      "ES=F": bars(at("09:00"), at("10:35"), 6_000),
    },
    daily: { "^NSEI": [bar(at("09:15", "2026-10-13"), 22_400), bar(at("09:15"), 99_999)], "^INDIAVIX": [bar(at("09:15", "2026-10-13"), 12)] },
    ltp: { NIFTY: 22_999, SENSEX: 81_000 },
    dataAgeSec: 3,
    dataAgeSecByIndex: { NIFTY: 3, SENSEX: 900 },
    asOfMs: { "^NSEI": T + 39_000 },
  });

  it("keeps bars closed by T and earlier days' daily bars, and drops the LTP, data ages and trade times", () => {
    const raw = input();
    const before = structuredClone(raw);
    const s = causalMarketSnapshot(raw, T);
    expect(s.t).toBe(T);
    expect(s.candles["^NSEI"].at(-1)!.t).toBe(at("10:30"));
    expect(s.candles["^NSEI"].every((c) => c.t + 5 * MINUTE_MS <= T)).toBe(true);
    expect(s.candles["ES=F"].at(-1)!.t).toBe(at("10:30"));
    expect(s.daily["^NSEI"]).toEqual([bar(at("09:15", "2026-10-13"), 22_400)]);
    expect(s.daily["^INDIAVIX"]).toHaveLength(1);
    expect(s.ltp).toEqual({});
    expect(s.dataAgeSec).toBe(0);
    expect(s.dataAgeSecByIndex).toEqual({});
    expect("asOfMs" in s).toBe(false);
    // The input is left as it was.
    expect(raw).toEqual(before);
  });

  it("is idempotent", () => {
    const once = causalMarketSnapshot(input(), T);
    expect(causalMarketSnapshot(once, T)).toEqual(once);
  });
});

describe("causalEvents, barCloseIst, barClosingAt", () => {
  it("keeps only events scored and first seen by T", () => {
    const T = at("11:00");
    const ev = (id: string, scoredAtMs: number, firstSeenMs: number) => ({ clusterId: id, scoredAtMs, firstSeenMs }) as ScoredEvent;
    const events = [ev("old", T - 60_000, T - 120_000), ev("at", T, T), ev("rescored", T + 1, T - 600_000), ev("future", T + 60_000, T + 30_000)];
    expect(causalEvents(events, T).map((e) => e.clusterId)).toEqual(["old", "at"]);
  });

  it("names the bar close and finds the bar that ends there", () => {
    expect(barCloseIst(at("09:20"))).toBe("09:20");
    expect(barCloseIst(at("15:30"))).toBe("15:30");
    const snap = { candles: { "^NSEI": bars(at("09:15"), at("09:25"), 100) } };
    expect(barClosingAt(snap, "NIFTY", at("09:30"))?.t).toBe(at("09:25"));
    expect(barClosingAt(snap, "NIFTY", at("09:35"))).toBeNull();
    expect(barClosingAt(snap, "SENSEX", at("09:30"))).toBeNull();
  });
});

describe("latestClosedBarMs", () => {
  const candles = { "^NSEI": bars(at("09:15"), at("15:25"), 22_500), "^BSESN": bars(at("09:15"), at("15:25"), 81_000) };

  it("is null before the first bar closes and on days without a session", () => {
    expect(latestClosedBarMs(live(at("09:19"), candles, {}), ["NIFTY"], at("09:19") + 59_000, cal)).toBeNull();
    expect(latestClosedBarMs(live(at("08:00"), candles, {}), ["NIFTY"], at("08:00"), cal)).toBeNull();
    // Tue 20 Oct 2026 is a holiday (Dussehra); Sat 17 Oct a weekend.
    expect(latestClosedBarMs(live(at("10:00", "2026-10-20"), candles, {}), ["NIFTY"], at("10:00", "2026-10-20"), cal)).toBeNull();
    expect(latestClosedBarMs(live(at("10:00", "2026-10-17"), candles, {}), ["NIFTY"], at("10:00", "2026-10-17"), cal)).toBeNull();
  });

  it("returns the newest bar close by the clock, and after the close the session's last bar", () => {
    const s = live(at("09:20") + 30_000, candles, { NIFTY: 0, SENSEX: 0 });
    expect(latestClosedBarMs(s, ["NIFTY", "SENSEX"], at("09:20") + 30_000, cal)).toEqual({ barCloseMs: at("09:20"), complete: ["NIFTY", "SENSEX"] });
    expect(latestClosedBarMs(s, ["NIFTY"], at("10:34") + 59_999, cal)?.barCloseMs).toBe(at("10:30"));
    expect(latestClosedBarMs(s, ["NIFTY"], at("16:40"), cal)?.barCloseMs).toBe(at("15:30"));
  });

  it("live data: complete once the index's own bars were observed at least 5 s after the close", () => {
    const T = at("10:35");
    const now = T + 40_000;
    // Bars observed 35 s after T (age 5 s at 40 s): complete.
    expect(latestClosedBarMs(live(now, candles, { NIFTY: 5 }), ["NIFTY"], now, cal)).toEqual({ barCloseMs: T, complete: ["NIFTY"] });
    // Observed exactly at T + 5 s: complete; one millisecond earlier: not.
    expect(barComplete(live(now, candles, { NIFTY: 35 }), "NIFTY", T)).toBe(true);
    expect(barComplete(live(now, candles, { NIFTY: 35.001 }), "NIFTY", T)).toBe(false);
    // Observed before T: the last bucket may still be a partial one.
    expect(latestClosedBarMs(live(now, candles, { NIFTY: 45 }), ["NIFTY"], now, cal)).toEqual({ barCloseMs: T, complete: [] });
    expect(LIVE_COMPLETE_AFTER_MS).toBe(5_000);
  });

  it("is per index: a missing or stale bar leaves only that index out", () => {
    const T = at("10:35");
    const now = T + 40_000;
    const s = live(now, { "^NSEI": candles["^NSEI"], "^BSESN": bars(at("09:15"), at("10:20"), 81_000) }, { NIFTY: 5, SENSEX: 5 });
    expect(latestClosedBarMs(s, ["NIFTY", "SENSEX"], now, cal)).toEqual({ barCloseMs: T, complete: ["NIFTY"] });
    const stale = live(now, candles, { NIFTY: 5, SENSEX: 900 });
    expect(latestClosedBarMs(stale, ["NIFTY", "SENSEX"], now, cal)).toEqual({ barCloseMs: T, complete: ["NIFTY"] });
  });

  it("live data without the index's own age waits 90 s after the close", () => {
    const T = at("10:35");
    const noAge = (t: number): MarketSnapshot => ({ ...live(t, candles, {}), dataAgeSecByIndex: undefined });
    expect(barComplete(noAge(T + 89_999), "NIFTY", T)).toBe(false);
    expect(barComplete(noAge(T + 90_000), "NIFTY", T)).toBe(true);
    expect(barComplete({ ...live(T + 30_000, candles, {}), dataAgeSecByIndex: { NIFTY: Number.NaN } }, "NIFTY", T)).toBe(false);
  });

  it("replays (no asOfMs) count a visible bar as complete 90 s after its close", async () => {
    const replay = new ReplayMarketDataSource({ candles });
    const T = at("09:20");
    const early = await replay.snapshot(T + 30_000);
    expect(early.asOfMs).toBeUndefined();
    expect(latestClosedBarMs(early, ["NIFTY", "SENSEX"], early.t, cal)).toEqual({ barCloseMs: T, complete: [] });
    const later = await replay.snapshot(T + REPLAY_COMPLETE_AFTER_MS);
    expect(latestClosedBarMs(later, ["NIFTY", "SENSEX"], later.t, cal)).toEqual({ barCloseMs: T, complete: ["NIFTY", "SENSEX"] });
    // A replay with Yahoo's publication lag shows the bar only later; until then it is not complete.
    const lagged = await new ReplayMarketDataSource({ candles }, { lagMs: 120_000 }).snapshot(T + REPLAY_COMPLETE_AFTER_MS);
    expect(latestClosedBarMs(lagged, ["NIFTY"], lagged.t, cal)?.complete).toEqual([]);
  });
});

describe("bar completeness on the Upstox overlay (SPEC-REVIEW #5)", () => {
  const NIFTY_KEY = UPSTOX_INDEX_KEYS.NIFTY!;
  const iso = (ms: number) => new Date(ms + 330 * MINUTE_MS).toISOString().replace("Z", "+05:30").replace(".000", "");
  /** The final close of the 1-minute bar opening at `t`: 22,500 + minutes since 09:15, plus 0.5. */
  const minuteClose = (t: number) => 22_500 + (t - at("09:15")) / MINUTE_MS + 0.5;
  /** A minute still forming at the fetch shows a mid-minute price instead. */
  const MID_MINUTE = -0.25;

  function harness() {
    const state = { now: 0, lastMinute: 0, spotTradeMs: 0 };
    const client: UpstoxMarketClient = {
      async get(path: string) {
        const key = decodeURIComponent(path.split("/")[4]);
        const rows: unknown[][] = [];
        // Upstox's intraday candles include the minute still forming, priced as of the fetch.
        for (let t = at("09:15"); key === NIFTY_KEY && t <= state.lastMinute; t += MINUTE_MS) {
          const c = minuteClose(t) + (t + MINUTE_MS > state.now ? MID_MINUTE : 0);
          rows.push([iso(t), minuteClose(t) - 0.5, minuteClose(t) + 1, minuteClose(t) - 1, c, 0, 0]);
        }
        return { status: "success", data: { candles: rows.reverse() } };
      },
      async quotesByKey(keys: readonly string[]) {
        const m = new Map<string, Record<string, unknown>>();
        if (keys.includes(NIFTY_KEY)) m.set(NIFTY_KEY, { last_price: 22_600, last_trade_time: String(state.spotTradeMs) });
        return m;
      },
    };
    const yahoo: MarketDataSource = {
      async snapshot(t) {
        return { t, candles: {}, daily: {}, ltp: {}, dataAgeSec: 999_999, dataAgeSecByIndex: { NIFTY: 999_999, SENSEX: 999_999 }, asOfMs: {} };
      },
    };
    const src = new UpstoxOverlayMarketData(yahoo, client, { now: () => state.now });
    return {
      state,
      snap: async (now: number, lastMinute: number, spotTradeMs: number) => {
        Object.assign(state, { now, lastMinute, spotTradeMs });
        return src.snapshot(now);
      },
    };
  }

  it("candles seen at T − 10 s and a spot traded at T + 14 s: the bar is not complete; the next candle fetch completes it", async () => {
    const T = at("10:35");
    const h = harness();
    // 10:34:50: candles fetched with the 10:34 minute still forming.
    await h.snap(T - 10_000, at("10:34"), T - 12_000);
    // 10:35:20: the spot is fresh (traded 10:35:14) but the candles are not refetched for 60 s.
    const s1 = await h.snap(T + 20_000, at("10:34"), T + 14_000);
    expect(s1.asOfMs?.["^NSEI"]).toBe(T + 14_000);
    expect(s1.dataAgeSecByIndex?.NIFTY).toBe(30);
    // SPEC v1's rule (asOfMs ≥ T) would have called this bucket complete although it closes at the 10:34:50 price.
    expect((s1.asOfMs?.["^NSEI"] ?? 0) >= T).toBe(true);
    expect(barClosingAt(s1, "NIFTY", T)?.c).toBe(minuteClose(at("10:34")) + MID_MINUTE);
    expect(latestClosedBarMs(s1, ["NIFTY"], s1.t, cal)).toEqual({ barCloseMs: T, complete: [] });

    // 10:35:55: the candles are refetched and now hold the 10:35 minute, so the 10:30 bucket is final.
    const s2 = await h.snap(T + 55_000, at("10:35"), T + 50_000);
    expect(s2.dataAgeSecByIndex?.NIFTY).toBe(0);
    expect(latestClosedBarMs(s2, ["NIFTY"], s2.t, cal)).toEqual({ barCloseMs: T, complete: ["NIFTY"] });
    expect(barClosingAt(s2, "NIFTY", T)?.c).toBe(minuteClose(at("10:34")));
  });
});
