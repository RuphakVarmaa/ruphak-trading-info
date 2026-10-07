import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalString, requestTarget, safeEqualHex, sha256Hex, signRequest } from "./auth.js";
import { Ledger } from "./ledger.js";
import { FakeClock, harness, json, TEST_SECRET } from "./test-helpers.js";

// Reference values computed independently with openssl:
//   printf '%s' "$BODY" | openssl dgst -sha256
//   printf '<canonical string>' | openssl dgst -sha256 -hmac "$SECRET"
const VECTOR = {
  secret: "unit-test-secret-0123456789abcdef",
  ts: "1791263400000",
  nonce: "3f9a1c0d5e7b2a4f6c8d0e1f2a3b4c5d",
  body: '{"idempotencyKey":"RT20261006A1","side":"BUY"}',
  bodySha256: "d59e65d0e890b311a6977fe0a468474061ea7c3c08923a6eb77c66ee8c054119",
  postSig: "1f4bd6eba737d40998a59b3bc33e777092487d77088da3d07d9907c63b73ba17",
  getPath: "/v1/orders/ref/RT20261006A1?segment=FNO",
  getSig: "c6aaef3a8bf10438339b756a766c776014fe33b760dbddfa1f0d655afc57f679",
};
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("HMAC signing vectors", () => {
  it("hashes bodies like openssl", () => {
    expect(sha256Hex(VECTOR.body)).toBe(VECTOR.bodySha256);
    expect(sha256Hex("")).toBe(EMPTY_SHA256);
  });

  it("builds the canonical string ts\\nnonce\\nMETHOD\\npathWithQuery\\nsha256(body)", () => {
    expect(canonicalString({ ts: "1", nonce: "n", method: "post", pathWithQuery: "/a?b=c", bodySha256: "h" })).toBe("1\nn\nPOST\n/a?b=c\nh");
  });

  it("signs a POST like openssl", () => {
    expect(
      signRequest(VECTOR.secret, { ts: VECTOR.ts, nonce: VECTOR.nonce, method: "POST", pathWithQuery: "/v1/orders", bodySha256: VECTOR.bodySha256 }),
    ).toBe(VECTOR.postSig);
  });

  it("signs a GET with a query string like openssl", () => {
    expect(signRequest(VECTOR.secret, { ts: VECTOR.ts, nonce: VECTOR.nonce, method: "GET", pathWithQuery: VECTOR.getPath, bodySha256: EMPTY_SHA256 })).toBe(
      VECTOR.getSig,
    );
  });

  it("compares digests in constant time, case-insensitively", () => {
    expect(safeEqualHex(VECTOR.postSig, VECTOR.postSig.toUpperCase())).toBe(true);
    expect(safeEqualHex(VECTOR.postSig, VECTOR.getSig)).toBe(false);
    expect(safeEqualHex(VECTOR.postSig, "abc")).toBe(false);
  });

  it("extracts the request target without re-encoding", () => {
    expect(requestTarget("http://relay.example.com/v1/orders/ref/RT1?segment=FNO")).toBe("/v1/orders/ref/RT1?segment=FNO");
    expect(requestTarget("http://localhost:8790/health")).toBe("/health");
    expect(requestTarget("http://localhost")).toBe("/");
  });
});

describe("relay auth middleware", () => {
  it("leaves /healthz open", async () => {
    const h = harness();
    const res = await h.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
  });

  it("accepts the exact vector request at its timestamp", async () => {
    const h = harness();
    h.clock.set(Number(VECTOR.ts));
    const res = await h.app.request(VECTOR.getPath, {
      headers: { "X-Relay-Ts": VECTOR.ts, "X-Relay-Nonce": VECTOR.nonce, "X-Relay-Sig": VECTOR.getSig },
    });
    // Auth passed; the (fake) broker has no such order.
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires all three headers", async () => {
    const h = harness();
    const res = await h.app.request("/health");
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ code: "AUTH_MISSING" });
  });

  it("rejects a replayed nonce", async () => {
    const h = harness();
    const first = await h.call("GET", "/health", undefined, { nonce: "replay-nonce-0123456789" });
    expect(first.status).toBe(200);
    const again = await h.call("GET", "/health", undefined, { nonce: "replay-nonce-0123456789" });
    expect(again.status).toBe(401);
    expect(await json(again)).toMatchObject({ code: "AUTH_REPLAY" });
  });

  it("rejects timestamps more than 30 s away, either direction", async () => {
    const h = harness();
    const stale = await h.call("GET", "/health", undefined, { ts: h.clock.now() - 31_000 });
    expect(stale.status).toBe(401);
    expect(await json(stale)).toMatchObject({ code: "AUTH_SKEW" });
    const future = await h.call("GET", "/health", undefined, { ts: h.clock.now() + 31_000 });
    expect(future.status).toBe(401);
    const edge = await h.call("GET", "/health", undefined, { ts: h.clock.now() - 29_000 });
    expect(edge.status).toBe(200);
  });

  it("rejects a wrong secret, a tampered body and a tampered query", async () => {
    const h = harness();
    const wrongSecret = await h.call("GET", "/health", undefined, { secret: "another-secret-0123456789abcdef!!" });
    expect(await json(wrongSecret)).toMatchObject({ code: "AUTH_BAD_SIG" });

    const tamperedBody = await h.call("POST", "/v1/panic", { reason: "real" }, { signBody: JSON.stringify({ reason: "signed" }) });
    expect(tamperedBody.status).toBe(401);
    expect(await json(tamperedBody)).toMatchObject({ code: "AUTH_BAD_SIG" });

    const tamperedQuery = await h.call("GET", "/v1/positions?segment=CASH", undefined, { signPath: "/v1/positions?segment=FNO" });
    expect(tamperedQuery.status).toBe(401);

    const tamperedMethod = await h.app.request("/v1/panic", {
      method: "POST",
      headers: (() => {
        const ts = String(h.clock.now());
        const nonce = "method-tamper-nonce-01";
        return { "X-Relay-Ts": ts, "X-Relay-Nonce": nonce, "X-Relay-Sig": signRequest(TEST_SECRET, { ts, nonce, method: "GET", pathWithQuery: "/v1/panic", bodySha256: sha256Hex("") }) };
      })(),
      body: "",
    });
    expect(tamperedMethod.status).toBe(401);
  });

  it("rejects malformed nonces and oversized bodies", async () => {
    const h = harness();
    const short = await h.call("GET", "/health", undefined, { nonce: "short" });
    expect(await json(short)).toMatchObject({ code: "AUTH_BAD_NONCE" });
    const big = await h.call("POST", "/v1/orders", "x".repeat(70_000));
    expect(big.status).toBe(413);
  });

  it("does not burn a nonce on a failed signature", async () => {
    const h = harness();
    const bad = await h.call("GET", "/health", undefined, { nonce: "shared-nonce-0123456789", secret: "wrong-secret-0123456789abcdef0000" });
    expect(bad.status).toBe(401);
    const good = await h.call("GET", "/health", undefined, { nonce: "shared-nonce-0123456789" });
    expect(good.status).toBe(200);
  });

  it("forgets nonces after five minutes (ledger TTL)", () => {
    const clock = new FakeClock();
    const ledger = new Ledger(":memory:", clock);
    expect(ledger.claimNonce("n-0123456789abcdef", clock.now(), 300_000)).toBe(true);
    expect(ledger.claimNonce("n-0123456789abcdef", clock.now() + 299_000, 300_000)).toBe(false);
    expect(ledger.claimNonce("n-0123456789abcdef", clock.now() + 301_000, 300_000)).toBe(true);
  });
});

// ---- Cloudflare Access JWT ----------------------------------------------------------------

const AUD = "aud-tag-0123456789";
const TEAM = "ruphak";
const CERTS = "https://ruphak.cloudflareaccess.com/cdn-cgi/access/certs";

async function keyPair() {
  return webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

async function jwt(privateKey: webcrypto.CryptoKey, claims: Record<string, unknown>, kid = "k1"): Promise<string> {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
  const sig = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, Buffer.from(head));
  return `${head}.${Buffer.from(sig).toString("base64url")}`;
}

describe("Cloudflare Access assertion", () => {
  async function setup() {
    const kp = await keyPair();
    const pub = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
    let certFetches = 0;
    const h = harness(
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
      {
        fetch: async (url: string) => {
          if (url === CERTS) {
            certFetches++;
            return new Response(JSON.stringify({ keys: [{ ...pub, kid: "k1", alg: "RS256", use: "sig" }] }), { status: 200 });
          }
          throw new Error(`unexpected fetch ${url}`);
        },
      },
    );
    const nowSec = Math.floor(h.clock.now() / 1000);
    const good = { aud: [AUD], exp: nowSec + 600, iat: nowSec - 10, iss: `https://${TEAM}.cloudflareaccess.com`, type: "app" };
    return { h, kp, good, nowSec, fetches: () => certFetches };
  }

  it("requires the assertion when Access is configured", async () => {
    const { h } = await setup();
    const res = await h.call("GET", "/health");
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ code: "ACCESS_MISSING" });
  });

  it("accepts a valid RS256 assertion and caches the JWKS", async () => {
    const { h, kp, good, fetches } = await setup();
    const token = await jwt(kp.privateKey, good);
    expect((await h.call("GET", "/health", undefined, { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(200);
    expect((await h.call("GET", "/health", undefined, { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(200);
    expect(fetches()).toBe(1);
  });

  it("rejects wrong audience, expiry, issuer, foreign keys and unknown kids", async () => {
    const { h, kp, good, nowSec } = await setup();
    const other = await keyPair();
    const cases: [string, string][] = [
      ["audience", await jwt(kp.privateKey, { ...good, aud: ["someone-else"] })],
      ["expired", await jwt(kp.privateKey, { ...good, exp: nowSec - 120 })],
      ["issuer", await jwt(kp.privateKey, { ...good, iss: "https://evil.cloudflareaccess.com" })],
      ["signature", await jwt(other.privateKey, good)],
      ["kid", await jwt(kp.privateKey, good, "k2")],
      ["malformed", "not.a.jwt"],
    ];
    for (const [name, token] of cases) {
      const res = await h.call("GET", "/health", undefined, { headers: { "Cf-Access-Jwt-Assertion": token } });
      expect(res.status, name).toBe(401);
      expect(await json(res), name).toMatchObject({ code: "ACCESS_INVALID" });
    }
  });
});
