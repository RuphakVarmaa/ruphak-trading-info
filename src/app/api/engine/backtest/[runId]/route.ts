import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { ID_PATTERN } from "../../_lib/params";
import { fail, handle, ok } from "../../_lib/respond";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!ID_PATTERN.test(runId)) return fail("BAD_REQUEST", "Invalid run id.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const result = await api.getBacktest(runId);
    if (!result) return fail("NOT_FOUND", `No backtest run '${runId}'.`);
    return ok(result, "none", source);
  });
}
