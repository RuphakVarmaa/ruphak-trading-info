/**
 * Live option-quote recorder: when it records, which contracts, and the D1 rows (table `option_quotes`,
 * workers/engine/src/db/schema.ts). Recording only: nothing here places, sizes or changes an order.
 *
 * Why: on five years of real 1-minute trade prices the one near-miss was selling the at-the-money NIFTY or
 * SENSEX straddle at the close of the 09:15 minute (reports/wp11-real-intraday.md §3, §9). Trade bars
 * cannot show whether a real sell order fills there; Groww's bid and ask can.
 *
 * - Slots, on NSE trading days: every trading tick from 09:15:00 to 09:31:00 IST ("open", at least 20 s
 *   apart), then one snapshot at each of 09:45, 10:15, 11:15, 15:00 and 15:20 (the first tick in the five
 *   minutes after the time). "manual" is a snapshot asked for with POST /ops/quotes-snapshot.
 * - Contracts, per index: the nearest weekly expiry that does not expire today ("next", the engine's own
 *   rule) and the contract expiring today when one is listed ("expiring"); the listed strike nearest
 *   Groww's index LTP (a tie goes to the lower strike, WP11's rule) and two listed strikes on each side,
 *   calls and puts. At 15:00 and 15:20 also every strike that was at the money at an entry snapshot
 *   (09:15-09:17, 09:20, 09:30, 11:15), so the morning's straddles can be valued at the buy-back.
 *
 * The Worker job is workers/engine/src/quoteRecorder.ts; `npm run quotes-report` reads the table
 * (src/engine/backtest/quoteReport.ts). Pure and web-standard (no node: imports).
 */
import { MINUTE_MS, istDate, istMidnight, parseHHMM } from "../clock";
import type { InstrumentProvider } from "../ports";
import type { IndexId, Level, OptionContract, OptionType, Quote } from "../types";

export const QUOTES_TABLE = "option_quotes";
export const QUOTE_SCHEMA_VERSION = 1;
/** `source` of the rows the trading DO writes. */
export const QUOTE_SOURCE = "groww:live-data/quote";

export const OPEN_SLOT = "open";
export const MANUAL_SLOT = "manual";
export const FIXED_SLOTS = ["09:45", "10:15", "11:15", "15:00", "15:20"] as const;
export type FixedSlot = (typeof FIXED_SLOTS)[number];
export type QuoteSlot = typeof OPEN_SLOT | typeof MANUAL_SLOT | FixedSlot;

/** The open window in ms after IST midnight: every tick in [09:15:00, 09:31:00]. */
export const OPEN_WINDOW_MS = { from: parseHHMM("09:15") * MINUTE_MS, to: parseHHMM("09:31") * MINUTE_MS } as const;
/** A fixed slot is taken by the first tick in [its time, its time + 5 min). */
export const FIXED_SLOT_GRACE_MS = 5 * MINUTE_MS;
/** Open-window snapshots are at least this far apart, so extra ticks (an admin tick, new scores) add none. */
export const MIN_SNAPSHOT_GAP_MS = 20_000;
/** Listed strikes recorded on each side of the at-the-money strike. */
export const STRIKES_EACH_SIDE = 2;
/** Slots at which the strikes sold at the morning's entry snapshots are recorded as well. */
export const EXIT_SLOTS: readonly FixedSlot[] = ["15:00", "15:20"];
/** Open-window spans ([from, to) in ms after IST midnight) whose snapshots are entry candidates of the report. */
export const ENTRY_WINDOWS_MS: readonly (readonly [number, number])[] = [
  [parseHHMM("09:15") * MINUTE_MS, parseHHMM("09:17") * MINUTE_MS],
  [parseHHMM("09:20") * MINUTE_MS, parseHHMM("09:21") * MINUTE_MS],
  [parseHHMM("09:30") * MINUTE_MS, parseHHMM("09:31") * MINUTE_MS + 1],
];

const FIXED_SLOT_MS: readonly (readonly [FixedSlot, number])[] = FIXED_SLOTS.map((s) => [s, parseHHMM(s) * MINUTE_MS] as const);

/** Milliseconds since IST midnight. */
export function msOfIstDay(ms: number): number {
  return ms - istMidnight(istDate(ms));
}

// ---------------------------------------------------------------------------
// When to record
// ---------------------------------------------------------------------------

/** What the recorder remembers about the current IST day (kept in the trading DO's storage). */
export interface RecorderDay {
  date: string;
  /** Fixed slots already recorded today. */
  slotsDone: string[];
  lastSnapshotMs: number | null;
  /** At-the-money strikes of today's entry snapshots, by `${index}|${expiry}` (recorded again at 15:00 and 15:20). */
  entryStrikes: Record<string, number[]>;
}

export function freshDay(date: string): RecorderDay {
  return { date, slotsDone: [], lastSnapshotMs: null, entryStrikes: {} };
}

/** True when `ms` falls in the open window or a fixed slot's five minutes (clock only, no calendar): a cheap pre-check. */
export function inRecordingWindow(ms: number): boolean {
  const t = msOfIstDay(ms);
  if (t >= OPEN_WINDOW_MS.from && t <= OPEN_WINDOW_MS.to) return true;
  return FIXED_SLOT_MS.some(([, at]) => t >= at && t < at + FIXED_SLOT_GRACE_MS);
}

export type SlotDecision = { slot: QuoteSlot; reason: null } | { slot: null; reason: string };

/**
 * The slot a snapshot taken at `nowMs` belongs to, or why none is due: not a trading day, outside the
 * slots, a fixed slot already recorded today, or an open-window snapshot under 20 s ago.
 */
export function dueSlot(nowMs: number, day: RecorderDay | null, calendar: { isTradingDay(date: string): boolean; holidayName?(date: string): string | null }): SlotDecision {
  const date = istDate(nowMs);
  if (!calendar.isTradingDay(date)) return { slot: null, reason: `not a trading day (${calendar.holidayName?.(date) ?? "market closed"})` };
  const today = day && day.date === date ? day : null;
  const t = msOfIstDay(nowMs);
  if (t >= OPEN_WINDOW_MS.from && t <= OPEN_WINDOW_MS.to) {
    const last = today?.lastSnapshotMs ?? null;
    if (last !== null && nowMs - last < MIN_SNAPSHOT_GAP_MS) return { slot: null, reason: `last snapshot ${Math.round((nowMs - last) / 1000)} s ago` };
    return { slot: OPEN_SLOT, reason: null };
  }
  for (const [slot, at] of FIXED_SLOT_MS) {
    if (t < at || t >= at + FIXED_SLOT_GRACE_MS) continue;
    if (today?.slotsDone.includes(slot)) return { slot: null, reason: `slot ${slot} already recorded` };
    return { slot, reason: null };
  }
  return { slot: null, reason: "outside the recording slots" };
}

/** True when the report can use a snapshot as an entry, so its at-the-money strikes are recorded at the exit slots too. */
export function isEntrySnapshot(slot: QuoteSlot, snapshotMs: number): boolean {
  if (slot === "11:15") return true;
  if (slot !== OPEN_SLOT) return false;
  const t = msOfIstDay(snapshotMs);
  return ENTRY_WINDOWS_MS.some(([from, to]) => t >= from && t < to);
}

/** The day after a snapshot: the fixed slot marked done, the last snapshot time, and the entry strikes kept. */
export function afterSnapshot(day: RecorderDay, slot: QuoteSlot, snapshotMs: number, atms: readonly { index: IndexId; expiry: string; atm: number }[]): RecorderDay {
  const next: RecorderDay = { ...day, slotsDone: [...day.slotsDone], entryStrikes: { ...day.entryStrikes } };
  if (slot !== OPEN_SLOT && slot !== MANUAL_SLOT && !next.slotsDone.includes(slot)) next.slotsDone.push(slot);
  if (slot !== MANUAL_SLOT) next.lastSnapshotMs = snapshotMs;
  if (isEntrySnapshot(slot, snapshotMs)) {
    for (const a of atms) {
      const key = `${a.index}|${a.expiry}`;
      const set = new Set(next.entryStrikes[key] ?? []);
      set.add(a.atm);
      next.entryStrikes[key] = [...set].sort((x, y) => x - y);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Which contracts
// ---------------------------------------------------------------------------

export type ExpiryKind = "next" | "expiring";

/** Expiries recorded on `today`: the nearest listed expiry after today ("next") and today's ("expiring") when listed. */
export function recordedExpiries(listed: readonly string[], today: string): { kind: ExpiryKind; expiry: string }[] {
  const sorted = [...new Set(listed)].sort();
  const out: { kind: ExpiryKind; expiry: string }[] = [];
  const next = sorted.find((e) => e > today);
  if (next) out.push({ kind: "next", expiry: next });
  if (sorted.includes(today)) out.push({ kind: "expiring", expiry: today });
  return out;
}

/** The listed strike nearest `spot`; a tie goes to the lower strike (WP11's at-the-money rule). Null for none. */
export function nearestStrike(listed: readonly number[], spot: number): number | null {
  let best: number | null = null;
  for (const k of listed) {
    if (!Number.isFinite(k)) continue;
    if (best === null || Math.abs(k - spot) < Math.abs(best - spot) || (Math.abs(k - spot) === Math.abs(best - spot) && k < best)) best = k;
  }
  return best;
}

/** The at-the-money strike and up to `n` listed strikes on each side of it (fewer at the edge of the listing). */
export function strikeWindow(listed: readonly number[], spot: number, n = STRIKES_EACH_SIDE): { atm: number | null; strikes: number[] } {
  const sorted = [...new Set(listed.filter((k) => Number.isFinite(k) && k > 0))].sort((a, b) => a - b);
  const atm = nearestStrike(sorted, spot);
  if (atm === null) return { atm: null, strikes: [] };
  const i = sorted.indexOf(atm);
  return { atm, strikes: sorted.slice(Math.max(0, i - n), i + n + 1) };
}

export interface PlannedContract {
  contract: OptionContract;
  kind: ExpiryKind;
  /** Fetch order: 0 for the at-the-money legs (and, at the exit slots, the strikes sold earlier), then 1 and 2 strikes away. */
  priority: number;
}

export interface IndexPlan {
  index: IndexId;
  spot: number;
  expiries: { kind: ExpiryKind; expiry: string; atm: number }[];
  contracts: PlannedContract[];
  /** Why part of the plan is missing (no listed expiry, no strikes, a contract that does not resolve). */
  problems: string[];
}

/**
 * The contracts of one index for one snapshot, resolved from the instrument master (never formatted by
 * hand). `held(expiry)` returns the strikes to add at the exit slots.
 */
export async function planIndexSnapshot(o: {
  index: IndexId;
  spot: number;
  today: string;
  instruments: InstrumentProvider;
  held?: (expiry: string) => readonly number[];
  strikesEachSide?: number;
}): Promise<IndexPlan> {
  const plan: IndexPlan = { index: o.index, spot: o.spot, expiries: [], contracts: [], problems: [] };
  const expiries = recordedExpiries(await o.instruments.expiries(o.index), o.today);
  if (expiries.length === 0) plan.problems.push(`${o.index}: no listed expiry after ${o.today} in the instrument master`);
  for (const { kind, expiry } of expiries) {
    const listed = await o.instruments.strikes(o.index, expiry);
    const w = strikeWindow(listed, o.spot, o.strikesEachSide ?? STRIKES_EACH_SIDE);
    if (w.atm === null) {
      plan.problems.push(`${o.index} ${expiry}: no listed strikes`);
      continue;
    }
    const atm = w.atm;
    plan.expiries.push({ kind, expiry, atm });
    const sorted = [...new Set(listed)].sort((a, b) => a - b);
    const priority = new Map<number, number>();
    for (const k of w.strikes) priority.set(k, Math.abs(sorted.indexOf(k) - sorted.indexOf(atm)));
    for (const k of o.held?.(expiry) ?? []) if (sorted.includes(k)) priority.set(k, 0);
    for (const [strike, p] of [...priority].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
      for (const type of ["CE", "PE"] as const) {
        const contract = await o.instruments.resolve(o.index, expiry, strike, type);
        if (contract) plan.contracts.push({ contract, kind, priority: p });
        else plan.problems.push(`${o.index} ${expiry} ${strike} ${type}: not in the instrument master`);
      }
    }
  }
  return plan;
}

/** Every planned contract in fetch order: the at-the-money legs of every index and expiry first, a call and its put back to back. */
export function fetchOrder(plans: readonly IndexPlan[]): PlannedContract[] {
  const indexRank = new Map(plans.map((p, i) => [p.index, i]));
  const kindRank = (k: ExpiryKind) => (k === "next" ? 0 : 1);
  return plans
    .flatMap((p) => p.contracts)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (indexRank.get(a.contract.index) ?? 0) - (indexRank.get(b.contract.index) ?? 0) ||
        kindRank(a.kind) - kindRank(b.kind) ||
        a.contract.strike - b.contract.strike ||
        (a.contract.type === b.contract.type ? 0 : a.contract.type === "CE" ? -1 : 1),
    );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface QuoteRow {
  snapshotMs: number;
  slot: string;
  indexId: IndexId;
  expiry: string;
  expiryKind: ExpiryKind;
  strike: number;
  optionType: OptionType;
  tradingSymbol: string;
  lotSize: number;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  ltp: number | null;
  lastTradeMs: number | null;
  volume: number | null;
  oi: number | null;
  depth: string | null;
  spot: number | null;
  fetchedMs: number;
  source: string;
  schemaV: number;
}

export const QUOTE_COLUMNS = [
  "snapshot_ms",
  "slot",
  "index_id",
  "expiry",
  "expiry_kind",
  "strike",
  "option_type",
  "trading_symbol",
  "lot_size",
  "bid",
  "ask",
  "bid_qty",
  "ask_qty",
  "ltp",
  "last_trade_ms",
  "volume",
  "oi",
  "depth",
  "spot",
  "fetched_ms",
  "source",
  "schema_v",
] as const;

export const INSERT_QUOTES_SQL = `INSERT OR IGNORE INTO ${QUOTES_TABLE} (${QUOTE_COLUMNS.join(",")}) VALUES`;
/** D1 allows 100 bound parameters per statement: 4 rows of 22 columns. */
export const QUOTE_ROWS_PER_STATEMENT = Math.floor(100 / QUOTE_COLUMNS.length);

const positive = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
const nonNegative = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);

/** The top `levels` depth levels as compact JSON {"b":[[price,qty],...],"a":[[price,qty],...]}, or null without depth. */
export function compactDepth(depth: { buy: Level[]; sell: Level[] } | undefined, levels = 5): string | null {
  if (!depth) return null;
  const side = (ls: Level[]) => ls.filter((l) => l.price > 0 && l.qty > 0).slice(0, levels).map((l) => [l.price, l.qty]);
  const b = side(depth.buy);
  const a = side(depth.sell);
  return b.length > 0 || a.length > 0 ? JSON.stringify({ b, a }) : null;
}

export function toQuoteRow(o: { snapshotMs: number; slot: QuoteSlot; planned: PlannedContract; quote: Quote; lastTradeMs: number | null; spot: number | null }): QuoteRow {
  const { contract } = o.planned;
  const q = o.quote;
  return {
    snapshotMs: o.snapshotMs,
    slot: o.slot,
    indexId: contract.index,
    expiry: contract.expiry,
    expiryKind: o.planned.kind,
    strike: contract.strike,
    optionType: contract.type,
    tradingSymbol: contract.tradingSymbol,
    lotSize: contract.lotSize,
    bid: positive(q.bid),
    ask: positive(q.ask),
    bidQty: positive(q.bid) === null ? null : positive(q.bidQty),
    askQty: positive(q.ask) === null ? null : positive(q.askQty),
    ltp: positive(q.ltp),
    lastTradeMs: positive(o.lastTradeMs),
    volume: nonNegative(q.volume),
    oi: nonNegative(q.oi),
    depth: compactDepth(q.depth),
    spot: positive(o.spot),
    fetchedMs: q.t,
    source: QUOTE_SOURCE,
    schemaV: QUOTE_SCHEMA_VERSION,
  };
}

/** Bound values of a row, in QUOTE_COLUMNS order. */
export function quoteRowParams(r: QuoteRow): (string | number | null)[] {
  return [
    r.snapshotMs,
    r.slot,
    r.indexId,
    r.expiry,
    r.expiryKind,
    r.strike,
    r.optionType,
    r.tradingSymbol,
    r.lotSize,
    r.bid,
    r.ask,
    r.bidQty,
    r.askQty,
    r.ltp,
    r.lastTradeMs,
    r.volume,
    r.oi,
    r.depth,
    r.spot,
    r.fetchedMs,
    r.source,
    r.schemaV,
  ];
}

/** One multi-row INSERT OR IGNORE with `n` rows of placeholders. */
export function insertQuotesSql(n: number): string {
  const one = `(${QUOTE_COLUMNS.map(() => "?").join(",")})`;
  return `${INSERT_QUOTES_SQL} ${Array.from({ length: n }, () => one).join(",")}`;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A row read back from D1 (snake_case columns). */
export function quoteRowFromDb(r: Record<string, unknown>): QuoteRow {
  return {
    snapshotMs: Number(r.snapshot_ms),
    slot: String(r.slot),
    indexId: String(r.index_id) as IndexId,
    expiry: String(r.expiry),
    expiryKind: String(r.expiry_kind) === "expiring" ? "expiring" : "next",
    strike: Number(r.strike),
    optionType: String(r.option_type) === "PE" ? "PE" : "CE",
    tradingSymbol: String(r.trading_symbol),
    lotSize: Number(r.lot_size),
    bid: numOrNull(r.bid),
    ask: numOrNull(r.ask),
    bidQty: numOrNull(r.bid_qty),
    askQty: numOrNull(r.ask_qty),
    ltp: numOrNull(r.ltp),
    lastTradeMs: numOrNull(r.last_trade_ms),
    volume: numOrNull(r.volume),
    oi: numOrNull(r.oi),
    depth: r.depth === null || r.depth === undefined ? null : String(r.depth),
    spot: numOrNull(r.spot),
    fetchedMs: Number(r.fetched_ms),
    source: String(r.source),
    schemaV: Number(r.schema_v),
  };
}

/**
 * One page of rows in (snapshot_ms, trading_symbol) order after `after`, as literal SQL for
 * `wrangler d1 execute --command` (numbers only, and the symbol quoted). Manual snapshots are left out
 * unless asked for.
 */
export function quotesPageSql(after: { snapshotMs: number; symbol: string } | null, o: { fromMs?: number; toMs?: number; limit: number; includeManual?: boolean }): string {
  const where: string[] = [];
  if (after) where.push(`(snapshot_ms > ${Math.floor(after.snapshotMs)} OR (snapshot_ms = ${Math.floor(after.snapshotMs)} AND trading_symbol > '${after.symbol.replaceAll("'", "''")}'))`);
  if (o.fromMs !== undefined) where.push(`snapshot_ms >= ${Math.floor(o.fromMs)}`);
  if (o.toMs !== undefined) where.push(`snapshot_ms < ${Math.floor(o.toMs)}`);
  if (!o.includeManual) where.push(`slot != '${MANUAL_SLOT}'`);
  const cond = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return `SELECT ${QUOTE_COLUMNS.join(",")} FROM ${QUOTES_TABLE}${cond} ORDER BY snapshot_ms, trading_symbol LIMIT ${Math.max(1, Math.floor(o.limit))}`;
}
