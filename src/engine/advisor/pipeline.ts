/**
 * One advisor run, start to finish: read the engine's inputs and run the web research at the same time, build
 * the context, ask for the brief, then validate and re-price it into an AdvisorReport. The AdvisorDO calls
 * this from its alarm; tests call it with the mock engine and a fake Anthropic client.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorReport } from "../api-types";
import { runAdvice } from "./advise";
import { buildAdvisorContext, DEFAULT_CAPITAL } from "./context";
import { gatherAdvisorInputs, type GatherOptions } from "./gather";
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
  const [inputs, research] = await Promise.all([gatherAdvisorInputs(d.sources, d.calendar, started, d.gather), runResearch(d.client, { model: d.model, nowMs: started })]);
  const context = buildAdvisorContext(inputs, d.calendar, { capital: d.capital ?? DEFAULT_CAPITAL });
  let advice;
  try {
    advice = await runAdvice(d.client, { model: d.model, contextJson: context.promptJson, research });
  } catch (err) {
    throw new AdvisorRunError(`The brief could not be written: the advice call failed (${plainError(err)}).`);
  }
  if (!advice.parsed) throw new AdvisorRunError(`The brief could not be written: ${advice.error ?? "no answer"}`);
  const { report, notes } = buildReport({
    id: d.id,
    nowMs: started,
    model: advice.model || d.model,
    durationMs: now() - started,
    usage: addUsage(research.usage, advice.usage),
    advice: advice.parsed,
    context,
    research,
    capital: d.capital,
  });
  if (!research.ok && research.error) notes.unshift(research.error);
  return { report, notes, research };
}

/** The production client: the Worker's ANTHROPIC_API_KEY, a long timeout (the advice call runs in an alarm). */
export function advisorClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: 240_000, maxRetries: 1 });
}
