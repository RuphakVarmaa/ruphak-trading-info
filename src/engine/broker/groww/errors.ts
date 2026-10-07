/** Groww API failures, classified so callers can decide to retry, re-authenticate or give up. */

export type GrowwErrorKind =
  | "auth" // 401 or GA005 on a token problem: re-mint once
  | "forbidden" // 403: IP not whitelisted, subscription inactive, segment disabled
  | "bad_request" // GA001 / GA006 / 400 / 422: the request itself is wrong
  | "not_found" // GA004 / 404
  | "duplicate" // GA007: order_reference_id already used (look the order up instead)
  | "rate_limited" // 429
  | "transient" // GA000 / GA003 / 5xx / timeout / network: retry with backoff
  | "unknown";

export class GrowwError extends Error {
  constructor(
    message: string,
    readonly kind: GrowwErrorKind,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GrowwError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

export function isGrowwError(e: unknown): e is GrowwError {
  return e instanceof GrowwError;
}

/** Maps an HTTP status and Groww error code (GA000-GA007) to an error kind. */
export function classifyGrowwFailure(status: number, code?: string): GrowwErrorKind {
  switch (code) {
    case "GA007":
      return "duplicate";
    case "GA004":
      return "not_found";
    case "GA001":
    case "GA006":
      return "bad_request";
    case "GA000":
    case "GA003":
      return "transient";
    case "GA005":
      return status === 403 ? "forbidden" : "auth";
  }
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "bad_request";
  if (status >= 500 || status === 0 || status === 408) return "transient";
  return "unknown";
}
