import { NextResponse } from "next/server";
import { barsSince } from "@/lib/market/liveIndices";
import { getLiveFeed } from "@/lib/market/liveSource";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Epoch milliseconds (13 digits until the year 2286). */
const EPOCH_MS = /^\d{13}$/;

/**
 * GET /api/market/live[?since=<epoch ms>] -> NIFTY 50 and SENSEX 1-minute bars with India VIX
 * (LiveIndicesFeed, see src/lib/market/liveIndices.ts). One shared Yahoo fetch per isolate, reused for 1.5 s
 * while the market is open or in pre-open and 60 s otherwise; a failed fetch is covered by the last good
 * values for up to two minutes (marked stale), then this answers 502. With `since`, an index whose session is
 * that day sends only its bars from then on (`barsFrom`); everything else is the full payload.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw && EPOCH_MS.test(raw) ? Number(raw) : null;
  const result = await getLiveFeed();
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: "UPSTREAM", error: result.error }, { status: 502, headers: NO_STORE });
  }
  const data = since != null ? barsSince(result.feed, since) : result.feed;
  return NextResponse.json({ ok: true, data, generatedAt: data.generatedAt }, { headers: NO_STORE });
}
