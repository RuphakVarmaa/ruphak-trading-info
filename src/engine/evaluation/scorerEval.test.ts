import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import { AnthropicLlmClient } from "../events/llm/anthropicClient";
import labelsFile from "./eval/headlines.json";
import { evaluate, scoreLabeled, selfAgreement, spearman, type LabeledCluster } from "./scorerEval";

const labels = labelsFile.items as LabeledCluster[];
const T = istAt("2026-10-07", "10:00");

describe("scorer evaluation metrics", () => {
  it("computes Spearman correlation with ties", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.866, 2);
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it("has a well-formed seed set", () => {
    expect(labels.length).toBeGreaterThanOrEqual(35);
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
    expect(labels.filter((l) => l.expected === 0).length).toBeGreaterThanOrEqual(5);
  });

  it("scores the seed set with the lexicon baseline and leaves noise neutral", async () => {
    const { events } = await scoreLabeled(labels, null, DEFAULT_CONFIG, T);
    const r = evaluate(labels, events);
    // Regression floor only: the lexicon rules were written with this seed set in view, so its
    // score here is in-sample (~0.9). The LLM is judged on the same set plus held-out history.
    expect(r.neutralRate).toBe(1);
    expect(r.directionAccuracy).toBeGreaterThanOrEqual(0.85);
    expect(selfAgreement(events, events)).toBe(1);
  });
});

const runLlm = process.env.RUN_LLM_EVAL === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.runIf(runLlm)("LLM scorer (RUN_LLM_EVAL=1, costs API credits)", () => {
  it("meets the accuracy and neutrality thresholds", async () => {
    const cfg = makeConfig({ llm: { enabled: true, model: process.env.LLM_MODEL || DEFAULT_CONFIG.llm.model } });
    const llm = new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const first = await scoreLabeled(labels, llm, cfg, T);
    expect(first.errors).toEqual([]);
    const r = evaluate(labels, first.events);
    console.log(JSON.stringify({ model: cfg.llm.model, directionAccuracy: r.directionAccuracy, neutralRate: r.neutralRate, misses: r.misses, usage: first.usage }, null, 2));
    expect(r.directionAccuracy).toBeGreaterThanOrEqual(0.65);
    expect(r.neutralRate).toBeGreaterThanOrEqual(0.6);
    if (process.env.RUN_LLM_EVAL_SELF === "1") {
      const second = await scoreLabeled(labels, llm, cfg, T);
      expect(selfAgreement(first.events, second.events)).toBeGreaterThanOrEqual(0.85);
    }
  }, 600_000);
});
