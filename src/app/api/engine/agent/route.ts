import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { dateParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/agent[?date=YYYY-MM-DD]: the options agent's view for an IST date (no date: the engine's own today). */
export async function GET(req: NextRequest) {
  const date = dateParam(req.nextUrl.searchParams, "date", "");
  if (!date.ok) return date.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await (date.value ? api.getAgent(date.value) : api.getAgent()), "fast", source);
  });
}
