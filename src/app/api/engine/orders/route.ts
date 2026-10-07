import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { istDate } from "@/lib/ist";
import { dateParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/orders?date=YYYY-MM-DD (IST date, default today). */
export async function GET(req: NextRequest) {
  const date = dateParam(req.nextUrl.searchParams, "date", istDate(Date.now()));
  if (!date.ok) return date.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getOrders(date.value), "fast", source);
  });
}
