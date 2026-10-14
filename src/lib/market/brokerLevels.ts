/**
 * The broker side of GET /api/market/live: the engine's live index levels (Upstox LTP, see
 * EngineApi.getLiveIndices) laid over the Yahoo feed from ./liveSource.
 *
 * - Per index (and India VIX): a broker level read at most BROKER_MAX_AGE_MS ago wins for the price, the
 *   previous close (Yahoo's when the broker has none), the change and the day's open/high/low; its `asOf`
 *   and `fetchedAt` are the time the engine read the broker, so the "no new trade" check stays quiet while
 *   that feed is live. Yahoo's bars, VWAP and opening range stay (the broker sends no bars).
 * - A missing, empty, failed or stale broker answer leaves that index exactly as Yahoo built it.
 * - With no Yahoo index at all, broker levels alone still make a payload (no bars).
 *
 * getBrokerLevels shares one engine call per isolate (reused for BROKER_TTL_MS, never waited on longer
 * than BROKER_TIMEOUT_MS); mergeBrokerLevels is pure.
 */
import type { LiveIndexLevelsView } from "@/engine/api-types";
import { defaultCalendar, type TradingCalendar } from "@/engine/calendar/calendar";
import { istDate, istIso } from "@/engine/clock";
import { LIVE_INDEX_IDS, LIVE_INDEX_SPECS, LIVE_SOURCE } from "./liveFeed";
import {
  BROKER_MAX_AGE_MS,
  BROKER_SOURCE,
  MOCK_BROKER_SOURCE,
  type LiveBrokerStatus,
  type LiveIndex,
  type LiveIndexId,
  type LiveIndicesFeed,
  type LiveQuoteFeed,
  type LiveVix,
} from "./liveIndices";
import type { LiveFeedResult } from "./liveSource";

/** Longest wait for the engine's answer, and how long one answer is reused. */
export const BROKER_TIMEOUT_MS = 1500;
export const BROKER_TTL_MS = 1000;

export type BrokerResult = { ok: true; view: LiveIndexLevelsView } | { ok: false; error: string };
type Level = LiveIndexLevelsView["levels"][number];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let cache: { at: number; result: BrokerResult } | null = null;
let inflight: { at: number; promise: Promise<BrokerResult> } | null = null;

/** Forgets the cached broker answer (tests only). */
export function __resetBrokerLevelsForTests(): void {
  cache = null;
  inflight = null;
}

/**
 * The engine's live index levels, shared per isolate: an answer is reused for BROKER_TTL_MS, a running call
 * is joined, and a call that takes longer than `timeoutMs` reads as a failure (it may still fill the cache).
 */
export async function getBrokerLevels(load: () => Promise<LiveIndexLevelsView>, opts: { nowMs?: number; timeoutMs?: number } = {}): Promise<BrokerResult> {
  const now = opts.nowMs ?? Date.now();
  if (cache && now - cache.at >= 0 && now - cache.at < BROKER_TTL_MS) return cache.result;
  if (!inflight || now - inflight.at > 10_000) {
    const started = now;
    const promise: Promise<BrokerResult> = (async (): Promise<BrokerResult> => {
      try {
        return { ok: true, view: await load() };
      } catch (err) {
        return { ok: false, error: messageOf(err) };
      }
    })().then((result) => {
      if (!cache || cache.at <= started) cache = { at: started, result };
      if (inflight?.promise === promise) inflight = null;
      return result;
    });
    inflight = { at: started, promise };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BrokerResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "the engine did not answer in time" }), opts.timeoutMs ?? BROKER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([inflight.promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const positive = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

const BROKER_KEY: Record<LiveIndexId | "VIX", Level["key"]> = { NIFTY: "NIFTY", SENSEX: "SENSEX", VIX: "INDIAVIX" };

interface UsableBroker {
  view: LiveIndexLevelsView;
  at: number;
  feed: Exclude<LiveQuoteFeed, "yahoo">;
  source: string;
}

/** The broker answer when its levels may be used at `now` (read at most BROKER_MAX_AGE_MS ago), plus its status for the payload. */
function judge(broker: BrokerResult | null, now: number): { usable: UsableBroker | null; status: LiveBrokerStatus | undefined } {
  if (!broker) return { usable: null, status: undefined };
  if (!broker.ok) return { usable: null, status: { status: "error", fetchedAt: null, error: broker.error } };
  const view = broker.view;
  const at = Date.parse(view.fetchedAt);
  const fetchedAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
  if (!Array.isArray(view.levels) || view.levels.length === 0 || !Number.isFinite(at)) {
    return { usable: null, status: { status: "error", fetchedAt, error: view.error ?? "the broker sent no levels" } };
  }
  if (now - at > BROKER_MAX_AGE_MS) {
    return { usable: null, status: { status: "stale", fetchedAt, error: view.error ?? `the broker levels are ${Math.round((now - at) / 1000)} s old` } };
  }
  const feed = view.source === "mock" ? "mock" : "upstox";
  return { usable: { view, at, feed, source: feed === "mock" ? MOCK_BROKER_SOURCE : BROKER_SOURCE }, status: { status: "live", fetchedAt, error: view.error ?? null } };
}

function levelOf(b: UsableBroker | null, key: LiveIndexId | "VIX"): Level | null {
  const l = b?.view.levels.find((x) => x.key === BROKER_KEY[key]);
  return l && positive(l.price) ? l : null;
}

const YAHOO = { feed: "yahoo" as const, source: LIVE_SOURCE };

/** One index from a broker level over Yahoo's entry (if any). Yahoo's bars stay unless the session has turned. */
function brokerIndex(id: LiveIndexId, l: Level, b: UsableBroker, yahoo: LiveIndex | undefined, open: boolean): LiveIndex {
  const price = round2(l.price);
  const ownPrev = positive(l.prevClose);
  const prev = ownPrev ? round2(l.prevClose as number) : (yahoo?.prevClose ?? null);
  const session = istDate(b.at);
  // While the market is open, Yahoo's bars from an earlier session do not belong to the broker's price.
  const keepBars = yahoo != null && (yahoo.session === session || !open);
  const base: LiveIndex = keepBars
    ? { ...yahoo }
    : { index: id, label: LIVE_INDEX_SPECS[id].label, symbol: LIVE_INDEX_SPECS[id].symbol, price, prevClose: null, change: null, changePct: null, open: null, high: null, low: null, vwap: null, openingRange: null, session, asOf: "", bars: [] };
  const { prevCloseSource: _drop, ...rest } = base;
  void _drop;
  const prevCloseSource = ownPrev ? "broker" : yahoo?.prevCloseSource;
  return {
    ...rest,
    price,
    prevClose: prev,
    ...(prev != null && prevCloseSource ? { prevCloseSource } : {}),
    change: prev != null ? round2(price - prev) : null,
    changePct: prev != null ? round3(((price - prev) / prev) * 100) : null,
    open: positive(l.open) ? round2(l.open) : base.open,
    high: positive(l.high) ? round2(Math.max(l.high, price)) : base.high,
    low: positive(l.low) ? round2(Math.min(l.low, price)) : base.low,
    asOf: istIso(b.at),
    stale: false,
    fetchedAt: new Date(b.at).toISOString(),
    feed: b.feed,
    source: b.source,
  };
}

function brokerVix(l: Level, b: UsableBroker, yahoo: LiveVix | null): LiveVix {
  const price = round4(l.price);
  const ownPrev = positive(l.prevClose);
  const prev = ownPrev ? round4(l.prevClose as number) : (yahoo?.prevClose ?? null);
  const prevCloseSource = ownPrev ? "broker" : yahoo?.prevCloseSource;
  return {
    price,
    prevClose: prev,
    ...(prev != null && prevCloseSource ? { prevCloseSource } : {}),
    change: prev != null ? round4(price - prev) : null,
    changePct: prev != null ? round3(((price - prev) / prev) * 100) : null,
    asOf: istIso(b.at),
    stale: false,
    fetchedAt: new Date(b.at).toISOString(),
    feed: b.feed,
    source: b.source,
  };
}

/** The payload's source line: one feed's own label, or both when the indices came from different feeds. */
function sourceLine(indices: LiveIndex[], yahooSource: string): string {
  const fromBroker = indices.filter((i) => i.feed === "upstox" || i.feed === "mock");
  if (fromBroker.length === 0) return yahooSource;
  const brokerSource = fromBroker[0].source ?? BROKER_SOURCE;
  const fromYahoo = indices.filter((i) => !fromBroker.includes(i));
  if (fromYahoo.length === 0) return brokerSource;
  return `${brokerSource} · ${fromYahoo.map((i) => i.label).join(", ")}: ${yahooSource}`;
}

export interface MergeOptions {
  /** Request time; default Date.now(). */
  nowMs?: number;
  calendar?: TradingCalendar;
}

/**
 * The /api/market/live payload from the Yahoo feed and the broker's answer (null: not asked). Pure apart
 * from the clock. Fails only when neither has an index.
 */
export function mergeBrokerLevels(yahoo: LiveFeedResult, broker: BrokerResult | null, opts: MergeOptions = {}): LiveFeedResult {
  const now = opts.nowMs ?? Date.now();
  const calendar = opts.calendar ?? defaultCalendar;
  const { usable, status } = judge(broker, now);
  const base = yahoo.ok ? yahoo.feed : null;
  const phase = base?.marketPhase ?? calendar.sessionPhase(now);
  const indices: LiveIndex[] = [];
  const missing: LiveIndexId[] = [];
  for (const id of LIVE_INDEX_IDS) {
    const y = base?.indices.find((i) => i.index === id);
    const l = levelOf(usable, id);
    if (l && usable) indices.push(brokerIndex(id, l, usable, y, phase === "OPEN"));
    else if (y) indices.push({ ...YAHOO, ...y });
    else missing.push(id);
  }
  if (indices.length === 0) {
    if (!yahoo.ok) return yahoo;
    return { ok: true, feed: { ...yahoo.feed, ...(status ? { broker: status } : {}) } };
  }
  const vixLevel = levelOf(usable, "VIX");
  const vix = vixLevel && usable ? brokerVix(vixLevel, usable, base?.vix ?? null) : base?.vix ? { ...YAHOO, ...base.vix } : null;
  const fetched = indices.map((i) => Date.parse(i.fetchedAt ?? base?.fetchedAt ?? "")).filter(Number.isFinite);
  let nextOpenAt = base?.nextOpenAt;
  if (!base) {
    try {
      nextOpenAt = istIso(calendar.nextOpenMs(now));
    } catch {
      nextOpenAt = undefined; // no trading day within 30 days
    }
  }
  const feed: LiveIndicesFeed = {
    indices,
    vix,
    marketPhase: phase,
    source: sourceLine(indices, base?.source ?? LIVE_SOURCE),
    generatedAt: base?.generatedAt ?? new Date(now).toISOString(),
    fetchedAt: fetched.length > 0 ? new Date(Math.max(...fetched)).toISOString() : (base?.fetchedAt ?? new Date(now).toISOString()),
    stale: indices.every((i) => i.stale === true),
    missing,
    holidayName: base ? (base.holidayName ?? null) : phase === "HOLIDAY" ? calendar.holidayName(istDate(now)) : null,
    ...(nextOpenAt ? { nextOpenAt } : {}),
    ...(status ? { broker: status } : {}),
  };
  return { ok: true, feed };
}
