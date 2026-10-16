import { getEngineApi } from "@/lib/engine/server";
import { fail, handle, ok } from "../_lib/respond";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;
const MAX_REASON = 100;

/** The optional `{ reason }` of a run request, trimmed to 100 characters; "manual" when the body is empty. */
async function reasonFrom(req: Request): Promise<{ ok: true; reason: string } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, error: "Could not read the request body." };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: "Request body is too large." };
  if (text.trim() === "") return { ok: true, reason: "manual" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "Request body must be valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Request body must be a JSON object." };
  const raw = (body as { reason?: unknown }).reason;
  if (raw !== undefined && typeof raw !== "string") return { ok: false, error: "'reason' must be a string." };
  const reason = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  return { ok: true, reason: reason || "manual" };
}

/** GET /api/engine/advisor: the latest advisor brief, the run status and recent history (never cached). */
export async function GET() {
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.getAdvisor(), "none", source);
  });
}

/**
 * POST /api/engine/advisor { reason? }: starts a new analysis unless one is running or the rate limit says
 * wait, and returns the view at once (poll GET). Public: the engine's rate limit is the guard.
 */
export async function POST(req: Request) {
  const parsed = await reasonFrom(req);
  if (!parsed.ok) return fail("BAD_REQUEST", parsed.error);
  return handle(async () => {
    const { api, source } = await getEngineApi();
    return ok(await api.runAdvisor(parsed.reason), "none", source);
  });
}
