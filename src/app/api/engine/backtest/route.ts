import { getEngineApi } from "@/lib/engine/server";
import { istDate } from "@/lib/ist";
import { ADMIN_ACTOR, requireAdmin } from "../_lib/auth";
import { jsonBody, parseBacktest } from "../_lib/params";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

/** POST /api/engine/backtest (admin) with BacktestParams; returns { runId, status }. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await jsonBody(req);
  if (!body.ok) return body.response;
  const params = parseBacktest(body.value, istDate(Date.now()));
  if (!params.ok) return params.response;
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.startBacktest(auth.token, params.value, ADMIN_ACTOR), "none", source);
  }, [auth.token]);
}
