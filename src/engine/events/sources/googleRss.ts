/** Google News RSS search, parsed directly (no rss2json proxy). */
import { XMLParser } from "fast-xml-parser";
import type { RawArticle } from "../../types";
import { BROWSER_UA, fetchText, type FetchLike } from "../../util/http";

export interface GoogleRssOptions {
  fetchImpl?: FetchLike;
  /** Google News "when:" window, e.g. "1d" or "12h". */
  window?: string;
  hl?: string;
  gl?: string;
  ceid?: string;
  timeoutMs?: number;
}

export function googleNewsRssUrl(query: string, opts: GoogleRssOptions = {}): string {
  const q = opts.window ? `${query} when:${opts.window}` : query;
  const params = new URLSearchParams({ q, hl: opts.hl ?? "en-IN", gl: opts.gl ?? "IN", ceid: opts.ceid ?? "IN:en" });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true });

type XmlText = string | { "#text"?: string; "@_url"?: string };

interface RssItem {
  title?: XmlText;
  link?: XmlText;
  pubDate?: XmlText;
  description?: XmlText;
  source?: XmlText;
}

const textOf = (v: XmlText | undefined): string => (typeof v === "string" ? v : v?.["#text"] ?? "");

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses a Google News RSS document into raw articles. Pure. */
export function parseGoogleNewsRss(xml: string): RawArticle[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const items = doc.rss?.channel?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  const out: RawArticle[] = [];
  for (const it of list) {
    const title = textOf(it.title).trim();
    const url = textOf(it.link).trim();
    const pub = textOf(it.pubDate).trim();
    if (!title || !url || !pub || !Number.isFinite(Date.parse(pub))) continue;
    const publisher = textOf(it.source).trim() || undefined;
    const description = stripHtml(textOf(it.description));
    out.push({
      source: "google_rss",
      title,
      description: description && description !== title ? description.slice(0, 300) : undefined,
      url,
      publishedAt: new Date(Date.parse(pub)).toISOString(),
      publisher,
      language: "en",
    });
  }
  return out;
}

export async function fetchGoogleNews(query: string, opts: GoogleRssOptions = {}): Promise<RawArticle[]> {
  const xml = await fetchText(
    opts.fetchImpl ?? fetch,
    googleNewsRssUrl(query, { window: "1d", ...opts }),
    { headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml;q=0.9" } },
    opts.timeoutMs ?? 15_000,
  );
  return parseGoogleNewsRss(xml);
}
