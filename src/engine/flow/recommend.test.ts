import { describe, expect, it } from "vitest";
import type { FlowBuildup, FlowEventView, FlowSideView, IndexId, OptionFlowView, TradeSetupView } from "../api-types";
import { istAt, istIso } from "../clock";
import type { FlowStatsFile, RuleStats } from "./flowStatsTypes";
import {
  MAX_DELTA,
  chooseStrike,
  matchRules,
  pickSetup,
  readFlow,
  recommend,
  roundTripCharges,
  ruleMatches,
  sizeLots,
  type RecoCandidate,
  type RecommendInput,
} from "./recommend";

const DAY = "2026-10-14"; // a Wednesday: not a NIFTY (Tuesday) or SENSEX (Thursday) expiry
const NOW = istAt(DAY, "10:30");

const STATS: FlowStatsFile = {
  generatedAt: "2026-10-14T18:00:00+05:30",
  source: "test",
  method: "",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["No option-buying edge passed the bar on the test data."],
};

function rule(o: Partial<RuleStats>): RuleStats {
  return {
    id: "ORB_BULL_OI_CONFIRM",
    title: "Opening-range breakout confirmed by option flow",
    description: "test",
    index: "BOTH",
    side: "EITHER",
    sample: 120,
    inSample: 300,
    hitRate: 0.46,
    avgPnlPerLot: -120,
    medianPnlPerLot: -300,
    avgHoldMin: 70,
    ci95: [-420, 150],
    bestEntryWindow: "09:45–11:15 IST",
    targetPct: 40,
    stopPct: -25,
    timeExit: "13:30 IST",
    dataRange: "2026-08-14..2026-10-14 (test)",
    verdict: "not_proven",
    notes: [],
    params: {},
    ...o,
  };
}

function setup(o: Partial<TradeSetupView> = {}): TradeSetupView {
  return {
    id: `${DAY}:NIFTY:ORB:BULL`,
    index: "NIFTY",
    kind: "ORB",
    name: "Opening-range breakout",
    side: "BULL",
    status: "TRIGGERED",
    statusSince: istIso(NOW - 120_000),
    firstSeen: istIso(NOW - 600_000),
    score: 70,
    spot: 22545,
    trigger: 22540,
    condition: "a 5-min candle closes above 22,540",
    chaseLimit: 22556,
    distance: -5,
    level: { price: 22540, label: "ORH" },
    stop: 22506,
    t1: 22600,
    t2: 22650,
    t1Label: "PDH",
    t2Label: "R1",
    rr1: 1.76,
    rr2: 3.2,
    invalidation: "a close back below 22,540",
    evidence: [
      { text: "ADX 26 (trending)", supports: true },
      { text: "Daily trend down", supports: false },
    ],
    cautions: [],
    atr: 22,
    option: null,
    ...o,
  };
}

const NIFTY_CE: [number, number, number][] = [
  // strike, ask, delta
  [22400, 240, 0.72],
  [22450, 205, 0.66],
  [22500, 172, 0.58],
  [22550, 140, 0.5],
  [22600, 112, 0.42],
  [22650, 88, 0.34],
  [22700, 66, 0.27],
];

function cands(index: IndexId, type: "CE" | "PE", rows: [number, number, number][], source: RecoCandidate["priceSource"] = "feed"): RecoCandidate[] {
  return rows.map(([strike, ask, delta]) => ({
    contract: {
      index,
      expiry: "2026-10-20",
      strike,
      optionType: type,
      tradingSymbol: `${index}26O20${strike}${type}`,
      lotSize: index === "NIFTY" ? 65 : 20,
      tickSize: 0.05,
      exchange: index === "NIFTY" ? "NSE" : "BSE",
    },
    bid: source === "model" ? null : ask - 0.1,
    ask: source === "model" ? null : ask,
    ltp: ask - 0.05,
    premium: ask,
    delta,
    gamma: 0.0008,
    thetaPerMin: -0.02,
    iv: 12.5,
    priceSource: source,
  }));
}

function side(o: Partial<FlowSideView> = {}): FlowSideView {
  return { oi: 100_000, ltp: 100, bid: 99.9, ask: 100.1, iv: 12, delta: 0.5, oiChg: 0, oiChgPct: 0, vol: 1000, volMultiple: 1, ltpChgPct: 0, ivChg: 0, buildup: "NEUTRAL", ...o };
}

interface FlowOpts {
  lean?: OptionFlowView["summary"]["callWritersVsPutWriters"]["lean"];
  pcrChg?: number;
  buildups?: { strike: number; side: "CE" | "PE"; buildup: FlowBuildup; oiChgPct?: number }[];
  dryUp?: boolean;
  asOf?: number;
  events?: FlowEventView[];
  source?: OptionFlowView["source"];
  index?: IndexId;
}

function flow(o: FlowOpts = {}): OptionFlowView {
  const strikes = [22400, 22450, 22500, 22550, 22600, 22650, 22700];
  const rows = strikes.map((strike) => {
    const b = (s: "CE" | "PE") => o.buildups?.find((x) => x.strike === strike && x.side === s);
    const ce = b("CE");
    const pe = b("PE");
    return {
      strike,
      ce: side(ce ? { buildup: ce.buildup, oiChgPct: ce.oiChgPct ?? 5, ltpChgPct: 3 } : {}),
      pe: side(pe ? { buildup: pe.buildup, oiChgPct: pe.oiChgPct ?? 5, ltpChgPct: -3 } : {}),
    };
  });
  const lean = o.lean ?? "BALANCED";
  const w = (minutes: number) => ({ minutes, from: istIso(NOW - minutes * 60_000), rows });
  return {
    index: o.index ?? "NIFTY",
    source: o.source ?? "feed",
    asOf: istIso(o.asOf ?? NOW - 30_000),
    expiry: "2026-10-20",
    lotSize: 65,
    spot: 22545,
    atm: 22550,
    step: 50,
    minutes: 75,
    note: null,
    windows: { "1m": w(1), "5m": w(5), "15m": w(15) },
    events: o.events ?? [],
    summary: {
      callWritersVsPutWriters: { window: "15m", ceOiAdded: 10_000, peOiAdded: lean === "PUT_WRITERS" ? 60_000 : 10_000, lean, text: `lean ${lean}` },
      pcr: 1.05,
      pcrChg15m: o.pcrChg ?? 0,
      resistance: { strike: 22700, oi: 9_000_000 },
      support: { strike: 22400, oi: 8_000_000 },
      fastestOiAdd: { ce: null, pe: null },
      premiumDryUp: o.dryUp ?? false,
      dryUpDetail: o.dryUp ? "At ATM±2 over 15 min: volume 20% of normal." : "",
      decayPctPerHourAtm: 4.2,
      volumeBaseline: "session",
    },
    bestEntryWindow: { verdict: "unknown", text: "No measured entry-time statistics yet.", now: null, best: null },
    honestSummary: STATS.honestSummary,
    statsGeneratedAt: null,
  };
}

const AGREE = { lean: "PUT_WRITERS" as const, pcrChg: 0.08 };

function input(o: Partial<RecommendInput> = {}): RecommendInput {
  return {
    index: "NIFTY",
    now: NOW,
    spot: 22545,
    setups: [setup()],
    flow: flow(AGREE),
    stats: STATS,
    candidates: cands("NIFTY", "CE", NIFTY_CE),
    phaseOpen: true,
    isExpiryDay: false,
    plan: null,
    exits: { stopPct: -30, targetPct: 50, squareOffIst: "15:05" },
    ...o,
  };
}

const onTick = (x: number) => Math.abs(Math.round(x * 20) - x * 20) < 1e-6;

describe("recommendation for ₹10,000", () => {
  it("buys the highest-delta NIFTY strike whose lot fits, with every number on the card", () => {
    const r = recommend(input());
    expect(r.status).toBe("ENTER");
    expect(r.grade).toBe("B");
    expect(r.capital).toBe(10_000);
    expect(r.contract).toMatchObject({ strike: 22550, optionType: "CE", lotSize: 65, expiry: "2026-10-20", priceSource: "feed" });
    expect(r.contract!.label).toBe("NIFTY 20-OCT-2026 22550 CE");
    // Entry: a limit on the tick, no more than the ask + 2%.
    expect(r.entry!.limit).toBeGreaterThanOrEqual(140);
    expect(r.entry!.limit).toBeLessThanOrEqual(140 * 1.02);
    expect(onTick(r.entry!.limit)).toBe(true);
    expect(Date.parse(r.entry!.validUntil) - NOW).toBe(5 * 60_000);
    // One lot, cost with charges inside the capital.
    expect(r.qty).toMatchObject({ lots: 1, units: 65 });
    expect(r.qty!.totalRupees).toBeLessThanOrEqual(10_000);
    expect(r.qty!.chargesRupees).toBeCloseTo(roundTripCharges(r.entry!.limit, 65, "NSE", DAY), 2);
    // Exits never looser than the engine's: stop ≥ −30%, targets ≤ +50%.
    expect(r.stop!.premium).toBeGreaterThanOrEqual(r.entry!.limit * 0.7 - 1e-9);
    expect(r.stop!.premium).toBeLessThan(r.entry!.limit);
    expect(r.target!.t1).toBeGreaterThan(r.entry!.limit);
    expect(r.target!.t2).toBeLessThanOrEqual(r.entry!.limit * 1.5 + 1e-9);
    expect([r.stop!.premium, r.target!.t1, r.target!.t2].every(onTick)).toBe(true);
    expect(r.stop!.index).toBe(22506);
    expect(r.timeExit).toBe("12:00");
    expect(r.risk!.riskRupees).toBeGreaterThan(0);
    expect(r.risk!.pctOfCapital).toBeCloseTo((r.risk!.riskRupees / 10_000) * 100, 1);
    expect(r.headline).toMatch(/^BUY 1 lot NIFTY 22550 CE \(20 Oct\) at ≤ ₹\d+\.\d\d · stop ₹\d+\.\d\d · target ₹/);
    // Honest: no measured edge.
    expect(r.honest).toContain("Edge not proven");
    expect(r.honest).toContain("No measured statistics are loaded yet");
    expect(r.historical.verdict).toBe("none");
    expect(r.reasons.some((x) => x.includes("Opening-range breakout (triggered)"))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("Against: Daily trend down"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("Option flow agrees"))).toBe(true);
  });

  it("sizes a SENSEX put on its 20-unit lot", () => {
    const rows: [number, number, number][] = [
      [72700, 600, -0.66],
      [72600, 560, -0.6],
      [72500, 470, -0.5],
      [72400, 380, -0.41],
    ];
    const r = recommend(
      input({
        index: "SENSEX",
        spot: 72480,
        setups: [setup({ id: `${DAY}:SENSEX:PDH_PDL:BEAR`, index: "SENSEX", kind: "PDH_PDL", name: "Previous-day low breakdown", side: "BEAR", spot: 72480, trigger: 72500, chaseLimit: 72460, stop: 72600, t1: 72300, t2: 72150, condition: "a 5-min candle closes below 72,500" })],
        flow: flow({ index: "SENSEX", lean: "CALL_WRITERS", pcrChg: -0.08 }),
        candidates: cands("SENSEX", "PE", rows),
      }),
    );
    expect(r.status).toBe("ENTER");
    expect(r.contract).toMatchObject({ strike: 72500, optionType: "PE", lotSize: 20 });
    expect(r.qty!.units).toBe(20);
    expect(r.qty!.totalRupees).toBeLessThanOrEqual(10_000);
    expect(r.qty!.chargesRupees).toBeCloseTo(roundTripCharges(r.entry!.limit, 20, "BSE", DAY), 2);
  });

  it("says NO_TRADE when no lot with delta ≥ 0.30 fits, and sizes the same trade for ₹5k and ₹5L", () => {
    const r = recommend(input({ capital: 5_000 }));
    expect(r.status).toBe("NO_TRADE");
    expect(r.contract).toBeNull();
    expect(r.reasons[0]).toContain("No NIFTY CE lot with delta 0.30–0.70 fits ₹5,000");
    expect(r.reasons[0]).toContain("22650 CE");
    const ten = recommend(input());
    expect(ten.sizing.map((s) => s.capital)).toEqual([5_000, 10_000, 500_000]);
    expect(ten.sizing[0]).toMatchObject({ fits: false, lots: 0 });
    expect(ten.sizing[1]).toMatchObject({ fits: true, lots: 1, strike: 22550 });
    const big = ten.sizing[2];
    expect(big).toMatchObject({ fits: true, strike: 22450 });
    expect(big.lots).toBeGreaterThan(1);
    expect(big.text).toContain("at most 2%");
  });

  it("never picks a strike beyond delta 0.70 or below 0.30", () => {
    const { fit } = chooseStrike(cands("NIFTY", "CE", NIFTY_CE), 1_000_000, DAY);
    expect(Math.abs(fit!.pick.delta)).toBeLessThanOrEqual(MAX_DELTA);
    expect(fit!.pick.contract.strike).toBe(22450);
    expect(chooseStrike(cands("NIFTY", "CE", [[22700, 66, 0.27]]), 100_000, DAY).fit).toBeNull();
    expect(sizeLots(10_000, 9_400, 2_800)).toBe(1);
    expect(sizeLots(500_000, 13_400, 4_000)).toBe(2);
    expect(sizeLots(5_000, 9_400, 2_800)).toBe(0);
  });
});

describe("grades", () => {
  it("never grades A without a positive measured rule", () => {
    const notProven = recommend(input({ stats: { ...STATS, rules: [rule({})] } }));
    expect(notProven.grade).toBe("B");
    expect(notProven.historical).toMatchObject({ verdict: "not_proven", ruleIds: ["ORB_BULL_OI_CONFIRM"], sample: 120, ci95: [-420, 150] });
    expect(notProven.honest).toContain("ORB_BULL_OI_CONFIRM is not proven");

    // "positive" with an interval that crosses zero is not positive.
    const crossing = recommend(input({ stats: { ...STATS, rules: [rule({ verdict: "positive", ci95: [-10, 400], avgPnlPerLot: 180 })] } }));
    expect(crossing.grade).toBe("B");
    expect(crossing.historical.verdict).toBe("not_proven");

    // A positive rule for the other index, or outside its window, does not apply.
    expect(recommend(input({ stats: { ...STATS, rules: [rule({ verdict: "positive", ci95: [50, 400], index: "SENSEX" })] } })).grade).toBe("B");
    expect(recommend(input({ stats: { ...STATS, rules: [rule({ verdict: "positive", ci95: [50, 400], bestEntryWindow: "13:00–14:00" })] } })).grade).toBe("B");
  });

  it("grades A on a positive rule and uses its measured exits (the stop only when tighter)", () => {
    const r = recommend(input({ stats: { ...STATS, rules: [rule({ verdict: "positive", ci95: [50, 400], avgPnlPerLot: 210, hitRate: 0.55 })] } }));
    expect(r.grade).toBe("A");
    expect(r.honest).toBeNull();
    expect(r.historical).toMatchObject({ verdict: "positive", sample: 120, avgPnlPerLot: 210 });
    expect(r.historical.text).toContain("55% of 120 out-of-sample trades");
    expect(r.stop!.pct).toBeCloseTo(-25, 0);
    expect(r.target!.t1Pct).toBeCloseTo(40, 0);
    expect(r.timeExit).toBe("13:30");
    const loose = recommend(input({ stats: { ...STATS, rules: [rule({ verdict: "positive", ci95: [50, 400], stopPct: -45 })] } }));
    expect(loose.stop!.pct).toBeGreaterThanOrEqual(-30.5);
  });

  it("waits, graded C, when the option flow does not confirm", () => {
    const against = recommend(input({ flow: flow({ lean: "CALL_WRITERS", pcrChg: -0.1 }) }));
    expect(against.status).toBe("WAIT");
    expect(against.grade).toBe("C");
    expect(against.honest).toContain("Watch only");
    expect(against.headline).toContain("the option flow does not confirm");
    const none = recommend(input({ flow: null }));
    expect(none).toMatchObject({ status: "WAIT", grade: "C" });
    const stale = recommend(input({ flow: flow({ ...AGREE, asOf: NOW - 10 * 60_000 }) }));
    expect(stale.grade).toBe("C");
    const rest = recommend(input({ flow: flow({ ...AGREE, source: "rest" }) }));
    expect(rest.grade).toBe("C");
  });
});

describe("status", () => {
  it("waits for a watched setup with the entry priced at the trigger", () => {
    const r = recommend(input({ setups: [setup({ status: "WATCHING", spot: 22528 })], spot: 22528 }));
    expect(r.status).toBe("WAIT");
    // The flow agrees: graded B, but nothing to do until the trigger.
    expect(r.grade).toBe("B");
    expect(r.reasons.some((x) => x === "Waiting because the setup has not triggered yet.")).toBe(true);
    expect(r.contract!.strike).toBe(22550);
    expect(r.entry!.limit).toBeGreaterThan(140);
    expect(r.entry!.trigger).toBe("NIFTY: a 5-min candle closes above 22,540.");
    expect(r.headline).toMatch(/^WAIT: buy NIFTY 22550 CE \(20 Oct\) at ≤ ₹\d+\.\d\d only if a 5-min candle closes above 22,540\.$/);
    expect(r.entry!.validUntil).toBe(istIso(istAt(DAY, "14:30")));
  });

  it("waits on premium dry-up, a model price or a chase past the limit", () => {
    expect(recommend(input({ flow: flow({ ...AGREE, dryUp: true }) })).status).toBe("WAIT");
    const model = recommend(input({ candidates: cands("NIFTY", "CE", NIFTY_CE, "model") }));
    expect(model.status).toBe("WAIT");
    expect(model.cautions.some((c) => c.includes("model estimate"))).toBe(true);
    expect(recommend(input({ spot: 22570 })).status).toBe("WAIT");
    const event = recommend(input({ eventBlackout: "RBI MPC policy decision is in 20 min: no new entry from 30 min before it (plan rule N1)" }));
    expect(event.status).toBe("WAIT");
    expect(event.headline).toContain("RBI MPC policy decision is in 20 min");
  });

  it("keeps the session rules", () => {
    expect(recommend(input({ now: istAt(DAY, "09:20") })).status).toBe("WAIT");
    expect(recommend(input({ now: istAt(DAY, "09:20") })).headline).toContain("nothing new before 09:25");
    expect(recommend(input({ now: istAt(DAY, "14:31") })).status).toBe("NO_TRADE");
    expect(recommend(input({ now: istAt(DAY, "13:05"), isExpiryDay: true })).status).toBe("NO_TRADE");
    const t1255 = istAt(DAY, "12:55");
    expect(recommend(input({ now: t1255, isExpiryDay: true, flow: flow({ ...AGREE, asOf: t1255 - 30_000 }) })).status).toBe("ENTER");
    expect(recommend(input({ phaseOpen: false })).status).toBe("NO_TRADE");
    const blocked = recommend(
      input({ plan: { verdict: "no_trade", headline: "NIFTY: no new entries this session (scheduled events).", checks: [{ rule: "N1", label: "N1 · Scheduled events", status: "block", detail: "RBI policy tomorrow." }] } }),
    );
    expect(blocked).toMatchObject({ status: "NO_TRADE", contract: null });
    expect(blocked.reasons[0]).toContain("RBI policy tomorrow");
  });

  it("waits without a setup, and without a quote", () => {
    expect(recommend(input({ setups: [] }))).toMatchObject({ status: "WAIT", contract: null });
    expect(recommend(input({ setups: [setup({ status: "MISSED" })] })).status).toBe("WAIT");
    const noQuote = recommend(input({ candidates: [] }));
    expect(noQuote).toMatchObject({ status: "WAIT", contract: null });
    expect(noQuote.setup?.status).toBe("TRIGGERED");
  });

  it("acts on a triggered setup before a watched one", () => {
    const watched = setup({ id: "w", status: "WATCHING", score: 90 });
    const trig = setup({ id: "t", status: "TRIGGERED", score: 60 });
    expect(pickSetup([watched, trig])?.id).toBe("t");
    expect(pickSetup([setup({ status: "INVALID" })])).toBeNull();
  });
});

describe("flow reading and live rule detectors", () => {
  it("scores the flow in the trade's direction with the numbers", () => {
    const f = flow({ lean: "PUT_WRITERS", pcrChg: 0.08, buildups: [{ strike: 22500, side: "PE", buildup: "SHORT_BUILDUP" }] });
    const bull = readFlow(f, "BULL", NOW);
    expect(bull.score).toBeCloseTo(1, 2);
    expect(bull.lines.some((l) => l.includes("22500 PE short build-up"))).toBe(true);
    expect(bull.lines.some((l) => l.startsWith("PCR 1.05 (+0.08 in 15 min)"))).toBe(true);
    expect(readFlow(f, "BEAR", NOW).score).toBeCloseTo(-1, 2);
  });

  it("matches OI, volume-spike, PCR and dry-up rules on the live flow", () => {
    const f = flow({
      pcrChg: 0.07,
      dryUp: true,
      buildups: [{ strike: 22550, side: "CE", buildup: "SHORT_COVERING", oiChgPct: -4 }],
      events: [
        { at: istIso(NOW - 2 * 60_000), kind: "VOLUME_SPIKE", strike: 22550, side: "CE", buildup: null, oiChg: null, ltpChgPct: 9, volMultiple: 7.2, text: "" },
      ],
    });
    const ctx = { index: "NIFTY" as const, optionType: "CE" as const, setup: setup(), flow: f, flowScore: 0.3, minutes: 630, now: NOW };
    const base = { bestEntryWindow: "09:30–15:00" };
    expect(ruleMatches(rule({ ...base, id: "OI_SHORT_COVERING_CE", params: { minOiChgPct: 3 } }), ctx)).toBe(true);
    expect(ruleMatches(rule({ ...base, id: "OI_SHORT_COVERING_CE", params: { minOiChgPct: 5 } }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "OI_LONG_BUILDUP_CE" }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_ATM", params: { k: 5 } }), ctx)).toBe(true);
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_ATM", params: { k: 8 } }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_ATM" }), { ...ctx, optionType: "PE" })).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_UP_ENGINE_NIFTY", params: { k: 5 } }), ctx)).toBe(true);
    // No live detector for these conditions: a same-side up-spike must not count as them.
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_DOWN_FADE_NIFTY", params: { k: 5 } }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "VOL_SPIKE_UP_DTE_NIFTY", params: { k: 5 } }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "PCR_RISE" }), ctx)).toBe(true);
    expect(ruleMatches(rule({ ...base, id: "PCR_FALL" }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "ATM_DRY_UP" }), ctx)).toBe(true);
    expect(ruleMatches(rule({ ...base, id: "ORB_BULL" }), ctx)).toBe(true);
    expect(ruleMatches(rule({ ...base, id: "ORB_BEAR" }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "ORB_BULL_OI_CONFIRM" }), { ...ctx, flowScore: 0.1 })).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "SOMETHING_ELSE" }), ctx)).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "PCR_RISE", side: "PE" }), ctx)).toBe(false);
    // Open to either side, a flow rule only buys the option its direction implies.
    expect(ruleMatches(rule({ ...base, id: "PCR_RISE" }), { ...ctx, optionType: "PE" })).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "OI_SHORT_COVERING_CE" }), { ...ctx, optionType: "PE" })).toBe(false);
    expect(ruleMatches(rule({ ...base, id: "PUT_WRITERS_ADDING" }), { ...ctx, flow: { ...f, summary: { ...f.summary, callWritersVsPutWriters: { ...f.summary.callWritersVsPutWriters, lean: "PUT_WRITERS" } } } })).toBe(true);
    // Flow rules never match on the REST fallback.
    expect(ruleMatches(rule({ ...base, id: "PCR_RISE" }), { ...ctx, flow: { ...f, source: "rest" } })).toBe(false);
    const ranked = matchRules([rule({ ...base, id: "PCR_RISE", sample: 400 }), rule({ ...base, id: "ORB_BULL", verdict: "positive", ci95: [10, 90], sample: 50 })], ctx);
    expect(ranked.map((r) => r.id)).toEqual(["ORB_BULL", "PCR_RISE"]);
  });
});
