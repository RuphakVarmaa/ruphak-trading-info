import { describe, expect, it } from "vitest";
import type { AdviceOut } from "./advise";
import { HONESTY_LINE } from "./knowledge";
import type { ResearchResult } from "./research";
import type { AdvisorCandidate, AdvisorContext } from "./types";
import { ZERO_USAGE } from "./types";
import { buildReport, costUsd, exitByFor, parseIstDateTime, roundTripCharges, summarize, validateIdea, type IdeaInput } from "./validate";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const NOW = ist("2026-10-16T11:00:00");

const cand = (p: Partial<AdvisorCandidate> = {}): AdvisorCandidate => ({
  id: "NIFTY-2026-10-20-23200-CE",
  index: "NIFTY",
  expiry: "2026-10-20",
  expiryKind: "nearest",
  monthly: false,
  strike: 23200,
  optionType: "CE",
  atmOffset: 0,
  tradingSymbol: "NIFTY26O2023200CE",
  label: "NIFTY 20-OCT-2026 23200 CE",
  lotSize: 65,
  bid: 99.5,
  ask: 100,
  ltp: 99.8,
  price: 100,
  priceBasis: "ask",
  delta: 0.52,
  iv: 13.1,
  theta: -9.5,
  oi: 4_000_000,
  oiChange: 250_000,
  daysToExpiry: 4,
  breakevenAtExpiry: 23300,
  costPerLot: 6500,
  asOf: "2026-10-16T10:59:30+05:30",
  ...p,
});

const idea = (p: Partial<IdeaInput> = {}): IdeaInput => ({
  candidateId: "NIFTY-2026-10-20-23200-CE",
  horizon: "TODAY",
  entryLow: 97,
  entryHigh: 102,
  stop: 70,
  target: 150,
  exitBy: "2026-10-16T14:30",
  why: ["Calls are being covered above 23,100."],
  wrongIf: "NIFTY closes a 5-minute candle below 23,050.",
  confidence: "LOW",
  ...p,
});

const opts = { id: "adv-1-1", nowMs: NOW };

describe("one idea against its real contract", () => {
  it("keeps a good idea and works out cost, maximum loss, reward and odds per lot", () => {
    const r = validateIdea(idea(), cand(), opts);
    if (!r.ok) throw new Error(r.reason);
    const x = r.idea;
    expect(x.contract).toEqual({ index: "NIFTY", expiry: "2026-10-20", strike: 23200, optionType: "CE", tradingSymbol: "NIFTY26O2023200CE", lotSize: 65, label: "NIFTY 20-OCT-2026 23200 CE" });
    expect(x.entry).toEqual({ low: 97, high: 102, ask: 100, asOf: "2026-10-16T10:59:30+05:30" });
    expect(x.stop).toBe(70);
    expect(x.target).toBe(150);
    expect(x.costPerLot).toBe(6500);
    const chargesStop = roundTripCharges(cand(), 100, 70, "2026-10-16");
    const chargesTarget = roundTripCharges(cand(), 100, 150, "2026-10-16");
    expect(chargesStop).toBeGreaterThan(20);
    expect(x.maxLossPerLot).toBeCloseTo(30 * 65 + chargesStop, 2);
    expect(x.rewardPerLot).toBeCloseTo(50 * 65 - chargesTarget, 2);
    expect(x.breakevenAtExpiry).toBe(23300);
    expect(x.probItm).toBe(0.52);
    expect(x.delta).toBe(0.52);
    expect(x.iv).toBe(13.1);
    expect(x.lots).toBe(1); // ₹6,500 a lot: one fits ₹10,000.
    expect(x.exitBy).toBe("2026-10-16T14:30:00+05:30");
    expect(r.notes).toEqual([]);
  });

  it("drops a hallucinated contract id", () => {
    const r = validateIdea(idea({ candidateId: "NIFTY-2026-10-20-99999-CE" }), undefined, opts);
    expect(r).toEqual({ ok: false, reason: 'unknown contract id "NIFTY-2026-10-20-99999-CE"' });
  });

  it("drops a buy zone more than 15% from the live ask, and clamps one inside it", () => {
    const far = validateIdea(idea({ entryLow: 80, entryHigh: 84 }), cand(), opts);
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.reason).toMatch(/16% away/);
    const near = validateIdea(idea({ entryLow: 88, entryHigh: 120 }), cand(), opts);
    if (!near.ok) throw new Error(near.reason);
    expect(near.idea.entry).toMatchObject({ low: 88, high: 105 });
    expect(near.notes[0]).toMatch(/clamped/);
  });

  it("drops a stop at or above the ask and a target at or below it", () => {
    expect(validateIdea(idea({ stop: 100 }), cand(), opts).ok).toBe(false);
    expect(validateIdea(idea({ target: 99 }), cand(), opts).ok).toBe(false);
    expect(validateIdea(idea({ stop: -5 }), cand(), opts).ok).toBe(false);
  });

  it("fixes a stop that is too tight or too wide, and a target under 1.2× the risk", () => {
    const tight = validateIdea(idea({ stop: 96, target: 200 }), cand(), opts);
    if (!tight.ok) throw new Error(tight.reason);
    expect(tight.idea.stop).toBe(90);
    const wide = validateIdea(idea({ stop: 20, target: 250 }), cand(), opts);
    if (!wide.ok) throw new Error(wide.reason);
    expect(wide.idea.stop).toBe(40);
    const low = validateIdea(idea({ stop: 70, target: 120 }), cand(), opts);
    if (!low.ok) throw new Error(low.reason);
    expect(low.idea.target).toBe(136); // 100 + 1.2 × 30
    expect(low.notes.join(" ")).toMatch(/target raised/);
  });

  it("drops a contract one lot of which costs more than the capital, and sizes cheap ones within the risk cap", () => {
    const dear = validateIdea(idea({ entryLow: 195, entryHigh: 205, stop: 140, target: 300 }), cand({ price: 200, ask: 200 }), opts);
    expect(dear.ok).toBe(false);
    if (!dear.ok) expect(dear.reason).toMatch(/more than the ₹10,000 capital/);
    const cheap = validateIdea(idea({ candidateId: "SENSEX-2026-10-22-82000-CE", entryLow: 39, entryHigh: 41, stop: 28, target: 60 }), cand({ index: "SENSEX", lotSize: 20, price: 40, ask: 40, strike: 82000 }), opts);
    if (!cheap.ok) throw new Error(cheap.reason);
    // ₹800 a lot fits 12 times, but the max loss (₹12 × 20 + charges a lot) caps it at 30% of ₹10,000.
    expect(cheap.idea.costPerLot).toBe(800);
    expect(cheap.idea.lots).toBe(Math.floor(3000 / cheap.idea.maxLossPerLot));
    expect(cheap.idea.lots * cheap.idea.maxLossPerLot).toBeLessThanOrEqual(3000);
  });

  it("checks against the last trade when no ask is quoted, and says so", () => {
    const r = validateIdea(idea(), cand({ ask: null, bid: null, price: 99.8, priceBasis: "ltp" }), opts);
    if (!r.ok) throw new Error(r.reason);
    expect(r.idea.entry.ask).toBe(99.8);
    expect(r.notes.join(" ")).toMatch(/last traded price/);
  });
});

describe("exit times", () => {
  it("parses IST date-times and keeps exits inside the session and before expiry", () => {
    expect(parseIstDateTime("2026-10-16 14:30")).toBe(ist("2026-10-16T14:30:00"));
    expect(parseIstDateTime("tomorrow")).toBeNull();
    expect(exitByFor("2026-10-16T15:29", "TODAY", "2026-10-20", NOW)).toBe("2026-10-16T15:15:00+05:30");
    expect(exitByFor("2026-10-25T11:00", "WEEK", "2026-10-20", NOW)).toBe("2026-10-20T15:15:00+05:30");
    expect(exitByFor("soon", "TODAY", "2026-10-20", NOW)).toBe("2026-10-16T15:15:00+05:30");
    expect(exitByFor("2026-10-10T11:00", "WEEK", "2026-10-27", NOW)).toBe("2026-10-27T15:15:00+05:30");
  });
});

describe("cost of a brief", () => {
  it("prices Opus 5.5 tokens and web searches", () => {
    // 100k in × $4 + 10k out × $20 + 50k cache reads × $0.20 + 6 searches × $0.01.
    expect(costUsd({ inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 50_000, cacheCreationTokens: 0, webSearches: 6 })).toBe(0.67);
    expect(costUsd({ ...ZERO_USAGE, cacheCreationTokens: 1_000_000 })).toBe(5);
    expect(costUsd(ZERO_USAGE)).toBe(0);
  });
});

describe("the whole report", () => {
  const ctx = (p: Partial<AdvisorContext> = {}): AdvisorContext => ({
    promptJson: "{}",
    candidates: [cand(), cand({ id: "NIFTY-2026-10-20-23100-PE", strike: 23100, optionType: "PE", label: "NIFTY 20-OCT-2026 23100 PE", tradingSymbol: "NIFTY26O2023100PE", price: 90, ask: 90, delta: -0.45 })],
    zeroHeroCandidates: [],
    market: { nifty: 23180, sensex: 76000, vix: 12.4, phase: "OPEN" },
    expiryToday: {},
    knownUrls: ["https://www.reuters.com/markets/india-1"],
    ...p,
  });
  const research = (ok = true): ResearchResult =>
    ok
      ? { ok: true, notes: "FII_DII: FIIs sold ₹1,200 crore (provisional) https://www.moneycontrol.com/a", sources: [{ title: "FIIs sell", url: "https://www.moneycontrol.com/a" }], usage: ZERO_USAGE, error: null, stopReason: "end_turn" }
      : { ok: false, notes: "", sources: [], usage: ZERO_USAGE, error: "Web research failed (HTTP 529: overloaded).", stopReason: null };
  const advice = (p: Partial<AdviceOut> = {}): AdviceOut => ({
    headline: "Wait for a cleaner setup; premiums are fair.",
    today: { action: "BUY", summary: "One small call idea.", candidateId: "NIFTY-2026-10-20-23200-CE" },
    outlook: [
      { index: "SENSEX", horizon: "WEEK", lean: "SIDEWAYS", confidence: "LOW", rangeLow: 75000, rangeHigh: 77000, why: ["range"] },
      { index: "NIFTY", horizon: "TODAY", lean: "UP", confidence: "LOW", rangeLow: 23300, rangeHigh: 23050, why: ["covering"] },
      { index: "NIFTY", horizon: "TODAY", lean: "DOWN", confidence: "HIGH", rangeLow: null, rangeHigh: null, why: ["duplicate"] },
    ],
    factors: [
      { key: "TREND", label: "Trend", reading: "SUPPORTS_UP", detail: "Above VWAP.", source: "engine signal" },
      { key: "FII_DII", label: "Funds", reading: "SUPPORTS_DOWN", detail: "FIIs sold ₹1,200 crore.", source: "web research: Moneycontrol" },
    ],
    ideas: [idea(), idea({ candidateId: "NIFTY-2026-10-20-99999-CE" }), idea({ candidateId: "NIFTY-2026-10-20-23100-PE", horizon: "WEEK", entryLow: 88, entryHigh: 92, stop: 60, target: 140, exitBy: "2026-10-19T14:00" })],
    zeroHero: { applicable: true, summary: "Lottery tickets." },
    premium: { verdict: "NORMAL", detail: "IV 13 vs VIX 12.4." },
    alsoKnow: ["India VIX is the market's expected 30-day volatility."],
    avoid: ["Do not buy in the first 15 minutes."],
    sources: [
      { title: "FIIs sell", url: "https://www.moneycontrol.com/a" },
      { title: "Made up", url: "https://example.com/fake" },
      { title: "News", url: "https://www.reuters.com/markets/india-1" },
    ],
    ...p,
  });
  const build = (a: AdviceOut, r = research(), c = ctx()) => buildReport({ id: "adv-1", nowMs: NOW, model: "claude-opus-5-5", durationMs: 61_000, usage: { ...ZERO_USAGE, inputTokens: 50_000, outputTokens: 8_000, webSearches: 4 }, advice: a, context: c, research: r });

  it("keeps valid ideas, drops invented ones, and points today's BUY at the kept idea", () => {
    const { report, notes } = build(advice());
    expect(report.ideas.map((x) => x.contract.label)).toEqual(["NIFTY 20-OCT-2026 23200 CE", "NIFTY 20-OCT-2026 23100 PE"]);
    expect(report.ideas.map((x) => x.id)).toEqual(["adv-1-1", "adv-1-2"]);
    expect(report.today).toEqual({ action: "BUY", summary: "One small call idea.", ideaId: "adv-1-1" });
    expect(notes.some((n) => n.includes("99999"))).toBe(true);
    expect(report.costUsd).toBe(0.4); // 50k in × $4 + 8k out × $20 + 4 searches × $0.01
    expect(report.honesty).toBe(HONESTY_LINE);
    expect(report.market).toEqual({ nifty: 23180, sensex: 76000, vix: 12.4, phase: "OPEN" });
    expect(report.createdAt).toBe("2026-10-16T11:00:00+05:30");
    expect(summarize(report).ideas).toEqual([
      { id: "adv-1-1", label: "NIFTY 20-OCT-2026 23200 CE", horizon: "TODAY", entryAsk: 100, stop: 70, target: 150 },
      { id: "adv-1-2", label: "NIFTY 20-OCT-2026 23100 PE", horizon: "WEEK", entryAsk: 90, stop: 60, target: 140 },
    ]);
  });

  it("turns a BUY whose idea failed the checks into WAIT and says why", () => {
    const { report } = build(advice({ today: { action: "BUY", summary: "Buy it.", candidateId: "NIFTY-2026-10-20-99999-CE" } }));
    expect(report.today.action).toBe("WAIT");
    expect(report.today.ideaId).toBeNull();
    expect(report.today.summary).toMatch(/Changed to WAIT/);
    const none = build(advice({ today: { action: "BUY", summary: "Buy.", candidateId: null } })).report;
    expect(none.today.action).toBe("WAIT");
    const wait = build(advice({ today: { action: "AVOID", summary: "Stay out.", candidateId: "NIFTY-2026-10-20-23200-CE" } })).report;
    expect(wait.today).toEqual({ action: "AVOID", summary: "Stay out.", ideaId: null });
  });

  it("orders factors, fills missing ones with no data, and forces FII/DII to no data when the research failed", () => {
    const ok = build(advice()).report;
    expect(ok.factors.map((f) => f.key)).toEqual(["FII_DII", "NEWS_UNCERTAINTY", "GLOBAL_CUES", "SHORT_COVERING", "OPTIONS_POSITIONING", "VOLATILITY_PREMIUM", "TREND", "EVENTS"]);
    expect(ok.factors[0].reading).toBe("SUPPORTS_DOWN");
    expect(ok.factors[1].reading).toBe("NO_DATA");
    const failed = build(advice(), research(false)).report;
    expect(failed.factors[0]).toMatchObject({ key: "FII_DII", reading: "NO_DATA", source: "web research (failed)" });
    expect(failed.factors[0].detail).toMatch(/HTTP 529/);
  });

  it("keeps only sources that came from the research or the news, sorts the outlook and fixes swapped ranges", () => {
    const { report } = build(advice());
    expect(report.sources.map((s) => s.url)).toEqual(["https://www.moneycontrol.com/a", "https://www.reuters.com/markets/india-1"]);
    expect(report.outlook.map((o) => `${o.index}|${o.horizon}`)).toEqual(["NIFTY|TODAY", "SENSEX|WEEK"]);
    expect(report.outlook[0]).toMatchObject({ lean: "UP", rangeLow: 23050, rangeHigh: 23300 });
  });

  it("shows zero-hero only on an expiry day, with the market's own odds", () => {
    expect(build(advice()).report.zeroHero).toEqual({ applicable: false, expiry: null, summary: "No expiry today." });
    const c = ctx({
      expiryToday: { NIFTY: "2026-10-16" },
      zeroHeroCandidates: [
        { id: "z1", index: "NIFTY", expiry: "2026-10-16", strike: 23500, optionType: "CE", label: "NIFTY 16-OCT-2026 23500 CE", lotSize: 65, price: 4, priceBasis: "ask", delta: 0.04, costPerLot: 260, distancePct: 1.4, impliedWorthlessPct: 96 },
      ],
    });
    const z = build(advice(), research(), c).report.zeroHero;
    expect(z.applicable).toBe(true);
    expect(z.expiry).toBe("2026-10-16");
    expect(z.summary).toMatch(/delta 0\.04/);
    expect(z.summary).toMatch(/96% of the time/);
  });
});
