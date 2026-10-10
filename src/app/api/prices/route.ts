import { NextResponse } from "next/server";
import { fetchCommodityBoard } from "@/lib/market/commodities";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/prices -> gold, silver, platinum, copper, WTI and Brent front-month futures from Yahoo Finance.
 * No fallback values: a commodity Yahoo did not return is listed in `missing`, and with none at all this is a 502.
 */
export async function GET() {
  const board = await fetchCommodityBoard();
  if (!board) {
    return NextResponse.json({ ok: false, code: "UPSTREAM", error: "Yahoo Finance did not return metal or oil prices" }, { status: 502, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, data: board, generatedAt: board.generatedAt }, { headers: NO_STORE });
}
