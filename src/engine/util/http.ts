/** fetch with a timeout, usable in Workers and Node. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms: ${url}`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET text; throws HttpError on non-2xx with a short body excerpt. */
export async function fetchText(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<string> {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${redactUrl(url)}`, res.status, text.slice(0, 300));
  return text;
}

/** Removes obvious secrets (apikey/token query params) from URLs before logging. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|token|key)=)[^&]+/gi, "$1***");
}

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
