import { getEngineApi } from "@/lib/engine/server";
import { ADMIN_ACTOR, requireAdmin } from "../../../_lib/auth";
import { jsonBody } from "../../../_lib/params";
import { handle, ok } from "../../../_lib/respond";
import { parseCandidateDecision } from "../candidateBody";

export const dynamic = "force-dynamic";

/** POST /api/engine/admin/agent/candidate { id, decision: "approve" | "reject" } -> AgentView. The engine allows approval only outside the session. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await jsonBody(req);
  if (!body.ok) return body.response;
  const input = parseCandidateDecision(body.value);
  if (!input.ok) return input.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.setAgentCandidate(auth.token, input.value.id, input.value.decision, ADMIN_ACTOR), "none", source);
  }, [auth.token]);
}
