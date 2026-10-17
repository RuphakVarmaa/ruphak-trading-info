/**
 * The "next 30 days" options outlook: what each listed expiry's option prices imply, from the engine's
 * option chains (pure, no I/O; unit-tested in outlook.test.ts on a real Upstox chain and the mock chain).
 *
 * The one priced-move number is the ATM straddle (call + put at the ATM strike). A straddle bought now
 * breaks even at expiry if the index ends outside ATM ± straddle, so that is the range shown. Under
 * Black-Scholes the ATM straddle is about 0.8 × S·σ√T (the expected absolute move), so straddle ÷ 0.8 is a
 * model's 1σ; it is offered as a tooltip only. Nothing here is a probability, a forecast or advice.
 */
import type { ImpactLevel, IndexId, OptionChainRowView, OptionChainView, OptionSideView, ScheduledEventKind, ScheduledEventView } from "@/engine/api-types";
import { DAY_MS, addDays, istAt, istDate, istMidnight, istParts, SESSION, toIstIso } from "@/lib/ist";

/** Calendar days ahead the outlook covers. */
export const OUTLOOK_HORIZON_DAYS = 30;
/** Hours of scheduled events to ask for (the engine clamps to 720 h = 30 days). */
export const OUTLOOK_EVENT_HOURS = 720;
/** ATM straddle ≈ 0.8 × a model's 1σ move (√(2/π) ≈ 0.798 under Black-Scholes). Tooltip only. */
export const ONE_SIGMA_FACTOR = 0.8;
/** A side is priced at its bid/ask mid when the spread is at most this % of the mid, else at its LTP. */
export const MAX_MID_SPREAD_PCT = 5;
/** Strikes listed per wall (support / resistance). */
export const WALL_STRIKES = 3;

/** What the outlook needs from the trading calendar (TradingCalendar provides it). */
export interface OutlookCalendar {
  isTradingDay(date: string): boolean;
  /** The weekly expiry after `expiry` (the following week's contract). */
  followingExpiry(index: IndexId, expiry: string): string;
}

export type PriceBasis = "mid" | "ltp";

export interface Straddle {
  ce: number;
  pe: number;
  total: number;
  /** "mid" when both sides are bid/ask mids, "ltp" when both are last trades, "mixed" otherwise. */
  basis: PriceBasis | "mixed";
}

export interface OutlookWall {
  strike: number;
  oi: number;
}

export type OutlookEvent = Pick<ScheduledEventView, "id" | "title" | "at" | "approx"> & { kind: ScheduledEventKind; impact: ImpactLevel };

export interface OutlookExpiry {
  /** YYYY-MM-DD. */
  expiry: string;
  /** The month's last expiry (the monthly contract). */
  monthly: boolean;
  /** Past the 30-day horizon: the first monthly, added because no monthly falls inside it. */
  beyondHorizon: boolean;
  /** Calendar days from today (IST) to the expiry date; 0 on expiry day. */
  days: number;
  /** Trading sessions left until expiry, counting today's while it has not closed. */
  sessions: number;
  /** The index level the chain was read at. */
  spot: number | null;
  atmStrike: number | null;
  straddle: Straddle | null;
  /** Straddle as % of the spot. */
  movePct: number | null;
  /** ATM strike ∓ straddle: where a straddle bought now breaks even at expiry. */
  range: { low: number; high: number } | null;
  /** movePct ÷ 0.8: a Black-Scholes 1σ move. Tooltip only. */
  oneSigmaPct: number | null;
  /** Mean of the ATM call and put IV (percent), Upstox's estimate. */
  atmIv: number | null;
  pcr: number | null;
  maxPain: number | null;
  /** Strikes with the most put OI (often read as support), most first. */
  support: OutlookWall[];
  /** Strikes with the most call OI (often read as resistance), most first. */
  resistance: OutlookWall[];
  /** Net open interest change since the previous session's close, summed over every strike; null when not reported. */
  oiChange: { ce: number | null; pe: number | null };
  /** Scheduled events (expiries left out) between now and this expiry's close. */
  events: OutlookEvent[];
  /** False when the expiry closes after the end of the event list (events are known 30 days ahead only). */
  eventsComplete: boolean;
  /** When the engine read this expiry's chain (ISO, IST); null before the first read. */
  fetchedAt: string | null;
  /** Why the figures are missing, or why the latest refresh failed (the previous figures are then kept). */
  error: string | null;
  /** The figures are the last good reading, kept after a failed refresh. */
  stale: boolean;
}

export interface OptionOutlookView {
  index: IndexId;
  /** The index level at the freshest chain read; null without one. */
  spot: number | null;
  /** When the freshest chain in it was read (ISO, IST); the engine's time now when none was. */
  asOf: string;
  horizonDays: number;
  source: "upstox" | "mock" | null;
  expiries: OutlookExpiry[];
  /** Scheduled events in the horizon for this index (expiries left out); null when they could not be read. */
  events: OutlookEvent[] | null;
  /** Expiries in the horizon not read yet (later requests fill them in, two at a time). */
  pending: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const pos = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

/** One side's price: the bid/ask mid when the spread is tight, else the last trade; null when neither is usable. */
export function sidePrice(s: OptionSideView | null | undefined, maxSpreadPct = MAX_MID_SPREAD_PCT): { price: number; basis: PriceBasis } | null {
  if (!s) return null;
  if (pos(s.bid) && pos(s.ask) && s.ask >= s.bid) {
    const mid = (s.bid + s.ask) / 2;
    if (((s.ask - s.bid) / mid) * 100 <= maxSpreadPct) return { price: round2(mid), basis: "mid" };
  }
  return pos(s.ltp) ? { price: s.ltp, basis: "ltp" } : null;
}

/** Call + put at one strike; null unless both sides have a usable price. */
export function straddleAt(row: OptionChainRowView | null | undefined, maxSpreadPct = MAX_MID_SPREAD_PCT): Straddle | null {
  const ce = sidePrice(row?.ce, maxSpreadPct);
  const pe = sidePrice(row?.pe, maxSpreadPct);
  if (!ce || !pe) return null;
  return { ce: ce.price, pe: pe.price, total: round2(ce.price + pe.price), basis: ce.basis === pe.basis ? ce.basis : "mixed" };
}

/** Mean of the call and put IV at one strike (Upstox's put IV runs above the call's), or the one reported. */
export function atmIv(row: OptionChainRowView | null | undefined): number | null {
  const ivs = [row?.ce?.iv, row?.pe?.iv].filter(pos);
  return ivs.length === 0 ? null : round2(ivs.reduce((a, b) => a + b, 0) / ivs.length);
}

/** The `n` strikes with the most open interest on one side, most first (the lower strike on a tie). */
export function topOi(rows: readonly OptionChainRowView[], side: "ce" | "pe", n = WALL_STRIKES): OutlookWall[] {
  return rows
    .map((r) => ({ strike: r.strike, oi: r[side]?.oi ?? 0 }))
    .filter((w) => w.oi > 0)
    .sort((a, b) => b.oi - a.oi || a.strike - b.strike)
    .slice(0, n);
}

/** Net OI change since the previous close per side, over every strike; null for a side with none reported. */
export function oiChangeTotals(rows: readonly OptionChainRowView[]): { ce: number | null; pe: number | null } {
  const sum = (side: "ce" | "pe") => {
    let total: number | null = null;
    for (const r of rows) {
      const c = r[side]?.oiChange;
      if (c != null && Number.isFinite(c)) total = (total ?? 0) + c;
    }
    return total;
  };
  return { ce: sum("ce"), pe: sum("pe") };
}

// ---------------------------------------------------------------------------
// Expiries and the calendar
// ---------------------------------------------------------------------------

const month = (date: string) => date.slice(0, 7);

/**
 * The monthly expiries among the listed ones: each month's last listed expiry, when a later month is also
 * listed (the exchange lists weeklies first, then monthlies further out). Where no later month is listed,
 * the calendar decides: an expiry is monthly when the following week's expiry falls in the next month.
 */
export function monthlyExpiries(listed: readonly string[], index: IndexId, calendar: OutlookCalendar): Set<string> {
  const sorted = [...new Set(listed)].sort();
  const out = new Set<string>();
  sorted.forEach((e, i) => {
    const next = sorted[i + 1];
    if (next != null) {
      if (month(next) !== month(e)) out.add(e);
      return;
    }
    try {
      if (month(calendar.followingExpiry(index, e)) !== month(e)) out.add(e);
    } catch {
      // The calendar cannot tell: leave it unflagged.
    }
  });
  return out;
}

/** True once today's session (15:30 IST) is over. */
const afterClose = (nowMs: number) => istParts(nowMs).minutesOfDay >= SESSION.close;

/**
 * The listed expiries the outlook covers: from the nearest still trading (today's counts until 15:30 IST)
 * up to `horizonDays` calendar days ahead, ascending. When none of them is a monthly, the first monthly
 * after the horizon is added (flagged `beyondHorizon`).
 */
export function outlookExpiries(
  listed: readonly string[],
  nowMs: number,
  index: IndexId,
  calendar: OutlookCalendar,
  horizonDays = OUTLOOK_HORIZON_DAYS,
): { expiry: string; monthly: boolean; beyondHorizon: boolean }[] {
  const today = istDate(nowMs);
  const closed = afterClose(nowMs);
  const last = addDays(today, horizonDays);
  const monthly = monthlyExpiries(listed, index, calendar);
  const live = [...new Set(listed)].sort().filter((e) => e > today || (e === today && !closed));
  const inside = live.filter((e) => e <= last).map((expiry) => ({ expiry, monthly: monthly.has(expiry), beyondHorizon: false }));
  if (inside.some((e) => e.monthly)) return inside;
  const nextMonthly = live.find((e) => e > last && monthly.has(e));
  return nextMonthly ? [...inside, { expiry: nextMonthly, monthly: true, beyondHorizon: true }] : inside;
}

/** Calendar days from today (IST) to the expiry date. */
export function daysToExpiry(nowMs: number, expiry: string): number {
  return Math.max(0, Math.round((istMidnight(expiry) - istMidnight(istDate(nowMs))) / DAY_MS));
}

/** Trading sessions from now to the expiry, inclusive of the expiry day and of today's session while it has not closed. */
export function sessionsLeft(nowMs: number, expiry: string, calendar: Pick<OutlookCalendar, "isTradingDay">): number {
  const today = istDate(nowMs);
  if (expiry < today) return 0;
  let n = calendar.isTradingDay(today) && !afterClose(nowMs) ? 1 : 0;
  for (let d = addDays(today, 1), i = 0; d <= expiry && i < 400; d = addDays(d, 1), i++) if (calendar.isTradingDay(d)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Scheduled events for an index in (fromMs, toMs], expiries left out (each row is an expiry already), by time. */
export function outlookEvents(scheduled: readonly ScheduledEventView[], index: IndexId, fromMs: number, toMs: number): OutlookEvent[] {
  return scheduled
    .filter((e) => e.kind !== "EXPIRY" && (e.indices.length === 0 || e.indices.includes(index)))
    .filter((e) => {
      const at = Date.parse(e.at);
      return Number.isFinite(at) && at > fromMs && at <= toMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(({ id, title, kind, at, impact, approx }) => ({ id, title, kind, at, impact, approx }));
}

/** The expiry's close (15:30 IST), when its options stop trading. */
export const expiryCloseMs = (expiry: string) => istAt(expiry, SESSION.close);

// ---------------------------------------------------------------------------
// One expiry and the whole outlook
// ---------------------------------------------------------------------------

export interface ExpiryContext {
  nowMs: number;
  index: IndexId;
  calendar: OutlookCalendar;
  monthly: boolean;
  beyondHorizon: boolean;
  /** This index's events from now on (outlookEvents), or null when they could not be read. */
  events: OutlookEvent[] | null;
  /** The last moment the event list covers. */
  eventsUntilMs: number;
}

function blankExpiry(expiry: string, ctx: ExpiryContext, error: string | null): OutlookExpiry {
  const close = expiryCloseMs(expiry);
  return {
    expiry,
    monthly: ctx.monthly,
    beyondHorizon: ctx.beyondHorizon,
    days: daysToExpiry(ctx.nowMs, expiry),
    sessions: sessionsLeft(ctx.nowMs, expiry, ctx.calendar),
    spot: null,
    atmStrike: null,
    straddle: null,
    movePct: null,
    range: null,
    oneSigmaPct: null,
    atmIv: null,
    pcr: null,
    maxPain: null,
    support: [],
    resistance: [],
    oiChange: { ce: null, pe: null },
    events: (ctx.events ?? []).filter((e) => Date.parse(e.at) <= close),
    eventsComplete: ctx.events != null && close <= ctx.eventsUntilMs,
    fetchedAt: null,
    error,
    stale: false,
  };
}

/** An expiry with no chain read yet (or none that worked): calendar facts and events only. */
export function missingExpiry(expiry: string, ctx: ExpiryContext, error: string | null): OutlookExpiry {
  return blankExpiry(expiry, ctx, error);
}

/** One expiry's figures from its chain. A chain with an error or no rows gives calendar facts and the error only. */
export function expiryOutlook(chain: OptionChainView, ctx: ExpiryContext): OutlookExpiry {
  const base = blankExpiry(chain.expiry, ctx, null);
  base.fetchedAt = chain.fetchedAt;
  if (chain.error || chain.rows.length === 0) return { ...base, error: chain.error ?? "The chain came back with no strikes." };
  const spot = pos(chain.spot) ? chain.spot : null;
  const atm = pos(chain.atmStrike) ? chain.atmStrike : null;
  const row = atm != null ? chain.rows.find((r) => r.strike === atm) : undefined;
  const straddle = straddleAt(row);
  const movePct = straddle && spot ? round2((straddle.total / spot) * 100) : null;
  return {
    ...base,
    spot,
    atmStrike: atm,
    straddle,
    movePct,
    range: straddle && atm != null ? { low: round2(atm - straddle.total), high: round2(atm + straddle.total) } : null,
    oneSigmaPct: movePct != null ? round2(movePct / ONE_SIGMA_FACTOR) : null,
    atmIv: atmIv(row),
    pcr: chain.pcr,
    maxPain: chain.maxPain,
    support: topOi(chain.rows, "pe"),
    resistance: topOi(chain.rows, "ce"),
    oiChange: oiChangeTotals(chain.rows),
  };
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "2026-10-27" -> "27 Oct". */
export function dayMonth(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

/** "2026-10-27" -> "Tue". */
export function weekdayShort(date: string): string {
  return WEEKDAYS[istParts(istMidnight(date) + 12 * 3_600_000).weekday - 1] ?? "";
}

const grouped = (n: number) => Math.round(n).toLocaleString("en-IN");

/** The expiry the headline speaks about: the first priced monthly, else the farthest priced expiry. */
export function headlineExpiry(rows: readonly OutlookExpiry[]): OutlookExpiry | null {
  const priced = rows.filter((r) => r.movePct != null && r.range != null);
  return priced.find((r) => r.monthly) ?? priced[priced.length - 1] ?? null;
}

/**
 * One plain sentence per index, e.g. "Option prices imply a move of about ±2.0% for NIFTY by the 27 Oct
 * monthly expiry: 22,500 to 23,400." Null when no expiry is priced.
 */
export function outlookHeadline(index: IndexId, rows: readonly OutlookExpiry[]): string | null {
  const r = headlineExpiry(rows);
  if (!r || r.movePct == null || !r.range) return null;
  const kind = r.monthly ? "monthly expiry" : "expiry";
  return `Option prices imply a move of about ±${r.movePct.toFixed(1)}% for ${index} by the ${dayMonth(r.expiry)} ${kind}: ${grouped(r.range.low)} to ${grouped(r.range.high)}.`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** What is known about one expiry's chain: the last good chain (if any), and the latest refresh's error. */
export interface ChainReading {
  chain: OptionChainView | null;
  error: string | null;
}

export interface BuildOutlookInput {
  index: IndexId;
  /** The engine's clock (the mock runs its own). */
  nowMs: number;
  /** Every listed expiry (OptionChainView.expiries). */
  listed: readonly string[];
  /** Per expiry; a missing entry means not read yet. */
  readings: ReadonlyMap<string, ChainReading>;
  /** The engine's scheduled events, or null when they could not be read. */
  scheduled: readonly ScheduledEventView[] | null;
  calendar: OutlookCalendar;
  horizonDays?: number;
  /** A problem with the outlook as a whole (e.g. no expiry list). */
  error?: string | null;
}

/** The outlook for one index from whatever chains have been read. Missing figures stay null ("no data"). */
export function buildOutlook(input: BuildOutlookInput): OptionOutlookView {
  const { index, nowMs, calendar } = input;
  const horizonDays = input.horizonDays ?? OUTLOOK_HORIZON_DAYS;
  const eventsUntilMs = nowMs + OUTLOOK_EVENT_HOURS * 3_600_000;
  const events = input.scheduled ? outlookEvents(input.scheduled, index, nowMs, eventsUntilMs) : null;
  const targets = outlookExpiries(input.listed, nowMs, index, calendar, horizonDays);
  let pending = 0;
  let freshest: OptionChainView | null = null;
  const expiries = targets.map((t) => {
    const ctx: ExpiryContext = { nowMs, index, calendar, monthly: t.monthly, beyondHorizon: t.beyondHorizon, events, eventsUntilMs };
    const reading = input.readings.get(t.expiry);
    if (!reading) {
      pending++;
      return missingExpiry(t.expiry, ctx, null);
    }
    if (!reading.chain) return missingExpiry(t.expiry, ctx, reading.error ?? "No chain was read for this expiry.");
    const chain = reading.chain;
    if (!freshest || Date.parse(chain.fetchedAt) > Date.parse(freshest.fetchedAt)) freshest = chain;
    const row = expiryOutlook(chain, ctx);
    return reading.error ? { ...row, error: reading.error, stale: true } : row;
  });
  const best = freshest as OptionChainView | null;
  return {
    index,
    spot: best && pos(best.spot) ? best.spot : null,
    asOf: best?.fetchedAt ?? toIstIso(nowMs),
    horizonDays,
    source: best?.source ?? null,
    expiries,
    events,
    pending,
    error: input.error ?? null,
  };
}
