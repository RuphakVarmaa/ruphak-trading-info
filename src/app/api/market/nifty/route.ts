import { NextResponse } from "next/server";
import { fetchYahooChart } from "@/engine/market/yahooClient";
import { MARKET_SYMBOLS } from "@/engine/types";
import { buildNiftyFeed } from "@/lib/market/niftyFeed";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/market/nifty?expiry=YYYY-MM-DD -> NIFTY 50 1-minute feed, India VIX and the model option chain. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("expiry");
  const want = raw && EXPIRY.test(raw) ? raw : null;
  const [nifty, vix] = await Promise.allSettled([
    fetchYahooChart(MARKET_SYMBOLS.NIFTY, { interval: "1m", range: "1d", timeoutMs: 8000 }),
    fetchYahooChart(MARKET_SYMBOLS.INDIAVIX, { interval: "1m", range: "1d", timeoutMs: 8000 }),
  ]);
  const feed = nifty.status === "fulfilled" ? buildNiftyFeed(nifty.value, vix.status === "fulfilled" ? vix.value : null, Date.now(), want) : null;
  if (!feed) {
    const why = nifty.status === "rejected" ? String(nifty.reason instanceof Error ? nifty.reason.message : nifty.reason) : "no NIFTY price in the response";
    return NextResponse.json({ ok: false, code: "ENGINE_UNREACHABLE", error: `Yahoo did not return a NIFTY price: ${why}` }, { status: 502, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, data: feed, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
}
