/**
 * Scores historical clusters (from bootstrap-events) for backtests.
 *
 *   npm run score-batch -- --dry-run          # request count and token estimate
 *   npm run score-batch -- --lexicon          # free baseline: lexicon scorer only
 *   npm run score-batch -- --submit           # Claude Message Batches API (50% price), same rubric and schema as live
 *   npm run score-batch -- --collect --wait   # poll until the batch ends, then write .cache/events/scored.json
 *
 * Caveat: a model scoring 2026 headlines may know what happened next (hindsight leakage). Treat
 * backtest event edge as optimistic; forward paper trading is the real test.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { defaultCalendar } from "../src/engine/calendar/calendar";
import { HOUR_MS } from "../src/engine/clock";
import { DEFAULT_CONFIG, makeConfig } from "../src/engine/config";
import { scoreFallback } from "../src/engine/events/fallbackScorer";
import { buildDigest, type ScoringContext } from "../src/engine/events/llm/digest";
import { RUBRIC_SYSTEM_PROMPT } from "../src/engine/events/llm/rubric";
import { EventScoreBatchS, type EventScoreBatchOut } from "../src/engine/events/llm/schema";
import { fromLlmScore } from "../src/engine/events/llm/scorer";
import type { ArticleCluster, ScoredEvent } from "../src/engine/types";
import { fail, loadEnvFiles, parseArgs, readJson, sleep, str, writeJson } from "./lib/node";

const CLUSTERS = ".cache/events/clusters.json";
const SCORED = ".cache/events/scored.json";
const BATCH = ".cache/events/batch.json";

interface BatchMeta {
  batchId: string;
  model: string;
  createdMs: number;
  requests: Record<string, string[]>;
}

loadEnvFiles();
const args = parseArgs();
const cfg = makeConfig({ llm: { model: str(args, "model", process.env.LLM_MODEL || DEFAULT_CONFIG.llm.model)! } });
const format = betaZodOutputFormat(EventScoreBatchS);

function loadClusters(): ArticleCluster[] {
  const file = readJson<{ clusters: ArticleCluster[] }>(str(args, "clusters", CLUSTERS)!);
  if (!file?.clusters?.length) fail(`No clusters in ${CLUSTERS}; run npm run bootstrap-events first.`);
  return file.clusters.sort((a, b) => a.firstSeenMs - b.firstSeenMs);
}

function context(batch: ArticleCluster[]): ScoringContext {
  const nowMs = Math.max(...batch.map((c) => c.lastSeenMs));
  return {
    nowMs,
    market: { niftyRetTodayPct: null, sensexRetTodayPct: null, vix: null, vixChangePct: null },
    upcomingEvents: defaultCalendar.scheduledEvents(nowMs, nowMs + 24 * HOUR_MS, { includeExpiries: false }).map((e) => ({ title: e.title, at: e.at, impact: e.impact })),
    knownClusters: [],
  };
}

function batches(clusters: ArticleCluster[]): ArticleCluster[][] {
  const out: ArticleCluster[][] = [];
  for (let i = 0; i < clusters.length; i += cfg.llm.batchSize) out.push(clusters.slice(i, i + cfg.llm.batchSize));
  return out;
}

function mergeScored(events: ScoredEvent[]): string {
  const existing = new Map((readJson<ScoredEvent[]>(SCORED) ?? []).map((e) => [e.clusterId, e]));
  for (const e of events) existing.set(e.clusterId, e);
  return writeJson(SCORED, [...existing.values()].sort((a, b) => a.firstSeenMs - b.firstSeenMs));
}

async function main() {
  if (args.lexicon) {
    const clusters = loadClusters();
    const path = mergeScored(clusters.map((c) => scoreFallback(c, cfg, c.lastSeenMs)));
    console.log(`Lexicon-scored ${clusters.length} clusters -> ${path}`);
    return;
  }

  if (args["dry-run"]) {
    const groups = batches(loadClusters());
    const userChars = groups.reduce((s, b) => s + buildDigest(b, context(b)).length, 0);
    const inTok = Math.round(userChars / 3.5 + (groups.length * RUBRIC_SYSTEM_PROMPT.length) / 3.5);
    console.log(`${groups.length} requests (${cfg.llm.batchSize} clusters each) on ${cfg.llm.model}; ~${inTok.toLocaleString()} input tokens before caching, output ~${(groups.length * 2500).toLocaleString()} tokens.`);
    console.log("Batches are billed at 50% of standard prices; check current pricing before submitting.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) fail("Set ANTHROPIC_API_KEY (env, .env or .dev.vars).");
  const client = new Anthropic({ apiKey });

  if (args.submit) {
    const groups = batches(loadClusters());
    const requests: BatchMeta["requests"] = {};
    const created = await client.messages.batches.create({
      requests: groups.map((b, i) => {
        const id = `b${i}`;
        requests[id] = b.map((c) => c.id);
        return {
          custom_id: id,
          params: {
            model: cfg.llm.model,
            max_tokens: 16_000,
            system: [{ type: "text" as const, text: RUBRIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
            messages: [{ role: "user" as const, content: buildDigest(b, context(b)) }],
            output_config: { format: { type: "json_schema" as const, schema: format.schema }, effort: cfg.llm.effort },
          },
        };
      }),
    });
    writeJson(BATCH, { batchId: created.id, model: cfg.llm.model, createdMs: Date.now(), requests } satisfies BatchMeta);
    console.log(`Submitted batch ${created.id} with ${groups.length} requests (status ${created.processing_status}). Collect with: npm run score-batch -- --collect --wait`);
    return;
  }

  if (args.collect) {
    const meta = readJson<BatchMeta>(BATCH);
    if (!meta) fail(`No ${BATCH}; submit a batch first.`);
    for (;;) {
      const b = await client.messages.batches.retrieve(meta.batchId);
      if (b.processing_status === "ended") break;
      if (!args.wait) fail(`Batch ${meta.batchId} is ${b.processing_status} (${b.request_counts.processing} processing). Re-run with --wait to poll.`);
      console.log(`Batch ${b.processing_status}: ${b.request_counts.succeeded} done, ${b.request_counts.processing} processing...`);
      await sleep(60_000);
    }
    const clusters = new Map(loadClusters().map((c) => [c.id, c]));
    const events: ScoredEvent[] = [];
    let ok = 0;
    let failed = 0;
    for await (const r of await client.messages.batches.results(meta.batchId)) {
      const ids = meta.requests[r.custom_id] ?? [];
      const scored = new Set<string>();
      if (r.result.type === "succeeded") {
        const text = r.result.message.content.find((c) => c.type === "text")?.text ?? "";
        try {
          const parsed = format.parse(text) as EventScoreBatchOut;
          for (const s of parsed.scores) {
            const c = clusters.get(s.cluster_id);
            if (!c || !ids.includes(c.id) || scored.has(c.id)) continue;
            events.push(fromLlmScore(s, c, cfg, r.result.message.model, c.lastSeenMs));
            scored.add(c.id);
          }
          ok++;
        } catch (err) {
          failed++;
          console.log(`${r.custom_id}: unparseable output (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
        }
      } else {
        failed++;
        console.log(`${r.custom_id}: ${r.result.type}`);
      }
      // Clusters the model skipped get lexicon scores so the backtest still sees them.
      for (const id of ids) {
        const c = clusters.get(id);
        if (c && !scored.has(id)) events.push(scoreFallback(c, cfg, c.lastSeenMs));
      }
    }
    const path = mergeScored(events);
    console.log(`${ok} requests parsed, ${failed} failed; ${events.length} scored events -> ${path}`);
    return;
  }

  fail("Choose one of --dry-run, --lexicon, --submit, --collect [--wait].");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
