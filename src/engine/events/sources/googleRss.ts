/** Google News RSS search, parsed directly (no rss2json proxy). Google answers Cloudflare Workers with HTTP 503. */
import type { RawArticle } from "../../types";
import { BROWSER_UA, fetchText, type FetchLike } from "../../util/http";
import { parseRssItems } from "./rss";

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

/** Parses a Google News RSS document into raw articles. Pure. */
export function parseGoogleNewsRss(xml: string): RawArticle[] {
  return parseRssItems(xml, "google_rss");
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
