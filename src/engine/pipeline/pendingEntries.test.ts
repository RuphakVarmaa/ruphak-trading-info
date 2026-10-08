/**
 * Entry orders that rest unfilled (a marketable limit whose ask moved more than two ticks during the
 * paper latency, or any live order still at the exchange) must take a position slot: otherwise the
 * next index in the same tick, or the next tick, sends another entry and both can fill.
 */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { istAt, MINUTE_MS } from "../clock";
import { makeConfig, maxOpenTotal, type EngineConfig } from "../config";
import type { Broker, OrderResult } from "../ports";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId, Order, OrderRequest } from "../types";
import { runFollowerEntries } from "./accountCycle";
import { runPositionCycle } from "./positionCycle";
import { runTradingCycle } from "./tradingCycle";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();

// Both indices, permissive signal gates so that most ticks want an entry.
const mainCfg = makeConfig({
  indices: ["NIFTY", "SENSEX"],
  conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
  gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0, maxSpreadPct: 100 },
  sizing: { maxOpenPerIndex: 1, maxOpenTotal: 1, maxTradesPerDay: 12 },
});

/** Accepts entries but never fills them (exits behave as usual). */
function restingEntries(inner: Broker, now: () => number): Broker {
  let n = 0;
  return {
    mode: inner.mode,
    placeOrder: async (req: OrderRequest): Promise<OrderResult> => {
      if (req.reason !== "ENTRY") return inner.placeOrder(req);
      const t = now();
      const order: Order = { ...req, id: `rest-${++n}`, status: "OPEN", filledQty: 0, createdMs: t, updatedMs: t, mode: inner.mode };
      return { order, fills: [] };
    },
    refreshOrder: async (o) => (o.reason === "ENTRY" ? { order: { ...o, updatedMs: now() }, fills: [] } : inner.refreshOrder(o)),
    cancelOrder: (o) => inner.cancelOrder(o),
    positions: () => inner.positions(),
    health: () => inner.health(),
  };
}

async function restingEntryOrders(d: ReplayDeps) {
  return (await d.repo.orders.open("BACKTEST")).filter((o) => o.reason === "ENTRY");
}

/** Replays the day and records the most entry orders resting at once (overall and per index). */
async function replay(follow: boolean) {
  const start = istAt(DAY, "09:15");
  const main = createReplayDeps({ cfg: mainCfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  main.broker = restingEntries(main.broker, () => main.clock.now());
  let follower: ReplayDeps | null = null;
  if (follow) {
    follower = createFollowerDeps(main, accountConfig(mainCfg, "small5k"), "small5k");
    follower.broker = restingEntries(follower.broker, () => main.clock.now());
  }
  const most = { main: { total: 0, perIndex: 0 }, small5k: { total: 0, perIndex: 0 } };
  const track = async (d: ReplayDeps, into: { total: number; perIndex: number }) => {
    const open = await restingEntryOrders(d);
    into.total = Math.max(into.total, open.length);
    for (const index of ["NIFTY", "SENSEX"] as IndexId[]) into.perIndex = Math.max(into.perIndex, open.filter((o) => o.contract.index === index).length);
  };
  let entries = 0;
  for (let t = start; t <= istAt(DAY, "15:30"); t += 5 * MINUTE_MS) {
    main.clock.set(t);
    const r = await runTradingCycle(main, { noEvents: true });
    entries += r.entries.length;
    await track(main, most.main);
    if (follower) {
      await runFollowerEntries(follower, r);
      await track(follower, most.small5k);
    }
    const convictions = r.convictions as Partial<Record<IndexId, Conviction>>;
    await runPositionCycle(main, { convictions });
    if (follower) await runPositionCycle(follower, { convictions });
  }
  return { most, entries };
}

const limits = (cfg: EngineConfig) => ({ total: maxOpenTotal(cfg), perIndex: cfg.sizing.maxOpenPerIndex });

describe("entry orders that have not filled yet", () => {
  it("count against main's open-position limits", async () => {
    const { most, entries } = await replay(false);
    expect(entries).toBeGreaterThan(1);
    expect(most.main.total).toBeLessThanOrEqual(limits(mainCfg).total);
    expect(most.main.perIndex).toBeLessThanOrEqual(limits(mainCfg).perIndex);
  });

  it("count against the ₹5k account's one position at a time", async () => {
    const { most } = await replay(true);
    const cfg = accountConfig(mainCfg, "small5k");
    expect(most.small5k.total).toBeGreaterThan(0);
    expect(most.small5k.total).toBeLessThanOrEqual(limits(cfg).total);
    expect(most.small5k.perIndex).toBeLessThanOrEqual(limits(cfg).perIndex);
  });
});
