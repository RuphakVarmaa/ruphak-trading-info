/** Article normalization: canonical URLs, comparable titles, shingles and entities. */
import type { NormalizedArticle, RawArticle } from "../types";
import { sha256Hex } from "../util/hash";

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ocid$|cmpid$|_ga$|igshid$|ref$|oc$|ito$|src$)/i;

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/" && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim();
  }
}

/** Removes a trailing " - Publisher" / " | Publisher" / " — Publisher" suffix. */
export function stripPublisherSuffix(title: string, publisher?: string): string {
  let t = title.trim();
  if (publisher) {
    const esc = publisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s+[-|–—:]\\s+${esc}\\s*$`, "i"), "");
  }
  // Generic: a short trailing segment after " - " that looks like an outlet name.
  const m = /^(.*\S)\s+[-|–—]\s+([^-|–—]{2,40})$/.exec(t);
  if (m && m[1].length > 25 && m[2].split(/\s+/).length <= 5) t = m[1];
  return t;
}

const STOPWORDS = new Set(
  (
    "a an the and or but if of in on at to for from by with as is are was were be been being it its this that these those " +
    "into over after before about amid than then so not no yes will would can could may might should shall has have had do does did " +
    "says said say new news today live updates update latest report reports why how what when who which here there amid via up down out"
  ).split(" "),
);

/** Lowercase, publisher suffix removed, punctuation stripped, whitespace collapsed. */
export function normalizeTitle(title: string, publisher?: string): string {
  return stripPublisherSuffix(title, publisher)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}%.]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Very light stemmer so "hikes", "hiked" and "hiking" compare equal ("hik"). */
export function stem(w: string): string {
  if (/^\d/.test(w)) return w;
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ied")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Stemmed content words (stopwords and 1-letter tokens removed). */
export function contentTokens(normTitle: string): string[] {
  return normTitle
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** Word 3-grams of content tokens (2-grams or 1-grams for very short titles). */
export function shingles(normTitle: string): string[] {
  const toks = contentTokens(normTitle);
  const n = toks.length >= 3 ? 3 : toks.length >= 2 ? 2 : 1;
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
  return [...out];
}

const ENTITY_LEXICON =
  /\b(rbi|fed|fomc|ecb|boj|pboc|opec|sebi|fii|fpi|dii|gdp|cpi|wpi|pmi|nifty|sensex|bank nifty|rupee|dollar|yuan|crude|brent|oil|gold|repo rate|inflation|tariffs?|sanctions?|ceasefire|missile|war|budget|monsoon|hormuz|red sea|houthi|iran|israel|ukraine|russia|china|taiwan|us|india)\b/gi;

/** Salient tokens for clustering: acronyms, capitalized names, numbers with units, lexicon hits. */
export function extractEntities(title: string): string[] {
  const out = new Set<string>();
  const words = title.split(/\s+/);
  words.forEach((raw, i) => {
    const w = raw.replace(/^[^\p{L}\p{N}₹$]+|[^\p{L}\p{N}%]+$/gu, "");
    if (!w) return;
    if (/^[A-Z]{2,6}$/.test(w)) out.add(w.toLowerCase()); // acronyms: RBI, FII, US
    else if (i > 0 && /^[A-Z][a-z]{2,}/.test(w) && !STOPWORDS.has(w.toLowerCase())) out.add(w.toLowerCase());
    if (/^[₹$]?\d[\d,.]*(%|bps|bp|cr|crore|lakh|bn|billion|mn|million|k)?$/i.test(w) && /\d/.test(w)) out.add(w.toLowerCase().replace(/,/g, ""));
  });
  for (const m of title.matchAll(ENTITY_LEXICON)) out.add(m[0].toLowerCase());
  return [...out];
}

/** Normalizes raw articles, dropping malformed ones and in-batch duplicates (same URL or same title). */
export async function normalizeArticles(raw: RawArticle[], nowMs: number): Promise<NormalizedArticle[]> {
  const out: NormalizedArticle[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  for (const a of raw) {
    const publishedMs = Date.parse(a.publishedAt);
    if (!a.title || !a.url || !Number.isFinite(publishedMs)) continue;
    const canonicalUrl = canonicalizeUrl(a.url);
    const normTitle = normalizeTitle(a.title, a.publisher);
    if (normTitle.length < 12) continue;
    const id = await sha256Hex(canonicalUrl);
    if (seenIds.has(id) || seenTitles.has(normTitle)) continue;
    seenIds.add(id);
    seenTitles.add(normTitle);
    out.push({
      ...a,
      title: stripPublisherSuffix(a.title, a.publisher),
      id,
      canonicalUrl,
      normTitle,
      shingles: shingles(normTitle),
      entities: extractEntities(stripPublisherSuffix(a.title, a.publisher)),
      // Clamp future timestamps (feeds sometimes run ahead) to ingestion time.
      publishedMs: Math.min(publishedMs, nowMs),
      ingestedMs: nowMs,
    });
  }
  return out;
}
