import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import type { LlmUsage } from "../ports";
import { AGENT_DEFAULTS } from "./config";
import { REFLEX_CALL } from "./constants";
import {
  CALL_ATTEMPTS,
  MODEL_PRICES,
  REFLEX_BARS_PER_DAY,
  callCostUsd,
  capAllows,
  isPricedModel,
  iterationsCostUsd,
  priceFor,
  reflexBarsLeft,
  reflexReserveUsd,
  responseCostUsd,
  servingModels,
  worstCaseUsd,
} from "./cost";

const REFLEX = AGENT_DEFAULTS.reflexModel;
const DEEP = AGENT_DEFAULTS.escalationModel;
const FALLBACKS = priceFor(DEEP).fallbackModels ?? [];
const UNKNOWN = "not-a-listed-model";
const u = (p: Partial<LlmUsage> = {}): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...p });
const at = (hhmm: string) => istAt("2026-10-19", hhmm);

describe("the price table", () => {
  it("prices the reflex model at the skill's rates, with the long card above 100K tokens", () => {
    expect(priceFor(REFLEX)).toEqual({ inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWrite5mPerM: 0.125, cacheWrite1hPerM: 0.2, longAbove: 100_000, longInputPerM: 0.5, longOutputPerM: 2.5 });
    expect(priceFor(REFLEX).fallbackModels).toBeUndefined();
  });

  it("prices the deep model and the two models its refusals can fall back to", () => {
    expect(priceFor(DEEP)).toMatchObject({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8 });
    expect(FALLBACKS).toHaveLength(2);
    for (const m of FALLBACKS) {
      expect(isPricedModel(m)).toBe(true);
      expect(priceFor(m)).toMatchObject({ inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 });
    }
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([REFLEX, DEEP, ...FALLBACKS].sort());
    expect(servingModels(DEEP)).toEqual([DEEP, ...FALLBACKS]);
    expect(servingModels(REFLEX)).toEqual([REFLEX]);
  });

  it("prices an unknown model at the highest rate of every kind, and a dated snapshot at its own row", () => {
    expect(isPricedModel(UNKNOWN)).toBe(false);
    expect(priceFor(UNKNOWN)).toEqual({ inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 });
    for (const m of Object.keys(MODEL_PRICES)) {
      const p = priceFor(m);
      expect(priceFor(UNKNOWN).outputPerM).toBeGreaterThanOrEqual(p.outputPerM);
      expect(priceFor(UNKNOWN).cacheWrite1hPerM).toBeGreaterThanOrEqual(p.cacheWrite1hPerM);
    }
    expect(priceFor(`${REFLEX}-20261001`)).toBe(priceFor(REFLEX));
    expect(isPricedModel(`${REFLEX}-extra`)).toBe(false);
    for (const odd of ["constructor", "__proto__", "toString", ""]) expect(priceFor(odd)).toEqual(priceFor(UNKNOWN));
  });
});

describe("callCostUsd", () => {
  it("prices a typical reflex call (SPEC §8.1: about $0.00078)", () => {
    expect(callCostUsd(u({ inputTokens: 1_700, outputTokens: 1_200, cacheReadTokens: 1_300 }), REFLEX)).toBe(0.000783);
  });

  it("prices cache writes at the 1-hour rate unless told the 5-minute one", () => {
    expect(callCostUsd(u({ cacheCreationTokens: 2_000 }), REFLEX)).toBe(0.0004);
    expect(callCostUsd(u({ cacheCreationTokens: 2_000 }), REFLEX, "5m")).toBe(0.00025);
    expect(callCostUsd(u({ inputTokens: 4_500, outputTokens: 3_000, cacheCreationTokens: 1_500 }), DEEP)).toBe(0.09);
    expect(callCostUsd(u({ cacheReadTokens: 10_000 }), DEEP)).toBe(0.002);
  });

  it("uses the long card when the whole prompt is above 100K tokens", () => {
    // 90K input + 20K cache read = 110K: input $0.50, cache read $0.05, output $2.50 per million.
    expect(callCostUsd(u({ inputTokens: 90_000, cacheReadTokens: 20_000, outputTokens: 1_000 }), REFLEX)).toBe(0.0485);
    // Exactly 100K stays on the normal card.
    expect(callCostUsd(u({ inputTokens: 100_000, outputTokens: 1_000 }), REFLEX)).toBe(0.0105);
  });

  it("never under-counts an unknown model and ignores nonsense token counts", () => {
    expect(callCostUsd(u({ inputTokens: 1_000_000 }), UNKNOWN)).toBe(5);
    expect(callCostUsd(u({ outputTokens: 1_000_000 }), UNKNOWN)).toBe(25);
    expect(callCostUsd(u({ inputTokens: -5, outputTokens: Number.NaN }), DEEP)).toBe(0);
  });
});

describe("usage.iterations", () => {
  const declined = { model: DEEP, usage: u({ inputTokens: 10_000, outputTokens: 2_000 }) };
  const served = { model: FALLBACKS[0], usage: u({ inputTokens: 10_000, outputTokens: 3_000 }) };

  it("prices each attempt at the model that ran it", () => {
    // 10K × $4 + 2K × $20 = $0.08; 10K × $5 + 3K × $25 = $0.125.
    expect(iterationsCostUsd([declined, served])).toBe(0.205);
  });

  it("prices a response from its attempts, never below its usage at the answering model", () => {
    const whole = u({ inputTokens: 20_000, outputTokens: 5_000 });
    expect(responseCostUsd({ usage: whole, model: FALLBACKS[0], iterations: [declined, served] })).toBe(0.225);
    expect(responseCostUsd({ usage: served.usage, model: FALLBACKS[0], iterations: [declined, served] })).toBe(0.205);
    expect(responseCostUsd({ usage: served.usage, model: FALLBACKS[0] })).toBe(0.125);
    expect(responseCostUsd({ usage: null, model: DEEP })).toBeNull();
    expect(responseCostUsd({ usage: null, model: DEEP, iterations: [declined] })).toBe(0.08);
  });
});

describe("the worst case", () => {
  it("counts the retry: two billed attempts by default", () => {
    expect(CALL_ATTEMPTS).toBe(2);
    // Reflex: 6,000 input tokens at the 1-hour write rate ($0.20) + 4,096 output at $0.50, twice.
    expect(worstCaseUsd(REFLEX, 6_000, REFLEX_CALL.maxTokens)).toBe(0.006496);
    expect(worstCaseUsd(REFLEX, 6_000, REFLEX_CALL.maxTokens, 1)).toBe(0.003248);
  });

  it("prices the deep model at the dearest model that can serve it", () => {
    // 6,000 input at $10 + 8,000 output at $25 = $0.26 an attempt (the fallback rows), not $0.208 (the deep model's own).
    expect(worstCaseUsd(DEEP, 6_000, 8_000)).toBe(0.52);
    expect(worstCaseUsd(DEEP, 6_000, 8_000)).toBeGreaterThan(2 * (6_000 * 8 + 8_000 * 20) / 1e6);
    // The streamed review: 20,000 input, 32,000 output.
    expect(worstCaseUsd(DEEP, 20_000, 32_000)).toBe(2);
    expect(worstCaseUsd(UNKNOWN, 6_000, 8_000)).toBe(0.52);
  });

  it("uses the long card for a long prompt", () => {
    expect(worstCaseUsd(REFLEX, 200_000, 1_000, 1)).toBe(0.2025);
  });

  it("is never below what the same call can be billed", () => {
    const usage = u({ inputTokens: 4_000, cacheCreationTokens: 2_000, outputTokens: REFLEX_CALL.maxTokens });
    expect(worstCaseUsd(REFLEX, 6_000, REFLEX_CALL.maxTokens, 1)).toBeGreaterThanOrEqual(callCostUsd(usage, REFLEX));
  });
});

describe("capAllows", () => {
  it("allows a call only when the worst case fits under the cap", () => {
    expect(capAllows(2.5, 0.5, 3)).toBe(true);
    expect(capAllows(2.5, 0.51, 3)).toBe(false);
    expect(capAllows(0, 0, 0)).toBe(true);
    expect(capAllows(0, 0.001, 0)).toBe(false);
  });

  it("fails closed on anything that is not a number", () => {
    expect(capAllows(Number.NaN, 0.1, 3)).toBe(false);
    expect(capAllows(0, Number.NaN, 3)).toBe(false);
    expect(capAllows(0, 0.1, Number.NaN)).toBe(false);
  });
});

describe("the reflex reserve", () => {
  it("counts the reflex calls still to come today", () => {
    expect(REFLEX_BARS_PER_DAY).toBe(70);
    expect(reflexBarsLeft(at("09:00"))).toBe(70);
    expect(reflexBarsLeft(at("09:20"))).toBe(70);
    expect(reflexBarsLeft(at("09:20") + 1_000)).toBe(69);
    expect(reflexBarsLeft(at("10:35"))).toBe(55);
    expect(reflexBarsLeft(at("10:35") + 40_000)).toBe(54);
    expect(reflexBarsLeft(at("15:05"))).toBe(1);
    expect(reflexBarsLeft(at("15:05") + 1)).toBe(0);
    expect(reflexBarsLeft(at("16:20"))).toBe(0);
    expect(reflexBarsLeft(Number.NaN)).toBe(70);
  });

  it("keeps the rest of the day's reflex worst case out of an escalation's reach", () => {
    const perCall = worstCaseUsd(REFLEX, 6_000, REFLEX_CALL.maxTokens);
    const now = at("10:00") + 40_000;
    const reserve = reflexReserveUsd(now, perCall);
    expect(reserve).toBe(Math.round(61 * perCall * 1e6) / 1e6);
    const escalation = worstCaseUsd(DEEP, 6_000, 8_000);
    expect(capAllows(0.5 + reserve, escalation, 3)).toBe(true);
    // At $2.20 spent the escalation would eat into the reflex's share, while one more reflex call still fits.
    expect(capAllows(2.2 + reserve, escalation, 3)).toBe(false);
    expect(capAllows(2.2, perCall, 3)).toBe(true);
    expect(reflexReserveUsd(at("15:30"), perCall)).toBe(0);
  });
});
