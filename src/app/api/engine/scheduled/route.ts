import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { intParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/scheduled?hours=120 */
export async function GET(req: NextRequest) {
  const hours = intParam(req.nextUrl.searchParams, "hours", 120, 1, 24 * 31);
  if (!hours.ok) return hours.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getScheduled(hours.value), "slow", source);
  });
}
