/**
 * Upstox Market Data Feed V3 (WebSocket) for 1-second index levels and option quotes, without spending the
 * REST budget (per user 50/s, 500/min, 2,000 per 30 min):
 *
 * - GET /v3/feed/market-data-feed/authorize (Bearer token) returns a one-time wss:// URL;
 * - the client subscribes with a binary JSON frame {guid, method: "sub", data: {mode, instrumentKeys}};
 * - the server sends protobuf FeedResponse frames (upstoxFeedProto.ts): a market_info frame, an initial_feed
 *   snapshot per subscription, then live_feed updates.
 *
 * This module is the pure part: the tick store, the feed window (IST), the strike selection around ATM and
 * its re-centring, reconnect backoff, subscribe frames, and the views built from ticks (index levels, the
 * option-chain overlay). The Durable Object holding the socket is workers/engine/src/do/MarketFeedDO.ts.
 * Pure and web-standard (no node: imports).
 */
import type { LiveIndexLevelsView, OptionChainRowView, OptionChainView, OptionSideView } from "../api-types";
import { istIso, istParts } from "../clock";
import { atmStrike, maxPainStrike, putCallRatio, UPSTOX_LIVE_INDEX_KEYS, type LiveIndexLevel } from "./upstoxChain";
import { decodeFeedResponse, type DecodedFeed, type DecodedFeedResponse } from "./upstoxFeedProto";

export const UPSTOX_FEED_AUTHORIZE_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";

/** The feed runs 09:10-15:35 IST, Monday to Friday. */
export const FEED_WINDOW = { start: 9 * 60 + 10, end: 15 * 60 + 35 } as const;
/** Strikes each side of ATM subscribed per index. */
export const FEED_STRIKES_EACH_SIDE = 15;
/** Re-centre when the spot moves more than this many strikes from the subscribed centre. */
export const FEED_RECENTRE_STRIKES = 3;
/** A tick (or a live stream that carried it) older than this is not used for the views. */
export const FEED_FRESH_MS = 3_000;
export const FEED_BACKOFF_MIN_MS = 1_000;
export const FEED_BACKOFF_MAX_MS = 30_000;

/** Index instrument keys (subscribed in mode "full": LTP, previous close and the day's OHLC). */
export const FEED_INDEX_KEYS: readonly string[] = UPSTOX_LIVE_INDEX_KEYS.map(([, k]) => k);

export type FeedMode = "ltpc" | "option_greeks" | "full" | "full_d30";

/**
 * Upstox V3 per-connection instrument limits (individual subscriptions; documented on the market data feed
 * page). Option strikes use option_greeks (best bid/ask, OI, IV and greeks) while within its limit.
 */
export const FEED_MODE_LIMITS: Record<FeedMode, number> = { ltpc: 5000, option_greeks: 3000, full: 2000, full_d30: 50 };

export interface FeedTick {
  key: string;
  ltp: number | null;
  /** Last trade time, epoch ms. */
  ltt: number | null;
  /** Previous close. */
  cp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  oi: number | null;
  /** Implied volatility in percent (the feed sends a fraction). */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** The day's OHLC (interval "1d") when the mode sends it. */
  open: number | null;
  high: number | null;
  low: number | null;
  /** When this engine received the latest frame for the key, epoch ms. */
  receivedAt: number;
}

const posOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const nonNegOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number, dp: number): number => Math.round(v * 10 ** dp) / 10 ** dp;

/** The tick fields one decoded feed carries (absent fields are left out so older values survive a merge). */
export function tickFields(f: DecodedFeed): Partial<FeedTick> {
  const out: Partial<FeedTick> = {};
  if (f.ltpc) {
    const ltp = posOrNull(f.ltpc.ltp);
    if (ltp !== null) out.ltp = ltp;
    if (f.ltpc.ltt > 0) out.ltt = f.ltpc.ltt;
    const cp = posOrNull(f.ltpc.cp);
    if (cp !== null) out.cp = cp;
  }
  if (f.depth) {
    out.bid = posOrNull(f.depth.bidP);
    out.ask = posOrNull(f.depth.askP);
    out.bidQty = out.bid !== null ? nonNegOrNull(f.depth.bidQ) : null;
    out.askQty = out.ask !== null ? nonNegOrNull(f.depth.askQ) : null;
  }
  if (f.greeks) {
    out.delta = finiteOrNull(f.greeks.delta);
    out.gamma = finiteOrNull(f.greeks.gamma);
    out.theta = finiteOrNull(f.greeks.theta);
    out.vega = finiteOrNull(f.greeks.vega);
  }
  if (f.vtt !== null) out.volume = nonNegOrNull(f.vtt);
  if (f.oi !== null) out.oi = nonNegOrNull(f.oi);
  // The feed reports IV as a fraction (0.1223); the REST chain and the views use percent (12.23). 0 = unsolved.
  if (f.iv !== null) out.iv = posOrNull(f.iv) !== null ? round(f.iv * 100, 2) : null;
  const day = f.ohlc.find((o) => o.interval === "1d");
  if (day) {
    out.open = posOrNull(day.open);
    out.high = posOrNull(day.high);
    out.low = posOrNull(day.low);
  }
  return out;
}

function emptyTick(key: string, receivedAt: number): FeedTick {
  return {
    key,
    ltp: null,
    ltt: null,
    cp: null,
    bid: null,
    ask: null,
    bidQty: null,
    askQty: null,
    volume: null,
    oi: null,
    iv: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    open: null,
    high: null,
    low: null,
    receivedAt,
  };
}

/** The latest tick per instrument key, merged across frames, plus the segments' market status. */
export class TickStore {
  private readonly ticks = new Map<string, FeedTick>();
  marketStatus: Record<string, string> = {};
  /** Server time of the latest frame (epoch ms), 0 before the first. */
  serverTs = 0;
  frames = 0;

  /** Applies one decoded frame; returns how many instruments it updated. */
  apply(resp: DecodedFeedResponse, receivedAt: number): number {
    this.frames++;
    if (resp.currentTs > 0) this.serverTs = resp.currentTs;
    if (resp.marketStatus) this.marketStatus = { ...this.marketStatus, ...resp.marketStatus };
    let n = 0;
    for (const [key, feed] of Object.entries(resp.feeds)) {
      const prev = this.ticks.get(key) ?? emptyTick(key, receivedAt);
      this.ticks.set(key, { ...prev, ...tickFields(feed), key, receivedAt });
      n++;
    }
    return n;
  }

  /** Decodes and applies a binary frame. Throws ProtoError on a malformed frame. */
  applyFrame(bytes: Uint8Array, receivedAt: number): number {
    return this.apply(decodeFeedResponse(bytes), receivedAt);
  }

  get(key: string): FeedTick | undefined {
    return this.ticks.get(key);
  }

  /** The ticks for `keys` (those known), or every tick. */
  list(keys?: readonly string[]): FeedTick[] {
    if (!keys) return [...this.ticks.values()];
    const out: FeedTick[] = [];
    for (const k of keys) {
      const t = this.ticks.get(k);
      if (t) out.push(t);
    }
    return out;
  }

  /** Drops ticks for keys no longer subscribed (indices are kept). */
  retain(keys: ReadonlySet<string>): void {
    for (const k of this.ticks.keys()) if (!keys.has(k)) this.ticks.delete(k);
  }

  get size(): number {
    return this.ticks.size;
  }
}

/** True during 09:10-15:35 IST on a weekday (holidays are left to the caller). */
export function inFeedWindow(nowMs: number): boolean {
  const p = istParts(nowMs);
  return p.weekday <= 5 && p.minutesOfDay >= FEED_WINDOW.start && p.minutesOfDay < FEED_WINDOW.end;
}

/** The next window start (epoch ms) strictly after `nowMs`, or `nowMs` itself when inside the window. */
export function nextFeedWindowStart(nowMs: number): number {
  if (inFeedWindow(nowMs)) return nowMs;
  const p = istParts(nowMs);
  // IST midnight of today, as epoch ms.
  const midnight = nowMs - (p.minutesOfDay * 60_000 + p.second * 1000 + (nowMs % 1000));
  for (let d = 0; d < 8; d++) {
    const start = midnight + d * 86_400_000 + FEED_WINDOW.start * 60_000;
    if (start > nowMs && istParts(start).weekday <= 5) return start;
  }
  return nowMs + 86_400_000;
}

/** Reconnect delay after `failures` consecutive failures: 1 s, 2 s, 4 s ... capped at 30 s. */
export function feedBackoffMs(failures: number): number {
  return Math.min(FEED_BACKOFF_MAX_MS, FEED_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures, 10)));
}

/** A subscribe (or unsubscribe / change-mode) request: Upstox expects it as a binary frame. */
export function feedRequestFrame(guid: string, method: "sub" | "unsub" | "change_mode", mode: FeedMode, keys: readonly string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ guid, method, data: { mode, instrumentKeys: [...keys] } }));
}

/** The option mode to use for `count` strikes' keys: option_greeks within its limit, else ltpc. */
export function optionFeedMode(count: number): FeedMode {
  return count <= FEED_MODE_LIMITS.option_greeks ? "option_greeks" : "ltpc";
}

export interface StrikeKeys {
  strike: number;
  ce: string | null;
  pe: string | null;
}

/** The chain's strikes with their instrument keys, ascending. */
export function strikeKeysFromRows(rows: readonly OptionChainRowView[]): StrikeKeys[] {
  return rows
    .map((r) => ({ strike: r.strike, ce: r.ce?.instrumentKey ?? null, pe: r.pe?.instrumentKey ?? null }))
    .filter((r) => r.ce || r.pe)
    .sort((a, b) => a.strike - b.strike);
}

export interface StrikeSelection {
  /** The ATM strike the selection is centred on. */
  centre: number;
  /** Strike step around the centre (0 with fewer than two strikes). */
  step: number;
  keys: string[];
}

/** The ATM strike and `each` strikes either side of it; null without strikes or a spot. */
export function selectStrikes(strikes: readonly StrikeKeys[], spot: number, each = FEED_STRIKES_EACH_SIDE): StrikeSelection | null {
  if (strikes.length === 0 || !(spot > 0)) return null;
  let atm = 0;
  let dist = Infinity;
  strikes.forEach((s, i) => {
    const d = Math.abs(s.strike - spot);
    if (d < dist) [atm, dist] = [i, d];
  });
  const lo = Math.max(0, atm - each);
  const hi = Math.min(strikes.length - 1, atm + each);
  const keys: string[] = [];
  for (let i = lo; i <= hi; i++) {
    if (strikes[i].ce) keys.push(strikes[i].ce!);
    if (strikes[i].pe) keys.push(strikes[i].pe!);
  }
  const nb = strikes[atm + 1] ?? strikes[atm - 1];
  return { centre: strikes[atm].strike, step: nb ? Math.abs(nb.strike - strikes[atm].strike) : 0, keys };
}

/** True when the spot has moved more than FEED_RECENTRE_STRIKES strikes from the subscribed centre. */
export function needsRecentre(sel: StrikeSelection | null, spot: number, maxStrikes = FEED_RECENTRE_STRIKES): boolean {
  if (!sel) return spot > 0;
  if (!(spot > 0) || sel.step <= 0) return false;
  return Math.abs(spot - sel.centre) > maxStrikes * sel.step;
}

/**
 * A message safe to show in status and errors: no wss/https URLs (the authorized URL is a one-time
 * credential), no bearer values, and none of `secrets` (e.g. the token).
 */
export function redactFeedError(err: unknown, secrets: readonly (string | undefined)[] = []): string {
  let s = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) if (secret && secret.length >= 6) s = s.split(secret).join("[redacted]");
  s = s.replace(/\b(?:wss?|https?):\/\/[^\s"'<>]+/gi, (u) => {
    try {
      const url = new URL(u);
      return url.hostname === "api.upstox.com" && url.protocol === "https:" ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.hostname}/[redacted]`;
    } catch {
      return "[url redacted]";
    }
  });
  s = s.replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]");
  s = s.replace(/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, "[redacted]");
  return s.slice(0, 200);
}

/** A tick as returned by MarketFeedDO.ticks(): fresh when it (or the live stream) is younger than FEED_FRESH_MS. */
export function tickIsFresh(t: Pick<FeedTick, "receivedAt">, nowMs: number, streamAliveAt: number | null = null, maxAgeMs = FEED_FRESH_MS): boolean {
  const seen = Math.max(t.receivedAt, streamAliveAt ?? 0);
  return nowMs - seen < maxAgeMs && seen <= nowMs + 1_000;
}

export interface FeedSnapshot {
  ticks: FeedTick[];
  connected: boolean;
  /** When the socket last delivered a frame (any instrument), epoch ms. */
  lastMessageAt: number | null;
  /** The DO's clock when it answered, epoch ms. */
  at: number;
}

/** Fresh ticks by key; an unchanged instrument stays fresh while the connected stream is alive. */
export function freshTicks(snap: FeedSnapshot | null, nowMs: number, maxAgeMs = FEED_FRESH_MS): Map<string, FeedTick> {
  const out = new Map<string, FeedTick>();
  if (!snap) return out;
  const alive = snap.connected ? snap.lastMessageAt : null;
  for (const t of snap.ticks) if (t.ltp !== null && tickIsFresh(t, nowMs, alive, maxAgeMs)) out.set(t.key, t);
  return out;
}

/**
 * Index levels from fresh feed ticks, in UPSTOX_LIVE_INDEX_KEYS order; null unless at least NIFTY and SENSEX
 * are fresh. Open/high/low come from the ticks' day OHLC, else from `rest` (the last REST levels).
 */
export function indexLevelsFromTicks(fresh: ReadonlyMap<string, FeedTick>, rest: readonly LiveIndexLevel[] | null): LiveIndexLevel[] | null {
  const restByKey = new Map((rest ?? []).map((l) => [l.key, l]));
  const levels: LiveIndexLevel[] = [];
  for (const [key, instrumentKey] of UPSTOX_LIVE_INDEX_KEYS) {
    const t = fresh.get(instrumentKey);
    const r = restByKey.get(key);
    if (!t || t.ltp === null) {
      if (r) levels.push(r);
      continue;
    }
    const prevClose = t.cp ?? r?.prevClose ?? null;
    const change = prevClose !== null ? round(t.ltp - prevClose, 2) : null;
    levels.push({
      key,
      price: t.ltp,
      open: t.open ?? r?.open ?? null,
      high: t.high !== null ? Math.max(t.high, t.ltp) : (r?.high ?? null),
      low: t.low !== null ? Math.min(t.low, t.ltp) : (r?.low ?? null),
      prevClose,
      change,
      changePct: change !== null && prevClose !== null && prevClose > 0 ? round((change / prevClose) * 100, 2) : null,
    });
  }
  if (!fresh.has(UPSTOX_LIVE_INDEX_KEYS[0][1]) || !fresh.has(UPSTOX_LIVE_INDEX_KEYS[1][1])) return null;
  return levels;
}

/** The latest receive time among `ticks`, or null. */
export function latestReceived(ticks: Iterable<FeedTick>): number | null {
  let max: number | null = null;
  for (const t of ticks) if (max === null || t.receivedAt > max) max = t.receivedAt;
  return max;
}

/** The LiveIndexLevelsView from feed levels. */
export function feedIndicesView(levels: LiveIndexLevel[], receivedMs: number): LiveIndexLevelsView {
  return { fetchedAt: istIso(receivedMs), source: "upstox", levels, error: null, feed: "websocket" };
}

function overlaySide(side: OptionSideView | null, t: FeedTick | undefined): OptionSideView | null {
  if (!side || !t || t.ltp === null) return side;
  const close = t.cp ?? side.close;
  const change = close !== null ? round(t.ltp - close, 2) : null;
  const oi = t.oi ?? side.oi;
  const bid = t.bid !== null || t.ask !== null ? t.bid : side.bid;
  const ask = t.bid !== null || t.ask !== null ? t.ask : side.ask;
  return {
    ...side,
    ltp: t.ltp,
    close,
    change,
    changePct: change !== null && close !== null && close > 0 ? round((change / close) * 100, 2) : null,
    bid,
    ask,
    bidQty: t.bid !== null || t.ask !== null ? t.bidQty : side.bidQty,
    askQty: t.bid !== null || t.ask !== null ? t.askQty : side.askQty,
    volume: t.volume ?? side.volume,
    oi,
    oiChange: oi !== null && side.prevOi !== null ? oi - side.prevOi : side.oiChange,
    iv: t.iv ?? side.iv,
    delta: t.delta ?? side.delta,
    gamma: t.gamma ?? side.gamma,
    theta: t.theta ?? side.theta,
    vega: t.vega ?? side.vega,
  };
}

/**
 * The REST chain with fresher feed ticks laid over the subscribed strikes (LTP, change, bid/ask, volume, OI,
 * IV and greeks when present) and the spot from the underlying's tick. ATM, PCR and max pain are recomputed.
 * Returns the view unchanged (feed "rest") when no tick applies.
 */
export function overlayChainTicks(view: OptionChainView, fresh: ReadonlyMap<string, FeedTick>, underlyingKey: string): OptionChainView {
  if (view.rows.length === 0 || fresh.size === 0) return { ...view, feed: "rest" };
  let applied: number | null = null;
  const rows = view.rows.map((r) => {
    const ce = r.ce ? fresh.get(r.ce.instrumentKey) : undefined;
    const pe = r.pe ? fresh.get(r.pe.instrumentKey) : undefined;
    if (!ce && !pe) return r;
    for (const t of [ce, pe]) if (t && t.ltp !== null) applied = Math.max(applied ?? 0, t.receivedAt);
    return { strike: r.strike, ce: overlaySide(r.ce, ce), pe: overlaySide(r.pe, pe) };
  });
  const u = fresh.get(underlyingKey);
  const spot = u?.ltp ?? view.spot;
  if (applied === null && !u) return { ...view, feed: "rest" };
  const at = Math.max(applied ?? 0, u?.receivedAt ?? 0);
  return {
    ...view,
    spot,
    atmStrike: atmStrike(rows, spot),
    pcr: putCallRatio(rows),
    maxPain: maxPainStrike(rows),
    rows,
    fetchedAt: istIso(at),
    feed: "websocket",
  };
}
