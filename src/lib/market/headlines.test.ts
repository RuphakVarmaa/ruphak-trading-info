import { beforeEach, describe, expect, it } from "vitest";
import type { RawArticle } from "@/engine/types";
import { __resetHeadlineCacheForTests, fetchHeadlineFeed, HEADLINE_QUERIES, toIntelItems } from "./headlines";

const NOW = Date.parse("2026-10-08T18:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const art = (title: string, url: string, agoMs: number, extra: Partial<RawArticle> = {}): RawArticle => ({
  source: "bing_rss",
  title,
  url,
  publishedAt: new Date(NOW - agoMs).toISOString(),
  ...extra,
});

describe("toIntelItems", () => {
  it("classifies each article on its title and description", () => {
    const [hormuz, gold] = toIntelItems(
      [
        art("Tanker attacked in the Strait of Hormuz", "https://example.com/hormuz", 1 * HOUR, { publisher: "Reuters", description: "Iran threatens tanker routes" }),
        art("Gold slips as the dollar firms", "https://example.com/gold", 2 * HOUR),
      ],
      NOW,
    );
    expect(hormuz).toMatchObject({
      title: "Tanker attacked in the Strait of Hormuz",
      description: "Iran threatens tanker routes",
      source: "Reuters",
      url: "https://example.com/hormuz",
      publishedAt: new Date(NOW - HOUR).toISOString(),
      category: "MARITIME",
      severity: "FLASH",
      tags: ["Geopolitics"],
      location: { name: "Strait of Hormuz", lat: 26.5, lng: 56.3 },
    });
    expect(gold).toMatchObject({ description: "", source: "Bing News", category: "MINING", severity: "UPDATE", tags: ["Gold", "USD"] });
    expect(hormuz.id).toMatch(/^bing-[0-9a-f]{8}$/);
    expect(toIntelItems([art("Again", "https://example.com/hormuz", HOUR)], NOW)[0].id).toBe(hormuz.id);
    expect(gold.id).not.toBe(hormuz.id);
  });

  it("keeps the earliest copy of a story, matching titles with and without a trailing publisher", () => {
    const items = toIntelItems(
      [
        art("Gold slips as the dollar firms - Reuters", "https://msn.com/copy", 1 * HOUR, { publisher: "Reuters on MSN" }),
        art("Gold  slips as the DOLLAR firms", "https://reuters.com/original", 3 * HOUR, { publisher: "Reuters" }),
        art("Gold rate today - Delhi", "https://example.com/delhi", 2 * HOUR, { publisher: "Times of India" }),
        art("Gold rate today - Mumbai", "https://example.com/mumbai", 2 * HOUR, { publisher: "Times of India" }),
        art("Same link, other title", "https://example.com/delhi", 90 * MIN),
      ],
      NOW,
    );
    expect(items.map((i) => i.url)).toEqual(["https://example.com/delhi", "https://example.com/mumbai", "https://reuters.com/original"]);
    expect(items[0].title).toBe("Gold rate today - Delhi");
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("keeps the last 7 days, allows an hour of clock skew, sorts newest first and caps at 80", () => {
    const items = toIntelItems(
      [
        art("Eight days old", "https://example.com/old", 8 * 24 * HOUR),
        art("Two hours ahead", "https://example.com/ahead", -2 * HOUR),
        art("Half an hour ahead", "https://example.com/skew", -30 * MIN),
        art("Six days old", "https://example.com/week", 6 * 24 * HOUR),
        art("Bad date", "https://example.com/bad", 0, { publishedAt: "not a date" }),
      ],
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(["Half an hour ahead", "Six days old"]);

    const many = Array.from({ length: 100 }, (_, i) => art(`Story ${i}`, `https://example.com/${i}`, i * MIN));
    const capped = toIntelItems(many, NOW);
    expect(capped).toHaveLength(80);
    expect(capped[0].title).toBe("Story 0");
    expect(capped[79].title).toBe("Story 79");
  });
});

/** A Bing News RSS document, items published `ago` ms before NOW. */
function bingRss(items: { title: string; url: string; ago: number; source?: string }[]): string {
  const xmlItems = items
    .map(
      (it) =>
        `<item><title>${it.title}</title>` +
        `<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=${encodeURIComponent(it.url)}&amp;c=1&amp;mkt=en-us</link>` +
        `<description>${it.title} and more</description>` +
        `<pubDate>${new Date(NOW - it.ago).toUTCString()}</pubDate>` +
        (it.source ? `<News:Source>${it.source}</News:Source>` : "") +
        `</item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=x&amp;format=rss"><channel><title>x - BingNews</title>${xmlItems}</channel></rss>`;
}

const EMPTY_HTML = '<!DOCTYPE html><html><head><title>Bing</title></head><body></body></html>';

/**
 * Fake Bing: "Panama Canal" answers 503, "Taiwan Strait" an empty HTML page, and "Black Sea shipping"
 * redirects (307 + cookies) to a page that serves the RSS only when the BN cookie comes back.
 */
function fakeBing(opts: { down?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const q = url.searchParams.get("q") ?? "";
    if (opts.down || q === "Panama Canal") return new Response("busy", { status: 503 });
    if (q === "Taiwan Strait") return new Response(EMPTY_HTML, { status: 200 });
    if (q === "Black Sea shipping" && url.searchParams.get("brdr") !== "1") {
      const target = new URL(url);
      target.searchParams.set("brdr", "1");
      const headers = new Headers({ location: target.toString() });
      headers.append("set-cookie", "MUID=m1; domain=.bing.com; expires=Tue, 02-Nov-2027 18:47:29 GMT; path=/; secure");
      headers.append("set-cookie", "BN=token; domain=.bing.com; path=/; secure; HttpOnly");
      return new Response(null, { status: 307, headers });
    }
    if (q === "Black Sea shipping" && !new Headers(init?.headers).get("cookie")?.includes("BN=token")) return new Response(EMPTY_HTML, { status: 200 });
    const story = (n: number) => ({ title: `${q} story ${n}`, url: `https://news.example/${encodeURIComponent(q)}/${n}`, ago: n * HOUR, source: "Wire" });
    const shared = { title: "Gold and silver slide as the dollar firms", url: "https://news.example/shared", ago: 30 * MIN, source: "Reuters" };
    return new Response(bingRss([story(1), story(2), ...(q.includes("price") ? [shared] : [])]), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("fetchHeadlineFeed", () => {
  beforeEach(() => __resetHeadlineCacheForTests());

  it("searches Bing (en-US) for every query, follows its cookie redirect and lists the queries that failed", async () => {
    const bing = fakeBing();
    const feed = (await fetchHeadlineFeed({ fetchImpl: bing.fetchImpl, nowMs: NOW }))!;
    const asked = bing.calls.filter((c) => c.url.includes("bing.com/news/search"));
    expect(new Set(asked.map((c) => new URL(c.url).searchParams.get("q")))).toEqual(new Set(HEADLINE_QUERIES));
    expect(asked.every((c) => new URL(c.url).searchParams.get("mkt") === "en-US" && c.init?.redirect === "manual")).toBe(true);
    expect(feed.failedQueries).toEqual(["Taiwan Strait", "Panama Canal"]);
    expect(feed.stale).toBe(false);
    expect(feed.generatedAt).toBe(new Date(NOW).toISOString());
    // 8 queries answered with 2 stories each, plus one story shared by both price queries.
    expect(feed.items).toHaveLength(17);
    expect(feed.items[0]).toMatchObject({ title: "Gold and silver slide as the dollar firms", source: "Reuters", url: "https://news.example/shared", tags: ["Gold", "Silver", "USD"] });
    expect(feed.items.some((i) => i.title === "Black Sea shipping story 1" && i.location?.name === "Black Sea")).toBe(true);
    expect(feed.items.map((i) => Date.parse(i.publishedAt))).toEqual([...feed.items.map((i) => Date.parse(i.publishedAt))].sort((a, b) => b - a));
  });

  it("caches a feed for 10 minutes and serves it as stale for up to an hour when Bing fails", async () => {
    const ok = fakeBing();
    const first = (await fetchHeadlineFeed({ fetchImpl: ok.fetchImpl, nowMs: NOW }))!;
    const callsAfterFirst = ok.calls.length;
    expect(await fetchHeadlineFeed({ fetchImpl: ok.fetchImpl, nowMs: NOW + 9 * MIN })).toBe(first);
    expect(ok.calls).toHaveLength(callsAfterFirst);

    const down = fakeBing({ down: true });
    const stale = (await fetchHeadlineFeed({ fetchImpl: down.fetchImpl, nowMs: NOW + 11 * MIN }))!;
    expect(down.calls.length).toBe(HEADLINE_QUERIES.length);
    expect(stale.stale).toBe(true);
    expect(stale.items).toEqual(first.items);
    expect(stale.generatedAt).toBe(first.generatedAt);
    expect(stale.failedQueries).toEqual(HEADLINE_QUERIES);
    expect(await fetchHeadlineFeed({ fetchImpl: down.fetchImpl, nowMs: NOW + 61 * MIN })).toBeNull();
  });

  it("returns null when every query fails and there is no earlier feed", async () => {
    expect(await fetchHeadlineFeed({ fetchImpl: fakeBing({ down: true }).fetchImpl, nowMs: NOW })).toBeNull();
  });
});
