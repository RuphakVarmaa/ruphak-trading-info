/** Builds the article fetchers used by the ingest cycle. */
import type { Clock } from "../../clock";
import type { EngineConfig } from "../../config";
import type { StateStore } from "../../ports";
import type { ArticleSource, RawArticle } from "../../types";
import type { FetchLike } from "../../util/http";
import { fetchGdeltArticles } from "./gdelt";
import { fetchGNews } from "./gnews";
import { fetchGoogleNews } from "./googleRss";

export interface ArticleFetcher {
  name: ArticleSource;
  fetch(): Promise<RawArticle[]>;
}

export interface FetcherOptions {
  cfg: EngineConfig;
  clock: Clock;
  state: StateStore;
  fetchImpl?: FetchLike;
  gnewsApiKey?: string;
  /** Disable GDELT (e.g. when its rate limit keeps failing from this egress IP). */
  gdelt?: boolean;
  /** Max GDELT queries per cycle (each costs >= 5.5 s of spacing). */
  gdeltQueriesPerCycle?: number;
}

const GDELT_CURSOR_KEY = "ingest:gdelt";

interface GdeltCursor {
  lastRequestMs: number;
  nextQueryIndex: number;
}

export function buildFetchers(o: FetcherOptions): ArticleFetcher[] {
  const fetchers: ArticleFetcher[] = [
    {
      name: "google_rss",
      fetch: async () => {
        const out: RawArticle[] = [];
        const results = await Promise.allSettled(o.cfg.ingest.rssQueries.map((q) => fetchGoogleNews(q, { fetchImpl: o.fetchImpl })));
        let failures = 0;
        for (const r of results) {
          if (r.status === "fulfilled") out.push(...r.value);
          else failures++;
        }
        if (failures === results.length && results.length > 0) {
          throw new Error(`all ${failures} Google News queries failed: ${String((results[0] as PromiseRejectedResult).reason)}`);
        }
        return out;
      },
    },
  ];
  if (o.gnewsApiKey) {
    const key = o.gnewsApiKey;
    fetchers.push({
      name: "gnews",
      fetch: async () => {
        const out: RawArticle[] = [];
        // GNews free tier is ~100 requests/day: rotate one query per cycle.
        const cursorKey = "ingest:gnews:next";
        const next = (await o.state.get<number>(cursorKey)) ?? 0;
        const queries = o.cfg.ingest.gnewsQueries;
        const q = queries[next % queries.length];
        await o.state.set(cursorKey, (next + 1) % queries.length);
        out.push(...(await fetchGNews(q, key, { fetchImpl: o.fetchImpl, max: 10 })));
        return out;
      },
    });
  }
  if (o.gdelt !== false) {
    fetchers.push({
      name: "gdelt",
      fetch: async () => {
        const queries = o.cfg.ingest.gdeltQueries;
        const perCycle = Math.min(o.gdeltQueriesPerCycle ?? 2, queries.length);
        const cursor = (await o.state.get<GdeltCursor>(GDELT_CURSOR_KEY)) ?? { lastRequestMs: 0, nextQueryIndex: 0 };
        const out: RawArticle[] = [];
        let firstError: unknown = null;
        for (let i = 0; i < perCycle; i++) {
          const wait = cursor.lastRequestMs + o.cfg.ingest.gdeltMinIntervalMs - o.clock.now();
          if (wait > 0) await o.clock.sleep(wait);
          const q = queries[cursor.nextQueryIndex % queries.length];
          cursor.nextQueryIndex = (cursor.nextQueryIndex + 1) % queries.length;
          cursor.lastRequestMs = o.clock.now();
          try {
            out.push(...(await fetchGdeltArticles(q, { fetchImpl: o.fetchImpl, timespan: "2h", maxRecords: 75 })));
          } catch (err) {
            firstError ??= err;
            break; // a 429 means "back off": do not burn the next query
          } finally {
            await o.state.set(GDELT_CURSOR_KEY, cursor);
          }
        }
        if (out.length === 0 && firstError) throw firstError;
        return out;
      },
    });
  }
  return fetchers;
}
