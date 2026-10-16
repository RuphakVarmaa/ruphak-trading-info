import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { MockEngineApi } from "@/lib/engine/mock";
import { defaultCalendar } from "../calendar/calendar";
import type { AdviceOut } from "./advise";
import { AdvisorRunError, runAdvisorPipeline } from "./pipeline";

interface PromptCandidate {
  id: string;
  ask: number | null;
  ltp: number | null;
  fitsCapital: boolean;
  days: number;
}

/** Reads the context JSON out of the advice request, the way the model would see it. */
function contextOf(body: { messages: { content: string }[] }) {
  const text = body.messages[0].content;
  const start = text.indexOf("{");
  const end = text.indexOf("\n\nWeb research");
  return JSON.parse(text.slice(start, end)) as { candidates: PromptCandidate[]; now: string };
}

/** A fake Anthropic client (no network): research returns notes with one source; advice picks the first affordable candidate. */
function fakeClient(opts: { adviceThrows?: boolean; researchThrows?: boolean } = {}) {
  const create = vi.fn(async () => {
    if (opts.researchThrows) throw Object.assign(new Error("overloaded"), { status: 529 });
    return {
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.livemint.com/market/fii-dii", title: "FII/DII data", encrypted_content: "x", page_age: null }] },
        { type: "text", text: "FII_DII: FIIs sold ₹850 crore (provisional, 15 Oct) https://www.livemint.com/market/fii-dii", citations: null },
      ],
      usage: { input_tokens: 20_000, output_tokens: 1_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 4, web_fetch_requests: 0 } },
    };
  });
  const parse = vi.fn(async (body: { messages: { content: string }[] }) => {
    if (opts.adviceThrows) throw Object.assign(new Error("Request timed out."), { status: 408 });
    const ctx = contextOf(body);
    const pick = ctx.candidates.find((c) => c.fitsCapital && (c.ask ?? 0) > 20)!;
    const ask = pick.ask as number;
    const advice: AdviceOut = {
      headline: "One small, low-confidence call idea; otherwise wait.",
      today: { action: "BUY", summary: "Covering above the call wall. No proven edge: size small.", candidateId: pick.id },
      outlook: [{ index: "NIFTY", horizon: "TODAY", lean: "UP", confidence: "LOW", rangeLow: null, rangeHigh: null, why: ["covering"] }],
      factors: [{ key: "FII_DII", label: "Funds", reading: "SUPPORTS_DOWN", detail: "FIIs sold ₹850 crore.", source: "web research: Mint" }],
      ideas: [
        { candidateId: pick.id, horizon: "TODAY", entryLow: ask * 0.98, entryHigh: ask * 1.01, stop: ask * 0.7, target: ask * 1.5, exitBy: `${ctx.now.slice(0, 10)}T14:45`, why: ["covering"], wrongIf: "The index falls back below VWAP.", confidence: "LOW" },
        { candidateId: "NIFTY-2099-01-01-1-CE", horizon: "WEEK", entryLow: 10, entryHigh: 11, stop: 7, target: 20, exitBy: "", why: [], wrongIf: "", confidence: "LOW" },
      ],
      zeroHero: { applicable: false, summary: "" },
      premium: { verdict: "NORMAL", detail: "IV close to VIX." },
      alsoKnow: ["Theta (time decay) speeds up in the last days before expiry."],
      avoid: ["Do not hold overnight."],
      sources: [{ title: "FII/DII data", url: "https://www.livemint.com/market/fii-dii" }],
    };
    return { model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: advice, usage: { input_tokens: 40_000, output_tokens: 7_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 3_000, server_tool_use: null } };
  });
  return { client: { messages: { create }, beta: { messages: { parse } } } as unknown as Anthropic, create, parse };
}

async function engine() {
  const api = new MockEngineApi("sim");
  const nowMs = Date.parse((await api.getState()).market.nowIst);
  return { api, nowMs };
}

describe("one advisor run on the mock engine (fake Anthropic client)", () => {
  it("writes a validated report: real contract, live price, costs, sources and the honesty line", async () => {
    const { api, nowMs } = await engine();
    const { client, create, parse } = fakeClient();
    const { report, notes, research } = await runAdvisorPipeline({ sources: api, calendar: defaultCalendar, client, model: "claude-opus-5-5", id: "adv-test", now: () => nowMs });
    expect(create).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(research.ok).toBe(true);
    expect(report.ideas).toHaveLength(1);
    expect(notes.some((n) => n.includes("NIFTY-2099-01-01-1-CE"))).toBe(true);
    const idea = report.ideas[0];
    expect(report.today).toMatchObject({ action: "BUY", ideaId: idea.id });
    expect(idea.lots).toBeGreaterThanOrEqual(1);
    expect(idea.stop).toBeLessThan(idea.entry.ask);
    expect(idea.target).toBeGreaterThan(idea.entry.ask);
    expect(idea.costPerLot).toBeLessThanOrEqual(10_000);
    // Validated against the chain the engine serves: the ask is that strike's live ask (the mock jitters every 3 s).
    const chain = await api.getOptionChain(idea.contract.index, idea.contract.expiry);
    const row = chain.rows.find((r) => r.strike === idea.contract.strike)!;
    const liveAsk = (idea.contract.optionType === "CE" ? row.ce : row.pe)!.ask!;
    expect(Math.abs(idea.entry.ask - liveAsk) / liveAsk).toBeLessThan(0.03);
    expect(report.sources).toEqual([{ title: "FII/DII data", url: "https://www.livemint.com/market/fii-dii" }]);
    // 60k in × $4 + 8.5k out × $20 + 3k cache writes × $5 + 4 searches × $0.01.
    expect(report.costUsd).toBeCloseTo(0.24 + 0.17 + 0.015 + 0.04, 4);
    expect(report.honesty).toMatch(/no proven edge/);
    expect(report.market.nifty).toBeGreaterThan(0);
  });

  it("still writes the brief when the web research fails (FII/DII becomes no data)", async () => {
    const { api, nowMs } = await engine();
    const { client } = fakeClient({ researchThrows: true });
    const { report, notes } = await runAdvisorPipeline({ sources: api, calendar: defaultCalendar, client, model: "claude-opus-5-5", id: "adv-test", now: () => nowMs });
    expect(report.factors[0]).toMatchObject({ key: "FII_DII", reading: "NO_DATA" });
    expect(report.sources).toEqual([]);
    expect(notes[0]).toMatch(/Web research failed/);
  });

  it("fails in plain words when the advice call fails (the DO keeps the previous brief)", async () => {
    const { api, nowMs } = await engine();
    const { client } = fakeClient({ adviceThrows: true });
    await expect(runAdvisorPipeline({ sources: api, calendar: defaultCalendar, client, model: "claude-opus-5-5", id: "adv-test", now: () => nowMs })).rejects.toThrow(AdvisorRunError);
    await expect(runAdvisorPipeline({ sources: api, calendar: defaultCalendar, client, model: "claude-opus-5-5", id: "adv-test", now: () => nowMs })).rejects.toThrow(/HTTP 408/);
  });
});
