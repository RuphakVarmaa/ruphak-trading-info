import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { FixedClock, HOUR_MS } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import type { ArticleFetcher } from "../events/sources";
import { silentLogger } from "../ports";
import { InMemoryRepository } from "../repo/memory";
import { FakeLlmClient, fakeScore } from "../testing/fakeLlm";
import type { RawArticle } from "../types";
import { runIngestCycle } from "./ingestCycle";
import { runScoringCycle } from "./scoringCycle";

const cfg = DEFAULT_CONFIG;
const calendar = new TradingCalendar();
const T0 = Date.parse("2026-10-07T05:00:00Z"); // 10:30 IST

function fetcher(articles: RawArticle[], name: ArticleFetcher["name"] = "google_rss"): ArticleFetcher {
  return { name, fetch: async () => articles };
}

function art(title: string, minutesAgo: number, url?: string): RawArticle {
  return { source: "google_rss", title, url: url ?? `https://n.example/${encodeURIComponent(title)}`, publishedAt: new Date(T0 - minutesAgo * 60_000).toISOString(), publisher: "Example" };
}

describe("ingest and scoring cycles", () => {
  it("ingests relevant articles, clusters them and scores them with the LLM", async () => {
    const clock = new FixedClock(T0);
    const repo = new InMemoryRepository(cfg, T0);
    const batch = [
      art("RBI hikes repo rate by 25 bps to curb inflation", 30),
      art("RBI raises repo rate by 25 bps; Sensex falls 400 points", 25),
      art("Brent crude jumps 4% after Red Sea tanker attack", 20),
      art("Local bakery wins award for best croissant", 10), // irrelevant, filtered
      art("Old RBI story from last week", 60 * 30), // outside lookback, filtered
    ];
    const ing = await runIngestCycle({ cfg, clock, repo, logger: silentLogger, fetchers: [fetcher(batch), { name: "gdelt", fetch: async () => { throw new Error("429"); } }] });
    expect(ing.relevant).toBe(3);
    expect(ing.clustersCreated).toBe(2);
    expect(ing.errors.gdelt).toBe("429");
    expect(ing.needingScore).toHaveLength(2);
    expect((await repo.state.get<{ ok: boolean }>("health:gdelt"))?.ok).toBe(false);

    // Re-running with the same articles is a no-op.
    const again = await runIngestCycle({ cfg, clock, repo, logger: silentLogger, fetchers: [fetcher(batch)] });
    expect(again.newArticles).toBe(0);

    const llm = new FakeLlmClient((c) =>
      fakeScore(c.cluster_id, c.headlines.some((h) => /crude/i.test(h))
        ? { cluster_key: "red-sea-tanker-attack", taxonomy: "COMMODITY_SHOCK", india_relevance: "INDIRECT", sectors: [{ sector: "OIL_GAS", direction: "BEAR", weight: "HIGH" }] }
        : { cluster_key: "RBI MPC Oct 2026 hike" }),
    );
    const sc = await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm }, { clusterIds: ing.needingScore });
    expect(sc.llmScored).toBe(2);
    expect(sc.fallbackScored).toBe(0);
    expect(sc.usage.cacheReadTokens).toBe(800);
    const events = await repo.events.active(T0 - 48 * HOUR_MS);
    expect(events.map((e) => e.clusterKey).sort()).toEqual(["rbi-mpc-oct-2026-hike", "red-sea-tanker-attack"]);
    expect(sc.pressure.find((p) => p.index === "NIFTY")!.epi).toBeLessThan(0);
    const clusters = await repo.clusters.byIds(ing.needingScore);
    expect(clusters.every((c) => c.status === "SCORED" && c.scoredAtMs === T0)).toBe(true);

    // Redelivery of the same queue message does not rescore.
    const redo = await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm }, { clusterIds: ing.needingScore });
    expect(redo.scored).toBe(0);
    expect(llm.calls).toBe(1);
  });

  it("merges a later cluster into an earlier one when the LLM reuses the story key", async () => {
    const clock = new FixedClock(T0);
    const repo = new InMemoryRepository(cfg, T0);
    const llm = new FakeLlmClient((c) => fakeScore(c.cluster_id, { cluster_key: "iran-israel-strikes", taxonomy: "GEOPOLITICAL" }));
    const a = await runIngestCycle({ cfg, clock, repo, logger: silentLogger, fetchers: [fetcher([art("Iran launches missiles at Israel, oil surges", 10)])] });
    await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm }, { clusterIds: a.needingScore });
    clock.advance(2 * HOUR_MS);
    const b = await runIngestCycle({
      cfg,
      clock,
      repo,
      logger: silentLogger,
      fetchers: [fetcher([{ ...art("Israel vows response after Tehran barrage; crude extends gains", 0), publishedAt: new Date(clock.now() - 60_000).toISOString() }])],
    });
    expect(b.clustersCreated).toBe(1);
    const sc = await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm }, { clusterIds: b.needingScore });
    expect(sc.removed).toBe(1);
    const active = await repo.clusters.active(T0 - HOUR_MS);
    expect(active).toHaveLength(1);
    expect(active[0].articleCount).toBe(2);
    expect(active[0].status).toBe("RESCORE"); // merged story gets scored again with full coverage
    const events = await repo.events.active(T0 - 48 * HOUR_MS);
    expect(events).toHaveLength(1);
    expect(llm.lastUser).toContain("iran-israel-strikes"); // known clusters are offered for key reuse
  });

  it("falls back to lexicon scores when the LLM fails and retries up to three times", async () => {
    const clock = new FixedClock(T0);
    const repo = new InMemoryRepository(cfg, T0);
    const llm = new FakeLlmClient(() => null, { fail: true });
    const ing = await runIngestCycle({ cfg, clock, repo, logger: silentLogger, fetchers: [fetcher([art("Sensex crashes as FII outflows deepen on war fears", 5)])] });
    for (let i = 1; i <= 3; i++) {
      const sc = await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm }, { clusterIds: ing.needingScore });
      expect(sc.fallbackScored).toBe(1);
      const [c] = await repo.clusters.byIds(ing.needingScore);
      expect(c.status).toBe(i < 3 ? "RESCORE" : "SCORED");
    }
    const [e] = await repo.events.byClusterIds(ing.needingScore);
    expect(e.scorer).toBe("fallback");
    expect(e.numeric.NIFTY).toBeLessThan(0);
    expect((await repo.state.get<{ ok: boolean }>("health:claude"))?.ok).toBe(false);
  });

  it("uses lexicon scores without touching an LLM when none is configured", async () => {
    const clock = new FixedClock(T0);
    const repo = new InMemoryRepository(cfg, T0);
    const ing = await runIngestCycle({ cfg, clock, repo, logger: silentLogger, fetchers: [fetcher([art("RBI cuts repo rate, Nifty rallies to record high", 5)])] });
    const sc = await runScoringCycle({ cfg, clock, calendar, repo, logger: silentLogger, llm: null }, { clusterIds: ing.needingScore });
    expect(sc.fallbackScored).toBe(1);
    const [c] = await repo.clusters.byIds(ing.needingScore);
    expect(c.status).toBe("SCORED");
    expect(sc.pressure.find((p) => p.index === "NIFTY")!.epi).toBeGreaterThan(0);
  });
});
