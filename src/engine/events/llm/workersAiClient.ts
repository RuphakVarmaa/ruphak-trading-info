/**
 * LlmClient on Cloudflare Workers AI, by default Z.ai GLM-5.3 (`@cf/zai-org/glm-5.3`).
 *
 * Inside the engine Worker the `AI` binding runs the model with no API key; Node scripts use the
 * REST endpoint with a Cloudflare API token (`workersAiRestRunner`). GLM-5.3 always reasons
 * (`reasoning_effort` low | high | max) and supports structured outputs, but the exact
 * `response_format` shape Workers AI expects for it is not documented, so the client tries three
 * modes and keeps the first one that works: OpenAI-style json_schema, Workers AI JSON-mode style,
 * then plain prompting. Every answer is validated against the Zod schema; one corrective retry
 * follows a bad answer, and anything still invalid returns `parsed: null` so the caller falls
 * back to the lexicon scorer.
 */
import { z, type ZodType } from "zod";
import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "../../ports";
import { fetchWithTimeout, type FetchLike } from "../../util/http";

export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.3";

/** Runs a Workers AI model: `(model, input) => env.AI.run(model, input)` or a REST runner. */
export type WorkersAiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;

export type ResponseFormatMode = "openai" | "workers" | "prompt";
export const RESPONSE_FORMAT_MODES: readonly ResponseFormatMode[] = ["openai", "workers", "prompt"];

/** Engine effort to GLM's reasoning_effort (reasoning cannot be turned off). */
export const REASONING_EFFORT: Record<LlmRequest<unknown>["effort"], "low" | "high" | "max"> = { low: "low", medium: "high", high: "max" };

export class WorkersAiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WorkersAiError";
  }
}

export interface WorkersAiClientOptions {
  run: WorkersAiRun;
  /** Structured-output mode to start with (default "openai"). */
  mode?: ResponseFormatMode;
  /** Consecutive unparseable answers in one mode before trying the next mode (default 3). */
  maxBadAnswersPerMode?: number;
  log?: (msg: string, data?: unknown) => void;
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** JSON Schema for a Zod schema, without the `$schema` key some validators reject. */
export function jsonSchemaOf(schema: ZodType<unknown>): Rec {
  const out = z.toJSONSchema(schema) as Rec;
  delete out.$schema;
  return out;
}

/** The model's answer from either output shape: OpenAI-style `choices` or Workers AI `response`. */
export function answerOf(out: unknown): string | Rec | null {
  const r = rec(out);
  if (!r) return typeof out === "string" ? out : null;
  const choice = rec(Array.isArray(r.choices) ? r.choices[0] : null);
  const message = rec(choice?.message);
  if (message) {
    const content = message.content;
    if (typeof content === "string") return content;
    if (rec(content)) return content as Rec;
    if (Array.isArray(content)) {
      return content.map((p) => (typeof p === "string" ? p : typeof rec(p)?.text === "string" ? (rec(p)!.text as string) : "")).join("");
    }
  }
  if (typeof choice?.text === "string") return choice.text;
  if (typeof r.response === "string") return r.response;
  if (rec(r.response)) return r.response as Rec;
  return null;
}

/** Removes reasoning blocks a model may emit before its answer. */
export function stripReasoning(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = t.search(/<think>/i);
  if (open !== -1) t = t.slice(0, open); // unterminated reasoning: nothing after it is the answer
  return t.trim();
}

/** The balanced JSON value starting at `start` (respecting strings), parsed, or undefined. */
function balancedJsonAt(t: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** First complete JSON object or array in a text (handles reasoning blocks, code fences and prose). */
export function firstJson(text: string): unknown {
  const t = stripReasoning(text).replace(/```(?:json)?/gi, "");
  try {
    return JSON.parse(t);
  } catch {
    // look for an embedded value
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{" && t[i] !== "[") continue;
    const v = balancedJsonAt(t, i);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function usageOf(out: unknown): LlmUsage {
  const u = rec(rec(out)?.usage);
  if (!u) return { ...ZERO };
  const details = rec(u.prompt_tokens_details);
  return {
    inputTokens: num(u.prompt_tokens) || num(u.input_tokens),
    outputTokens: num(u.completion_tokens) || num(u.output_tokens),
    cacheReadTokens: num(details?.cached_tokens) || num(u.cached_tokens),
    cacheCreationTokens: 0,
  };
}

function finishReason(out: unknown): string | null {
  const choice = rec(Array.isArray(rec(out)?.choices) ? (rec(out)!.choices as unknown[])[0] : null);
  return typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
}

/** True when the request itself was refused (so another response_format may work), not on timeouts or 5xx. */
export function isRequestProblem(err: unknown): boolean {
  const status = err instanceof WorkersAiError ? err.status : null;
  if (status !== null && status >= 500) return false;
  if (status === 429) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? ?out|timeout|network|ECONN|fetch failed/i.test(msg)) return false;
  return status === 400 || status === 422 || /response_format|json_schema|schema|invalid (input|request|argument)|unrecognized|not supported|AiError: 5006|code: 5006/i.test(msg);
}

const add = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; raw: string };

export class WorkersAiLlmClient implements LlmClient {
  private mode: ResponseFormatMode;
  private badAnswers = 0;

  constructor(private readonly o: WorkersAiClientOptions) {
    this.mode = o.mode ?? "openai";
  }

  /** Structured-output mode currently in use. */
  get currentMode(): ResponseFormatMode {
    return this.mode;
  }

  private buildInput<T>(req: LlmRequest<T>, mode: ResponseFormatMode, retry?: { previous: string; error: string }): Rec {
    const schema = jsonSchemaOf(req.schema as ZodType<unknown>);
    const system = `${req.system}\n\nOutput format: reply with only one JSON object that matches this JSON Schema exactly. No prose, no code fences.\n${JSON.stringify(schema)}`;
    const messages: { role: string; content: string }[] = [
      { role: "system", content: system },
      { role: "user", content: req.user },
    ];
    if (retry) {
      messages.push({ role: "assistant", content: retry.previous.slice(0, 8_000) });
      messages.push({ role: "user", content: `That answer did not match the schema (${retry.error.slice(0, 500)}). Reply again with only the corrected JSON object.` });
    }
    const input: Rec = { messages, max_completion_tokens: req.maxTokens, reasoning_effort: REASONING_EFFORT[req.effort] };
    if (mode === "openai") input.response_format = { type: "json_schema", json_schema: { name: "structured_output", schema, strict: true } };
    else if (mode === "workers") input.response_format = { type: "json_schema", json_schema: schema };
    return input;
  }

  private parse<T>(schema: ZodType<T>, out: unknown): ParseResult<T> {
    const answer = answerOf(out);
    if (answer === null) return { ok: false, error: "empty answer", raw: "" };
    const raw = typeof answer === "string" ? answer : JSON.stringify(answer);
    const value = typeof answer === "string" ? firstJson(answer) : answer;
    if (value === undefined) return { ok: false, error: "no JSON object in the answer", raw };
    const res = schema.safeParse(value);
    if (res.success) return { ok: true, value: res.data };
    const issue = res.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "schema mismatch", raw };
  }

  /** Calls the model, moving to the next structured-output mode when the request is refused. */
  private async call<T>(req: LlmRequest<T>, retry?: { previous: string; error: string }): Promise<unknown> {
    for (let i = RESPONSE_FORMAT_MODES.indexOf(this.mode); i < RESPONSE_FORMAT_MODES.length; i++) {
      const mode = RESPONSE_FORMAT_MODES[i];
      try {
        const out = await this.o.run(req.model, this.buildInput(req, mode, retry));
        if (mode !== this.mode) {
          this.o.log?.("workers-ai: switched structured-output mode", { from: this.mode, to: mode });
          this.mode = mode;
          this.badAnswers = 0;
        }
        return out;
      } catch (err) {
        if (i < RESPONSE_FORMAT_MODES.length - 1 && isRequestProblem(err)) {
          this.o.log?.("workers-ai: request refused; trying the next structured-output mode", { mode, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          continue;
        }
        throw err;
      }
    }
    throw new WorkersAiError("no structured-output mode left", null);
  }

  private noteBadAnswer(): void {
    this.badAnswers++;
    const limit = this.o.maxBadAnswersPerMode ?? 3;
    const idx = RESPONSE_FORMAT_MODES.indexOf(this.mode);
    if (this.badAnswers >= limit && idx < RESPONSE_FORMAT_MODES.length - 1) {
      const next = RESPONSE_FORMAT_MODES[idx + 1];
      this.o.log?.("workers-ai: repeated invalid answers; trying the next structured-output mode", { from: this.mode, to: next });
      this.mode = next;
      this.badAnswers = 0;
    }
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    let usage: LlmUsage = { ...ZERO };
    const first = await this.call(req);
    usage = add(usage, usageOf(first));
    const p1 = this.parse(req.schema, first);
    if (p1.ok) {
      this.badAnswers = 0;
      return { parsed: p1.value, usage, model: req.model, stopReason: finishReason(first) };
    }
    this.o.log?.("workers-ai: invalid answer; asking once for a correction", { error: p1.error });
    let second: unknown;
    try {
      second = await this.call(req, { previous: p1.raw, error: p1.error });
    } catch (err) {
      this.noteBadAnswer();
      throw err;
    }
    usage = add(usage, usageOf(second));
    const p2 = this.parse(req.schema, second);
    if (p2.ok) {
      this.badAnswers = 0;
      return { parsed: p2.value, usage, model: req.model, stopReason: finishReason(second) };
    }
    this.noteBadAnswer();
    return { parsed: null, usage, model: req.model, stopReason: "invalid_output" };
  }
}

/**
 * REST runner for Node scripts: POST /client/v4/accounts/{accountId}/ai/run/{model} with a
 * Cloudflare API token that has Workers AI permission. Returns the `result` of the envelope.
 */
export function workersAiRestRunner(o: { accountId: string; apiToken: string; fetchImpl?: FetchLike; timeoutMs?: number }): WorkersAiRun {
  if (!o.accountId || !o.apiToken) throw new Error("Workers AI REST needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  return async (model, input) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.accountId)}/ai/run/${model}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        o.fetchImpl ?? ((i, init) => fetch(i, init)),
        url,
        { method: "POST", headers: { Authorization: `Bearer ${o.apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify(input) },
        o.timeoutMs ?? 180_000,
      );
    } catch (err) {
      throw new WorkersAiError(`Workers AI request failed: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    const text = await res.text();
    let body: Rec | null = null;
    try {
      body = rec(JSON.parse(text));
    } catch {
      body = null;
    }
    if (!res.ok || body?.success === false) {
      const errors = Array.isArray(body?.errors) ? (body!.errors as unknown[]).map((e) => rec(e)?.message ?? String(e)).join("; ") : text.slice(0, 300);
      throw new WorkersAiError(`Workers AI HTTP ${res.status}: ${errors || "error"}`, res.status);
    }
    return body && "result" in body ? body.result : body;
  };
}
