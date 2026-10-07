/**
 * RSS 2.0 parsing shared by Google News search, Bing News search and publisher feeds
 * (Economic Times, Business Standard, Mint, ...). Publisher feeds and Bing answer requests
 * from Cloudflare Workers; Google News answers them with HTTP 503.
 */
import { XMLParser } from "fast-xml-parser";
import type { FeedSpec } from "../../config";
import type { ArticleSource, RawArticle } from "../../types";
import { BROWSER_UA, fetchText, type FetchLike } from "../../util/http";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true });

type XmlText = string | number | { "#text"?: string | number; "@_url"?: string };

interface RssItem {
  title?: XmlText;
  link?: XmlText;
  pubDate?: XmlText;
  "dc:date"?: XmlText;
  description?: XmlText;
  source?: XmlText;
  "News:Source"?: XmlText;
}

const textOf = (v: XmlText | undefined): string => {
  if (v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return v["#text"] === undefined ? "" : String(v["#text"]);
};

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RssParseOptions {
  /** Publisher for items that do not name one (publisher feeds). */
  publisher?: string;
  /** Rewrites item links, e.g. to unwrap redirect URLs. */
  mapLink?: (link: string) => string;
}

/** Parses an RSS 2.0 document into raw articles; items without a title, link or valid date are skipped. Pure. */
export function parseRssItems(xml: string, source: ArticleSource, opts: RssParseOptions = {}): RawArticle[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const items = doc.rss?.channel?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  const out: RawArticle[] = [];
  for (const it of list) {
    const title = textOf(it.title).replace(/\s+/g, " ").trim();
    const link = textOf(it.link).trim();
    const pub = (textOf(it.pubDate) || textOf(it["dc:date"])).trim();
    if (!title || !link || !pub || !Number.isFinite(Date.parse(pub))) continue;
    const publisher = (textOf(it.source) || textOf(it["News:Source"])).trim() || opts.publisher;
    const description = stripHtml(textOf(it.description));
    out.push({
      source,
      title,
      description: description && description !== title ? description.slice(0, 300) : undefined,
      url: opts.mapLink ? opts.mapLink(link) : link,
      publishedAt: new Date(Date.parse(pub)).toISOString(),
      publisher,
      language: "en",
    });
  }
  return out;
}

const RSS_ACCEPT = "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8";

export interface RssFetchOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Fetches one publisher feed. */
export async function fetchRssFeed(feed: FeedSpec, opts: RssFetchOptions = {}): Promise<RawArticle[]> {
  const xml = await fetchText(opts.fetchImpl ?? fetch, feed.url, { headers: { "User-Agent": BROWSER_UA, Accept: RSS_ACCEPT } }, opts.timeoutMs ?? 15_000);
  return parseRssItems(xml, "publisher_rss", { publisher: feed.publisher });
}

/** Bing News RSS search for India, newest first. */
export function bingNewsRssUrl(query: string): string {
  const params = new URLSearchParams({ q: query, format: "rss", mkt: "en-IN", qft: 'sortbydate="1"' });
  return `https://www.bing.com/news/search?${params.toString()}`;
}

/** Bing News links go through apiclick.aspx; the article's own URL is in its `url` parameter. */
export function unwrapBingLink(link: string): string {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith("bing.com") && u.pathname.toLowerCase().includes("apiclick")) {
      const target = u.searchParams.get("url");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch {
    // not a URL: keep it as is
  }
  return link;
}

export async function fetchBingNews(query: string, opts: RssFetchOptions = {}): Promise<RawArticle[]> {
  const xml = await fetchText(opts.fetchImpl ?? fetch, bingNewsRssUrl(query), { headers: { "User-Agent": BROWSER_UA, Accept: RSS_ACCEPT } }, opts.timeoutMs ?? 15_000);
  return parseRssItems(xml, "bing_rss", { mapLink: unwrapBingLink });
}
