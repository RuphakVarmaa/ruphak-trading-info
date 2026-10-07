import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { intParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/pnl?days=30 */
export async function GET(req: NextRequest) {
  const days = intParam(req.nextUrl.searchParams, "days", 30, 1, 365);
  if (!days.ok) return days.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getPnl(days.value), "slow", source);
  });
}
