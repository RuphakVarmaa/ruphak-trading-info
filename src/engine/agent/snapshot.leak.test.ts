/**
 * The leak test (SPEC §3.4 as amended): what the reflex model is sent for the bar closing at T is the same with or
 * without data timestamped after T. Covered here: buildIndexSnapshot, flowViewAsOf, compileFinalists and
 * briefContext. buildReflexInput (item 2) and the book fallback are agentCycle's, tested with it.
 */
import { describe, expect, it } from "vitest";
import type { AdvisorIdea, AdvisorReport } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, istAt, istDate, istIso } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { toNumeric } from "../events/taxonomy";
import type { ChainRow, ChainSnapshot } from "../flow/flowMonitor";
import { ReplayMarketDataSource } from "../market/replayMarketData";
import { loadMarketFixtures } from "../testing/fixtures";
import { MARKET_SYMBOLS, type Candle, type IndexId, type MarketSnapshot, type ScoredEvent } from "../types";
import { briefContext, compileFinalists, finalistPrompt } from "./finalists";
import { flowViewAsOf } from "./flowAsOf";
import { buildIndexSnapshot, encodeSnapshot, type SnapshotInput } from "./snapshot";
import type { AgentBookState } from "./types";

const DAY = "2026-10-07";
const T = istAt(DAY, "11:00");
const cal = new TradingCalendar();
const cfg = DEFAULT_CONFIG;
const fixtures = loadMarketFixtures();
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];

/** A: only what existed at T, as the point-in-time replay source shows it (bars closed by T, daily bars before today). */
const marketA: MarketSnapshot = new ReplayMarketDataSource({ candles: fixtures.candles, daily: fixtures.daily }).snapshotSync(T);

/** Prices after T bent out of shape, so any leak would show. */
const wild = (c: Candle): Candle => ({ ...c, o: c.o * 1.07, h: c.h * 1.09, l: c.l * 0.93, c: c.c * 1.08 });

/** B: A plus the future: every later bar (the forming 11:00 bar too), today's daily bar, a live spot, trade times and ages. */
const marketB: MarketSnapshot = {
  t: T + 3 * MINUTE_MS,
  candles: Object.fromEntries(Object.entries(fixtures.candles).map(([sym, arr]) => [sym, arr.map((c) => (c.t + 5 * MINUTE_MS > T ? wild(c) : c))])),
  daily: Object.fromEntries(Object.entries(fixtures.daily).map(([sym, arr]) => [sym, arr.map((c) => (istDate(c.t) === DAY ? { ...c, h: c.h * 1.2, c: c.c * 1.15 } : c))])),
  ltp: { NIFTY: 25_000 * 1.05, SENSEX: 82_000 * 1.05, BANKNIFTY: 1 },
  dataAgeSec: 999,
  dataAgeSecByIndex: { NIFTY: 999, SENSEX: 999 },
  asOfMs: { "^NSEI": T + 170_000, "^BSESN": T + 170_000, "^INDIAVIX": T + 120_000 },
};

/** The index's last 5-minute close at or before t (the samples' spot). */
function spotAt(index: IndexId, t: number): number {
  const bars = fixtures.candles[MARKET_SYMBOLS[index]].filter((c) => c.t + 5 * MINUTE_MS <= t);
  return bars[bars.length - 1].c;
}

/** One chain sample a minute (1.5 s after it) from 09:16 to 11:30; after T the OI and prices change wildly. */
function samples(index: IndexId): ChainSnapshot[] {
  const step = cfg.indexSpecs[index].strikeStep;
  const out: ChainSnapshot[] = [];
  for (let t = istAt(DAY, "09:16") + 1_500, m = 0; t <= istAt(DAY, "11:30"); t += MINUTE_MS, m++) {
    const future = t > T;
    const spot = spotAt(index, Math.min(t, T)) * (future ? 1.03 : 1);
    const atm = Math.round(spot / step) * step;
    const rows: ChainRow[] = Array.from({ length: 31 }, (_, i) => {
      const strike = atm + (i - 15) * step;
      const side = (type: "CE" | "PE") => {
        const mid = Math.max(0, type === "CE" ? spot - strike : strike - spot) + 100 * Math.exp(-Math.abs(strike - spot) / (3 * step)) * (future ? 3 : 1);
        return { ltp: mid, volume: 500 * m, oi: (future ? 7_000_000 : 1_000_000) + 900 * m * (type === "CE" ? 1 : 2), bid: mid * 0.997, ask: mid * 1.003, iv: future ? 40 : 12.5, delta: type === "CE" ? 0.5 : -0.5 };
      };
      return { strike, ce: side("CE"), pe: side("PE") };
    });
    out.push({ t, index, expiry: index === "NIFTY" ? "2026-10-13" : "2026-10-08", lotSize: cfg.indexSpecs[index].lotSize, spot, rows });
  }
  return out;
}

function event(id: string, scoredAtMs: number, firstSeenMs: number): ScoredEvent {
  const base: Omit<ScoredEvent, "numeric"> = {
    clusterId: id,
    clusterKey: id,
    scoredAtMs,
    scorer: "llm",
    model: "test",
    version: "rubric-v1",
    taxonomy: "MACRO_POLICY",
    indiaRelevance: "DIRECT",
    isScheduledData: false,
    surprise: "NEGATIVE",
    novelty: "NEW",
    pricedIn: "LOW",
    horizon: "DAYS_1_2",
    halfLifeHours: 6,
    impact: {
      NIFTY: { direction: "STRONG_BEAR", magnitude: "LARGE", confidence: "HIGH" },
      SENSEX: { direction: "STRONG_BEAR", magnitude: "LARGE", confidence: "HIGH" },
    },
    sectors: [],
    rationale: "Test event.",
    firstSeenMs,
    articleCount: 25,
    title: id,
  };
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") } };
}

const eventsA = [event("before", T - 40 * MINUTE_MS, T - 45 * MINUTE_MS)];
// Scored after T: a new story, and a story seen before T but scored after it.
const eventsB = [...eventsA, event("after", T + 60_000, T + 30_000), event("late-score", T + 20_000, T - 5 * MINUTE_MS)];

/** The agent's book, recorded before T with a NIFTY call open; the same in A and B. */
const book: AgentBookState = {
  t: T - 20_000,
  equity: 498_000,
  peakEquity: 503_000,
  ddPct: 0.99,
  dayLossPct: 0.4,
  positions: [{ index: "NIFTY", side: "BULL", lots: 2, avgEntry: 120, markPremium: 131.2, markMs: T - 25_000 }],
};

const samplesAll = Object.fromEntries(INDICES.map((i) => [i, samples(i)])) as Record<IndexId, ChainSnapshot[]>;
const samplesA = (index: IndexId) => samplesAll[index].filter((s) => s.t <= T);

function snapshotInput(index: IndexId, b: boolean, o: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    index,
    barCloseMs: T,
    market: b ? marketB : marketA,
    calendar: cal,
    cfg,
    events: b ? eventsB : eventsA,
    perf: [],
    flow: flowViewAsOf(b ? samplesAll[index] : samplesA(index), index, T),
    book,
    ...o,
  };
}

describe("leak test: bar T is the same with and without data after T", () => {
  it("B really holds data after T", () => {
    expect(marketB.candles["^NSEI"].some((c) => c.t === T)).toBe(true);
    expect(marketB.candles["^INDIAVIX"].some((c) => c.t > T)).toBe(true);
    expect(marketB.daily["^NSEI"].some((c) => istDate(c.t) === DAY)).toBe(true);
    expect(marketA.candles["^NSEI"].every((c) => c.t + 5 * MINUTE_MS <= T)).toBe(true);
    expect(samplesAll.NIFTY.some((s) => s.t > T)).toBe(true);
  });

  it("1. buildIndexSnapshot and encodeSnapshot are equal on A and B, for both indices", () => {
    for (const index of INDICES) {
      const a = buildIndexSnapshot(snapshotInput(index, false));
      const b = buildIndexSnapshot(snapshotInput(index, true));
      expect(b).toEqual(a);
      expect(encodeSnapshot(b)).toBe(encodeSnapshot(a));
      // Not vacuous: real numbers, an option block and the open position.
      expect(a.c).toBeGreaterThan(0);
      expect(a.o).not.toBeNull();
      expect(a.o!.iv).toBe(13);
      if (index === "NIFTY") expect(a.bk).toMatchObject({ pos: "L", lots: 2, pnl: 9.3 });
    }
  });

  it("3. flowViewAsOf ignores samples taken after T", () => {
    for (const index of INDICES) {
      const a = flowViewAsOf(samplesA(index), index, T);
      expect(a).not.toBeNull();
      expect(flowViewAsOf(samplesAll[index], index, T)).toEqual(a);
      expect(Date.parse(a!.asOf!)).toBeLessThanOrEqual(T);
    }
  });

  it("4. control: changing data before T does change the snapshot", () => {
    const barBefore = T - 5 * MINUTE_MS;
    const bent: MarketSnapshot = { ...marketA, candles: { ...marketA.candles, "^NSEI": marketA.candles["^NSEI"].map((c) => (c.t === barBefore ? { ...c, c: c.c * 1.002 } : c)) } };
    const a = buildIndexSnapshot(snapshotInput("NIFTY", false));
    const changed = buildIndexSnapshot(snapshotInput("NIFTY", false, { market: bent }));
    expect(changed.c !== a.c || changed.r5 !== a.r5).toBe(true);
    // The option block too: the last sample before T moves the call's quote.
    const last = samplesA("NIFTY").at(-1)!;
    const moved = samplesA("NIFTY").map((s) => (s === last ? { ...s, rows: s.rows.map((r) => ({ ...r, ce: r.ce && { ...r.ce, bid: r.ce.bid! * 0.95 } })) } : s));
    const withMoved = buildIndexSnapshot(snapshotInput("NIFTY", false, { flow: flowViewAsOf(moved, "NIFTY", T) }));
    expect(withMoved.o!.cs).not.toBe(a.o!.cs);
  });

  it("5. a brief created at T + 30 s changes nothing in bar T's finalists and brief context", () => {
    const idea: AdvisorIdea = {
      id: "adv-202610071100-1",
      horizon: "TODAY",
      contract: { index: "NIFTY", expiry: "2026-10-13", strike: 25_000, optionType: "PE", tradingSymbol: "NIFTY26O1325000PE", lotSize: 65, label: "NIFTY 13-OCT-2026 25000 PE" },
      entry: { low: 90, high: 100, ask: 95, asOf: istIso(T + 25_000) },
      stop: 65,
      target: 145,
      exitBy: `${DAY}T15:00:00+05:30`,
      lots: 1,
      costPerLot: 6_175,
      maxLossPerLot: 1_950,
      rewardPerLot: 3_250,
      breakevenAtExpiry: 24_905,
      delta: -0.5,
      iv: 13,
      probItm: 0.5,
      why: ["NIFTY broke down after a comment made at 11:00:20."],
      wrongIf: "NIFTY closes back above 25,100.",
      confidence: "HIGH",
      condition: null,
      bearCase: "The fall may already be priced in.",
    };
    const brief = (createdMs: number): AdvisorReport => ({
      id: "adv-202610071100",
      createdAt: istIso(createdMs),
      model: "test",
      durationMs: 1,
      costUsd: null,
      market: { nifty: 25_000, sensex: 82_000, vix: 13, phase: "OPEN" },
      headline: "SELL-OFF: NIFTY is breaking down after the 11:00 comment.",
      today: { action: "BUY", summary: "Buy the put.", ideaId: idea.id },
      outlook: [],
      factors: [{ key: "NEWS_UNCERTAINTY", label: "News", reading: "SUPPORTS_DOWN", detail: "A comment at 11:00:20 hit banks.", source: "web research" }],
      ideas: [idea],
      zeroHero: { applicable: false, expiry: null, summary: "" },
      premium: { verdict: "NORMAL", detail: "" },
      alsoKnow: [],
      avoid: [],
      sources: [],
      honesty: "No measured edge.",
    });
    const request = (b: AdvisorReport | null) => JSON.stringify({ finalists: compileFinalists({ indices: INDICES, nowMs: T, brief: b }).map(finalistPrompt), brief: briefContext(b, T) });
    expect(request(brief(T + 30_000))).toBe(request(null));
    // Control: the same brief written before the close is used.
    expect(request(brief(T - 30_000))).not.toBe(request(null));
    expect(compileFinalists({ indices: INDICES, nowMs: T, brief: brief(T - 30_000) }).map((f) => f.id)).toContain("idea:adv-202610071100:adv-202610071100-1");
  });
});
