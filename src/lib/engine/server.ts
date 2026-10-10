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

const RPC_METHODS = [
  "getState",
  "getSignals",
  "getPositions",
  "getEvents",
  "getEventDetail",
  "getOrders",
  "getPnl",
  "getPerformance",
  "getScheduled",
  "getTodayPlan",
  "getBacktest",
  "getCopyTickets",
  "verifyAdmin",
  "setArmed",
  "setKillSwitch",
  "setMode",
  "startBacktest",
] as const satisfies readonly (keyof EngineApi)[];

// Every EngineApi method must be forwarded: a method missing from RPC_METHODS fails to compile here.
type Unforwarded = Exclude<keyof EngineApi, (typeof RPC_METHODS)[number]>;
const ALL_FORWARDED: [Unforwarded] extends [never] ? true : Unforwarded = true;
void ALL_FORWARDED;

/**
 * Workers RPC returns thenables and objects that are not plain (proxies / null prototypes);
 * React refuses to pass those to Client Components. Every result is copied into plain JSON,
 * which the DTO contract guarantees is lossless.
 */
function plainRpc(stub: EngineApi): EngineApi {
  // Call methods directly on the stub: on an RPC stub every property access (even `.apply`)
  // becomes part of the remote call path, so the method must never be detached.
  const target = stub as unknown as Record<string, (...args: unknown[]) => PromiseLike<unknown>>;
  const out: Record<string, unknown> = {};
  for (const name of RPC_METHODS) {
    out[name] = async (...args: unknown[]) => {
      const value = await target[name](...args);
      return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
    };
  }
  return out as unknown as EngineApi;
}

/**
 * The EngineApi to use for this request: the real engine through the service binding, or
 * the mock when ENGINE_MOCK=1 or the binding is absent.
 */
export async function getEngineApi(): Promise<{ api: EngineApi; source: EngineSource }> {
  if (process.env.ENGINE_MOCK === "1") return { api: mockFor(null), source: "mock" };
  const env = await cloudflareEnv();
  if (pick("ENGINE_MOCK", env) === "1") return { api: mockFor(env), source: "mock" };
  if (env?.ENGINE) return { api: plainRpc(env.ENGINE), source: "engine" };
  return { api: mockFor(env), source: "mock" };
}

/** The admin token the route handlers compare against, or null when admin actions are disabled. */
export async function getAdminToken(): Promise<string | null> {
  const fromProcess = process.env.ADMIN_TOKEN;
  if (fromProcess) return fromProcess;
  return adminTokenFrom(await cloudflareEnv());
}
