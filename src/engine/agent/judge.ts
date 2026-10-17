/**
 * The judges (SPEC §4.1, §4.6, §4.7 as amended, #7). The reflex model sits behind ReflexJudge: one structured call
 * per closed bar judges every finalist at once. The deep model sits behind DeepJudge: escalations and the nightly
 * review. They only judge; code decides.
 *
 * Every call reads the stop reason and the usage before the answer, so a refused, cut-off or malformed answer is
 * still recorded with what it cost, and then parses the joined text blocks itself (the SDK's own parser reads one
 * block at a time and throws on an answer a refusal fallback split in two). Every failure is a status, never a
 * throw: no answer means no entry. Sampling settings and assistant prefill are never sent; refusal fallbacks only
 * for the models the Advisor sends them for.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ZodType } from "zod";
import { FALLBACK_BETA, FALLBACK_MODELS, STRUCTURED_OUTPUTS_BETA } from "../advisor/advise";
import { plainError } from "../advisor/research";
import type { LlmUsage } from "../ports";
import { REFLEX_CALL, REVIEW_CALL } from "./constants";
import type { UsageIteration } from "./cost";
import { promptFinalists, reflexSystem, reflexUser } from "./prompt";
import { REFLEX_OUTPUT_FORMAT, outputFormat } from "./schema";
import type { BriefContext, CallStatus, Finalist, ReflexDecision, ReflexInput } from "./types";
import { validateBatch } from "./validate";

export type { BriefContext };

export interface ReflexRequest { input: ReflexInput; finalists: Finalist[]; brief: BriefContext | null; guidance: string; signal?: AbortSignal }
export interface ReflexResponse {
  status: CallStatus;
  decisions: ReflexDecision[];
  dropped: string[];
  usage: LlmUsage | null;
  model: string;
  latencyMs: number;
  error: string | null;
  /**
   * HTTP attempts of this call that may have been billed beyond the usage reported: those that got no response (a
   * timeout, an abort, a dropped connection) and 200 answers whose body or stream broke before the message was read.
   * An attempt answered with an error status bills nothing. Undefined when unknown (the cost ledger then books the
   * call's whole worst case).
   */
  possiblyBilledAttempts?: number;
}
export interface ReflexJudge { readonly kind: "claude" | "fake"; readonly model: string; judge(req: ReflexRequest): Promise<ReflexResponse> }

export interface DeepRequest<T> {
  system: string;
  user: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  /** The SDK's per-attempt timeout: until the response starts streaming. */
  timeoutMs: number;
  schema: ZodType<T>;
  signal?: AbortSignal;
  /** The whole call is stopped after this long (ESCALATION.abortMs, REVIEW_CALL.abortMs); default deepAbortMs(timeoutMs). */
  abortMs?: number;
}
export interface DeepResponse<T> {
  status: CallStatus;
  parsed: T | null;
  /** Every attempt's tokens added up (a refused attempt and its fallback included). */
  usage: LlmUsage | null;
  /** The model that answered. */
  model: string;
  latencyMs: number;
  error: string | null;
  /** Each attempt with the model that ran it, when the response lists them (cost.ts responseCostUsd prices them one by one). */
  iterations?: UsageIteration[] | null;
  /** As ReflexResponse.possiblyBilledAttempts. */
  possiblyBilledAttempts?: number;
}
export interface DeepJudge {
  readonly model: string;
  structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>>;
  /** The API's token count of a user message sent alone (free; no model call); null when it cannot be had. */
  countTokens?(user: string): Promise<number | null>;
}

export interface ClaudeJudgeOptions { apiKey: string; model: string; fetch?: typeof fetch; now?: () => number }

/** Escalations and the review retry once, as the reflex does. */
export const DEEP_MAX_RETRIES = REVIEW_CALL.maxRetries;
/** A token count gets this long, with no retry; the review then sizes its prompt from the local estimate. */
export const COUNT_TOKENS_TIMEOUT_MS = 10_000;

/**
 * Counts the HTTP attempts a judge's client makes during one call, through the fetch the client is given. Calls on
 * one judge never overlap (the AgentDO runs one job at a time); if two ever do, neither can say what it sent.
 */
class AttemptMeter {
  private attempts = 0;
  private errorStatus = 0;
  private active = 0;
  private overlapped = false;

  constructor(private readonly base: typeof fetch | undefined) {}

  /** The client's fetch: every request it sends is one attempt; one answered with a status of 400 or more billed nothing. */
  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    this.attempts++;
    const res = await (this.base ? this.base(input, init) : globalThis.fetch(input, init));
    if (res.status >= 400) this.errorStatus++;
    return res;
  }) as typeof fetch;

  /** Starts one call; the function it returns ends it and gives the attempts that may have been billed beyond the usage read. */
  begin(): (messageRead: boolean) => number | undefined {
    if (this.active > 0) this.overlapped = true;
    else {
      this.attempts = 0;
      this.errorStatus = 0;
      this.overlapped = false;
    }
    this.active++;
    let ended = false;
    return (messageRead) => {
      if (!ended) {
        ended = true;
        this.active--;
      }
      return this.overlapped ? undefined : Math.max(0, this.attempts - this.errorStatus - (messageRead ? 1 : 0));
    };
  }
}

/** Default deadline of a deep call: every attempt's timeout and 10 s more (ESCALATION.abortMs follows the same rule). */
export function deepAbortMs(timeoutMs: number): number {
  return timeoutMs * (DEEP_MAX_RETRIES + 1) + 10_000;
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

type Block = { type: string; text?: unknown };
interface Answer {
  model: string;
  stopReason: string | null;
  refusalCategory: string | null;
  content: readonly Block[];
}

type UsageLike = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

function llmUsage(u: UsageLike | null | undefined): LlmUsage {
  return { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheCreationTokens: u?.cache_creation_input_tokens ?? 0 };
}

/** Each attempt of a call (usage.iterations) with the model that ran it; null when the response does not list them. */
function iterationsOf(list: readonly unknown[] | null | undefined, requested: string): UsageIteration[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((entry) => {
    const e = entry as UsageLike & { model?: unknown };
    return { model: typeof e.model === "string" && e.model ? e.model : requested, usage: llmUsage(e) };
  });
}

/** The tokens of all attempts, never fewer than the top-level usage reports. */
function totalUsage(top: LlmUsage, iterations: readonly UsageIteration[] | null): LlmUsage {
  if (!iterations) return top;
  const sum = (k: keyof LlmUsage) => iterations.reduce((s, it) => s + it.usage[k], 0);
  return {
    inputTokens: Math.max(top.inputTokens, sum("inputTokens")),
    outputTokens: Math.max(top.outputTokens, sum("outputTokens")),
    cacheReadTokens: Math.max(top.cacheReadTokens, sum("cacheReadTokens")),
    cacheCreationTokens: Math.max(top.cacheCreationTokens, sum("cacheCreationTokens")),
  };
}

function stopFailure(a: Answer): { status: CallStatus; error: string } | null {
  if (a.stopReason === "refusal") return { status: "REFUSED", error: `The model declined to answer${a.refusalCategory ? ` (${a.refusalCategory})` : ""}.` };
  if (a.stopReason === "max_tokens") return { status: "MAX_TOKENS", error: "The answer was cut off at the output limit." };
  return null;
}

/**
 * The texts an answer can be read from, in order: every text block joined (a refusal fallback part-way through an
 * answer leaves its JSON split across the fallback block), then the text after the last fallback block alone.
 */
export function answerTexts(content: readonly Block[]): string[] {
  const join = (blocks: readonly Block[]) =>
    blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  const texts = [join(content), last >= 0 ? join(content.slice(last + 1)) : ""];
  return [...new Set(texts.filter((t) => t.trim() !== ""))];
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The first text that parses as JSON and passes `check`; else the first problem met. */
function readAnswer<T>(content: readonly Block[], check: (raw: unknown) => Checked<T>): Checked<T> {
  const texts = answerTexts(content);
  if (texts.length === 0) return { ok: false, error: "The answer had no text." };
  let problem: string | null = null;
  for (const text of texts) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      problem ??= "The answer was not complete JSON.";
      continue;
    }
    const r = check(raw);
    if (r.ok) return r;
    problem ??= r.error;
  }
  return { ok: false, error: problem ?? "The answer could not be read." };
}

// ---------------------------------------------------------------------------
// Deadlines and failures
// ---------------------------------------------------------------------------

interface Deadline {
  signal: AbortSignal;
  /** True once this call's own deadline stopped it. */
  fired: () => boolean;
  clear: () => void;
}

/** An abort signal for one call: its own deadline, or the caller's signal, whichever comes first. */
function callDeadline(ms: number, outer: AbortSignal | undefined): Deadline {
  const ac = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ac.abort();
  }, ms);
  const relay = () => ac.abort();
  if (outer?.aborted) ac.abort();
  else outer?.addEventListener("abort", relay, { once: true });
  return {
    signal: ac.signal,
    fired: () => fired,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    },
  };
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** A thrown call as a status: an abort or a timeout is TIMEOUT, anything else ERROR; the text never holds the key or the prompt. */
function failure(err: unknown, d: Deadline, a: { abortMs: number; timeoutMs: number; maxRetries: number }): { status: CallStatus; error: string } {
  if (d.fired()) return { status: "TIMEOUT", error: `No answer within ${seconds(a.abortMs)}; the call was stopped.` };
  if (d.signal.aborted) return { status: "TIMEOUT", error: "The call was stopped by its caller." };
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { status: "TIMEOUT", error: `No response within the ${seconds(a.timeoutMs)} timeout${a.maxRetries > 0 ? `, retried ${a.maxRetries === 1 ? "once" : `${a.maxRetries} times`}` : ""}.` };
  }
  if (err instanceof Anthropic.APIUserAbortError) return { status: "TIMEOUT", error: "The call was stopped." };
  return { status: "ERROR", error: `The call failed (${plainError(err)}).` };
}

// ---------------------------------------------------------------------------
// The judges
// ---------------------------------------------------------------------------

/** The reflex model: one non-streamed structured call per bar, effort low, the system prompt cached for an hour. */
export class ClaudeReflexJudge implements ReflexJudge {
  readonly kind = "claude" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly now: () => number;
  private readonly meter: AttemptMeter;

  constructor(o: ClaudeJudgeOptions) {
    this.model = o.model;
    this.now = o.now ?? Date.now;
    this.meter = new AttemptMeter(o.fetch);
    this.client = new Anthropic({ apiKey: o.apiKey, timeout: REFLEX_CALL.timeoutMs, maxRetries: REFLEX_CALL.maxRetries, fetch: this.meter.fetch });
  }

  async judge(req: ReflexRequest): Promise<ReflexResponse> {
    // possiblyBilledAttempts 0: no request was sent.
    const none = { decisions: [] as ReflexDecision[], dropped: [] as string[], possiblyBilledAttempts: 0 };
    // Only finalists on an index with a snapshot are asked about, and only their answers count.
    let finalists: Finalist[];
    try {
      finalists = promptFinalists(req.input, req.finalists);
    } catch (err) {
      return { ...none, status: "ERROR", usage: null, model: this.model, latencyMs: 0, error: `The request could not be built (${plainError(err)}).` };
    }
    if (finalists.length === 0) return { ...none, status: "ERROR", usage: null, model: this.model, latencyMs: 0, error: "No finalist has a snapshot, so there was nothing to ask." };
    const started = this.now();
    const elapsed = () => Math.max(0, this.now() - started);
    const deadline = callDeadline(REFLEX_CALL.abortMs, req.signal);
    const end = this.meter.begin();
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: REFLEX_CALL.maxTokens,
          system: [{ type: "text", text: reflexSystem(req.guidance), cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ role: "user", content: reflexUser(req.input, finalists, req.brief) }],
          output_config: { format: REFLEX_OUTPUT_FORMAT, effort: REFLEX_CALL.effort },
        },
        { timeout: REFLEX_CALL.timeoutMs, maxRetries: REFLEX_CALL.maxRetries, signal: deadline.signal },
      );
    } catch (err) {
      const f = failure(err, deadline, { abortMs: REFLEX_CALL.abortMs, timeoutMs: REFLEX_CALL.timeoutMs, maxRetries: REFLEX_CALL.maxRetries });
      return { ...none, status: f.status, usage: null, model: this.model, latencyMs: elapsed(), error: f.error, possiblyBilledAttempts: end(false) };
    } finally {
      deadline.clear();
    }
    const billed = { possiblyBilledAttempts: end(true) };
    const latencyMs = elapsed();
    const usage = llmUsage(msg.usage);
    const answer: Answer = { model: msg.model || this.model, stopReason: msg.stop_reason ?? null, refusalCategory: msg.stop_details?.category ?? null, content: msg.content };
    const stop = stopFailure(answer);
    if (stop) return { ...none, ...billed, status: stop.status, usage, model: answer.model, latencyMs, error: stop.error };
    const read = readAnswer(answer.content, (raw) => {
      const v = validateBatch(raw, finalists);
      return v.ok ? { ok: true, value: v } : v;
    });
    if (!read.ok) return { ...none, ...billed, status: "PARSE_ERROR", usage, model: answer.model, latencyMs, error: read.error };
    return { status: "OK", decisions: read.value.decisions, dropped: read.value.dropped, usage, model: answer.model, latencyMs, error: null, ...billed };
  }
}

/**
 * The deep model: a streamed structured call (a long answer at high effort can take minutes), the system prompt
 * cached for an hour, with server-side refusal fallbacks for the models that take them.
 */
export class ClaudeDeepJudge implements DeepJudge {
  readonly model: string;
  private readonly client: Anthropic;
  /** Token counts go through their own client, so they are never counted as a call's attempts. */
  private readonly counter: Anthropic;
  private readonly now: () => number;
  private readonly meter: AttemptMeter;

  constructor(o: ClaudeJudgeOptions) {
    this.model = o.model;
    this.now = o.now ?? Date.now;
    this.meter = new AttemptMeter(o.fetch);
    this.client = new Anthropic({ apiKey: o.apiKey, maxRetries: DEEP_MAX_RETRIES, fetch: this.meter.fetch });
    this.counter = new Anthropic({ apiKey: o.apiKey, maxRetries: 0, timeout: COUNT_TOKENS_TIMEOUT_MS, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  /** The API's count of `user` sent alone to this model (POST /v1/messages/count_tokens: free); null on any failure. */
  async countTokens(user: string): Promise<number | null> {
    try {
      const r = await this.counter.messages.countTokens({ model: this.model, messages: [{ role: "user", content: user }] }, { timeout: COUNT_TOKENS_TIMEOUT_MS, maxRetries: 0 });
      return Number.isFinite(r.input_tokens) && r.input_tokens > 0 ? r.input_tokens : null;
    } catch {
      return null;
    }
  }

  async structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    const started = this.now();
    const elapsed = () => Math.max(0, this.now() - started);
    const fallbacks = FALLBACK_MODELS.has(this.model);
    const abortMs = req.abortMs ?? deepAbortMs(req.timeoutMs);
    const deadline = callDeadline(abortMs, req.signal);
    const end = this.meter.begin();
    let answer: Answer;
    let top: LlmUsage;
    let iterations: UsageIteration[] | null;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ role: "user", content: req.user }],
          output_config: { format: outputFormat(req.schema), effort: req.effort },
          betas: [...(fallbacks ? [FALLBACK_BETA] : []), STRUCTURED_OUTPUTS_BETA],
          ...(fallbacks ? { fallbacks: "default" as const } : {}),
        },
        { timeout: req.timeoutMs, maxRetries: DEEP_MAX_RETRIES, signal: deadline.signal },
      );
      let msg: BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        // A stream that failed after the whole message arrived (its stop reason is in) still holds the answer.
        const snap = stream.currentMessage;
        if (!snap || snap.stop_reason == null) throw err;
        msg = snap;
      }
      answer = { model: msg.model || this.model, stopReason: msg.stop_reason ?? null, refusalCategory: msg.stop_details?.category ?? null, content: msg.content };
      top = llmUsage(msg.usage);
      iterations = iterationsOf(msg.usage?.iterations, this.model);
    } catch (err) {
      const f = failure(err, deadline, { abortMs, timeoutMs: req.timeoutMs, maxRetries: DEEP_MAX_RETRIES });
      return { status: f.status, parsed: null, usage: null, model: this.model, latencyMs: elapsed(), error: f.error, iterations: null, possiblyBilledAttempts: end(false) };
    } finally {
      deadline.clear();
    }
    const base = { usage: totalUsage(top, iterations), model: answer.model, latencyMs: elapsed(), iterations, possiblyBilledAttempts: end(true) };
    const stop = stopFailure(answer);
    if (stop) return { ...base, status: stop.status, parsed: null, error: stop.error };
    const read = readAnswer<T>(answer.content, (raw) => {
      const r = req.schema.safeParse(raw);
      if (r.success) return { ok: true, value: r.data };
      const issue = r.error.issues[0];
      return { ok: false, error: `The answer did not match the expected structure${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}.` };
    });
    if (!read.ok) return { ...base, status: "PARSE_ERROR", parsed: null, error: read.error };
    return { ...base, status: "OK", parsed: read.value, error: null };
  }
}
