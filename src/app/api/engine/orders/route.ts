import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { istDate } from "@/lib/ist";
import { accountParam, dateParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/orders?date=YYYY-MM-DD[&account=small10k] (IST date, default today; no account: main). */
export async function GET(req: NextRequest) {
  const date = dateParam(req.nextUrl.searchParams, "date", istDate(Date.now()));
  if (!date.ok) return date.response;
  const account = accountParam(req.nextUrl.searchParams);
  if (!account.ok) return account.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await (account.value ? api.getOrders(date.value, account.value) : api.getOrders(date.value)), "fast", source);
  });
}
