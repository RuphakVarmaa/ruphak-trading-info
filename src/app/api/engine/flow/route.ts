import type { NextRequest } from "next/server";
import type { EngineApi, IndexId, OptionFlowView } from "@/engine/api-types";
import { getEngineApi } from "@/lib/engine/server";
import { fail, handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** An engine that may or may not publish option flow yet (engines that predate it have no getOptionFlow). */
type MaybeFlowApi = EngineApi & { getOptionFlow?: (index: IndexId) => Promise<OptionFlowView> };

/** GET /api/engine/flow?index=NIFTY|SENSEX: live option flow (OI added/removed, build-ups, volume, premium decay), read-only. */
export async function GET(req: NextRequest) {
  const index = (req.nextUrl.searchParams.get("index") ?? "NIFTY").toUpperCase();
  if (index !== "NIFTY" && index !== "SENSEX") return fail("BAD_REQUEST", "'index' must be NIFTY or SENSEX.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const flowApi = api as MaybeFlowApi;
    if (typeof flowApi.getOptionFlow !== "function") return fail("NOT_FOUND", "This engine does not publish option flow yet.");
    return ok(await flowApi.getOptionFlow(index as IndexId), "fast", source);
  });
}
