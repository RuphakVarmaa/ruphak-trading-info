/**
 * One minute's option-chain sample from the market feed's tick store (MarketFeedDO): for each subscribed
 * strike of an index (ATM ± 15, nearest expiry) the latest LTP, the day's cumulative volume, OI, best
 * bid/ask, IV and delta, and the index level from its own tick. Pure.
 */
import { SESSION, istParts } from "../clock";
import { UPSTOX_UNDERLYING_KEYS } from "../market/upstoxChain";
import type { FeedTick } from "../market/upstoxFeed";
import type { OptionBook } from "../market/upstoxFeedClient";
import type { ChainSnapshot, SideQuote } from "./flowMonitor";

/** Samples are taken 09:15–15:30 IST on weekdays (the caller checks holidays). */
export function inFlowSession(nowMs: number): boolean {
  const p = istParts(nowMs);
  return p.weekday <= 5 && p.minutesOfDay >= SESSION.open && p.minutesOfDay < SESSION.close;
}

function sideFrom(t: FeedTick | undefined): SideQuote | null {
  if (!t || t.ltp === null) return null;
  return { ltp: t.ltp, volume: t.volume, oi: t.oi, bid: t.bid, ask: t.ask, iv: t.iv, delta: t.delta };
}

/** The snapshot for one index, or null without an index level or any option tick. */
export function chainSnapshotFromTicks(book: OptionBook, get: (key: string) => FeedTick | undefined, nowMs: number): ChainSnapshot | null {
  const u = get(UPSTOX_UNDERLYING_KEYS[book.index]);
  if (!u || u.ltp === null || !(u.ltp > 0)) return null;
  const rows = book.strikes
    .map((s) => ({ strike: s.strike, ce: s.ce ? sideFrom(get(s.ce)) : null, pe: s.pe ? sideFrom(get(s.pe)) : null }))
    .filter((r) => r.ce !== null || r.pe !== null);
  if (rows.length === 0) return null;
  return { t: nowMs, index: book.index, expiry: book.expiry, lotSize: book.lotSize, spot: u.ltp, rows };
}
