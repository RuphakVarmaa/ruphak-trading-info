/**
 * What each model call costs, from its token usage (SPEC §8 as amended, #11). Prices are USD per million tokens
 * from the claude-api skill (cached 2026-10-06), plus the two models a deep-model refusal can fall back to. An
 * unknown model is priced on the most expensive row, so a cost is never under-counted. A call that sent a
 * request and ended without usage is recorded at its worst case.
 */
import type { LlmUsage } from "../ports";

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWrite5mPerM: number;
  cacheWrite1hPerM: number;
  /** A prompt (input plus cache) above this many tokens is priced on the long card. */
  longAbove?: number;
  longInputPerM?: number;
  longOutputPerM?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Cache reads 0.1× input, 5-minute writes 1.25×, 1-hour writes 2×; a prompt over 100K tokens uses the long card.
  "claude-haiku-5-5": { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWrite5mPerM: 0.125, cacheWrite1hPerM: 0.2, longAbove: 100_000, longInputPerM: 0.5, longOutputPerM: 2.5 },
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8 },
  // Server-side refusal fallbacks of the deep model; each attempt bills at the model that ran it.
  "claude-opus-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
};

/** The models a server-side refusal fallback may hand a deep-model request to. */
export const FALLBACK_TARGETS: readonly string[] = ["claude-opus-5", "claude-opus-4-8"];

const HIGHEST: ModelPrice = Object.values(MODEL_PRICES).reduce((a, b) => (b.outputPerM > a.outputPerM || (b.outputPerM === a.outputPerM && b.inputPerM > a.inputPerM) ? b : a));

/** The row for a model id (an exact match, else the longest listed id it extends), else the most expensive row. */
export function priceFor(model: string): ModelPrice {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  let best: string | null = null;
  for (const id of Object.keys(MODEL_PRICES)) if (model.startsWith(`${id}-`) && (!best || id.length > best.length)) best = id;
  return best ? MODEL_PRICES[best] : HIGHEST;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** One call's cost from its usage. Cache writes are priced at the 1-hour rate unless told otherwise (conservative). */
export function callCostUsd(u: LlmUsage, model: string, cacheTtl: "5m" | "1h" = "1h"): number {
  const p = priceFor(model);
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const long = p.longAbove !== undefined && prompt > p.longAbove;
  // The long card scales the cache rates with the input rate.
  const k = long && p.longInputPerM !== undefined ? p.longInputPerM / p.inputPerM : 1;
  const input = long ? (p.longInputPerM ?? p.inputPerM) : p.inputPerM;
  const output = long ? (p.longOutputPerM ?? p.outputPerM) : p.outputPerM;
  const write = (cacheTtl === "1h" ? p.cacheWrite1hPerM : p.cacheWrite5mPerM) * k;
  return round6((u.inputTokens * input + u.outputTokens * output + u.cacheReadTokens * p.cacheReadPerM * k + u.cacheCreationTokens * write) / 1e6);
}

/** A call made of several attempts (a refusal fallback reports each in usage.iterations): each priced at its own model. */
export function iterationsCostUsd(iterations: readonly { model: string; usage: LlmUsage }[], cacheTtl: "5m" | "1h" = "1h"): number {
  return round6(iterations.reduce((s, it) => s + callCostUsd(it.usage, it.model, cacheTtl), 0));
}

function worstFor(p: ModelPrice, inputTokensEst: number, maxTokens: number): number {
  const long = p.longAbove !== undefined && inputTokensEst > p.longAbove;
  const k = long && p.longInputPerM !== undefined ? p.longInputPerM / p.inputPerM : 1;
  // Every input token as a 1-hour cache write (the dearest input rate), every output token used.
  const input = Math.max(long ? (p.longInputPerM ?? p.inputPerM) : p.inputPerM, p.cacheWrite1hPerM * k);
  const output = long ? (p.longOutputPerM ?? p.outputPerM) : p.outputPerM;
  return (inputTokensEst * input + maxTokens * output) / 1e6;
}

/**
 * The most one call can cost: `attempts` (maxRetries + 1) billed attempts, each at the dearest model that can
 * serve it (the requested one, and its refusal-fallback targets when `fallbacks` is on).
 */
export function worstCaseUsd(model: string, inputTokensEst: number, maxTokens: number, o: { attempts?: number; fallbacks?: boolean } = {}): number {
  const models = o.fallbacks ? [model, ...FALLBACK_TARGETS] : [model];
  const one = Math.max(...models.map((m) => worstFor(priceFor(m), inputTokensEst, maxTokens)));
  return round6(one * Math.max(1, o.attempts ?? 1));
}

/** True when the worst case still fits under the day's cap. */
export function capAllows(spentUsd: number, worstUsd: number, capUsd: number): boolean {
  return spentUsd + worstUsd <= capUsd + 1e-9;
}
