/**
 * One advisor run, start to finish: read the engine's inputs and run the web research at the same time, build
 * the context, ask for the brief, re-read the chains its ideas use, then validate and re-price it against
 * those fresh prices into an AdvisorReport. The AdvisorDO calls this from its alarm with an abort signal for
 * its deadline; tests call it with the mock engine and a fake Anthropic client.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorReport } from "../api-types";
import { runAdvice } from "./advise";
import { buildAdvisorContext, DEFAULT_CAPITAL } from "./context";
import { READ_TIMEOUT_MS, gatherAdvisorInputs, refreshCandidates, type GatherOptions } from "./gather";
import { plainError, runResearch, type ResearchResult } from "./research";
import { addUsage, type AdvisorCalendar, type AdvisorSources } from "./types";
import { buildReport } from "./validate";

export interface PipelineDeps {
  sources: AdvisorSources;
  calendar: AdvisorCalendar;
  client: Anthropic;
  model: string;
  id: string;
  now?: () => number;
  capital?: number;
  gather?: GatherOptions;
  /** Aborted when the run is given up (the Durable Object's deadline): the model calls stop paying. */
  signal?: AbortSignal;
}

export interface PipelineResult {
  report: AdvisorReport;
  notes: string[];
  research: ResearchResult;
}

/** A pipeline failure the owner can read ("The brief could not be written: …"). */
export class AdvisorRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorRunError";
  }
}

export async function runAdvisorPipeline(d: PipelineDeps): Promise<PipelineResult> {
  const now = d.now ?? Date.now;
  const started = now();
  const [inputs, research] = await Promise.all([
    gatherAdvisorInputs(d.sources, d.calendar, started, d.gather),
    runResearch(d.client, { model: d.model, nowMs: started, signal: d.signal }),
  ]);
  const context = buildAdvisorContext(inputs, d.calendar, { capital: d.capital ?? DEFAULT_CAPITAL });
  let advice;
  try {
    advice = await runAdvice(d.client, { model: d.model, contextJson: context.promptJson, research, signal: d.signal });
  } catch (err) {
    throw new AdvisorRunError(`The brief could not be written: the advice call failed (${plainError(err)}).`);
  }
  if (!advice.parsed) throw new AdvisorRunError(`The brief could not be written: ${advice.error ?? "no answer"}`);
  if (d.signal?.aborted) throw new AdvisorRunError("The brief could not be written: the run was stopped.");
  // The answer took minutes: check the ideas against prices read now, not the ones the model saw.
  const fresh = await refreshCandidates(
    d.sources,
    context.candidates,
    (advice.parsed.ideas ?? []).map((x) => x.candidateId),
    now,
    d.gather?.timeoutMs ?? READ_TIMEOUT_MS,
  );
  const checkedAt = now();
  const { report, notes } = buildReport({
    id: d.id,
    nowMs: checkedAt,
    model: advice.model || d.model,
    durationMs: checkedAt - started,
    usage: addUsage(research.usage, advice.usage),
    advice: advice.parsed,
    context: { ...context, candidates: fresh.candidates },
    research,
    capital: d.capital,
  });
  for (const idea of report.ideas) {
    const line = fresh.stale.get(`${idea.contract.index}|${idea.contract.expiry}`);
    if (line) idea.engineNotes = [...(idea.engineNotes ?? []), line];
  }
  notes.push(...fresh.notes);
  if (!research.ok && research.error) notes.unshift(research.error);
  return { report, notes, research };
}

/**
 * The production client: the Worker's ANTHROPIC_API_KEY and a long timeout for the research call and for the
 * advice stream to open (both run in an alarm; the DO's deadline aborts them). One retry.
 */
export function advisorClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: 240_000, maxRetries: 1 });
}
