/**
 * The advice call: Claude (claude-opus-5-5, effort "high") reads the engine's context JSON and the research
 * notes and answers in a fixed structure (Zod schema → structured output, with server-side refusal fallbacks).
 * The call streams (a long answer at effort high can take minutes) and the SDK parses the finished message.
 * Ideas name a candidate id only; src/engine/advisor/validate.ts maps each id to the real listed contract,
 * re-prices it and drops what does not hold up.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ALSO_KNOW_TOPICS, HONESTY_LINE } from "./knowledge";
import type { ResearchResult } from "./research";
import { usageOf } from "./research";
import type { AdvisorUsage } from "./types";
import { MAX_TARGET_MULT } from "./validate";

export const ADVICE_MAX_TOKENS = 32_000;
/**
 * How long the stream may take to open (the SDK's timeout covers the request until the response headers
 * arrive; a refusal fallback before any output adds to it). The whole call is bounded by the Durable Object's
 * deadline through the abort signal.
 */
export const ADVICE_TIMEOUT_MS = 240_000;
/** The beta header `messages.parse()` sends for structured outputs; `messages.stream()` does not add it. */
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const Horizon = z.enum(["TODAY", "WEEK", "MONTH"]);
const Confidence = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const AdviceSchema = z.object({
  headline: z.string().describe("One plain sentence: the answer first."),
  today: z.object({
    action: z.enum(["BUY", "WAIT", "AVOID"]),
    summary: z.string().describe("Two to four short sentences: what to do today and why."),
    candidateId: z.string().nullable().describe("When action is BUY: the candidate id of the one idea to buy today (it must also be in ideas). Otherwise null."),
  }),
  outlook: z.array(
    z.object({
      index: z.enum(["NIFTY", "SENSEX"]),
      horizon: Horizon,
      lean: z.enum(["UP", "DOWN", "SIDEWAYS"]),
      confidence: Confidence,
      rangeLow: z.number().nullable(),
      rangeHigh: z.number().nullable(),
      why: z.array(z.string()),
    }),
  ),
  factors: z.array(
    z.object({
      key: z.enum(["FII_DII", "NEWS_UNCERTAINTY", "GLOBAL_CUES", "VOLATILITY_PREMIUM", "OPTIONS_POSITIONING", "SHORT_COVERING", "TREND", "EVENTS", "OTHER"]),
      label: z.string(),
      reading: z.enum(["SUPPORTS_UP", "SUPPORTS_DOWN", "NEUTRAL", "RISK", "NO_DATA"]),
      detail: z.string(),
      source: z.string(),
    }),
  ),
  ideas: z.array(
    z.object({
      candidateId: z.string(),
      horizon: Horizon,
      entryLow: z.number(),
      entryHigh: z.number(),
      stop: z.number(),
      target: z.number(),
      exitBy: z.string().describe("IST date-time YYYY-MM-DDTHH:mm by which to exit if neither stop nor target is hit."),
      why: z.array(z.string()),
      wrongIf: z.string(),
      confidence: Confidence,
    }),
  ),
  zeroHero: z.object({ applicable: z.boolean(), summary: z.string() }),
  premium: z.object({ verdict: z.enum(["CHEAP", "NORMAL", "EXPENSIVE", "NO_DATA"]), detail: z.string() }),
  alsoKnow: z.array(z.string()),
  avoid: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});

export type AdviceOut = z.infer<typeof AdviceSchema>;

export const ADVICE_SYSTEM = [
  "You are a careful Indian index-options advisor (NIFTY and SENSEX) writing for a beginner with a small account: ₹10,000 is typical, 1 lot.",
  "Write plain English in short sentences. Explain any jargon in one short line the first time you use it (e.g. 'PCR (put-call ratio: puts open divided by calls open)'). Put the answer first.",
  "",
  "Weigh every factor in the context and the research notes, and say how each one reads:",
  "- FII/DII flows (foreign and domestic funds); current uncertainty that is bad for Indian markets; global cues (US markets, US 10-year yield, dollar, crude, USD/INR, GIFT Nifty).",
  "- Short covering (computed for you per expiry and on the live flow: call writers covering → up; put writers covering → down).",
  "- Options positioning: support and resistance from the OI walls, PCR, max pain (where option writers lose least at expiry; its pull is strongest near expiry).",
  "- Volatility and premium: IV against India VIX, IV crush after events, time decay (theta), the measured cheapest time of day to buy (entryTimes, entryWindow).",
  "- Trend and the engine's setups and signals; scheduled events; expiry-day dynamics; zero-hero odds (far out-of-the-money expiry-day options).",
  "",
  "Trade ideas:",
  "- Pick ideas ONLY by candidate id from `candidates`. Never invent a contract, a strike or an expiry. zeroHero candidates are never ideas.",
  "- For each idea give the buy zone (entryLow–entryHigh), stop and target as option premium prices in rupees, the exit-by time (IST), why, and what would prove it wrong (wrongIf).",
  `- Keep the buy zone near the live ask, the stop 10–60% below the entry, and the target at least 1.2× the risk and at most ${MAX_TARGET_MULT.TODAY}× the entry for TODAY, ${MAX_TARGET_MULT.WEEK}× for WEEK and ${MAX_TARGET_MULT.MONTH}× for MONTH (the engine lowers a higher target). Prefer contracts that fit the capital (fitsCapital).`,
  "- At most 6 ideas across TODAY, WEEK and MONTH. Fewer is fine. Zero ideas is fine.",
  "- When today is WAIT or AVOID, still consider WEEK and MONTH: if a contract offers a sensible risk/reward once a clear condition is met (for example 'only if NIFTY closes above 23,250' or 'after the event'), give at most one such conditional idea per horizon with LOW confidence, the condition first in `why`, and the condition's failure in `wrongIf`. Skip the horizon when nothing is sensible.",
  "- Say WAIT or AVOID when nothing is worth buying: that is a valid and often correct answer. Respect the plan's no-trade rules (todayPlan) and the measured findings.",
  "- The project's research found no proven edge for buying options. Say so once, plainly, in today's summary or in avoid; do not lecture. Never promise profit. |delta| is only a rough market estimate of the chance of finishing in the money; the implied range is what option prices imply, not a forecast.",
  "",
  "Outlook: for NIFTY and SENSEX give TODAY, WEEK and MONTH (six rows): lean UP/DOWN/SIDEWAYS, confidence, a range (use the option-implied ranges where they fit), and the top reasons.",
  "Factors: one row per key FII_DII, NEWS_UNCERTAINTY, GLOBAL_CUES, SHORT_COVERING, OPTIONS_POSITIONING, VOLATILITY_PREMIUM, TREND, EVENTS, with the numbers behind the reading and where they came from. Use NO_DATA when the context and the research have nothing.",
  `alsoKnow: 4–8 short things a beginner should know that they did not ask about, tied to today's market where possible. Ideas: ${ALSO_KNOW_TOPICS.join("; ")}.`,
  "avoid: what not to do today (short lines).",
  "",
  "Numbers: quote numbers only from the context or the research notes, and name the source. Missing data is 'no data'. sources: only URLs that appear in the research notes, the research sources or the news items.",
  `The standing caution shown under the brief: "${HONESTY_LINE}"`,
].join("\n");

export function adviceUserMessage(contextJson: string, research: ResearchResult): string {
  const notes = research.ok
    ? `Web research notes (Claude web search, reputable finance news):\n${research.notes}\n\nResearch sources:\n${research.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n") || "- none"}`
    : `Web research: no data (${research.error ?? "not run"}). Treat FII/DII and global cues as NO_DATA unless the context's news carries them.`;
  return `Engine context (JSON):\n${contextJson}\n\n${notes}\n\nWrite today's brief.`;
}

export interface AdviceResult {
  parsed: AdviceOut | null;
  usage: AdvisorUsage;
  model: string;
  stopReason: string | null;
  error: string | null;
}

/** Models that accept server-side refusal fallbacks with `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export interface AdviceOptions {
  model: string;
  contextJson: string;
  research: ResearchResult;
  /** Aborts the stream (the Durable Object's deadline), so a run that is given up stops paying. */
  signal?: AbortSignal;
}

/** The parts of a finished (or parsed) message the advice reads. */
interface AdviceMessage {
  model: string;
  stop_reason: string | null;
  usage: unknown;
  content: readonly { type: string; text?: string }[];
  parsed_output?: unknown;
}

/**
 * The brief from the message's text when the SDK could not parse it: after a refusal fallback mid-stream the
 * JSON is split across the text blocks either side of the `fallback` block, so they are joined first.
 */
export function adviceFromText(content: AdviceMessage["content"]): AdviceOut | null {
  const joined = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!joined.trim()) return null;
  try {
    const r = AdviceSchema.safeParse(JSON.parse(joined));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const isParseError = (err: unknown) => /Failed to parse structured output/.test(String((err as { message?: unknown })?.message ?? err));

/** The structured advice call, streamed; throws on transport errors and aborts (the pipeline reports them in plain words). */
export async function runAdvice(client: Anthropic, opts: AdviceOptions): Promise<AdviceResult> {
  const fallbacks = FALLBACK_MODELS.has(opts.model);
  const stream = client.beta.messages.stream(
    {
      model: opts.model,
      max_tokens: ADVICE_MAX_TOKENS,
      system: [{ type: "text", text: ADVICE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: adviceUserMessage(opts.contextJson, opts.research) }],
      output_config: { format: betaZodOutputFormat(AdviceSchema), effort: "high" },
      betas: [...(fallbacks ? [FALLBACK_BETA] : []), STRUCTURED_OUTPUTS_BETA],
      ...(fallbacks ? { fallbacks: "default" as const } : {}),
    },
    { timeout: ADVICE_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  let resp: AdviceMessage;
  try {
    resp = (await stream.finalMessage()) as unknown as AdviceMessage;
  } catch (err) {
    // The SDK parses the JSON as the stream ends and throws when it does not parse (a cut-off or refused
    // answer, or text split by a mid-stream fallback). The message did arrive: judge it from its stop reason.
    const snap = stream.currentMessage as unknown as AdviceMessage | undefined;
    if (!isParseError(err) || !snap || snap.stop_reason == null) throw err;
    resp = { ...snap, parsed_output: undefined };
  }
  const usage = usageOf(resp.usage as Anthropic.Usage);
  const stopReason = resp.stop_reason ?? null;
  if (stopReason === "refusal") return { parsed: null, usage, model: resp.model, stopReason, error: "The model declined to write the brief." };
  if (stopReason === "max_tokens") return { parsed: null, usage, model: resp.model, stopReason, error: "The brief was cut off (too long)." };
  const parsed = (resp.parsed_output as AdviceOut | null | undefined) ?? adviceFromText(resp.content);
  return { parsed, usage, model: resp.model, stopReason, error: parsed ? null : "The brief did not match the expected structure." };
}
