/** Client helpers for the /api/engine envelope (no React). */
import type { ApiResponse } from "@/engine/api-types";

export class EnvelopeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export interface EnvelopeResult<T> {
  data: T;
  source: "engine" | "mock" | null;
}

/** Fetches an /api/engine route and unwraps `{ ok, data }`; throws EnvelopeError otherwise. */
export async function fetchEnvelope<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<EnvelopeResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        cache: "no-store",
        signal: ctrl.signal,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
      });
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      throw new EnvelopeError("ENGINE_UNREACHABLE", aborted ? "Request timed out" : "Network error", 0);
    }
    let body: ApiResponse<T> | null = null;
    try {
      body = (await res.json()) as ApiResponse<T>;
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || !("ok" in body)) {
      throw new EnvelopeError("ENGINE_UNREACHABLE", `Unexpected response (HTTP ${res.status})`, res.status);
    }
    if (!body.ok) throw new EnvelopeError(body.code, body.error, res.status);
    const src = res.headers.get("x-engine-source");
    return { data: body.data, source: src === "engine" || src === "mock" ? src : null };
  } finally {
    clearTimeout(timer);
  }
}

export function errorText(err: unknown): string {
  if (err instanceof EnvelopeError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
