import { getEngineApi } from "@/lib/engine/server";
import { ADMIN_ACTOR, requireAdmin } from "../../_lib/auth";
import { jsonBody, parseArm } from "../../_lib/params";
import { handle, ok } from "../../_lib/respond";

export const dynamic = "force-dynamic";

/** POST /api/engine/admin/arm { armed: boolean } -> EngineStateDTO */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await jsonBody(req);
  if (!body.ok) return body.response;
  const input = parseArm(body.value);
  if (!input.ok) return input.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.setArmed(auth.token, input.value.armed, ADMIN_ACTOR), "none", source);
  }, [auth.token]);
}
