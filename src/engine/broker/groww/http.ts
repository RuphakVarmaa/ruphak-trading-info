/**
 * Minimal Groww Trade API client: auth header, envelope parsing, error classification,
 * per-category request spacing and one re-authentication on 401.
 * Wire contract: docs/RESEARCH.md section 2 (base https://api.groww.in/v1, X-API-VERSION 1.0,
 * responses {status: "SUCCESS", payload} or {status: "FAILURE", error: {code, message}}).
 */
import { fetchWithTimeout, type FetchLike } from "../../util/http";
import { GrowwError, classifyGrowwFailure } from "./errors";

export const GROWW_BASE_URL = "https://api.groww.in/v1";

/** Rate-limit categories from the Groww docs (orders 10/s, live data 10/s, non-trading 20/s). */
export type RateCategory = "orders" | "live" | "nontrading";

/** Default spacing per category: far below Groww's limits. */
export const DEFAULT_MIN_INTERVAL_MS: Record<RateCategory, number> = { orders: 250, live: 150, nontrading: 100 };

export interface TokenSource {
  /** A valid access token (cached or freshly minted). */
  token(): Promise<string>;
  /** Called when Groww answered 401 for `token`, so the next token() call re-mints. */
  invalidate(token: string): void;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  category?: RateCategory;
  timeoutMs?: number;
}

export interface GrowwTransport {
  request<T>(method: "GET" | "POST", path: string, o?: RequestOptions): Promise<T>;
}

export interface GrowwHttpOptions {
  tokens: TokenSource;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  minIntervalMs?: Partial<Record<RateCategory, number>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildQuery(query: RequestOptions["query"]): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

interface Envelope {
  status?: unknown;
  payload?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

/** Parses a Groww response body; throws GrowwError for FAILURE envelopes and HTTP errors. */
export function unwrapEnvelope<T>(status: number, text: string, what: string): T {
  let json: Envelope | null = null;
  try {
    json = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    json = null;
  }
  const ok = status >= 200 && status < 300;
  if (json && json.status === "SUCCESS" && ok) return (json.payload ?? null) as T;
  const code = typeof json?.error?.code === "string" ? json.error.code : undefined;
  const msg = typeof json?.error?.message === "string" ? json.error.message : text.slice(0, 200) || `HTTP ${status}`;
  if (ok && json && json.status === undefined) return json as T; // endpoints without an envelope
  throw new GrowwError(`Groww ${what}: ${msg}${code ? ` (${code})` : ""}`, classifyGrowwFailure(ok ? 422 : status, code), status, code);
}

export class GrowwHttp implements GrowwTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly minInterval: Record<RateCategory, number>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastCall: Record<RateCategory, number> = { orders: -Infinity, live: -Infinity, nontrading: -Infinity };

  constructor(private readonly o: GrowwHttpOptions) {
    this.baseUrl = (o.baseUrl ?? GROWW_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.minInterval = { ...DEFAULT_MIN_INTERVAL_MS, ...(o.minIntervalMs ?? {}) };
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async pace(category: RateCategory): Promise<void> {
    const wait = this.lastCall[category] + this.minInterval[category] - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCall[category] = this.now();
  }

  async request<T>(method: "GET" | "POST", path: string, o: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(o.query)}`;
    const what = `${method} ${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.tokens.token();
      await this.pace(o.category ?? "nontrading");
      let res: Response;
      try {
        res = await fetchWithTimeout(
          this.fetchImpl,
          url,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "X-API-VERSION": "1.0",
              ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          },
          o.timeoutMs ?? this.timeoutMs,
        );
      } catch (err) {
        throw new GrowwError(`Groww ${what}: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
      }
      const text = await res.text();
      try {
        return unwrapEnvelope<T>(res.status, text, what);
      } catch (err) {
        if (err instanceof GrowwError && err.kind === "auth" && attempt === 0) {
          this.o.tokens.invalidate(token);
          continue;
        }
        throw err;
      }
    }
  }
}
