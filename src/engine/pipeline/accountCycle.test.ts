import { describe, expect, it } from "vitest";
import { accountConfig, type AccountId } from "../accounts";
import { istAt, MINUTE_MS } from "../clock";
import { makeConfig, premiumBand, type EngineConfig } from "../config";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import type { Conviction, IndexId, PlanDecision } from "../types";
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
const cfg5k = accountConfig(mainCfg, "small5k");
const configs: Partial<Record<AccountId, EngineConfig>> = { small10k: smallCfg, small5k: cfg5k };

type Followers = Partial<Record<AccountId, ReplayDeps>>;

async function replay(cfg: EngineConfig, accounts: AccountId[], before?: (f: Followers) => Promise<void>, day = DAY) {
  const start = istAt(day, "09:15");
  const main = createReplayDeps({ cfg, startMs: start, candles: fixtures.candles, daily: fixtures.daily });
  const followers: Followers = {};
  for (const id of accounts) followers[id] = createFollowerDeps(main, configs[id]!, id);
  if (before) await before(followers);
  const passedAt = new Set<number>();
  // Every decision each follower made (its repository keeps only the latest per index).
  const followerDecisions: Partial<Record<AccountId, PlanDecision[]>> = {};
  for (let t = start; t <= istAt(day, "15:30"); t += 5 * MINUTE_MS) {
    main.clock.set(t);
    const r = await runTradingCycle(main, { noEvents: true });
    if (r.convictions.NIFTY?.passes) passedAt.add(t);
    for (const id of accounts) (followerDecisions[id] ??= []).push(...(await runFollowerEntries(followers[id]!, r)).decisions);
    const convictions = r.convictions as Partial<Record<IndexId, Conviction>>;
    await runPositionCycle(main, { convictions });
    for (const id of accounts) await runPositionCycle(followers[id]!, { convictions });
  }
  main.clock.set(istAt(day, "16:00"));
  await runEndOfDay(main);
  for (const id of accounts) await runEndOfDay(followers[id]!, { grade: false, performance: false });
  const from = istAt(day, "09:00");
  const to = istAt(day, "16:00");
  const book = async (d: ReplayDeps) => ({
    trades: await d.repo.trades.between(from, to, "BACKTEST"),
    ledger: await d.repo.ledger.get(day, "BACKTEST"),
    // refId is random per order (idempotency key), so it differs between otherwise identical runs.
    orders: (await d.repo.orders.between(from, to, "BACKTEST")).map((o) => ({ ...o, refId: "" })),
  });
  const books: Partial<Record<AccountId, Awaited<ReturnType<typeof book>>>> = {};
  for (const id of accounts) books[id] = await book(followers[id]!);
  return {
    main,
    small: followers.small10k ?? null,
    followers,
    followerDecisions,
    passedAt,
    mainBook: await book(main),
    smallBook: books.small10k ?? null,
    books,
    decisions: await main.repo.decisions.between(from, to),
  };
}

const failedGates = (d: PlanDecision) => d.gates.filter((g) => g.passed === false).map((g) => g.gate);

describe("₹10k account following main's signals (7 Oct replay)", () => {
  it("leaves main's trades, decisions and ledger exactly as without it", async () => {
    const alone = await replay(mainCfg, []);
    const both = await replay(mainCfg, ["small10k"]);
    expect(alone.mainBook.trades.length).toBeGreaterThan(0);
    expect(both.mainBook).toEqual(alone.mainBook);
    expect(both.decisions).toEqual(alone.decisions);
    expect(await both.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER)).toEqual(await alone.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER));
  });

  it("buys one lot in the premium band, only when main's conviction passed, one position at a time", async () => {
    const { small, smallBook, passedAt } = await replay(mainCfg, ["small10k"]);
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
    const alone = await replay(mainCfg, []);
    const killed = await replay(mainCfg, ["small10k"], async (f) => {
      await f.small10k!.repo.settings.update({ killSwitch: true, killReason: "test" }, "test");
    });
    expect(killed.smallBook!.trades).toEqual([]);
    expect(killed.mainBook).toEqual(alone.mainBook);
  });
});

describe("₹5k account following main's signals (7 Oct replay)", () => {
  it("leaves main's trades, decisions and ledger exactly as without it, alongside the ₹10k account", async () => {
    const alone = await replay(mainCfg, []);
    const all = await replay(mainCfg, ["small10k", "small5k"]);
    expect(alone.mainBook.trades.length).toBeGreaterThan(0);
    expect(all.mainBook).toEqual(alone.mainBook);
    expect(all.decisions).toEqual(alone.decisions);
    expect(await all.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER)).toEqual(await alone.main.repo.outcomes.between(0, Number.MAX_SAFE_INTEGER));
    // The ₹10k account's book does not change with the ₹5k account next to it.
    const tenK = await replay(mainCfg, ["small10k"]);
    expect(all.books.small10k).toEqual(tenK.books.small10k);
  });

  it("buys one lot in its band, only on main's passing ticks, at most 2 a day, one at a time", async () => {
    const { followers, books, passedAt } = await replay(mainCfg, ["small10k", "small5k"]);
    const f = followers.small5k!;
    const b = books.small5k!;
    expect(b.trades.length).toBeGreaterThan(0);
    expect(b.trades.length).toBeLessThanOrEqual(2);
    const entries = b.orders.filter((o) => o.reason === "ENTRY");
    expect(entries.filter((o) => o.filledQty > 0).length).toBeLessThanOrEqual(2);
    for (const o of entries) {
      expect(o.qty).toBe(cfg5k.indexSpecs[o.contract.index].lotSize);
      expect(passedAt.has(o.createdMs)).toBe(true);
      const plan = (await f.repo.plans.get(o.planId!))!;
      const band = premiumBand(cfg5k, plan.index);
      expect(plan.lots).toBe(1);
      expect(plan.refPremium).toBeGreaterThanOrEqual(band.minPremium);
      expect(plan.refPremium).toBeLessThanOrEqual(band.maxPremium);
      expect(plan.gates.find((g) => g.gate === "premium_band")?.passed).toBe(true);
      expect(plan.gates.find((g) => g.gate === "loss_room")?.passed).toBe(true);
    }
    const sorted = [...b.trades].sort((x, y) => x.entryMs - y.entryMs);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].entryMs).toBeGreaterThanOrEqual(sorted[i - 1].exitMs);
    expect(await f.repo.positions.open("BACKTEST")).toEqual([]);
    const ledger = b.ledger!;
    expect(ledger.startEquity).toBe(5_000);
    expect(ledger.realized - ledger.charges).toBeCloseTo(b.trades.reduce((s, t) => s + t.pnl, 0), 1);
    expect(ledger.losses).toBeLessThanOrEqual(1);
  });

  it("stops for the day after its first losing trade (7 Oct: a stop-out)", async () => {
    const { books, followerDecisions } = await replay(mainCfg, ["small5k"]);
    const b = books.small5k!;
    const loss = [...b.trades].sort((x, y) => x.entryMs - y.entryMs).find((t) => t.pnl < 0);
    expect(loss).toBeDefined();
    // Nothing is entered after it closes, although main's signal kept passing.
    for (const o of b.orders.filter((x) => x.reason === "ENTRY")) expect(o.createdMs).toBeLessThanOrEqual(loss!.exitMs);
    const after = followerDecisions.small5k!.filter((d) => d.t > loss!.exitMs && d.conviction.passes);
    expect(after.length).toBeGreaterThan(0);
    for (const d of after) {
      expect(d.plan).toBeNull();
      expect(failedGates(d)).toContain("loss_streak");
    }
  });

  it("takes a second entry after a winner but never a third (6 Oct)", async () => {
    const { books, followerDecisions } = await replay(mainCfg, ["small5k"], undefined, "2026-10-06");
    const b = books.small5k!;
    const sorted = [...b.trades].sort((x, y) => x.entryMs - y.entryMs);
    expect(sorted.length).toBe(2);
    expect(sorted[0].pnl).toBeGreaterThanOrEqual(0);
    expect(sorted[1].entryMs).toBeGreaterThanOrEqual(sorted[0].exitMs);
    for (const t of sorted) expect(t.qty).toBe(65);
    // Every later decision of the day is refused by the 2-entry cap (all gates are evaluated each time).
    const after = followerDecisions.small5k!.filter((d) => d.t > sorted[1].exitMs);
    expect(after.length).toBeGreaterThan(0);
    for (const d of after) {
      expect(d.plan).toBeNull();
      expect(failedGates(d)).toContain("trades_today");
    }
  });

  it("stops only the ₹5k account when its kill switch is on", async () => {
    const both = await replay(mainCfg, ["small10k", "small5k"]);
    const killed = await replay(mainCfg, ["small10k", "small5k"], async (f) => {
      await f.small5k!.repo.settings.update({ killSwitch: true, killReason: "test" }, "test");
    });
    expect(killed.books.small5k!.trades).toEqual([]);
    expect(killed.mainBook).toEqual(both.mainBook);
    expect(killed.books.small10k).toEqual(both.books.small10k);
  });
});
