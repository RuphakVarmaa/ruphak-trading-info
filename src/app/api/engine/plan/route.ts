import { getEngineApi } from "@/lib/engine/server";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/plan: the plan's no-trade rules for today's session (or the next one). Read-only. */
export async function GET() {
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getTodayPlan(), "slow", source);
  });
}
