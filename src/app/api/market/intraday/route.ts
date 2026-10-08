import { NextResponse } from "next/server";
import { fetchYahooChart } from "@/engine/market/yahooClient";
import { MARKET_SYMBOLS, type IndexId } from "@/engine/types";
import { buildIntraday, type IntradayFeed } from "@/lib/market/intraday";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INDICES: Record<string, IndexId> = { NIFTY: "NIFTY", SENSEX: "SENSEX" };

/** Open pages share one Yahoo fetch per 5 s per index and date (this isolate's memory only). */
const CACHE_MS = 5000;
/** When Yahoo fails, the last good feed is served for up to two minutes (its as-of time shows its age). */
const STALE_OK_MS = 120_000;
const cache = new Map<string, { at: number; data: IntradayFeed }>();

const reply = (data: IntradayFeed, at: number) => NextResponse.json({ ok: true, data, generatedAt: new Date(at).toISOString() }, { headers: NO_STORE });

/** GET /api/market/intraday?index=NIFTY|SENSEX[&date=YYYY-MM-DD] -> one session of 5-minute candles with VWAP and the opening range. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const index = INDICES[(sp.get("index") ?? "NIFTY").toUpperCase()];
  if (!index) return NextResponse.json({ ok: false, code: "BAD_REQUEST", error: "'index' must be NIFTY or SENSEX." }, { status: 400, headers: NO_STORE });
  const raw = sp.get("date");
  if (raw && !DATE.test(raw)) return NextResponse.json({ ok: false, code: "BAD_REQUEST", error: "'date' must be YYYY-MM-DD." }, { status: 400, headers: NO_STORE });
  const date = raw || null;
  const key = `${index}:${date ?? "latest"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return reply(hit.data, hit.at);

  let feed: IntradayFeed | null = null;
  let why = "no bars for that day";
  try {
    feed = buildIntraday(index, await fetchYahooChart(MARKET_SYMBOLS[index], { interval: "5m", range: "5d", timeoutMs: 8000 }), date);
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (!feed) {
    if (hit && Date.now() - hit.at < STALE_OK_MS) return reply(hit.data, hit.at);
    return NextResponse.json({ ok: false, code: "ENGINE_UNREACHABLE", error: `Yahoo did not return ${index} candles: ${why}` }, { status: 502, headers: NO_STORE });
  }
  const at = Date.now();
  cache.set(key, { at, data: feed });
  return reply(feed, at);
}
