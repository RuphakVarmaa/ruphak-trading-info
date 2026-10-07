#!/usr/bin/env node
// Creates the engine's Cloudflare resources (idempotent) and writes their IDs into
// workers/engine/wrangler.jsonc. Run it where Wrangler is logged in:
//
//   npx wrangler login            # once, or set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID)
//   npm run cf:setup              # production resources
//   npm run cf:setup -- --preview # the preview environment's resources too
//
// Resources: D1 database, KV namespace, the scoring queue and its dead-letter queue, the data
// bucket and the dashboard's incremental-cache bucket. Existing resources are reused.
// Nothing secret is printed or written; Worker secrets are set separately (see the README).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE_CONFIG = resolve(ROOT, "workers/engine/wrangler.jsonc");
const withPreview = process.argv.includes("--preview");

const SETS = [
  {
    label: "production",
    d1: "ruphak-trading",
    kv: "ruphak-engine-kv",
    queues: ["events-to-score", "events-to-score-dlq"],
    buckets: ["ruphak-data", "ruphak-next-cache"],
    d1Placeholder: "00000000-0000-0000-0000-000000000000",
    kvPlaceholder: "00000000000000000000000000000000",
  },
  {
    label: "preview",
    d1: "ruphak-trading-preview",
    kv: "ruphak-engine-kv-preview",
    queues: ["events-to-score-preview", "events-to-score-preview-dlq"],
    buckets: ["ruphak-data-preview"],
    d1Placeholder: "00000000-0000-0000-0000-000000000001",
    kvPlaceholder: "00000000000000000000000000000001",
  },
];

function wrangler(args, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) {
    console.error(`\nwrangler ${args.join(" ")} failed:\n${out.trim().split("\n").slice(-15).join("\n")}`);
    process.exit(1);
  }
  return { ok: r.status === 0, out, stdout: r.stdout ?? "" };
}

/** First JSON array or object in wrangler's output (it may print banners and warnings around it). */
function parseJson(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (!(t.startsWith("[") || t.startsWith("{")) || /^\[(WARNING|ERROR|INFO)\]/.test(t)) continue;
    const rest = lines.slice(i).join("\n").trimStart();
    const close = rest[0] === "[" ? "]" : "}";
    for (let end = rest.lastIndexOf(close); end > 0; end = rest.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(rest.slice(0, end + 1));
      } catch {
        // shorten to the previous closing bracket
      }
    }
  }
  return null;
}

const alreadyExists = (out) => /already exists|already taken|code: 10026|code: 11009|code: 100(1|14)|name is already|409/i.test(out);

function ensureD1(name) {
  const find = () => (parseJson(wrangler(["d1", "list", "--json"]).stdout) ?? []).find((d) => d.name === name);
  let db = find();
  if (!db) {
    console.log(`Creating D1 database ${name} (location hint: apac)...`);
    wrangler(["d1", "create", name, "--location", "apac"]);
    db = find();
  } else console.log(`D1 database ${name} exists.`);
  if (!db?.uuid) throw new Error(`could not read the id of D1 database ${name}`);
  return db.uuid;
}

function ensureKv(title) {
  const find = () => {
    const list = parseJson(wrangler(["kv", "namespace", "list"]).stdout) ?? [];
    return list.find((n) => n.title === title) ?? list.find((n) => typeof n.title === "string" && n.title.endsWith(`-${title}`));
  };
  let ns = find();
  if (!ns) {
    console.log(`Creating KV namespace ${title}...`);
    wrangler(["kv", "namespace", "create", title]);
    ns = find();
  } else console.log(`KV namespace ${title} exists.`);
  if (!ns?.id) throw new Error(`could not read the id of KV namespace ${title}`);
  return ns.id;
}

function ensureQueue(name) {
  const r = wrangler(["queues", "create", name], { allowFail: true });
  if (r.ok) console.log(`Created queue ${name}.`);
  else if (alreadyExists(r.out)) console.log(`Queue ${name} exists.`);
  else {
    console.error(`Could not create queue ${name}:\n${r.out.trim().split("\n").slice(-8).join("\n")}`);
    process.exit(1);
  }
}

function ensureBucket(name) {
  const r = wrangler(["r2", "bucket", "create", name, "--location", "apac"], { allowFail: true });
  if (r.ok) console.log(`Created R2 bucket ${name}.`);
  else if (alreadyExists(r.out)) console.log(`R2 bucket ${name} exists.`);
  else {
    console.error(`Could not create R2 bucket ${name} (is R2 enabled on the account?):\n${r.out.trim().split("\n").slice(-8).join("\n")}`);
    process.exit(1);
  }
}

const who = wrangler(["whoami"], { allowFail: true });
if (!who.ok || /not authenticated/i.test(who.out)) {
  console.error("Wrangler is not logged in. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(1);
}
console.log("Wrangler is authenticated.");

let config = readFileSync(ENGINE_CONFIG, "utf8");
const done = [];
for (const set of SETS) {
  if (set.label === "preview" && !withPreview) continue;
  console.log(`\n--- ${set.label} resources ---`);
  const d1Id = ensureD1(set.d1);
  const kvId = ensureKv(set.kv);
  for (const q of set.queues) ensureQueue(q);
  for (const b of set.buckets) ensureBucket(b);
  if (config.includes(set.d1Placeholder)) config = config.replace(set.d1Placeholder, d1Id);
  if (config.includes(set.kvPlaceholder)) config = config.replace(set.kvPlaceholder, kvId);
  done.push(`${set.label}: D1 ${set.d1} = ${d1Id}, KV ${set.kv} = ${kvId}`);
}
writeFileSync(ENGINE_CONFIG, config);

console.log(`\nUpdated workers/engine/wrangler.jsonc:\n  ${done.join("\n  ")}`);
console.log(`
Next:
  1. Secrets (ADMIN_TOKEN is the only required one for paper trading):
       npx wrangler secret put ADMIN_TOKEN --config workers/engine/wrangler.jsonc
       npx wrangler secret put ADMIN_TOKEN            # dashboard Worker, same value
     Optional: ANTHROPIC_API_KEY, GNEWS_API_KEY, GROWW_API_KEY, GROWW_TOTP_SECRET, TELEGRAM_* (see .dev.vars.example).
  2. npm run db:migrate:remote && npm run deploy:engine && npm run deploy:dashboard
  3. Commit the updated workers/engine/wrangler.jsonc (resource IDs are not secrets).`);
