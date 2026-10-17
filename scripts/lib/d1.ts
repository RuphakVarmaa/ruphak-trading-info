/**
 * Node helpers for the D1 bar-archive scripts: `wrangler d1 execute` against the local database
 * (.wrangler/state, the one `npm run db:migrate:local` and `npm run dev:engine` use) or, only when a
 * script is asked for it, the deployed one; and guards that keep raw market data out of git (the
 * repository is public).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ROOT } from "./node";

export const D1_DATABASE = "ruphak-trading";
export const ENGINE_CONFIG = "workers/engine/wrangler.jsonc";
export const LOCAL_PERSIST = ".wrangler/state";

export type D1Target = "local" | "remote";

function wranglerBin(): string {
  return resolve(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
}

function targetArgs(target: D1Target): string[] {
  return target === "remote" ? ["--remote"] : ["--local", "--persist-to", LOCAL_PERSIST];
}

function wrangler(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [wranglerBin(), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Runs SQL statements (no bound parameters) in one `wrangler d1 execute --json` call; returns each statement's rows. */
export function queryD1(statements: string[], target: D1Target): Record<string, unknown>[][] {
  const r = wrangler(["d1", "execute", D1_DATABASE, "--config", ENGINE_CONFIG, ...targetArgs(target), "--json", "--command", statements.join(";\n")]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  if (!Array.isArray(parsed) || r.status !== 0) {
    const text = (parsed as { error?: { text?: string } } | null)?.error?.text;
    throw new Error(`D1 query failed: ${text ?? JSON.stringify(parsed).slice(0, 800)}`);
  }
  return parsed.map((x: { results?: unknown }) => (Array.isArray(x?.results) ? (x.results as Record<string, unknown>[]) : []));
}

/** Applies a SQL file to the LOCAL D1 (.wrangler/state). There is deliberately no remote variant. */
export function executeLocalD1File(file: string): void {
  const r = wrangler(["d1", "execute", D1_DATABASE, "--config", ENGINE_CONFIG, ...targetArgs("local"), "--yes", "--file", file]);
  if (r.status !== 0) throw new Error(`wrangler d1 execute --local --file ${file} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
}

/** POSIX shell quoting for printed commands. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The command that applies a SQL file, for a human to run from the repository root. */
export function d1FileCommand(file: string, target: D1Target): string {
  const where = target === "remote" ? ["--remote"] : ["--local"];
  const persist = target === "local" ? ["--persist-to", LOCAL_PERSIST] : [];
  return ["npx", "wrangler", "d1", "execute", D1_DATABASE, ...where, "--config", ENGINE_CONFIG, ...persist, "--file", shellQuote(file)].join(" ");
}

/** The command that runs one SQL query, for a human to run from the repository root. */
export function d1QueryCommand(sql: string, target: D1Target): string {
  const persist = target === "local" ? " --persist-to " + LOCAL_PERSIST : "";
  return `npx wrangler d1 execute ${D1_DATABASE} --${target} --config ${ENGINE_CONFIG}${persist} --command ${shellQuote(sql)}`;
}

export function isInsideRepo(path: string): boolean {
  const rel = relative(ROOT, resolve(ROOT, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when git ignores the path (without git: when it is under .cache/, which .gitignore lists). */
export function isGitIgnored(path: string): boolean {
  const abs = resolve(ROOT, path);
  const r = spawnSync("git", ["check-ignore", "-q", abs], { cwd: ROOT });
  if (r.error || (r.status !== 0 && r.status !== 1)) return relative(ROOT, abs).split(/[\\/]/)[0] === ".cache";
  return r.status === 0;
}
