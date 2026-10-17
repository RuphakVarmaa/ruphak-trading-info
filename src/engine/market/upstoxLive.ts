/**
 * The engine's live option chain and index levels (EngineApi.getOptionChain / getLiveIndices), cached per
 * isolate so the dashboard's polling cannot run the Upstox Analytics Token into its rate limits:
 *
 * - each value has a TTL (chain 5 s per index and expiry, expiries and lot size 30 min, index levels 3 s);
 * - concurrent identical requests share one in-flight fetch;
 * - at most `budgetPerMinute` Upstox requests in any 60 s, and none for 20 s after an HTTP 429; a value due
 *   for refresh is then served as it is (up to 60 s old);
 * - a failed refresh serves the last good value for up to 60 s, with `error` set.
 *
 * Worst case one isolate makes `budgetPerMinute` requests a minute, whatever the polling.
 */
import type { IndexId, LiveIndexLevelsView, OptionChainView } from "../api-types";
import { istIso } from "../clock";
import {
  UpstoxChainClient,
  buildOptionChainView,
  defaultExpiry,
  upstoxFailureMessage,
  type LiveIndexLevel,
  type OptionContractsMeta,
  type ParsedChain,
} from "./upstoxChain";
import { UpstoxError } from "./upstoxQuotes";

export const NO_QUOTE_SOURCE = "no quote source: set UPSTOX_ANALYTICS_TOKEN";

export const CHAIN_TTL_MS = 5_000;
/** The chain TTL while the market feed overlays 1-second ticks (REST then only refreshes greeks and the structure). */
export const CHAIN_TTL_FEED_MS = 30_000;
export const META_TTL_MS = 30 * 60_000;
export const INDICES_TTL_MS = 3_000;
/** How long a last good value is served after a failed or throttled refresh. */
export const STALE_MS = 60_000;
/** Expiries and lot size change at most daily: served this long when their refresh fails. */
export const META_STALE_MS = 6 * 60 * 60_000;
/** A failed refresh is retried after min(TTL, this). */
export const RETRY_MS = 10_000;
export const RATE_LIMIT_COOLDOWN_MS = 20_000;
export const DEFAULT_BUDGET_PER_MINUTE = 28;

export interface UpstoxLiveOptions {
  /** The Analytics Token (Worker secret UPSTOX_ANALYTICS_TOKEN); without one every view carries NO_QUOTE_SOURCE. */
  token?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  budgetPerMinute?: number;
}

interface Slot<T> {
  good: { value: T; at: number } | null;
  triedAt: number;
  error: string | null;
  inflight: Promise<void> | null;
}

interface Read<T> {
  value: T | null;
  /** When `value` was fetched. */
  at: number | null;
  error: string | null;
}

export class UpstoxLive {
  private readonly client: UpstoxChainClient | null;
  private readonly slots = new Map<string, Slot<unknown>>();
  private calls: number[] = [];
  private cooldownUntil = 0;
  /** Upstox requests started (for tests and budget checks). */
  requests = 0;

  constructor(private readonly o: UpstoxLiveOptions = {}) {
    this.client = o.token ? new UpstoxChainClient({ token: o.token, fetch: o.fetch }) : null;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Why a request may not be made now, or null. */
  private blocked(now: number): string | null {
    if (now < this.cooldownUntil) return "Upstox rate limit (HTTP 429): retrying shortly";
    this.calls = this.calls.filter((t) => now - t < 60_000);
    if (this.calls.length >= (this.o.budgetPerMinute ?? DEFAULT_BUDGET_PER_MINUTE)) return "Upstox request budget reached: retrying shortly";
    return null;
  }

  private result<T>(s: Slot<T>, staleMs: number, error: string | null, throttled: boolean): Read<T> {
    const now = this.now();
    const good = s.good && now - s.good.at <= staleMs ? s.good : null;
    // A throttled refresh with a usable value is not an error: fetchedAt shows its age.
    return { value: good?.value ?? null, at: good?.at ?? null, error: throttled && good && !s.error ? null : error };
  }

  private async read<T>(key: string, ttlMs: number, load: () => Promise<T>, staleMs = STALE_MS): Promise<Read<T>> {
    let s = this.slots.get(key) as Slot<T> | undefined;
    if (!s) {
      s = { good: null, triedAt: -Infinity, error: null, inflight: null };
      this.slots.set(key, s as Slot<unknown>);
    }
    if (s.inflight) {
      await s.inflight;
      return this.result(s, staleMs, s.error, false);
    }
    const now = this.now();
    const due = s.error ? Math.min(ttlMs, RETRY_MS) : ttlMs;
    if (now - s.triedAt < due) return this.result(s, staleMs, s.error, false);
    const blocked = this.blocked(now);
    if (blocked) return this.result(s, staleMs, blocked, true);
    this.calls.push(now);
    this.requests++;
    s.triedAt = now;
    const slot = s;
    slot.inflight = load()
      .then(
        (value) => {
          slot.good = { value, at: this.now() };
          slot.error = null;
        },
        (err: unknown) => {
          slot.error = upstoxFailureMessage(err);
          if (err instanceof UpstoxError && err.kind === "rate_limited") this.cooldownUntil = this.now() + RATE_LIMIT_COOLDOWN_MS;
        },
      )
      .finally(() => {
        slot.inflight = null;
      });
    await slot.inflight;
    return this.result(slot, staleMs, slot.error, false);
  }

  private emptyChain(index: IndexId, expiry: string, meta: OptionContractsMeta | null, error: string): OptionChainView {
    return {
      index,
      expiry,
      expiries: meta?.expiries ?? [],
      lotSize: meta?.lotSize ?? 0,
      spot: 0,
      atmStrike: 0,
      pcr: null,
      maxPain: null,
      rows: [],
      fetchedAt: istIso(this.now()),
      source: "upstox",
      error,
    };
  }

  /** `expiry` (YYYY-MM-DD, validated by the caller) defaults to defaultExpiry(). */
  /** `chainTtlMs` overrides CHAIN_TTL_MS (CHAIN_TTL_FEED_MS while the market feed is live). */
  async getOptionChain(index: IndexId, expiry?: string, chainTtlMs: number = CHAIN_TTL_MS): Promise<OptionChainView> {
    const client = this.client;
    if (!client) return this.emptyChain(index, expiry ?? "", null, NO_QUOTE_SOURCE);
    const m = await this.read(`meta:${index}`, META_TTL_MS, () => client.contracts(index), META_STALE_MS);
    const meta = m.value;
    if (!meta) return this.emptyChain(index, expiry ?? "", null, m.error ?? "Upstox listed no contracts");
    const exp = expiry || defaultExpiry(meta.expiries, this.now());
    if (!exp) return this.emptyChain(index, "", meta, `Upstox lists no upcoming ${index} expiry`);
    if (!meta.expiries.includes(exp)) return this.emptyChain(index, exp, meta, `${index} has no listed expiry ${exp}`);
    const c = await this.read<ParsedChain>(`chain:${index}:${exp}`, chainTtlMs, () => client.chain(index, exp));
    if (!c.value || c.at === null) return this.emptyChain(index, exp, meta, c.error ?? "Upstox returned no chain");
    if (c.value.rows.length === 0) return this.emptyChain(index, exp, meta, c.error ?? `Upstox returned an empty chain for ${index} ${exp}`);
    return buildOptionChainView({ index, expiry: exp, meta, chain: c.value, fetchedMs: c.at, error: c.error });
  }

  async getLiveIndices(): Promise<LiveIndexLevelsView> {
    const client = this.client;
    if (!client) return { fetchedAt: istIso(this.now()), source: "upstox", levels: [], error: NO_QUOTE_SOURCE };
    const r = await this.read<LiveIndexLevel[]>("indices", INDICES_TTL_MS, () => client.indexLevels());
    const levels = r.value ?? [];
    const error = r.error ?? (levels.length === 0 ? "Upstox returned no index levels" : null);
    return { fetchedAt: istIso(r.at ?? this.now()), source: "upstox", levels, error, feed: "rest" };
  }

  /** The last good index levels already fetched (no request), up to `maxAgeMs` old; null without one. */
  cachedIndices(maxAgeMs = 6 * 60 * 60_000): LiveIndexLevel[] | null {
    const s = this.slots.get("indices") as Slot<LiveIndexLevel[]> | undefined;
    return s?.good && this.now() - s.good.at <= maxAgeMs ? s.good.value : null;
  }
}
