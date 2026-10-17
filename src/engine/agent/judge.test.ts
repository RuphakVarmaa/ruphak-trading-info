import { describe, expect, it, vi } from "vitest";
import { FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA } from "../advisor/advise";
import { istAt } from "../clock";
import { AGENT_DEFAULTS } from "./config";
import { ESCALATION, REFLEX_CALL } from "./constants";
import { priceFor } from "./cost";
import { ClaudeDeepJudge, ClaudeReflexJudge, answerTexts, deepAbortMs, type DeepRequest } from "./judge";
import { BUILTIN_GUIDANCE, ESCALATION_SYSTEM, reflexSystem, reflexUser } from "./prompt";
import { EscalationSchema, type EscalationOut } from "./schema";
import type { Finalist, IndexSnapshot, ReflexDecision, ReflexInput } from "./types";

// Model ids come from the config defaults and the price table only.
const REFLEX = AGENT_DEFAULTS.reflexModel;
const DEEP = AGENT_DEFAULTS.escalationModel;
const FALLBACK = (priceFor(DEEP).fallbackModels ?? [])[0];
const KEY = "sk-ant-test-not-a-key";

const T = istAt("2026-10-19", "10:35");
const snapshot: IndexSnapshot = {
  c: 25012, r5: 12, r15: -8, r60: 31, ro: 45, vw: -18, vz: 0.9,
  orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
  rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
  o: { k: 25000, cm: 112.5, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
  bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
};
const input = (snapshots: ReflexInput["snapshots"] = { NIFTY: snapshot, SENSEX: { ...snapshot, c: 82010 } }): ReflexInput => ({
  barCloseMs: T, date: "2026-10-19", builtMs: T + 40_000, snapshots, tokensEst: {}, closes: {}, problems: [],
});
const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({
  id: `gen:${index}`, kind: "GENERIC", index, label: index, side: null, contract: null, entryHigh: null,
  condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
});
const finalists = [generic("NIFTY"), generic("SENSEX")];
const d = (p: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.84, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "r5 +12 bps, above VWAP.", ...p,
});
const batchJson = (decisions: ReflexDecision[]) => JSON.stringify({ decisions });

type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string; signature: string } | { type: "fallback"; from: { model: string }; to: { model: string }; trigger: { category: null } };
interface Seen { url: string; headers: Headers; body: Record<string, unknown>; signal: AbortSignal | null }

/** A fetch that records each request and answers with the next responder (the last one repeats). */
function fakeFetch(responders: ((req: Seen) => Response | Promise<Response>)[]) {
  const requests: Seen[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const req: Seen = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal ?? null };
    requests.push(req);
    return responders[Math.min(requests.length - 1, responders.length - 1)](req);
  });
  return { fetch, requests };
}

const usage = { input_tokens: 3_100, output_tokens: 640, cache_read_input_tokens: 1_500, cache_creation_input_tokens: 0 };

/** A non-streamed Messages API response. */
function message(content: Block[], stop = "end_turn", u: Record<string, unknown> = usage, extra: Record<string, unknown> = {}) {
  return () =>
    new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: REFLEX, content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: u, ...extra }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
}

const httpError = (status: number) => () =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 529 ? "overloaded_error" : "invalid_request_error", message: `status ${status}` } }), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });

/** A fetch that never answers until its request is aborted. */
const hang = (req: Seen) =>
  new Promise<Response>((_, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (req.signal?.aborted) fail();
    else req.signal?.addEventListener("abort", fail);
  });

/** A clock that returns these instants in turn. */
const clock = (...ts: number[]) => () => ts.shift() ?? 99_999;

const reflexJudge = (fetch: typeof globalThis.fetch, now = clock(1_000, 3_500)) => new ClaudeReflexJudge({ apiKey: KEY, model: REFLEX, fetch, now });
const ask = (j: ClaudeReflexJudge, p: Partial<Parameters<ClaudeReflexJudge["judge"]>[0]> = {}) => j.judge({ input: input(), finalists, brief: null, guidance: BUILTIN_GUIDANCE, ...p });

describe("the reflex call", () => {
  it("sends one structured request: effort low, 4,096 tokens, the cached system prompt, and nothing the model rejects", async () => {
    const { fetch, requests } = fakeFetch([message([{ type: "text", text: batchJson([d(), d({ finalistId: "gen:SENSEX", direction: "NEUTRAL", directionConfidence: 0.5, setupQuality: 0 })]) }])]);
    const r = await ask(reflexJudge(fetch), { brief: { headline: "Wait.", factors: [] } });
    expect(r.status).toBe("OK");
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.url).toMatch(/\/v1\/messages$/);
    expect(req.body.model).toBe(REFLEX);
    expect(req.body.max_tokens).toBe(4096);
    expect(req.body.max_tokens).toBe(REFLEX_CALL.maxTokens);
    expect(req.body.system).toEqual([{ type: "text", text: reflexSystem(BUILTIN_GUIDANCE), cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(req.body.messages).toEqual([{ role: "user", content: reflexUser(input(), finalists, { headline: "Wait.", factors: [] }) }]);
    const oc = req.body.output_config as { effort: string; format: { type: string; schema: { properties: { decisions: { items: { properties: Record<string, { enum?: unknown[] }> } } } } } };
    expect(oc.effort).toBe("low");
    expect(oc.format.type).toBe("json_schema");
    expect(oc.format.schema.properties.decisions.items.properties.regime.enum).toEqual(["TRENDING", "MEAN_REVERTING", "HIGH_VOL", "CRISIS"]);
    for (const key of ["temperature", "top_p", "top_k", "fallbacks", "thinking", "betas", "stream", "tools", "tool_choice"]) expect(req.body).not.toHaveProperty(key);
    // No assistant prefill: the only message is the user's.
    expect((req.body.messages as { role: string }[]).at(-1)?.role).toBe("user");
    expect(req.headers.get("anthropic-beta")).toBeNull();
    expect(req.headers.get("x-stainless-timeout")).toBe(String(REFLEX_CALL.timeoutMs / 1000));
    expect(req.headers.get("x-api-key")).toBe(KEY);
  });

  it("returns the validated decisions, the usage, the answering model and the latency", async () => {
    const { fetch } = fakeFetch([message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: batchJson([d(), d({ finalistId: "gen:BANKNIFTY" })]) }])]);
    const r = await ask(reflexJudge(fetch));
    expect(r).toEqual({
      status: "OK",
      decisions: [d()],
      dropped: ["gen:BANKNIFTY: not a finalist"],
      usage: { inputTokens: 3_100, outputTokens: 640, cacheReadTokens: 1_500, cacheCreationTokens: 0 },
      model: REFLEX,
      latencyMs: 2_500,
      error: null,
      possiblyBilledAttempts: 0,
    });
  });

  it("asks only about finalists on an index with a snapshot, and drops an answer about any other", async () => {
    const { fetch, requests } = fakeFetch([message([{ type: "text", text: batchJson([d(), d({ finalistId: "gen:SENSEX" })]) }])]);
    const r = await ask(reflexJudge(fetch), { input: input({ NIFTY: snapshot }) });
    expect((JSON.parse((requests[0].body.messages as { content: string }[])[0].content) as { finalists: { id: string }[] }).finalists.map((f) => f.id)).toEqual(["gen:NIFTY"]);
    expect(r.decisions).toEqual([d()]);
    expect(r.dropped).toEqual(["gen:SENSEX: not a finalist"]);
  });

  it("makes no call when no finalist has a snapshot, and never throws on a malformed request", async () => {
    const { fetch } = fakeFetch([message([])]);
    const r = await ask(reflexJudge(fetch), { input: input({}) });
    expect(fetch).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "ERROR", usage: null, decisions: [], latencyMs: 0 });
    const broken = await ask(reflexJudge(fetch), { input: {} as ReflexInput });
    expect(broken).toMatchObject({ status: "ERROR", usage: null });
    expect(broken.error).toMatch(/^The request could not be built/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a refusal as REFUSED, with what it cost", async () => {
    const { fetch } = fakeFetch([message([], "refusal", usage, { stop_details: { type: "refusal", category: "cyber", explanation: null } })]);
    const r = await ask(reflexJudge(fetch));
    expect(r).toMatchObject({ status: "REFUSED", decisions: [], usage: { inputTokens: 3_100, outputTokens: 640 }, error: "The model declined to answer (cyber)." });
  });

  it("reports an answer cut off mid-JSON as MAX_TOKENS, with its usage", async () => {
    const cut = batchJson([d(), d({ finalistId: "gen:SENSEX" })]).slice(0, 90);
    const { fetch } = fakeFetch([message([{ type: "text", text: cut }], "max_tokens", { ...usage, output_tokens: 4_096 })]);
    const r = await ask(reflexJudge(fetch));
    expect(r).toMatchObject({ status: "MAX_TOKENS", decisions: [], usage: { inputTokens: 3_100, outputTokens: 4_096 }, error: "The answer was cut off at the output limit." });
  });

  it("reports malformed JSON, a schema mismatch or no usable decision as PARSE_ERROR, with usage", async () => {
    for (const text of ["{not json", JSON.stringify({ decisions: [{ ...d(), setupQuality: 4 }] }), batchJson([d({ finalistId: "x" }), d({ directionConfidence: 7 })]), ""]) {
      const { fetch } = fakeFetch([message(text ? [{ type: "text", text }] : [])]);
      const r = await ask(reflexJudge(fetch));
      expect(r.status).toBe("PARSE_ERROR");
      expect(r.usage).toEqual({ inputTokens: 3_100, outputTokens: 640, cacheReadTokens: 1_500, cacheCreationTokens: 0 });
      expect(r.decisions).toEqual([]);
      expect(r.error).toBeTruthy();
    }
  });

  it("reads a decision batch split across text blocks", async () => {
    const json = batchJson([d()]);
    const { fetch } = fakeFetch([message([{ type: "text", text: json.slice(0, 40) }, { type: "text", text: json.slice(40) }])]);
    expect((await ask(reflexJudge(fetch))).decisions).toEqual([d()]);
  });

  it("is TIMEOUT when the caller's deadline aborts it, before or during the request", async () => {
    const before = fakeFetch([message([])]);
    const ac = new AbortController();
    ac.abort();
    const r1 = await ask(reflexJudge(before.fetch), { signal: ac.signal });
    expect(r1).toMatchObject({ status: "TIMEOUT", usage: null, decisions: [] });
    expect(before.fetch).not.toHaveBeenCalled();

    const during = fakeFetch([hang]);
    const ac2 = new AbortController();
    const pending = ask(reflexJudge(during.fetch), { signal: ac2.signal });
    await vi.waitFor(() => expect(during.fetch).toHaveBeenCalled());
    ac2.abort();
    const r2 = await pending;
    expect(r2).toMatchObject({ status: "TIMEOUT", usage: null, error: "The call was stopped by its caller." });
  });

  it("retries an overloaded API once, then reports ERROR without the key", async () => {
    const recovered = fakeFetch([httpError(529), message([{ type: "text", text: batchJson([d()]) }])]);
    expect((await ask(reflexJudge(recovered.fetch))).status).toBe("OK");
    expect(recovered.fetch).toHaveBeenCalledTimes(2);

    const down = fakeFetch([httpError(529)]);
    const r = await ask(reflexJudge(down.fetch));
    expect(down.fetch).toHaveBeenCalledTimes(REFLEX_CALL.maxRetries + 1);
    expect(r).toMatchObject({ status: "ERROR", usage: null, decisions: [] });
    expect(r.error).toMatch(/HTTP 529/);
    expect(r.error).not.toContain(KEY);

    const bad = fakeFetch([httpError(400)]);
    expect(await ask(reflexJudge(bad.fetch))).toMatchObject({ status: "ERROR" });
    expect(bad.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The deep model: streamed, over server-sent events.
// ---------------------------------------------------------------------------

const answer: EscalationOut = { decision: d({ directionConfidence: 0.7, reason: "Flow and trend agree." }), reason: "Calls are being covered; a close below VWAP would change my mind." };
const deepUsage = { input_tokens: 4_500, output_tokens: 3_000, cache_read_input_tokens: 1_500, cache_creation_input_tokens: 0 };

function sse(blocks: Block[], stop: string, o: { model?: string; usage?: Record<string, unknown>; iterations?: Record<string, unknown>[]; stopDetails?: Record<string, unknown> } = {}) {
  const u = o.usage ?? deepUsage;
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: o.model ?? DEEP, content: [], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 37) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 37) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: b });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, stop_details: o.stopDetails ?? null }, usage: { output_tokens: u.output_tokens, ...(o.iterations ? { iterations: o.iterations } : {}) } });
  events.push({ type: "message_stop" });
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}

const deepJudge = (fetch: typeof globalThis.fetch, model = DEEP, now = clock(10_000, 52_000)) => new ClaudeDeepJudge({ apiKey: KEY, model, fetch, now });
const deepReq = (p: Partial<DeepRequest<EscalationOut>> = {}): DeepRequest<EscalationOut> => ({
  system: ESCALATION_SYSTEM, user: "Trigger: LOW_CONFIDENCE.", effort: "medium", maxTokens: ESCALATION.maxTokens, timeoutMs: ESCALATION.timeoutMs, schema: EscalationSchema, ...p,
});

describe("the deep call", () => {
  it("streams with effort, refusal fallbacks and the betas as headers, the cached system prompt, and no thinking or sampling settings", async () => {
    const { fetch, requests } = fakeFetch([sse([{ type: "text", text: JSON.stringify(answer) }], "end_turn")]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(r).toMatchObject({ status: "OK", parsed: answer, model: DEEP, latencyMs: 42_000, error: null });
    expect(r.usage).toEqual({ inputTokens: 4_500, outputTokens: 3_000, cacheReadTokens: 1_500, cacheCreationTokens: 0 });
    const req = requests[0];
    expect(req.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(req.body).toMatchObject({ stream: true, model: DEEP, max_tokens: ESCALATION.maxTokens, fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema" } } });
    expect(req.body.system).toEqual([{ type: "text", text: ESCALATION_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(req.body.messages).toEqual([{ role: "user", content: "Trigger: LOW_CONFIDENCE." }]);
    for (const key of ["thinking", "temperature", "top_p", "top_k", "betas"]) expect(req.body).not.toHaveProperty(key);
    expect(req.headers.get("anthropic-beta")?.split(",")).toEqual([FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA]);
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const regime = (req.body.output_config as { format: { schema: { properties: { decision: { properties: { regime: { enum: string[] } } } } } } }).format.schema.properties.decision.properties.regime;
    expect(regime.enum).toContain("CRISIS");
  });

  it("sends no fallbacks for a model outside the Advisor's fallback set", async () => {
    const { fetch, requests } = fakeFetch([sse([{ type: "text", text: JSON.stringify(answer) }], "end_turn", { model: REFLEX })]);
    expect((await deepJudge(fetch, REFLEX).structured(deepReq())).status).toBe("OK");
    expect(requests[0].body).not.toHaveProperty("fallbacks");
    expect(requests[0].headers.get("anthropic-beta")).toBe(STRUCTURED_OUTPUTS_BETA);
  });

  it("joins the text either side of a mid-stream refusal fallback, reports the serving model and every attempt", async () => {
    const json = JSON.stringify(answer);
    const iterations = [
      { type: "message", model: DEEP, input_tokens: 4_500, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_500 },
      { type: "fallback_message", model: FALLBACK, input_tokens: 4_600, output_tokens: 2_600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ];
    const { fetch } = fakeFetch([
      sse(
        [
          { type: "text", text: json.slice(0, 70) },
          { type: "fallback", from: { model: DEEP }, to: { model: FALLBACK }, trigger: { category: null } },
          { type: "text", text: json.slice(70) },
        ],
        "end_turn",
        { usage: { input_tokens: 4_600, output_tokens: 2_600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, iterations },
      ),
    ]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(r).toMatchObject({ status: "OK", parsed: answer, model: FALLBACK });
    expect(r.iterations).toEqual([
      { model: DEEP, usage: { inputTokens: 4_500, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 1_500 } },
      { model: FALLBACK, usage: { inputTokens: 4_600, outputTokens: 2_600, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    ]);
    // The usage adds up both attempts.
    expect(r.usage).toEqual({ inputTokens: 9_100, outputTokens: 3_000, cacheReadTokens: 0, cacheCreationTokens: 1_500 });
  });

  it("reads the answer after the last fallback block when the fallback started over", async () => {
    const { fetch } = fakeFetch([
      sse([{ type: "text", text: '{"decision": {"finalistId": "gen:NIF' }, { type: "fallback", from: { model: DEEP }, to: { model: FALLBACK }, trigger: { category: null } }, { type: "text", text: JSON.stringify(answer) }], "end_turn"),
    ]);
    expect(await deepJudge(fetch).structured(deepReq())).toMatchObject({ status: "OK", parsed: answer, model: FALLBACK });
  });

  it("reports a refusal of the whole chain as REFUSED, with usage", async () => {
    const { fetch } = fakeFetch([sse([], "refusal", { stopDetails: { type: "refusal", category: "bio", explanation: null } })]);
    expect(await deepJudge(fetch).structured(deepReq())).toMatchObject({ status: "REFUSED", parsed: null, usage: { inputTokens: 4_500 }, error: "The model declined to answer (bio)." });
  });

  it("reports truncated JSON at max_tokens as MAX_TOKENS, with usage", async () => {
    const { fetch } = fakeFetch([sse([{ type: "text", text: JSON.stringify(answer).slice(0, 60) }], "max_tokens")]);
    expect(await deepJudge(fetch).structured(deepReq())).toMatchObject({ status: "MAX_TOKENS", parsed: null, usage: { inputTokens: 4_500, outputTokens: 3_000 } });
  });

  it("reports an answer that does not match the schema as PARSE_ERROR, with usage", async () => {
    const { fetch } = fakeFetch([sse([{ type: "text", text: JSON.stringify({ decision: { ...answer.decision, regime: "BULL" }, reason: "x" }) }], "end_turn")]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(r).toMatchObject({ status: "PARSE_ERROR", parsed: null, usage: { inputTokens: 4_500 } });
    expect(r.error).toMatch(/did not match the expected structure \(decision\.regime/);
  });

  it("is TIMEOUT when its own deadline or the caller stops it", async () => {
    const own = fakeFetch([hang]);
    const r = await deepJudge(own.fetch).structured(deepReq({ abortMs: 30 }));
    expect(r).toMatchObject({ status: "TIMEOUT", parsed: null, usage: null, iterations: null });
    expect(r.error).toMatch(/^No answer within/);

    const ac = new AbortController();
    ac.abort();
    const caller = fakeFetch([hang]);
    expect(await deepJudge(caller.fetch).structured(deepReq({ signal: ac.signal }))).toMatchObject({ status: "TIMEOUT", usage: null });
    expect(caller.fetch).not.toHaveBeenCalled();
  });

  it("reports an API error as ERROR in plain words", async () => {
    const { fetch } = fakeFetch([httpError(400)]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(r).toMatchObject({ status: "ERROR", parsed: null, usage: null, model: DEEP });
    expect(r.error).toMatch(/^The call failed \(HTTP 400/);
  });

  it("stops a call by default at every attempt's timeout plus 10 s (the escalation's own deadline)", () => {
    expect(deepAbortMs(ESCALATION.timeoutMs)).toBe(ESCALATION.abortMs);
  });
});

// ---------------------------------------------------------------------------
// Attempts that may have been billed (M2, M3): the real SDK over a fake fetch.
// ---------------------------------------------------------------------------

/** A 200 event stream that breaks (a reset connection) after its first events, before message_stop. */
const cutStream = () => () => {
  const first = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: DEEP, content: [], stop_reason: null, stop_sequence: null, usage: { ...deepUsage, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"decision": {"fina' } },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(new TextEncoder().encode(first));
      } else c.error(new TypeError("terminated: the connection was reset"));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
};

/** A dropped connection: the request went out and no response came back. */
const dropped = () => {
  throw new TypeError("fetch failed");
};

describe("attempts that may have been billed (M2, M3)", () => {
  it("counts nothing for attempts answered with an error status: 529 then 529", async () => {
    const { fetch } = fakeFetch([httpError(529)]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "ERROR", usage: null, possiblyBilledAttempts: 0 });
    const reflex = fakeFetch([httpError(529)]);
    expect(await ask(reflexJudge(reflex.fetch))).toMatchObject({ status: "ERROR", usage: null, possiblyBilledAttempts: 0 });
  });

  it("counts every attempt that timed out: timeout then timeout is 2", async () => {
    const { fetch } = fakeFetch([hang]);
    const r = await deepJudge(fetch).structured(deepReq({ timeoutMs: 40 }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "TIMEOUT", usage: null, possiblyBilledAttempts: 2 });
  });

  it("counts the timed-out attempt beside the usage of the one that answered: timeout then 200 is 1", async () => {
    const { fetch } = fakeFetch([hang, sse([{ type: "text", text: JSON.stringify(answer) }], "end_turn")]);
    const r = await deepJudge(fetch).structured(deepReq({ timeoutMs: 40 }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "OK", parsed: answer, usage: { inputTokens: 4_500, outputTokens: 3_000 }, possiblyBilledAttempts: 1 });
    // The reflex: a dropped connection, retried, then an answer.
    const reflex = fakeFetch([dropped, message([{ type: "text", text: batchJson([d()]) }])]);
    const rr = await ask(reflexJudge(reflex.fetch));
    expect(reflex.fetch).toHaveBeenCalledTimes(2);
    expect(rr).toMatchObject({ status: "OK", usage: { inputTokens: 3_100 }, possiblyBilledAttempts: 1 });
  });

  it("counts a 200 stream cut before message_stop as 1", async () => {
    const { fetch } = fakeFetch([cutStream()]);
    const r = await deepJudge(fetch).structured(deepReq());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "ERROR", usage: null, possiblyBilledAttempts: 1 });
  });

  it("counts an attempt the caller aborted mid-request, and none for a request never sent", async () => {
    const during = fakeFetch([hang]);
    const ac = new AbortController();
    const pending = ask(reflexJudge(during.fetch), { signal: ac.signal });
    await vi.waitFor(() => expect(during.fetch).toHaveBeenCalled());
    ac.abort();
    expect(await pending).toMatchObject({ status: "TIMEOUT", possiblyBilledAttempts: 1 });
    const before = new AbortController();
    before.abort();
    const never = fakeFetch([hang]);
    expect(await ask(reflexJudge(never.fetch), { signal: before.signal })).toMatchObject({ status: "TIMEOUT", possiblyBilledAttempts: 0 });
    expect(await ask(reflexJudge(never.fetch), { input: input({}) })).toMatchObject({ status: "ERROR", possiblyBilledAttempts: 0 });
  });

  it("cannot say when two calls on one judge overlap", async () => {
    const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(message([{ type: "text", text: batchJson([d()]) }])()), 20));
    const { fetch } = fakeFetch([slow]);
    const j = new ClaudeReflexJudge({ apiKey: KEY, model: REFLEX, fetch });
    const [a, b] = await Promise.all([ask(j), ask(j)]);
    expect(a.status).toBe("OK");
    expect(a.possiblyBilledAttempts).toBeUndefined();
    expect(b.possiblyBilledAttempts).toBeUndefined();
    // The next call on its own counts again.
    expect((await ask(j)).possiblyBilledAttempts).toBe(0);
  });
});

describe("countTokens (M1)", () => {
  const counted = (n: number) => () => new Response(JSON.stringify({ input_tokens: n }), { status: 200, headers: { "content-type": "application/json" } });

  it("asks the API to count the user message alone, and never counts it as an attempt of a call", async () => {
    const { fetch, requests } = fakeFetch([counted(21_345), sse([{ type: "text", text: JSON.stringify(answer) }], "end_turn")]);
    const j = deepJudge(fetch);
    expect(await j.countTokens("the review's user message")).toBe(21_345);
    expect(requests[0].url).toMatch(/\/v1\/messages\/count_tokens/);
    expect(requests[0].body).toEqual({ model: DEEP, messages: [{ role: "user", content: "the review's user message" }] });
    expect(requests[0].headers.get("x-api-key")).toBe(KEY);
    expect(await j.structured(deepReq())).toMatchObject({ status: "OK", possiblyBilledAttempts: 0 });
  });

  it("is null on any failure, with no retry", async () => {
    const down = fakeFetch([httpError(529)]);
    expect(await deepJudge(down.fetch).countTokens("x")).toBeNull();
    expect(down.fetch).toHaveBeenCalledTimes(1);
    expect(await deepJudge(fakeFetch([dropped]).fetch).countTokens("x")).toBeNull();
    expect(await deepJudge(fakeFetch([counted(0)]).fetch).countTokens("x")).toBeNull();
  });
});

describe("answerTexts", () => {
  it("joins every text block first, then offers the text after the last fallback", () => {
    const fb = { type: "fallback" };
    expect(answerTexts([{ type: "text", text: "{\"a\"" }, fb, { type: "text", text: ":1}" }])).toEqual(['{"a":1}', ":1}"]);
    expect(answerTexts([{ type: "thinking" }, { type: "text", text: "{}" }])).toEqual(["{}"]);
    expect(answerTexts([{ type: "text", text: "  " }])).toEqual([]);
    expect(answerTexts([])).toEqual([]);
  });
});
