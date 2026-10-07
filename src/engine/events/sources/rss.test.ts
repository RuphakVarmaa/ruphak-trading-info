import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config";
import { InMemoryRepository } from "../../repo/memory";
import { buildFetchers } from "./index";
import { bingNewsRssUrl, parseRssItems, unwrapBingLink } from "./rss";

const T0 = Date.parse("2026-10-07T12:00:00Z");

// Shapes seen in the live feeds: CDATA everywhere (Mint, BusinessLine, NDTV Profit),
// a plain link (Business Standard), padding after CDATA (Economic Times).
const PUBLISHER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Markets</title>
<item><title><![CDATA[RBI hikes repo rate by 25 bps; Sensex falls 429 points]]></title>
  <link><![CDATA[https://www.livemint.com/market/stock-market-news/rbi-hike-11791392672814.html]]></link>
  <description><![CDATA[<p>The central bank raised rates for the first time in nearly four years.</p>]]></description>
  <pubDate><![CDATA[Wed, 07 Oct 2026 11:17:06 +0530]]></pubDate></item>
<item><title><![CDATA[Nifty ends lower as FPIs sell]]> </title>
  <link>https://www.business-standard.com/markets/news/nifty-ends-lower-126100701182_1.html</link>
  <dc:date>2026-10-07T10:30:00+05:30</dc:date></item>
<item><title><![CDATA[No date on this one]]></title><link>https://example.com/a</link></item>
<item><title></title><link>https://example.com/b</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0530</pubDate></item>
</channel></rss>`;

const BING_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=Nifty&amp;format=rss"><channel><title>Nifty - BingNews</title>
<item><title>Sensex, Nifty trim losses as RBI hike lifts banks</title>
  <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=https%3a%2f%2fwww.cnbctv18.com%2fmarket%2fsensex-nifty-rbi-20006155.htm&amp;c=799&amp;mkt=en-in</link>
  <description>The Reserve Bank of India raised the repo rate ...</description>
  <pubDate>Wed, 07 Oct 2026 04:50:00 GMT</pubDate>
  <News:Source>CNBCTV18</News:Source></item>
</channel></rss>`;

describe("RSS parsing", () => {
  it("reads publisher feeds with CDATA, plain links and dc:date, and skips unusable items", () => {
    const items = parseRssItems(PUBLISHER_XML, "publisher_rss", { publisher: "Mint" });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "publisher_rss",
      title: "RBI hikes repo rate by 25 bps; Sensex falls 429 points",
      url: "https://www.livemint.com/market/stock-market-news/rbi-hike-11791392672814.html",
      publishedAt: "2026-10-07T05:47:06.000Z",
      publisher: "Mint",
      description: "The central bank raised rates for the first time in nearly four years.",
    });
    expect(items[1].title).toBe("Nifty ends lower as FPIs sell");
    expect(items[1].publishedAt).toBe("2026-10-07T05:00:00.000Z");
    expect(items[1].description).toBeUndefined();
  });

  it("reads Bing News items, unwrapping the redirect link and naming the publisher", () => {
    const [item] = parseRssItems(BING_XML, "bing_rss", { mapLink: unwrapBingLink });
    expect(item.url).toBe("https://www.cnbctv18.com/market/sensex-nifty-rbi-20006155.htm");
    expect(item.publisher).toBe("CNBCTV18");
    expect(item.publishedAt).toBe("2026-10-07T04:50:00.000Z");
  });

  it("leaves links that are not Bing redirects alone", () => {
    expect(unwrapBingLink("https://www.livemint.com/x.html")).toBe("https://www.livemint.com/x.html");
    expect(unwrapBingLink("http://www.bing.com/news/apiclick.aspx?url=javascript%3aalert(1)")).toBe("http://www.bing.com/news/apiclick.aspx?url=javascript%3aalert(1)");
    expect(unwrapBingLink("not a url")).toBe("not a url");
  });

  it("asks Bing for India results, newest first", () => {
    const u = new URL(bingNewsRssUrl("RBI policy"));
    expect(u.searchParams.get("format")).toBe("rss");
    expect(u.searchParams.get("mkt")).toBe("en-IN");
    expect(u.searchParams.get("qft")).toBe('sortbydate="1"');
  });
});

describe("buildFetchers", () => {
  const clock = { now: () => T0, sleep: async () => {} };

  function recorder(fail: (url: string) => boolean = () => false) {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (fail(url)) return new Response("busy", { status: 503 });
      return new Response(url.includes("bing.com") ? BING_XML : PUBLISHER_XML, { status: 200 });
    };
    return { urls, fetchImpl };
  }

  it("polls publisher feeds and Bing, and skips Google News when asked", () => {
    const state = new InMemoryRepository(DEFAULT_CONFIG, T0).state;
    const names = buildFetchers({ cfg: DEFAULT_CONFIG, clock, state, googleNews: false, gdelt: false }).map((f) => f.name);
    expect(names).toEqual(["publisher_rss", "bing_rss"]);
    const all = buildFetchers({ cfg: DEFAULT_CONFIG, clock, state, gnewsApiKey: "k" }).map((f) => f.name);
    expect(all).toEqual(["publisher_rss", "bing_rss", "google_rss", "gnews", "gdelt"]);
  });

  it("polls only the boost feeds and the first Bing queries on boost cycles", async () => {
    const state = new InMemoryRepository(DEFAULT_CONFIG, T0).state;
    const { urls, fetchImpl } = recorder();
    const fetchers = buildFetchers({ cfg: DEFAULT_CONFIG, clock, state, fetchImpl, googleNews: false, gdelt: false, boost: true });
    for (const f of fetchers) await f.fetch();
    const boostFeeds = DEFAULT_CONFIG.ingest.feeds.filter((f) => f.boost).map((f) => f.url);
    expect(boostFeeds.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.includes("bing.com")).sort()).toEqual([...boostFeeds].sort());
    expect(urls.filter((u) => u.includes("bing.com"))).toHaveLength(2);
  });

  it("keeps the feeds that answered and fails only when all of them fail", async () => {
    const state = new InMemoryRepository(DEFAULT_CONFIG, T0).state;
    const firstFeed = DEFAULT_CONFIG.ingest.feeds[0].url;
    const partial = recorder((u) => u === firstFeed);
    const [publisher] = buildFetchers({ cfg: DEFAULT_CONFIG, clock, state, fetchImpl: partial.fetchImpl, googleNews: false, gdelt: false });
    const items = await publisher.fetch();
    expect(items.length).toBe((DEFAULT_CONFIG.ingest.feeds.length - 1) * 2);

    const down = recorder(() => true);
    const [failing] = buildFetchers({ cfg: DEFAULT_CONFIG, clock, state, fetchImpl: down.fetchImpl, googleNews: false, gdelt: false });
    await expect(failing.fetch()).rejects.toThrow(/all 9 publisher feeds failed/);
  });
});
