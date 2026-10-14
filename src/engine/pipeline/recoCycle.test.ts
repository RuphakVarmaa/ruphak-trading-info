import { describe, expect, it } from "vitest";
import type { IndexId, OptionFlowView } from "../api-types";
import { defaultCalendar } from "../calendar/calendar";
import { MINUTE_MS, istAt, istIso } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { recoKey } from "../flow/recommend";
import type { EngineDeps, InstrumentProvider } from "../ports";
import { loadMarketFixtures } from "../testing/fixtures";
import { createReplayDeps } from "../testing/replayHarness";
import type { OptionContract, Quote } from "../types";
import { eventBlackout, recoCandidates, recoExpiry, recoStrikes, type RecoRecord } from "./recoCycle";
import { runTradingCycle } from "./tradingCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();

function instruments(expiries: string[]): InstrumentProvider {
  return { expiries: async () => expiries, strikes: async () => [], resolve: async () => null };
}

describe("the recommendation's contract", () => {
  it("uses the nearest expiry with at least 4 calendar days left, never today's", async () => {
    const list = ["2026-10-13", "2026-10-20", "2026-10-27"];
    expect(await recoExpiry("NIFTY", istAt("2026-10-12", "10:00"), instruments(list), defaultCalendar)).toBe("2026-10-20");
    expect(await recoExpiry("NIFTY", istAt("2026-10-13", "10:00"), instruments(list), defaultCalendar)).toBe("2026-10-20");
    expect(await recoExpiry("NIFTY", istAt("2026-10-09", "10:00"), instruments(list), defaultCalendar)).toBe("2026-10-13");
    expect(await recoExpiry("NIFTY", istAt("2026-10-12", "10:00"), instruments(["2026-10-13"]), defaultCalendar)).toBeNull();
  });

  it("holds new entries around a scheduled event (plan rule N1)", () => {
    const g = { preEventBlackoutMin: 15, postEventWaitMin: 5 };
    expect(eventBlackout({ nextScheduledEvent: { id: "e", name: "RBI policy", impact: "HIGH", minutesAway: 25 }, recentScheduledEvent: null }, g)).toContain("RBI policy is in 25 min");
    expect(eventBlackout({ nextScheduledEvent: { id: "e", name: "RBI policy", impact: "HIGH", minutesAway: 45 }, recentScheduledEvent: null }, g)).toBeNull();
    expect(eventBlackout({ nextScheduledEvent: null, recentScheduledEvent: { id: "e", name: "US CPI", impact: "MED", minutesAgo: 12 } }, g)).toContain("US CPI was 12 min ago");
    expect(eventBlackout({ nextScheduledEvent: { id: "e", name: "Auction", impact: "LOW", minutesAway: 5 }, recentScheduledEvent: null }, g)).toBeNull();
  });

  it("quotes two strikes in the money to three out, on the trade's side", () => {
    expect(recoStrikes(22512, 50, "CE", [])).toEqual([22400, 22450, 22500, 22550, 22600, 22650]);
    expect(recoStrikes(22512, 50, "PE", [])).toEqual([22600, 22550, 22500, 22450, 22400, 22350]);
    // Snapped to the listed strikes, without duplicates.
    expect(recoStrikes(22512, 50, "CE", [22400, 22500, 22600, 22700])).toEqual([22400, 22500, 22600]);
  });
});

describe("candidate quotes", () => {
  it("prefers a real quote, then the feed's minute sample, else a flagged model price", async () => {
    const now = istAt("2026-10-14", "10:30");
    const contract = (strike: number): OptionContract => ({ index: "NIFTY", exchange: "NSE", tradingSymbol: `NIFTY26O20${strike}CE`, growwSymbol: "", exchangeToken: `${strike}`, expiry: "2026-10-20", strike, type: "CE", lotSize: 65, tickSize: 0.05 });
    const quote = (strike: number, ask: number, source: Quote["source"]): Quote => ({ symbol: `NIFTY26O20${strike}CE`, t: now, ltp: ask - 0.1, bid: ask - 0.2, ask, bidQty: 650, askQty: 650, iv: 12, source });
    const deps = {
      cfg: DEFAULT_CONFIG,
      clock: { now: () => now, sleep: async () => {} },
      instruments: { expiries: async () => ["2026-10-20"], strikes: async () => [22400, 22450, 22500, 22550, 22600, 22650], resolve: async (_i: IndexId, _e: string, strike: number) => contract(strike) },
      optionQuotes: {
        kind: "upstox" as const,
        quote: async (c: OptionContract) => {
          if (c.strike === 22500) return quote(22500, 171.5, "upstox");
          if (c.strike === 22550) return quote(22550, 140, "synthetic");
          throw new Error("no quote");
        },
      },
    } as unknown as EngineDeps;
    const row = (strike: number, ask: number | null) => ({ strike, ce: { oi: 1, ltp: ask, bid: ask, ask, iv: 11, delta: 0.48, oiChg: null, oiChgPct: null, vol: null, volMultiple: null, ltpChgPct: null, ivChg: null, buildup: "NEUTRAL" as const }, pe: null });
    const flow = { source: "feed", expiry: "2026-10-20", asOf: istIso(now - 40_000), windows: { "1m": { minutes: 1, from: null, rows: [row(22550, 139.5), row(22600, 112)] } } } as unknown as OptionFlowView;
    const c = await recoCandidates(deps, "NIFTY", "CE", "2026-10-20", { spot: 22530, vix: 12 }, flow, defaultCalendar);
    const by = new Map(c.map((x) => [x.contract.strike, x]));
    expect(by.get(22500)).toMatchObject({ priceSource: "broker", ask: 171.5, premium: 171.5 });
    expect(by.get(22550)).toMatchObject({ priceSource: "feed", ask: 139.5, delta: 0.48 });
    expect(by.get(22600)).toMatchObject({ priceSource: "feed", ask: 112 });
    expect(by.get(22650)).toMatchObject({ priceSource: "model", ask: null, bid: null });
    expect(by.get(22650)!.premium).toBeGreaterThan(0);
    // A stale flow is not used.
    const stale = await recoCandidates(deps, "NIFTY", "CE", "2026-10-20", { spot: 22530, vix: 12 }, { ...flow, asOf: istIso(now - 10 * 60_000) }, defaultCalendar);
    expect(stale.find((x) => x.contract.strike === 22600)?.priceSource).toBe("model");
  });
});

describe("the recommendation on the engine tick", () => {
  async function run(recommend: boolean, flowFails = false) {
    const start = istAt(DAY, "09:15");
    const base = createReplayDeps({ cfg: DEFAULT_CONFIG, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
    const deps = flowFails
      ? {
          ...base,
          flow: {
            view: async () => {
              throw new Error("feed DO unreachable");
            },
          },
        }
      : base;
    const trace: unknown[] = [];
    for (let t = istAt(DAY, "09:30"); t <= istAt(DAY, "11:00"); t += 5 * MINUTE_MS) {
      base.clock.set(t);
      const r = await runTradingCycle(deps, { noEvents: true, recommend });
      trace.push(r.errors, r.entries.length, r.decisions.map((d) => [d.index, d.conviction.score, d.plan?.contract.tradingSymbol ?? null, d.gates.map((g) => g.passed)]));
    }
    return { deps: base, trace };
  }

  it("stores one per index and never changes the trading", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(on.trace).toEqual(off.trace);
    expect(await off.deps.repo.state.get(recoKey("NIFTY"))).toBeNull();
    for (const index of DEFAULT_CONFIG.indices) {
      const rec = await on.deps.repo.state.get<RecoRecord>(recoKey(index));
      expect(rec).not.toBeNull();
      expect(rec!.session).toBe(DAY);
      expect(rec!.t).toBe(istAt(DAY, "11:00"));
      expect(["ENTER", "WAIT", "NO_TRADE"]).toContain(rec!.view.status);
      // No measured statistics in the repo: never graded A, always an honest line.
      expect(rec!.view.grade).not.toBe("A");
      expect(rec!.view.honest).toBeTruthy();
      // The replay has no live quotes: a model price can never say ENTER.
      if (rec!.view.contract?.priceSource === "model") expect(rec!.view.status).not.toBe("ENTER");
    }
  });

  it("keeps ticking when the flow source fails", async () => {
    const on = await run(true, true);
    expect(on.trace.filter((x, i) => i % 3 === 0).every((errs) => Array.isArray(errs) && errs.length === 0)).toBe(true);
    expect(await on.deps.repo.state.get(recoKey("NIFTY"))).not.toBeNull();
  });
});
