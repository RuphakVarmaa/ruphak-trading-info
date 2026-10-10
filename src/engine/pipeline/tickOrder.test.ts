/**
 * Tick cost of the follower accounts: main's exit check comes before any follower work, a follower
 * that cannot trade fetches no option quotes, and the risk state's reads go out together.
 */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import type { OptionQuoteSource, Repository } from "../ports";
import { InMemoryRepository } from "../repo/memory";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps } from "../testing/replayHarness";
import { runFollowerEntries } from "./accountCycle";
import { loadRiskState } from "./riskState";
import { mainExitsFirst } from "./tickOrder";
import { runTradingCycle } from "./tradingCycle";

describe("order of one engine tick", () => {
  it("runs main's exits before any follower entry or exit", async () => {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
    };
    await mainExitsFirst({
      mainExits: step("main exits"),
      followers: [
        { entries: step("10k entries"), exits: step("10k exits") },
        { entries: step("5k entries"), exits: step("5k exits") },
      ],
    });
    expect(calls).toEqual(["main exits", "10k entries", "5k entries", "10k exits", "5k exits"]);
  });
});

describe("a follower that cannot trade", () => {
  const fx = loadMarketFixtures();
  const mainCfg = makeConfig({
    indices: ["NIFTY", "SENSEX"],
    conviction: { thresholds: { TREND_UP: 0.05, TREND_DOWN: 0.05, RANGE: 0.05, HIGH_VOL: 0.05, EVENT: 0.05 }, counterTrendThreshold: 0.05 },
    gates: { minEdgeRatio: -100, minExpectedVsImplied: 0, maxDataAgeSec: 100_000, minOi: 0, maxSpreadPct: 100 },
  });
  const T = istAt("2026-10-07", "11:00");

  async function followerTick(setup: (repo: Repository) => Promise<void>) {
    const main = createReplayDeps({ cfg: mainCfg, startMs: T, candles: fx.candles, daily: fx.daily });
    const report = await runTradingCycle(main, { noEvents: true });
    const f = createFollowerDeps(main, accountConfig(mainCfg, "small5k"), "small5k");
    let quotes = 0;
    const inner = f.optionQuotes;
    const counting: OptionQuoteSource = { kind: inner.kind, quote: (c, ctx) => (quotes++, inner.quote(c, ctx)) };
    await setup(f.repo);
    const r = await runFollowerEntries({ ...f, optionQuotes: counting }, report);
    return { r, quotes };
  }

  it("fetches option quotes when it can trade (control)", async () => {
    const { r, quotes } = await followerTick(async () => {});
    expect(r.decisions.length).toBe(2);
    expect(quotes).toBeGreaterThan(0);
  });

  it("fetches no option quotes once an account check fails, and still says why", async () => {
    const killed = await followerTick((repo) => repo.settings.update({ killSwitch: true, killReason: "test" }, "test").then(() => undefined));
    expect(killed.quotes).toBe(0);
    expect(killed.r.entries).toEqual([]);
    for (const d of killed.r.decisions) {
      expect(d.contract).toBeNull();
      expect(d.plan).toBeNull();
      expect(d.gates.find((g) => g.gate === "halt")?.passed).toBe(false);
      expect(d.noPlanReason).toMatch(/Kill switch and daily loss cap/);
    }
  });
});

describe("loadRiskState", () => {
  it("sends its reads together", async () => {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, 0);
    let inFlight = 0;
    let most = 0;
    const slow = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return fn(...a);
    };
    const wrapped = {
      ...repo,
      ledger: { ...repo.ledger, get: slow(repo.ledger.get), range: slow(repo.ledger.range) },
      positions: { ...repo.positions, open: slow(repo.positions.open), closedBetween: slow(repo.positions.closedBetween) },
      orders: { ...repo.orders, open: slow(repo.orders.open), between: slow(repo.orders.between) },
    } as unknown as Repository;
    const cfg = accountConfig(DEFAULT_CONFIG, "small5k");
    const r = await loadRiskState(wrapped, cfg, await repo.settings.get(), istAt("2026-10-07", "11:00"), "PAPER");
    expect(r.pendingEntries).toEqual([]);
    expect(most).toBeGreaterThanOrEqual(6);
  });
});
