import type { NextRequest } from "next/server";
import type { IndexId } from "@/engine/api-types";
import { isIsoDate } from "@/lib/ist";
import { getEngineApi } from "@/lib/engine/server";
import { fail, handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/chain?index=NIFTY|SENSEX&expiry=YYYY-MM-DD: the live option chain (read-only). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const index = (sp.get("index") ?? "NIFTY").toUpperCase();
  if (index !== "NIFTY" && index !== "SENSEX") return fail("BAD_REQUEST", "'index' must be NIFTY or SENSEX.");
  const expiry = sp.get("expiry") ?? undefined;
  if (expiry !== undefined && !isIsoDate(expiry)) return fail("BAD_REQUEST", "'expiry' must be a date as YYYY-MM-DD.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getOptionChain(index as IndexId, expiry), "fast", source);
  });
}
