import { NextResponse } from "next/server";
import { fetchHeadlineFeed } from "@/lib/market/headlines";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/metals/headlines -> metals, oil and shipping-lane headlines from Bing News, newest first (refreshed every 10 minutes). */
export async function GET() {
  const feed = await fetchHeadlineFeed();
  if (!feed) {
    return NextResponse.json({ ok: false, code: "UPSTREAM", error: "Bing News did not return any metals or shipping headlines" }, { status: 502, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, data: feed, generatedAt: feed.generatedAt }, { headers: NO_STORE });
}
