import { describe, expect, it } from "vitest";
import { makeConfig } from "../../config";
import { sample } from "../../repo/contract";
import { FakeLlmClient, fakeScore } from "../../testing/fakeLlm";
import type { LlmRequest } from "../../ports";
import { scoreClusters } from "./scorer";

const ctx = { nowMs: Date.parse("2026-10-15T10:00:00+05:30"), market: { niftyRetTodayPct: 0, sensexRetTodayPct: 0, vix: 14, vixChangePct: 0 }, upcomingEvents: [], knownClusters: [] };

describe("escalation to a second model", () => {
  const big = { nifty: { direction: "BEAR", magnitude: "LARGE", confidence: "HIGH" }, sensex: { direction: "BEAR", magnitude: "LARGE", confidence: "HIGH" } };

  it("re-scores only LARGE/EXTREME stories with the escalation model and keeps its score", async () => {
    const models: string[] = [];
    const llm = new FakeLlmClient((c) => (c.cluster_id === "c1" ? fakeScore(c.cluster_id, big) : fakeScore(c.cluster_id)));
    const orig = llm.structured.bind(llm);
    llm.structured = (<T,>(req: LlmRequest<T>) => {
      models.push(req.model);
      return orig(req);
    }) as typeof llm.structured;
    const cfg = makeConfig({ llm: { enabled: true, model: "claude-sonnet-5-5", escalation: { model: "claude-opus-5-5", effort: "high", maxPerCycle: 4 } } });
    const res = await scoreClusters([sample.cluster("c1"), sample.cluster("c2")], ctx, llm, cfg);
    expect(models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(res.escalated).toBe(1);
    expect(res.events.find((e) => e.clusterId === "c1")?.model).toBe("claude-opus-5-5");
    expect(res.events.find((e) => e.clusterId === "c2")?.model).toBe("claude-sonnet-5-5");
  });

  it("respects the per-cycle cap, is off by default, and keeps the first score when it fails", async () => {
    const all = new FakeLlmClient((c) => fakeScore(c.cluster_id, big));
    const capped = await scoreClusters(["a", "b", "c"].map((id) => sample.cluster(id)), ctx, all, makeConfig({ llm: { enabled: true, escalation: { model: "claude-opus-5-5", effort: "high", maxPerCycle: 2 } } }));
    expect(capped.escalated).toBe(2);
    const off = await scoreClusters([sample.cluster("a")], ctx, new FakeLlmClient((c) => fakeScore(c.cluster_id, big)), makeConfig({ llm: { enabled: true } }));
    expect(off.escalated).toBe(0);
    const failing = new FakeLlmClient((c) => fakeScore(c.cluster_id, big), { fail: (n) => n > 1 });
    const kept = await scoreClusters([sample.cluster("a")], ctx, failing, makeConfig({ llm: { enabled: true, escalation: { model: "claude-opus-5-5", effort: "high", maxPerCycle: 4 } } }));
    expect(kept.escalated).toBe(0);
    expect(kept.llmScored).toBe(1);
  });
});
