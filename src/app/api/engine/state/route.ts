import { getEngineApi } from "@/lib/engine/server";
import { handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getState(), "fast", source);
  });
}
