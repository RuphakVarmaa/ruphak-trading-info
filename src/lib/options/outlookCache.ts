/**
 * The in-isolate cache behind GET /api/engine/outlook (unit-tested in outlookCache.test.ts with a fake engine).
 *
 * Each (index, expiry) chain is kept for 5 minutes in market hours and 30 minutes otherwise. A request reads
 * at most two chains from the engine (the expiry list comes with the default chain, which counts as one);
 * the rest come from the cache, so a full outlook costs about two Upstox calls a minute at most. When a
 * refresh fails, the last good chain for that expiry is kept and marked stale. Concurrent requests for the
 * same index share one load.
 */
import type { IndexId, OptionChainView, ScheduledEventView } from "@/engine/api-types";
import { istParts, SESSION } from "@/lib/ist";
import { buildOutlook, OUTLOOK_EVENT_HOURS, OUTLOOK_HORIZON_DAYS, outlookExpiries, type ChainReading, type OptionOutlookView, type OutlookCalendar } from "./outlook";

export const TTL_OPEN_MS = 5 * 60_000;
export const TTL_CLOSED_MS = 30 * 60_000;
/** Engine chain reads per request, the default chain (for the expiry list) included. */
export const MAX_READS_PER_REQUEST = 2;
/** A chain read that failed is not retried sooner than this. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** Each chain read gives up after this long (the row keeps its previous figures). */
export const READ_TIMEOUT_MS = 8_000;

/** The engine methods the outlook uses. */
export interface OutlookEngine {
  getOptionChain(index: IndexId, expiry?: string): Promise<OptionChainView>;
  getScheduled(hours: number): Promise<ScheduledEventView[]>;
}

interface Entry {
  /** Last good chain and the wall-clock time it was read. */
  chain: OptionChainView | null;
  at: number;
  /** Latest failed read: when and why (cleared by a good read). */
  failedAt: number | null;
  error: string | null;
}

interface ListEntry {
  expiries: string[];
  at: number;
  /** Engine clock minus wall clock at that read, rounded to the minute (the mock runs a simulated clock). */
  offsetMs: number;
}

export interface OutlookCacheOptions {
  calendar: OutlookCalendar & { isTradingDay(date: string): boolean };
  /** Wall clock (injected for tests). */
  now?: () => number;
  maxReads?: number;
  horizonDays?: number;
  timeoutMs?: number;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/** Market hours on the engine's clock, holidays included. */
export function inSession(engineMs: number, calendar: { isTradingDay(date: string): boolean }): boolean {
  const p = istParts(engineMs);
  return calendar.isTradingDay(p.date) && p.minutesOfDay >= SESSION.open && p.minutesOfDay < SESSION.close;
}

export class OutlookCache {
  private readonly chains = new Map<string, Entry>();
  private readonly lists = new Map<IndexId, ListEntry>();
  private events: { data: ScheduledEventView[]; at: number } | null = null;
  private eventsFailedAt: number | null = null;
  private readonly running = new Map<IndexId, Promise<OptionOutlookView>>();
  private readonly now: () => number;
  private readonly maxReads: number;
  private readonly horizonDays: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OutlookCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.maxReads = opts.maxReads ?? MAX_READS_PER_REQUEST;
    this.horizonDays = opts.horizonDays ?? OUTLOOK_HORIZON_DAYS;
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** The outlook for an index; concurrent calls for the same index share one load. */
  get(index: IndexId, engine: OutlookEngine): Promise<OptionOutlookView> {
    const inFlight = this.running.get(index);
    if (inFlight) return inFlight;
    const p = this.load(index, engine).finally(() => this.running.delete(index));
    this.running.set(index, p);
    return p;
  }

  private ttl(engineMs: number): number {
    return inSession(engineMs, this.opts.calendar) ? TTL_OPEN_MS : TTL_CLOSED_MS;
  }

  private key(index: IndexId, expiry: string) {
    return `${index}|${expiry}`;
  }

  /** Stores a read: a good chain replaces the entry; a failure keeps the last good chain. */
  private store(index: IndexId, expiry: string, chain: OptionChainView | null, error: string | null, wall: number) {
    const k = this.key(index, expiry);
    const prev = this.chains.get(k);
    if (chain && !error) this.chains.set(k, { chain, at: wall, failedAt: null, error: null });
    else this.chains.set(k, { chain: prev?.chain ?? null, at: prev?.at ?? 0, failedAt: wall, error: error ?? "The chain could not be read." });
  }

  /** Why a chain cannot be used for `expiry`, or null when it can. */
  private static problem(chain: OptionChainView, expiry: string | null): string | null {
    if (expiry && chain.expiry !== expiry) return `The engine answered with the ${chain.expiry} chain instead of ${expiry}.`;
    if (chain.error) return chain.error;
    if (chain.rows.length === 0) return "The chain came back with no strikes.";
    return null;
  }

  private async load(index: IndexId, engine: OutlookEngine): Promise<OptionOutlookView> {
    const wall = this.now();
    let reads = 0;
    let listError: string | null = null;
    let list = this.lists.get(index);
    const ttl = this.ttl(wall + (list?.offsetMs ?? 0));

    // 1. The expiry list comes with the default (nearest) chain.
    if (!list || wall - list.at >= ttl) {
      reads++;
      try {
        const chain = await withTimeout(engine.getOptionChain(index), this.timeoutMs, "The engine");
        const engineMs = Date.parse(chain.fetchedAt);
        const offsetMs = Number.isFinite(engineMs) ? Math.round((engineMs - wall) / 60_000) * 60_000 : (list?.offsetMs ?? 0);
        if (chain.expiries.length > 0) {
          list = { expiries: [...chain.expiries], at: wall, offsetMs };
          this.lists.set(index, list);
        } else if (chain.error) listError = chain.error;
        if (chain.expiry) this.store(index, chain.expiry, chain, OutlookCache.problem(chain, null), wall);
      } catch (err) {
        listError = message(err);
      }
    }

    // 2. Events (one list for both indices).
    const engineNow = wall + (list?.offsetMs ?? 0);
    const due = !this.events || wall - this.events.at >= this.ttl(engineNow);
    const retryEvents = this.eventsFailedAt == null || wall - this.eventsFailedAt >= RETRY_AFTER_FAILURE_MS;
    const eventsRead = due && retryEvents ? this.readEvents(engine, wall) : Promise.resolve();

    if (!list) {
      await eventsRead;
      return buildOutlook({
        index,
        nowMs: engineNow,
        listed: [],
        readings: new Map(),
        scheduled: this.events?.data ?? null,
        calendar: this.opts.calendar,
        horizonDays: this.horizonDays,
        error: `The engine did not list any ${index} expiries${listError ? `: ${listError}` : "."}`,
      });
    }

    // 3. Refresh the stalest expiries in the horizon, missing ones first, nearest first.
    const targets = outlookExpiries(list.expiries, engineNow, index, this.opts.calendar, this.horizonDays).map((t) => t.expiry);
    const ttlNow = this.ttl(engineNow);
    const stale = targets
      .map((expiry) => ({ expiry, e: this.chains.get(this.key(index, expiry)) }))
      .filter(({ e }) => {
        if (!e) return true;
        if (e.failedAt != null && wall - e.failedAt < RETRY_AFTER_FAILURE_MS) return false;
        return !e.chain || wall - e.at >= ttlNow;
      })
      .sort((a, b) => (a.e?.chain ? a.e.at : -1) - (b.e?.chain ? b.e.at : -1) || a.expiry.localeCompare(b.expiry))
      .slice(0, Math.max(0, this.maxReads - reads));

    await Promise.all([
      eventsRead,
      ...stale.map(async ({ expiry }) => {
        try {
          const chain = await withTimeout(engine.getOptionChain(index, expiry), this.timeoutMs, "The engine");
          const problem = OutlookCache.problem(chain, expiry);
          this.store(index, expiry, problem ? null : chain, problem, wall);
        } catch (err) {
          this.store(index, expiry, null, message(err), wall);
        }
      }),
    ]);

    const readings = new Map<string, ChainReading>();
    for (const expiry of targets) {
      const e = this.chains.get(this.key(index, expiry));
      if (e) readings.set(expiry, { chain: e.chain, error: e.error });
    }
    return buildOutlook({
      index,
      nowMs: engineNow,
      listed: list.expiries,
      readings,
      scheduled: this.events?.data ?? null,
      calendar: this.opts.calendar,
      horizonDays: this.horizonDays,
      error: listError ? `The expiry list could not be refreshed (${listError}); showing the last one.` : null,
    });
  }

  private async readEvents(engine: OutlookEngine, wall: number): Promise<void> {
    try {
      const data = await withTimeout(engine.getScheduled(OUTLOOK_EVENT_HOURS), this.timeoutMs, "The engine");
      this.events = { data: Array.isArray(data) ? data : [], at: wall };
      this.eventsFailedAt = null;
    } catch {
      // Keep the last good list (if any); without one the outlook says events are not available.
      this.eventsFailedAt = wall;
    }
  }
}
