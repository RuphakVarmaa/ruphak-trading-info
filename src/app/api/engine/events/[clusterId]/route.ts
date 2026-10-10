import type { NextRequest } from "next/server";
import { getEngineApi } from "@/lib/engine/server";
import { ID_PATTERN } from "../../_lib/params";
import { fail, handle, ok } from "../../_lib/respond";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ clusterId: string }> }) {
  const { clusterId } = await params;
  if (!ID_PATTERN.test(clusterId)) return fail("BAD_REQUEST", "Invalid cluster id.");
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const detail = await api.getEventDetail(clusterId);
    if (!detail) return fail("NOT_FOUND", `No event cluster '${clusterId}'.`);
    return ok(detail, "slow", source);
  });
}
