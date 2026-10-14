/**
 * Live broker data for the trading loop from Upstox's read-only Market Data API (the Analytics Token;
 * GET only, it cannot place orders). Two pieces, both paper-only:
 * - UpstoxOverlayMarketData: a MarketDataSource decorator over Yahoo. For NIFTY, SENSEX and India VIX it
 *   replaces today's 5-minute bars with Upstox 1-minute candles resampled to 09:15-aligned 5-minute bars
 *   (refreshed at most every `candleTtlMs`, default 60 s), and for NIFTY and SENSEX sets the spot and its
 *   trade time from an Upstox quote (at most every `ltpTtlMs`, default 15 s). Yahoo's ^BSESN is ~15 min
 *   late; Upstox's is live. Any Upstox failure leaves that part of Yahoo's snapshot untouched.
 * - UpstoxOptionQuotes: paper option quotes (Quote.source "upstox"), cached per contract and batched: one
 *   request refreshes every contract asked for recently, so main and the followers share it.
 * Each has a hard request budget per rolling minute (8 and 15); over budget is treated as a failure.
 */
import { MINUTE_MS, SESSION } from "../clock";
import type { MarketDataSource, OptionQuoteSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type FeatureIndexId, type MarketSnapshot, type OptionContract, type Quote } from "../types";
import { BAR_5M_MS, istMinuteOfDay, lastIndexAtOrBefore, resample, spliceCandles } from "./candles";
import { UPSTOX_INDEX_KEYS, UPSTOX_MAX_KEYS, UPSTOX_VIX_KEY, UpstoxError, parseUpstoxQuote, parseUpstoxTime, upstoxInstrumentKey } from "./upstoxQuotes";

type Rec = Record<string, unknown>;

/** The part of UpstoxQuotes these sources use. */
export interface UpstoxMarketClient {
  get(path: string, query?: string, label?: string): Promise<unknown>;
  quotesByKey(keys: readonly string[]): Promise<Map<string, Rec>>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Requests allowed per rolling minute. */
class RequestBudget {
  private readonly at: number[] = [];
  constructor(private readonly perMinute: number) {}
  take(now: number): boolean {
    while (this.at.length > 0 && now - this.at[0] >= MINUTE_MS) this.at.shift();
    if (this.at.length >= this.perMinute) return false;
    this.at.push(now);
    return true;
  }
}

/** Upstox candle rows ([iso time, o, h, l, c, volume, oi], newest first) as candles, oldest first. */
export function parseUpstoxCandles(payload: unknown): Candle[] {
  const data = (payload as { data?: { candles?: unknown } } | null)?.data;
  const rows = Array.isArray(data?.candles) ? (data.candles as unknown[]) : [];
  const out: Candle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const t = typeof r[0] === "string" ? Date.parse(r[0]) : NaN;
    const [o, h, l, c] = [num(r[1]), num(r[2]), num(r[3]), num(r[4])];
    if (!Number.isFinite(t) || o === null || h === null || l === null || c === null) continue;
    out.push({ t, o, h, l, c, v: num(r[5]) ?? 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 1-minute bars as 5-minute bars aligned to 09:15 IST; only bars opening in [09:15, 15:30) count, and the
 * last bucket is the forming bar when its five minutes are not all in yet (as Yahoo's newest bar is).
 */
export function aggregate1mTo5m(bars1m: readonly Candle[]): Candle[] {
  const inSession = bars1m.filter((c) => {
    const m = istMinuteOfDay(c.t);
    return m >= SESSION.open && m < SESSION.close;
  });
  return resample(inSession, 5);
}

interface OverlaySpec {
  symbol: string;
  key: string;
  /** Traded index: its spot, trade time and per-index freshness come from Upstox too. */
  index?: Extract<FeatureIndexId, "NIFTY" | "SENSEX">;
}

const OVERLAY: readonly OverlaySpec[] = [
  { symbol: MARKET_SYMBOLS.NIFTY, key: UPSTOX_INDEX_KEYS.NIFTY!, index: "NIFTY" },
  { symbol: MARKET_SYMBOLS.SENSEX, key: UPSTOX_INDEX_KEYS.SENSEX!, index: "SENSEX" },
  { symbol: MARKET_SYMBOLS.INDIAVIX, key: UPSTOX_VIX_KEY },
];

export interface UpstoxOverlayOptions {
  now?: () => number;
  /** Intraday candle refresh per symbol (default 60 s). */
  candleTtlMs?: number;
  /** Index quote refresh (default 15 s: every 30-second tick gets a fresh one). */
  ltpTtlMs?: number;
  /** Upstox requests per rolling minute (default 8). */
  maxRequestsPerMinute?: number;
  log?: (msg: string, data?: unknown) => void;
}

interface HeldCandles {
  fetchedMs: number;
  bars1m: Candle[];
  bars5m: Candle[];
}

interface HeldSpot {
  ltp: number;
  /** Exchange time of the last trade, else the fetch time. */
  asOfMs: number;
}

export class UpstoxOverlayMarketData implements MarketDataSource {
  readonly source = "upstox" as const;
  private readonly now: () => number;
  private readonly candleTtlMs: number;
  private readonly ltpTtlMs: number;
  private readonly budget: RequestBudget;
  private readonly log: (msg: string, data?: unknown) => void;
  private readonly candles = new Map<string, HeldCandles>();
  private readonly candleAttempt = new Map<string, number>();
  private spots: Map<string, HeldSpot> | null = null;
  private spotAttempt = -Infinity;
  private failing = false;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly inner: MarketDataSource,
    private readonly client: UpstoxMarketClient,
    opts: UpstoxOverlayOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.candleTtlMs = opts.candleTtlMs ?? 60_000;
    this.ltpTtlMs = opts.ltpTtlMs ?? 15_000;
    this.budget = new RequestBudget(opts.maxRequestsPerMinute ?? 8);
    this.log = opts.log ?? (() => {});
  }

  async snapshot(t: number): Promise<MarketSnapshot> {
    const [snap] = await Promise.all([this.inner.snapshot(t), this.refresh()]);
    return this.apply(snap, t);
  }

  private refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const now = this.now();
    const jobs: Promise<string | null>[] = [];
    if (now - this.spotAttempt >= this.ltpTtlMs && this.budget.take(now)) {
      this.spotAttempt = now;
      jobs.push(this.fetchSpots());
    }
    for (const s of OVERLAY) {
      const last = this.candleAttempt.get(s.symbol);
      if (last !== undefined && now - last < this.candleTtlMs) continue;
      if (!this.budget.take(now)) break;
      this.candleAttempt.set(s.symbol, now);
      jobs.push(this.fetchCandles(s, now));
    }
    if (jobs.length === 0) return;
    const errors = (await Promise.all(jobs)).filter((e): e is string => e !== null);
    if (errors.length > 0 && !this.failing) {
      this.failing = true;
      this.log("upstox-market: Upstox data failed, Yahoo's data used instead", { errors });
    } else if (errors.length === 0 && this.failing) {
      this.failing = false;
      this.log("upstox-market: Upstox data recovered");
    }
  }

  private async fetchSpots(): Promise<string | null> {
    try {
      const byKey = await this.client.quotesByKey(OVERLAY.filter((s) => s.index).map((s) => s.key));
      const fetchedMs = this.now();
      const spots = new Map<string, HeldSpot>();
      for (const s of OVERLAY) {
        const e = byKey.get(s.key);
        const ltp = num(e?.last_price);
        if (!s.index || !e || ltp === null || ltp <= 0) continue;
        const traded = parseUpstoxTime(e.last_trade_time);
        spots.set(s.symbol, { ltp, asOfMs: Math.min(traded ?? fetchedMs, fetchedMs) });
      }
      this.spots = spots;
      return null;
    } catch (err) {
      this.spots = null;
      return `quotes: ${errMsg(err)}`;
    }
  }

  private async fetchCandles(s: OverlaySpec, now: number): Promise<string | null> {
    try {
      const path = `/v2/historical-candle/intraday/${encodeURIComponent(s.key)}/1minute`;
      const bars1m = parseUpstoxCandles(await this.client.get(path, undefined, `/v2/historical-candle/intraday/${s.key}/1minute`));
      const bars5m = aggregate1mTo5m(bars1m);
      if (bars5m.length === 0) this.candles.delete(s.symbol);
      else this.candles.set(s.symbol, { fetchedMs: Math.max(now, this.now()), bars1m, bars5m });
      return null;
    } catch (err) {
      this.candles.delete(s.symbol);
      return `${s.symbol} candles: ${errMsg(err)}`;
    }
  }

  private apply(snap: MarketSnapshot, t: number): MarketSnapshot {
    const now = this.now();
    const candles = { ...snap.candles };
    const ltp = { ...snap.ltp };
    const asOfMs = { ...(snap.asOfMs ?? {}) };
    const ageByIndex = { ...(snap.dataAgeSecByIndex ?? {}) };
    let dataAgeSec = snap.dataAgeSec;
    let changed = false;
    for (const s of OVERLAY) {
      const held = this.candles.get(s.symbol);
      const i5 = held ? lastIndexAtOrBefore(held.bars5m, t) : -1;
      const i1 = held ? lastIndexAtOrBefore(held.bars1m, t) : -1;
      if (held && i5 >= 0 && i1 >= 0) {
        const bars = held.bars5m.slice(0, i5 + 1);
        candles[s.symbol] = spliceCandles(snap.candles[s.symbol] ?? [], bars);
        const last = bars[bars.length - 1];
        // The bars were observed up to the newest 1-minute bar's close, no later than the fetch.
        const seen = Math.min(held.bars1m[i1].t + MINUTE_MS, held.fetchedMs, now);
        asOfMs[s.symbol] = seen;
        if (s.index) {
          ltp[s.index] = last.c;
          const age = Math.max(0, (now - Math.min(last.t + BAR_5M_MS, seen)) / 1000);
          ageByIndex[s.index] = age;
          dataAgeSec = Math.min(dataAgeSec, age);
        }
        changed = true;
      }
      const spot = this.spots?.get(s.symbol);
      if (spot && s.index) {
        // The spot only: a live quote must not make frozen bars look fresh (dataAgeSecByIndex is the bars').
        ltp[s.index] = spot.ltp;
        asOfMs[s.symbol] = Math.min(spot.asOfMs, now);
        changed = true;
      }
    }
    if (!changed) return snap;
    return { ...snap, candles, ltp, asOfMs, dataAgeSecByIndex: ageByIndex, dataAgeSec };
  }
}

export interface UpstoxOptionQuotesOptions {
  now?: () => number;
  /** Per contract (default 5 s). */
  cacheMs?: number;
  /** Contracts asked for within this window are refreshed together (default 2 min). */
  watchMs?: number;
  /** Upstox requests per rolling minute (default 15). */
  maxRequestsPerMinute?: number;
  /** After a failure that is not about one contract, fail every quote at once for this long (default 30 s). */
  pauseAfterErrorMs?: number;
}

const CONTRACT_ERRORS = new Set(["bad_request", "not_found"]);

/** Paper option quotes from Upstox (source "upstox"); the caller falls back to synthetic on a throw. */
export class UpstoxOptionQuotes implements OptionQuoteSource {
  readonly kind = "upstox" as const;
  private readonly cache = new Map<string, Quote>();
  /** Instrument key -> contract and when it was last asked for. */
  private readonly watched = new Map<string, { contract: OptionContract; askedMs: number }>();
  private readonly budget: RequestBudget;
  private pending: Promise<void> | null = null;
  private pausedUntil = -Infinity;
  private pauseReason = "";
  requests = 0;

  constructor(
    private readonly client: UpstoxMarketClient,
    private readonly o: UpstoxOptionQuotesOptions = {},
  ) {
    this.budget = new RequestBudget(o.maxRequestsPerMinute ?? 15);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async quote(contract: OptionContract): Promise<Quote> {
    if (!contract.exchangeToken || contract.exchangeToken.startsWith("SYN-")) {
      throw new UpstoxError(`no exchange token for ${contract.tradingSymbol}`, "bad_request", 0);
    }
    const key = upstoxInstrumentKey(contract);
    const now = this.now();
    this.watched.set(key, { contract, askedMs: now });
    const fresh = () => {
      const hit = this.cache.get(contract.tradingSymbol);
      return hit && this.now() - hit.t < (this.o.cacheMs ?? 5_000) ? hit : null;
    };
    const hit = fresh();
    if (hit) return hit;
    if (now < this.pausedUntil) {
      throw new UpstoxError(`Upstox quotes paused for ${Math.ceil((this.pausedUntil - now) / 1000)} s after: ${this.pauseReason}`, "transient", 0);
    }
    // Concurrent callers wait for the batch in flight; it may already cover this contract.
    if (this.pending) {
      await this.pending.catch(() => {});
      const after = fresh();
      if (after) return after;
    }
    this.pending ??= this.fetchWatched().finally(() => {
      this.pending = null;
    });
    await this.pending;
    const q = fresh();
    if (!q) throw new UpstoxError(`Upstox returned no quote for ${contract.tradingSymbol}`, "not_found", 0);
    return q;
  }

  private async fetchWatched(): Promise<void> {
    // Yield once so contracts asked for in the same turn join this request.
    await Promise.resolve();
    const now = this.now();
    const watchMs = this.o.watchMs ?? 2 * MINUTE_MS;
    for (const [k, w] of this.watched) if (now - w.askedMs > watchMs) this.watched.delete(k);
    const wanted = [...this.watched.entries()].sort((a, b) => b[1].askedMs - a[1].askedMs).slice(0, UPSTOX_MAX_KEYS);
    if (!this.budget.take(now)) {
      throw new UpstoxError("Upstox paper-quote budget reached (requests per minute)", "rate_limited", 0);
    }
    this.requests++;
    try {
      const byKey = await this.client.quotesByKey(wanted.map(([k]) => k));
      const fetchedMs = this.now();
      for (const [k, w] of wanted) {
        const e = byKey.get(k);
        if (e) this.cache.set(w.contract.tradingSymbol, parseUpstoxQuote(w.contract.tradingSymbol, e, fetchedMs).quote);
      }
    } catch (err) {
      const pause = this.o.pauseAfterErrorMs ?? 30_000;
      if (pause > 0 && !(err instanceof UpstoxError && CONTRACT_ERRORS.has(err.kind))) {
        this.pausedUntil = this.now() + pause;
        this.pauseReason = errMsg(err).slice(0, 200);
      }
      throw err;
    }
  }
}
