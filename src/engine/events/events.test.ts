import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { HOUR_MS } from "../clock";
import type { ArticleCluster, NormalizedArticle, RawArticle, ScoredEvent } from "../types";
import { clusterArticles, jaccard, mergeClustersByKey, overlapCoefficient } from "./cluster";
import { scoreFallback } from "./fallbackScorer";
import { lexiconPolarity } from "./lexicon";
import { RUBRIC_SYSTEM_PROMPT } from "./llm/rubric";
import { canonicalizeUrl, extractEntities, normalizeArticles, normalizeTitle, shingles, stripPublisherSuffix } from "./normalize";
import { computePressure, coverageWeight, decayFactor } from "./pressure";
import { parseGdeltArtList, parseGdeltDate } from "./sources/gdelt";
import { parseGoogleNewsRss } from "./sources/googleRss";
import { clampHalfLife, toNumeric } from "./taxonomy";
import { clusterParams } from "../pipeline/ingestCycle";

const cfg = DEFAULT_CONFIG;
const params = clusterParams(cfg);
const T0 = Date.parse("2026-10-07T05:00:00Z");

function raw(title: string, minutes = 0, extra: Partial<RawArticle> = {}): RawArticle {
  return {
    source: "google_rss",
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    publishedAt: new Date(T0 + minutes * 60_000).toISOString(),
    ...extra,
  };
}

describe("normalization", () => {
  it("canonicalizes URLs", () => {
    expect(canonicalizeUrl("https://WWW.Example.com/a/b/?utm_source=x&id=7&fbclid=zz#frag")).toBe("https://example.com/a/b/?id=7");
    expect(canonicalizeUrl("https://example.com/story/")).toBe("https://example.com/story");
  });

  it("strips publisher suffixes and normalizes titles", () => {
    expect(stripPublisherSuffix("Sensex down 420 points, Nifty near 22600 - ChiniMandi", "ChiniMandi")).toBe("Sensex down 420 points, Nifty near 22600");
    expect(normalizeTitle("RBI hikes repo rate by 25 bps; Sensex falls 1.2% - Mint", "Mint")).toBe("rbi hikes repo rate by 25 bps sensex falls 1.2%");
  });

  it("builds shingles and entities", () => {
    const s = shingles(normalizeTitle("RBI hikes repo rate by 25 bps as inflation persists"));
    expect(s).toContain("rbi hik repo"); // stemmed: hikes -> hik
    const ents = extractEntities("RBI hikes repo rate by 25 bps; Sensex falls 1.2% as FII selling deepens");
    expect(ents).toEqual(expect.arrayContaining(["rbi", "sensex", "1.2%", "fii"]));
  });

  it("dedupes within a batch by URL and title", async () => {
    const out = await normalizeArticles(
      [raw("Nifty ends lower after RBI hike surprises traders"), raw("Nifty ends lower after RBI hike surprises traders", 1), raw("Short")],
      T0 + HOUR_MS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sources", () => {
  it("parses a real Google News RSS response", () => {
    const xml = readFileSync(new URL("../__fixtures__/events/google-news-nifty.xml", import.meta.url), "utf8");
    const items = parseGoogleNewsRss(xml);
    expect(items.length).toBe(12);
    expect(items[0].publisher).toBe("HDFC Sky");
    expect(items[0].url).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
    expect(Number.isFinite(Date.parse(items[0].publishedAt))).toBe(true);
    expect(items[2].title).toContain("S&P BSE SENSEX");
  });

  it("parses GDELT article lists and dates", () => {
    expect(parseGdeltDate("20261007T101500Z")).toBe("2026-10-07T10:15:00.000Z");
    expect(parseGdeltDate("bad")).toBeNull();
    const arts = parseGdeltArtList({
      articles: [
        { url: "https://a.in/x", title: "RBI raises repo rate", seendate: "20261007T050000Z", domain: "a.in", language: "English", sourcecountry: "India" },
        { url: "https://b.in/y", title: "missing date" },
      ],
    });
    expect(arts).toHaveLength(1);
    expect(arts[0].language).toBe("en");
    expect(parseGdeltArtList({})).toEqual([]);
  });
});

describe("clustering", () => {
  it("measures set similarity", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(overlapCoefficient(["a", "b"], ["a", "b", "c", "d"])).toBe(1);
  });

  it("groups many articles about one story into one cluster", async () => {
    const stems = [
      "RBI hikes repo rate by 25 bps to curb inflation",
      "RBI hikes repo rate by 25 bps, markets fall",
      "RBI raises repo rate by 25 bps in surprise move",
      "RBI MPC hikes repo rate by 25 bps; Sensex falls",
      "Repo rate hiked by 25 bps by RBI as inflation stays high",
      "RBI surprises with 25 bps repo rate hike",
      "Banks slide after RBI repo rate hike of 25 bps",
      "RBI rate hike: repo raised 25 bps, what it means for EMIs",
      "RBI hikes repo rate 25 bps, signals more tightening",
      "Repo rate up 25 bps as RBI turns hawkish",
    ];
    const tails = ["", " today", " analysts react", " key takeaways", " live updates"];
    const rawArticles: RawArticle[] = [];
    stems.forEach((st, i) => tails.forEach((tl, j) => rawArticles.push(raw(`${st}${tl}`, i * 5 + j, { url: `https://news.example/${i}-${j}` }))));
    const arts = await normalizeArticles(rawArticles, T0 + 2 * HOUR_MS);
    expect(arts).toHaveLength(50);
    const other = await normalizeArticles([raw("Brent crude jumps 4% after Red Sea tanker attack", 3)], T0 + 2 * HOUR_MS);
    const { touched, createdIds } = clusterArticles([...arts, ...other], [], params);
    const rbi = touched.filter((c) => c.headlines.some((h) => /repo/i.test(h)));
    expect(rbi).toHaveLength(1);
    expect(rbi[0].articleCount).toBe(50);
    expect(rbi[0].headlines.length).toBeLessThanOrEqual(5);
    expect(createdIds.size).toBe(2);
  });

  it("keeps unrelated stories apart", async () => {
    const arts = await normalizeArticles(
      [
        raw("RBI hikes repo rate by 25 bps to curb inflation"),
        raw("Infosys Q2 profit rises 8%, beats estimates", 5),
        raw("Brent crude jumps 4% after Red Sea tanker attack", 10),
        raw("China unveils fresh stimulus to support property sector", 15),
        raw("US Treasury yields climb as Fed signals higher for longer", 20),
      ],
      T0 + HOUR_MS,
    );
    expect(clusterArticles(arts, [], params).createdIds.size).toBe(5);
  });

  it("clusters the real Google News fixture into a few stories", async () => {
    const xml = readFileSync(new URL("../__fixtures__/events/google-news-nifty.xml", import.meta.url), "utf8");
    const arts = await normalizeArticles(parseGoogleNewsRss(xml), Date.parse("2026-10-07T16:00:00Z"));
    const { touched } = clusterArticles(arts, [], params);
    expect(touched.length).toBeLessThan(arts.length);
    expect(touched.length).toBeGreaterThanOrEqual(2);
  });

  it("attaches to existing clusters without mutating them and flags re-scores", async () => {
    const first = await normalizeArticles([raw("Iran strikes Israeli air base, oil jumps")], T0);
    const { touched } = clusterArticles(first, [], params);
    const scored: ArticleCluster = { ...touched[0], status: "SCORED", scoredArticleCount: 1 };
    const more = await normalizeArticles(
      [1, 2, 3, 4, 5].map((i) => raw(`Iran strikes Israeli air base, oil jumps (${i})`, i * 10, { url: `https://x.example/${i}` })),
      T0 + HOUR_MS,
    );
    const res = clusterArticles(more, [scored], params);
    expect(scored.articleCount).toBe(1);
    expect(res.updatedIds.has(scored.id)).toBe(true);
    expect(res.touched[0].articleCount).toBe(6);
    expect(res.touched[0].status).toBe("RESCORE");
  });

  it("merges clusters that share an LLM story key into the earliest", () => {
    const base = (id: string, first: number, key: string): ArticleCluster => ({
      id,
      key,
      articleIds: [id + "-a"],
      representativeTitle: id,
      headlines: [`headline ${id} about something specific`],
      urls: ["u"],
      firstSeenMs: first,
      lastSeenMs: first,
      articleCount: 3,
      sources: [id],
      status: "SCORED",
    });
    const { merged, removedIds } = mergeClustersByKey([base("c1", 10, "k"), base("c2", 5, "k"), base("c3", 1, "other")], params);
    expect(removedIds).toEqual(["c1"]);
    expect(merged[0].id).toBe("c2");
    expect(merged[0].articleCount).toBe(6);
    expect(merged[0].status).toBe("RESCORE");
  });
});

function event(over: Partial<ScoredEvent> = {}): ScoredEvent {
  const base: Omit<ScoredEvent, "numeric"> = {
    clusterId: "c1",
    clusterKey: "rbi-hike",
    scoredAtMs: T0,
    scorer: "llm",
    version: "rubric-v1",
    taxonomy: "MACRO_POLICY",
    indiaRelevance: "DIRECT",
    isScheduledData: true,
    surprise: "NEGATIVE",
    novelty: "NEW",
    pricedIn: "LOW",
    horizon: "DAYS_1_2",
    halfLifeHours: 4,
    impact: {
      NIFTY: { direction: "BEAR", magnitude: "MODERATE", confidence: "HIGH" },
      SENSEX: { direction: "BEAR", magnitude: "MODERATE", confidence: "HIGH" },
    },
    sectors: [{ sector: "FINANCIALS", direction: "BEAR", weight: "HIGH" }],
    rationale: "Surprise hike",
    firstSeenMs: T0,
    articleCount: 20,
    title: "RBI hikes",
    ...over,
  };
  return { ...base, numeric: { NIFTY: toNumeric(base, "NIFTY"), SENSEX: toNumeric(base, "SENSEX") }, ...over };
}

describe("numeric impact", () => {
  it("maps direction, magnitude and confidence with a sector consistency term", () => {
    const e = event();
    // direct = -0.5 * 0.5 * 0.85 = -0.2125; sector = 0.33 * -0.5 * 1 = -0.165
    expect(e.numeric.NIFTY).toBeCloseTo(0.7 * -0.2125 + 0.3 * -0.165, 6);
    expect(e.numeric.SENSEX).toBeLessThan(e.numeric.NIFTY); // larger financials weight
  });

  it("discounts repeats, priced-in news and irrelevant stories", () => {
    const fresh = event().numeric.NIFTY;
    expect(event({ novelty: "REPEAT" }).numeric.NIFTY).toBeCloseTo(fresh * 0.2, 6);
    expect(event({ pricedIn: "MOSTLY" }).numeric.NIFTY).toBeCloseTo(fresh * 0.15, 6);
    expect(event({ indiaRelevance: "NONE" }).numeric.NIFTY).toBe(0);
  });

  it("clamps the LLM half-life to the taxonomy default ±50%", () => {
    expect(clampHalfLife(100, { taxonomy: "GEOPOLITICAL", isScheduledData: false }, cfg)).toBe(18);
    expect(clampHalfLife(1, { taxonomy: "GEOPOLITICAL", isScheduledData: false }, cfg)).toBe(6);
    expect(clampHalfLife(5, { taxonomy: "MACRO_POLICY", isScheduledData: true }, cfg)).toBe(5);
  });
});

describe("event pressure", () => {
  it("halves after one half-life", () => {
    const e = event({ halfLifeHours: 6 });
    expect(decayFactor(e, T0)).toBe(1);
    expect(decayFactor(e, T0 + 6 * HOUR_MS)).toBeCloseTo(0.5, 10);
    const p0 = computePressure([e], "NIFTY", T0, cfg.events);
    const p1 = computePressure([e], "NIFTY", T0 + 6 * HOUR_MS, cfg.events);
    expect(Math.atanh(p1.epi)).toBeCloseTo(Math.atanh(p0.epi) / 2, 6);
  });

  it("saturates coverage on a log scale", () => {
    // 50 articles weigh ~1.27x as much as 10, not 5x.
    expect(coverageWeight(50, 20) / coverageWeight(10, 20)).toBeCloseTo(1.27, 2);
    expect(coverageWeight(50, 20)).toBe(1);
    expect(coverageWeight(10, 20) / coverageWeight(3, 20)).toBeGreaterThan(1.5);
    expect(coverageWeight(0, 20)).toBe(0);
  });

  it("ignores stale events, stays bounded and ranks contributors", () => {
    const old = event({ clusterId: "old", firstSeenMs: T0 - 200 * HOUR_MS });
    const big = event({ clusterId: "big", impact: { NIFTY: { direction: "STRONG_BULL", magnitude: "EXTREME", confidence: "HIGH" }, SENSEX: { direction: "STRONG_BULL", magnitude: "EXTREME", confidence: "HIGH" } }, sectors: [] });
    const p = computePressure([old, big, big, big, big, event({ clusterId: "small" })], "NIFTY", T0, cfg.events);
    expect(p.activeClusters).toBe(5);
    expect(p.epi).toBeLessThanOrEqual(1);
    expect(p.epi).toBeGreaterThan(0.9);
    expect(p.topContributors[0].clusterId).toBe("big");
  });
});

describe("fallback scorer and rubric", () => {
  it("scores conservatively from keywords", () => {
    const c: ArticleCluster = {
      id: "c9",
      articleIds: ["a"],
      representativeTitle: "Missile attack on tanker in Red Sea sends crude prices sharply higher",
      headlines: ["Missile attack on tanker in Red Sea sends crude prices sharply higher"],
      urls: ["u"],
      firstSeenMs: T0,
      lastSeenMs: T0,
      articleCount: 4,
      sources: ["x"],
      status: "UNSCORED",
    };
    const e = scoreFallback(c, cfg, T0);
    expect(e.scorer).toBe("fallback");
    expect(e.impact.NIFTY.confidence).toBe("LOW");
    expect(e.impact.NIFTY.direction).toBe("BEAR");
    expect(e.numeric.NIFTY).toBeLessThan(0);
    expect(Math.abs(e.numeric.NIFTY)).toBeLessThan(0.15);
  });

  it("treats rising oil as bearish and falling oil as bullish for India", () => {
    expect(lexiconPolarity("Brent crude jumps 4% after Red Sea tanker attack")).toBe(-1);
    expect(lexiconPolarity("Oil prices slump as OPEC+ agrees to raise output")).toBe(1);
    expect(lexiconPolarity("RBI cuts repo rate, Nifty rallies to record high")).toBe(1);
    expect(lexiconPolarity("RBI hikes repo rate by 25 bps")).toBe(-1);
    expect(lexiconPolarity("Markets await RBI decision")).toBe(0);
  });

  it("keeps the rubric long enough to be cached (>= ~1,024 tokens)", () => {
    expect(RUBRIC_SYSTEM_PROMPT.length / 4).toBeGreaterThan(1024);
  });
});

export type { NormalizedArticle };
