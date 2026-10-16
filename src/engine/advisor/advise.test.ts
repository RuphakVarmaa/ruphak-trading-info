import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ADVICE_SYSTEM, ADVICE_TIMEOUT_MS, AdviceSchema, FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA, adviceFromText, adviceUserMessage, runAdvice, type AdviceOut } from "./advise";
import type { ResearchResult } from "./research";
import { ZERO_USAGE } from "./types";

const SAMPLE_ADVICE: AdviceOut = {
  headline: "No clear edge today: wait.",
  today: { action: "WAIT", summary: "Premiums are fair and the trend is flat. The project's research found no proven edge for buying options.", candidateId: null },
  outlook: [{ index: "NIFTY", horizon: "WEEK", lean: "SIDEWAYS", confidence: "LOW", rangeLow: 22800, rangeHigh: 23400, why: ["The straddle implies ±1.3%."] }],
  factors: [{ key: "FII_DII", label: "Funds", reading: "NO_DATA", detail: "No data.", source: "web research" }],
  ideas: [],
  zeroHero: { applicable: false, summary: "No expiry today." },
  premium: { verdict: "NORMAL", detail: "ATM IV 13% vs VIX 12.5." },
  alsoKnow: ["India VIX is the market's expected 30-day volatility of NIFTY."],
  avoid: ["Do not buy in the first 15 minutes."],
  sources: [],
};

const research: ResearchResult = { ok: true, notes: "GLOBAL_CUES: S&P 500 +0.4%", sources: [{ title: "Reuters", url: "https://www.reuters.com/x" }], usage: ZERO_USAGE, error: null, stopReason: "end_turn" };

/** A fake client whose stream() resolves to `resp` (the shape the pipeline test fakes use too). */
function fakeClient(resp: Record<string, unknown>) {
  type Stream = { finalMessage: () => Promise<Record<string, unknown>>; currentMessage: undefined };
  const stream = vi.fn<(body: Record<string, unknown>, opts?: Record<string, unknown>) => Stream>(() => ({ finalMessage: async () => resp, currentMessage: undefined }));
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream };
}

// ---------------------------------------------------------------------------
// The real SDK over a fake fetch: server-sent events, no network.
// ---------------------------------------------------------------------------

type Block = { type: "text"; text: string } | { type: "fallback"; from: { model: string }; to: { model: string }; trigger: { category: null } };

function sseEvents(blocks: Block[], stop: string, usage = { input_tokens: 30_000, output_tokens: 6_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 }) {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      // Split the text across deltas, as a real stream does.
      for (let i = 0; i < b.text.length; i += 37) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 37) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: b });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function sseClient(blocks: Block[], stop = "end_turn") {
  const requests: { url: string; headers: Headers; body: Record<string, unknown>; signal: AbortSignal | null }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal ?? null });
    return new Response(sseEvents(blocks, stop), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  });
  const client = new Anthropic({ apiKey: "sk-ant-test-not-a-key", fetch, maxRetries: 0 });
  return { client, requests, fetch };
}

describe("the advice call", () => {
  it("streams from Opus 5.5 at effort high for structured output, with refusal fallbacks, the betas and the abort signal", async () => {
    const { client, stream } = fakeClient({ model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: SAMPLE_ADVICE, usage: { input_tokens: 30_000, output_tokens: 6_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, server_tool_use: null } });
    const signal = new AbortController().signal;
    const r = await runAdvice(client, { model: "claude-opus-5-5", contextJson: '{"candidates":[]}', research, signal });
    const [body, opts] = stream.mock.calls[0];
    expect(body).toMatchObject({ model: "claude-opus-5-5", betas: [FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA], fallbacks: "default", output_config: { effort: "high" } });
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(opts).toEqual({ timeout: ADVICE_TIMEOUT_MS, signal });
    const user = (body.messages as { content: string }[])[0].content;
    expect(user).toContain('{"candidates":[]}');
    expect(user).toContain("https://www.reuters.com/x");
    expect(r.parsed).toEqual(SAMPLE_ADVICE);
    expect(r.usage).toEqual({ inputTokens: 30_000, outputTokens: 6_000, cacheReadTokens: 2_000, cacheCreationTokens: 0, webSearches: 0 });
  });

  it("gets a parsed brief from the SDK's stream (real SDK, fake server-sent events)", async () => {
    const { client, requests } = sseClient([{ type: "text", text: JSON.stringify(SAMPLE_ADVICE) }]);
    const r = await runAdvice(client, { model: "claude-opus-5-5", contextJson: "{}", research });
    expect(r.error).toBeNull();
    expect(r.parsed).toEqual(SAMPLE_ADVICE);
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage).toEqual({ inputTokens: 30_000, outputTokens: 6_000, cacheReadTokens: 2_000, cacheCreationTokens: 0, webSearches: 0 });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(req.body).toMatchObject({ stream: true, model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(req.body.betas).toBeUndefined();
    expect(req.headers.get("anthropic-beta")?.split(",")).toEqual([FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA]);
  });

  it("joins the text either side of a mid-stream refusal fallback", async () => {
    const json = JSON.stringify(SAMPLE_ADVICE);
    const cut = 120;
    const { client } = sseClient([
      { type: "text", text: json.slice(0, cut) },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: { category: null } },
      { type: "text", text: json.slice(cut) },
    ]);
    const r = await runAdvice(client, { model: "claude-opus-5-5", contextJson: "{}", research });
    expect(r.parsed).toEqual(SAMPLE_ADVICE);
    expect(r.model).toBe("claude-opus-5");
  });

  it("reports a refusal or a cut-off answer instead of a brief, also when the SDK could not parse it", async () => {
    const refused = fakeClient({ model: "claude-opus-5-5", stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await runAdvice(refused.client, { model: "claude-opus-5-5", contextJson: "{}", research })).error).toMatch(/declined/);
    const cut = fakeClient({ model: "claude-opus-5-5", stop_reason: "max_tokens", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await runAdvice(cut.client, { model: "claude-opus-5-5", contextJson: "{}", research })).error).toMatch(/cut off/);
    // Real SDK: the cut-off JSON does not parse, so finalMessage() rejects; the stop reason still decides.
    const sdkCut = sseClient([{ type: "text", text: JSON.stringify(SAMPLE_ADVICE).slice(0, 200) }], "max_tokens");
    const r = await runAdvice(sdkCut.client, { model: "claude-opus-5-5", contextJson: "{}", research });
    expect(r).toMatchObject({ parsed: null, stopReason: "max_tokens", error: "The brief was cut off (too long)." });
    expect(r.usage.inputTokens).toBe(30_000);
    const garbled = sseClient([{ type: "text", text: '{"headline": 3}' }]);
    expect((await runAdvice(garbled.client, { model: "claude-opus-5-5", contextJson: "{}", research })).error).toMatch(/did not match/);
  });

  it("throws when the run is aborted (the pipeline reports it)", async () => {
    const { client } = sseClient([{ type: "text", text: JSON.stringify(SAMPLE_ADVICE) }]);
    const ac = new AbortController();
    ac.abort();
    await expect(runAdvice(client, { model: "claude-opus-5-5", contextJson: "{}", research, signal: ac.signal })).rejects.toThrow();
  });

  it("reads a brief from plain text only when it matches the schema", () => {
    expect(adviceFromText([{ type: "text", text: JSON.stringify(SAMPLE_ADVICE) }])).toEqual(SAMPLE_ADVICE);
    expect(adviceFromText([{ type: "text", text: "not json" }])).toBeNull();
    expect(adviceFromText([])).toBeNull();
  });

  it("tells the model when the research failed, and keeps the rules in the system prompt", () => {
    const msg = adviceUserMessage("{}", { ...research, ok: false, notes: "", sources: [], error: "Web research failed (HTTP 500)." });
    expect(msg).toMatch(/Web research: no data \(Web research failed \(HTTP 500\)\.\)/);
    expect(ADVICE_SYSTEM).toMatch(/ONLY by candidate id/);
    expect(ADVICE_SYSTEM).toMatch(/WAIT or AVOID/);
    expect(ADVICE_SYSTEM).toMatch(/no proven edge/);
    expect(ADVICE_SYSTEM).toMatch(/at most 2× the entry for TODAY, 3× for WEEK and 4× for MONTH/);
    expect(AdviceSchema.parse(SAMPLE_ADVICE)).toEqual(SAMPLE_ADVICE);
  });
});
