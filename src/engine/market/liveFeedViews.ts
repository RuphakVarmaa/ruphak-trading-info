/**
 * EngineApi.getLiveIndices / getOptionChain with the market feed (MarketFeedDO) in front of the REST client:
 *
 * - index levels come from feed ticks younger than FEED_FRESH_MS (or from a connected stream that is that
 *   fresh), with open/high/low from the ticks' day OHLC or the REST levels already cached; otherwise from
 *   UpstoxLive's REST path as before;
 * - the option chain's structure and greeks stay on REST (TTL 30 s while the feed is live, 5 s otherwise) with
 *   fresher feed ticks laid over the subscribed strikes.
 *
 * Outside market hours the feed is closed, its ticks go stale and both views fall back to REST, which serves
 * the last values. `snapshot` failures (DO unreachable) count as "no feed".
 */
import type { IndexId, LiveIndexLevelsView, OptionChainView } from "../api-types";
import { UPSTOX_UNDERLYING_KEYS } from "./upstoxChain";
import { FEED_INDEX_KEYS, feedIndicesView, freshTicks, indexLevelsFromTicks, latestReceived, overlayChainTicks, type FeedSnapshot } from "./upstoxFeed";
import { CHAIN_TTL_FEED_MS, CHAIN_TTL_MS, type UpstoxLive } from "./upstoxLive";

export type SnapshotFn = (keys?: string[]) => Promise<FeedSnapshot | null>;

async function safeSnapshot(snapshot: SnapshotFn, keys?: string[]): Promise<FeedSnapshot | null> {
  try {
    return await snapshot(keys);
  } catch {
    return null;
  }
}

export async function liveIndicesWithFeed(market: UpstoxLive, snapshot: SnapshotFn, now: number = Date.now()): Promise<LiveIndexLevelsView> {
  const snap = await safeSnapshot(snapshot, [...FEED_INDEX_KEYS]);
  const fresh = freshTicks(snap, now);
  const levels = fresh.size > 0 ? indexLevelsFromTicks(fresh, market.cachedIndices()) : null;
  if (levels) return feedIndicesView(levels, latestReceived(fresh.values()) ?? now);
  return market.getLiveIndices();
}

export async function optionChainWithFeed(market: UpstoxLive, snapshot: SnapshotFn, index: IndexId, expiry: string | undefined, now: number = Date.now()): Promise<OptionChainView> {
  const snap = await safeSnapshot(snapshot);
  const fresh = freshTicks(snap, now);
  const underlying = UPSTOX_UNDERLYING_KEYS[index];
  const live = fresh.has(underlying);
  const view = await market.getOptionChain(index, expiry, live ? CHAIN_TTL_FEED_MS : CHAIN_TTL_MS);
  if (!live || view.rows.length === 0) return { ...view, feed: "rest" };
  return overlayChainTicks(view, fresh, underlying);
}
