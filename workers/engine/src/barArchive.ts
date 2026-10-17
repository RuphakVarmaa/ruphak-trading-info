/**
 * Nightly 5-minute bar archive. At 16:15 IST on trading days (cron ARCHIVE; POST /ops/archive by hand) the
 * trading DO passes its market-data source to runBarArchive, which appends to D1 `bars_5m` every settled
 * bar the source holds that is not archived yet (Indian indices: Yahoo's 60-day window; cross assets: the
 * 5-day window, or 60 days when the archive ends before it):
 * - per symbol, fresh bars are compared with the archive from IST midnight of the day of the last archived
 *   bar, so the first run writes the whole window and a missed night is caught up by the next run
 *   (`full` compares the whole held window instead, which also fills older holes);
 * - a bar is written once it closed ARCHIVE_SETTLE_MS (30 min) before the run, with INSERT OR IGNORE in
 *   batched multi-row statements: an archived bar is never rewritten, so running twice is harmless, and
 *   a fresh copy that differs is counted and logged as a revision;
 * - non-trading days are skipped. Every failure is caught and logged; the outcome goes to KV
 *   (BAR_ARCHIVE_STATUS_KEY, POST /ops/archive-status). It never throws and runs outside the alarm loop,
 *   so it cannot stop trading or count toward DEGRADED.
 */
import type { TradingCalendar } from "../../../src/engine/calendar/calendar";
import { formatIst, istDate, istIso } from "../../../src/engine/clock";
import { archiveWindowStart, ARCHIVE_SETTLE_MS, candleFromRow, ENGINE_SOURCE, INSERT_OR_IGNORE_SQL, planBars, toBarRow, type BarRow } from "../../../src/engine/market/barArchive";
import { mergeCandles } from "../../../src/engine/market/candles";
import { fetchYahooChart } from "../../../src/engine/market/yahooClient";
import { CROSS_ASSET_SYMBOLS, INDIAN_SYMBOLS } from "../../../src/engine/market/yahooMarketData";
import type { Logger } from "../../../src/engine/ports";
import type { Candle } from "../../../src/engine/types";

export const BAR_ARCHIVE_STATUS_KEY = "archive:bars_5m:status";

/** 9 rows x 10 columns = 90 bound parameters; D1 allows 100 per statement. */
const ROWS_PER_STATEMENT = 9;
const STATEMENTS_PER_BATCH = 50;
const REVISION_EXAMPLES = 5;
/** Range of the one-off fetch for a cross asset whose archive ends before the source's 5-day window. */
const CATCH_UP_RANGE = "60d";
const CATCH_UP_TIMEOUT_MS = 20_000;
const CATCH_UP_CONCURRENCY = 4;

/** What the archive needs from the market-data source (YahooMarketDataSource). */
export interface BarSource {
  refresh(): Promise<void>;
  heldBars(): Record<string, readonly Candle[]>;
}

export type StatusStore = Pick<KVNamespace, "get" | "put">;

export interface BarArchiveDeps {
  db: D1Database;
  /** Where the status for /ops goes (the engine's KV); null keeps it in the logs only. */
  kv: StatusStore | null;
  source: BarSource;
  calendar: TradingCalendar;
  logger: Logger;
  now?: () => number;
  /** For the 60-day catch-up fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface BarArchiveOptions {
  /** Compare everything the source holds with the archive (fills holes anywhere in Yahoo's window). */
  full?: boolean;
  /** Run on a non-trading day too (manual runs). */
  force?: boolean;
}

export interface SymbolArchiveStatus {
  /** Settled bars found that were not archived. */
  new: number;
  /** Rows D1 inserted (less than `new` only if another run wrote them first). */
  added: number;
  revisions: number;
  /** Newest archived bar after the run. */
  lastBar: string | null;
}

export interface BarArchiveStatus {
  v: 1;
  /** True when the run finished without an error (a skipped day is ok). */
  ok: boolean;
  ranAt: string;
  date: string;
  skipped: string | null;
  full: boolean;
  settledBefore: string | null;
  new: number;
  added: number;
  revisions: number;
  symbols: Record<string, SymbolArchiveStatus>;
  /** Cross assets fetched with range=60d because their archive ended before the source's window. */
  fetched60d: string[];
  /** Symbols whose archive ends before everything Yahoo still serves: those bars are lost. */
  gaps: string[];
  errors: string[];
  durationMs: number;
  /** Last run that wrote without an error. */
  lastOkAt: string | null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Runs tasks with at most `limit` in flight. */
async function inPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const numberOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

async function readStatus(kv: StatusStore | null): Promise<BarArchiveStatus | null> {
  if (!kv) return null;
  try {
    return (await kv.get(BAR_ARCHIVE_STATUS_KEY, "json")) as BarArchiveStatus | null;
  } catch {
    return null;
  }
}

async function writeStatus(kv: StatusStore | null, status: BarArchiveStatus, logger: Logger): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(BAR_ARCHIVE_STATUS_KEY, JSON.stringify(status));
  } catch (err) {
    logger.error("bar archive: status not saved", { error: errorText(err) });
  }
}

/** Appends the settled bars the source holds to D1 bars_5m. Never throws; see the module comment. */
export async function runBarArchive(deps: BarArchiveDeps, opts: BarArchiveOptions = {}): Promise<BarArchiveStatus> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const status: BarArchiveStatus = {
    v: 1,
    ok: false,
    ranAt: istIso(now),
    date: istDate(now),
    skipped: null,
    full: opts.full === true,
    settledBefore: null,
    new: 0,
    added: 0,
    revisions: 0,
    symbols: {},
    fetched60d: [],
    gaps: [],
    errors: [],
    durationMs: 0,
    lastOkAt: null,
  };
  const previous = await readStatus(deps.kv);
  try {
    if (!opts.force && !deps.calendar.isTradingDay(status.date)) {
      status.skipped = `not a trading day (${deps.calendar.holidayName(status.date) ?? "market closed"})`;
    } else {
      await archive(deps, opts, now, status);
    }
    status.ok = status.errors.length === 0;
  } catch (err) {
    status.ok = false;
    status.errors.push(errorText(err));
  }
  status.durationMs = Math.max(0, clock() - now);
  status.lastOkAt = status.ok && !status.skipped ? status.ranAt : (previous?.lastOkAt ?? null);
  if (status.ok) {
    deps.logger.info("bar archive", { date: status.date, skipped: status.skipped, new: status.new, added: status.added, revisions: status.revisions, fetched60d: status.fetched60d, gaps: status.gaps, durationMs: status.durationMs });
  } else {
    deps.logger.error("bar archive failed", { date: status.date, errors: status.errors, added: status.added, durationMs: status.durationMs });
  }
  await writeStatus(deps.kv, status, deps.logger);
  return status;
}

/** Records a run that could not start (e.g. the trading DO was unreachable), keeping the last success. */
export async function recordBarArchiveFailure(kv: StatusStore | null, message: string, nowMs: number, logger: Logger): Promise<void> {
  const previous = await readStatus(kv);
  await writeStatus(
    kv,
    {
      v: 1,
      ok: false,
      ranAt: istIso(nowMs),
      date: istDate(nowMs),
      skipped: null,
      full: false,
      settledBefore: null,
      new: 0,
      added: 0,
      revisions: 0,
      symbols: {},
      fetched60d: [],
      gaps: [],
      errors: [message.slice(0, 300)],
      durationMs: 0,
      lastOkAt: previous?.lastOkAt ?? null,
    },
    logger,
  );
}

async function archive(deps: BarArchiveDeps, opts: BarArchiveOptions, now: number, status: BarArchiveStatus): Promise<void> {
  const { db, logger } = deps;
  const settledAt = now - ARCHIVE_SETTLE_MS;
  status.settledBefore = istIso(settledAt);

  await deps.source.refresh();
  const held = deps.source.heldBars();
  const symbols = [...new Set([...INDIAN_SYMBOLS, ...CROSS_ASSET_SYMBOLS, ...Object.keys(held)])];

  // 1) Newest archived bar per symbol (MAX over the primary key reads one row each).
  const lastRes = await db.batch(symbols.map((s) => db.prepare("SELECT MAX(t) AS t FROM bars_5m WHERE symbol = ?").bind(s)));
  const lastT = new Map(symbols.map((s, i) => [s, numberOrNull((lastRes[i]?.results?.[0] as Record<string, unknown> | undefined)?.t)]));

  // 2) Fresh bars: what the source holds. A cross asset whose archive is empty or ends before the source's
  //    5-day window gets Yahoo's 60 days (4 requests at a time), so a missed week costs nothing either.
  const catchUp = symbols.filter((s) => {
    const bars = held[s] ?? [];
    const last = lastT.get(s) ?? null;
    return CROSS_ASSET_SYMBOLS.includes(s) && (last === null || bars.length === 0 || last < bars[0].t);
  });
  const caught = new Map<string, Candle[]>();
  await inPool(
    catchUp.map((s) => async () => {
      try {
        caught.set(s, (await fetchYahooChart(s, { interval: "5m", range: CATCH_UP_RANGE, fetchImpl: deps.fetchImpl, timeoutMs: CATCH_UP_TIMEOUT_MS })).candles);
      } catch (err) {
        status.errors.push(`${s} ${CATCH_UP_RANGE} fetch: ${errorText(err)}`);
        logger.warn("bar archive: catch-up fetch failed", { symbol: s, range: CATCH_UP_RANGE, error: errorText(err) });
      }
    }),
    CATCH_UP_CONCURRENCY,
  );
  const fresh = new Map<string, readonly Candle[]>();
  for (const s of symbols) {
    const extra = caught.get(s);
    const bars: readonly Candle[] = extra ? mergeCandles(extra, [...(held[s] ?? [])]) : (held[s] ?? []); // the source's copy wins
    if (extra) status.fetched60d.push(s);
    const last = lastT.get(s) ?? null;
    if (last !== null && bars.length > 0 && last < bars[0].t) {
      status.gaps.push(`${s}: archive ends ${formatIst(last)}, Yahoo's window starts ${formatIst(bars[0].t)}`);
    }
    fresh.set(s, bars);
  }
  if (status.gaps.length > 0) logger.warn("bar archive: gaps that can no longer be filled", { gaps: status.gaps });

  // 3) The archived bars of each comparison window (one batch).
  const windows = symbols.map((s) => {
    const bars = fresh.get(s) ?? [];
    const last = lastT.get(s) ?? null;
    const start = last === null ? -Infinity : opts.full ? Math.min(bars[0]?.t ?? Infinity, archiveWindowStart(last)) : archiveWindowStart(last);
    return { symbol: s, last, start, bars };
  });
  const reads = windows.filter((w) => w.last !== null && w.bars.length > 0);
  const archivedRes = reads.length > 0 ? await db.batch(reads.map((w) => db.prepare("SELECT t,o,h,l,c,v,oi FROM bars_5m WHERE symbol = ? AND t >= ? ORDER BY t").bind(w.symbol, w.start))) : [];
  const archived = new Map(reads.map((w, i) => [w.symbol, ((archivedRes[i]?.results ?? []) as Record<string, unknown>[]).map(candleFromRow)]));

  // 4) Plan: settled bars not archived yet; differing fresh copies are revisions (the archive keeps its own).
  const statements: { symbol: string; stmt: D1PreparedStatement }[] = [];
  for (const w of windows) {
    const plan = planBars(w.bars, archived.get(w.symbol) ?? [], settledAt, w.start);
    const newest = plan.bars.at(-1)?.t ?? null;
    const lastBar = Math.max(w.last ?? -Infinity, newest ?? -Infinity);
    status.symbols[w.symbol] = { new: plan.bars.length, added: 0, revisions: plan.revisions.length, lastBar: Number.isFinite(lastBar) ? formatIst(lastBar) : null };
    status.new += plan.bars.length;
    status.revisions += plan.revisions.length;
    if (plan.revisions.length > 0) {
      logger.warn("bar archive: revised bars (archived copies kept)", {
        symbol: w.symbol,
        count: plan.revisions.length,
        examples: plan.revisions.slice(0, REVISION_EXAMPLES).map((r) => ({ bar: formatIst(r.fetched.t), archived: r.archived, fetched: r.fetched })),
      });
    }
    const rows = plan.bars.map((c) => toBarRow(w.symbol, c, ENGINE_SOURCE, now));
    for (const part of chunks(rows, ROWS_PER_STATEMENT)) statements.push({ symbol: w.symbol, stmt: insertStatement(db, part) });
  }

  // 5) INSERT OR IGNORE, 50 statements per batch.
  for (const batch of chunks(statements, STATEMENTS_PER_BATCH)) {
    const res = await db.batch(batch.map((b) => b.stmt));
    res.forEach((r, i) => {
      const n = r.meta?.changes ?? 0;
      status.added += n;
      status.symbols[batch[i].symbol].added += n;
    });
  }
}

function insertStatement(db: D1Database, rows: BarRow[]): D1PreparedStatement {
  const sql = `${INSERT_OR_IGNORE_SQL} ${rows.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`;
  return db.prepare(sql).bind(...rows.flatMap((r) => [r.symbol, r.t, r.o, r.h, r.l, r.c, r.v, r.oi, r.source, r.firstSeenMs]));
}
