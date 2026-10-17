import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { RESEARCH_DOMAINS } from "./knowledge";
import { extractSources, researchTool, responseNotes, runResearch } from "./research";

const NOW = Date.parse("2026-10-16T08:50:00+05:30");

const usage = (i: number, o: number, searches = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } });

const searchResult = (url: string, title: string) => ({ type: "web_search_result", url, title, encrypted_content: "x", page_age: null });

/** A fake Anthropic client: never touches the network. Records a copy of each request. */
function fakeClient(responses: (() => unknown)[]) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const create = vi.fn<(body: Record<string, unknown>, o?: { signal?: AbortSignal }) => Promise<unknown>>(async (body) => {
    calls.push(JSON.parse(JSON.stringify(body)));
    const next = responses[Math.min(i++, responses.length - 1)];
    return next();
  });
  return { client: { messages: { create } } as unknown as Anthropic, calls, create };
}

describe("source extraction", () => {
  it("collects search results and cited URLs on the allowed domains, once each", () => {
    const content = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "FII DII" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: [
          searchResult("https://www.moneycontrol.com/news/fii-dii-1.html", "FIIs net sellers"),
          searchResult("https://www.livemint.com/market/gift-nifty.html", "GIFT Nifty"),
          searchResult("https://www.nseindia.com/reports/fii", "NSE report"),
          searchResult("https://www.moneycontrol.com/news/fii-dii-1.html#top", "dup"),
        ],
      },
      { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      {
        type: "text",
        text: "FIIs sold ₹1,200 crore.",
        citations: [
          { type: "web_search_result_location", url: "https://www.reuters.com/markets/asia/x", title: "Reuters", cited_text: "", encrypted_index: "" },
          { type: "web_search_result_location", url: "javascript:alert(1)", title: "bad", cited_text: "", encrypted_index: "" },
        ],
      },
    ];
    expect(extractSources(content)).toEqual([
      { url: "https://www.moneycontrol.com/news/fii-dii-1.html", title: "FIIs net sellers" },
      { url: "https://www.livemint.com/market/gift-nifty.html", title: "GIFT Nifty" },
      { url: "https://www.reuters.com/markets/asia/x", title: "Reuters" },
    ]);
  });

  it("limits the search tool to reputable finance news (no exchange sites) and 6 searches", () => {
    const t = researchTool();
    expect(t).toMatchObject({ type: "web_search_20260209", name: "web_search", max_uses: 6 });
    expect(t.allowed_domains).toEqual([...RESEARCH_DOMAINS]);
    expect(t.allowed_domains?.some((d) => /nseindia|bseindia/.test(d))).toBe(false);
  });
});

const cite = (url: string) => ({ type: "web_search_result_location", url, title: "t", cited_text: "", encrypted_index: "" });

describe("research notes", () => {
  it("keep each text block's citation URLs and do not break sentences at citation boundaries", () => {
    const content = [
      { type: "text", text: "FII_DII: ", citations: null },
      { type: "text", text: "FIIs sold ₹850 crore", citations: [cite("https://www.livemint.com/fii#x"), cite("https://www.livemint.com/fii"), cite("https://www.nseindia.com/fii")] },
      { type: "text", text: " on 15 Oct (provisional); DIIs bought ", citations: null },
      { type: "text", text: "₹1,100 crore.", citations: [cite("https://www.moneycontrol.com/dii")] },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
    ];
    expect(responseNotes(content)).toBe(
      "FII_DII: FIIs sold ₹850 crore [https://www.livemint.com/fii] on 15 Oct (provisional); DIIs bought ₹1,100 crore. [https://www.moneycontrol.com/dii]",
    );
  });
});

describe("the research call (fake client)", () => {
  it("passes the abort signal and marks an answer cut off at max_tokens", async () => {
    const { client, create } = fakeClient([
      () => ({ model: "m", stop_reason: "max_tokens", content: [{ type: "text", text: "FII_DII: FIIs sold ₹850 crore", citations: [cite("https://www.livemint.com/fii")] }], usage: usage(10, 8_000) }),
    ]);
    const signal = new AbortController().signal;
    const r = await runResearch(client, { model: "claude-opus-5-5", nowMs: NOW, signal });
    expect(create.mock.calls[0][1]).toEqual({ signal });
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_tokens");
    expect(r.notes).toBe("FII_DII: FIIs sold ₹850 crore [https://www.livemint.com/fii]\n(Research was cut off; some items may be missing.)");
  });

  it("continues a paused turn by sending the assistant content back, then returns notes, sources and usage", async () => {
    const paused = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "FII DII provisional" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [searchResult("https://www.business-standard.com/markets/fii", "FII data")] },
    ];
    const { client, calls } = fakeClient([
      () => ({ model: "claude-opus-5-5", stop_reason: "pause_turn", content: paused, usage: usage(5_000, 300, 1) }),
      () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "FII_DII: FIIs sold ₹1,200 crore (provisional, 15 Oct).", citations: null }], usage: usage(6_000, 900, 2) }),
    ]);
    const r = await runResearch(client, { model: "claude-opus-5-5", nowMs: NOW });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" } });
    expect((calls[0].tools as unknown[])[0]).toMatchObject({ type: "web_search_20260209", max_uses: 6 });
    // The resumed request is the user message plus the paused assistant turn, with no extra "continue" message.
    const resumed = calls[1].messages as { role: string; content: unknown }[];
    expect(resumed.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(resumed[1].content).toEqual(paused);
    expect(r.ok).toBe(true);
    expect(r.notes).toMatch(/FIIs sold ₹1,200 crore/);
    expect(r.sources).toEqual([{ url: "https://www.business-standard.com/markets/fii", title: "FII data" }]);
    expect(r.usage).toEqual({ inputTokens: 11_000, outputTokens: 1_200, cacheReadTokens: 0, cacheCreationTokens: 0, webSearches: 3 });
  });

  it("stops after 3 continuations", async () => {
    const { client, create } = fakeClient([() => ({ model: "m", stop_reason: "pause_turn", content: [{ type: "text", text: "partial", citations: null }], usage: usage(10, 1) })]);
    const r = await runResearch(client, { model: "claude-opus-5-5", nowMs: NOW });
    expect(create).toHaveBeenCalledTimes(4);
    expect(r.ok).toBe(true);
    expect(r.notes).toMatch(/stopped early/);
  });

  it("never throws: a failed or refused search is reported as no data", async () => {
    const failing = fakeClient([
      () => {
        throw Object.assign(new Error("Overloaded sk-ant-api03-secret"), { status: 529 });
      },
    ]);
    const r = await runResearch(failing.client, { model: "claude-opus-5-5", nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 529/);
    expect(r.error).not.toMatch(/secret/);
    const refused = fakeClient([() => ({ model: "m", stop_reason: "refusal", content: [], usage: usage(10, 1) })]);
    expect((await runResearch(refused.client, { model: "claude-opus-5-5", nowMs: NOW })).ok).toBe(false);
    const empty = fakeClient([() => ({ model: "m", stop_reason: "end_turn", content: [], usage: usage(10, 1) })]);
    expect((await runResearch(empty.client, { model: "claude-opus-5-5", nowMs: NOW })).error).toMatch(/no notes/);
  });
});

describe("refused research domains", () => {
  it("reads the domain list out of the search tool's 400 and drops them from the tool", async () => {
    const { refusedDomainsOf } = await import("./research");
    const err = new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"The following domains are not accessible to our user agent: ['cnbctv18.com', 'economictimes.indiatimes.com']"}}`);
    expect(refusedDomainsOf(err)).toEqual(["cnbctv18.com", "economictimes.indiatimes.com"]);
    expect(refusedDomainsOf(new Error("429 rate limited"))).toEqual([]);
    const t = researchTool(new Set(["livemint.com"]));
    expect(t.allowed_domains).not.toContain("livemint.com");
    expect(t.allowed_domains).toContain("moneycontrol.com");
  });

  it("retries once without a refused domain and still returns notes", async () => {
    let calls = 0;
    const seen: string[][] = [];
    const client = {
      messages: {
        create: async (body: { tools: { allowed_domains: string[] }[] }) => {
          calls++;
          seen.push([...body.tools[0].allowed_domains]);
          if (calls === 1) throw new Error("400 The following domains are not accessible to our user agent: ['livemint.com']");
          return { content: [{ type: "text", text: "FII net sold ₹1,000 crore (provisional)." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
        },
      },
    } as unknown as Parameters<typeof runResearch>[0];
    const refused = new Set<string>();
    const r = await runResearch(client, { model: "claude-opus-5-5", nowMs: Date.parse("2026-10-16T13:00:00+05:30"), refused });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect([...refused]).toEqual(["livemint.com"]);
    // The isolate-wide set is untouched when the caller passes its own.
    expect(researchTool().allowed_domains).toContain("livemint.com");
    expect(seen[0]).toContain("livemint.com");
    expect(seen[1]).not.toContain("livemint.com");
  });
});
