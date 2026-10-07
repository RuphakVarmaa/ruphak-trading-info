/**
 * Engine runtime for the Worker: configuration from vars/secrets, logging, the D1 repository,
 * and factories for the Groww data client, relay client and LLM client.
 * Secrets are read from `env` only; nothing secret is ever logged or returned.
 */
import { TradingCalendar, defaultCalendar } from "../../../src/engine/calendar/calendar";
import { makeConfig, type EngineConfig } from "../../../src/engine/config";
import { AnthropicLlmClient } from "../../../src/engine/events/llm/anthropicClient";
import type { LlmClient, Logger } from "../../../src/engine/ports";
import { GrowwDataClient, GrowwHttp, RelayClient, type GrowwTransport, type TokenSource } from "../../../src/engine/broker/groww";
import { D1Repository } from "./db/d1Repository";

export const ENGINE_VERSION = "2026.10.07";

export interface Runtime {
  env: Env;
  cfg: EngineConfig;
  calendar: TradingCalendar;
  logger: Logger;
  repo: D1Repository;
  /** Worker var LIVE_TRADING: first key for live orders. */
  liveTradingEnabled: boolean;
  growwConfigured: boolean;
  relayConfigured: boolean;
  version: string;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : fallback;
};

export function engineConfig(env: Env): EngineConfig {
  const effort = env.LLM_EFFORT === "low" || env.LLM_EFFORT === "high" ? env.LLM_EFFORT : "medium";
  return makeConfig({
    capitalRupees: num(env.CAPITAL_INR, 500_000),
    llm: {
      enabled: Boolean(env.ANTHROPIC_API_KEY),
      model: env.LLM_MODEL || "claude-opus-5-5",
      effort,
    },
  });
}

/** JSON-lines logger: one object per line, visible in Workers Logs. */
export function jsonLogger(scope: string): Logger {
  const line = (level: string, msg: string, data?: unknown) => {
    const rec: Record<string, unknown> = { level, scope, msg };
    if (data !== undefined) rec.data = data;
    const text = JSON.stringify(rec, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  };
  return {
    debug: () => {},
    info: (m, d) => line("info", m, d),
    warn: (m, d) => line("warn", m, d),
    error: (m, d) => line("error", m, d),
  };
}

export function makeRuntime(env: Env, scope = "engine"): Runtime {
  const cfg = engineConfig(env);
  return {
    env,
    cfg,
    calendar: defaultCalendar,
    logger: jsonLogger(scope),
    repo: new D1Repository(env.DB, cfg),
    liveTradingEnabled: env.LIVE_TRADING === "true",
    growwConfigured: Boolean(env.GROWW_API_KEY && env.GROWW_TOTP_SECRET),
    relayConfigured: Boolean(env.RELAY_URL && env.RELAY_HMAC_SECRET),
    version: ENGINE_VERSION,
  };
}

export function relayClient(env: Env): RelayClient | null {
  if (!env.RELAY_URL || !env.RELAY_HMAC_SECRET) return null;
  return new RelayClient({
    baseUrl: env.RELAY_URL,
    hmacSecret: env.RELAY_HMAC_SECRET,
    accessClientId: env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
  });
}

/** Groww data over the direct API, or over the relay's data proxy when GROWW_DATA_VIA_RELAY=true. */
export function growwDataClient(env: Env, tokens: TokenSource | null): GrowwDataClient | null {
  let transport: GrowwTransport | null = null;
  if (env.GROWW_DATA_VIA_RELAY === "true") transport = relayClient(env)?.dataTransport() ?? null;
  else if (tokens) transport = new GrowwHttp({ tokens });
  return transport ? new GrowwDataClient(transport) : null;
}

export function llmClient(env: Env): LlmClient | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicLlmClient({ apiKey: env.ANTHROPIC_API_KEY, timeoutMs: 90_000, maxRetries: 1 });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
