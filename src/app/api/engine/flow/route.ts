import type { NextRequest } from "next/server";
import type { IndexId } from "@/engine/api-types";
import { getEngineApi } from "@/lib/engine/server";
import { fail, handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/flow?index=NIFTY|SENSEX: the live option flow (OI added/removed, build-ups, volume spikes, premium decay; read-only). */
export async function GET(req: NextRequest) {
  const index = (req.nextUrl.searchParams.get("index") ?? "NIFTY").toUpperCase();
  if (index !== "NIFTY" && index !== "SENSEX") return fail("BAD_REQUEST", "'index' must be NIFTY or SENSEX.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getOptionFlow(index as IndexId), "fast", source);
  });
}
