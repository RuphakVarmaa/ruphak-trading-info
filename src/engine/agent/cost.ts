/**
 * What each model call costs, from its token usage (SPEC §8 as amended, #11). Prices are USD per million tokens from
 * the claude-api skill (cached 2026-10-06), plus the rows of the models a deep-model refusal can fall back to. A model
 * that is not in the table is priced at the highest rate of every kind, so a cost is never under-counted. A call that
 * sent a request and ended without usage is recorded at its worst case.
 */
import { istAt, istDate } from "../clock";
import { BAR_5M_MS } from "../market/candles";
import type { LlmUsage } from "../ports";
import { AGENT_POLICY, REFLEX_CALL, REVIEW_CALL } from "./constants";

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWrite5mPerM: number;
  cacheWrite1hPerM: number;
  /** A prompt (input plus cache) above this many tokens is priced on the long card; the cache rates scale with it. */
  longAbove?: number;
  longInputPerM?: number;
  longOutputPerM?: number;
  /** Models a server-side refusal fallback can hand this model's requests to; each attempt bills at its own row. */
  fallbackModels?: readonly string[];
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Cache reads 0.1× input, 5-minute writes 1.25×, 1-hour writes 2×; no server-side fallback exists.
  "claude-haiku-5-5": { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWrite5mPerM: 0.125, cacheWrite1hPerM: 0.2, longAbove: 100_000, longInputPerM: 0.5, longOutputPerM: 2.5 },
  // Cache reads 0.05× input.
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8, fallbackModels: ["claude-opus-5", "claude-opus-4-8"] },
  "claude-opus-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10, fallbackModels: ["claude-opus-4-8"] },
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
};

/** How much dearer the long card is than the normal one for a prompt of this size (1 when it does not apply). */
function longFactor(p: ModelPrice, promptTokens: number): number {
  return p.longAbove !== undefined && promptTokens > p.longAbove && p.longInputPerM !== undefined ? p.longInputPerM / p.inputPerM : 1;
}

/** Per kind of token, the highest rate any row (or its long card) charges: the price of a model not in the table. */
const HIGHEST: ModelPrice = (() => {
  const rows = Object.values(MODEL_PRICES);
  const top = (f: (p: ModelPrice, k: number) => number) => Math.max(...rows.map((p) => Math.max(f(p, 1), f(p, longFactor(p, Infinity)))));
  return {
    inputPerM: top((p, k) => p.inputPerM * k),
    outputPerM: top((p, k) => (k === 1 ? p.outputPerM : (p.longOutputPerM ?? p.outputPerM * k))),
    cacheReadPerM: top((p, k) => p.cacheReadPerM * k),
    cacheWrite5mPerM: top((p, k) => p.cacheWrite5mPerM * k),
    cacheWrite1hPerM: top((p, k) => p.cacheWrite1hPerM * k),
  };
})();

const DATED = /^(.+)-\d{8}$/;
const row = (model: string): ModelPrice | null => (Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : null);

/** The row for a model id (also its dated snapshot, "<id>-YYYYMMDD"), else the highest rates in the table. */
export function priceFor(model: string): ModelPrice {
  const dated = DATED.exec(model);
  return row(model) ?? (dated ? row(dated[1]) : null) ?? HIGHEST;
}

/** True when the model has its own row (or its dated snapshot does). */
export function isPricedModel(model: string): boolean {
  return priceFor(model) !== HIGHEST;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const tokens = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);

/** One call's cost from its usage. Cache writes are priced at the 1-hour rate unless told otherwise (conservative). */
export function callCostUsd(u: LlmUsage, model: string, cacheTtl: "5m" | "1h" = "1h"): number {
  const p = priceFor(model);
  const [input, output, read, write] = [tokens(u.inputTokens), tokens(u.outputTokens), tokens(u.cacheReadTokens), tokens(u.cacheCreationTokens)];
  const k = longFactor(p, input + read + write);
  const outputRate = k === 1 ? p.outputPerM : (p.longOutputPerM ?? p.outputPerM * k);
  const writeRate = (cacheTtl === "1h" ? p.cacheWrite1hPerM : p.cacheWrite5mPerM) * k;
  return round6((input * p.inputPerM * k + output * outputRate + read * p.cacheReadPerM * k + write * writeRate) / 1e6);
}

/** One sampling attempt of a call (usage.iterations): a refused attempt and its fallback each bill at their own model. */
export interface UsageIteration {
  model: string;
  usage: LlmUsage;
}

export function iterationsCostUsd(iterations: readonly UsageIteration[], cacheTtl: "5m" | "1h" = "1h"): number {
  return round6(iterations.reduce((s, it) => s + callCostUsd(it.usage, it.model, cacheTtl), 0));
}

/**
 * What a finished call cost: its attempts priced one by one when the response lists them, never less than its usage
 * priced at the model that answered; null when the call ended without usage (record its worst case instead).
 */
export function responseCostUsd(r: { usage: LlmUsage | null; model: string; iterations?: readonly UsageIteration[] | null }, cacheTtl: "5m" | "1h" = "1h"): number | null {
  if (!r.usage) return r.iterations?.length ? iterationsCostUsd(r.iterations, cacheTtl) : null;
  const whole = callCostUsd(r.usage, r.model, cacheTtl);
  return r.iterations?.length ? Math.max(whole, iterationsCostUsd(r.iterations, cacheTtl)) : whole;
}

/** Billed attempts of one call at most: the first and its retry (every agent call retries once: REFLEX_CALL, REVIEW_CALL, escalations). */
export const CALL_ATTEMPTS = Math.max(REFLEX_CALL.maxRetries, REVIEW_CALL.maxRetries) + 1;

/** The models that can serve, and bill, a request for `model`: itself and its refusal fallbacks. */
export function servingModels(model: string): string[] {
  return [model, ...(priceFor(model).fallbackModels ?? [])];
}

/** One attempt at its dearest: every input token at the dearest input rate (a 1-hour cache write), every output token used. */
function attemptWorstUsd(p: ModelPrice, inputTokensEst: number, maxTokens: number): number {
  const k = longFactor(p, inputTokensEst);
  const inputRate = Math.max(p.inputPerM, p.cacheWrite1hPerM) * k;
  const outputRate = k === 1 ? p.outputPerM : (p.longOutputPerM ?? p.outputPerM * k);
  return (inputTokensEst * inputRate + maxTokens * outputRate) / 1e6;
}

/**
 * The most one call can cost: `attempts` billed attempts (the first and its retries), each at the dearest model that
 * can serve the request. Two attempts also cover a refusal part-way through an answer followed by its fallback.
 */
export function worstCaseUsd(model: string, inputTokensEst: number, maxTokens: number, attempts: number = CALL_ATTEMPTS): number {
  const one = Math.max(...servingModels(model).map((m) => attemptWorstUsd(priceFor(m), inputTokensEst, maxTokens)));
  return round6(one * Math.max(1, Math.ceil(attempts)));
}

/** True when the worst case still fits under the day's cap (false for anything that is not a number: fail closed). */
export function capAllows(spentUsd: number, worstUsd: number, capUsd: number): boolean {
  return spentUsd + worstUsd <= capUsd + 1e-9;
}

/** Reflex calls in a full session: bar closes every 5 minutes from AGENT_POLICY.reflexFirstBarIst to reflexLastBarIst. */
export const REFLEX_BARS_PER_DAY = (istAt("2026-01-01", AGENT_POLICY.reflexLastBarIst) - istAt("2026-01-01", AGENT_POLICY.reflexFirstBarIst)) / BAR_5M_MS + 1;

/** Reflex calls still to come today: the bar closes from AGENT_POLICY.reflexFirstBarIst to reflexLastBarIst at or after now. */
export function reflexBarsLeft(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return REFLEX_BARS_PER_DAY;
  const date = istDate(nowMs);
  const first = istAt(date, AGENT_POLICY.reflexFirstBarIst);
  const last = istAt(date, AGENT_POLICY.reflexLastBarIst);
  if (!(nowMs <= last)) return 0;
  const next = first + Math.max(0, Math.ceil((nowMs - first) / BAR_5M_MS)) * BAR_5M_MS;
  return Math.floor((last - next) / BAR_5M_MS) + 1;
}

/**
 * The part of the cap kept for the rest of today's reflex calls; an escalation may start only when
 * capAllows(spent + reserve, its worst case, cap). perCallWorstUsd: worstCaseUsd(reflex model, input estimate, REFLEX_CALL.maxTokens).
 */
export function reflexReserveUsd(nowMs: number, perCallWorstUsd: number): number {
  return round6(reflexBarsLeft(nowMs) * perCallWorstUsd);
}
