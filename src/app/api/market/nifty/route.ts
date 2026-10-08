import { NextResponse } from "next/server";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { fetchYahooChart, type YahooChart } from "@/engine/market/yahooClient";
import { MARKET_SYMBOLS } from "@/engine/types";
import { buildNiftyFeed, niftySession, prevSessionClose, type NiftyFeed } from "@/lib/market/niftyFeed";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/** Several open pages share one Yahoo fetch per 1.5 s per expiry; this isolate's memory only. */
const CACHE_MS = 1500;
/** When Yahoo fails, the last good feed is served for up to a minute (its own as-of time shows its age). */
const STALE_OK_MS = 60_000;
const cache = new Map<string, { at: number; data: NiftyFeed }>();

/** The prior session's close does not change intraday: the daily chart is read again after 10 minutes. */
const PREV_CLOSE_TTL_MS = 10 * 60_000;
/** While the daily chart lacks the prior session's bar, it is read again after a minute. */
const PREV_CLOSE_RETRY_MS = 60_000;
let prevClose: { session: string; value: number | null; at: number } | null = null;

const fetchDaily = () => fetchYahooChart(MARKET_SYMBOLS.NIFTY, { interval: "1d", range: "1mo", timeoutMs: 8000 });

const prevCloseDue = (now: number) =>
  !prevClose || now - prevClose.at >= (prevClose.value !== null ? PREV_CLOSE_TTL_MS : PREV_CLOSE_RETRY_MS);

/**
 * The previous session's close for `session`: from the daily chart read in this request (read now if the
 * cached value belongs to another session), else the cached value for the same session, else null.
 * Never Yahoo's meta.previousClose (two sessions old on the 1-minute chart).
 */
async function resolvePrevClose(session: string, daily: PromiseSettledResult<YahooChart | null>, now: number): Promise<number | null> {
  let chart = daily.status === "fulfilled" ? daily.value : null;
  if (daily.status === "fulfilled" && chart === null && prevClose?.session !== session) chart = await fetchDaily().catch(() => null);
  const cached = prevClose?.session === session ? prevClose.value : null;
  if (!chart) return cached;
  const value = prevSessionClose(chart, session, defaultCalendar) ?? cached;
  prevClose = { session, value, at: now };
  return value;
}

const reply = (data: NiftyFeed, at: number) => NextResponse.json({ ok: true, data, generatedAt: new Date(at).toISOString() }, { headers: NO_STORE });

/** GET /api/market/nifty?expiry=YYYY-MM-DD -> NIFTY 50 1-minute feed, India VIX and the model option chain. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("expiry");
  const want = raw && EXPIRY.test(raw) ? raw : null;
  const key = want ?? "default";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return reply(hit.data, hit.at);

  const now = Date.now();
  const [nifty, vix, daily] = await Promise.allSettled([
    fetchYahooChart(MARKET_SYMBOLS.NIFTY, { interval: "1m", range: "1d", timeoutMs: 8000 }),
    fetchYahooChart(MARKET_SYMBOLS.INDIAVIX, { interval: "1m", range: "1d", timeoutMs: 8000 }),
    prevCloseDue(now) ? fetchDaily() : Promise.resolve(null),
  ]);
  let feed: NiftyFeed | null = null;
  if (nifty.status === "fulfilled") {
    const session = niftySession(nifty.value);
    const prev = session ? await resolvePrevClose(session, daily, now) : null;
    feed = buildNiftyFeed(nifty.value, vix.status === "fulfilled" ? vix.value : null, prev, Date.now(), want);
  }
  if (!feed) {
    if (hit && Date.now() - hit.at < STALE_OK_MS) return reply(hit.data, hit.at);
    const why = nifty.status === "rejected" ? String(nifty.reason instanceof Error ? nifty.reason.message : nifty.reason) : "no NIFTY price in the response";
    return NextResponse.json({ ok: false, code: "ENGINE_UNREACHABLE", error: `Yahoo did not return a NIFTY price: ${why}` }, { status: 502, headers: NO_STORE });
  }
  const at = Date.now();
  cache.set(key, { at, data: feed });
  return reply(feed, at);
}
