import { describe, expect, it } from "vitest";
import type { OptionChainView, OptionFlowView } from "../api-types";
import { istAt } from "../clock";
import { NIFTY_CHAIN_SAMPLE } from "../market/upstoxChain.fixture";
import { buildOptionChainView, parseUpstoxChain } from "../market/upstoxChain";
import { FlowMonitor } from "./flowMonitor";
import { optionFlowWithFallback, restFlowView } from "./flowFallback";
import type { FlowStatsFile } from "./flowStatsTypes";

const NOW = istAt("2026-10-14", "11:00");
const STATS: FlowStatsFile = {
  generatedAt: "",
  source: "test",
  method: "",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Test."],
};

function restChain(): OptionChainView {
  return buildOptionChainView({ index: "NIFTY", expiry: "2026-10-19", meta: { expiries: ["2026-10-19"], lotSize: 65 }, chain: parseUpstoxChain(NIFTY_CHAIN_SAMPLE), fetchedMs: NOW - 2_000 });
}

function feedView(): OptionFlowView {
  const mon = new FlowMonitor({ stats: STATS });
  const chain = parseUpstoxChain(NIFTY_CHAIN_SAMPLE);
  for (let m = 0; m < 3; m++) {
    mon.ingest({
      t: NOW - (3 - m) * 60_000,
      index: "NIFTY",
      expiry: "2026-10-19",
      lotSize: 65,
      spot: chain.spot,
      rows: chain.rows.map((r) => ({ strike: r.strike, ce: r.ce ? { ltp: r.ce.ltp, volume: r.ce.volume, oi: r.ce.oi, bid: r.ce.bid, ask: r.ce.ask, iv: r.ce.iv, delta: r.ce.delta } : null, pe: null })),
    });
  }
  return mon.view("NIFTY", NOW);
}

describe("option flow with the REST fallback", () => {
  it("serves the feed's view when it has minutes", async () => {
    const v = feedView();
    let chainCalls = 0;
    const out = await optionFlowWithFallback("NIFTY", async () => v, async () => (chainCalls++, restChain()), NOW, { stats: STATS });
    expect(out).toBe(v);
    expect(chainCalls).toBe(0);
  });

  it("falls back to one REST chain, flagged, when the feed has no minutes", async () => {
    const empty = new FlowMonitor({ stats: STATS }).view("NIFTY", NOW);
    const out = await optionFlowWithFallback("NIFTY", async () => empty, async () => restChain(), NOW, { stats: STATS });
    expect(out.source).toBe("rest");
    expect(out.minutes).toBe(1);
    expect(out.note).toContain("The market feed has no option-flow minutes yet");
    expect(out.note).toContain("built from one REST option chain");
    // No minute history: the windows carry the latest quotes but no changes.
    expect(out.windows["5m"].from).toBeNull();
    expect(out.windows["5m"].rows.every((r) => r.ce?.oiChg == null)).toBe(true);
    // The day's change comes from the chain's previous OI and close.
    const chain = restChain();
    const row = chain.rows.find((r) => r.strike === 22650)!;
    const day = out.day!.rows.find((r) => r.strike === 22650)!;
    expect(day.ce!.oiChg).toBe(row.ce!.oi! - row.ce!.prevOi!);
    expect(day.ce!.ltpChgPct).toBe(row.ce!.changePct);
    expect(out.summary.callWritersVsPutWriters.window).toBe("day");
    expect(out.summary.callWritersVsPutWriters.text).toContain("since the previous close");
    expect(out.summary.pcr).toBeGreaterThan(0);
    expect(out.spot).toBe(chain.spot);
  });

  it("treats a feed that throws or times out as no feed", async () => {
    const out = await optionFlowWithFallback(
      "NIFTY",
      async () => {
        throw new Error("DO unreachable");
      },
      async () => restChain(),
      NOW,
      { stats: STATS },
    );
    expect(out.source).toBe("rest");
    expect(out.note).toContain("The market feed did not answer");
    const timedOut = await optionFlowWithFallback("NIFTY", async () => null, async () => restChain(), NOW, { stats: STATS });
    expect(timedOut.note).toContain("did not answer");
  });

  it("returns an empty view with the reason when the REST chain fails too", async () => {
    const out = await optionFlowWithFallback(
      "NIFTY",
      async () => null,
      async () => {
        throw new Error("Upstox rate limit (HTTP 429)");
      },
      NOW,
      { stats: STATS },
    );
    expect(out).toMatchObject({ source: "rest", minutes: 0, asOf: null, events: [] });
    expect(out.note).toContain("Upstox rate limit (HTTP 429)");
    const noRows = restFlowView({ ...restChain(), rows: [], spot: 0, error: "no quote source: set UPSTOX_ANALYTICS_TOKEN" }, NOW, { stats: STATS });
    expect(noRows.minutes).toBe(0);
    expect(noRows.note).toContain("UPSTOX_ANALYTICS_TOKEN");
  });
});
