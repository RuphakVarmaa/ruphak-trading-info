import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "../../ports";
import { EventScoreBatchS } from "./schema";
import {
  WorkersAiError,
  WorkersAiLlmClient,
  answerOf,
  firstJson,
  isRequestProblem,
  jsonSchemaOf,
  stripReasoning,
  usageOf,
  workersAiRestRunner,
  type WorkersAiRun,
} from "./workersAiClient";

const Small = z.object({ direction: z.enum(["UP", "DOWN"]), score: z.number() });

function req(over: Partial<LlmRequest<z.infer<typeof Small>>> = {}): LlmRequest<z.infer<typeof Small>> {
  return { system: "rubric", user: "digest", model: "@cf/zai-org/glm-5.3", effort: "low", maxTokens: 2000, schema: Small, ...over };
}

const chat = (content: string, usage = { prompt_tokens: 100, completion_tokens: 40 }) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage });

/** Fake runner: replies in order; an Error reply is thrown. Records every input. */
function fake(replies: unknown[]) {
  const inputs: Record<string, unknown>[] = [];
  const run: WorkersAiRun = async (_model, input) => {
    inputs.push(input);
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, inputs };
}

describe("Workers AI response helpers", () => {
  it("reads OpenAI-style choices and Workers AI response shapes", () => {
    expect(answerOf(chat('{"a":1}'))).toBe('{"a":1}');
    expect(answerOf({ response: { a: 1 } })).toEqual({ a: 1 });
    expect(answerOf({ response: "text" })).toBe("text");
    expect(answerOf({ choices: [{ message: { content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] } }] })).toBe("xy");
    expect(answerOf({})).toBeNull();
  });

  it("strips reasoning and finds the first JSON value", () => {
    expect(stripReasoning("<think>hmm {not json}</think>  {\"a\":1}")).toBe('{"a":1}');
    expect(stripReasoning("answer <think>unfinished")).toBe("answer");
    expect(firstJson('Sure! ```json\n{"a": {"b": "}"}}\n``` done')).toEqual({ a: { b: "}" } });
    expect(firstJson("<think>{bad}</think> prefix {\"ok\": true} trailing")).toEqual({ ok: true });
    expect(firstJson("no json at all")).toBeUndefined();
  });

  it("maps usage, including cached prompt tokens", () => {
    expect(usageOf({ usage: { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 800 } } })).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    });
    expect(usageOf({})).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it("classifies request problems separately from outages", () => {
    expect(isRequestProblem(new WorkersAiError("Workers AI HTTP 400: response_format not supported", 400))).toBe(true);
    expect(isRequestProblem(new Error("AiError: 5006: Error: input: unrecognized key json_schema"))).toBe(true);
    expect(isRequestProblem(new WorkersAiError("Workers AI HTTP 503: overloaded", 503))).toBe(false);
    expect(isRequestProblem(new WorkersAiError("Workers AI HTTP 429: rate limited", 429))).toBe(false);
    expect(isRequestProblem(new Error("Timed out after 60000 ms"))).toBe(false);
  });

  it("produces a strict-friendly JSON Schema for the event score batch", () => {
    const s = jsonSchemaOf(EventScoreBatchS);
    expect(s.$schema).toBeUndefined();
    const item = (s.properties as { scores: { items: Record<string, unknown> } }).scores.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toContain("cluster_id");
    expect(JSON.stringify(s)).toContain('"enum":["NONE","INDIRECT","DIRECT"]');
  });
});

describe("WorkersAiLlmClient", () => {
  it("returns a validated answer and sends GLM parameters", async () => {
    const { run, inputs } = fake([chat('<think>reasoning</think>{"direction":"UP","score":0.4}')]);
    const client = new WorkersAiLlmClient({ run });
    const res = await client.structured(req({ effort: "medium" }));
    expect(res.parsed).toEqual({ direction: "UP", score: 0.4 });
    expect(res.usage.inputTokens).toBe(100);
    expect(res.stopReason).toBe("stop");
    const sent = inputs[0];
    expect(sent.reasoning_effort).toBe("high");
    expect(sent.max_completion_tokens).toBe(2000);
    expect(sent.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "structured_output", strict: true } });
    expect((sent.messages as { role: string; content: string }[])[0].content).toContain('"direction"');
  });

  it("falls back across structured-output modes when the request is refused, and remembers the mode", async () => {
    const refused = new WorkersAiError("Workers AI HTTP 400: response_format.json_schema: invalid", 400);
    const { run, inputs } = fake([refused, refused, chat('{"direction":"DOWN","score":-0.2}'), chat('{"direction":"UP","score":0.1}')]);
    const client = new WorkersAiLlmClient({ run, log: () => {} });
    expect((await client.structured(req())).parsed).toEqual({ direction: "DOWN", score: -0.2 });
    expect(client.currentMode).toBe("prompt");
    expect(inputs[2].response_format).toBeUndefined();
    await client.structured(req());
    expect(inputs).toHaveLength(4);
    expect(inputs[3].response_format).toBeUndefined();
  });

  it("does not switch modes on outages", async () => {
    const { run } = fake([new WorkersAiError("Workers AI HTTP 503: busy", 503)]);
    const client = new WorkersAiLlmClient({ run });
    await expect(client.structured(req())).rejects.toThrow(/503/);
    expect(client.currentMode).toBe("openai");
  });

  it("asks once for a correction, then gives up with parsed null", async () => {
    const fixed = fake([chat('{"direction":"SIDEWAYS","score":1}'), chat('{"direction":"UP","score":1}')]);
    const c1 = new WorkersAiLlmClient({ run: fixed.run, log: () => {} });
    const ok = await c1.structured(req());
    expect(ok.parsed).toEqual({ direction: "UP", score: 1 });
    expect(ok.usage.inputTokens).toBe(200);
    const retryMessages = fixed.inputs[1].messages as { role: string; content: string }[];
    expect(retryMessages.at(-1)?.content).toMatch(/did not match the schema/);
    expect(retryMessages.at(-2)?.role).toBe("assistant");

    const bad = fake([chat("I cannot answer in JSON.")]);
    const c2 = new WorkersAiLlmClient({ run: bad.run, log: () => {} });
    const res = await c2.structured(req());
    expect(res.parsed).toBeNull();
    expect(res.stopReason).toBe("invalid_output");
  });

  it("moves to the next mode after repeated invalid answers", async () => {
    const { run } = fake([chat("nope")]);
    const client = new WorkersAiLlmClient({ run, maxBadAnswersPerMode: 2, log: () => {} });
    await client.structured(req());
    expect(client.currentMode).toBe("openai");
    await client.structured(req());
    expect(client.currentMode).toBe("workers");
  });

  it("accepts an already-parsed object in the response field", async () => {
    const { run } = fake([{ response: { direction: "UP", score: 0.3 }, usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
    const res = await new WorkersAiLlmClient({ run }).structured(req());
    expect(res.parsed).toEqual({ direction: "UP", score: 0.3 });
  });
});

describe("workersAiRestRunner", () => {
  it("posts to the account's AI endpoint and unwraps the envelope", async () => {
    let seen: { url: string; auth: string | null; body: unknown } | null = null;
    const run = workersAiRestRunner({
      accountId: "acc123",
      apiToken: "tok",
      fetchImpl: async (input, init) => {
        seen = { url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ success: true, result: chat("{}"), errors: [] }));
      },
    });
    const out = await run("@cf/zai-org/glm-5.3", { messages: [] });
    expect(seen!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/zai-org/glm-5.3");
    expect(seen!.auth).toBe("Bearer tok");
    expect(answerOf(out)).toBe("{}");
  });

  it("raises a WorkersAiError with the status and message", async () => {
    const run = workersAiRestRunner({
      accountId: "a",
      apiToken: "t",
      fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 5006, message: "response_format: unsupported" }] }), { status: 400 }),
    });
    const err = (await run("m", {}).catch((e: unknown) => e)) as WorkersAiError;
    expect(err).toBeInstanceOf(WorkersAiError);
    expect(err.status).toBe(400);
    expect(isRequestProblem(err)).toBe(true);
  });
});
