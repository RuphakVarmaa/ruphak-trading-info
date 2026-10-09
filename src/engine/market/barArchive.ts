/**
 * The private 5-minute bar archive in D1 (table `bars_5m`, workers/engine/src/db/schema.ts). Yahoo serves
 * only the last ~60 days of 5-minute bars, so the engine appends the settled bars it holds every trading
 * day (workers/engine/src/barArchive.ts), `npm run archive-backfill` loads a `fetch-history --save` JSON
 * archive, and `npm run archive-export` writes the table back out as a backtest history snapshot
 * (docs/DATA.md).
 *
 * Platform-neutral helpers shared by the Worker and the Node scripts:
 * - rows <-> candles, and the append plan (appendCandles: an archived bar is never rewritten);
 * - INSERT OR IGNORE statements with literal values for `wrangler d1 execute --file` (every double
 *   written this way read back bit for bit from D1's SQLite, 725k values checked);
 * - paged reads of the table and the history snapshot built from them.
 */
import { DAY_MS, MINUTE_MS, formatIst, istDate, istMidnight } from "../clock";
import type { Candle } from "../types";
import { appendCandles, BAR_5M_MS, normalizeCandles } from "./candles";

export const BARS_TABLE = "bars_5m";
export const BAR_COLUMNS = ["symbol", "t", "o", "h", "l", "c", "v", "oi", "source", "first_seen_ms"] as const;
export const INSERT_OR_IGNORE_SQL = `INSERT OR IGNORE INTO ${BARS_TABLE} (${BAR_COLUMNS.join(",")}) VALUES`;

/** A bar is archived once it closed at least this long before the run (the rule of `fetch-history --save`). */
export const ARCHIVE_SETTLE_MS = 30 * MINUTE_MS;

/** `source` of the bars the engine's nightly job writes. */
export const ENGINE_SOURCE = "yahoo:engine";
/** `source` of the bars back-filled from a `fetch-history --save` archive. */
export const BACKFILL_SOURCE = "yahoo:fetch-history";

export interface BarRow {
  symbol: string;
  /** Bar open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi: number | null;
  source: string;
  /** When the bar was first archived, epoch ms. */
  firstSeenMs: number;
}

export function toBarRow(symbol: string, c: Candle, source: string, firstSeenMs: number): BarRow {
  return {
    symbol,
    t: c.t,
    o: c.o,
    h: c.h,
    l: c.l,
    c: c.c,
    v: Number.isFinite(c.v) ? c.v : 0,
    oi: c.oi !== undefined && Number.isFinite(c.oi) ? c.oi : null,
    source,
    firstSeenMs,
  };
}

/** Candle from a `bars_5m` row (t, o, h, l, c, v, oi); `oi` only when it is set. */
export function candleFromRow(r: Record<string, unknown>): Candle {
  const c: Candle = { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) };
  if (r.oi !== null && r.oi !== undefined) c.oi = Number(r.oi);
  return c;
}

// ---------------------------------------------------------------------------
// The append plan
// ---------------------------------------------------------------------------

/**
 * Start of the window in which a run compares fresh bars with the archive: IST midnight of the day of
 * the last archived bar (a late revision or a partly written day is still caught), or -Infinity when
 * nothing is archived yet (the whole fresh window is written).
 */
export function archiveWindowStart(lastArchivedT: number | null): number {
  return lastArchivedT === null ? -Infinity : istMidnight(istDate(lastArchivedT));
}

export interface BarPlan {
  /** Settled fresh bars in the window that are not archived yet, ascending: the rows to insert. */
  bars: Candle[];
  /** Fresh copies that differ from the archived bar with the same open time (the archived one is kept). */
  revisions: { archived: Candle; fetched: Candle }[];
  /** Fresh bars in the window left out: not closed by the settle time, or a non-finite price. */
  unsettled: number;
}

/**
 * What a run writes for one symbol: the fresh bars from `windowStartMs` on that closed by `settledAtMs`
 * and are not archived. `archived` must hold every archived bar of the symbol from `windowStartMs` on.
 */
export function planBars(fresh: readonly Candle[], archived: readonly Candle[], settledAtMs: number, windowStartMs = -Infinity): BarPlan {
  const inWindow = normalizeCandles(fresh.filter((c) => c.t >= windowStartMs));
  const r = appendCandles(archived, inWindow, settledAtMs);
  return { bars: r.appended, revisions: r.revisions, unsettled: r.skipped };
}

// ---------------------------------------------------------------------------
// SQL with literal values (back-fill files for `wrangler d1 execute --file`)
// ---------------------------------------------------------------------------

/** Yahoo-style symbol names ("^NSEI", "ES=F", "DX-Y.NYB", "000001.SS"): the only ones the archive takes. */
export function isArchiveSymbol(s: string): boolean {
  return /^[A-Za-z0-9^=._-]{1,32}$/.test(s);
}

/** Text that cannot leave a `--` SQL comment line. */
const commentSafe = (s: string) => s.replace(/[\r\n]+/g, " ");

/** SQLite string literal. */
export function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** SQLite numeric literal that reads back as the same double (JavaScript's shortest round-trip form). */
export function sqlNumber(x: number): string {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`SQL literal needs a finite number, got ${String(x)}`);
  return Object.is(x, -0) ? "0" : String(x);
}

/** `(symbol,t,o,h,l,c,v,oi,source,first_seen_ms)` values of one row. */
export function rowValuesSql(r: BarRow): string {
  const nums = [r.t, r.o, r.h, r.l, r.c, r.v].map(sqlNumber).join(",");
  return `(${sqlString(r.symbol)},${nums},${r.oi === null ? "NULL" : sqlNumber(r.oi)},${sqlString(r.source)},${sqlNumber(r.firstSeenMs)})`;
}

/** D1 rejects SQL statements longer than 100,000 bytes. */
export const MAX_STATEMENT_BYTES = 90_000;
export const DEFAULT_ROWS_PER_STATEMENT = 500;
export const DEFAULT_ROWS_PER_FILE = 20_000;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** Multi-row INSERT OR IGNORE statements (each ends with ";") of at most `maxRows` rows and `maxBytes` bytes. */
export function insertStatements(rows: readonly BarRow[], opts: { maxRows?: number; maxBytes?: number } = {}): string[] {
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_ROWS_PER_STATEMENT);
  const maxBytes = opts.maxBytes ?? MAX_STATEMENT_BYTES;
  const head = `${INSERT_OR_IGNORE_SQL}\n`;
  const out: string[] = [];
  let values: string[] = [];
  let bytes = head.length + 1;
  for (const r of rows) {
    const v = rowValuesSql(r);
    const len = byteLength(v) + 2; // ",\n"
    if (head.length + 1 + len > maxBytes) throw new Error(`a ${r.symbol} row is longer than ${maxBytes} bytes`);
    if (values.length > 0 && (values.length >= maxRows || bytes + len > maxBytes)) {
      out.push(`${head}${values.join(",\n")};`);
      values = [];
      bytes = head.length + 1;
    }
    values.push(v);
    bytes += len;
  }
  if (values.length > 0) out.push(`${head}${values.join(",\n")};`);
  return out;
}

export interface SymbolRange {
  rows: number;
  /** First and last bar open time, epoch ms. */
  fromMs: number;
  toMs: number;
}

export function symbolRanges(rows: readonly BarRow[]): Record<string, SymbolRange> {
  const out: Record<string, SymbolRange> = {};
  for (const r of rows) {
    const s = out[r.symbol];
    if (!s) out[r.symbol] = { rows: 1, fromMs: r.t, toMs: r.t };
    else {
      s.rows++;
      if (r.t < s.fromMs) s.fromMs = r.t;
      if (r.t > s.toMs) s.toMs = r.t;
    }
  }
  return out;
}

export interface SqlFile {
  /** bars-0001.sql, bars-0002.sql, ... */
  name: string;
  sql: string;
  rows: number;
  statements: number;
  symbols: Record<string, SymbolRange>;
}

/** Splits rows into SQL files of at most `rowsPerFile` rows; `header` lines become comments at the top of each. */
export function backfillSqlFiles(
  rows: readonly BarRow[],
  opts: { rowsPerFile?: number; rowsPerStatement?: number; maxStatementBytes?: number; header?: readonly string[] } = {},
): SqlFile[] {
  const perFile = Math.max(1, opts.rowsPerFile ?? DEFAULT_ROWS_PER_FILE);
  const parts: BarRow[][] = [];
  for (let i = 0; i < rows.length; i += perFile) parts.push(rows.slice(i, i + perFile));
  return parts.map((part, i) => {
    const name = `bars-${String(i + 1).padStart(4, "0")}.sql`;
    const statements = insertStatements(part, { maxRows: opts.rowsPerStatement, maxBytes: opts.maxStatementBytes });
    const symbols = symbolRanges(part);
    const comments = [
      `-- ${BARS_TABLE} back-fill, file ${i + 1} of ${parts.length}: ${part.length} bars (${commentSafe(Object.keys(symbols).join(", "))}).`,
      `-- INSERT OR IGNORE: running it again changes nothing, and a bar already archived is never rewritten.`,
      ...(opts.header ?? []).map((l) => `-- ${commentSafe(l)}`),
    ];
    return { name, sql: `${comments.join("\n")}\n${statements.join("\n")}\n`, rows: part.length, statements: statements.length, symbols };
  });
}

/** A `fetch-history --save` archive or a `backtest --save-history` snapshot (the fields the back-fill reads). */
export interface HistoryFile {
  source?: string;
  savedAt?: string;
  fetchedAt?: string;
  candles: Record<string, Candle[]>;
  archive?: { captures?: { fetchedAt: string }[] };
}

export interface BackfillPlan {
  /** Sorted by symbol, then bar open time. */
  rows: BarRow[];
  /** Only bars that closed by this time are included (savedAt - ARCHIVE_SETTLE_MS unless given). */
  settledBeforeMs: number;
  skipped: { unsettled: number; invalid: number; outOfRange: number; duplicates: number };
  symbols: Record<string, SymbolRange>;
}

/**
 * Rows for every settled bar of a JSON archive. `first_seen_ms` is the first capture that could have
 * archived the bar (closed ARCHIVE_SETTLE_MS before it), or the file's savedAt without a capture log.
 * Bars that had not closed ARCHIVE_SETTLE_MS before savedAt are left out, so a still-forming bar of a
 * plain snapshot is never frozen into the archive.
 */
export function backfillRows(
  file: HistoryFile,
  opts: { source?: string; symbols?: readonly string[]; fromMs?: number; toMs?: number; settledBeforeMs?: number } = {},
): BackfillPlan {
  if (!file || typeof file.candles !== "object" || file.candles === null) throw new Error("not a history file: no `candles` map");
  const savedAtMs = Date.parse(file.savedAt ?? file.fetchedAt ?? "");
  const settledBeforeMs = opts.settledBeforeMs ?? savedAtMs - ARCHIVE_SETTLE_MS;
  if (!Number.isFinite(settledBeforeMs)) throw new Error("the file has no savedAt/fetchedAt: give the settle cutoff explicitly");
  // A bar closing at t + 5m first fits a capture fetched at or after t + 5m + ARCHIVE_SETTLE_MS.
  const captures = (file.archive?.captures ?? [])
    .map((c) => Date.parse(c.fetchedAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const fallbackSeen = Number.isFinite(savedAtMs) ? savedAtMs : settledBeforeMs + ARCHIVE_SETTLE_MS;
  const firstSeen = (t: number): number => {
    const need = t + BAR_5M_MS + ARCHIVE_SETTLE_MS;
    let lo = 0;
    let hi = captures.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (captures[mid] >= need) hi = mid;
      else lo = mid + 1;
    }
    return lo < captures.length ? captures[lo] : fallbackSeen;
  };
  const source = opts.source ?? BACKFILL_SOURCE;
  const wanted = opts.symbols && opts.symbols.length > 0 ? new Set(opts.symbols) : null;
  const skipped = { unsettled: 0, invalid: 0, outOfRange: 0, duplicates: 0 };
  const rows: BarRow[] = [];
  for (const symbol of Object.keys(file.candles).sort()) {
    if (wanted && !wanted.has(symbol)) continue;
    if (!isArchiveSymbol(symbol)) throw new Error(`unexpected symbol name ${JSON.stringify(symbol.slice(0, 40))}`);
    const raw = Array.isArray(file.candles[symbol]) ? file.candles[symbol] : [];
    const valid = raw.filter((c) => c && typeof c === "object" && Number.isFinite(c.t));
    const bars = normalizeCandles(valid);
    skipped.invalid += raw.length - valid.length;
    skipped.duplicates += valid.length - bars.length;
    for (const c of bars) {
      if (![c.o, c.h, c.l, c.c, c.v].every((x) => typeof x === "number" && Number.isFinite(x)) || (c.oi !== undefined && !Number.isFinite(c.oi))) {
        skipped.invalid++;
      } else if ((opts.fromMs !== undefined && c.t < opts.fromMs) || (opts.toMs !== undefined && c.t >= opts.toMs)) {
        skipped.outOfRange++;
      } else if (c.t + BAR_5M_MS > settledBeforeMs) {
        skipped.unsettled++;
      } else {
        rows.push(toBarRow(symbol, c, source, firstSeen(c.t)));
      }
    }
  }
  return { rows, settledBeforeMs, skipped, symbols: symbolRanges(rows) };
}

// ---------------------------------------------------------------------------
// Reading the archive back (export)
// ---------------------------------------------------------------------------

/** Runs SQL statements without bound parameters and returns each statement's rows, in order. */
export type SqlRunner = (statements: string[]) => Promise<Record<string, unknown>[][]>;

/** Every symbol in the table: a skip-scan over the primary key that reads about one row per symbol. */
export const LIST_SYMBOLS_SQL =
  `WITH RECURSIVE s(symbol) AS (SELECT MIN(symbol) FROM ${BARS_TABLE} ` +
  `UNION ALL SELECT (SELECT MIN(symbol) FROM ${BARS_TABLE} WHERE symbol > s.symbol) FROM s WHERE s.symbol IS NOT NULL) ` +
  `SELECT symbol FROM s WHERE symbol IS NOT NULL`;

/** One page of a symbol's bars with open time in (afterT, beforeT), oldest first. */
export function pageSql(symbol: string, afterT: number, beforeT: number | null, limit: number): string {
  const upper = beforeT === null ? "" : ` AND t < ${sqlNumber(Math.ceil(beforeT))}`;
  return `SELECT t,o,h,l,c,v,oi FROM ${BARS_TABLE} WHERE symbol = ${sqlString(symbol)} AND t > ${sqlNumber(Math.floor(afterT))}${upper} ORDER BY t LIMIT ${Math.max(1, Math.floor(limit))}`;
}

export interface ReadBarsOptions {
  /** Default: every symbol in the table. */
  symbols?: readonly string[];
  /** Bar open time bounds, epoch ms: [fromMs, toMs). */
  fromMs?: number;
  toMs?: number;
  /** Rows per statement (default 25,000). */
  pageRows?: number;
  /** Statements per runner call (default 4). */
  statementsPerCall?: number;
  onProgress?: (symbol: string, bars: number) => void;
}

/** Reads archived bars page by page (keyset on the primary key), several symbols per call. */
export async function readArchivedBars(run: SqlRunner, opts: ReadBarsOptions = {}): Promise<Record<string, Candle[]>> {
  const symbols = opts.symbols && opts.symbols.length > 0 ? [...new Set(opts.symbols)] : ((await run([LIST_SYMBOLS_SQL]))[0] ?? []).map((r) => String(r.symbol));
  const pageRows = Math.max(1, opts.pageRows ?? 25_000);
  const perCall = Math.max(1, opts.statementsPerCall ?? 4);
  const out: Record<string, Candle[]> = {};
  const queue = symbols.map((symbol) => ({ symbol, after: (opts.fromMs ?? 0) - 1 }));
  while (queue.length > 0) {
    const call = queue.splice(0, perCall);
    const results = await run(call.map((q) => pageSql(q.symbol, q.after, opts.toMs ?? null, pageRows)));
    call.forEach((q, i) => {
      const rows = results[i] ?? [];
      const arr = (out[q.symbol] ??= []);
      for (const r of rows) arr.push(candleFromRow(r));
      if (rows.length >= pageRows) queue.push({ symbol: q.symbol, after: arr[arr.length - 1].t });
      opts.onProgress?.(q.symbol, arr.length);
    });
  }
  for (const s of Object.keys(out)) if (out[s].length === 0) delete out[s];
  return out;
}

/** The JSON shape `npm run backtest -- --history <file>` replays (what `--save-history` writes). */
export interface HistorySnapshot {
  source: string;
  savedAt: string;
  candles: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
  errors: string[];
}

/** Snapshot of archived 5-minute bars: per symbol ascending and unique; symbols without bars left out. */
export function historySnapshot(candles: Record<string, readonly Candle[]>, o: { source: string; savedAt: string; daily?: Record<string, Candle[]>; errors?: string[] }): HistorySnapshot {
  const out: Record<string, Candle[]> = {};
  for (const sym of Object.keys(candles).sort()) {
    const arr = normalizeCandles([...candles[sym]]);
    if (arr.length > 0) out[sym] = arr;
  }
  return { source: o.source, savedAt: o.savedAt, candles: out, daily: o.daily ?? {}, errors: o.errors ?? [] };
}

/** Smallest Yahoo daily range that reaches `warmupDays` before the first archived bar. */
export function dailyRangeFor(firstBarMs: number, nowMs: number, warmupDays = 60): "2y" | "5y" | "10y" | "max" {
  const days = (nowMs - firstBarMs) / DAY_MS + warmupDays;
  if (days <= 730) return "2y";
  if (days <= 1826) return "5y";
  if (days <= 3652) return "10y";
  return "max";
}

export interface BarComparison {
  /** Expected bars found in `actual` with identical values. */
  same: number;
  missing: number;
  different: number;
  /** Bars in `actual` that `expected` does not have (e.g. written later by the engine). */
  extra: number;
  examples: string[];
}

/** Compares archived bars with the bars a file says should be there, value for value. */
export function compareBars(expected: Record<string, readonly Candle[]>, actual: Record<string, readonly Candle[]>, maxExamples = 10): BarComparison {
  const res: BarComparison = { same: 0, missing: 0, different: 0, extra: 0, examples: [] };
  const note = (s: string) => {
    if (res.examples.length < maxExamples) res.examples.push(s);
  };
  for (const sym of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const have = new Map((actual[sym] ?? []).map((c) => [c.t, c]));
    const want = new Set<number>();
    for (const e of expected[sym] ?? []) {
      want.add(e.t);
      const a = have.get(e.t);
      if (!a) {
        res.missing++;
        note(`${sym} ${formatIst(e.t)}: missing`);
      } else if (a.o !== e.o || a.h !== e.h || a.l !== e.l || a.c !== e.c || a.v !== e.v || a.oi !== e.oi) {
        res.different++;
        note(`${sym} ${formatIst(e.t)}: archived ${JSON.stringify(a)} vs expected ${JSON.stringify(e)}`);
      } else res.same++;
    }
    for (const t of have.keys()) if (!want.has(t)) res.extra++;
  }
  return res;
}
