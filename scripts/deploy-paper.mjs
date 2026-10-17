#!/usr/bin/env node
// One-command deployment of the engine and dashboard Workers for PAPER trading.
//
//   npm run deploy:paper              # needs Wrangler logged in, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
//   npm run deploy:paper -- --dry-run # print the steps only
//
// Required environment: ENGINE_ADMIN_TOKEN (32+ characters; you type it into the dashboard's
// Admin button). Optional, set as Worker secrets when present: ENGINE_GNEWS_API_KEY,
// ENGINE_TELEGRAM_BOT_TOKEN, ENGINE_TELEGRAM_CHAT_ID, ENGINE_TELEGRAM_WEBHOOK_SECRET,
// ENGINE_GROWW_API_KEY, ENGINE_GROWW_TOTP_SECRET, ENGINE_ANTHROPIC_API_KEY (only used when
// LLM_PROVIDER is "anthropic"). Secret values go to Wrangler on stdin and are never printed.
// Live trading stays off: LIVE_TRADING is "false" in workers/engine/wrangler.jsonc.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = "workers/engine/wrangler.jsonc";
const dryRun = process.argv.includes("--dry-run");

const ENGINE_SECRETS = [
  ["ADMIN_TOKEN", "ENGINE_ADMIN_TOKEN"],
  ["GNEWS_API_KEY", "ENGINE_GNEWS_API_KEY"],
  ["TELEGRAM_BOT_TOKEN", "ENGINE_TELEGRAM_BOT_TOKEN"],
  ["TELEGRAM_CHAT_ID", "ENGINE_TELEGRAM_CHAT_ID"],
  ["TELEGRAM_WEBHOOK_SECRET", "ENGINE_TELEGRAM_WEBHOOK_SECRET"],
  ["GROWW_API_KEY", "ENGINE_GROWW_API_KEY"],
  ["GROWW_TOTP_SECRET", "ENGINE_GROWW_TOTP_SECRET"],
  ["ANTHROPIC_API_KEY", "ENGINE_ANTHROPIC_API_KEY"],
];

function step(title) {
  console.log(`\n==> ${title}`);
}

/** Runs a command from the repo root. `input` is piped to stdin (secrets) and never echoed. */
function run(cmd, args, { input, capture = false, env = {}, allowFail = false } = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}${input !== undefined ? "   (value on stdin)" : ""}`);
  if (dryRun) return { ok: true, out: "" };
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    input,
    stdio: [input !== undefined ? "pipe" : "inherit", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (capture && out) process.stdout.write(out.split("\n").filter((l) => !/secret|token/i.test(l) || /Success|Uploaded|Created/i.test(l)).join("\n"));
  if (r.status !== 0 && !allowFail) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
  return { ok: r.status === 0, out };
}

async function smokeTest(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${url}/api/engine/state`, { headers: { accept: "application/json" } });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body.data?.dataSource === "engine") {
        console.log(`Dashboard reads the engine: mode ${body.data.mode}, phase ${body.data.market?.phase}, live switch ${body.data.liveTradingEnabled ? "ON" : "off"}.`);
        return true;
      }
      console.log(`Attempt ${attempt}: HTTP ${res.status} ${body?.code ?? ""} ${body?.data?.dataSource ?? ""}`.trim());
    } catch (err) {
      console.log(`Attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return false;
}

async function main() {
  step("Preflight");
  const admin = process.env.ENGINE_ADMIN_TOKEN ?? "";
  if (!dryRun && admin.length < 32) {
    console.error("Set ENGINE_ADMIN_TOKEN to a random string of at least 32 characters (keep a copy: the dashboard's Admin button asks for it).");
    process.exit(1);
  }
  const who = run("npx", ["wrangler", "whoami"], { capture: true, allowFail: true });
  if (!dryRun && (!who.ok || /not authenticated/i.test(who.out))) {
    console.error("Wrangler is not authenticated: run `npx wrangler login` or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
    process.exit(1);
  }

  step("Cloudflare resources and IDs");
  run("node", ["scripts/cloudflare-setup.mjs"]);

  step("D1 migrations");
  run("npx", ["wrangler", "d1", "migrations", "apply", "ruphak-trading", "--remote", "--config", ENGINE], { env: { CI: "true" } });

  step("Engine Worker");
  run("npx", ["wrangler", "deploy", "--config", ENGINE]);
  for (const [name, envName] of ENGINE_SECRETS) {
    const value = process.env[envName];
    if (!value) {
      console.log(`(skipping ${name}: ${envName} is not set)`);
      continue;
    }
    run("npx", ["wrangler", "secret", "put", name, "--config", ENGINE], { input: value, capture: true });
  }

  step("Dashboard Worker");
  run("npx", ["opennextjs-cloudflare", "build"]);
  const deployed = run("npx", ["opennextjs-cloudflare", "deploy"], { capture: true });
  run("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], { input: admin || "dry-run", capture: true });
  const url = /https:\/\/ruphak-dashboard\.[a-z0-9-]+\.workers\.dev/i.exec(deployed.out)?.[0] ?? null;

  step("Smoke test");
  if (dryRun) console.log("(skipped in dry run)");
  else if (!url) console.log("Could not find the workers.dev URL in the deploy output; open the dashboard from the Cloudflare dashboard and check /api/engine/state.");
  else if (!(await smokeTest(url))) {
    console.error(`The dashboard at ${url} does not read the engine yet. Check \`npx wrangler tail ruphak-dashboard\`.`);
    process.exit(1);
  }

  console.log(`
Done${url ? `: ${url}` : ""}.
- News ingest runs every 10 minutes; scored stories appear in the event feed shortly after.
- On trading days: instruments at 08:10 IST, pre-market at 08:30, the trading loop from 09:00.
- Paper trading only: live orders stay off until LIVE_TRADING, LIVE mode, ARM and the relay are all enabled.
- Commit the updated workers/engine/wrangler.jsonc and wrangler.jsonc (resource IDs, not secrets).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
