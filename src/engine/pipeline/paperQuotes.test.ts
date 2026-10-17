/**
 * Paper exits when Groww is configured (GROWW_API_KEY and GROWW_TOTP_SECRET set): a Groww answer without a
 * two-sided price must not hold an exit. The trading DO wraps Groww quotes in FallbackOptionQuotes for every
 * paper book; these tests run the production position cycle and paper broker on that wiring.
 */
import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, istDate } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { FallbackOptionQuotes, GrowwDataClient, GrowwError, GrowwOptionQuotes } from "../broker/groww";
import { SyntheticOptionQuotes } from "../pricing/syntheticOptionPricer";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { OptionQuoteSource } from "../ports";
import type { Position } from "../types";
import { runPositionCycle } from "./positionCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();
const cfg = DEFAULT_CONFIG;
const calendar = new TradingCalendar();

/** Groww over a fake transport that answers every quote with `payload` (or throws it). */
function growwQuotes(payload: unknown, opts: { pauseAfterErrorMs?: number } = {}): GrowwOptionQuotes {
  const transport = {
    request: async <T,>(): Promise<T> => {
      if (payload instanceof Error) throw payload;
      return payload as T;
    },
  };
  return new GrowwOptionQuotes(new GrowwDataClient(transport), cfg, { cacheMs: 0, ...opts });
}

async function openPosition(quotes: OptionQuoteSource) {
  const t = istAt(DAY, "15:06");
  const deps = createReplayDeps({ cfg, startMs: t, candles: fixtures.candles, daily: fixtures.daily, calendar, optionQuotes: quotes });
  const spot = fixtures.candles["^NSEI"].filter((c) => c.t <= t).at(-1)!.c;
  deps.marketContext.set("NIFTY", { spot, vix: 14, t });
  const expiry = (await deps.instruments.expiries("NIFTY")).find((e) => e > istDate(t))!;
  const strikes = await deps.instruments.strikes("NIFTY", expiry);
  const strike = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const contract = (await deps.instruments.resolve("NIFTY", expiry, strike, "CE"))!;
  const p: Position = {
    id: "pos1",
    planId: "plan1",
    index: "NIFTY",
    side: "BULL",
    contract,
    mode: deps.mode,
    qty: contract.lotSize,
    avgEntry: 150,
    entryMs: istAt(DAY, "10:00"),
    entryCharges: 30,
    status: "OPEN",
    markPremium: 150,
    markMs: istAt(DAY, "15:05"),
    peakPremium: 150,
    unrealized: 0,
    // The 15:05 square-off has passed: the cycle must exit now.
    stops: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: istAt(DAY, "12:00"), squareOffMs: istAt(DAY, "15:05") },
    horizonMin: 60,
    convictionAtEntry: 0.6,
    regimeAtEntry: "TREND_UP",
    dominantSource: "MOMENTUM",
    attribution: [{ source: "MOMENTUM", share: 1 }],
    eventKeysAtEntry: [],
    maePct: 0,
    mfePct: 0,
  };
  await deps.repo.positions.save(p);
  return deps;
}

describe("paper exits on Groww quotes", () => {
  for (const [name, payload] of [
    ["an empty book (no bid, ask or last price)", {}],
    ["a one-sided book (no ask)", { last_price: 120, bid_price: 119.5, offer_price: 0 }],
  ] as const) {
    it(`square off on synthetic prices when Groww sends ${name}`, async () => {
      const synthetic = new SyntheticOptionQuotes(calendar, cfg);
      const deps = await openPosition(new FallbackOptionQuotes(growwQuotes(payload), synthetic));
      const report = await runPositionCycle(deps);
      expect(report.errors).toEqual([]);
      expect(report.exits).toEqual([{ positionId: "pos1", reason: "SQUARE_OFF", status: "FILLED" }]);
      const closed = await deps.repo.positions.get("pos1");
      expect(closed?.status).toBe("CLOSED");
      const [trade] = await deps.repo.trades.recent(10, deps.mode);
      expect(trade).toMatchObject({ positionId: "pos1", exitReason: "SQUARE_OFF" });
      expect(trade.exitPremium).toBeGreaterThan(0);
    });
  }

  it("square off when Groww fails outright (the fallback that already existed)", async () => {
    const deps = await openPosition(new FallbackOptionQuotes(growwQuotes(new GrowwError("Groww: 503", "transient", 503), { pauseAfterErrorMs: 30_000 }), new SyntheticOptionQuotes(calendar, cfg)));
    const report = await runPositionCycle(deps);
    expect(report.exits.map((x) => x.status)).toEqual(["FILLED"]);
  });

  it("without the fallback an empty or one-sided Groww book held the exit (why the guard exists)", async () => {
    const empty = await openPosition(growwQuotes({}));
    const a = await runPositionCycle(empty);
    expect(a.exits).toEqual([]);
    expect(a.errors[0]).toMatch(/exits paused, the quote has no bid or last price/);
    expect((await empty.repo.positions.get("pos1"))?.status).toBe("OPEN");

    const oneSided = await openPosition(growwQuotes({ last_price: 120, bid_price: 119.5, offer_price: 0 }));
    const b = await runPositionCycle(oneSided);
    expect(b.exits).toEqual([{ positionId: "pos1", reason: "SQUARE_OFF", status: "REJECTED" }]); // the paper broker needs a two-sided quote
    expect((await oneSided.repo.positions.get("pos1"))?.status).toBe("OPEN");
  });
});
