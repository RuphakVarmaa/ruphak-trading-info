/**
 * The live option-quote recorder inside the trading DO. Recording only: it reads quotes and writes D1; it
 * never places, sizes or changes an order. The slots and contracts are in
 * src/engine/market/quoteRecorder.ts; docs/DATA.md explains what is recorded and why. The quotes come from
 * the Groww Trade API when its keys are set, otherwise from Upstox's official Market Data API with the
 * free read-only Analytics Token (runtime.ts recorderQuoteSource); each row's `source` says which.
 *
 * After each trading tick, once the tick's own work is done, the DO asks `wants(now)` (clock only, no I/O)
 * and, when a slot may be due, starts `run()` in the background, so a snapshot never delays a tick:
 * 1. one index-LTP call for the spots, then the quotes: with Groww one /live-data/quote call per contract
 *    in fetch order, started at least MIN_GAP_MS apart on the recorder's own Groww client (its own pacing,
 *    the trading DO's token manager), and no new call after BUDGET_MS; with Upstox one batch call for
 *    every contract;
 * 2. INSERT OR IGNORE into D1 `option_quotes`, 4 rows per statement in one batch: a snapshot written
 *    twice adds nothing;
 * 3. the day's slots and entry strikes in the DO's storage; the outcome in KV (QUOTE_RECORDER_STATUS_KEY,
 *    POST /ops/quotes-status), with the recorder's own counters.
 * A failed quote is skipped and counted. Anything else ends that snapshot and is counted and logged. It
 * never throws and never touches the engine's error count, so it cannot slow trading or mark the engine
 * DEGRADED. Without a quote source it records nothing and the status says why.
 */
import { defaultCalendar } from "../../../src/engine/calendar/calendar";
import { istDate, istIso } from "../../../src/engine/clock";
import {
  EXIT_SLOTS,
  MANUAL_SLOT,
  QUOTE_ROWS_PER_STATEMENT,
  QUOTE_SOURCE,
  afterSnapshot,
  dueSlot,
  fetchOrder,
  freshDay,
  inRecordingWindow,
  insertQuotesSql,
  planIndexSnapshot,
  quoteRowParams,
  toQuoteRow,
  type IndexPlan,
  type QuoteRow,
  type QuoteSlot,
  type RecorderDay,
} from "../../../src/engine/market/quoteRecorder";
import type { InstrumentProvider, Logger } from "../../../src/engine/ports";
import type { Exchange, FeatureIndexId, IndexId, OptionContract, Quote } from "../../../src/engine/types";

export const QUOTE_RECORDER_STATUS_KEY = "quotes:option_quotes:status";
/** Key of the recorder's state in the trading DO's storage. */
export const QUOTE_RECORDER_STATE_KEY = "quotes:recorder";

/** Calls start at least this far apart: at most 3.3 a second, so with the trading tick's own calls Groww's 10 a second is never reached. */
export const MIN_GAP_MS = 300;
/** No new call this long after a snapshot started (a snapshot normally takes 7-12 s). */
export const BUDGET_MS = 25_000;
/** Quote failures in a row after which a snapshot gives up. */
const MAX_FAILURES_IN_A_ROW = 3;
/** Failed snapshots in a row after which one Telegram alert goes out (at most once a day). */
const ALERT_AFTER_FAILURES = 3;
const MAX_ERRORS_KEPT = 10;
const STATEMENTS_PER_BATCH = 50;
/** The status text without a quote source, unless the deps give a reason. */
export const NO_SOURCE_REASON =
  "no quote source: set the free Upstox Analytics Token (Worker secret UPSTOX_ANALYTICS_TOKEN) or the Groww Trade API keys (GROWW_API_KEY and GROWW_TOTP_SECRET)";

/**
 * What the recorder needs from a quote source: the Groww Trade API (GrowwDataClient, one quote a call) or
 * Upstox's Market Data API (UpstoxQuotes, every contract in one batch). Both are read-only here.
 */
export interface QuoteSource {
  /** Written to each row's `source` (default QUOTE_SOURCE, the Groww Trade API). */
  readonly name?: string;
  indexLtp(): Promise<Partial<Record<FeatureIndexId, number>>>;
  quoteDetail?(exchange: Exchange, segment: "FNO", tradingSymbol: string): Promise<{ quote: Quote; lastTradeMs: number | null }>;
  /** Every contract at once; a contract missing from the map was not returned. */
  quoteBatch?(contracts: readonly OptionContract[]): Promise<{ quotes: Map<string, { quote: Quote; lastTradeMs: number | null }>; requests: number }>;
}

export type StatusStore = Pick<KVNamespace, "get" | "put">;

export interface StateStore {
  get(): Promise<RecorderState | null>;
  put(state: RecorderState): Promise<void>;
}

export interface DayCounts {
  date: string;
  /** Snapshots that wrote at least one row. */
  snapshots: number;
  rowsWritten: number;
  requests: number;
  errors: number;
}

/** Kept in the trading DO's storage. */
export interface RecorderState {
  v: 1;
  day: RecorderDay;
  today: DayCounts;
  consecutiveFailures: number;
  lastError: { at: string; message: string } | null;
  lastOkAt: string | null;
  /** The day the "not configured" status was last written (once a day is enough). */
  disabledNotedDate: string | null;
  /** The day the failure alert was last sent. */
  alertedDate: string | null;
}

export interface QuoteRecorderStatus {
  v: 1;
  /** The run finished without any error (a skip counts as ok). */
  ok: boolean;
  /** A quote source exists (the Groww Trade API keys, or UPSTOX_ANALYTICS_TOKEN). */
  configured: boolean;
  /** The quote source's name (each row's `source`), or null without one. */
  source: string | null;
  ranAt: string;
  date: string;
  slot: string | null;
  /** Why the run recorded nothing on purpose (e.g. no quote source configured). */
  skipped: string | null;
  snapshotMs: number | null;
  /** The source's index LTP at the start of the snapshot. */
  spot: Partial<Record<IndexId, number>>;
  /** Contracts in the snapshot's plan. */
  planned: number;
  /** Quotes received. */
  quotes: number;
  /** Rows D1 inserted (fewer than `quotes` only when the same snapshot was written before). */
  rowsWritten: number;
  /** Groww calls made. */
  requests: number;
  /** This run's errors (the first ten) and how many there were. */
  errors: string[];
  errorCount: number;
  durationMs: number;
  today: DayCounts & { slotsDone: string[] };
  /** Failed snapshots in a row: the recorder's own counter (the engine's is never touched). */
  consecutiveFailures: number;
  lastError: { at: string; message: string } | null;
  /** Last snapshot without an error. */
  lastOkAt: string | null;
}

export interface QuoteRecorderDeps {
  db: D1Database;
  /** Where the status for /ops goes (the engine's KV); null keeps it in the logs only. */
  kv: StatusStore | null;
  state: StateStore;
  /** Null without a configured source: nothing is recorded and the status says why (`disabledReason`). */
  source: QuoteSource | null;
  /** Why there is no source (shown in the status); a generic text by default. */
  disabledReason?: string;
  /** The real instrument master only (never synthetic contracts). */
  instruments: InstrumentProvider;
  /** Trading days with the dashboard's holiday overrides; the bundled calendar is used if it fails. */
  calendar: () => Promise<{ isTradingDay(date: string): boolean; holidayName(date: string): string | null }>;
  indices: readonly IndexId[];
  logger: Logger;
  alert?: (text: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  budgetMs?: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function emptyCounts(date: string): DayCounts {
  return { date, snapshots: 0, rowsWritten: 0, requests: 0, errors: 0 };
}

function freshState(date: string): RecorderState {
  return { v: 1, day: freshDay(date), today: emptyCounts(date), consecutiveFailures: 0, lastError: null, lastOkAt: null, disabledNotedDate: null, alertedDate: null };
}

/** Auth, permission and rate-limit failures (GrowwError or UpstoxError): every other call of the snapshot would fail the same way. */
function stopsSnapshot(err: unknown): boolean {
  const kind = err instanceof Error ? (err as Error & { kind?: unknown }).kind : undefined;
  return kind === "auth" || kind === "forbidden" || kind === "rate_limited";
}

/** INSERT OR IGNORE of the rows; returns the rows D1 inserted. */
export async function writeQuoteRows(db: D1Database, rows: readonly QuoteRow[]): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += QUOTE_ROWS_PER_STATEMENT) {
    const part = rows.slice(i, i + QUOTE_ROWS_PER_STATEMENT);
    statements.push(db.prepare(insertQuotesSql(part.length)).bind(...part.flatMap(quoteRowParams)));
  }
  let added = 0;
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    const res = await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
    for (const r of res) added += r.meta?.changes ?? 0;
  }
  return added;
}

export class QuoteRecorder {
  private running: Promise<QuoteRecorderStatus | null> | null = null;
  private state: RecorderState | null = null;

  constructor(private readonly d: QuoteRecorderDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** For the trading DO after each tick: a slot may be due (by the clock) and no snapshot is running. No I/O. */
  wants(nowMs: number): boolean {
    return this.running === null && inRecordingWindow(nowMs);
  }

  /**
   * Takes the snapshot that is due now, if any (`manual`: one snapshot now, labelled "manual"). Concurrent
   * callers share a running snapshot. Never throws; resolves to the run's status, or null when no slot was due.
   */
  run(opts: { manual?: boolean } = {}): Promise<QuoteRecorderStatus | null> {
    if (!this.running) {
      this.running = this.runOnce(opts.manual === true)
        .catch((err) => {
          this.d.logger.error("quote recorder failed", { error: errorText(err) });
          return null;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async loadState(date: string): Promise<RecorderState> {
    if (!this.state) {
      try {
        const stored = await this.d.state.get();
        if (stored && stored.v === 1) this.state = stored;
      } catch (err) {
        this.d.logger.warn("quote recorder: state unavailable, starting fresh", { error: errorText(err) });
      }
    }
    const st = this.state ?? freshState(date);
    if (st.day.date !== date) st.day = freshDay(date);
    if (st.today.date !== date) st.today = emptyCounts(date);
    this.state = st;
    return st;
  }

  private async saveState(st: RecorderState): Promise<void> {
    this.state = st;
    try {
      await this.d.state.put(st);
    } catch (err) {
      this.d.logger.error("quote recorder: state not saved", { error: errorText(err) });
    }
  }

  private async writeStatus(status: QuoteRecorderStatus): Promise<void> {
    if (!this.d.kv) return;
    try {
      await this.d.kv.put(QUOTE_RECORDER_STATUS_KEY, JSON.stringify(status));
    } catch (err) {
      this.d.logger.error("quote recorder: status not saved", { error: errorText(err) });
    }
  }

  private baseStatus(st: RecorderState, startedMs: number, slot: QuoteSlot | null): QuoteRecorderStatus {
    return {
      v: 1,
      ok: true,
      configured: this.d.source !== null,
      source: this.d.source ? (this.d.source.name ?? QUOTE_SOURCE) : null,
      ranAt: istIso(startedMs),
      date: istDate(startedMs),
      slot,
      skipped: null,
      snapshotMs: null,
      spot: {},
      planned: 0,
      quotes: 0,
      rowsWritten: 0,
      requests: 0,
      errors: [],
      errorCount: 0,
      durationMs: 0,
      today: { ...st.today, slotsDone: [...st.day.slotsDone] },
      consecutiveFailures: st.consecutiveFailures,
      lastError: st.lastError,
      lastOkAt: st.lastOkAt,
    };
  }

  private async runOnce(manual: boolean): Promise<QuoteRecorderStatus | null> {
    const started = this.now();
    const date = istDate(started);
    const st = await this.loadState(date);
    let slot: QuoteSlot;
    if (manual) slot = MANUAL_SLOT;
    else {
      let cal: Awaited<ReturnType<QuoteRecorderDeps["calendar"]>> = defaultCalendar;
      try {
        cal = await this.d.calendar();
      } catch (err) {
        this.d.logger.warn("quote recorder: settings unavailable, using the bundled holiday calendar", { error: errorText(err) });
      }
      const due = dueSlot(started, st.day, cal);
      if (due.slot === null) return null;
      slot = due.slot;
    }
    if (!this.d.source) {
      if (!manual && st.disabledNotedDate === date) return null;
      const status = this.baseStatus(st, started, slot);
      status.skipped = `${this.d.disabledReason ?? NO_SOURCE_REASON}: nothing recorded`;
      st.disabledNotedDate = date;
      await this.saveState(st);
      await this.writeStatus(status);
      this.d.logger.info("quote recorder skipped", { slot, reason: status.skipped });
      return status;
    }
    return this.snapshot(this.d.source, slot, started, st);
  }

  private async snapshot(source: QuoteSource, slot: QuoteSlot, started: number, st: RecorderState): Promise<QuoteRecorderStatus> {
    const date = istDate(started);
    const status = this.baseStatus(st, started, slot);
    status.snapshotMs = started;
    const errors: string[] = [];
    let fatal: string | null = null;
    const rows: QuoteRow[] = [];
    const plans: IndexPlan[] = [];
    const gap = this.d.minGapMs ?? MIN_GAP_MS;
    const budget = this.d.budgetMs ?? BUDGET_MS;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const sourceName = source.name ?? QUOTE_SOURCE;
    try {
      status.requests++;
      const spots = await source.indexLtp();
      let lastStart = this.now();
      for (const index of this.d.indices) {
        const spot = spots[index];
        if (typeof spot !== "number" || !(spot > 0)) {
          errors.push(`${index}: no index LTP from ${sourceName}`);
          continue;
        }
        status.spot[index] = spot;
        const held = (EXIT_SLOTS as readonly string[]).includes(slot) ? (expiry: string) => st.day.entryStrikes[`${index}|${expiry}`] ?? [] : undefined;
        const plan = await planIndexSnapshot({ index, spot, today: date, instruments: this.d.instruments, held });
        errors.push(...plan.problems);
        plans.push(plan);
      }
      const order = fetchOrder(plans);
      status.planned = order.length;
      if (order.length === 0) throw new Error(`no contracts to record${errors.length > 0 ? "" : " (instrument master empty?)"}`);
      if (source.quoteBatch) {
        // Every contract in one call (Upstox: up to 500 a request); a failure ends the snapshot.
        const batch = await source.quoteBatch(order.map((p) => p.contract)).catch((err: unknown) => {
          status.requests++;
          throw err;
        });
        status.requests += batch.requests;
        for (const p of order) {
          const got = batch.quotes.get(p.contract.tradingSymbol);
          if (!got) {
            errors.push(`${p.contract.tradingSymbol}: not returned by ${sourceName}`);
            continue;
          }
          rows.push(toQuoteRow({ snapshotMs: started, slot, planned: p, quote: got.quote, lastTradeMs: got.lastTradeMs, spot: status.spot[p.contract.index] ?? null, source: sourceName }));
        }
      }
      const quoteDetail = source.quoteBatch ? undefined : source.quoteDetail?.bind(source);
      if (!source.quoteBatch && !quoteDetail) throw new Error(`${sourceName} has no quote call`);
      let failuresInARow = 0;
      for (let i = 0; quoteDetail && i < order.length; i++) {
        if (this.now() - started >= budget) {
          errors.push(`time budget of ${Math.round(budget / 1000)} s reached: ${order.length - i} contract(s) not quoted`);
          break;
        }
        const wait = lastStart + gap - this.now();
        if (wait > 0) await sleep(wait);
        lastStart = this.now();
        const p = order[i];
        status.requests++;
        try {
          const { quote, lastTradeMs } = await quoteDetail(p.contract.exchange, "FNO", p.contract.tradingSymbol);
          rows.push(toQuoteRow({ snapshotMs: started, slot, planned: p, quote, lastTradeMs, spot: status.spot[p.contract.index] ?? null, source: sourceName }));
          failuresInARow = 0;
        } catch (err) {
          errors.push(`${p.contract.tradingSymbol}: ${errorText(err)}`);
          failuresInARow++;
          if (stopsSnapshot(err) || failuresInARow >= MAX_FAILURES_IN_A_ROW) {
            if (i + 1 < order.length) errors.push(`snapshot stopped: ${order.length - i - 1} contract(s) not quoted`);
            break;
          }
        }
      }
      status.quotes = rows.length;
      if (rows.length > 0) status.rowsWritten = await writeQuoteRows(this.d.db, rows);
    } catch (err) {
      fatal = errorText(err);
    }

    const failed = fatal !== null || rows.length === 0;
    if (!failed) {
      st.day = afterSnapshot(
        st.day,
        slot,
        started,
        plans.flatMap((p) => p.expiries.map((e) => ({ index: p.index, expiry: e.expiry, atm: e.atm }))),
      );
    }
    const allErrors = fatal !== null ? [...errors, fatal] : errors;
    status.errors = allErrors.slice(0, MAX_ERRORS_KEPT);
    status.errorCount = allErrors.length;
    status.ok = allErrors.length === 0;
    status.durationMs = Math.max(0, this.now() - started);
    st.today.requests += status.requests;
    st.today.errors += allErrors.length;
    st.today.rowsWritten += status.rowsWritten;
    if (!failed) st.today.snapshots++;
    st.consecutiveFailures = failed ? st.consecutiveFailures + 1 : 0;
    if (allErrors.length > 0) st.lastError = { at: status.ranAt, message: (fatal ?? allErrors[0]).slice(0, 300) };
    if (status.ok) st.lastOkAt = status.ranAt;
    status.today = { ...st.today, slotsDone: [...st.day.slotsDone] };
    status.consecutiveFailures = st.consecutiveFailures;
    status.lastError = st.lastError;
    status.lastOkAt = st.lastOkAt;

    const alertDue = st.consecutiveFailures >= ALERT_AFTER_FAILURES && st.alertedDate !== date && this.d.alert !== undefined;
    if (alertDue) st.alertedDate = date;
    await this.saveState(st);
    await this.writeStatus(status);
    if (failed) this.d.logger.error("quote snapshot failed", { slot, errors: status.errors, consecutive: st.consecutiveFailures, durationMs: status.durationMs });
    else this.d.logger.info("quote snapshot", { slot, planned: status.planned, quotes: status.quotes, rowsWritten: status.rowsWritten, errors: status.errorCount, durationMs: status.durationMs });
    if (alertDue) {
      try {
        await this.d.alert?.(`⚠ Quote recorder (recording only, no orders): ${st.consecutiveFailures} snapshots in a row failed. Last error: ${st.lastError?.message ?? "unknown"}`);
      } catch (err) {
        this.d.logger.warn("quote recorder: alert not sent", { error: errorText(err) });
      }
    }
    return status;
  }
}
