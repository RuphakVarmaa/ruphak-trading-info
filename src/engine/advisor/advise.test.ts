import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ADVICE_SYSTEM, ADVICE_TIMEOUT_MS, AdviceSchema, adviceUserMessage, runAdvice, type AdviceOut } from "./advise";
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

function fakeClient(resp: Record<string, unknown>) {
  const parse = vi.fn<(body: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => resp);
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe("the advice call (fake client)", () => {
  it("asks Opus 5.5 at effort high for structured output, with refusal fallbacks and a long timeout", async () => {
    const { client, parse } = fakeClient({ model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: SAMPLE_ADVICE, usage: { input_tokens: 30_000, output_tokens: 6_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, server_tool_use: null } });
    const r = await runAdvice(client, { model: "claude-opus-5-5", contextJson: '{"candidates":[]}', research });
    const [body, opts] = parse.mock.calls[0];
    expect(body).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "high" } });
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(opts).toEqual({ timeout: ADVICE_TIMEOUT_MS });
    const user = (body.messages as { content: string }[])[0].content;
    expect(user).toContain('{"candidates":[]}');
    expect(user).toContain("https://www.reuters.com/x");
    expect(r.parsed).toEqual(SAMPLE_ADVICE);
    expect(r.usage).toEqual({ inputTokens: 30_000, outputTokens: 6_000, cacheReadTokens: 2_000, cacheCreationTokens: 0, webSearches: 0 });
  });

  it("reports a refusal or a cut-off answer instead of a brief", async () => {
    const refused = fakeClient({ model: "claude-opus-5-5", stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await runAdvice(refused.client, { model: "claude-opus-5-5", contextJson: "{}", research })).error).toMatch(/declined/);
    const cut = fakeClient({ model: "claude-opus-5-5", stop_reason: "max_tokens", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await runAdvice(cut.client, { model: "claude-opus-5-5", contextJson: "{}", research })).error).toMatch(/cut off/);
  });

  it("tells the model when the research failed, and keeps the rules in the system prompt", () => {
    const msg = adviceUserMessage("{}", { ...research, ok: false, notes: "", sources: [], error: "Web research failed (HTTP 500)." });
    expect(msg).toMatch(/Web research: no data \(Web research failed \(HTTP 500\)\.\)/);
    expect(ADVICE_SYSTEM).toMatch(/ONLY by candidate id/);
    expect(ADVICE_SYSTEM).toMatch(/WAIT or AVOID/);
    expect(ADVICE_SYSTEM).toMatch(/no proven edge/);
    expect(AdviceSchema.parse(SAMPLE_ADVICE)).toEqual(SAMPLE_ADVICE);
  });
});
