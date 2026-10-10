/**
 * Groww access tokens from an API key of type TOTP (no daily approval needed):
 * POST /token/api/access {key_type: "totp", totp} with the API key as bearer.
 * The response is NOT wrapped in the usual envelope: {token, tokenRefId, sessionName, expiry, isActive}.
 * Tokens expire every day at 06:00 IST; Groww allows ~150 token calls per 24 h, so tokens are cached,
 * re-minted at most once per `minRemintGapMs` after a 401, and a failed mint is retried only after a
 * backoff (5 min doubling to 30 min) instead of on every data call.
 */
import { DAY_MS, istAt, istDate } from "../../clock";
import { fetchWithTimeout, type FetchLike } from "../../util/http";
import { GrowwError, classifyGrowwFailure } from "./errors";
import { GROWW_BASE_URL, type TokenSource } from "./http";
import { msLeftInStep, totp } from "./totp";

export interface GrowwToken {
  token: string;
  expiryMs: number;
  mintedMs: number;
}

/** Next 06:00 IST strictly after `nowMs`. */
export function nextTokenExpiry(nowMs: number): number {
  const today = istAt(istDate(nowMs), "06:00");
  return today > nowMs ? today : today + DAY_MS;
}

/** Parses Groww's `expiry` (epoch s/ms, ISO with offset, or naive IST "YYYY-MM-DD HH:mm:ss"). */
export function parseGrowwExpiry(raw: unknown, nowMs: number): number {
  const cap = nextTokenExpiry(nowMs);
  let ms: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) ms = raw < 1e12 ? raw * 1000 : raw;
  else if (typeof raw === "string" && raw.trim() !== "") {
    const s = raw.trim();
    if (/^\d+$/.test(s)) ms = Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
    else if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) ms = Date.parse(s);
    else {
      const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
      if (m) ms = istAt(m[1], `${m[2]}:${m[3]}`) + Number(m[4] ?? 0) * 1000;
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms <= nowMs) return cap;
  return Math.min(ms, cap);
}

export interface MintOptions {
  apiKey: string;
  totpSecret: string;
  nowMs: () => number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export async function mintTotpToken(o: MintOptions): Promise<GrowwToken> {
  if (!o.apiKey || !o.totpSecret) throw new GrowwError("Groww token: GROWW_API_KEY and GROWW_TOTP_SECRET are required", "auth", 0);
  // Avoid sending a code that expires in flight.
  if (msLeftInStep(o.nowMs()) < 2_000) await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(msLeftInStep(o.nowMs()) + 50);
  const now = o.nowMs();
  const code = await totp(o.totpSecret, now);
  const url = `${(o.baseUrl ?? GROWW_BASE_URL).replace(/\/+$/, "")}/token/api/access`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      o.fetchImpl ?? ((input, init) => fetch(input, init)),
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${o.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-VERSION": "1.0",
        },
        body: JSON.stringify({ key_type: "totp", totp: code }),
      },
      o.timeoutMs ?? 10_000,
    );
  } catch (err) {
    throw new GrowwError(`Groww token: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  // Tolerate both the documented bare shape and an enveloped one.
  const body = (json && typeof json.payload === "object" && json.payload !== null ? json.payload : json) as Record<string, unknown> | null;
  const token = typeof body?.token === "string" ? body.token : null;
  if (!res.ok || !token) {
    const err = json?.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof err?.code === "string" ? err.code : undefined;
    const msg = typeof err?.message === "string" ? err.message : text.slice(0, 200) || `HTTP ${res.status}`;
    throw new GrowwError(`Groww token: ${msg}`, classifyGrowwFailure(res.ok ? 401 : res.status, code), res.status, code);
  }
  return { token, expiryMs: parseGrowwExpiry(body?.expiry, now), mintedMs: now };
}

export interface TokenCache {
  get(): Promise<GrowwToken | null>;
  set(t: GrowwToken): Promise<void>;
}

export interface TokenManagerOptions {
  mint: () => Promise<GrowwToken>;
  now: () => number;
  cache?: TokenCache;
  /** Re-use a token only while it has at least this much life left (default 5 min). */
  minRemainingMs?: number;
  /** After a 401, re-mint at most this often (default 5 min) to protect the daily token quota. */
  minRemintGapMs?: number;
  /**
   * After a failed mint, the next attempt waits this long (default 5 min), doubling with each failure in a
   * row up to `maxMintBackoffMs` (default 30 min). Until then token() fails at once without a request, so
   * a rejected key (or one waiting for approval) costs no token quota and no time in the trading tick.
   */
  mintBackoffMs?: number;
  maxMintBackoffMs?: number;
}

export const DEFAULT_MINT_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_MAX_MINT_BACKOFF_MS = 30 * 60_000;

/** Single-flight token cache (one instance per Durable Object / process). */
export class GrowwTokenManager implements TokenSource {
  private current: GrowwToken | null = null;
  private inflight: Promise<GrowwToken> | null = null;
  private lastMintMs = -Infinity;
  private invalidated = new Set<string>();
  private failures = 0;
  private retryAtMs = -Infinity;
  private lastFailure = "";

  constructor(private readonly o: TokenManagerOptions) {}

  private usable(t: GrowwToken | null): t is GrowwToken {
    return !!t && !this.invalidated.has(t.token) && t.expiryMs - this.o.now() > (this.o.minRemainingMs ?? 5 * 60_000);
  }

  async token(): Promise<string> {
    if (this.usable(this.current)) return this.current.token;
    if (this.o.cache && !this.current) {
      const cached = await this.o.cache.get();
      if (this.usable(cached)) {
        this.current = cached;
        return cached.token;
      }
    }
    return (await this.refresh()).token;
  }

  /**
   * Mints a new token (shared by concurrent callers). After a failed mint it refuses without a request
   * until the backoff ends; `force` (the 08:00 job and POST /ops/token) tries anyway.
   */
  refresh(opts: { force?: boolean } = {}): Promise<GrowwToken> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const now = this.o.now();
        if (!opts.force && now < this.retryAtMs) {
          throw new GrowwError(
            `Groww token: minting paused for ${Math.ceil((this.retryAtMs - now) / 1000)} s after ${this.failures} failed attempt(s): ${this.lastFailure}`,
            "auth",
            0,
          );
        }
        const gap = this.o.minRemintGapMs ?? 5 * 60_000;
        const since = now - this.lastMintMs;
        if (since < gap && this.current && !this.usable(this.current)) {
          throw new GrowwError(`Groww token: re-mint throttled (last mint ${Math.round(since / 1000)} s ago)`, "auth", 401);
        }
        this.lastMintMs = now;
        let t: GrowwToken;
        try {
          t = await this.o.mint();
        } catch (err) {
          this.failures++;
          const base = this.o.mintBackoffMs ?? DEFAULT_MINT_BACKOFF_MS;
          const cap = this.o.maxMintBackoffMs ?? DEFAULT_MAX_MINT_BACKOFF_MS;
          this.retryAtMs = this.o.now() + Math.min(cap, base * 2 ** Math.min(this.failures - 1, 20));
          this.lastFailure = (err instanceof Error ? err.message : String(err)).slice(0, 200);
          throw err;
        }
        this.failures = 0;
        this.retryAtMs = -Infinity;
        this.lastFailure = "";
        this.current = t;
        this.invalidated.clear();
        if (this.o.cache) await this.o.cache.set(t);
        return t;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  invalidate(token: string): void {
    this.invalidated.add(token);
  }

  status(): { valid: boolean; expiryMs: number | null; mintedMs: number | null; failures: number; retryAtMs: number | null } {
    return {
      valid: this.usable(this.current),
      expiryMs: this.current?.expiryMs ?? null,
      mintedMs: this.current?.mintedMs ?? null,
      failures: this.failures,
      retryAtMs: Number.isFinite(this.retryAtMs) ? this.retryAtMs : null,
    };
  }
}
