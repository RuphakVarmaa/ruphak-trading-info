import { describe, expect, it } from "vitest";
import type { LiveIndex, LiveIndicesFeed } from "@/lib/market/liveIndices";
import { changeText, entryFreshness, fmtFeedAge, freshnessLabel, panelStatus, phaseSentence, rangeText, sessionPhrase, vixText } from "./marketText";

const T = Date.parse("2026-10-08T10:00:00+05:30");
const iso = (ms: number) => new Date(ms).toISOString();

const nifty: LiveIndex = {
  index: "NIFTY",
  label: "NIFTY 50",
  symbol: "^NSEI",
  price: 22231.8,
  prevClose: 22603.05,
  change: -371.25,
  changePct: -1.642,
  open: 22599.05,
  high: 22599.05,
  low: 22179.9,
  vwap: 22339.59,
  openingRange: { high: 22599.05, low: 22475.85 },
  session: "2026-10-08",
  asOf: "2026-10-08T09:59:50+05:30",
  bars: [],
  stale: false,
  fetchedAt: iso(T),
};

function feed(over: Partial<LiveIndicesFeed> = {}): LiveIndicesFeed {
  return {
    indices: [nifty],
    vix: null,
    marketPhase: "OPEN",
    source: "Yahoo Finance",
    generatedAt: iso(T + 500),
    fetchedAt: iso(T),
    stale: false,
    missing: [],
    holidayName: null,
    nextOpenAt: "2026-10-09T09:15:00+05:30",
    ...over,
  };
}

describe("ages and freshness labels", () => {
  it("formats feed ages in words", () => {
    expect(fmtFeedAge(1400)).toBe("1 s");
    expect(fmtFeedAge(14_000)).toBe("14 s");
    expect(fmtFeedAge(125_000)).toBe("2 min");
    expect(fmtFeedAge(65 * 60_000)).toBe("1 h 5 min");
    expect(fmtFeedAge(2 * 3600_000)).toBe("2 h");
    expect(fmtFeedAge(50 * 3600_000)).toBe("2 d");
    expect(fmtFeedAge(-5)).toBe("0 s");
  });

  it("labels the four states", () => {
    expect(freshnessLabel("live", 1000)).toBe("Live · 1 s");
    expect(freshnessLabel("stale", 14_000)).toBe("Stale · 14 s");
    expect(freshnessLabel("offline", 120_000)).toBe("Offline · 2 min");
    expect(freshnessLabel("loading", null)).toBe("Connecting…");
    expect(freshnessLabel("live", null)).toBe("Connecting…");
  });
});

describe("entryFreshness", () => {
  it("is live with a fresh payload and a recent trade", () => {
    expect(entryFreshness(feed(), nifty, "live", 1000)).toEqual({ freshness: "live", ageMs: 1000, note: null });
  });

  it("ages a value served after a failed fetch by its own fetch time", () => {
    const old = { ...nifty, stale: true, fetchedAt: iso(T - 40_000) };
    const f = entryFreshness(feed({ indices: [old] }), old, "live", 1000);
    expect(f.freshness).toBe("stale");
    expect(f.ageMs).toBe(41_500);
    expect(f.note).toBe("Yahoo Finance did not answer the latest refresh; this value was fetched 41 s ago.");
    // Past a minute it reads offline.
    const older = { ...nifty, stale: true, fetchedAt: iso(T - 90_000) };
    expect(entryFreshness(feed({ indices: [older] }), older, "live", 1000).freshness).toBe("offline");
  });

  it("marks a last trade over 3 minutes old as stale while the market is open, not when it is closed", () => {
    const lagging = { ...nifty, asOf: "2026-10-08T09:55:00+05:30" };
    const f = entryFreshness(feed(), lagging, "live", 1000);
    expect(f.freshness).toBe("stale");
    expect(f.note).toBe("No new trade from Yahoo Finance for 5 min.");
    expect(entryFreshness(feed({ marketPhase: "CLOSED" }), lagging, "live", 1000).freshness).toBe("live");
  });

  it("follows the poll when the page has not heard from the server", () => {
    expect(entryFreshness(feed(), nifty, "stale", 20_000)).toMatchObject({ freshness: "stale", note: "No update from the server for 20 s." });
    expect(entryFreshness(feed(), nifty, "offline", 120_000).freshness).toBe("offline");
    expect(entryFreshness(null, null, "loading", null)).toEqual({ freshness: "loading", ageMs: null, note: null });
  });
});

describe("numbers in words", () => {
  it("shows the change, or a dash without a previous close", () => {
    expect(changeText(nifty)).toEqual({ text: "−371.25 (−1.64%)", dir: -1 });
    expect(changeText({ change: -1045.46, changePct: -1.439 })).toEqual({ text: "−1,045.46 (−1.44%)", dir: -1 });
    expect(changeText({ change: 12.5, changePct: 0.0561 })).toEqual({ text: "+12.50 (+0.06%)", dir: 1 });
    expect(changeText({ change: 0.001, changePct: 0 })).toEqual({ text: "0.00 (0.00%)", dir: 0 });
    expect(changeText({ change: null, changePct: null })).toEqual({ text: "—", dir: 0 });
  });

  it("shows ranges and India VIX at its own precision", () => {
    expect(rangeText(22179.9, 22599.05)).toBe("22,179.90 – 22,599.05");
    expect(rangeText(null, 1)).toBe("—");
    expect(vixText({ price: 15.275, prevClose: 13.89, change: 1.385, changePct: 9.971 })).toEqual({ value: "15.275", prevClose: "13.89", change: "+1.385 (+9.97%)", dir: 1 });
    expect(vixText({ price: 15.275, prevClose: null, change: null, changePct: null })).toMatchObject({ prevClose: null, change: "—", dir: 0 });
  });
});

describe("sentences", () => {
  it("says what the market is doing and which session the bars are", () => {
    expect(phaseSentence(feed())).toBe("Market open. 1-minute bars, refreshed every 1.5 s.");
    const after = feed({ marketPhase: "CLOSED", generatedAt: "2026-10-08T19:11:00.000Z" }); // 00:41 IST on 10-09
    expect(phaseSentence(after)).toBe("Market closed. Showing the Thu 08 Oct session. Next open Fri 09 Oct, 09:15 IST.");
    expect(phaseSentence(feed({ marketPhase: "CLOSED" }))).toBe("Market closed. Showing today's session. Next open Fri 09 Oct, 09:15 IST.");
    expect(phaseSentence(feed({ marketPhase: "PRE_OPEN", generatedAt: "2026-10-09T03:35:00.000Z" }))).toBe("Pre-open: trading starts at 09:15 IST. Showing the Thu 08 Oct session.");
    expect(phaseSentence(feed({ marketPhase: "HOLIDAY", holidayName: "Dussehra", generatedAt: "2026-10-20T05:00:00.000Z", nextOpenAt: "2026-10-21T09:15:00+05:30" }))).toBe(
      "Exchange holiday (Dussehra). Showing the Thu 08 Oct session. Next open Wed 21 Oct, 09:15 IST.",
    );
    expect(phaseSentence(feed({ marketPhase: "HOLIDAY", holidayName: "Weekend", generatedAt: "2026-10-10T05:00:00.000Z", nextOpenAt: "2026-10-12T09:15:00+05:30" }))).toMatch(/^Weekend: the market is shut\./);
    expect(sessionPhrase("2026-10-08", "2026-10-08T04:30:00.000Z")).toBe("today's session");
  });

  it("explains loading, failures, staleness and a missing index without codes", () => {
    const base = { data: feed(), error: null, freshness: "live" as const, ageMs: 1000 };
    expect(panelStatus(base, 1500)).toBeNull();
    expect(panelStatus({ ...base, data: null, ageMs: null, freshness: "loading" }, 1500)).toEqual({ tone: "wait", text: "Connecting to the index feed…" });
    expect(panelStatus({ ...base, data: null, ageMs: null, freshness: "loading", error: "The server could not be reached." }, 30_000)).toEqual({
      tone: "down",
      text: "The index feed did not load. The server could not be reached. Trying again every 30 s.",
    });
    expect(panelStatus({ ...base, freshness: "offline", ageMs: 125_000, error: "Yahoo Finance did not return NIFTY 50 or SENSEX prices: it is limiting requests." }, 1500)).toEqual({
      tone: "down",
      text: "No update for 2 min. Yahoo Finance did not return NIFTY 50 or SENSEX prices: it is limiting requests. Showing the last prices received. Trying again every 1.5 s.",
    });
    expect(panelStatus({ ...base, data: feed({ stale: true, generatedAt: iso(T + 30_000) }) }, 1500)).toEqual({
      tone: "stale",
      text: "Yahoo Finance did not answer the latest refresh, so these prices were fetched 31 s ago.",
    });
    expect(panelStatus({ ...base, freshness: "stale", ageMs: 15_000 }, 1500)).toEqual({ tone: "stale", text: "Updates are late: the last one arrived 15 s ago." });
    expect(panelStatus({ ...base, data: feed({ missing: ["SENSEX"] }) }, 1500)).toEqual({ tone: "stale", text: "SENSEX did not load from Yahoo Finance; it will show when a refresh brings it." });
    for (const s of [panelStatus({ ...base, freshness: "offline", ageMs: 125_000, error: "x" }, 1500)]) expect(s?.text).not.toMatch(/UPSTREAM|HTTP|ENGINE_/);
  });
});
