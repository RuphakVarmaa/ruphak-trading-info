import { getEngineApi } from "@/lib/engine/server";
import { requireAdmin } from "../../_lib/auth";
import { fail, handle, ok } from "../../_lib/respond";

export const dynamic = "force-dynamic";

/** GET /api/engine/admin/verify with x-admin-token: 200 { verified: true } or 401. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    if (!(await api.verifyAdmin(auth.token))) return fail("UNAUTHORIZED", "The engine rejected the admin token.");
    return ok({ verified: true }, "none", source);
  }, [auth.token]);
}
