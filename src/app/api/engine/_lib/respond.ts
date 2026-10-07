import { NextResponse } from "next/server";
import type { ApiErr, ApiErrorCode, ApiOk } from "@/engine/api-types";
import type { EngineSource } from "@/lib/engine/server";

/** fast: state/signals/positions/orders; slow: events, P&L and other slow-moving slices; none: admin and polling. */
export type CacheProfile = "fast" | "slow" | "none";

const CACHE_CONTROL: Record<CacheProfile, string> = {
  fast: "public, s-maxage=3, stale-while-revalidate=5",
  slow: "public, s-maxage=30, stale-while-revalidate=60",
  none: "no-store",
};

const STATUS: Record<ApiErrorCode, number> = {
  ENGINE_UNREACHABLE: 503,
  UNAUTHORIZED: 401,
  ADMIN_DISABLED: 503,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export function ok<T>(data: T, cache: CacheProfile, source?: EngineSource): NextResponse<ApiOk<T>> {
  const headers: Record<string, string> = { "Cache-Control": CACHE_CONTROL[cache] };
  if (source) headers["X-Engine-Source"] = source;
  return NextResponse.json({ ok: true, data, generatedAt: new Date().toISOString() }, { status: 200, headers });
}

export function fail(code: ApiErrorCode, error: string, status = STATUS[code]): NextResponse<ApiErr> {
  return NextResponse.json({ ok: false, code, error }, { status, headers: { "Cache-Control": "no-store" } });
}

const MAPPED_CODES = new Set<ApiErrorCode>(["UNAUTHORIZED", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "ADMIN_DISABLED"]);

/**
 * Maps a thrown engine error to an envelope. Engine errors carry their code either as an
 * `err.code` property (the engine Worker's AdminError) or as a message prefix
 * ("CONFLICT: ...", as the mock does); the prefix is the form that is sure to survive
 * Workers RPC error serialization. Anything else means the engine could not be reached
 * or failed, so the client keeps its last good data (503 ENGINE_UNREACHABLE).
 */
export function failFromError(err: unknown, secrets: (string | null | undefined)[] = []): NextResponse<ApiErr> {
  let message = err instanceof Error ? err.message : String(err);
  for (const s of secrets) if (s) message = message.split(s).join("***");
  message = message.slice(0, 300);
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && MAPPED_CODES.has(code as ApiErrorCode)) return fail(code as ApiErrorCode, message || code);
  const m = /^(UNAUTHORIZED|BAD_REQUEST|NOT_FOUND|CONFLICT|ADMIN_DISABLED)\b:?\s*(.*)$/s.exec(message);
  if (m) return fail(m[1] as ApiErrorCode, m[2] || m[1]);
  return fail("ENGINE_UNREACHABLE", `Engine unreachable: ${message || "unknown error"}`);
}

/** Runs a handler body and converts anything it throws into a 503 ENGINE_UNREACHABLE envelope. */
export async function handle(fn: () => Promise<NextResponse>, secrets: (string | null | undefined)[] = []): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return failFromError(err, secrets);
  }
}
