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

/** The machine-readable code of a failed request (for logic), e.g. "ENGINE_UNREACHABLE"; null when unknown. */
export function errorCode(err: unknown): string | null {
  return err instanceof EnvelopeError ? err.code : null;
}

/** First letter upper case and a full stop at the end: messages from the server read as sentences. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * A plain sentence for people, never a raw code ("ENGINE_UNREACHABLE: ..."). Use errorCode() for logic.
 * Messages that come from the server for a request it refused (a conflict, a bad value) are kept: they
 * are written for people.
 */
export function errorText(err: unknown): string {
  if (err instanceof EnvelopeError) {
    switch (err.code) {
      case "ENGINE_UNREACHABLE":
        if (err.status === 0) return /timed out/i.test(err.message) ? "The server took too long to answer." : "Could not reach the server. Check the connection.";
        if (/^Unexpected response/.test(err.message)) return "The server sent an answer the page could not read.";
        return "The trading engine is not answering right now.";
      case "UNAUTHORIZED":
        return "The admin token was not accepted.";
      case "ADMIN_DISABLED":
        return "Admin actions are turned off on this server.";
      case "NOT_FOUND":
        return "Nothing was found for that request.";
      case "CONFLICT":
      case "BAD_REQUEST":
        return err.message && err.message !== err.code ? sentence(err.message) : "The request was refused.";
      default:
        return "Something went wrong on the server.";
    }
  }
  return "Something went wrong.";
}
