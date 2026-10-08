import { getEngineApi } from "@/lib/engine/server";
import { ADMIN_ACTOR, requireAdmin } from "../../_lib/auth";
import { accountField, jsonBody, parseKill } from "../../_lib/params";
import { handle, ok } from "../../_lib/respond";

export const dynamic = "force-dynamic";

/** POST /api/engine/admin/kill { engaged, squareOff, reason, account? } -> EngineStateDTO (account: id or "all"; absent: main) */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await jsonBody(req);
  if (!body.ok) return body.response;
  const input = parseKill(body.value);
  if (!input.ok) return input.response;
  const account = accountField(body.value);
  if (!account.ok) return account.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    const state = account.value ? await api.setKillSwitch(auth.token, input.value, ADMIN_ACTOR, account.value) : await api.setKillSwitch(auth.token, input.value, ADMIN_ACTOR);
    return ok(state, "none", source);
  }, [auth.token]);
}
