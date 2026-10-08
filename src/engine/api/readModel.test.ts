import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { sample } from "../repo/contract";
import { accountRepository } from "../repo/accountRepo";
import { InMemoryRepository } from "../repo/memory";
import type { Conviction, Fill, OptionContract, Order, PlanDecision, Position, TradePlan } from "../types";
import { ReadModel, llmUsageKey, positionView } from "./readModel";

const NOW = istAt("2026-10-07", "11:00");

const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1322600PE",
  growwSymbol: "NSE-NIFTY-13Oct26-22600-PE",
  exchangeToken: "1",
  expiry: "2026-10-13",
  strike: 22600,
  type: "PE",
  lotSize: 65,
  tickSize: 0.05,
};

function conviction(score: number): Conviction {
  return {
    index: "NIFTY",
    t: NOW,
    score,
    components: [
      { source: "EVENT", value: -0.8, weight: 0.35, horizonMin: 120, enabled: true },
      { source: "MOMENTUM", value: -0.3, weight: 0.25, horizonMin: 60, enabled: true },
    ],
    regime: "EVENT",
    threshold: 0.45,
    passes: Math.abs(score) >= 0.45,
    sizeMult: 1,
    stance: score > 0.1 ? "BULLISH" : score < -0.1 ? "BEARISH" : "NEUTRAL",
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: "pos1",
    planId: "plan1",
    index: "NIFTY",
    side: "BEAR",
    contract,
    mode: "PAPER",
    qty: 65,
    avgEntry: 100,
    entryMs: NOW - 30 * 60_000,
    entryCharges: 28,
    status: "OPEN",
    markPremium: 120,
    markMs: NOW,
    peakPremium: 135,
    unrealized: 1300,
    stops: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: NOW + 90 * 60_000, squareOffMs: istAt("2026-10-07", "15:05") },
    horizonMin: 120,
    convictionAtEntry: -0.6,
    regimeAtEntry: "EVENT",
    dominantSource: "EVENT",
    attribution: [{ source: "EVENT", share: 1 }],
    eventKeysAtEntry: ["k-c_rbi"],
    maePct: -5,
    mfePct: 35,
    ...over,
  };
}

async function setup() {
  const repo = new InMemoryRepository(DEFAULT_CONFIG, NOW);
  const model = new ReadModel({ repo, cfg: DEFAULT_CONFIG, calendar: defaultCalendar, now: NOW, liveTradingEnabled: false, version: "test" });
  return { repo, model };
}

describe("read model", () => {
  it("builds the engine state with defaults", async () => {
    const { repo, model } = await setup();
    await repo.state.set(llmUsageKey("2026-10-07"), { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, calls: 1, clustersScored: 9 });
    await repo.state.set("health:google_rss", { ok: true, lastOkMs: NOW - 60_000, lastErrorMs: null });
    await repo.snapshots.append({ t: NOW, quotes: [{ key: "NIFTY", label: "NIFTY 50", price: 22603, change: -85, changePct: -0.37, asOf: NOW - 120_000 }], features: {}, regimes: {}, pressure: {} });
    const s = await model.getState();
    expect(s).toMatchObject({ dataSource: "engine", mode: "PAPER", liveTradingEnabled: false, armed: false, killSwitch: false });
    expect(s.market).toMatchObject({ phase: "OPEN", nowIst: "2026-10-07T11:00:00+05:30", isHoliday: false });
    expect(s.quotes[0]).toMatchObject({ key: "NIFTY", price: 22603, stale: false, asOf: "2026-10-07T10:58:00+05:30" });
    expect(s.health.rss?.ok).toBe(true);
    expect(s.stats).toMatchObject({ clustersScoredToday: 9, llmInputTokensToday: 1200, llmOutputTokensToday: 300 });
    expect(s.caps.dailyLossCap).toBe(15_000);
  });

  it("explains a signal with contributors, gates and the open position", async () => {
    const { repo, model } = await setup();
    await repo.events.upsertMany([sample.event("c_rbi", { title: "RBI hikes repo rate", numeric: { NIFTY: -0.6, SENSEX: -0.55 }, firstSeenMs: NOW - 40 * 60_000 })]);
    await repo.pressure.append({ index: "NIFTY", t: NOW, epi: -0.5, absPressure: 0.5, activeClusters: 1, freshestEventAgeMin: 40, topContributors: [{ clusterId: "c_rbi", clusterKey: "k-c_rbi", title: "RBI", contribution: -0.5, ageMin: 40 }] });
    const decision: PlanDecision = {
      id: "d1",
      index: "NIFTY",
      t: NOW,
      conviction: conviction(-0.62),
      gates: [
        { gate: "conviction", label: "Conviction beyond threshold", passed: true, detail: "0.62 ≥ 0.45" },
        { gate: "edge", label: "Expected move beats theta + costs", passed: false, detail: "edge 0.10 < 0.15" },
      ],
      plan: null,
      contract,
      refPremium: 101.5,
      expectedMovePct: 0.31,
      impliedMovePct: 0.4,
      edgeRatio: 0.1,
      noPlanReason: "edge gate failed",
    };
    await repo.decisions.append(decision);
    await repo.positions.save(position());
    const [sig] = await model.getSignals();
    expect(sig).toMatchObject({ index: "NIFTY", stance: "BEARISH", conviction: -0.62, regime: "EVENT", allGatesPassed: false, edgeRatio: 0.1 });
    expect(sig.contract).toMatchObject({ label: "NIFTY 13-OCT-2026 22600 PE", lots: 0, premium: 101.5 });
    expect(sig.contributors[0]).toMatchObject({ clusterId: "c_rbi", title: "RBI hikes repo rate", weight: -1, ageMin: 40, score: -0.6 });
    expect(sig.rationale).toMatch(/Bearish NIFTY/);
    expect(sig.rationale).toMatch(/Expected move beats theta/);
    expect(sig.position?.id).toBe("pos1");
  });

  it("maps positions with stop, target and trail levels", () => {
    const v = positionView(position());
    expect(v).toMatchObject({ stopPrice: 70, targetPrice: 150, ltp: 120, pnl: 1272, qty: 65, openedAt: "2026-10-07T10:30:00+05:30" });
    expect(v.trailPrice).toBeCloseTo(117.5);
    expect(v.pnlPct).toBeCloseTo((1272 / 6500) * 100, 1);
    expect(v.contract.premiumAtRisk).toBe(1950);
  });

  it("lists events by tab with decay and pending clusters", async () => {
    const { repo, model } = await setup();
    await repo.clusters.upsertMany([
      sample.cluster("c1", { firstSeenMs: NOW - 2 * 3_600_000, lastSeenMs: NOW - 60_000, representativeTitle: "Fed signals cut", status: "SCORED" }),
      sample.cluster("c2", { firstSeenMs: NOW - 600_000, lastSeenMs: NOW - 300_000, representativeTitle: "Brent jumps 4% on Iran strike", status: "UNSCORED" }),
    ]);
    await repo.events.upsertMany([sample.event("c1", { taxonomy: "US_MARKET_FED", halfLifeHours: 2, firstSeenMs: NOW - 2 * 3_600_000 })]);
    const all = await model.getEvents({ tab: "ALL" });
    expect(all.map((e) => e.clusterId)).toEqual(["c1", "c2"]);
    expect(all[0]).toMatchObject({ tab: "MACRO", scorer: "llm", decayRemaining: 0.5 });
    expect(all[1]).toMatchObject({ scorer: "pending", impacts: [] });
    expect((await model.getEvents({ tab: "MACRO" })).map((e) => e.clusterId)).toEqual(["c1"]);
    const detail = await model.getEventDetail("c1");
    expect(detail?.headlines[0]).toEqual({ title: "c1", url: "u" });
    expect(await model.getEventDetail("nope")).toBeNull();
  });

  it("shows upcoming scheduled events with blackout windows", async () => {
    const { model } = await setup();
    const list = await model.getScheduled(24 * 7);
    const expiry = list.find((e) => e.kind === "EXPIRY");
    expect(expiry?.blackoutStart).toBeNull();
    for (const e of list) expect(Date.parse(e.at)).toBeGreaterThanOrEqual(NOW - 2 * 3_600_000);
  });

  it("reports P&L with charge breakdown from the displayed book", async () => {
    const { repo, model } = await setup();
    await repo.ledger.save({ date: "2026-10-06", mode: "PAPER", realized: 2000, unrealized: 0, charges: 100, trades: 1, wins: 1, losses: 0, consecutiveLosses: 0, ordersPlaced: 2, maxIntradayDrawdown: 0, peakEquity: 501_900, startEquity: 500_000, updatedMs: NOW });
    await repo.ledger.save({ date: "2026-10-07", mode: "PAPER", realized: -500, unrealized: 300, charges: 50, trades: 1, wins: 0, losses: 1, consecutiveLosses: 1, ordersPlaced: 2, maxIntradayDrawdown: 400, peakEquity: 501_900, startEquity: 501_900, updatedMs: NOW });
    const pnl = await model.getPnl(5);
    expect(pnl.mode).toBe("PAPER");
    expect(pnl.today).toMatchObject({ date: "2026-10-07", net: -250, equityEnd: 501_650 });
    expect(pnl.history.map((h) => h.date)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(pnl.equityCurve.at(-1)?.equity).toBe(501_650);
    const st = await model.getState();
    expect(st.caps.dailyLossUsed).toBe(250);
  });
});

describe("read model for the ₹10k account", () => {
  const cfg10k = accountConfig(DEFAULT_CONFIG, "small10k");
  const accounts = [
    { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, capitalRupees: 500_000 },
    { id: "small10k", label: "₹10k account", shortLabel: "₹10k", paperOnly: true, capitalRupees: 10_000 },
  ];

  async function setupBoth() {
    const base = new InMemoryRepository(DEFAULT_CONFIG, NOW);
    const small = accountRepository(base, "small10k", cfg10k, () => NOW);
    const ctx = { calendar: defaultCalendar, now: NOW, liveTradingEnabled: true, version: "test", accounts };
    const main = new ReadModel({ ...ctx, repo: base, cfg: DEFAULT_CONFIG, account: accounts[0] });
    const tenK = new ReadModel({ ...ctx, repo: small, cfg: cfg10k, account: accounts[1] });
    return { base, small, main, tenK };
  }

  const order = (id: string): Order =>
    ({ id, refId: `R${id}AAAAAAAA`.slice(0, 10), contract, side: "BUY", qty: 65, type: "LIMIT", product: "MIS", reason: "ENTRY", filledQty: 65, status: "FILLED", mode: "PAPER", createdMs: NOW, updatedMs: NOW }) as Order;
  const fill = (id: string, orderId: string): Fill =>
    ({ id, orderId, t: NOW, qty: 65, price: 50, slippageTicks: 0, charges: { brokerage: 20, stt: 0, exchangeTxn: 1, sebi: 0, stampDuty: 0, ipft: 0, gst: 4, total: 25 } }) as Fill;

  it("describes the account: ₹10,000 capital, paper only", async () => {
    const { tenK } = await setupBoth();
    const s = await tenK.getState();
    expect(s.account?.id).toBe("small10k");
    expect(s.accounts?.map((a) => a.id)).toEqual(["main", "small10k"]);
    expect(s.liveTradingEnabled).toBe(false);
    expect(s.caps.dailyLossCap).toBe(2_500);
    const pnl = await tenK.getPnl(5);
    expect(pnl.startingEquity).toBe(10_000);
  });

  it("never shows one account's orders, fills or positions in the other's view", async () => {
    const { base, small, main, tenK } = await setupBoth();
    await base.orders.save(order("m1"));
    await base.fills.append(fill("fm", "m1"));
    await small.orders.save(order("s1"));
    await small.fills.append(fill("fs", "s1"));
    await base.positions.save(position({ id: "pm" }));
    await small.positions.save(position({ id: "ps" }));

    const mainOrders = await main.getOrders("2026-10-07");
    expect(mainOrders.orders.map((o) => o.id)).toEqual(["m1"]);
    expect(mainOrders.fills.map((f) => f.id)).toEqual(["fm"]);
    const smallOrders = await tenK.getOrders("2026-10-07");
    expect(smallOrders.orders.map((o) => [o.id, o.mode])).toEqual([["s1", "PAPER"]]);
    expect(smallOrders.fills.map((f) => f.id)).toEqual(["fs"]);
    expect((await main.getPositions()).map((p) => p.id)).toEqual(["pm"]);
    expect((await tenK.getPositions()).map((p) => p.id)).toEqual(["ps"]);
  });

  it("lists each account's own trades of the day as copy tickets, open first", async () => {
    const { base, small, main, tenK } = await setupBoth();
    const plan = (id: string): TradePlan =>
      ({ id, index: "NIFTY", t: NOW - 30 * 60_000, side: "BEAR", contract, lots: 1, qty: 65, entryType: "LIMIT", refPremium: 100, refSpot: 22_650, horizonMin: 90, expectedMovePct: 0.4, impliedMovePct: 0.3, breakevenMovePct: 0.2, edgeRatio: 1.3, stops: position().stops, riskRupees: 2_000, riskPct: 0.4, kellyFraction: 0, conviction: conviction(-0.6), gates: [], dominantSource: "EVENT" }) as TradePlan;
    await base.plans.save(plan("plan-m"));
    await small.plans.save(plan("plan-s"));
    await base.positions.save(position({ id: "m-open", planId: "plan-m" }));
    await base.positions.save(position({ id: "m-closed", planId: "plan-m", entryMs: NOW - 90 * 60_000, status: "CLOSED", qty: 0, exitedQty: 65, exitMs: NOW - 60 * 60_000, avgExit: 130, exitReason: "TARGET", realized: 1_950, exitCharges: 40 }));
    await base.positions.save(position({ id: "m-yesterday", planId: "plan-m", entryMs: NOW - 86_400_000, status: "CLOSED", qty: 0, exitedQty: 65, exitMs: NOW - 86_000_000, avgExit: 90, exitReason: "STOP", realized: -650, exitCharges: 40 }));
    await small.positions.save(position({ id: "s-open", planId: "plan-s" }));

    // The entry order's limit (here not the plan's) is what the ticket shows.
    await base.orders.save({ ...order("e-open"), positionId: "m-open", planId: "plan-m", limitPrice: 100.15 });
    const mine = await main.getCopyTickets("2026-10-07");
    expect(mine.map((t) => [t.id, t.status])).toEqual([["m-open", "OPEN"], ["m-closed", "CLOSED"]]);
    expect(mine[0].entry.limitPrice).toBe(100.15);
    expect(mine[1].entry.limitPrice).toBeNull();
    expect(mine[0].account.id).toBe("main");
    expect(mine[0].setup?.conviction).toBe(-0.6);
    expect(mine[1].exit?.pnl).toBeCloseTo(1_950 - 28 - 40, 2);
    const theirs = await tenK.getCopyTickets("2026-10-07");
    expect(theirs.map((t) => t.id)).toEqual(["s-open"]);
    expect(theirs[0].account).toMatchObject({ id: "small10k", capitalRupees: 10_000 });
    // Other days list only their own trades (today's open position is not one of them).
    expect((await main.getCopyTickets("2026-10-06")).map((t) => [t.id, t.exit?.reason])).toEqual([["m-yesterday", "STOP"]]);
    expect(await main.getCopyTickets("2026-10-05")).toEqual([]);
  });

  it("shows readings from main's decision for plans made before plans carried them", async () => {
    const { base, main } = await setupBoth();
    const d: PlanDecision = {
      id: "d1",
      index: "NIFTY",
      t: NOW - 30 * 60_000,
      conviction: conviction(-0.6),
      gates: [],
      plan: { id: "plan-old", index: "NIFTY", t: NOW - 30 * 60_000, side: "BEAR", contract, lots: 1, qty: 65, entryType: "LIMIT", refPremium: 100, refSpot: 22_650, horizonMin: 90, expectedMovePct: 0.4, impliedMovePct: 0.3, breakevenMovePct: 0.2, edgeRatio: 1.3, stops: position().stops, riskRupees: 2_000, riskPct: 0.4, kellyFraction: 0, conviction: conviction(-0.6), gates: [], dominantSource: "EVENT" },
      contract,
      refPremium: 100,
      expectedMovePct: 0.4,
      impliedMovePct: 0.3,
      edgeRatio: 1.3,
      noPlanReason: null,
      indicators: { rsi14: 41 } as PlanDecision["indicators"],
    };
    await base.decisions.append(d);
    await base.plans.save(d.plan!);
    await base.positions.save(position({ id: "p-old", planId: "plan-old" }));
    const [t] = await main.getCopyTickets("2026-10-07");
    expect(t.market.indicators?.rsi14).toBe(41);
  });

  it("shows its own kill switch, not main's", async () => {
    const { base, small, tenK, main } = await setupBoth();
    await base.settings.update({ killSwitch: true, killReason: "main only" }, "test");
    expect((await tenK.getState()).killSwitch).toBe(false);
    await small.settings.update({ killSwitch: true, killReason: "₹10k only" }, "test");
    expect((await tenK.getState()).heartbeat.phase).toBe("KILLED");
    expect((await main.getState()).killReason).toBe("main only");
  });
});

describe("source health", () => {
  it("reads every health key at once and keeps the freshest per source", async () => {
    const repo = new InMemoryRepository(DEFAULT_CONFIG, NOW);
    await repo.state.set("health:bing_rss", { ok: true, lastOkMs: NOW - 60_000, lastErrorMs: null });
    await repo.state.set("health:publisher_rss", { ok: false, lastOkMs: NOW - 600_000, lastErrorMs: NOW, detail: "503" });
    await repo.state.set("health:yahoo", { ok: true, lastOkMs: NOW, lastErrorMs: null });
    let inFlight = 0;
    let most = 0;
    const get = repo.state.get.bind(repo.state);
    const state = {
      ...repo.state,
      get: async <T,>(key: string) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return get<T>(key);
      },
    };
    const model = new ReadModel({ repo: { ...repo, state } as unknown as InMemoryRepository, cfg: DEFAULT_CONFIG, calendar: defaultCalendar, now: NOW, liveTradingEnabled: false, version: "test" });
    const h = await model.health();
    // All 11 keys (7 sources) are requested together instead of one after another.
    expect(most).toBe(11);
    expect(h.rss).toEqual({ ok: true, lastOkAt: "2026-10-07T10:59:00+05:30" });
    expect(h.yahoo).toEqual({ ok: true, lastOkAt: "2026-10-07T11:00:00+05:30" });
    expect(h.gdelt).toBeUndefined();
  });
});
