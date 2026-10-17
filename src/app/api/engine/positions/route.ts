import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { accountParam } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/positions[?account=small10k] (no account: main). */
export async function GET(req: NextRequest) {
  const account = accountParam(req.nextUrl.searchParams);
  if (!account.ok) return account.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await (account.value ? api.getPositions(account.value) : api.getPositions()), "fast", source);
  });
}
