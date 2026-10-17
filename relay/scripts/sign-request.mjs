#!/usr/bin/env node
// Signs a request exactly like the engine does and sends it to the relay (manual testing).
//
//   node scripts/sign-request.mjs GET /health
//   node scripts/sign-request.mjs POST /v1/orders '{"idempotencyKey":"MANUAL0001",...}'
//   node scripts/sign-request.mjs POST /v1/orders @order.json
//   node scripts/sign-request.mjs --replay GET /health        # same nonce twice: 2nd must be 401
//   node scripts/sign-request.mjs --url https://relay.example.com GET /health
//
// Settings come from flags, then the environment, then ./.env:
//   RELAY_URL (default http://127.0.0.1:8790), RELAY_HMAC_SECRET,
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (sent as CF-Access-Client-Id/-Secret when set).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const HELP = `usage: node scripts/sign-request.mjs [options] <METHOD> <PATH> [BODY | @file]

options:
  --url <origin>        relay origin (env RELAY_URL, default http://127.0.0.1:8790)
  --secret <secret>     HMAC secret (env RELAY_HMAC_SECRET)
  --cf-id <id>          Cloudflare Access client id (env CF_ACCESS_CLIENT_ID)
  --cf-secret <secret>  Cloudflare Access client secret (env CF_ACCESS_CLIENT_SECRET)
  --skew <ms>           shift X-Relay-Ts by <ms> (e.g. -40000 to test skew rejection)
  --replay              send the identical signed request twice (second must be 401)
  --dry-run             print the signed curl command instead of sending
  --verbose             print the canonical string and headers
`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (existsSync(".env")) process.loadEnvFile(".env"); // variables already set win

const args = process.argv.slice(2);
const opts = { url: process.env.RELAY_URL, secret: process.env.RELAY_HMAC_SECRET, cfId: process.env.CF_ACCESS_CLIENT_ID, cfSecret: process.env.CF_ACCESS_CLIENT_SECRET, skew: 0 };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "--help" || a === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (a === "--url") opts.url = value();
  else if (a === "--secret") opts.secret = value();
  else if (a === "--cf-id") opts.cfId = value();
  else if (a === "--cf-secret") opts.cfSecret = value();
  else if (a === "--skew") opts.skew = Number(value());
  else if (a === "--replay") opts.replay = true;
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--verbose") opts.verbose = true;
  else if (a.startsWith("--")) fail(`unknown option ${a}\n\n${HELP}`);
  else positional.push(a);
}

const [methodArg, path, bodyArg] = positional;
if (!methodArg || !path) fail(HELP);
if (!path.startsWith("/")) fail("PATH must start with / (e.g. /health or /v1/orders/ref/RT123?segment=FNO)");
if (!opts.secret) fail("RELAY_HMAC_SECRET is not set (flag --secret, environment, or ./.env)");
const method = methodArg.toUpperCase();
const origin = (opts.url || "http://127.0.0.1:8790").replace(/\/+$/, "");

let body = "";
if (bodyArg !== undefined) body = bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1), "utf8") : bodyArg;
if (body !== "") {
  try {
    JSON.parse(body);
  } catch {
    fail("BODY is not valid JSON");
  }
}

// Canonical string: ts \n nonce \n METHOD \n pathWithQuery \n sha256hex(body)
const ts = String(Date.now() + opts.skew);
const nonce = randomBytes(16).toString("hex");
const bodySha = createHash("sha256").update(body, "utf8").digest("hex");
const canonical = `${ts}\n${nonce}\n${method}\n${path}\n${bodySha}`;
const sig = createHmac("sha256", opts.secret).update(canonical, "utf8").digest("hex");

const headers = { "X-Relay-Ts": ts, "X-Relay-Nonce": nonce, "X-Relay-Sig": sig, Accept: "application/json" };
if (body !== "") headers["Content-Type"] = "application/json";
if (opts.cfId && opts.cfSecret) {
  headers["CF-Access-Client-Id"] = opts.cfId;
  headers["CF-Access-Client-Secret"] = opts.cfSecret;
}

if (opts.verbose || opts.dryRun) {
  console.error(`canonical string:\n${canonical.split("\n").map((l) => `  ${l}`).join("\n")}`);
}
if (opts.dryRun) {
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const parts = [`curl -sS -X ${method}`, ...Object.entries(headers).map(([k, v]) => `-H ${quote(`${k}: ${v}`)}`)];
  if (body !== "") parts.push(`--data-binary ${quote(body)}`);
  parts.push(quote(origin + path));
  console.log(parts.join(" \\\n  "));
  process.exit(0);
}

async function send(label) {
  let res;
  try {
    res = await fetch(origin + path, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
  } catch (e) {
    console.error(`${label}request failed: ${e instanceof Error ? `${e.message}${e.cause ? ` (${e.cause.message ?? e.cause})` : ""}` : e}`);
    process.exit(1);
  }
  const text = await res.text();
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: print as-is
  }
  console.log(`${label}HTTP ${res.status}`);
  if (opts.verbose) for (const [k, v] of res.headers) console.error(`  < ${k}: ${v}`);
  console.log(shown);
  return res.status;
}

const status = await send(opts.replay ? "[1] " : "");
if (opts.replay) {
  const again = await send("[2] ");
  process.exit(again === 401 ? 0 : 1);
}
process.exit(status >= 200 && status < 300 ? 0 : 1);
