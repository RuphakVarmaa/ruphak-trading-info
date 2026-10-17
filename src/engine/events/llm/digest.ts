/** Builds the volatile user message for a scoring batch. */
import { formatIst } from "../../clock";
import type { ArticleCluster, IndexId } from "../../types";
import { round } from "../../util/math";

export interface ScoringContext {
  nowMs: number;
  market: {
    niftyRetTodayPct: number | null;
    sensexRetTodayPct: number | null;
    vix: number | null;
    vixChangePct: number | null;
  };
  upcomingEvents: { title: string; at: number; impact: string }[];
  /** Stories scored in the last few days, so the model can reuse their keys. */
  knownClusters: { key: string; oneLiner: string; firstSeenMs: number }[];
  /** Index move in percent from a past instant to now, when price history is available. */
  indexMoveSince?: (ms: number) => Partial<Record<IndexId, number | null>>;
}

export function buildDigest(clusters: ArticleCluster[], ctx: ScoringContext): string {
  const digest = {
    as_of_ist: formatIst(ctx.nowMs),
    market_context: {
      nifty_ret_today_pct: ctx.market.niftyRetTodayPct === null ? null : round(ctx.market.niftyRetTodayPct, 2),
      sensex_ret_today_pct: ctx.market.sensexRetTodayPct === null ? null : round(ctx.market.sensexRetTodayPct, 2),
      india_vix: ctx.market.vix === null ? null : round(ctx.market.vix, 2),
      india_vix_change_pct: ctx.market.vixChangePct === null ? null : round(ctx.market.vixChangePct, 1),
      upcoming_scheduled_events_24h: ctx.upcomingEvents.slice(0, 8).map((e) => ({ title: e.title, at_ist: formatIst(e.at), impact: e.impact })),
    },
    known_active_clusters: ctx.knownClusters.slice(0, 40).map((k) => ({ key: k.key, one_liner: k.oneLiner.slice(0, 140), first_seen_ist: formatIst(k.firstSeenMs) })),
    clusters: clusters.map((c) => {
      const moves = ctx.indexMoveSince?.(c.firstSeenMs) ?? {};
      return {
        cluster_id: c.id,
        headlines: c.headlines.slice(0, 5),
        sources: c.sources.slice(0, 8),
        first_seen_ist: formatIst(c.firstSeenMs),
        last_seen_ist: formatIst(c.lastSeenMs),
        article_count: c.articleCount,
        gdelt_tone_mean: c.toneMean === undefined ? null : round(c.toneMean, 2),
        index_move_since_first_seen_pct: {
          nifty: moves.NIFTY === undefined || moves.NIFTY === null ? null : round(moves.NIFTY, 2),
          sensex: moves.SENSEX === undefined || moves.SENSEX === null ? null : round(moves.SENSEX, 2),
        },
        location_hint: c.locationName ?? null,
      };
    }),
  };
  return JSON.stringify(digest);
}
