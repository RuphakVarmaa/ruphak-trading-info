import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { sample } from "../repo/contract";
import { InMemoryRepository } from "../repo/memory";
import type { Conviction, OptionContract, PlanDecision, Position } from "../types";
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
