/**
 * Anthropic-backed LlmClient using structured outputs (Zod → output_config.format).
 * Fetch-based SDK, so it runs in Workers, Node and tests.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { LlmClient, LlmRequest, LlmResponse } from "../../ports";

/** Models that accept server-side refusal fallbacks with `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
/** Models that do not accept output_config.effort. */
const NO_EFFORT_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-4-5"]);

export interface AnthropicLlmClientOptions {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Opt in to server-side refusal fallbacks on supported models (default true). */
  fallbacks?: boolean;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicLlmClientOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.fallbacks = opts.fallbacks ?? true;
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const useFallbacks = this.fallbacks && FALLBACK_MODELS.has(req.model);
    const resp = await this.client.beta.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
      output_config: {
        format: betaZodOutputFormat(req.schema),
        ...(NO_EFFORT_MODELS.has(req.model) ? {} : { effort: req.effort }),
      },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const usage = {
      inputTokens: resp.usage.input_tokens ?? 0,
      outputTokens: resp.usage.output_tokens ?? 0,
      cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage.cache_creation_input_tokens ?? 0,
    };
    if (resp.stop_reason === "refusal") {
      return { parsed: null, usage, model: resp.model, stopReason: "refusal" };
    }
    return { parsed: (resp.parsed_output as T | null) ?? null, usage, model: resp.model, stopReason: resp.stop_reason ?? null };
  }
}
