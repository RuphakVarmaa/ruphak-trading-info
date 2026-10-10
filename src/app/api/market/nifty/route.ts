import { NextResponse } from "next/server";
import { getNiftyCharts } from "@/lib/market/liveSource";
import { buildNiftyFeed, type NiftyFeed } from "@/lib/market/niftyFeed";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/** Several open pages share one feed per 1.5 s per expiry; this isolate's memory only. */
const CACHE_MS = 1500;
/** When Yahoo fails, the last good feed is served for up to a minute (its own as-of time shows its age). */
const STALE_OK_MS = 60_000;
const cache = new Map<string, { at: number; data: NiftyFeed }>();

const reply = (data: NiftyFeed, at: number) => NextResponse.json({ ok: true, data, generatedAt: new Date(at).toISOString() }, { headers: NO_STORE });

/**
 * GET /api/market/nifty?expiry=YYYY-MM-DD -> NIFTY 50 1-minute feed, India VIX and the model option chain.
 * The Yahoo charts and NIFTY's previous close (daily chart, calendar-checked; never the 1-minute
 * meta.previousClose) come from the same shared fetch as /api/market/live (src/lib/market/liveSource.ts).
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("expiry");
  const want = raw && EXPIRY.test(raw) ? raw : null;
  const key = want ?? "default";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return reply(hit.data, hit.at);

  const { nifty, vix, prevClose, dayRange, error } = await getNiftyCharts();
  const feed = nifty ? buildNiftyFeed(nifty, vix, prevClose, Date.now(), want, dayRange) : null;
  if (!feed) {
    if (hit && Date.now() - hit.at < STALE_OK_MS) return reply(hit.data, hit.at);
    const why = error ?? "no NIFTY price in the response";
    return NextResponse.json({ ok: false, code: "ENGINE_UNREACHABLE", error: `Yahoo did not return a NIFTY price: ${why}` }, { status: 502, headers: NO_STORE });
  }
  const at = Date.now();
  cache.set(key, { at, data: feed });
  return reply(feed, at);
}
