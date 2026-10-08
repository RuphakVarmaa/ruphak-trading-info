/**
 * The one upstream poll behind GET /api/market/live (server only; module memory, so one per isolate):
 * Yahoo's 1-minute charts of ^NSEI, ^BSESN and ^INDIAVIX, plus their daily charts for the previous closes.
 *
 * - Requests that arrive while a fetch is running wait for it instead of starting another.
 * - A finished fetch (good or not) is reused for 1.5 s while the market is open or in pre-open by the
 *   exchange calendar, and for 60 s otherwise.
 * - A symbol that fails is served from its last good value for up to 2 minutes, marked stale; after that it
 *   is listed in `missing`. With no index left the caller answers 502.
 * - Previous closes come from the daily charts (calendar-checked, see prevSessionClose), re-read every
 *   10 minutes (every minute while unknown) and at once when the last price moves to a new day.
 */
import { defaultCalendar, type TradingCalendar } from "@/engine/calendar/calendar";
import { istDate, istIso } from "@/engine/clock";
import { fetchYahooChart, type YahooChart } from "@/engine/market/yahooClient";
import { buildLiveIndex, buildLiveVix, LIVE_INDEX_IDS, LIVE_INDEX_SPECS, LIVE_SOURCE, quoteSession, VIX_SYMBOL, type LiveChart } from "./liveFeed";
import type { LiveIndex, LiveIndexId, LiveIndicesFeed, LiveVix } from "./liveIndices";
import { prevSessionClose, type DayRange } from "./niftyFeed";

/** Reuse of a finished fetch while the market is open or in pre-open, and otherwise. */
export const LIVE_TTL_MS = 1500;
export const IDLE_TTL_MS = 60_000;
/** How long a symbol's last good value may stand in for a failed fetch. */
export const STALE_OK_MS = 2 * 60_000;
/** The previous close does not change intraday: its daily chart is read again after 10 minutes (1 minute while unknown). */
export const PREV_CLOSE_TTL_MS = 10 * 60_000;
export const PREV_CLOSE_RETRY_MS = 60_000;
/** Per-chart timeout; a request never waits longer than WAIT_MS for a running fetch. */
const FETCH_TIMEOUT_MS = 5000;
const DAY_TURN_TIMEOUT_MS = 3000;
const WAIT_MS = 9000;
/**
 * A fetch still running after this is treated as lost and a new one starts. (On Workers, a fetch whose
 * starting request has ended can be cancelled without ever settling.)
 */
const STUCK_MS = 15_000;

type Key = LiveIndexId | "VIX";
const KEYS: readonly Key[] = ["NIFTY", "SENSEX", "VIX"];
const SYMBOL: Record<Key, string> = { NIFTY: LIVE_INDEX_SPECS.NIFTY.symbol, SENSEX: LIVE_INDEX_SPECS.SENSEX.symbol, VIX: VIX_SYMBOL };

export interface LiveSourceOptions {
  /** Request time (tests); default Date.now(). */
  nowMs?: number;
  fetchImpl?: typeof fetch;
  calendar?: TradingCalendar;
  /** Longest wait for a running fetch (tests); default 9 s. */
  waitMs?: number;
}

export type LiveFeedResult = { ok: true; feed: LiveIndicesFeed } | { ok: false; error: string };

interface Good<T> {
  value: T;
  /** The 1-minute chart it was built from (shared with the NIFTY route), with Yahoo's day range. */
  chart: YahooChart;
  dayRange: DayRange;
  prevClose: number | null;
  /** Start time of the fetch that loaded it. */
  at: number;
}

interface State {
  /** Start time of the latest finished fetch. */
  fetchedAt: number | null;
  /** Why each symbol failed in the latest finished fetch. */
  errors: Partial<Record<Key, string>>;
  indices: Partial<Record<LiveIndexId, Good<LiveIndex>>>;
  vix: Good<LiveVix> | null;
  prev: Partial<Record<Key, { session: string; value: number | null; at: number }>>;
  inflight: Promise<void> | null;
  /** Start time of the running fetch. */
  inflightAt: number;
}

const fresh = (): State => ({ fetchedAt: null, errors: {}, indices: {}, vix: null, prev: {}, inflight: null, inflightAt: 0 });
let state: State = fresh();

/** Forgets every cached value (tests only). */
export function __resetLiveSourceForTests(): void {
  state = fresh();
}

const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The meta object of a chart v8 response body, or null. */
function metaOf(text: string): Record<string, unknown> | null {
  try {
    const meta = (JSON.parse(text) as { chart?: { result?: { meta?: unknown }[] } })?.chart?.result?.[0]?.meta;
    return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A 1-minute chart (range 1d) through the engine's Yahoo client (browser User-Agent, timeouts, errors),
 * keeping Yahoo's day high and low from the meta, which the shared parser drops.
 */
export async function fetchLiveChart(symbol: string, fetchImpl?: typeof fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<LiveChart> {
  let meta: Record<string, unknown> | null = null;
  const tap = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = fetchImpl ?? fetch;
    const res = await base(input, init);
    const text = await res.text();
    meta = metaOf(text);
    return new Response(text, { status: res.status, statusText: res.statusText });
  }) as typeof fetch;
  const chart = await fetchYahooChart(symbol, { interval: "1m", range: "1d", timeoutMs, fetchImpl: tap });
  const m = meta as Record<string, unknown> | null;
  return { chart, dayHigh: finite(m?.regularMarketDayHigh), dayLow: finite(m?.regularMarketDayLow) };
}

const fetchDaily = (key: Key, fetchImpl: typeof fetch | undefined, timeoutMs = FETCH_TIMEOUT_MS) =>
  fetchYahooChart(SYMBOL[key], { interval: "1d", range: "1mo", timeoutMs, fetchImpl });

const prevDue = (key: Key, now: number): boolean => {
  const c = state.prev[key];
  return !c || now - c.at >= (c.value !== null ? PREV_CLOSE_TTL_MS : PREV_CLOSE_RETRY_MS);
};

/**
 * The close before `session` for one symbol: from the daily chart read in this fetch (read now if the
 * cached close is for another day), else the cached close for the same day, else null.
 */
async function resolvePrevClose(
  key: Key,
  session: string,
  daily: PromiseSettledResult<YahooChart | null>,
  now: number,
  fetchImpl: typeof fetch | undefined,
  calendar: TradingCalendar,
): Promise<number | null> {
  const cached = state.prev[key];
  const sameDay = cached?.session === session ? cached.value : null;
  let chart = daily.status === "fulfilled" ? daily.value : null;
  if (daily.status === "fulfilled" && chart === null && cached?.session !== session) {
    chart = await fetchDaily(key, fetchImpl, DAY_TURN_TIMEOUT_MS).catch(() => null);
  }
  if (!chart) return sameDay;
  const value = prevSessionClose(chart, session, calendar) ?? sameDay;
  state.prev[key] = { session, value, at: now };
  return value;
}

type Loaded = { key: Key; chart: LiveChart; prevClose: number | null; value: LiveIndex | LiveVix } | { key: Key; error: string };

async function loadOne(key: Key, intraday: Promise<LiveChart>, daily: Promise<YahooChart | null>, now: number, fetchImpl: typeof fetch | undefined, calendar: TradingCalendar): Promise<Loaded> {
  const [chart, dailyResult] = await Promise.allSettled([intraday, daily]);
  if (chart.status === "rejected") return { key, error: messageOf(chart.reason) };
  const session = quoteSession(chart.value.chart);
  const prevClose = session ? await resolvePrevClose(key, session, dailyResult, now, fetchImpl, calendar) : null;
  const value = key === "VIX" ? buildLiveVix(chart.value.chart, prevClose) : buildLiveIndex(key, chart.value, prevClose);
  return value ? { key, chart: chart.value, prevClose, value } : { key, error: "no price in the response" };
}

async function refresh(now: number, fetchImpl: typeof fetch | undefined, calendar: TradingCalendar): Promise<void> {
  const daily = KEYS.map((k) => (prevDue(k, now) ? fetchDaily(k, fetchImpl) : Promise.resolve(null)));
  const results = await Promise.all(KEYS.map((k, i) => loadOne(k, fetchLiveChart(SYMBOL[k], fetchImpl), daily[i], now, fetchImpl, calendar)));
  // A fetch given up as lost that finishes after a newer one must not overwrite it.
  if (state.fetchedAt !== null && state.fetchedAt > now) return;
  const errors: State["errors"] = {};
  for (const r of results) {
    if ("error" in r) {
      errors[r.key] = r.error;
      continue;
    }
    const good = { chart: r.chart.chart, dayRange: { high: r.chart.dayHigh, low: r.chart.dayLow }, prevClose: r.prevClose, at: now };
    if (r.key === "VIX") state.vix = { ...good, value: r.value as LiveVix };
    else state.indices[r.key] = { ...good, value: r.value as LiveIndex };
  }
  state.errors = errors;
  state.fetchedAt = now;
}

const ttlAt = (now: number, calendar: TradingCalendar): number => {
  const phase = calendar.sessionPhase(now);
  return phase === "OPEN" || phase === "PRE_OPEN" ? LIVE_TTL_MS : IDLE_TTL_MS;
};

/** Starts a fetch unless a recent one can be reused or one is running, and waits for it (at most `waitMs`). */
async function ensureFresh(now: number, fetchImpl: typeof fetch | undefined, calendar: TradingCalendar, waitMs = WAIT_MS): Promise<void> {
  if (state.fetchedAt !== null && now - state.fetchedAt < ttlAt(now, calendar)) return;
  if (!state.inflight || now - state.inflightAt > STUCK_MS) {
    const run: Promise<void> = refresh(now, fetchImpl, calendar)
      .catch((err) => {
        if (state.fetchedAt !== null && state.fetchedAt > now) return;
        state.errors = Object.fromEntries(KEYS.map((k) => [k, messageOf(err)]));
        state.fetchedAt = now;
      })
      .finally(() => {
        if (state.inflight === run) state.inflight = null;
      });
    state.inflight = run;
    state.inflightAt = now;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([state.inflight, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}

/** Plain-language reason for an upstream error message (none yet: the first fetch is still running). */
export function plainReason(message: string | undefined): string {
  if (!message || /timed out|timeout|aborted/i.test(message)) return "it did not answer in time";
  if (/HTTP 429/.test(message)) return "it is limiting requests";
  if (/HTTP 5\d\d/.test(message)) return "it reported a server error";
  if (/HTTP 4\d\d/.test(message)) return "it refused the request";
  if (/no price/i.test(message)) return "its response had no price";
  return "the request failed";
}

/** The payload for a request at `now` from what the latest fetches loaded; an error when no index is left. */
function compose(now: number, calendar: TradingCalendar): LiveFeedResult {
  const usable = <T>(g: Good<T> | null | undefined): g is Good<T> => g != null && now - g.at <= STALE_OK_MS;
  const marks = (g: Good<unknown>) => ({ stale: g.at !== state.fetchedAt, fetchedAt: new Date(g.at).toISOString() });
  const indices: LiveIndex[] = [];
  const missing: LiveIndexId[] = [];
  let newest = -Infinity;
  for (const id of LIVE_INDEX_IDS) {
    const g = state.indices[id];
    if (!usable(g)) {
      missing.push(id);
      continue;
    }
    indices.push({ ...g.value, ...marks(g) });
    newest = Math.max(newest, g.at);
  }
  if (indices.length === 0) {
    const hadGood = LIVE_INDEX_IDS.some((id) => state.indices[id] != null);
    const why = plainReason(state.errors.NIFTY ?? state.errors.SENSEX);
    return {
      ok: false,
      error: hadGood
        ? `Yahoo Finance has not returned NIFTY 50 or SENSEX prices for over 2 minutes: ${why}.`
        : `Yahoo Finance did not return NIFTY 50 or SENSEX prices: ${why}.`,
    };
  }
  const vix = usable(state.vix) ? { ...state.vix.value, ...marks(state.vix) } : null;
  const phase = calendar.sessionPhase(now);
  let nextOpenAt: string | undefined;
  try {
    nextOpenAt = istIso(calendar.nextOpenMs(now));
  } catch {
    nextOpenAt = undefined; // no trading day within 30 days
  }
  return {
    ok: true,
    feed: {
      indices,
      vix,
      marketPhase: phase,
      source: LIVE_SOURCE,
      generatedAt: new Date(now).toISOString(),
      fetchedAt: new Date(newest).toISOString(),
      stale: indices.every((i) => i.stale),
      missing,
      holidayName: phase === "HOLIDAY" ? calendar.holidayName(istDate(now)) : null,
      ...(nextOpenAt ? { nextOpenAt } : {}),
    },
  };
}

/** The live feed for a request now: one shared upstream fetch per isolate (see the module comment). */
export async function getLiveFeed(opts: LiveSourceOptions = {}): Promise<LiveFeedResult> {
  const calendar = opts.calendar ?? defaultCalendar;
  await ensureFresh(opts.nowMs ?? Date.now(), opts.fetchImpl, calendar, opts.waitMs);
  return compose(opts.nowMs ?? Date.now(), calendar);
}

export interface NiftyCharts {
  /** ^NSEI 1-minute chart from the latest shared fetch; null when that fetch failed for it. */
  nifty: YahooChart | null;
  vix: YahooChart | null;
  /** NIFTY's previous close for the day of its last price (daily chart, calendar-checked). */
  prevClose: number | null;
  /** Yahoo's day high and low for NIFTY's last trade day (see checkedDayRange). */
  dayRange: DayRange | null;
  /** Why NIFTY failed in the latest fetch. */
  error: string | null;
}

/** For GET /api/market/nifty: NIFTY and India VIX from the same shared fetch (no stale carry: that route has its own). */
export async function getNiftyCharts(opts: LiveSourceOptions = {}): Promise<NiftyCharts> {
  await ensureFresh(opts.nowMs ?? Date.now(), opts.fetchImpl, opts.calendar ?? defaultCalendar, opts.waitMs);
  const latest = <T>(g: Good<T> | null | undefined): Good<T> | null => (g != null && g.at === state.fetchedAt ? g : null);
  const nifty = latest(state.indices.NIFTY);
  return {
    nifty: nifty?.chart ?? null,
    vix: latest(state.vix)?.chart ?? null,
    prevClose: nifty?.prevClose ?? null,
    dayRange: nifty?.dayRange ?? null,
    error: nifty ? null : (state.errors.NIFTY ?? "no NIFTY price in the response"),
  };
}
