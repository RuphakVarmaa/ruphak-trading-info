import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { istAt, MINUTE_MS } from "../clock";
import { makeConfig, type EngineConfig } from "../config";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId } from "../types";
import { runFollowerEntries } from "./accountCycle";
import { runEndOfDay } from "./dayLifecycle";
import { runPositionCycle } from "./positionCycle";
import { runTradingCycle } from "./tradingCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();

// Low thresholds and no edge floor so the 7 Oct fixture produces several entries.
const mainCfg = makeConfig({
  indices: ["NIFTY"],
  conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0 },
  sizing: { maxTradesPerDay: 3 },
});
const smallCfg = accountConfig(mainCfg, "small10k");

async function replay(cfg: EngineConfig, follower: boolean, before?: (f: ReplayDeps) => Promise<void>) {
  const start = istAt(DAY, "09:15");
  const main = createReplayDeps({ cfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  const small = follower ? createFollowerDeps(main, smallCfg, "small10k") : null;
  if (small && before) await before(small);
  const passedAt = new Set<number>();
  for (let t = start; t <= istAt(DAY, "15:30"); t += 5 * MINUTE_MS) {
    main.clock.set(t);
    const r = await runTradingCycle(main, { noEvents: true });
    if (r.convictions.NIFTY?.passes) passedAt.add(t);
    if (small) await runFollowerEntries(small, r);
    const convictions = r.convictions as Partial<Record<IndexId, Conviction>>;
    await runPositionCycle(main, { convictions });
    if (small) await runPositionCycle(small, { convictions });
  }
  main.clock.set(istAt(DAY, "16:00"));
  await runEndOfDay(main);
  if (small) await runEndOfDay(small, { grade: false, performance: false });
  const from = istAt(DAY, "09:00");
  const to = istAt(DAY, "16:00");
  const book = async (d: ReplayDeps) => ({
    trades: await d.repo.trades.between(from, to, "BACKTEST"),
    ledger: await d.repo.ledger.get(DAY, "BACKTEST"),
    // refId is random per order (idempotency key), so it differs between otherwise identical runs.
    orders: (await d.repo.orders.between(from, to, "BACKTEST")).map((o) => ({ ...o, refId: "" })),
  });
  return { main, small, passedAt, mainBook: await book(main), smallBook: small ? await book(small) : null, decisions: await main.repo.decisions.between(from, to) };
}

describe("₹10k account following main's signals (7 Oct replay)", () => {
  it("leaves main's trades, decisions and ledger exactly as without it", async () => {
    const alone = await replay(mainCfg, false);
    const both = await replay(mainCfg, true);
    expect(alone.mainBook.trades.length).toBeGreaterThan(0);
    expect(both.mainBook).toEqual(alone.mainBook);
    expect(both.decisions).toEqual(alone.decisions);
    expect(await both.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER)).toEqual(await alone.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER));
  });

  it("buys one lot in the premium band, only when main's conviction passed, one position at a time", async () => {
    const { small, smallBook, passedAt } = await replay(mainCfg, true);
    const trades = smallBook!.trades;
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.length).toBeLessThanOrEqual(smallCfg.sizing.maxTradesPerDay);
    const entries = smallBook!.orders.filter((o) => o.reason === "ENTRY");
    for (const o of entries) {
      expect(o.qty).toBe(65);
      expect(passedAt.has(o.createdMs)).toBe(true);
      const plan = (await small!.repo.plans.get(o.planId!))!;
      expect(plan.refPremium).toBeGreaterThanOrEqual(smallCfg.selection.minPremium);
      expect(plan.refPremium).toBeLessThanOrEqual(smallCfg.selection.maxPremium);
      expect(plan.gates.find((g) => g.gate === "premium_band")?.passed).toBe(true);
    }
    const sorted = [...trades].sort((a, b) => a.entryMs - b.entryMs);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].entryMs).toBeGreaterThanOrEqual(sorted[i - 1].exitMs);
    expect(await small!.repo.positions.open("BACKTEST")).toEqual([]);
    const ledger = smallBook!.ledger!;
    expect(ledger.startEquity).toBe(10_000);
    expect(ledger.realized - ledger.charges).toBeCloseTo(trades.reduce((s, t) => s + t.pnl, 0), 1);
  });

  it("stops only the ₹10k account when its kill switch is on", async () => {
    const alone = await replay(mainCfg, false);
    const killed = await replay(mainCfg, true, async (f) => {
      await f.repo.settings.update({ killSwitch: true, killReason: "test" }, "test");
    });
    expect(killed.smallBook!.trades).toEqual([]);
    expect(killed.mainBook).toEqual(alone.mainBook);
  });
});
