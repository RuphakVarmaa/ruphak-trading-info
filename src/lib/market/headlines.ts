/**
 * Metals, oil and shipping-lane headlines for the metals terminal, from Bing News RSS. Google News
 * answers Cloudflare Workers with HTTP 503; Bing answers them.
 *
 * Bing redirects some requests (HTTP 307 to the same URL plus `brdr=1`) and sets MUID/BN cookies;
 * the redirect target serves the RSS only when those cookies come back. fetch keeps no cookie jar, so a
 * plainly followed redirect ends on an empty HTML page (8 of 10 queries in one live run). `bingFetch`
 * follows the redirect with the cookies and reports a body that is not RSS as a failed query.
 */
import { extractLocation } from "@/engine/events/geo";
import { classifyCategory, classifySeverity, extractTags } from "@/engine/events/lexicon";
import { fetchBingNews } from "@/engine/events/sources/rss";
import type { RawArticle } from "@/engine/types";
import { fnv1aHex } from "@/engine/util/hash";
import type { FetchLike } from "@/engine/util/http";
import type { IntelItem } from "@/utils/api";

export interface HeadlineFeed {
  /** Newest first. */
  items: IntelItem[];
  generatedAt: string;
  /** Queries that failed in the latest refresh (HTTP error, timeout or a page that is not RSS). */
  failedQueries: string[];
  /** True when the refresh loaded nothing and these are the previous headlines (see generatedAt). */
  stale: boolean;
}

export const HEADLINE_QUERIES: string[] = [
  "gold price",
  "silver price",
  "copper supply mining",
  "crude oil OPEC Brent",
  "Strait of Hormuz",
  "Red Sea Houthi shipping",
  "Suez Canal shipping",
  "Taiwan Strait",
  "Black Sea shipping",
  "Panama Canal",
];

/**
 * Bing market for these global queries. Against en-IN (2026-10-08, ~12 items per query either way):
 * en-US brings more trade and commodity press (OilPrice.com, Rigzone, Seatrade, TradeWinds, Seeking Alpha)
 * and fewer city-by-city Indian jewellery-rate pages.
 */
export const HEADLINE_MARKET = "en-US";

const HOUR_MS = 3_600_000;
const MAX_AGE_MS = 7 * 24 * HOUR_MS;
const MAX_FUTURE_MS = HOUR_MS;
const MAX_ITEMS = 80;
const QUERY_TIMEOUT_MS = 8000;
/** One Bing refresh per 10 minutes per isolate. */
const FRESH_MS = 10 * 60_000;
/** When a refresh loads nothing, the previous headlines are served for up to an hour, marked stale. */
const STALE_OK_MS = 60 * 60_000;
const MAX_REDIRECTS = 3;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Dedupe key: lowercased title with whitespace collapsed and a trailing " - Publisher" removed. */
function titleKey(title: string, publisher: string | undefined): string {
  const t = squash(title);
  const pub = publisher ? squash(publisher) : "";
  const m = /^(.*\S)\s+[-–—|]\s+([^-–—|]+)$/.exec(t);
  // "Reuters" also matches "Reuters on MSN" and the other way round.
  if (m && pub && (pub.startsWith(m[2]) || m[2].startsWith(pub))) return m[1];
  return t;
}

/**
 * Raw Bing articles -> intel items: classified on title + description, deduplicated by title (the
 * earliest copy of a story is kept), only the last 7 days (nothing dated over an hour ahead),
 * newest first, at most 80. Ids are a hash of the URL. Pure.
 */
export function toIntelItems(articles: RawArticle[], nowMs: number): IntelItem[] {
  const dated: { ms: number; a: RawArticle }[] = [];
  for (const a of articles) {
    const ms = Date.parse(a.publishedAt);
    if (!a.title.trim() || !a.url || !Number.isFinite(ms)) continue;
    if (ms < nowMs - MAX_AGE_MS || ms > nowMs + MAX_FUTURE_MS) continue;
    dated.push({ ms, a });
  }
  dated.sort((x, y) => x.ms - y.ms || cmp(x.a.url, y.a.url));

  const kept: { ms: number; item: IntelItem }[] = [];
  const seenTitles = new Set<string>();
  const seenIds = new Set<string>();
  for (const { ms, a } of dated) {
    const title = a.title.replace(/\s+/g, " ").trim();
    const key = titleKey(title, a.publisher);
    const id = `bing-${fnv1aHex(a.url)}`;
    if (seenTitles.has(key) || seenIds.has(id)) continue;
    seenTitles.add(key);
    seenIds.add(id);
    const description = a.description ?? "";
    const text = `${title} ${description}`;
    kept.push({
      ms,
      item: {
        id,
        title,
        description,
        source: a.publisher || "Bing News",
        url: a.url,
        publishedAt: new Date(ms).toISOString(),
        category: classifyCategory(text),
        severity: classifySeverity(text),
        tags: extractTags(text),
        location: extractLocation(text),
      },
    });
  }
  return kept
    .sort((x, y) => y.ms - x.ms || cmp(x.item.url, y.item.url))
    .slice(0, MAX_ITEMS)
    .map((k) => k.item);
}

function setCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const joined = headers.get("set-cookie");
  return joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

/** fetch for Bing News: follows redirects itself, carrying the cookies they set, and fails on a body that is not RSS. */
function bingFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init = {}) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cookies = new Map<string, string>();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await fetchImpl(url, { ...init, headers, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        for (const c of setCookies(res.headers)) {
          const pair = c.split(";")[0];
          const eq = pair.indexOf("=");
          if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        url = new URL(location, url).toString();
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) return res;
      const body = await res.text();
      if (!/<rss[\s>]/i.test(body)) return new Response(`Bing News answered without RSS: ${body.slice(0, 120)}`, { status: 502 });
      return new Response(body, { status: res.status });
    }
    return new Response(`Bing News redirected more than ${MAX_REDIRECTS} times`, { status: 502 });
  };
}

let cache: { at: number; feed: HeadlineFeed } | null = null;

/** Clears this module's headline cache (tests only). */
export function __resetHeadlineCacheForTests(): void {
  cache = null;
}

/**
 * Headlines for every query, refreshed at most every 10 minutes; queries run in parallel and the ones
 * that fail are listed. When a refresh loads no headlines, the previous feed (up to an hour old) comes
 * back with `stale: true`; else null.
 */
export async function fetchHeadlineFeed(opts: { fetchImpl?: typeof fetch; nowMs?: number } = {}): Promise<HeadlineFeed | null> {
  const nowMs = opts.nowMs ?? Date.now();
  if (cache && nowMs - cache.at < FRESH_MS) return cache.feed;

  const fetchImpl = bingFetch(opts.fetchImpl ?? fetch);
  const results = await Promise.allSettled(
    HEADLINE_QUERIES.map((q) => fetchBingNews(q, { fetchImpl, market: HEADLINE_MARKET, timeoutMs: QUERY_TIMEOUT_MS })),
  );
  const failedQueries = HEADLINE_QUERIES.filter((_, i) => results[i].status === "rejected");
  const items = toIntelItems(
    results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    nowMs,
  );

  if (items.length === 0) {
    if (cache && nowMs - cache.at < STALE_OK_MS) return { ...cache.feed, failedQueries, stale: true };
    return null;
  }
  const feed: HeadlineFeed = { items, generatedAt: new Date(nowMs).toISOString(), failedQueries, stale: false };
  cache = { at: nowMs, feed };
  return feed;
}
