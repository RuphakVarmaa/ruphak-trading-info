/**
 * WP14 research helpers (reports/wp14-positioning.md; research only, nothing in the live engine
 * imports this): NSE's participant-wise open-interest file, the positioning ratios built from it, a
 * trailing percentile rank and its extreme buckets, a circular block bootstrap for overlapping
 * holding-period returns, runs of a condition, and the Wilson interval of a hit rate. Every
 * definition is frozen in the report's §1.
 *
 * Pure and web-standard (no node: imports), like intraday1m.ts and expiryCalendar.ts.
 */
import { seededRandom, type BootstrapStat } from "./metrics";
import { percentileRank, quantile, stdev } from "../util/math";

// ---------------------------------------------------------------------------
// The participant-wise open-interest file
// ---------------------------------------------------------------------------

/** The four participant categories of the file, plus its TOTAL row. */
export const PARTICIPANTS = ["Client", "DII", "FII", "Pro"] as const;
export type Participant = (typeof PARTICIPANTS)[number];
export type OiRowLabel = Participant | "TOTAL";

/** One row of the file: open contracts (not lots, not notional) by instrument and side. */
export interface OiRow {
  futIdxLong: number;
  futIdxShort: number;
  futStkLong: number;
  futStkShort: number;
  optIdxCallLong: number;
  optIdxPutLong: number;
  optIdxCallShort: number;
  optIdxPutShort: number;
  optStkCallLong: number;
  optStkPutLong: number;
  optStkCallShort: number;
  optStkPutShort: number;
  totalLong: number;
  totalShort: number;
}

const COLUMNS: Record<string, keyof OiRow> = {
  "future index long": "futIdxLong",
  "future index short": "futIdxShort",
  "future stock long": "futStkLong",
  "future stock short": "futStkShort",
  "option index call long": "optIdxCallLong",
  "option index put long": "optIdxPutLong",
  "option index call short": "optIdxCallShort",
  "option index put short": "optIdxPutShort",
  "option stock call long": "optStkCallLong",
  "option stock put long": "optStkPutLong",
  "option stock call short": "optStkCallShort",
  "option stock put short": "optStkPutShort",
  "total long contracts": "totalLong",
  "total short contracts": "totalShort",
};
const FIELDS = Object.values(COLUMNS);

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export interface ParticipantOi {
  /** The "as on" date of the title row (YYYY-MM-DD), null when it cannot be read. */
  asOf: string | null;
  /** The first header cell as written ("CLIENT_TYPE" or "Client Type"). */
  firstHeader: string;
  /** Row labels in file order, as written (trimmed). */
  order: string[];
  rows: Partial<Record<OiRowLabel, OiRow>>;
  /** Why the file is not a complete, consistent report (empty when it is). */
  problems: string[];
  /** Totals that miss by a rounding amount (at most SUM_TOLERANCE of the total, or 10 contracts): reported, not disqualifying. */
  warnings: string[];
}

/** Largest relative gap between the categories' sum and TOTAL that counts as rounding (0.01%). */
export const SUM_TOLERANCE = 1e-4;

const norm = (s: string) => s.replace(/^"+|"+$/g, "").trim().replace(/\s+/g, " ").toLowerCase();

/** The row label as one of the file's categories ("FII" and "FPI" are the same category), else null. */
export function rowLabel(raw: string): OiRowLabel | null {
  const s = norm(raw).replace(/[^a-z]/g, "");
  if (s === "client") return "Client";
  if (s === "dii") return "DII";
  if (s === "fii" || s === "fpi") return "FII";
  if (s === "pro") return "Pro";
  if (s === "total") return "TOTAL";
  return null;
}

/** Reads "... as on Oct 08, 2026" / "as on January 02, 2012" / "as on Jan 06,2020" / "as on Jan 02 2020" into YYYY-MM-DD. */
export function titleDate(title: string): string | null {
  const m = /as on\s+([A-Za-z]+)\.?\s*(\d{1,2})\s*,?\s*(\d{4})/i.exec(title.replace(/"/g, ""));
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Splits one CSV line, honouring double quotes (a doubled quote inside quotes is a literal quote). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * One contract count as written: "307664", "2,38,483.00" (Indian digit grouping, 20 Jan 2012), a
 * fraction ("679462.5846": stock futures on 28 Mar and 12 Jul 2012, presumably contracts adjusted for a
 * corporate action) or "NA" (no position, 3 Jan 2012: the TOTAL row counts it as 0). NaN for anything
 * else, including an empty cell or a negative number.
 */
export function parseCount(raw: string): { value: number; na: boolean; fractional: boolean } {
  const s = raw.trim().replace(/,/g, "");
  if (s.toUpperCase() === "NA") return { value: 0, na: true, fractional: false };
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: NaN, na: false, fractional: false };
  const value = Number(s);
  return { value, na: false, fractional: !Number.isInteger(value) };
}

/** The index futures and index options columns: the ones the positioning signals read. */
export const INDEX_COLUMNS: readonly (keyof OiRow)[] = ["futIdxLong", "futIdxShort", "optIdxCallLong", "optIdxPutLong", "optIdxCallShort", "optIdxPutShort"];

/**
 * Parses one fao_participant_oi_DDMMYYYY.csv: the title row, the header row (columns are matched by
 * name, so a reordering is harmless) and the Client, DII, FII, Pro and TOTAL rows. Checks that every
 * category is present once, every number is a non-negative count (a fraction is a warning), the four
 * categories add up to TOTAL in every column, and TOTAL longs equal TOTAL shorts column by column
 * (every contract has two sides). A sum that misses by a rounding amount is a warning; a larger miss
 * is a problem in the `strict` columns (default: every column) and a warning in the others (e.g. the
 * miscomputed "Total Long/Short Contracts" of five 2016–2017 files). "NA" reads as 0 with a warning
 * (the TOTAL checks then confirm or reject it).
 */
export function parseParticipantOi(text: string, o: { strict?: readonly (keyof OiRow)[] } = {}): ParticipantOi {
  // Line ends are CRLF, LF or (4 Oct 2017) a bare CR.
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.replace(/[,"\s]/g, "") !== "");
  const problems: string[] = [];
  const warnings: string[] = [];
  const out: ParticipantOi = { asOf: null, firstHeader: "", order: [], rows: {}, problems, warnings };
  const strict = new Set<keyof OiRow>(o.strict ?? FIELDS);
  const rounding = (diff: number, total: number) => Math.abs(diff) <= Math.max(10, SUM_TOLERANCE * Math.abs(total));
  const sink = (diff: number, total: number, ...cols: (keyof OiRow)[]) => (rounding(diff, total) ? warnings : cols.some((c) => strict.has(c)) ? problems : warnings);
  if (lines.length < 2) {
    problems.push("fewer than two lines");
    return out;
  }
  // The title row comes first; two files (17 Jul 2014, 13 Jun 2018) start at the header row instead.
  const titled = !splitCsvLine(lines[0]).some((c) => COLUMNS[norm(c)] !== undefined);
  if (titled) {
    out.asOf = titleDate(lines[0]);
    // A few titles lose the year ("as on Jun 08,,,"); the file name still dates the file.
    if (out.asOf === null) warnings.push("no full 'as on' date in the title row");
  } else warnings.push("no title row");
  const header = splitCsvLine(lines[titled ? 1 : 0]);
  out.firstHeader = header[0].trim();
  const idx = new Map<keyof OiRow, number>();
  header.forEach((h, i) => {
    const f = COLUMNS[norm(h)];
    if (f) idx.set(f, i);
  });
  for (const f of FIELDS) if (!idx.has(f)) problems.push(`missing column ${f}`);
  let na = 0;
  let fractional = 0;
  for (const line of lines.slice(titled ? 2 : 1)) {
    const cells = splitCsvLine(line);
    const label = rowLabel(cells[0] ?? "");
    out.order.push((cells[0] ?? "").trim());
    if (label === null) {
      problems.push(`unknown row "${(cells[0] ?? "").trim()}"`);
      continue;
    }
    if (out.rows[label]) {
      problems.push(`duplicate row ${label}`);
      continue;
    }
    const row = {} as OiRow;
    let ok = true;
    for (const f of FIELDS) {
      const i = idx.get(f);
      const c = parseCount(i === undefined ? "" : (cells[i] ?? ""));
      if (!Number.isFinite(c.value)) ok = false;
      if (c.na) na++;
      if (c.fractional) fractional++;
      row[f] = c.value;
    }
    if (!ok) problems.push(`non-numeric value in row ${label}`);
    out.rows[label] = row;
  }
  if (na) warnings.push(`${na} "NA" cells read as 0`);
  if (fractional) warnings.push(`${fractional} fractional contract counts`);
  for (const p of [...PARTICIPANTS, "TOTAL"] as const) if (!out.rows[p]) problems.push(`missing row ${p}`);
  const total = out.rows.TOTAL;
  if (total && PARTICIPANTS.every((p) => out.rows[p])) {
    for (const f of FIELDS) {
      const s = PARTICIPANTS.reduce((a, p) => a + out.rows[p]![f], 0);
      if (s !== total[f]) sink(s - total[f], total[f], f).push(`${f}: categories add to ${s}, TOTAL ${total[f]}`);
    }
    // Every open contract has a long and a short side, so TOTAL longs equal TOTAL shorts column by column
    // (with the sums above, this is also "net calls and net puts across the four categories add to zero").
    for (const [l, s] of BALANCED) if (total[l] !== total[s]) sink(total[l] - total[s], total[l], l, s).push(`TOTAL ${l} ${total[l]} ≠ ${s} ${total[s]}`);
  }
  return out;
}

const BALANCED: readonly [keyof OiRow, keyof OiRow][] = [
  ["futIdxLong", "futIdxShort"],
  ["futStkLong", "futStkShort"],
  ["optIdxCallLong", "optIdxCallShort"],
  ["optIdxPutLong", "optIdxPutShort"],
  ["optStkCallLong", "optStkCallShort"],
  ["optStkPutLong", "optStkPutShort"],
  ["totalLong", "totalShort"],
];

/**
 * The FII and DII rows appear to carry each other's labels: the row labelled FII has no index-option
 * shorts while the row labelled DII has some. FIIs always write index options; DIIs wrote none in the
 * files of 2012–2025, so this flags the 2 Jan 2012 file (R5 §3.2). A flagged file is excluded, never
 * relabelled.
 */
export function fiiDiiLabelsSwapped(fii: Pick<OiRow, "optIdxCallShort" | "optIdxPutShort">, dii: Pick<OiRow, "optIdxCallShort" | "optIdxPutShort">): boolean {
  return fii.optIdxCallShort + fii.optIdxPutShort === 0 && dii.optIdxCallShort + dii.optIdxPutShort > 0;
}

// ---------------------------------------------------------------------------
// Positioning ratios
// ---------------------------------------------------------------------------

/** long / (long + short); null when both are zero. */
export function longShare(long: number, short: number): number | null {
  const d = long + short;
  return d > 0 ? long / d : null;
}

/**
 * Net directional index-options position: [(call long − call short) − (put long − put short)] ÷
 * (call long + call short + put long + put short), in [−1, 1]; null when the four are zero.
 * Long calls and short puts count as bullish, short calls and long puts as bearish.
 */
export function optionsNetDirection(r: Pick<OiRow, "optIdxCallLong" | "optIdxCallShort" | "optIdxPutLong" | "optIdxPutShort">): number | null {
  const d = r.optIdxCallLong + r.optIdxCallShort + r.optIdxPutLong + r.optIdxPutShort;
  return d > 0 ? (r.optIdxCallLong - r.optIdxCallShort - (r.optIdxPutLong - r.optIdxPutShort)) / d : null;
}

// ---------------------------------------------------------------------------
// Trailing percentile rank and extreme buckets
// ---------------------------------------------------------------------------

/**
 * Percentile rank (0..1) of each value within the `window` most recent values up to and including it
 * (nulls are skipped, so the window counts readings, not calendar days): the share of the window
 * strictly below plus half the share equal (the value itself counts as one tie). Null for a null
 * value or before `window` readings exist. Uses only the past and the present value.
 */
export function trailingRank(values: readonly (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  const recent: number[] = [];
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) {
      out.push(null);
      continue;
    }
    recent.push(v);
    if (recent.length > window) recent.shift();
    out.push(recent.length === window ? percentileRank(recent, v) / 100 : null);
  }
  return out;
}

/** −1 below the bottom 1/q of ranks, +1 above the top 1/q, 0 in between (q = 3 terciles, 4 quartiles, 5 quintiles). */
export function extremeBucket(rank: number, q: number): -1 | 0 | 1 {
  if (rank < 1 / q) return -1;
  if (rank > 1 - 1 / q) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Circular block bootstrap (overlapping holding periods)
// ---------------------------------------------------------------------------

export interface SeriesBootstrap {
  resamples: number;
  block: number;
  seed: number;
  level: number;
  sessions: number;
  trades: number;
  /** Mean of x over the trade sessions. */
  perTrade: BootstrapStat;
  /** Mean of x over every session (sessions without a trade are 0). */
  perSession: BootstrapStat;
  emptyResamples: number;
}

/**
 * Circular block bootstrap (Politis & Romano 1992) of a session-ordered series: each resample joins
 * ⌈n / block⌉ blocks of `block` consecutive sessions, each starting at a uniform session and wrapping
 * past the end, cut to n sessions. `x[i]` is session i's value (a trade's return, 0 without a
 * trade) and `trade[i]` whether it held a trade. With block ≥ the holding period, the overlap of
 * consecutive holding periods stays inside the blocks. block = 1 is the day-block bootstrap.
 * Percentile intervals; one-sided p = (1 + #{resamples ≤ 0}) / (1 + resamples). Seeded.
 */
export function blockBootstrap(x: readonly number[], trade: readonly boolean[], o: { block: number; resamples?: number; seed?: number; level?: number }): SeriesBootstrap {
  const n = x.length;
  if (trade.length !== n) throw new Error("x and trade differ in length");
  const block = Math.max(1, Math.floor(o.block));
  const resamples = Math.max(1, Math.floor(o.resamples ?? 10_000));
  const seed = o.seed ?? 7;
  const level = o.level ?? 0.95;
  const rnd = seededRandom(seed);
  const total = x.reduce((a, b, i) => a + (trade[i] ? b : 0), 0);
  const nTrades = trade.filter(Boolean).length;
  const perTrade: number[] = [];
  const perSession: number[] = [];
  let emptyResamples = 0;
  const nBlocks = Math.ceil(n / Math.max(1, block));
  for (let b = 0; b < resamples && n > 0; b++) {
    let s = 0;
    let k = 0;
    let taken = 0;
    for (let j = 0; j < nBlocks && taken < n; j++) {
      const start = Math.floor(rnd() * n);
      for (let t = 0; t < block && taken < n; t++, taken++) {
        const i = (start + t) % n;
        if (trade[i]) {
          s += x[i];
          k++;
        }
      }
    }
    perSession.push(s / n);
    if (k > 0) perTrade.push(s / k);
    else emptyResamples++;
  }
  const tail = (1 - level) / 2;
  const stat = (estimate: number, dist: number[]): BootstrapStat => ({
    estimate,
    lo: quantile(dist, tail),
    hi: quantile(dist, 1 - tail),
    se: stdev(dist),
    p: (1 + dist.filter((v) => v <= 0).length) / (1 + dist.length),
  });
  return {
    resamples,
    block,
    seed,
    level,
    sessions: n,
    trades: nTrades,
    perTrade: stat(nTrades > 0 ? total / nTrades : 0, perTrade),
    perSession: stat(n > 0 ? total / n : 0, perSession),
    emptyResamples,
  };
}

// ---------------------------------------------------------------------------
// Runs and intervals
// ---------------------------------------------------------------------------

/** Maximal runs of consecutive true values, as inclusive index ranges in order. */
export function runsOf(flags: readonly boolean[]): { start: number; end: number; length: number }[] {
  const out: { start: number; end: number; length: number }[] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) {
      out.push({ start, end: i - 1, length: i - start });
      start = -1;
    }
  });
  if (start >= 0) out.push({ start, end: flags.length - 1, length: flags.length - start });
  return out;
}

/** Wilson score interval of a proportion k / n (z = 1.96 for 95%); [NaN, NaN] for n = 0. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (!(n > 0)) return { lo: NaN, hi: NaN };
  const p = k / n;
  const z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
