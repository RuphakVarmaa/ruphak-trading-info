/** GNews.io search API (optional; needs GNEWS_API_KEY). */
import type { RawArticle } from "../../types";
import { fetchText, type FetchLike } from "../../util/http";

interface GNewsArticle {
  title?: string;
  description?: string;
  url?: string;
  publishedAt?: string;
  source?: { name?: string; url?: string };
}

export function parseGNews(json: unknown): RawArticle[] {
  const articles = (json as { articles?: GNewsArticle[] } | null)?.articles ?? [];
  const out: RawArticle[] = [];
  for (const a of articles) {
    if (!a.title || !a.url || !a.publishedAt || !Number.isFinite(Date.parse(a.publishedAt))) continue;
    out.push({
      source: "gnews",
      title: a.title.trim(),
      description: a.description?.trim() || undefined,
      url: a.url,
      publishedAt: new Date(Date.parse(a.publishedAt)).toISOString(),
      publisher: a.source?.name,
      language: "en",
    });
  }
  return out;
}

export async function fetchGNews(
  query: string,
  apiKey: string,
  opts: { fetchImpl?: FetchLike; max?: number; fromIso?: string; timeoutMs?: number } = {},
): Promise<RawArticle[]> {
  const params = new URLSearchParams({ q: query, lang: "en", max: String(opts.max ?? 10), apikey: apiKey, sortby: "publishedAt" });
  if (opts.fromIso) params.set("from", opts.fromIso);
  const text = await fetchText(opts.fetchImpl ?? fetch, `https://gnews.io/api/v4/search?${params.toString()}`, {}, opts.timeoutMs ?? 15_000);
  return parseGNews(JSON.parse(text));
}
