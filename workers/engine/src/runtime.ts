/**
 * Engine runtime for the Worker: configuration from vars/secrets, logging, the D1 repository,
 * and factories for the Groww data client, relay client and LLM client.
 * Secrets are read from `env` only; nothing secret is ever logged or returned.
 */
import { ACCOUNTS, accountConfig, parseAccounts, type AccountId, type AccountSpec } from "../../../src/engine/accounts";
import type { AccountView } from "../../../src/engine/api-types";
import { TradingCalendar, defaultCalendar } from "../../../src/engine/calendar/calendar";
import { makeConfig, parseIndices, parseMaxOpenPerIndex, parseMaxTradesPerDay, type EngineConfig } from "../../../src/engine/config";
import { AnthropicLlmClient } from "../../../src/engine/events/llm/anthropicClient";
import { DEFAULT_WORKERS_AI_MODEL, WorkersAiLlmClient, type ResponseFormatMode } from "../../../src/engine/events/llm/workersAiClient";
import type { LlmClient, Logger, Repository } from "../../../src/engine/ports";
import { accountRepository } from "../../../src/engine/repo/accountRepo";
import { GrowwDataClient, GrowwHttp, RelayClient, type GrowwTransport, type TokenSource } from "../../../src/engine/broker/groww";
import { D1Repository } from "./db/d1Repository";

export const ENGINE_VERSION = "2026.10.09-2";

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

export type LlmProvider = "workers-ai" | "anthropic" | "lexicon";

/**
 * News scorer provider: Workers AI (default, through the AI binding), Anthropic, or "lexicon"
 * (no model at all; `npm run dev:engine` uses it because the AI binding only runs remotely).
 */
export function llmProvider(env: Env): LlmProvider {
  if (env.LLM_PROVIDER === "anthropic") return "anthropic";
  if (env.LLM_PROVIDER === "lexicon" || env.LLM_PROVIDER === "none") return "lexicon";
  return "workers-ai";
}

function llmAvailable(env: Env): boolean {
  const provider = llmProvider(env);
  if (provider === "lexicon") return false;
  return provider === "anthropic" ? Boolean(env.ANTHROPIC_API_KEY) : Boolean(env.AI);
}

export function engineConfig(env: Env): EngineConfig {
  const effort = env.LLM_EFFORT === "low" || env.LLM_EFFORT === "high" ? env.LLM_EFFORT : "medium";
  const provider = llmProvider(env);
  return makeConfig({
    capitalRupees: num(env.CAPITAL_INR, 500_000),
    indices: parseIndices(env.INDICES),
    sizing: { maxOpenPerIndex: parseMaxOpenPerIndex(env.MAX_OPEN_PER_INDEX), maxTradesPerDay: parseMaxTradesPerDay(env.MAX_TRADES_PER_DAY) },
    llm: {
      enabled: llmAvailable(env),
      model: env.LLM_MODEL || (provider === "anthropic" ? "claude-opus-5-5" : DEFAULT_WORKERS_AI_MODEL),
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

/** Paper accounts this Worker runs (Worker var ACCOUNTS); main is always first. */
export function enabledAccounts(env: Env): AccountId[] {
  return parseAccounts(env.ACCOUNTS);
}

export interface AccountRuntime {
  spec: AccountSpec;
  cfg: EngineConfig;
  /** The engine repository scoped to this account (main gets it unchanged). */
  repo: Repository;
}

export function accountRuntime(rt: Runtime, id: AccountId): AccountRuntime {
  const cfg = accountConfig(rt.cfg, id);
  return { spec: ACCOUNTS[id], cfg, repo: accountRepository(rt.repo, id, cfg, Date.now) };
}

export function accountViews(rt: Runtime, ids: AccountId[]): AccountView[] {
  return ids.map((id) => {
    const s = ACCOUNTS[id];
    return { id, label: s.label, shortLabel: s.shortLabel, paperOnly: s.paperOnly, capitalRupees: accountConfig(rt.cfg, id).capitalRupees };
  });
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

export function llmClient(env: Env, logger?: Logger, opts: { mode?: ResponseFormatMode } = {}): LlmClient | null {
  if (llmProvider(env) === "lexicon") return null;
  if (llmProvider(env) === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return null;
    return new AnthropicLlmClient({ apiKey: env.ANTHROPIC_API_KEY, timeoutMs: 90_000, maxRetries: 1 });
  }
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> } | undefined;
  if (!ai) return null;
  // Call run() on the binding itself: a detached method loses its binding.
  return new WorkersAiLlmClient({ run: (model, input) => ai.run(model, input), mode: opts.mode, log: logger ? (m, d) => logger.warn(m, d) : undefined });
}

/**
 * Optional R2 archive for dated copies of instrument masters and backtest results. Bind "R2"
 * in wrangler.jsonc to enable it; the working copies live in KV and Durable Object storage.
 */
export function archiveBucket(env: Env): R2Bucket | null {
  return (env as Env & { R2?: R2Bucket }).R2 ?? null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
