/**
 * Builds historical story clusters for backtests from the GDELT DOC API: crawls each configured
 * query in 6-hour windows (GDELT allows one request per 5 seconds per IP, so requests are spaced
 * >= 5.5 s and a 429 backs off), keeps market-relevant articles, normalizes and clusters them
 * exactly like live ingestion, and writes .cache/events/clusters.json for `npm run score-batch`.
 * Progress is saved, so an interrupted crawl resumes where it stopped.
 *
 *   npm run bootstrap-events -- --from 2026-07-01 --to 2026-10-07
 */
import { DEFAULT_CONFIG } from "../src/engine/config";
import { addDays, istAt } from "../src/engine/clock";
import { clusterArticles } from "../src/engine/events/cluster";
import { extractLocation } from "../src/engine/events/geo";
import { isMarketRelevant } from "../src/engine/events/lexicon";
import { normalizeArticles } from "../src/engine/events/normalize";
import { fetchGdeltArticles } from "../src/engine/events/sources/gdelt";
import { clusterParams } from "../src/engine/pipeline/ingestCycle";
import type { ArticleCluster, NormalizedArticle, RawArticle } from "../src/engine/types";
import { fail, num, parseArgs, readJson, sleep, str, writeJson } from "./lib/node";

const PROGRESS = ".cache/events/bootstrap-progress.json";
const RAW = ".cache/events/raw-articles.json";
const OUT = ".cache/events/clusters.json";
const WINDOW_MS = 6 * 3_600_000;

const gdeltTime = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function crawl(from: string, to: string, spacingMs: number): Promise<RawArticle[]> {
  const done = new Set(readJson<string[]>(PROGRESS) ?? []);
  const raw = readJson<RawArticle[]>(RAW) ?? [];
  const queries = DEFAULT_CONFIG.ingest.gdeltQueries;
  const start = istAt(from, "00:00");
  const end = istAt(addDays(to, 1), "00:00");
  const total = Math.ceil((end - start) / WINDOW_MS) * queries.length;
  let n = 0;
  for (let w = start; w < end; w += WINDOW_MS) {
    for (const q of queries) {
      n++;
      const key = `${w}|${q}`;
      if (done.has(key)) continue;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const arts = await fetchGdeltArticles(q, { startDateTime: gdeltTime(w), endDateTime: gdeltTime(Math.min(end, w + WINDOW_MS)), maxRecords: 250, timeoutMs: 30_000 });
          raw.push(...arts);
          done.add(key);
          process.stdout.write(`\r[${n}/${total}] ${new Date(w).toISOString().slice(0, 13)}Z ${arts.length} articles (total ${raw.length})      `);
          break;
        } catch (err) {
          const wait = 30_000 * (attempt + 1);
          console.log(`\n${err instanceof Error ? err.message : String(err)}; retrying in ${wait / 1000} s`);
          await sleep(wait);
        }
      }
      if (done.size % 20 === 0) {
        writeJson(PROGRESS, [...done]);
        writeJson(RAW, raw);
      }
      await sleep(spacingMs);
    }
  }
  writeJson(PROGRESS, [...done]);
  writeJson(RAW, raw);
  process.stdout.write("\n");
  return raw;
}

async function main() {
  const args = parseArgs();
  const from = str(args, "from");
  const to = str(args, "to");
  if (!from || !to || from > to) fail("usage: npm run bootstrap-events -- --from YYYY-MM-DD --to YYYY-MM-DD [--spacing-ms 5500]");
  const raw = await crawl(from, to, Math.max(5_500, num(args, "spacing-ms", 5_500)));
  const relevant = raw.filter((a) => isMarketRelevant(`${a.title} ${a.description ?? ""}`));
  const normalized: NormalizedArticle[] = await normalizeArticles(relevant, Date.now());
  // Cluster in publication order with the live parameters, carrying recent clusters forward.
  const params = clusterParams(DEFAULT_CONFIG);
  let clusters: ArticleCluster[] = [];
  const byId = new Map<string, ArticleCluster>();
  const sorted = [...normalized].sort((a, b) => a.publishedMs - b.publishedMs);
  for (let i = 0; i < sorted.length; i += 500) {
    const chunk = sorted.slice(i, i + 500);
    const horizon = chunk[0].publishedMs - params.windowHours * 3_600_000;
    const recent = clusters.filter((c) => c.lastSeenMs >= horizon);
    const { touched } = clusterArticles(chunk, recent, params, (t) => extractLocation(t)?.name);
    for (const c of touched) byId.set(c.id, c);
    clusters = [...byId.values()];
  }
  const path = writeJson(OUT, { from, to, articles: normalized.length, clusters });
  console.log(`${raw.length} articles crawled, ${relevant.length} market-relevant, ${normalized.length} after de-duplication, ${clusters.length} clusters -> ${path}`);
  console.log("Next: npm run score-batch -- --submit (Claude Batches API, 50% price) or --lexicon (free baseline).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
