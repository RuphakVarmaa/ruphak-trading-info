/**
 * Runs the repository contract against a real local D1 (Miniflare via wrangler's
 * getPlatformProxy) with the committed migrations applied.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";
import { getPlatformProxy } from "wrangler";
import { DEFAULT_CONFIG } from "../../../../src/engine/config";
import { repositoryContract } from "../../../../src/engine/repo/contract";
import { D1Repository } from "./d1Repository";

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let counter = 0;

const migrationsDir = new URL("../../../../migrations/", import.meta.url);
const migrationSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, migrationsDir), "utf8"))
  .join("\n");

const TABLES = ["articles", "clusters", "event_scores", "pressure", "snapshots", "decisions", "outcomes", "plans", "orders", "fills", "positions", "trades", "performance", "ledger", "settings", "kv_state", "audit", "heartbeat"];

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: "workers/engine/wrangler.jsonc", persist: false });
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const st of statements) await proxy.env.DB.prepare(st).run();
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

repositoryContract("D1", async () => {
  // Fresh tables for every test.
  for (const t of TABLES) await proxy.env.DB.prepare(`DELETE FROM ${t}`).run();
  counter++;
  return new D1Repository(proxy.env.DB, DEFAULT_CONFIG, () => Date.parse("2026-10-07T05:00:00Z") + counter);
});
