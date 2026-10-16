import { getEngineApi } from "@/lib/engine/server";
import { ADMIN_ACTOR, requireAdmin } from "../../../_lib/auth";
import { jsonBody } from "../../../_lib/params";
import { handle, ok } from "../../../_lib/respond";

export const dynamic = "force-dynamic";

/** POST /api/engine/admin/agent/rearm {} -> AgentView: clears the agent's drawdown halt and kill switch; its peak equity restarts at the current equity. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await jsonBody(req);
  if (!body.ok) return body.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.rearmAgent(auth.token, ADMIN_ACTOR), "none", source);
  }, [auth.token]);
}
