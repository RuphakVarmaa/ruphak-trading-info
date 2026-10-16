/**
 * Reads everything the advisor needs through the same calls EngineAdmin serves (AdvisorSources), with a
 * timeout per read. A failed read becomes null plus a plain line in `errors`; it never stops the brief.
 */
import { outlookExpiries } from "../../lib/options/outlook";
import type { EventClusterView, IndexId, OptionChainView } from "../api-types";
import { ADVISOR_INDICES, NEWS_HOURS, OUTLOOK_DAYS, candidateExpiries } from "./context";
import type { AdvisorCalendar, AdvisorIndexInput, AdvisorInputs, AdvisorSources } from "./types";

export const READ_TIMEOUT_MS = 12_000;
/** Chains read per index (the default one included): about 5 weeklies within 35 days plus a monthly. */
export const MAX_CHAINS_PER_INDEX = 7;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface GatherOptions {
  timeoutMs?: number;
  maxChainsPerIndex?: number;
}

async function gatherIndex(src: AdvisorSources, calendar: AdvisorCalendar, index: IndexId, nowMs: number, errors: string[], o: Required<GatherOptions>): Promise<AdvisorIndexInput> {
  const read = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await withTimeout(f(), o.timeoutMs, what);
    } catch (err) {
      errors.push(`${what}: ${message(err)}`);
      return null;
    }
  };
  const flowP = read(`option flow ${index}`, () => src.getOptionFlow(index));
  const chains: OptionChainView[] = [];
  const first = await read(`option chain ${index}`, () => src.getOptionChain(index));
  let listed: string[] = [];
  if (first) {
    if (first.error) errors.push(`option chain ${index} ${first.expiry}: ${first.error.slice(0, 160)}`);
    chains.push(first);
    listed = [...first.expiries];
  }
  const wanted = [...new Set([...outlookExpiries(listed, nowMs, index, calendar, OUTLOOK_DAYS).map((e) => e.expiry), ...candidateExpiries(listed, nowMs, index, calendar).map((e) => e.expiry)])]
    .filter((e) => !chains.some((c) => c.expiry === e))
    .sort();
  // One at a time: the Upstox budget is shared with the dashboard.
  for (const expiry of wanted.slice(0, Math.max(0, o.maxChainsPerIndex - chains.length))) {
    const c = await read(`option chain ${index} ${expiry}`, () => src.getOptionChain(index, expiry));
    if (!c) continue;
    if (c.error) errors.push(`option chain ${index} ${expiry}: ${c.error.slice(0, 160)}`);
    chains.push(c);
  }
  return { signal: null, flow: await flowP, chains, listed };
}

export async function gatherAdvisorInputs(src: AdvisorSources, calendar: AdvisorCalendar, nowMs: number, opts: GatherOptions = {}): Promise<AdvisorInputs> {
  const o: Required<GatherOptions> = { timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS, maxChainsPerIndex: opts.maxChainsPerIndex ?? MAX_CHAINS_PER_INDEX };
  const errors: string[] = [];
  const read = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await withTimeout(f(), o.timeoutMs, what);
    } catch (err) {
      errors.push(`${what}: ${message(err)}`);
      return null;
    }
  };
  const [indices, signals, events, scheduled, plan, pnl, positions, ...perIndex] = await Promise.all([
    read("index levels", () => src.getLiveIndices()),
    read("signals", () => src.getSignals()),
    read("news", () => src.getEvents({ sinceMs: nowMs - NEWS_HOURS * 3_600_000, limit: 200 })),
    read("scheduled events", () => src.getScheduled(720)),
    read("today's plan", () => src.getTodayPlan()),
    read("paper P&L", () => src.getPnl(1)),
    read("paper positions", () => src.getPositions()),
    ...ADVISOR_INDICES.map((index) => gatherIndex(src, calendar, index, nowMs, errors, o)),
  ]);
  if (indices?.error) errors.push(`index levels: ${indices.error.slice(0, 160)}`);
  const per: AdvisorInputs["perIndex"] = {};
  ADVISOR_INDICES.forEach((index, i) => {
    const input = perIndex[i] as AdvisorIndexInput;
    per[index] = { ...input, signal: signals?.find((s) => s.index === index) ?? null };
  });
  return {
    nowMs,
    indices,
    perIndex: per,
    events: events as EventClusterView[] | null,
    scheduled,
    plan,
    pnl,
    positions,
    errors,
  };
}
