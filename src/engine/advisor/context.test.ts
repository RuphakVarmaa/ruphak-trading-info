import { describe, expect, it } from "vitest";
import { MockEngineApi } from "@/lib/engine/mock";
import { buildMockChain, weeklyExpiries } from "@/lib/engine/mockChain";
import type { OptionFlowView, OptionSideView, FlowSideView, EventClusterView } from "../api-types";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { buildOptionChainView, parseUpstoxChain } from "../market/upstoxChain";
import { NIFTY_CHAIN_SAMPLE } from "../market/upstoxChain.fixture";
import {
  buildAdvisorContext,
  candidateExpiries,
  chainCandidates,
  flowShortCoveringRead,
  premiumRead,
  shortCoveringRead,
  topNews,
  zeroHeroCandidates,
} from "./context";
import { gatherAdvisorInputs } from "./gather";
import type { AdvisorInputs } from "./types";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const cal = defaultCalendar;

describe("short covering (computed in code)", () => {
  it("call OI falling with the index rising: call writers covering, bullish", () => {
    const r = shortCoveringRead({ indexChangePct: 0.8, ceOiChange: -500_000, peOiChange: 50_000, ceOi: 4_500_000, peOi: 5_000_000 });
    expect(r.lean).toBe("BULLISH");
    expect(r.signals).toEqual(["CALL_COVERING"]);
    expect(r.text).toMatch(/call writers are covering/);
  });

  it("put OI falling with the index falling: put writers covering, bearish", () => {
    const r = shortCoveringRead({ indexChangePct: -1.1, ceOiChange: 10_000, peOiChange: -900_000, ceOi: 5_000_000, peOi: 4_100_000 });
    expect(r.lean).toBe("BEARISH");
    expect(r.signals).toEqual(["PUT_COVERING"]);
  });

  it("reads writing too: calls added on a fall and puts added on a rise", () => {
    expect(shortCoveringRead({ indexChangePct: -0.5, ceOiChange: 800_000, peOiChange: 0, ceOi: 5_800_000, peOi: 5_000_000 }).signals).toEqual(["CALL_WRITING"]);
    const up = shortCoveringRead({ indexChangePct: 0.5, ceOiChange: -600_000, peOiChange: 700_000, ceOi: 4_400_000, peOi: 5_700_000 });
    expect(up.signals).toEqual(["CALL_COVERING", "PUT_WRITING"]);
    expect(up.lean).toBe("BULLISH");
  });

  it("ignores small moves and small OI changes, and says no data when inputs are missing", () => {
    expect(shortCoveringRead({ indexChangePct: 0.05, ceOiChange: -900_000, peOiChange: 0, ceOi: 4_000_000, peOi: 4_000_000 }).lean).toBe("NEUTRAL");
    expect(shortCoveringRead({ indexChangePct: 0.9, ceOiChange: -10_000, peOiChange: 0, ceOi: 4_000_000, peOi: 4_000_000 }).lean).toBe("NEUTRAL");
    expect(shortCoveringRead({ indexChangePct: null, ceOiChange: -900_000, peOiChange: 0, ceOi: 4_000_000, peOi: 4_000_000 }).lean).toBe("NO_DATA");
    expect(shortCoveringRead({ indexChangePct: 1, ceOiChange: null, peOiChange: null, ceOi: null, peOi: null }).lean).toBe("NO_DATA");
  });

  it("reads the live flow's 15-minute build-ups", () => {
    const side = (buildup: FlowSideView["buildup"]): FlowSideView => ({ oi: 1, ltp: 1, bid: 1, ask: 1, iv: 1, delta: 0.5, oiChg: 1, oiChgPct: 1, vol: 1, volMultiple: 1, ltpChgPct: 1, ivChg: 0, buildup });
    const rows = [
      { strike: 100, ce: side("SHORT_COVERING"), pe: side("SHORT_BUILDUP") },
      { strike: 110, ce: side("SHORT_COVERING"), pe: side("NEUTRAL") },
      { strike: 120, ce: side("NEUTRAL"), pe: side("SHORT_BUILDUP") },
    ];
    const flow = { windows: { "1m": { minutes: 1, from: null, rows: [] }, "5m": { minutes: 5, from: null, rows: [] }, "15m": { minutes: 15, from: null, rows } } } as unknown as OptionFlowView;
    const r = flowShortCoveringRead(flow);
    expect(r.lean).toBe("BULLISH");
    expect(r.signals).toEqual(["CALL_COVERING", "PUT_WRITING"]);
    expect(r.counts).toEqual({ ceCovering: 2, peCovering: 0, ceBuildup: 0, peBuildup: 2 });
    expect(flowShortCoveringRead(null).lean).toBe("NO_DATA");
  });
});

describe("premium read", () => {
  const row = (expiry: string, days: number, atmIv: number | null, events: { impact: "HIGH" | "MED"; title: string }[] = []) =>
    ({ expiry, days, atmIv, events: events.map((e, i) => ({ id: String(i), title: e.title, kind: "MACRO", at: `${expiry}T10:00:00+05:30`, impact: e.impact, approx: false })) }) as never;

  it("compares the nearest ATM IV with VIX and the next expiry, and flags events before expiry", () => {
    const r = premiumRead(13, [row("2026-10-20", 4, 16.5, [{ impact: "HIGH", title: "RBI policy" }]), row("2026-10-27", 11, 14)]);
    expect(r.ivMinusVix).toBe(3.5);
    expect(r.termStructure).toBe("INVERTED");
    expect(r.ruleOfThumb).toBe("EXPENSIVE");
    expect(r.eventsBeforeExpiry).toHaveLength(1);
    expect(r.eventsBeforeExpiry[0].events[0]).toMatch(/RBI policy/);
    expect(premiumRead(14, [row("2026-10-20", 4, 11), row("2026-10-27", 11, 11.5)]).ruleOfThumb).toBe("CHEAP");
    expect(premiumRead(null, []).ruleOfThumb).toBe("NO_DATA");
  });
});

describe("candidates from real listed contracts", () => {
  const NIFTY_LISTED = ["2026-10-19", "2026-10-27", "2026-11-03", "2026-11-09", "2026-11-17", "2026-11-23", "2026-12-29"];

  it("picks the nearest expiry not expiring today, the next weekly and the monthly within 35 days", () => {
    expect(candidateExpiries(NIFTY_LISTED, ist("2026-10-16T12:00:00"), "NIFTY", cal)).toEqual([
      { expiry: "2026-10-19", kind: "nearest", monthly: false },
      { expiry: "2026-10-27", kind: "nextWeekly", monthly: true },
    ]);
    // On the 19 Oct expiry day itself, today's contract is skipped.
    expect(candidateExpiries(NIFTY_LISTED, ist("2026-10-19T10:00:00"), "NIFTY", cal)).toEqual([
      { expiry: "2026-10-27", kind: "nearest", monthly: true },
      { expiry: "2026-11-03", kind: "nextWeekly", monthly: false },
      { expiry: "2026-11-23", kind: "monthly", monthly: true },
    ]);
  });

  it("builds ATM±3 CE and PE from a real Upstox chain with prices, greeks, breakeven and cost", () => {
    const parsed = parseUpstoxChain(NIFTY_CHAIN_SAMPLE);
    const chain = buildOptionChainView({ index: "NIFTY", expiry: "2026-10-19", meta: { expiries: ["2026-10-19", "2026-10-27"], lotSize: 65 } as never, chain: parsed, fetchedMs: ist("2026-10-14T12:00:00") });
    const c = chainCandidates(chain, "nearest", false, ist("2026-10-14T12:00:00"));
    // The fixture holds 4 strikes (22550–22700) around ATM 22600: offsets −1 … +2, both sides.
    expect(c).toHaveLength(8);
    const ce = c.find((x) => x.id === "NIFTY-2026-10-19-22600-CE")!;
    expect(ce).toMatchObject({ atmOffset: 0, ask: 145.85, bid: 145.25, ltp: 145.85, price: 145.85, priceBasis: "ask", delta: 0.5443, iv: 12.21, lotSize: 65, daysToExpiry: 5, tradingSymbol: "NIFTY26O1922600CE" });
    expect(ce.breakevenAtExpiry).toBe(22745.85);
    expect(ce.costPerLot).toBe(9480.25);
    const pe = c.find((x) => x.id === "NIFTY-2026-10-19-22700-PE")!;
    expect(pe.breakevenAtExpiry).toBe(22700 - 186.25);
    expect(pe.oiChange).toBe(4301115 - 4154865);
    expect(new Set(c.map((x) => x.id)).size).toBe(c.length);
  });

  it("lists expiry-day lottery tickets at ₹10 or less with the market's own odds", () => {
    const now = istAt("2026-10-20", "14:00");
    const chain = buildMockChain({ index: "NIFTY", spot: 23_000, prevSpot: 22_950, nowMs: now, expiries: ["2026-10-20", "2026-10-27"], expiry: "2026-10-20" });
    const z = zeroHeroCandidates(chain);
    expect(z.length).toBeGreaterThan(0);
    for (const t of z) {
      expect(t.price).toBeLessThanOrEqual(10);
      expect(t.optionType === "CE" ? t.strike > 23_000 : t.strike < 23_000).toBe(true);
      expect(t.costPerLot).toBeCloseTo(t.price * 65, 2);
      if (t.delta != null) expect(t.impliedWorthlessPct).toBeCloseTo((1 - Math.abs(t.delta)) * 100, 0);
    }
  });
});

describe("news", () => {
  const ev = (id: string, score: number, taxonomy: EventClusterView["taxonomy"], hoursAgo: number, now: number): EventClusterView =>
    ({
      clusterId: id,
      title: `story ${id}`,
      summary: "s",
      taxonomy,
      tab: "ALL",
      severity: "UPDATE",
      scorer: "llm",
      firstSeenAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      lastSeenAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      articleCount: 1,
      sources: ["Reuters"],
      impacts: [{ index: "NIFTY", direction: score > 0 ? 1 : -1, score, magnitudePct: 0.5, confidence: 0.5, halfLifeHours: 24 }],
      sectors: [],
      pricedIn: false,
      decayRemaining: 1,
      topUrl: `https://www.reuters.com/${id}`,
      isScheduledData: false,
    }) as EventClusterView;

  it("ranks the last 48 hours by impact and lists FII-flow stories separately", () => {
    const now = ist("2026-10-16T12:00:00");
    const r = topNews([ev("a", 0.1, "MACRO_POLICY", 1, now), ev("b", -0.6, "GEOPOLITICAL", 2, now), ev("c", 0.3, "FII_FLOWS", 3, now), ev("old", 0.9, "MACRO_POLICY", 60, now)], now);
    expect(r.top.map((t) => t.title)).toEqual(["story b", "story c", "story a"]);
    expect(r.fiiFlows.map((t) => t.title)).toEqual(["story c"]);
    expect(r.urls).toContain("https://www.reuters.com/b");
  });
});

describe("the whole context on the mock engine", () => {
  it("gathers every input, offers real candidates only, and stays compact", async () => {
    const api = new MockEngineApi("sim");
    const nowMs = Date.parse((await api.getState()).market.nowIst);
    const inputs = await gatherAdvisorInputs(api, cal, nowMs);
    expect(inputs.perIndex.NIFTY?.chains.length).toBeGreaterThan(1);
    const ctx = buildAdvisorContext(inputs, cal);
    const doc = JSON.parse(ctx.promptJson);
    expect(ctx.promptJson.length).toBeLessThan(160_000); // ≈ 40k tokens
    expect(ctx.candidates.length).toBeGreaterThan(20);
    expect(new Set(ctx.candidates.map((c) => c.id)).size).toBe(ctx.candidates.length);
    // Every candidate is a strike that exists in the chain read for its expiry.
    for (const c of ctx.candidates) {
      const chain = inputs.perIndex[c.index]!.chains.find((x) => x.expiry === c.expiry)!;
      const row = chain.rows.find((r) => r.strike === c.strike)!;
      const side = (c.optionType === "CE" ? row.ce : row.pe) as OptionSideView;
      expect(c.price).toBe(side.ask);
      expect(Math.abs(c.atmOffset)).toBeLessThanOrEqual(3);
      expect(c.expiry > new Date(nowMs + 5.5 * 3_600_000).toISOString().slice(0, 10)).toBe(true);
    }
    expect(ctx.market.nifty).toBe(inputs.indices!.levels.find((l) => l.key === "NIFTY")!.price);
    expect(ctx.market.vix).toBe(inputs.indices!.levels.find((l) => l.key === "INDIAVIX")!.price);
    expect(doc.indices.NIFTY.outlook.expiries.length).toBeGreaterThan(0);
    expect(doc.indices.NIFTY.outlook.expiries[0].shortCovering.lean).toMatch(/BULLISH|BEARISH|NEUTRAL|NO_DATA/);
    expect(doc.indices.SENSEX.premium).toBeTruthy();
    expect(doc.measuredResearch.flowStudy.length).toBeGreaterThan(0);
    expect(doc.measuredResearch.mainFindings.length).toBeGreaterThan(5);
    expect(doc.todayPlan).toBeTruthy();
    expect(doc.candidates[0]).toHaveProperty("fitsCapital");
  });

  it("marks missing inputs as gaps instead of inventing them", () => {
    const empty: AdvisorInputs = { nowMs: ist("2026-10-16T12:00:00"), indices: null, perIndex: {}, events: null, scheduled: null, plan: null, pnl: null, positions: null, errors: ["index levels: timed out"] };
    const ctx = buildAdvisorContext(empty, cal);
    const doc = JSON.parse(ctx.promptJson);
    expect(ctx.candidates).toEqual([]);
    expect(ctx.market).toEqual({ nifty: null, sensex: null, vix: null, phase: "OPEN" });
    expect(doc.dataGaps).toEqual(expect.arrayContaining(["index levels: timed out", "NIFTY: no inputs", "news: could not be read"]));
    expect(doc.zeroHero.note).toBe("No index expires today.");
  });

  it("only adds zero-hero tickets on an expiry day", () => {
    const now = istAt("2026-10-20", "13:00");
    const expiries = weeklyExpiries("NIFTY", now, () => false);
    expect(expiries[0]).toBe("2026-10-20");
    const chains = expiries.slice(0, 3).map((e) => buildMockChain({ index: "NIFTY", spot: 23_000, prevSpot: 23_100, nowMs: now, expiries, expiry: e }));
    const inputs: AdvisorInputs = { nowMs: now, indices: null, perIndex: { NIFTY: { signal: null, flow: null, chains, listed: expiries } }, events: [], scheduled: [], plan: null, pnl: null, positions: null, errors: [] };
    const ctx = buildAdvisorContext(inputs, cal);
    expect(ctx.expiryToday).toEqual({ NIFTY: "2026-10-20" });
    expect(ctx.zeroHeroCandidates.length).toBeGreaterThan(0);
    expect(ctx.candidates.every((c) => c.expiry !== "2026-10-20")).toBe(true);
  });
});
