import { describe, expect, it } from "vitest";
import { accountConfig, accountSpec } from "../accounts";
import { computeCharges } from "../broker/charges";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { NEUTRAL_INDICATORS, NEUTRAL_OPENING_RANGE } from "../market/features";
import { applyExitFills } from "../pipeline/execution";
import { evaluateExits, trailPrice } from "../strategy/exits";
import { createReplayDeps } from "../testing/replayHarness";
import type { Fill, IndicatorView, OptionContract, Position, Quote, TradePlan } from "../types";
import { accountTag, copyEntryText, copyExitText, copyLink, copyTicketView, copyTrailText, expiryLabel, setupReasons } from "./copyTicket";

const T = istAt("2026-10-09", "10:20");
const TEN_K = { id: "small10k", label: "₹10k account", shortLabel: "₹10k", paperOnly: true, capitalRupees: 10_000 };
const MAIN = { id: "main", label: "Main account", shortLabel: "Main", paperOnly: false, capitalRupees: 500_000 };

const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1325000PE",
  growwSymbol: "NSE-NIFTY-13Oct26-25000-PE",
  exchangeToken: "1",
  expiry: "2026-10-13",
  strike: 25000,
  type: "PE",
  lotSize: 65,
  tickSize: 0.05,
};

const stops = { stopPct: -35, targetPct: 60, trailActivatePct: 30, trailGivebackPct: 50, timeStopMs: istAt("2026-10-09", "11:50"), squareOffMs: istAt("2026-10-09", "15:05") };

const indicators: IndicatorView = {
  ...NEUTRAL_INDICATORS,
  rsi14: 38,
  adx14: 24,
  plusDi14: 17,
  minusDi14: 28,
  supertrendDir: -1,
  vwap: 25_080,
  vwapZ: -1.3,
  prevDayClose: 25_200,
  spot: 25_050,
  atrPct5m: 0.08,
  vwapDistPct: -0.12,
  openingRange: { ...NEUTRAL_OPENING_RANGE, high: 25_160, low: 25_070, state: "BROKE_DOWN", strengthAtr: 0.4, barsOutside: 2, lastBreak: "DOWN" },
};

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    id: "plan1",
    index: "NIFTY",
    t: T,
    side: "BEAR",
    contract,
    lots: 1,
    qty: 65,
    entryType: "LIMIT",
    limitPrice: 62.5,
    refPremium: 62.4,
    refSpot: 25_050,
    horizonMin: 90,
    expectedMovePct: 0.4,
    impliedMovePct: 0.3,
    breakevenMovePct: 0.25,
    edgeRatio: 1.33,
    stops,
    riskRupees: 1_420,
    riskPct: 14.2,
    kellyFraction: 0,
    conviction: {
      index: "NIFTY",
      t: T,
      score: -0.52,
      components: [
        { source: "MOMENTUM", value: -0.4, weight: 0.15, horizonMin: 60, enabled: true, notes: "z15 -1.2" },
        { source: "ORB", value: -0.9, weight: 0.15, horizonMin: 90, enabled: true, notes: "below 25,070–25,160 by 0.40 ATR, 2 bars outside" },
        { source: "GAP", value: 0, weight: 0.1, horizonMin: 60, enabled: true, abstain: true, notes: "undecided" },
        { source: "VOL_REGIME", value: 0, weight: 0, horizonMin: 60, enabled: true, notes: "RV/IV 1.30: options cheap" },
      ],
      regime: "RANGE",
      threshold: 0.45,
      passes: true,
      sizeMult: 1,
      stance: "BEARISH",
    },
    gates: [{ gate: "quote", label: "Usable option quote", passed: true, detail: "synthetic bid 62.1 / ask 62.4" }],
    dominantSource: "ORB",
    indicators,
    vix: 13.9,
    retFromOpenPct: -0.4,
    quoteSource: "synthetic",
    ...over,
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
    avgEntry: 62.4,
    entryMs: T + 2_000,
    entryCharges: 27.5,
    status: "OPEN",
    markPremium: 70.2,
    markMs: T + 600_000,
    peakPremium: 72,
    unrealized: (70.2 - 62.4) * 65,
    stops,
    horizonMin: 90,
    convictionAtEntry: -0.52,
    regimeAtEntry: "RANGE",
    dominantSource: "ORB",
    attribution: [],
    eventKeysAtEntry: [],
    maePct: -3,
    mfePct: 15.4,
    ...over,
  };
}

describe("copy ticket", () => {
  it("says what to buy, at which levels, with the risk in rupees", () => {
    const t = copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(t.headline).toBe("BUY NIFTY 25000 PE (13 Oct)");
    expect(t.searchText).toBe("NIFTY 25000 PE");
    expect(t.expiryLabel).toBe("Tue 13 Oct");
    expect(t.qty).toBe(65);
    expect(t.lots).toBe(1);
    expect(t.entry.premium).toBe(62.4);
    expect(t.entry.costRupees).toBeCloseTo(4_056, 2);
    expect(t.entry.priceSource).toBe("model");
    expect(t.levels.stop).toBe(40.55);
    expect(t.levels.target).toBe(99.85);
    expect(t.levels.trailActivateAt).toBe(81.15);
    expect(t.levels.trail).toBeNull();
    expect(t.levels.timeStopAt).toBe("2026-10-09T11:50:00+05:30");
    const expectedRisk = (62.4 - 40.55) * 65 + 27.5 + computeCharges("SELL", 40.55, 65, "NSE", "2026-10-09").total;
    expect(t.riskAtStop.rupees).toBe(Math.round(expectedRisk));
    expect(t.riskAtStop.pctOfCapital).toBeCloseTo((expectedRisk / 10_000) * 100, 1);
  });

  it("puts the skip level half the expected move past the entry, in the trade's direction", () => {
    const bear = copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(bear.entry.skipBeyondSpot).toBeCloseTo(25_050 * (1 - 0.002), 2);
    const bull = copyTicketView({ position: position({ side: "BULL" }), plan: plan({ side: "BULL" }), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(bull.entry.skipBeyondSpot).toBeCloseTo(25_050 * 1.002, 2);
    expect(bull.steps.join(" ")).toContain("already above 25,100");
  });

  it("marks an open trade and reports a closed one after all charges", () => {
    const open = copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(open.live?.movePct).toBeCloseTo(12.5, 1);
    expect(open.live?.pnl).toBeCloseTo((70.2 - 62.4) * 65 - 27.5, 2);
    expect(open.exit).toBeNull();

    const closed = copyTicketView({
      position: position({ status: "CLOSED", qty: 0, exitedQty: 65, exitMs: T + 42 * 60_000, avgExit: 99.9, exitReason: "TARGET", realized: (99.9 - 62.4) * 65, exitCharges: 41 }),
      plan: plan(),
      account: TEN_K,
      timeStopMinPnlPct: 10,
    });
    expect(closed.qty).toBe(65);
    expect(closed.live).toBeNull();
    expect(closed.levels.trail).toBeNull();
    expect(closed.exit).toMatchObject({ reason: "TARGET", reasonText: "Target hit", holdMin: 42 });
    expect(closed.exit!.pnl).toBeCloseTo((99.9 - 62.4) * 65 - 27.5 - 41, 2);
    expect(closed.exit!.movePct).toBeCloseTo(60.1, 1);
  });

  it("explains the setup from the signals that voted, strongest first", () => {
    const reasons = setupReasons(plan());
    expect(reasons[0]).toMatch(/^Opening-range breakout, bearish \(69% of the vote\): below 25,070–25,160/);
    expect(reasons[1]).toMatch(/^Intraday momentum, bearish \(31% of the vote\)/);
    expect(reasons.at(-1)).toBe("Volatility: RV/IV 1.30: options cheap");
    const t = copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(t.setup?.components.map((c) => c.source)).toEqual(["ORB", "MOMENTUM", "GAP", "VOL_REGIME"]);
    expect(t.market.changePct).toBeCloseTo((25_050 / 25_200 - 1) * 100, 2);
  });

  it("falls back for older plans: decision readings and the quote gate's source", () => {
    const old = plan({ indicators: undefined, vix: undefined, quoteSource: undefined, gates: [{ gate: "quote", label: "q", passed: true, detail: "groww bid 61 / ask 62.4" }] });
    const t = copyTicketView({ position: position(), plan: old, account: TEN_K, timeStopMinPnlPct: 10, fallbackIndicators: indicators });
    expect(t.market.indicators?.rsi14).toBe(38);
    expect(t.market.vix).toBeNull();
    expect(t.entry.priceSource).toBe("broker");
    const none = copyTicketView({ position: position(), plan: null, account: TEN_K, timeStopMinPnlPct: 10 });
    expect(none.setup).toBeNull();
    expect(none.entry.skipBeyondSpot).toBeNull();
  });

  it("formats SENSEX tickets with its own lot size", () => {
    const sx: OptionContract = { ...contract, index: "SENSEX", exchange: "BSE", tradingSymbol: "SENSEX26O1582000CE", strike: 82_000, type: "CE", lotSize: 20, expiry: "2026-10-15" };
    const t = copyTicketView({ position: position({ index: "SENSEX", side: "BULL", contract: sx, qty: 20, avgEntry: 180 }), plan: null, account: TEN_K, timeStopMinPnlPct: 10 });
    expect(t.headline).toBe("BUY SENSEX 82000 CE (15 Oct)");
    expect(t.expiryLabel).toBe("Thu 15 Oct");
    expect(t.lots).toBe(1);
    expect(t.entry.costRupees).toBe(3_600);
  });
});

describe("the too-late-to-copy level in the texts", () => {
  it("rounds so a copier never enters past the engine's level (down for calls, up for puts)", () => {
    // Call: half the 0.4% move from 25,050.5 is 25,100.60, so "above 25,100" (not 25,101).
    const bull = copyTicketView({ position: position({ side: "BULL" }), plan: plan({ side: "BULL", refSpot: 25_050.5 }), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(bull.entry.skipBeyondSpot).toBeCloseTo(25_100.6, 2);
    expect(copyEntryText(bull, null)).toContain("Skip if NIFTY is already above 25,100 (");
    expect(bull.steps.join(" ")).toContain("already above 25,100:");
    // Put: from 25,050.2 the level is 25,000.10, so "below 25,001" (not 25,000).
    const bear = copyTicketView({ position: position(), plan: plan({ refSpot: 25_050.2 }), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(bear.entry.skipBeyondSpot).toBeCloseTo(25_000.1, 2);
    expect(copyEntryText(bear, null)).toContain("Skip if NIFTY is already below 25,001 (");
    expect(bear.steps.join(" ")).toContain("already below 25,001:");
  });
});

describe("the engine's entry limit", () => {
  const view = (over: Partial<Parameters<typeof copyTicketView>[0]>) => copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10, ...over });

  it("comes from the entry order, else from the plan; null for a market order", () => {
    expect(view({}).entry.limitPrice).toBe(62.5);
    expect(view({ entryOrder: { type: "LIMIT", limitPrice: 62.55 } }).entry.limitPrice).toBe(62.55);
    expect(view({ entryOrder: { type: "MARKET" } }).entry.limitPrice).toBeNull();
    expect(view({ plan: plan({ entryType: "MARKET", limitPrice: undefined }) }).entry.limitPrice).toBeNull();
    expect(view({ plan: null }).entry.limitPrice).toBeNull();
  });

  it("is in the entry alert and the steps", () => {
    const t = view({});
    expect(copyEntryText(t, null).split("\n")[1]).toBe("1 lot = 65 qty · limit ₹62.50 · paper fill ₹62.40 (model price: check the real one) · cost ₹4,056");
    expect(t.steps[1]).toContain("the engine's limit was ₹62.50");
    expect(copyEntryText(view({ entryOrder: { type: "MARKET" } }), null)).not.toContain("limit ₹");
  });
});

describe("ticket levels are exactly where the engine's exits fire", () => {
  const configs = { main: DEFAULT_CONFIG, small5k: accountConfig(DEFAULT_CONFIG, "small5k") };
  const tickUp = (x: number) => Math.round((x + 0.05) * 100) / 100;
  const tickDown = (x: number) => Math.round((x - 0.05) * 100) / 100;
  const bidAt = (bid: number): Quote => ({ symbol: contract.tradingSymbol, bid, ask: tickUp(bid), bidQty: 0, askQty: 0, ltp: bid, t: T, source: "synthetic" });

  for (const [name, cfg] of Object.entries(configs)) {
    it(`for every fill from ₹20 to ₹400 in ₹0.05 steps (${name}: stop, target, trail start, trail)`, () => {
      const s = { ...stops, stopPct: cfg.exits.stopPct, targetPct: cfg.exits.targetPct, trailActivatePct: cfg.exits.trailActivatePct, trailGivebackPct: cfg.exits.trailGivebackPct };
      const ctx = { nowMs: T };
      const misses: string[] = [];
      for (let k = 400; k <= 8_000; k++) {
        const fill = Math.round(k * 5) / 100;
        const p = position({ avgEntry: fill, peakPremium: fill, markPremium: fill, stops: s });
        const { levels } = copyTicketView({ position: p, plan: null, account: TEN_K, timeStopMinPnlPct: 10 });
        const reason = (bid: number, pos: Position = p) => evaluateExits(pos, bidAt(bid), ctx, cfg)?.reason;
        if (reason(levels.stop) !== "STOP" || reason(tickUp(levels.stop)) === "STOP") misses.push(`stop ${fill}: ${levels.stop}`);
        if (reason(levels.target) !== "TARGET" || reason(tickDown(levels.target)) === "TARGET") misses.push(`target ${fill}: ${levels.target}`);
        // The trail turns on once the peak reaches its start (the engine's own trailPrice).
        if (trailPrice({ ...p, peakPremium: levels.trailActivateAt }) === null || trailPrice({ ...p, peakPremium: tickDown(levels.trailActivateAt) }) !== null) misses.push(`trail start ${fill}: ${levels.trailActivateAt}`);
        // With the trail on (peak ten ticks past its start), it sells at the shown level, not a tick above.
        const peak = Math.round((levels.trailActivateAt + 0.5) * 100) / 100;
        const on = { ...p, peakPremium: peak, markPremium: peak };
        const trail = copyTicketView({ position: on, plan: null, account: TEN_K, timeStopMinPnlPct: 10 }).levels.trail!;
        if (reason(trail, on) !== "TRAIL" || reason(tickUp(trail), on) === "TRAIL") misses.push(`trail ${fill} (peak ${peak}): ${trail}`);
      }
      expect(misses.slice(0, 6)).toEqual([]);
    });
  }
});

describe("copy ticket levels on the ₹0.05 tick", () => {
  // Entry ₹62.40: the raw stop is ₹40.56, the target ₹99.84 and the trail start ₹81.12.
  const t = copyTicketView({ position: position({ peakPremium: 90.05, markPremium: 88 }), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
  const onTick = (x: number) => Math.abs(Math.round(x / 0.05) * 0.05 - x) < 1e-9;

  it("puts every level on a tradable price", () => {
    for (const x of [t.levels.stop, t.levels.target, t.levels.trailActivateAt, t.levels.trail!]) expect(onTick(x)).toBe(true);
  });

  it("uses the first tick at which the engine's own check fires", () => {
    // The engine sells when the bid is at or below the stop or trail, and at or above the target;
    // the trail starts once the bid has reached its start. Bids move in ticks.
    expect(t.levels.stop).toBe(40.55);
    expect(t.levels.target).toBe(99.85);
    expect(t.levels.trailActivateAt).toBe(81.15);
    // Trail: the peak ₹90.05 gives back half the gain to ₹76.225, so it sells at ₹76.20.
    expect(t.levels.trail).toBe(76.2);
    const p = position({ peakPremium: 90.05 });
    const q = (bid: number): Quote => ({ symbol: contract.tradingSymbol, bid, ask: bid + 0.1, bidQty: 0, askQty: 0, ltp: bid, t: T, source: "synthetic" });
    const ctx = { nowMs: T };
    expect(evaluateExits(p, q(t.levels.stop), ctx, DEFAULT_CONFIG)?.reason).toBe("STOP");
    expect(evaluateExits(p, q(t.levels.stop + 0.05), ctx, DEFAULT_CONFIG)?.reason).not.toBe("STOP");
    expect(evaluateExits(p, q(t.levels.target), ctx, DEFAULT_CONFIG)?.reason).toBe("TARGET");
    expect(evaluateExits(p, q(t.levels.target - 0.05), ctx, DEFAULT_CONFIG)?.reason).not.toBe("TARGET");
    expect(evaluateExits(p, q(t.levels.trail!), ctx, DEFAULT_CONFIG)?.reason).toBe("TRAIL");
    expect(evaluateExits(p, q(t.levels.trail! + 0.05), ctx, DEFAULT_CONFIG)).toBeNull();
    const notYet = position({ peakPremium: t.levels.trailActivateAt - 0.05 });
    expect(trailPrice(notYet)).toBeNull();
    expect(trailPrice(position({ peakPremium: t.levels.trailActivateAt }))).not.toBeNull();
  });

  it("states the risk at the stop the engine would actually hit", () => {
    expect(t.riskAtStop.rupees).toBe(Math.round((62.4 - 40.55) * 65 + 27.5 + computeCharges("SELL", 40.55, 65, "NSE", "2026-10-09").total));
    expect(t.steps.find((s) => s.startsWith("Set a stop-loss"))).toContain("(₹40.55 for a ₹62.40 fill). The target is +60% (₹99.85).");
  });
});

describe("closed copy tickets", () => {
  it("show the entry's quantity, lots, cost and risk (not entry plus exit)", async () => {
    // Close the position the way the engine does, so the ticket sees the stored shape.
    const deps = createReplayDeps({ cfg: DEFAULT_CONFIG, startMs: T, candles: {}, daily: {} });
    const open = position();
    await deps.repo.positions.save(open);
    const exitAt = T + 42 * 60_000;
    deps.clock.set(exitAt);
    const fill: Fill = { id: "f-exit", orderId: "o-exit", t: exitAt, qty: 65, price: 40.5, charges: computeCharges("SELL", 40.5, 65, "NSE", "2026-10-09"), slippageTicks: 0 };
    const closed = await applyExitFills(deps, open, [fill], "STOP");
    expect(closed.status).toBe("CLOSED");
    const before = copyTicketView({ position: open, plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    const after = copyTicketView({ position: closed, plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    expect(after.qty).toBe(65);
    expect(after.lots).toBe(1);
    expect(after.contract.lots).toBe(1);
    expect(after.entry.costRupees).toBe(before.entry.costRupees);
    expect(after.contract.premiumAtRisk).toBe(before.contract.premiumAtRisk);
    expect(after.riskAtStop).toEqual(before.riskAtStop);
    expect(after.steps[1]).toMatch(/^Buy 1 lot \(65 qty\)/);
    expect(copyEntryText(after, null)).toContain("1 lot = 65 qty");
    expect(after.exit?.pnl).toBeCloseTo((40.5 - 62.4) * 65 - 27.5 - fill.charges.total, 2);
  });

  it("count a partly sold open position by its entry quantity", () => {
    const partly = copyTicketView({ position: position({ qty: 65, exitedQty: 65 }), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    // Two lots bought, one sold so far: still a two-lot entry.
    expect(partly.qty).toBe(130);
    expect(partly.lots).toBe(2);
  });
});

describe("copy alert texts", () => {
  const open = copyTicketView({ position: position(), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
  const link = copyLink("https://dash.example.dev/", open);

  it("links to the ticket on the copy page (account only when not main)", () => {
    expect(link).toBe("https://dash.example.dev/copy?account=small10k&id=pos1");
    const m = copyTicketView({ position: position(), plan: plan(), account: MAIN, timeStopMinPnlPct: 10 });
    expect(copyLink("https://dash.example.dev", m)).toBe("https://dash.example.dev/copy?id=pos1");
    expect(copyLink(undefined, m)).toBeNull();
    expect(copyLink("not a url", m)).toBeNull();
  });

  it("tags accounts by their capital", () => {
    expect(accountTag(TEN_K)).toBe("₹10k");
    expect(accountTag(MAIN)).toBe("Main ₹5L");
  });

  it("prefixes the ₹5k account's alerts with ₹5k and links to its book", () => {
    const spec = accountSpec("small5k");
    const fiveK = { id: spec.id, label: spec.label, shortLabel: spec.shortLabel, paperOnly: spec.paperOnly, capitalRupees: 5_000 };
    expect(accountTag(fiveK)).toBe("₹5k");
    const t = copyTicketView({ position: position(), plan: plan(), account: fiveK, timeStopMinPnlPct: 10 });
    const l = copyLink("https://dash.example.dev", t);
    expect(l).toBe("https://dash.example.dev/copy?account=small5k&id=pos1");
    expect(copyEntryText(t, l).split("\n")[0]).toBe("🟢 COPY ₹5k · BUY NIFTY 25000 PE (13 Oct)");
    expect(copyEntryText(t, l)).toContain("% of ₹5k)");
  });

  it("has everything needed to copy the entry", () => {
    const text = copyEntryText(open, link);
    expect(text.split("\n")[0]).toBe("🟢 COPY ₹10k · BUY NIFTY 25000 PE (13 Oct)");
    expect(text).toContain("1 lot = 65 qty · limit ₹62.50 · paper fill ₹62.40 (model price: check the real one) · cost ₹4,056");
    expect(text).toContain("Skip if NIFTY is already below 25,000 (it was 25,050)");
    expect(text).toContain("Stop −35% → ₹40.55 · Target +60% → ₹99.85");
    expect(text).toContain("time stop 11:50 unless +10% · out by 15:05");
    expect(text).toContain("Why: bearish −0.52 (needs 0.45) on a range-bound day");
    expect(text).toContain("• Opening-range breakout, bearish");
    expect(text).toContain("Edge: expects 0.40% vs 0.30% priced in over 90 min (×1.33)");
    expect(text).toContain("NIFTY 25,050 (−0.60% on the day) · VWAP 25,080 (−1.3σ) · opening range 25,070–25,160 broken downward · RSI 38 · ADX 24 (+DI 17 / −DI 28) · Supertrend down · VIX 13.9");
    expect(text.endsWith(link!)).toBe(true);
    expect(text.length).toBeLessThan(4000);
  });

  it("announces the trailing stop once the trail is on", () => {
    expect(copyTrailText(open, link)).toBeNull();
    const peaked = copyTicketView({ position: position({ peakPremium: 90, markPremium: 88 }), plan: plan(), account: TEN_K, timeStopMinPnlPct: 10 });
    const text = copyTrailText(peaked, null)!;
    expect(text.split("\n")[0]).toBe("🟡 COPY ₹10k · NIFTY 25000 PE (13 Oct): trailing stop on");
    expect(text).toContain(`falls to ₹${((90 + 62.4) / 2).toFixed(2)}`);
  });

  it("tells the copier to sell, with the paper result", () => {
    expect(copyExitText(open, link)).toBeNull();
    const closed = copyTicketView({
      position: position({ status: "CLOSED", qty: 0, exitedQty: 65, exitMs: T + 42 * 60_000, avgExit: 40.5, exitReason: "STOP", realized: (40.5 - 62.4) * 65, exitCharges: 40 }),
      plan: plan(),
      account: TEN_K,
      timeStopMinPnlPct: 10,
    });
    const text = copyExitText(closed, link)!;
    expect(text.split("\n")[0]).toBe("🔴 COPY ₹10k · SELL NIFTY 25000 PE (13 Oct) now");
    expect(text).toContain("Stop-loss hit · paper ₹62.40 → ₹40.50 (−35.1%) · −₹1,491 after charges ❌");
    expect(text).toContain("Held 42 min");
  });

  it("labels expiries with the weekday", () => {
    expect(expiryLabel("2026-10-15")).toBe("Thu 15 Oct");
  });
});
