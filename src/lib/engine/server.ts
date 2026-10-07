/**
 * Server-side access to the engine. All engine data comes from the engine Worker's
 * EngineAdmin RPC entrypoint (service binding ENGINE); when that binding is missing, or
 * ENGINE_MOCK=1, the dashboard falls back to its built-in mock engine.
 */
import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { EngineApi } from "@/engine/api-types";
import { getMockEngine, type MockClockMode } from "./mock";

export type EngineSource = "engine" | "mock";

async function cloudflareEnv(): Promise<CloudflareEnv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    return ctx.env;
  } catch {
    return null;
  }
}

function pick(name: "ENGINE_MOCK" | "ENGINE_MOCK_FAIL" | "ADMIN_TOKEN", env: CloudflareEnv | null): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess !== "") return fromProcess;
  const fromEnv = env?.[name];
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : undefined;
}

function adminTokenFrom(env: CloudflareEnv | null): string | null {
  const token = pick("ADMIN_TOKEN", env);
  if (token) return token;
  // Local development convenience: the documented default token.
  return process.env.NODE_ENV === "development" ? "dev" : null;
}

function mockFor(env: CloudflareEnv | null): EngineApi {
  const clock: MockClockMode = process.env.ENGINE_MOCK_CLOCK === "real" ? "real" : "sim";
  return getMockEngine({ adminToken: adminTokenFrom(env), fail: pick("ENGINE_MOCK_FAIL", env) === "1" }, clock);
}

/**
 * The EngineApi to use for this request: the real engine through the service binding, or
 * the mock when ENGINE_MOCK=1 or the binding is absent.
 */
export async function getEngineApi(): Promise<{ api: EngineApi; source: EngineSource }> {
  if (process.env.ENGINE_MOCK === "1") return { api: mockFor(null), source: "mock" };
  const env = await cloudflareEnv();
  if (pick("ENGINE_MOCK", env) === "1") return { api: mockFor(env), source: "mock" };
  if (env?.ENGINE) return { api: env.ENGINE, source: "engine" };
  return { api: mockFor(env), source: "mock" };
}

/** The admin token the route handlers compare against, or null when admin actions are disabled. */
export async function getAdminToken(): Promise<string | null> {
  const fromProcess = process.env.ADMIN_TOKEN;
  if (fromProcess) return fromProcess;
  return adminTokenFrom(await cloudflareEnv());
}
