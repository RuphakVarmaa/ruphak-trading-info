import type { NextRequest } from "next/server";
import type { IndexId } from "@/engine/api-types";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { getEngineApi, type EngineSource } from "@/lib/engine/server";
import { OutlookCache } from "@/lib/options/outlookCache";
import { fail, handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** One cache per engine source in this isolate (mock and real chains never mix). */
const caches = new Map<EngineSource, OutlookCache>();

function cacheFor(source: EngineSource): OutlookCache {
  let c = caches.get(source);
  if (!c) {
    c = new OutlookCache({ calendar: defaultCalendar });
    caches.set(source, c);
  }
  return c;
}

/**
 * GET /api/engine/outlook?index=NIFTY|SENSEX: what each listed expiry in the next 30 days is priced at
 * (ATM straddle, break-even range, ATM IV, PCR, max pain, OI walls, OI change, events before expiry).
 * Chains are cached per expiry (5 min in market hours, 30 min otherwise) and at most two are read from
 * the engine per request; `pending` counts the expiries still to be read.
 */
export async function GET(req: NextRequest) {
  const index = (req.nextUrl.searchParams.get("index") ?? "NIFTY").toUpperCase();
  if (index !== "NIFTY" && index !== "SENSEX") return fail("BAD_REQUEST", "'index' must be NIFTY or SENSEX.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const view = await cacheFor(source).get(index as IndexId, api);
    return ok(view, view.pending > 0 ? "none" : "slow", source);
  });
}
