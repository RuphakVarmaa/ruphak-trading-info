import { getEngineApi } from "@/lib/engine/server";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/live-indices: NIFTY, SENSEX, BANKNIFTY and India VIX from the broker feed (read-only). */
export async function GET() {
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getLiveIndices(), "fast", source);
  });
}
