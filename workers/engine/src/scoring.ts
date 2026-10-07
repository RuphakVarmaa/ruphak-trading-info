/**
 * Queue consumer for `events-to-score`: one Claude call per batch of up to 10 clusters
 * (structured outputs, cached rubric), lexicon fallback when the LLM is unavailable or the
 * daily token budget is spent, then a nudge to the trading DO. The dead-letter queue is
 * consumed with the lexicon scorer only, so no story is ever left unscored.
 */
import { DAY_MS, istDate } from "../../../src/engine/clock";
import { llmUsageKey, type LlmUsageDay } from "../../../src/engine/api/readModel";
import { runScoringCycle } from "../../../src/engine/pipeline/scoringCycle";
import { systemClock } from "../../../src/engine/clock";
import type { LlmClient } from "../../../src/engine/ports";
import type { ScoreMessage } from "./do/IngestDO";
import { errorMessage, llmClient, makeRuntime, type Runtime } from "./runtime";
import { Alerts } from "./telegram";

const EMPTY_USAGE: LlmUsageDay = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0, clustersScored: 0 };

function budget(env: Env): { input: number; output: number } {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { input: n(env.LLM_DAILY_INPUT_TOKEN_BUDGET, 3_000_000), output: n(env.LLM_DAILY_OUTPUT_TOKEN_BUDGET, 600_000) };
}

/** The LLM client to use now, or null (no key, disabled, or today's budget spent). */
async function llmForToday(rt: Runtime, alerts: Alerts): Promise<LlmClient | null> {
  if (!rt.cfg.llm.enabled) return null;
  const usage = (await rt.repo.state.get<LlmUsageDay>(llmUsageKey(istDate(Date.now())))) ?? EMPTY_USAGE;
  const b = budget(rt.env);
  if (usage.inputTokens >= b.input || usage.outputTokens >= b.output) {
    await alerts.send(`⚠ LLM daily token budget spent (in ${usage.inputTokens}/${b.input}, out ${usage.outputTokens}/${b.output}); lexicon scoring until midnight IST`, {
      key: `llm-budget:${istDate(Date.now())}`,
      minIntervalMs: DAY_MS,
    });
    return null;
  }
  return llmClient(rt.env);
}

export async function consumeScoreBatch(batch: MessageBatch<ScoreMessage>, env: Env): Promise<void> {
  const rt = makeRuntime(env, "score");
  const alerts = new Alerts(env, rt.repo.state, rt.logger);
  const deadLetter = batch.queue.endsWith("-dlq");
  const ids = [...new Set(batch.messages.map((m) => m.body?.clusterId).filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) {
    batch.ackAll();
    return;
  }
  try {
    const llm = deadLetter ? null : await llmForToday(rt, alerts);
    const report = await runScoringCycle({ cfg: rt.cfg, clock: systemClock, calendar: rt.calendar, repo: rt.repo, logger: rt.logger, llm }, { clusterIds: ids, limit: ids.length });
    if (llm || report.llmScored > 0) {
      const key = llmUsageKey(istDate(Date.now()));
      const u = (await rt.repo.state.get<LlmUsageDay>(key)) ?? { ...EMPTY_USAGE };
      await rt.repo.state.set<LlmUsageDay>(key, {
        inputTokens: u.inputTokens + report.usage.inputTokens + report.usage.cacheCreationTokens,
        outputTokens: u.outputTokens + report.usage.outputTokens,
        cacheReadTokens: u.cacheReadTokens + report.usage.cacheReadTokens,
        calls: u.calls + (report.llmScored > 0 || report.errors.length > 0 ? 1 : 0),
        clustersScored: u.clustersScored + report.scored,
      });
    } else if (report.scored > 0) {
      const key = llmUsageKey(istDate(Date.now()));
      const u = (await rt.repo.state.get<LlmUsageDay>(key)) ?? { ...EMPTY_USAGE };
      await rt.repo.state.set<LlmUsageDay>(key, { ...u, clustersScored: u.clustersScored + report.scored });
    }
    batch.ackAll();
    if (report.scored > 0) {
      await env.ENGINE_DO.get(env.ENGINE_DO.idFromName("engine")).onNewScores(report.scored);
    }
  } catch (err) {
    rt.logger.error("scoring batch failed", { error: errorMessage(err), clusters: ids.length, deadLetter });
    // Retry later (rate limits / 5xx); after max_retries the messages land in the DLQ.
    batch.retryAll({ delaySeconds: 120 });
  }
}
