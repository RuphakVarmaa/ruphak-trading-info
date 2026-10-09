/** Plan §6 E2(a), the first 15-minute candle (WP9b): the rule, and the rule through the production cycles. */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../../accounts";
import { runBacktestAccounts } from "../../backtest/runBacktest";
import { TradingCalendar } from "../../calendar/calendar";
import { MINUTE_MS, istAt, istDate, istParts } from "../../clock";
import { DEFAULT_CONFIG, makeConfig, type DeepPartial, type EngineConfig } from "../../config";
import { computeFeatures } from "../../market/features";
import { ReplayMarketDataSource } from "../../market/replayMarketData";
import { loadRiskState } from "../../pipeline/riskState";
import { loadMarketFixtures } from "../../testing/fixtures";
import { createReplayDeps } from "../../testing/replayHarness";
import { MARKET_SYMBOLS, type Candle } from "../../types";
import { planEntry } from "../planner";
import { firstCandleParams, firstCandlePlan, firstCandleState, publishedConviction, publishedEntrySlots, publishedSignal, sessionsAt } from "./index";

const BAR = 5 * MINUTE_MS;
const DAY = "2026-09-30";
const OPEN = istAt(DAY, "09:15");
const p = firstCandleParams(DEFAULT_CONFIG);

/** 5-minute bars from 09:15 (bar k opens at 09:15 + 5k) from per-bar closes. */
function bars(open: number, closes: number[], start = 0): Candle[] {
  let prev = open;
  return closes.map((c, k) => {
    const bar = { t: OPEN + (start + k) * BAR, o: prev, h: Math.max(prev, c) + 1, l: Math.min(prev, c) - 1, c, v: 0 };
    prev = c;
    return bar;
  });
}

describe("first 15-minute candle (plan §6 E2a)", () => {
  it("enters in the direction of a body larger than 0.24%, at the candle's close", () => {
    const up = firstCandlePlan(bars(24_000, [24_010, 24_040, 24_060]), OPEN, p, BAR);
    expect(up).toMatchObject({ side: "BULL", skipped: false, pending: false, entryBarT: istAt(DAY, "09:25"), entryLevel: 24_060 });
    expect(up.bodyPct).toBeCloseTo(0.25, 9);
    const down = firstCandlePlan(bars(24_000, [23_990, 23_960, 23_940]), OPEN, p, BAR);
    expect(down).toMatchObject({ side: "BEAR", entryLevel: 23_940 });
  });

  it("skips a body of 0.24% or less, a missing 09:15 bar and an incomplete candle", () => {
    expect(firstCandlePlan(bars(24_000, [24_010, 24_040, 24_057]), OPEN, p, BAR)).toMatchObject({ side: null, skipped: true });
    expect(firstCandlePlan(bars(24_000, [23_990, 23_960, 23_943]), OPEN, p, BAR)).toMatchObject({ side: null, skipped: true });
    expect(firstCandlePlan(bars(24_000, [24_040, 24_100], 1), OPEN, p, BAR)).toMatchObject({ side: null, skipped: true });
    expect(firstCandlePlan(bars(24_000, [24_040, 24_100]), OPEN, p, BAR)).toMatchObject({ side: null, skipped: false, reason: "first candle not complete" });
  });

  it("enters only on the entry bar: never before the candle closes, never again later", () => {
    const day = bars(24_000, [24_010, 24_040, 24_060, 24_100, 24_150]);
    expect(firstCandleState(day.slice(0, 2), OPEN, p, BAR).entry).toBeNull();
    const at = firstCandleState(day.slice(0, 3), OPEN, p, BAR);
    expect(at).toMatchObject({ strategy: "FIRST_CANDLE", entry: "BULL", decisionBarEndMs: istAt(DAY, "09:30"), exitBull: null, exitBear: null });
    expect(firstCandleState(day.slice(0, 4), OPEN, p, BAR).entry).toBeNull();
    expect(firstCandleState(day, OPEN, p, BAR)).toMatchObject({ entry: null, exitBull: null, exitBear: null });
  });

  it("waits for the entry window: N3's later start moves the entry to the first bar ending after it", () => {
    const late = firstCandleParams(makeConfig({ rules: { n3: { enabled: true, entryFromIst: "09:33" } } }));
    expect(late.windowStartMin).toBe(9 * 60 + 33);
    const day = bars(24_000, [24_010, 24_040, 24_060, 24_080]);
    expect(firstCandlePlan(day.slice(0, 3), OPEN, late, BAR)).toMatchObject({ side: "BULL", pending: true });
    expect(firstCandlePlan(day, OPEN, late, BAR)).toMatchObject({ entryBarT: istAt(DAY, "09:30"), entryLevel: 24_080 });
    expect(publishedEntrySlots(makeConfig({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 } }))).toEqual([9 * 60 + 30]);
    expect(publishedEntrySlots(makeConfig({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 }, rules: { n3: { enabled: true, entryFromIst: "09:33" } } }))).toEqual([9 * 60 + 35]);
    expect(publishedEntrySlots(DEFAULT_CONFIG)).toBeNull();
  });

  it("books as an opening-range signal with a ±1 score", () => {
    const cfg = makeConfig({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 } });
    const sig = firstCandleState(bars(24_000, [24_010, 24_040, 24_060]), OPEN, p, BAR);
    const c = publishedConviction("NIFTY", istAt(DAY, "09:31") + 30_000, sig, "RANGE", cfg);
    expect([c.score, c.passes, c.components[0].source]).toEqual([1, true, "ORB"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the production cycles (fixture week 1-7 Oct 2026)
// ---------------------------------------------------------------------------------------------

const fixtures = loadMarketFixtures();
const calendar = new TradingCalendar();

async function replay(patch: DeepPartial<EngineConfig>) {
  const cfg = makeConfig(patch);
  const followers = (["small10k"] as const).map((account) => ({ account, cfg: accountConfig(cfg, account) }));
  const r = await runBacktestAccounts({ cfg, from: "2026-10-01", to: "2026-10-07", candles: fixtures.candles, daily: fixtures.daily, noEvents: true, followers, perfOverlay: false });
  return { cfg, main: r.main.trades, small: r.followers.small10k!.trades, days: r.main.days };
}

/** The rule's view of a day from the fixture bars (point in time at 23:00, so the whole session). */
function dayPlan(index: "NIFTY" | "SENSEX", date: string) {
  const s = sessionsAt(fixtures.candles[MARKET_SYMBOLS[index]], calendar, istAt(date, "23:00"), BAR, 0).today!;
  return firstCandlePlan(s.bars, istAt(date, "09:15"), p, BAR);
}

describe("first candle through the engine", () => {
  it("buys at 09:31:30 on days with a large first candle, in its direction, once per index, and holds to the square-off", async () => {
    const { main, small, days } = await replay({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 } });
    const expected = days.flatMap((d) => (["NIFTY", "SENSEX"] as const).map((i) => ({ d, i, plan: dayPlan(i, d) }))).filter((x) => x.plan.side !== null);
    expect(expected.length).toBeGreaterThan(0);
    expect(main.length).toBe(expected.length);
    for (const trades of [main, small]) {
      for (const t of trades) {
        expect(istParts(t.entryMs)).toMatchObject({ hour: 9, minute: 31, second: 30 });
        const plan = dayPlan(t.index as "NIFTY" | "SENSEX", istDate(t.entryMs));
        expect(Math.abs(plan.bodyPct!)).toBeGreaterThan(0.24);
        expect(t.side).toBe(plan.side);
        expect(["SQUARE_OFF", "STOP", "DAILY_LOSS_CAP"]).toContain(t.exitReason);
      }
    }
  }, 120_000);

  it("measures the trade from its entry: the option is bought at the candle's close, not its open", async () => {
    // The decision at 09:31:30 sees the 09:25 bar, whose close is the candle's close and the spot the option is priced at.
    const t = istAt("2026-10-07", "09:31") + 30_000;
    const market = new ReplayMarketDataSource({ candles: fixtures.candles, daily: fixtures.daily }, { lagMs: 90_000 });
    const cfg = makeConfig({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 } });
    for (const index of ["NIFTY", "SENSEX"] as const) {
      const sig = publishedSignal(index, t, market.snapshotSync(t), calendar, cfg);
      const plan = dayPlan(index, "2026-10-07");
      if (plan.side) {
        expect(sig.entry).toBe(plan.side);
        expect(sig.level).toBe(plan.close);
        expect(market.snapshotSync(t).ltp[index]).toBe(plan.close);
      } else expect(sig.entry).toBeNull();
    }
  });

  it("with N3, every position is out at the 11:15 bar (11:16:30) and nothing is entered after 11:15", async () => {
    const { main } = await replay({ strategy: { mode: "FIRST_CANDLE" }, sizing: { maxOpenPerIndex: 1 }, rules: { n3: { enabled: true } } });
    expect(main.length).toBeGreaterThan(0);
    for (const t of main) {
      expect(t.exitMs).toBeLessThanOrEqual(istAt(istDate(t.entryMs), "11:16") + 30_000);
      expect(["SQUARE_OFF", "STOP", "DAILY_LOSS_CAP"]).toContain(t.exitReason);
    }
    expect(main.some((t) => t.exitReason === "SQUARE_OFF" && istParts(t.exitMs).hour === 11)).toBe(true);
  }, 120_000);
});

describe("plan §4 rules through the engine (conviction model)", () => {
  it("N3: entries only 09:30-11:15 and every position out by 11:16:30", async () => {
    const { main } = await replay({ rules: { n3: { enabled: true } }, gates: { minEdgeRatio: -100, minExpectedVsImplied: 0 } });
    for (const t of main) {
      const m = istParts(t.entryMs);
      expect(m.hour * 60 + m.minute).toBeGreaterThanOrEqual(9 * 60 + 30);
      expect(m.hour * 60 + m.minute).toBeLessThan(11 * 60 + 15);
      expect(t.exitMs).toBeLessThanOrEqual(istAt(istDate(t.entryMs), "11:16") + 30_000);
    }
  }, 120_000);

  it("N2 fails closed: three months of daily VIX are too short for the 1-year percentile, so nothing is bought", async () => {
    const { main, small } = await replay({ rules: { n2: { enabled: true } }, gates: { minEdgeRatio: -100, minExpectedVsImplied: 0 } });
    expect(main).toEqual([]);
    expect(small).toEqual([]);
  }, 120_000);

  it("N4: plans next week's NIFTY contract on Monday and SENSEX's on Wednesday, for main and the ₹10k account", async () => {
    const open = { gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000 } };
    const expiryOf = async (patch: DeepPartial<EngineConfig>, account: "main" | "small10k", index: "NIFTY" | "SENSEX", date: string) => {
      const main = makeConfig(patch);
      const cfg = accountConfig(main, account);
      const t = istAt(date, "10:01") + 30_000;
      const deps = createReplayDeps({ cfg, startMs: t, candles: fixtures.candles, daily: fixtures.daily, lagMs: 90_000 });
      const f = computeFeatures(index, await deps.market.snapshot(t), deps.calendar, cfg);
      const risk = await loadRiskState(deps.repo, cfg, await deps.repo.settings.get(), t, "BACKTEST");
      const conviction = publishedConviction(index, t, { ...firstCandleState([], t, p, BAR), entry: "BULL" }, "RANGE", cfg);
      const d = await planEntry({ index, t, features: f, pressure: null, conviction, risk, perf: [] }, deps);
      return d.contract?.expiry;
    };
    for (const account of ["main", "small10k"] as const) {
      expect(await expiryOf(open, account, "NIFTY", "2026-10-05")).toBe("2026-10-06");
      expect(await expiryOf({ ...open, rules: { n4: { enabled: true } } }, account, "NIFTY", "2026-10-05")).toBe("2026-10-13");
      expect(await expiryOf(open, account, "SENSEX", "2026-10-07")).toBe("2026-10-08");
      expect(await expiryOf({ ...open, rules: { n4: { enabled: true } } }, account, "SENSEX", "2026-10-07")).toBe("2026-10-15");
    }
  });
});
