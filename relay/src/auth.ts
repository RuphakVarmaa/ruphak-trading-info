// Request authentication: HMAC-SHA256 signature + timestamp skew + nonce replay protection,
// and (optionally) the Cloudflare Access JWT that the edge adds for service-token requests.
import { createHash, createHmac, timingSafeEqual, webcrypto } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Clock } from "./clock.js";
import type { FetchLike } from "./groww.js";
import { errorFields, type Logger } from "./log.js";

export const HEADER_TS = "x-relay-ts";
export const HEADER_NONCE = "x-relay-nonce";
export const HEADER_SIG = "x-relay-sig";
export const HEADER_ACCESS_JWT = "cf-access-jwt-assertion";

export const MAX_SKEW_MS = 30_000;
export const NONCE_TTL_MS = 5 * 60_000;
export const MAX_BODY_BYTES = 64 * 1024;

export type AppEnv = {
  Variables: {
    rawBody: string;
    /** Relay clock minus the signed X-Relay-Ts (positive when the relay is ahead). */
    skewMs: number;
  };
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface SignatureParts {
  ts: string;
  nonce: string;
  method: string;
  /** Request path plus "?query" exactly as sent, e.g. "/v1/orders/ref/RT123?segment=FNO". */
  pathWithQuery: string;
  /** Lower-case hex SHA-256 of the exact body bytes (of "" for GET). */
  bodySha256: string;
}

export function canonicalString(p: SignatureParts): string {
  return `${p.ts}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.pathWithQuery}\n${p.bodySha256}`;
}

export function signRequest(secret: string, p: SignatureParts): string {
  return createHmac("sha256", secret).update(canonicalString(p), "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), "utf8");
  const bb = Buffer.from(b.toLowerCase(), "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing independent of where the mismatch is
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** The request-target (path + query, no fragment) of an absolute URL, without re-encoding it. */
export function requestTarget(url: string): string {
  const schemeEnd = url.indexOf("://");
  const start = url.indexOf("/", schemeEnd === -1 ? 0 : schemeEnd + 3);
  if (start === -1) return "/";
  const hash = url.indexOf("#", start);
  return hash === -1 ? url.slice(start) : url.slice(start, hash);
}

export interface NonceStore {
  claimNonce(nonce: string, nowMs: number, ttlMs: number): boolean;
}

export interface AccessVerifier {
  verify(jwt: string): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; reason: string; unavailable?: boolean }>;
}

export interface AuthOptions {
  secret: string;
  clock: Clock;
  nonces: NonceStore;
  logger: Logger;
  access: AccessVerifier | null;
  publicPaths?: string[];
  maxSkewMs?: number;
  nonceTtlMs?: number;
  maxBodyBytes?: number;
}

const TS_RE = /^\d{10,16}$/;
const NONCE_RE = /^[A-Za-z0-9._~+/=-]{16,64}$/;
const SIG_RE = /^[0-9a-fA-F]{64}$/;

export function relayAuth(o: AuthOptions): MiddlewareHandler<AppEnv> {
  const publicPaths = new Set(o.publicPaths ?? ["/healthz"]);
  const maxSkew = o.maxSkewMs ?? MAX_SKEW_MS;
  const ttl = o.nonceTtlMs ?? NONCE_TTL_MS;
  const maxBody = o.maxBodyBytes ?? MAX_BODY_BYTES;

  return async (c, next) => {
    const target = requestTarget(c.req.url);
    const path = target.split("?")[0] ?? "/";
    if (publicPaths.has(path)) return next();

    const deny = (status: 401 | 400 | 413 | 503, code: string, error: string) => {
      o.logger.warn("request rejected by auth", {
        code,
        method: c.req.method,
        path,
        ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null,
      });
      return c.json({ error, code }, status);
    };

    if (o.access !== null) {
      const jwt = c.req.header(HEADER_ACCESS_JWT);
      if (!jwt) return deny(401, "ACCESS_MISSING", "missing Cloudflare Access assertion");
      const res = await o.access.verify(jwt);
      if (!res.ok) {
        return res.unavailable
          ? deny(503, "ACCESS_UNAVAILABLE", `cannot verify Cloudflare Access assertion: ${res.reason}`)
          : deny(401, "ACCESS_INVALID", `invalid Cloudflare Access assertion: ${res.reason}`);
      }
    }

    const ts = c.req.header(HEADER_TS);
    const nonce = c.req.header(HEADER_NONCE);
    const sig = c.req.header(HEADER_SIG);
    if (!ts || !nonce || !sig) return deny(401, "AUTH_MISSING", "missing X-Relay-Ts, X-Relay-Nonce or X-Relay-Sig");
    if (!TS_RE.test(ts)) return deny(401, "AUTH_BAD_TS", "X-Relay-Ts must be unix epoch milliseconds");
    const now = o.clock.now();
    const skew = now - Number(ts);
    if (Math.abs(skew) > maxSkew) return deny(401, "AUTH_SKEW", `X-Relay-Ts is ${Math.round(skew / 1000)} s away from the relay clock (max ${maxSkew / 1000} s)`);
    if (!NONCE_RE.test(nonce)) return deny(401, "AUTH_BAD_NONCE", "X-Relay-Nonce must be 16-64 characters of [A-Za-z0-9._~+/=-]");
    if (!SIG_RE.test(sig)) return deny(401, "AUTH_BAD_SIG", "X-Relay-Sig must be 64 hex characters");

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > maxBody) return deny(413, "BODY_TOO_LARGE", `body exceeds ${maxBody} bytes`);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > maxBody) return deny(413, "BODY_TOO_LARGE", `body exceeds ${maxBody} bytes`);

    const expected = signRequest(o.secret, { ts, nonce, method: c.req.method, pathWithQuery: target, bodySha256: sha256Hex(bytes) });
    if (!safeEqualHex(expected, sig)) return deny(401, "AUTH_BAD_SIG", "signature mismatch");
    if (!o.nonces.claimNonce(nonce, now, ttl)) return deny(401, "AUTH_REPLAY", "nonce already used");

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return deny(400, "BAD_ENCODING", "body must be UTF-8");
    }
    c.set("rawBody", text);
    c.set("skewMs", skew);
    return next();
  };
}

// ---- Cloudflare Access JWT (RS256) ------------------------------------------------------

export interface AccessJwtOptions {
  certsUrl: string;
  issuer: string;
  aud: string;
  fetch: FetchLike;
  clock: Clock;
  logger: Logger;
  /** Accepted clock difference for exp/nbf/iat, in seconds. */
  leewaySec?: number;
}

type Jwk = { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown; alg?: unknown };

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verifies `Cf-Access-Jwt-Assertion` against the team's JWKS (cached, refreshed on unknown kid). */
export class AccessJwtVerifier implements AccessVerifier {
  private keys = new Map<string, webcrypto.CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(private readonly o: AccessJwtOptions) {}

  async verify(jwt: string): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; reason: string; unavailable?: boolean }> {
    const parts = jwt.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed token" };
    const [h, p, s] = parts as [string, string, string];
    const header = b64urlJson(h);
    const claims = b64urlJson(p);
    if (!header || !claims) return { ok: false, reason: "malformed token" };
    if (header.alg !== "RS256") return { ok: false, reason: "unexpected alg" };
    const kid = typeof header.kid === "string" ? header.kid : null;
    if (!kid) return { ok: false, reason: "missing kid" };

    let key: webcrypto.CryptoKey | undefined;
    try {
      key = await this.key(kid);
    } catch (e) {
      this.o.logger.error("cannot fetch Cloudflare Access certs", { err: errorFields(e) });
      return { ok: false, reason: "certs unavailable", unavailable: true };
    }
    if (!key) return { ok: false, reason: "unknown signing key" };

    let valid = false;
    try {
      valid = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(s, "base64url"), Buffer.from(`${h}.${p}`, "utf8"));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: "bad signature" };

    const nowSec = this.o.clock.now() / 1000;
    const leeway = this.o.leewaySec ?? 30;
    const aud = claims.aud;
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.includes(this.o.aud)) return { ok: false, reason: "audience mismatch" };
    if (typeof claims.exp !== "number" || claims.exp + leeway < nowSec) return { ok: false, reason: "expired" };
    if (typeof claims.nbf === "number" && claims.nbf - leeway > nowSec) return { ok: false, reason: "not yet valid" };
    if (claims.iss !== undefined && claims.iss !== this.o.issuer) return { ok: false, reason: "issuer mismatch" };
    return { ok: true, claims };
  }

  private async key(kid: string): Promise<webcrypto.CryptoKey | undefined> {
    const now = this.o.clock.now();
    const stale = now - this.fetchedAt > 60 * 60_000;
    const missing = !this.keys.has(kid);
    // Refetch hourly, or when an unknown kid shows up (key rotation), but at most once a
    // minute (every 5 s while no keys are loaded at all).
    const minGap = this.keys.size === 0 ? 5_000 : 60_000;
    if ((stale || missing) && now - this.lastAttemptAt > minGap) {
      this.lastAttemptAt = now;
      try {
        await this.refresh();
      } catch (e) {
        if (this.keys.size === 0) throw e;
        this.o.logger.warn("Cloudflare Access certs refresh failed; using cached keys", { err: errorFields(e) });
      }
    }
    if (this.keys.size === 0) throw new Error("no Cloudflare Access certs loaded yet");
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    const res = await this.o.fetch(this.o.certsUrl, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`certs endpoint HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, webcrypto.CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid !== "string" || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      const key = await webcrypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      next.set(jwk.kid, key);
    }
    if (next.size === 0) throw new Error("certs endpoint returned no RSA keys");
    this.keys = next;
    this.fetchedAt = this.o.clock.now();
  }
}
