/**
 * Bindings and vars the dashboard Worker reads through `getCloudflareContext()`.
 * Augments the global `CloudflareEnv` interface declared by @opennextjs/cloudflare.
 */
import type { EngineApi } from "@/engine/api-types";

declare global {
  interface CloudflareEnv {
    /** Service binding to the engine Worker's EngineAdmin RPC entrypoint (methods are callable directly). */
    ENGINE?: EngineApi;
    /** "1" forces the built-in mock engine. */
    ENGINE_MOCK?: string;
    /** "1" makes every mock read throw (exercises the stale/offline UI). */
    ENGINE_MOCK_FAIL?: string;
    /** Admin token for arm / kill switch / mode / backtest routes. */
    ADMIN_TOKEN?: string;
  }
}

export {};
