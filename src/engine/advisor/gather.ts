/**
 * Reads everything the advisor needs through the same calls EngineAdmin serves (AdvisorSources), with a
 * timeout per read. A failed read becomes null plus a plain line in `errors`; it never stops the brief.
 * After the model answers, refreshCandidates re-reads the chains its ideas use, so they are checked against
 * fresh prices rather than the ones read minutes earlier.
 */
import { outlookExpiries } from "../../lib/options/outlook";
import type { EventClusterView, IndexId, OptionChainView } from "../api-types";
import { ADVISOR_INDICES, NEWS_HOURS, OUTLOOK_DAYS, candidateExpiries, chainCandidates } from "./context";
import type { AdvisorCalendar, AdvisorCandidate, AdvisorIndexInput, AdvisorInputs, AdvisorSources } from "./types";

export const READ_TIMEOUT_MS = 12_000;
/** Chains read per index (the default one included): about 5 weeklies within 35 days plus a monthly. */
export const MAX_CHAINS_PER_INDEX = 7;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
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

export interface RefreshResult {
  /** The candidates, with those of each re-read expiry replaced by fresh ones (same ids). */
  candidates: AdvisorCandidate[];
  /** Plain lines for the log ("NIFTY 2026-10-20: checked against the 12:38 prices (…)"). */
  notes: string[];
  /** Per "INDEX|expiry" whose re-read failed: the line to put on that expiry's ideas. */
  stale: Map<string, string>;
}

const expiryKey = (c: Pick<AdvisorCandidate, "index" | "expiry">) => `${c.index}|${c.expiry}`;

/**
 * Re-reads, one at a time (the Upstox budget is shared), the chain of every (index, expiry) the given
 * candidate ids use, and rebuilds those candidates from it. Only contracts already on the list are replaced:
 * one the fresh chain has no price for gets price 0 (the idea is then dropped for "no live price"). A failed
 * re-read keeps the earlier prices and says so.
 */
export async function refreshCandidates(
  src: Pick<AdvisorSources, "getOptionChain">,
  candidates: readonly AdvisorCandidate[],
  ids: readonly string[],
  now: () => number,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<RefreshResult> {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const wanted = new Map<string, AdvisorCandidate>();
  for (const id of ids) {
    const c = byId.get(id);
    if (c && !wanted.has(expiryKey(c))) wanted.set(expiryKey(c), c);
  }
  const replaced = new Map<string, AdvisorCandidate>();
  const notes: string[] = [];
  const stale = new Map<string, string>();
  for (const [key, rep] of wanted) {
    const what = `option chain ${rep.index} ${rep.expiry}`;
    let chain: OptionChainView | null = null;
    let why: string | null = null;
    try {
      chain = await withTimeout(src.getOptionChain(rep.index, rep.expiry), timeoutMs, what);
    } catch (err) {
      why = message(err);
    }
    if (chain && chain.expiry !== rep.expiry) why = `the chain came back for ${chain.expiry}`;
    else if (chain?.error) why = chain.error.replace(/\s+/g, " ").slice(0, 160);
    // Every strike of the fresh chain: the index may have moved the ATM away from the idea's strike.
    const fresh = chain && why == null ? chainCandidates(chain, rep.expiryKind, rep.monthly, now(), chain.rows.length) : [];
    if (!chain || fresh.length === 0) {
      const line = `checked against the ${rep.asOf.slice(11, 16)} prices (the re-read after the brief failed: ${why ?? "no prices"})`;
      stale.set(key, line);
      notes.push(`${rep.index} ${rep.expiry}: ${line}`);
      continue;
    }
    const freshById = new Map(fresh.map((c) => [c.id, c]));
    for (const c of candidates) {
      if (expiryKey(c) !== key) continue;
      replaced.set(c.id, freshById.get(c.id) ?? { ...c, bid: null, ask: null, ltp: null, price: 0, asOf: chain.fetchedAt });
    }
  }
  return { candidates: candidates.map((c) => replaced.get(c.id) ?? c), notes, stale };
}
