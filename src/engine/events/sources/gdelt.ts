/**
 * GDELT DOC 2.0 article search. Free, no key, but limited to one request per 5 seconds per IP;
 * from shared egress IPs (Cloudflare, cloud sandboxes) it often answers 429. Callers must
 * space requests (IngestDO does) and treat failures as non-fatal.
 */
import type { RawArticle } from "../../types";
import { BROWSER_UA, fetchWithTimeout, HttpError, type FetchLike } from "../../util/http";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

/** "20261007T101500Z" -> ISO string. */
export function parseGdeltDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

export function parseGdeltArtList(json: unknown): RawArticle[] {
  const arts = (json as { articles?: GdeltArticle[] } | null)?.articles ?? [];
  const out: RawArticle[] = [];
  for (const a of arts) {
    const publishedAt = a.seendate ? parseGdeltDate(a.seendate) : null;
    if (!a.url || !a.title || !publishedAt) continue;
    out.push({
      source: "gdelt",
      title: a.title.trim(),
      url: a.url,
      publishedAt,
      publisher: a.domain,
      sourceCountry: a.sourcecountry,
      language: a.language?.toLowerCase().startsWith("english") ? "en" : a.language,
    });
  }
  return out;
}

export interface GdeltOptions {
  fetchImpl?: FetchLike;
  timespan?: string;
  maxRecords?: number;
  /** Absolute window instead of timespan, as YYYYMMDDHHMMSS (UTC). */
  startDateTime?: string;
  endDateTime?: string;
  timeoutMs?: number;
}

export function gdeltArtListUrl(query: string, opts: GdeltOptions = {}): string {
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    sort: "datedesc",
    maxrecords: String(opts.maxRecords ?? 75),
  });
  if (opts.startDateTime && opts.endDateTime) {
    params.set("startdatetime", opts.startDateTime);
    params.set("enddatetime", opts.endDateTime);
  } else {
    params.set("timespan", opts.timespan ?? "1h");
  }
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

export async function fetchGdeltArticles(query: string, opts: GdeltOptions = {}): Promise<RawArticle[]> {
  const res = await fetchWithTimeout(
    opts.fetchImpl ?? fetch,
    gdeltArtListUrl(query, opts),
    { headers: { "User-Agent": BROWSER_UA } },
    opts.timeoutMs ?? 20_000,
  );
  const text = await res.text();
  // GDELT answers rate limiting with HTTP 429 or a 200 plain-text notice.
  if (!res.ok || !text.trimStart().startsWith("{")) {
    throw new HttpError(`GDELT ${res.status}: ${text.slice(0, 120)}`, res.ok ? 429 : res.status, text.slice(0, 300));
  }
  // An empty result is "{}".
  return parseGdeltArtList(JSON.parse(text));
}
