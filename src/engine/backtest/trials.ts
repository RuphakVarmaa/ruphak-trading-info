/**
 * Trials ledger: an append-only JSON-lines file (reports/trials.jsonl) with one line per backtest
 * variant, seed and run, so the acceptance protocol can correct for multiple testing — Bonferroni
 * over every trial anyone logged, and the number of trials and Sharpe-ratio variance of the
 * deflated Sharpe ratio. Lines are only ever appended, never rewritten.
 *
 * Pure: the caller supplies the file I/O (the Node scripts), so this module also builds for Workers.
 */

/** What a ledger line records. */
export type TrialKind = "strategy" | "copy-delay" | "perturbation" | "placebo" | "walk-forward";

export interface TrialRecord {
  /** ISO time of the run. */
  ts: string;
  /** Work package or author tag, e.g. "WP0". */
  wp: string;
  /** Variant name. */
  variant: string;
  /** What defines the run: flags and the strategy settings. */
  params: Record<string, unknown>;
  /** The data used: source, snapshot path and hash, range. */
  data: string;
  trades: number;
  /** Net P&L in rupees. */
  net: number;
  notes: string;
  kind?: TrialKind;
  account?: string;
  sessions?: number;
  meanPerTrade?: number;
  /** Sharpe ratio of net P&L per session (not annualized), for the deflated Sharpe ratio. */
  srSession?: number;
}

const STRATEGY_KINDS: ReadonlySet<TrialKind> = new Set(["strategy", "copy-delay", "perturbation", "walk-forward"]);

/** Why a value is not a valid ledger record (empty when it is). */
export function trialProblems(r: unknown): string[] {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return ["not an object"];
  const o = r as Record<string, unknown>;
  const p: string[] = [];
  for (const k of ["ts", "wp", "variant", "data", "notes"]) if (typeof o[k] !== "string") p.push(`${k} must be a string`);
  if (typeof o.ts === "string" && Number.isNaN(Date.parse(o.ts))) p.push("ts must be an ISO time");
  if (typeof o.params !== "object" || o.params === null || Array.isArray(o.params)) p.push("params must be an object");
  for (const k of ["trades", "net"]) if (typeof o[k] !== "number" || !Number.isFinite(o[k])) p.push(`${k} must be a finite number`);
  return p;
}

/** One ledger line (with the trailing newline). Throws on an invalid record: the ledger never takes a bad line. */
export function formatTrial(r: TrialRecord): string {
  const problems = trialProblems(r);
  if (problems.length > 0) throw new Error(`invalid trial record: ${problems.join("; ")}`);
  return `${JSON.stringify(r)}\n`;
}

/** Records in a ledger text; `invalid` counts non-empty lines that are not valid records. */
export function parseTrials(text: string): { records: TrialRecord[]; invalid: number } {
  const records: TrialRecord[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const r: unknown = JSON.parse(line);
      if (trialProblems(r).length === 0) records.push(r as TrialRecord);
      else invalid++;
    } catch {
      invalid++;
    }
  }
  return { records, invalid };
}

/** File access for the ledger: read the whole text (null when missing) and append text. */
export interface LedgerIO {
  read(): string | null;
  append(text: string): void;
}

export interface LedgerStats {
  path: string;
  /** Trials for Bonferroni: every non-empty line (a damaged line still was a trial). */
  n: number;
  valid: number;
  invalid: number;
  byKind: Record<string, number>;
  /** Variance of the per-session Sharpe ratios of the strategy trials (null with fewer than 2). */
  srVariance: number | null;
  srTrials: number;
}

export class TrialLedger {
  constructor(
    private readonly io: LedgerIO,
    readonly path: string,
  ) {}

  /** Appends records as lines, in one write. */
  append(...records: TrialRecord[]): void {
    if (records.length === 0) return;
    this.io.append(records.map(formatTrial).join(""));
  }

  read(): { records: TrialRecord[]; invalid: number } {
    return parseTrials(this.io.read() ?? "");
  }

  stats(): LedgerStats {
    const { records, invalid } = this.read();
    const byKind: Record<string, number> = {};
    for (const r of records) byKind[r.kind ?? "unspecified"] = (byKind[r.kind ?? "unspecified"] ?? 0) + 1;
    const sv = sharpeVariance(records);
    return { path: this.path, n: records.length + invalid, valid: records.length, invalid, byKind, srVariance: sv.variance, srTrials: sv.n };
  }
}

/**
 * Sample variance of the per-session Sharpe ratios of the strategy trials (strategy, copy-delay,
 * perturbation and walk-forward lines; placebo runs are not strategies). Null with fewer than two.
 */
export function sharpeVariance(records: readonly TrialRecord[]): { variance: number | null; n: number } {
  const xs = records.filter((r) => STRATEGY_KINDS.has(r.kind ?? "strategy") && typeof r.srSession === "number" && Number.isFinite(r.srSession)).map((r) => r.srSession!);
  if (xs.length < 2) return { variance: null, n: xs.length };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { variance: xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1), n: xs.length };
}
