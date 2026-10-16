/**
 * The advisor's web research call: Claude (claude-opus-5-5, effort "medium") with the server-side web search
 * tool, restricted to reputable finance news, collects the facts the engine has no feed for: FII/FPI and DII
 * cash flows, FII index-futures positioning, GIFT Nifty and global cues, the next two weeks' big events, and
 * current uncertainty for Indian markets. It returns plain notes with a source URL for every number, the URLs
 * the search actually returned, and token usage. A failure is not fatal: the advice runs without it and the
 * FII/DII factor reads "no data".
 */
import type Anthropic from "@anthropic-ai/sdk";
import { istIso } from "../clock";
import { RESEARCH_DOMAINS } from "./knowledge";
import { ZERO_USAGE, addUsage, type AdvisorUsage } from "./types";

export const RESEARCH_MAX_SEARCHES = 6;
/** pause_turn continuations (each re-sends the paused assistant turn). */
export const RESEARCH_MAX_CONTINUATIONS = 3;
export const RESEARCH_MAX_TOKENS = 8_000;

export interface ResearchSource {
  title: string;
  url: string;
}

export interface ResearchResult {
  ok: boolean;
  /** Plain notes, "" when the research failed. */
  notes: string;
  sources: ResearchSource[];
  usage: AdvisorUsage;
  /** Why it failed, in plain words (never the key or the prompt). */
  error: string | null;
  stopReason: string | null;
}

export const RESEARCH_SYSTEM = [
  "You are a research assistant for an Indian index-options desk (NIFTY and SENSEX).",
  "Search reputable finance news and report facts only: numbers, dates and the source URL for each.",
  "Never estimate or invent a number. When something is not found, write 'not found'.",
  "Prefer the most recent reports; give the date each figure refers to. Mark provisional figures as provisional.",
  "Do not give trading advice. Plain text, short lines, grouped under the headings you are asked for.",
].join("\n");

export function researchPrompt(nowMs: number): string {
  return [
    `Now: ${istIso(nowMs)} (IST).`,
    "Find, with numbers, dates and the source URL for each line:",
    "1. FII/FPI and DII cash-market net buying or selling (₹ crore): today's provisional figure if out, and the last few sessions.",
    "2. FII index-futures positioning (net long/short, long-short ratio) if reported.",
    "3. GIFT Nifty (level and indicated gap) and global cues: US markets' last close (S&P 500, Nasdaq, Dow), the US 10-year Treasury yield, the dollar index, Brent crude, USD/INR.",
    "4. Big scheduled Indian and global events in the next 2 weeks (RBI, US Fed, CPI/inflation, GDP, big results, elections, budget, expiry-related events) with dates.",
    "5. Any current uncertainty that is bad for Indian markets (geopolitics, tariffs or trade, policy, flows, crude, the rupee), each with its source.",
    "Answer under the headings FII_DII, FII_FUTURES, GLOBAL_CUES, EVENTS, UNCERTAINTY. Write 'not found' under a heading with nothing reliable.",
  ].join("\n");
}

/** The web search tool, limited to the allowed domains (exchange sites left out). */
export function researchTool(): Anthropic.Messages.WebSearchTool20260209 {
  return {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: RESEARCH_MAX_SEARCHES,
    allowed_domains: [...RESEARCH_DOMAINS],
    user_location: { type: "approximate", country: "IN", timezone: "Asia/Kolkata" },
  };
}

const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

function allowedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return RESEARCH_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * The source URLs in a response: every web_search_result inside web_search_tool_result blocks, plus the URLs
 * text blocks cite (web_search_result_location). De-duplicated, http(s) only, on the allowed domains.
 */
export function extractSources(content: readonly Anthropic.ContentBlock[] | readonly unknown[]): ResearchSource[] {
  const out = new Map<string, ResearchSource>();
  const add = (url: unknown, title: unknown) => {
    if (!httpUrl(url) || !allowedHost(url)) return;
    const key = url.replace(/#.*$/, "");
    if (!out.has(key)) out.set(key, { url: key, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : new URL(key).hostname });
  };
  for (const raw of content) {
    const b = raw as { type?: string; content?: unknown; citations?: unknown };
    if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as { type?: string; url?: unknown; title?: unknown }[]) if (r?.type === "web_search_result") add(r.url, r.title);
    } else if (b?.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations as { type?: string; url?: unknown; title?: unknown }[]) if (c?.type === "web_search_result_location") add(c.url, c.title);
    }
  }
  return [...out.values()];
}

export function usageOf(u: Anthropic.Usage | null | undefined): AdvisorUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    webSearches: u?.server_tool_use?.web_search_requests ?? 0,
  };
}

/** A plain error line for the brief: the SDK's status and type, never the request. */
export function plainError(err: unknown): string {
  const e = err as { status?: number; name?: string; message?: string };
  const status = typeof e?.status === "number" ? `HTTP ${e.status}` : null;
  const msg = (e?.message ?? String(err)).replace(/sk-ant-[\w-]+/g, "[key]").replace(/\s+/g, " ").slice(0, 160);
  return [status, msg].filter(Boolean).join(": ");
}

export interface ResearchOptions {
  model: string;
  nowMs: number;
  maxContinuations?: number;
}

/** Runs the research call, continuing a paused turn up to 3 times; never throws. */
export async function runResearch(client: Anthropic, opts: ResearchOptions): Promise<ResearchResult> {
  const user: Anthropic.MessageParam = { role: "user", content: researchPrompt(opts.nowMs) };
  const messages: Anthropic.MessageParam[] = [user];
  const texts: string[] = [];
  const sources = new Map<string, ResearchSource>();
  let usage = ZERO_USAGE;
  let stopReason: string | null = null;
  const maxContinuations = opts.maxContinuations ?? RESEARCH_MAX_CONTINUATIONS;
  try {
    for (let turn = 0; turn <= maxContinuations; turn++) {
      const resp = await client.messages.create({
        model: opts.model,
        max_tokens: RESEARCH_MAX_TOKENS,
        system: [{ type: "text", text: RESEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages,
        tools: [researchTool()],
        output_config: { effort: "medium" },
      });
      usage = addUsage(usage, usageOf(resp.usage));
      stopReason = resp.stop_reason ?? null;
      for (const s of extractSources(resp.content)) if (!sources.has(s.url)) sources.set(s.url, s);
      for (const b of resp.content) if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());
      if (resp.stop_reason !== "pause_turn") break;
      // Resume the paused turn: send the assistant content back as it came (no extra user message; the API
      // joins consecutive assistant messages into one turn).
      if (turn < maxContinuations) messages.push({ role: "assistant", content: resp.content as Anthropic.ContentBlockParam[] });
    }
  } catch (err) {
    return { ok: false, notes: texts.join("\n"), sources: [...sources.values()], usage, error: `Web research failed (${plainError(err)}).`, stopReason };
  }
  if (stopReason === "refusal") return { ok: false, notes: "", sources: [...sources.values()], usage, error: "Web research was declined by the model.", stopReason };
  const notes = texts.join("\n").trim();
  if (!notes) return { ok: false, notes: "", sources: [...sources.values()], usage, error: "Web research returned no notes.", stopReason };
  const paused = stopReason === "pause_turn" ? "\n(Research stopped early after 3 continuations; some items may be missing.)" : "";
  return { ok: true, notes: `${notes}${paused}`, sources: [...sources.values()], usage, error: null, stopReason };
}
