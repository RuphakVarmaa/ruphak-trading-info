/** Node-only helpers for the research scripts: env files, a JSON cache, argument parsing. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const CACHE_DIR = resolve(ROOT, ".cache");
export const REPORTS_DIR = resolve(ROOT, "reports");

/** Loads KEY=VALUE files (.env, .dev.vars, workers/engine/.dev.vars) without overriding the environment. */
export function loadEnvFiles(): void {
  for (const f of [".env", ".env.local", ".dev.vars", "workers/engine/.dev.vars"]) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
    }
  }
}

export function readJson<T>(path: string): T | null {
  const p = resolve(ROOT, path);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function writeJson(path: string, data: unknown): string {
  const p = resolve(ROOT, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

export type Args = Record<string, string | boolean>;

/** --key value, --key=value and bare --flag. */
export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

export function str(args: Args, key: string, fallback?: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

export function num(args: Args, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fixed-width table for terminal reports. */
export function table(rows: (string | number)[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => (typeof v === "number" ? String(v).padStart(widths[c]) : String(v).padEnd(widths[c]))).join("  ")).join("\n");
}
