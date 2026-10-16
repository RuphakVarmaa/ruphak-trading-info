import { describe, expect, it } from "vitest";
import type { EventClusterView, ImpactView, ScheduledEventView, SignalComponentView, SignalView } from "@/engine/api-types";
import type { IntelItem } from "@/utils/api";
import {
  activeImpact,
  chokepointMarkers,
  engineLinkFor,
  engineVerdict,
  eventMarkers,
  eventVote,
  geoTradeAnswer,
  headlineMarkers,
  layerChipText,
  MAP_COLORS,
  moreScheduled,
  placeEvents,
  pressureWords,
  STRIP_ROWS,
  type EngineVerdict,
  type EventVote,
} from "./geoView";
import { chokepointNews } from "@/utils/api";

const NOW = Date.parse("2026-10-16T11:42:00+05:30");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const imp = (index: "NIFTY" | "SENSEX", score: number): ImpactView => ({ index, direction: score > 0 ? 1 : score < 0 ? -1 : 0, score, magnitudePct: 0.5, confidence: 0.6, halfLifeHours: 12 });

function ev(id: string, title: string, over: Partial<EventClusterView> = {}): EventClusterView {
  return {
    clusterId: id,
    title,
    summary: "",
    taxonomy: "GEOPOLITICAL",
    tab: "GEOPOLITICS",
    severity: "ALERT",
    scorer: "llm",
    firstSeenAt: iso(120),
    lastSeenAt: iso(10),
    articleCount: 3,
    sources: ["Reuters"],
    impacts: [imp("NIFTY", -0.3), imp("SENSEX", -0.2)],
    sectors: [],
    pricedIn: false,
    decayRemaining: 1,
    topUrl: null,
    isScheduledData: false,
    ...over,
  };
}

const comp = (source: SignalComponentView["source"], value: number, weight: number, extra: Partial<SignalComponentView> = {}): SignalComponentView => ({ source, value, weight, enabled: true, ...extra });

function signal(over: Partial<SignalView> = {}): SignalView {
  return {
    index: "NIFTY",
    stance: "BULLISH",
    conviction: 0.5,
    entryThreshold: 0.35,
    regime: "TREND_UP",
    computedAt: iso(1),
    spot: 22600,
    expectedMovePct: null,
    impliedMovePct: null,
    edgeRatio: null,
    minEdgeRatio: 0.1,
    gates: [],
    allGatesPassed: false,
    contract: null,
    noPlanReason: null,
    components: [comp("EVENT", 0.62, 0.3), comp("ORB", 0.55, 0.15), comp("MOMENTUM", 0.66, 0.15), comp("GAP", 0, 0.1, { abstain: true }), comp("VOL_REGIME", 0, 0)],
    contributors: [],
    rationale: "",
    position: null,
    indicators: null,
    advice: null,
    ...over,
  };
}

describe("placeEvents and activeImpact", () => {
  it("splits placed and unplaced; pending stories have no active impact", () => {
    const pending = ev("p", "FPIs sell ₹3,870 crore", { scorer: "pending", impacts: [] });
    const { placed, unplaced } = placeEvents([ev("a", "Red Sea attacks reroute tankers"), pending, ev("b", "China unveils bond package", { impacts: [imp("NIFTY", 0.6)] })]);
    expect(placed.map((p) => p.event.clusterId)).toEqual(["b", "a"]);
    expect(unplaced.map((e) => e.clusterId)).toEqual(["p"]);
    expect(activeImpact(pending)).toBe(0);
    expect(activeImpact(ev("x", "t", { decayRemaining: 0.5 }), "NIFTY")).toBeCloseTo(0.15);
    expect(activeImpact(ev("x", "t", { impacts: [imp("NIFTY", 0.4)] }), "SENSEX")).toBe(0);
  });
});

describe("eventMarkers", () => {
  it("groups per place, counts, links the strongest story and colours by the NIFTY direction", () => {
    const { placed } = placeEvents([
      ev("weak", "Iran warns shipping", { impacts: [imp("NIFTY", -0.1)] }),
      ev("strong", "Iranian strike on tanker", { impacts: [imp("NIFTY", -0.5)] }),
      ev("cn", "China stimulus", { impacts: [imp("NIFTY", 0.4)] }),
    ]);
    const markers = eventMarkers(placed, new Set(["weak"]), NOW);
    const iran = markers.find((m) => m.placeId === "IR")!;
    expect(iran.items).toHaveLength(2);
    expect(iran.items[0].href).toBe("/events/strong");
    expect(iran.summary).toMatch(/^2 engine stories/);
    expect(iran.itemCount).toBe(2);
    expect(iran.color).toBe(MAP_COLORS.bear);
    expect(iran.ring).toBe(true);
    expect(iran.radius).toBe(11);
    const cn = markers.find((m) => m.placeId === "CN")!;
    expect(cn.color).toBe(MAP_COLORS.bull);
    expect(cn.ring).toBe(false);
    expect(iran.items[0].meta).toContain("10 min ago");
  });
});

describe("headlineMarkers and chokepointMarkers", () => {
  const item = (id: string, title: string, over: Partial<IntelItem> = {}): IntelItem => ({
    id,
    title,
    description: "",
    source: "Reuters",
    url: `https://example.com/${id}`,
    publishedAt: iso(30),
    category: "ENERGY",
    severity: "UPDATE",
    tags: [],
    ...over,
  });
  it("aggregates per place, ignores item.location, and never places a commodity word", () => {
    const items = [
      item("1", "Saudi Arabia raises crude prices", { location: { lat: 0, lng: 0, name: "Nowhere" } }),
      item("2", "Saudi output steady"),
      item("3", "Gold price hits a record"),
      item("4", "Houthis strike near the Red Sea"),
    ];
    const markers = headlineMarkers(items, NOW);
    expect(markers).toHaveLength(1);
    expect(markers[0].placeId).toBe("SA");
    expect(markers[0].items).toHaveLength(2);
    expect(markers[0].lat).not.toBe(0);
  });
  it("chokepoints are hollow and coloured by news level", () => {
    const cps = chokepointNews([item("4", "Houthis strike near the Red Sea", { severity: "FLASH" })], NOW);
    const markers = chokepointMarkers(cps, NOW);
    const red = markers.find((m) => m.placeId === "RED_SEA")!;
    expect(red.hollow).toBe(true);
    expect(red.color).toBe(MAP_COLORS.cpHeavy);
    expect(markers.find((m) => m.placeId === "SUEZ")!.color).toBe(MAP_COLORS.cpQuiet);
  });
  it("layer chips count items and their places, and say 'no data' before the feed loads", () => {
    const { placed } = placeEvents([ev("a", "Iran warns shipping"), ev("b", "Iranian strike on tanker"), ev("c", "China stimulus")]);
    const hl = headlineMarkers([item("1", "Saudi Arabia raises crude prices"), item("2", "Saudi output steady"), item("3", "Japan's exports rise")], NOW);
    const cps = chokepointMarkers(chokepointNews([], NOW), NOW);
    const markers = [...eventMarkers(placed, new Set(), NOW), ...hl, ...cps];
    expect(layerChipText("engine", markers, true)).toBe("3 · 2 places");
    expect(layerChipText("headline", markers, true)).toBe("3 · 2 places");
    expect(layerChipText("chokepoint", markers, true)).toBe(String(cps.length));
    expect(layerChipText("headline", [], true)).toBe("0");
    expect(layerChipText("headline", markers, false)).toBe("no data");
    expect(layerChipText("chokepoint", markers, false)).toBe("no data");
  });
});

describe("moreScheduled", () => {
  const sched = (id: string, hoursAhead: number): ScheduledEventView => ({
    id,
    title: id,
    kind: "OTHER",
    at: new Date(NOW + hoursAhead * 3_600_000).toISOString(),
    impact: "MED",
    approx: false,
    blackoutStart: null,
    blackoutEnd: null,
    indices: ["NIFTY"],
  });
  it("leaves out only the rows the strip shows, so a busy week leaves no gap", () => {
    // Ten events inside the strip's 8-day window: the strip shows 8, the 9th and 10th belong here.
    const week = Array.from({ length: 10 }, (_, i) => sched(`w${i}`, 6 + i * 12));
    const later = [sched("m1", 24 * 12), sched("m2", 24 * 20)];
    const past = sched("past", -1);
    const more = moreScheduled([...later, past, ...week], week, NOW);
    expect(STRIP_ROWS).toBe(8);
    expect(more.map((e) => e.id)).toEqual(["w8", "w9", "m1", "m2"]);
  });
  it("excludes nothing while the strip has no data", () => {
    expect(moreScheduled([sched("a", 2), sched("b", 300)], null, NOW).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("eventVote", () => {
  it("is absent when the decision has no EVENT component (published strategies)", () => {
    expect(eventVote({ components: [comp("ORB", 0.5, 1)], conviction: 0.5 })).toEqual({ kind: "absent" });
  });
  it("carries abstain notes and spots the out-of-regime case", () => {
    const v = eventVote({ components: [comp("EVENT", 0, 0, { abstain: true, notes: "6 live stories, no net direction (EPI −0.02)" })], conviction: 0 });
    expect(v).toEqual({ kind: "abstain", notes: "6 live stories, no net direction (EPI −0.02)", outOfRegime: false });
    const r = eventVote({ components: [comp("EVENT", 0.3, 0, { abstain: true, notes: "EPI 0.3 (not used in the RANGE regime)" })], conviction: 0 });
    expect(r.kind === "abstain" && r.outOfRegime).toBe(true);
  });
  it("computes the pull and share as the engine counts them", () => {
    const v = eventVote(signal());
    expect(v.kind).toBe("voting");
    if (v.kind !== "voting") return;
    expect(v.pull).toBeCloseTo(0.186 / 0.6, 6);
    expect(v.sharePct).toBeCloseTo((0.186 / (0.186 + 0.0825 + 0.099)) * 100, 6);
    expect(v.sameSide).toBe(true);
    const zero = eventVote(signal({ conviction: 0 }));
    expect(zero.kind === "voting" && zero.sameSide).toBeNull();
  });
});

describe("pressureWords", () => {
  it("uses the engine's 0.1 floor and display bands", () => {
    expect(pressureWords(0.099)).toEqual({ side: "none", band: "none" });
    expect(pressureWords(0.1)).toEqual({ side: "bullish", band: "weak" });
    expect(pressureWords(0.3)).toEqual({ side: "bullish", band: "moderate" });
    expect(pressureWords(0.6)).toEqual({ side: "bullish", band: "strong" });
    expect(pressureWords(-0.6)).toEqual({ side: "bearish", band: "strong" });
  });
});

describe("engineVerdict", () => {
  const position = { contract: { label: "NIFTY 27-OCT-2026 22600 CE", optionType: "CE" }, dominantSource: "EVENT" } as unknown as SignalView["position"];
  it("stale beats holding", () => {
    expect(engineVerdict(signal({ computedAt: iso(20), position }), NOW).kind).toBe("STALE");
    expect(engineVerdict(null, NOW).kind).toBe("NO_SIGNAL");
  });
  it("holding, then entering, then advice", () => {
    expect(engineVerdict(signal({ position }), NOW)).toEqual({ kind: "HOLDING", contractLabel: "NIFTY 27-OCT-2026 22600 CE", eventLed: true, side: 1 });
    const pe = { contract: { label: "NIFTY 27-OCT-2026 22600 PE", optionType: "PE" }, dominantSource: "TREND" } as unknown as SignalView["position"];
    expect(engineVerdict(signal({ position: pe }), NOW)).toMatchObject({ kind: "HOLDING", side: -1, eventLed: false });
    const contract = { label: "NIFTY 27-OCT-2026 22700 CE", lots: 1 } as SignalView["contract"];
    expect(engineVerdict(signal({ allGatesPassed: true, contract }), NOW).kind).toBe("ENTERING");
    expect(engineVerdict(signal({ allGatesPassed: true, contract: { ...contract!, lots: 0 } }), NOW).kind).toBe("WAIT");
    const advice = { contract: { label: "NIFTY X CE" }, pausedBy: ["edge"] } as unknown as SignalView["advice"];
    expect(engineVerdict(signal({ advice }), NOW)).toEqual({ kind: "ENTER_ADVICE", contractLabel: "NIFTY X CE", pausedBy: ["edge"] });
  });
  it("waits with the first blocking check", () => {
    const v = engineVerdict(signal({ conviction: 0.2, gates: [{ gate: "event_blackout", label: "Event blackout", passed: false, detail: "RBI at 10:00" }] }), NOW);
    expect(v.kind).toBe("WAIT");
    if (v.kind === "WAIT") expect(v.reason.length).toBeGreaterThan(0);
  });
});

describe("geoTradeAnswer", () => {
  const voting = (sameSide: boolean | null): EventVote => ({ kind: "voting", epi: -0.34, weight: 0.3, pull: -0.1, sharePct: 31, sameSide });
  const wait: EngineVerdict = { kind: "WAIT", reason: "Conviction too low.", trigger: "Conviction above 0.35." };
  const holdPe: EngineVerdict = { kind: "HOLDING", contractLabel: "NIFTY X PE", eventLed: true, side: -1 };
  const holdCe: EngineVerdict = { kind: "HOLDING", contractLabel: "NIFTY X CE", eventLed: false, side: 1 };
  const cases: [EventVote, EngineVerdict, string][] = [
    [{ kind: "absent" }, wait, "news_not_used"],
    [{ kind: "abstain", notes: "no live events", outOfRegime: false }, wait, "news_silent"],
    [voting(false), wait, "news_against_reading"],
    [voting(null), wait, "news_supports_engine_waits"],
    [voting(true), { kind: "ENTER_ADVICE", contractLabel: "NIFTY X PE", pausedBy: [] }, "news_in_entry"],
    [voting(true), wait, "news_supports_engine_waits"],
    [voting(true), holdPe, "holding_news_with"],
    [voting(true), holdCe, "holding_news_against"],
    [voting(false), holdPe, "holding_news_with"],
    [voting(true), { kind: "STALE", ageMs: 1e6 }, "no_reading"],
  ];
  it.each(cases)("%# gives the right kind and never promises profit", (vote, verdict, kind) => {
    const a = geoTradeAnswer("NIFTY", vote, verdict);
    expect(a.kind).toBe(kind);
    expect(a.text.replace("Not a profit promise", "")).not.toMatch(/profit/i);
  });
  it("names the share and the contract when news is behind an entry", () => {
    const a = geoTradeAnswer("NIFTY", voting(true), { kind: "ENTER_ADVICE", contractLabel: "NIFTY X PE", pausedBy: [] });
    expect(a.word).toBe("Yes");
    expect(a.text).toContain("31%");
    expect(a.text).toContain("NIFTY X PE");
  });
  it("while holding, compares the news with the open position's side, not the conviction", () => {
    // A CE is still open after the conviction flipped bearish: the bearish news is against the trade.
    const ce = { contract: { label: "NIFTY 20-OCT-2026 22600 CE", optionType: "CE" }, dominantSource: "TREND" } as unknown as SignalView["position"];
    const against = engineLinkFor("NIFTY", signal({ conviction: -0.3, position: ce, components: [comp("EVENT", -0.4, 0.3), comp("ORB", -0.1, 0.15)] }), [], NOW).answer;
    expect(against).toMatchObject({ kind: "holding_news_against", word: "Holding", tone: "stale" });
    expect(against.text).toBe("The news now leans bearish (EPI −0.40), against the open NIFTY 20-OCT-2026 22600 CE.");
    // A PE with bearish news: same side, but no new entry while it is open.
    const pe = { contract: { label: "NIFTY 20-OCT-2026 22600 PE", optionType: "PE" }, dominantSource: "EVENT" } as unknown as SignalView["position"];
    const withIt = engineLinkFor("NIFTY", signal({ conviction: -0.3, position: pe, components: [comp("EVENT", -0.4, 0.3), comp("ORB", -0.1, 0.15)] }), [], NOW).answer;
    expect(withIt).toMatchObject({ kind: "holding_news_with", word: "Holding", tone: "hold" });
    expect(withIt.text).toBe("The engine already holds NIFTY 20-OCT-2026 22600 PE; news supplies 89% of the current pull, on the same side. No new entry while it is open.");
    for (const a of [against, withIt]) expect(a.word).not.toBe("Yes");
  });
  it("gives conviction 0 its own 'Not yet', without claiming other signals outweigh the news", () => {
    // EVENT is the only voter and its weight is under the engine's minimum, so the score is forced to 0.
    const a = geoTradeAnswer("NIFTY", { kind: "voting", epi: 0.5, weight: 0.24, pull: 0.5, sharePct: 100, sameSide: null }, wait);
    expect(a).toMatchObject({ kind: "news_supports_engine_waits", word: "Not yet", tone: "idle" });
    expect(a.text).toBe(
      "News leans bullish (EPI +0.50), but the engine's conviction is 0: too little signal weight has a view. The engine waits: Conviction too low. It would enter when: Conviction above 0.35.",
    );
    expect(a.text).not.toMatch(/outweigh/);
    const viaLink = engineLinkFor("NIFTY", signal({ conviction: 0, components: [comp("EVENT", 0.5, 0.24)] }), [], NOW).answer;
    expect(viaLink.word).toBe("Not yet");
    expect(viaLink.text).toContain("conviction is 0");
  });
  it("states an abstaining news signal once, with the engine's own notes and no nested brackets", () => {
    const a = geoTradeAnswer("SENSEX", { kind: "abstain", notes: "6 live stories, no net direction (EPI −0.02)", outOfRegime: false }, wait);
    expect(a).toMatchObject({ kind: "news_silent", word: "No" });
    expect(a.text).toBe("The news signal abstains for SENSEX: 6 live stories, no net direction (EPI −0.02).");
    expect(geoTradeAnswer("NIFTY", { kind: "abstain", notes: "no live events.", outOfRegime: false }, wait).text).toBe("The news signal abstains for NIFTY: no live events.");
  });
});

describe("engineLinkFor", () => {
  it("takes the top 3 contributors by |weight| and places them from their title", () => {
    const contributors = [
      { clusterId: "a", title: "RBI holds repo rate", weight: -0.2, ageMin: 30, pricedIn: false, taxonomy: "MACRO_POLICY", ...imp("NIFTY", -0.4) },
      { clusterId: "b", title: "FPIs sell", weight: 0.5, ageMin: 10, pricedIn: false, taxonomy: "FII_FLOWS", ...imp("NIFTY", 0.3) },
      { clusterId: "c", title: "Red Sea attacks", weight: -0.3, ageMin: 5, pricedIn: true, taxonomy: "COMMODITY_SHOCK", ...imp("NIFTY", -0.2) },
      { clusterId: "d", title: "Tiny", weight: 0.01, ageMin: 5, pricedIn: false, taxonomy: "OTHER", ...imp("NIFTY", 0.01) },
    ] as SignalView["contributors"];
    const link = engineLinkFor("NIFTY", signal({ contributors }), [], NOW);
    expect(link.topStories.map((s) => s.clusterId)).toEqual(["b", "c", "a"]);
    expect(link.topStories[1].place?.place.id).toBe("RED_SEA");
    expect(link.topStories[2].place?.via).toBe("institution");
    expect(link.topStories[0].place).toBeNull();
    expect(link.pressure).toEqual({ side: "bullish", band: "strong" });
  });
  it("has no reading without a signal", () => {
    const link = engineLinkFor("SENSEX", null, null, NOW);
    expect(link.answer.kind).toBe("no_reading");
    expect(link.topStories).toEqual([]);
  });
});
