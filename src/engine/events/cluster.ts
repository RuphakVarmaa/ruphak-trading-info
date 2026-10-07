/**
 * Story clustering: many articles about one event count once.
 * Layer 1 (exact duplicates) happens in normalize/ingest; this module does layer 2
 * (near-duplicate headlines via shingle Jaccard and entity overlap, union into clusters)
 * and layer 3 (merging clusters the LLM labels with the same story key).
 */
import type { ArticleCluster, NormalizedArticle } from "../types";
import { contentTokens, extractEntities, normalizeTitle, shingles } from "./normalize";

export interface ClusterParams {
  windowHours: number;
  /** Word-trigram Jaccard at or above which two headlines are the same story. */
  jaccardThreshold: number;
  /** Entity overlap coefficient that, together with tokenJaccardFloor, also means "same story". */
  entityOverlapThreshold: number;
  /** Minimum stemmed-token Jaccard required alongside the entity overlap (paraphrase tolerance). */
  entityJaccardFloor: number;
  rescoreAfterNewArticles: number;
  rescoreToneShift: number;
  /** Max article ids kept per cluster (articleCount keeps counting beyond it). */
  maxArticleIds?: number;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of new Set(a)) if (sb.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/** |A ∩ B| / min(|A|, |B|). */
export function overlapCoefficient(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

interface ClusterFeatures {
  headlineShingles: string[][];
  headlineTokens: string[][];
  entities: string[];
}

function featuresOf(c: ArticleCluster): ClusterFeatures {
  const norms = c.headlines.map((h) => normalizeTitle(h));
  return {
    headlineShingles: norms.map((n) => shingles(n)),
    headlineTokens: norms.map((n) => contentTokens(n)),
    entities: [...new Set(c.headlines.flatMap((h) => extractEntities(h)))],
  };
}

export interface Similarity {
  /** Best word-trigram Jaccard against the cluster's headlines. */
  jac: number;
  /** Best stemmed-token Jaccard against the cluster's headlines. */
  tok: number;
  /** Entity overlap coefficient against the cluster's entity set. */
  ent: number;
}

export function similarity(article: Pick<NormalizedArticle, "shingles" | "entities" | "normTitle">, f: ClusterFeatures): Similarity {
  const toks = contentTokens(article.normTitle);
  let jac = 0;
  let tok = 0;
  for (const hs of f.headlineShingles) jac = Math.max(jac, jaccard(article.shingles, hs));
  for (const ht of f.headlineTokens) tok = Math.max(tok, jaccard(toks, ht));
  return { jac, tok, ent: overlapCoefficient(article.entities, f.entities) };
}

export function isMatch(sim: Similarity, p: ClusterParams): boolean {
  return sim.jac >= p.jaccardThreshold || (sim.ent >= p.entityOverlapThreshold && sim.tok >= p.entityJaccardFloor);
}

function addHeadline(c: ArticleCluster, title: string, url: string): void {
  if (c.headlines.length >= 5) return;
  const s = shingles(normalizeTitle(title));
  for (const h of c.headlines) if (jaccard(s, shingles(normalizeTitle(h))) >= 0.8) return;
  c.headlines.push(title);
  c.urls.push(url);
}

function addArticle(c: ArticleCluster, a: NormalizedArticle, p: ClusterParams): void {
  const maxIds = p.maxArticleIds ?? 200;
  if (c.articleIds.includes(a.id)) return;
  c.articleIds.push(a.id);
  if (c.articleIds.length > maxIds) c.articleIds.splice(0, c.articleIds.length - maxIds);
  c.articleCount += 1;
  c.firstSeenMs = Math.min(c.firstSeenMs, a.publishedMs);
  c.lastSeenMs = Math.max(c.lastSeenMs, a.publishedMs);
  const src = a.publisher ?? a.source;
  if (src && !c.sources.includes(src) && c.sources.length < 20) c.sources.push(src);
  if (typeof a.tone === "number" && Number.isFinite(a.tone)) {
    const n = c.toneN ?? 0;
    c.toneMean = ((c.toneMean ?? 0) * n + a.tone) / (n + 1);
    c.toneN = n + 1;
  }
  addHeadline(c, a.title, a.url);
  if (c.status === "SCORED") {
    const grown = c.articleCount - (c.scoredArticleCount ?? c.articleCount);
    const toneShift =
      c.toneMean !== undefined && c.scoredToneMean !== undefined ? Math.abs(c.toneMean - c.scoredToneMean) : 0;
    if (grown >= p.rescoreAfterNewArticles || toneShift >= p.rescoreToneShift) c.status = "RESCORE";
  }
}

function newCluster(a: NormalizedArticle, locationName?: string): ArticleCluster {
  return {
    id: `c_${a.id.slice(0, 20)}`,
    articleIds: [a.id],
    representativeTitle: a.title,
    headlines: [a.title],
    urls: [a.url],
    firstSeenMs: a.publishedMs,
    lastSeenMs: a.publishedMs,
    articleCount: 1,
    toneMean: typeof a.tone === "number" ? a.tone : undefined,
    toneN: typeof a.tone === "number" ? 1 : 0,
    sources: [a.publisher ?? a.source],
    status: "UNSCORED",
    locationName,
  };
}

export interface ClusterResult {
  /** Every cluster that was created or changed (deep copies). */
  touched: ArticleCluster[];
  createdIds: Set<string>;
  updatedIds: Set<string>;
}

/**
 * Assigns fresh articles to existing clusters or new ones. Existing clusters are not mutated;
 * modified copies are returned in `touched`.
 */
export function clusterArticles(
  fresh: NormalizedArticle[],
  existing: ArticleCluster[],
  p: ClusterParams,
  locate?: (title: string) => string | undefined,
): ClusterResult {
  const clusters = new Map<string, ArticleCluster>();
  const feats = new Map<string, ClusterFeatures>();
  const index = new Map<string, Set<string>>(); // shingle/entity token -> cluster ids
  const indexCluster = (c: ArticleCluster) => {
    const f = featuresOf(c);
    feats.set(c.id, f);
    for (const hs of f.headlineShingles) for (const s of hs) (index.get(`s:${s}`) ?? index.set(`s:${s}`, new Set()).get(`s:${s}`)!).add(c.id);
    for (const e of f.entities) (index.get(`e:${e}`) ?? index.set(`e:${e}`, new Set()).get(`e:${e}`)!).add(c.id);
  };
  for (const c of existing) {
    clusters.set(c.id, structuredClone(c));
    indexCluster(clusters.get(c.id)!);
  }
  const createdIds = new Set<string>();
  const updatedIds = new Set<string>();
  const windowMs = p.windowHours * 3_600_000;

  for (const a of [...fresh].sort((x, y) => x.publishedMs - y.publishedMs)) {
    const candidates = new Set<string>();
    for (const s of a.shingles) for (const id of index.get(`s:${s}`) ?? []) candidates.add(id);
    for (const e of a.entities) for (const id of index.get(`e:${e}`) ?? []) candidates.add(id);
    let best: { id: string; jac: number } | null = null;
    for (const id of candidates) {
      const c = clusters.get(id)!;
      if (a.publishedMs - c.lastSeenMs > windowMs || c.firstSeenMs - a.publishedMs > windowMs) continue;
      const sim = similarity(a, feats.get(id)!);
      if (isMatch(sim, p) && (!best || sim.jac > best.jac)) best = { id, jac: sim.jac };
    }
    if (best) {
      const c = clusters.get(best.id)!;
      const before = c.headlines.length;
      addArticle(c, a, p);
      if (c.headlines.length !== before) indexCluster(c);
      if (!createdIds.has(c.id)) updatedIds.add(c.id);
    } else {
      const c = newCluster(a, locate?.(a.title));
      if (clusters.has(c.id)) continue; // same seed article already clustered
      clusters.set(c.id, c);
      indexCluster(c);
      createdIds.add(c.id);
    }
  }
  const touched = [...createdIds, ...updatedIds].map((id) => clusters.get(id)!);
  return { touched, createdIds, updatedIds };
}

/**
 * Merges clusters that share an LLM-assigned story key into the earliest one.
 * Returns the surviving (changed) clusters and the ids that were absorbed.
 */
export function mergeClustersByKey(clusters: ArticleCluster[], p: ClusterParams): { merged: ArticleCluster[]; removedIds: string[] } {
  const byKey = new Map<string, ArticleCluster[]>();
  for (const c of clusters) if (c.key) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)!).push(c);
  const merged: ArticleCluster[] = [];
  const removedIds: string[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.firstSeenMs - b.firstSeenMs);
    const primary = structuredClone(group[0]);
    for (const other of group.slice(1)) {
      for (let i = 0; i < other.headlines.length; i++) addHeadline(primary, other.headlines[i], other.urls[i] ?? "");
      for (const id of other.articleIds) if (!primary.articleIds.includes(id)) primary.articleIds.push(id);
      primary.articleCount += other.articleCount;
      primary.firstSeenMs = Math.min(primary.firstSeenMs, other.firstSeenMs);
      primary.lastSeenMs = Math.max(primary.lastSeenMs, other.lastSeenMs);
      for (const s of other.sources) if (!primary.sources.includes(s) && primary.sources.length < 20) primary.sources.push(s);
      if (other.toneN) {
        const n = primary.toneN ?? 0;
        primary.toneMean = ((primary.toneMean ?? 0) * n + (other.toneMean ?? 0) * other.toneN) / (n + other.toneN);
        primary.toneN = n + other.toneN;
      }
      removedIds.push(other.id);
    }
    const maxIds = p.maxArticleIds ?? 200;
    if (primary.articleIds.length > maxIds) primary.articleIds.splice(0, primary.articleIds.length - maxIds);
    // The merged story has more coverage than its last score saw: score it again.
    primary.status = "RESCORE";
    merged.push(primary);
  }
  return { merged, removedIds };
}
