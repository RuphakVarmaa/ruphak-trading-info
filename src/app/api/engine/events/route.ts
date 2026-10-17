import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { intParam, sinceParam, tabParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/events?tab=ALL|MACRO|...&limit=50&since=<epoch ms | ISO> */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const tab = tabParam(sp);
  if (!tab.ok) return tab.response;
  const limit = intParam(sp, "limit", 50, 1, 200);
  if (!limit.ok) return limit.response;
  const since = sinceParam(sp);
  if (!since.ok) return since.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const data = await api.getEvents({ tab: tab.value, limit: limit.value, sinceMs: since.value });
    return ok(data, "slow", source);
  });
}
