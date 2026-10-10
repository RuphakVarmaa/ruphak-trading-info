/**
 * Trading calendar for NSE/BSE index options: trading days, session phases, weekly expiries
 * (holiday-shifted to the previous trading day, as the exchanges do) and scheduled macro events.
 */
import { DEFAULT_CONFIG, type IndexSpec } from "../config";
import {
  addDays,
  daysBetween,
  istAt,
  istDate,
  istMinutes,
  MINUTE_MS,
  SESSION,
  weekdayOf,
} from "../clock";
import type { ImpactLevel, IndexId, ScheduledEvent, ScheduledEventKind, SessionPhase } from "../types";
import holidaysJson from "./holidays.json";
import econJson from "./econ-events.json";

export interface HolidayEntry {
  date: string;
  name: string;
  provisional?: boolean;
}

export interface CalendarOverride {
  date: string;
  /** true = force open (special session), false = force closed. */
  open: boolean;
  note?: string;
}

interface EconJsonEvent {
  id: string;
  kind: string;
  title: string;
  at: string;
  impact: string;
  approx?: boolean;
  indices?: string[];
}

const ALL_INDICES: IndexId[] = ["NIFTY", "SENSEX"];

export function loadBundledHolidays(): HolidayEntry[] {
  return (holidaysJson as { holidays: HolidayEntry[] }).holidays.map((h) => ({ ...h }));
}

export function loadBundledEvents(): ScheduledEvent[] {
  return (econJson as { events: EconJsonEvent[] }).events.map((e) => {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) throw new Error(`Invalid event time for ${e.id}: ${e.at}`);
    return {
      id: e.id,
      kind: e.kind as ScheduledEventKind,
      title: e.title,
      at,
      impact: e.impact as ImpactLevel,
      approx: e.approx ?? false,
      indices: (e.indices as IndexId[] | undefined) ?? ALL_INDICES,
    };
  });
}

export interface TradingCalendarOptions {
  holidays?: HolidayEntry[];
  overrides?: CalendarOverride[];
  events?: ScheduledEvent[];
  indexSpecs?: Record<IndexId, IndexSpec>;
}

export class TradingCalendar {
  private readonly holidays: Map<string, HolidayEntry>;
  private readonly overrides: Map<string, CalendarOverride>;
  private readonly events: ScheduledEvent[];
  private readonly specs: Record<IndexId, IndexSpec>;

  constructor(opts: TradingCalendarOptions = {}) {
    this.holidays = new Map((opts.holidays ?? loadBundledHolidays()).map((h) => [h.date, h]));
    this.overrides = new Map((opts.overrides ?? []).map((o) => [o.date, o]));
    this.events = [...(opts.events ?? loadBundledEvents())].sort((a, b) => a.at - b.at);
    this.specs = opts.indexSpecs ?? DEFAULT_CONFIG.indexSpecs;
  }

  /** Returns a copy with dashboard overrides applied (later entries win). */
  withOverrides(overrides: CalendarOverride[]): TradingCalendar {
    return new TradingCalendar({
      holidays: [...this.holidays.values()],
      overrides: [...this.overrides.values(), ...overrides],
      events: this.events,
      indexSpecs: this.specs,
    });
  }

  isTradingDay(date: string): boolean {
    const o = this.overrides.get(date);
    if (o) return o.open;
    const wd = weekdayOf(date);
    if (wd >= 6) return false;
    return !this.holidays.has(date);
  }

  holidayName(date: string): string | null {
    const o = this.overrides.get(date);
    if (o) return o.open ? null : o.note ?? "Exchange holiday (override)";
    const h = this.holidays.get(date);
    if (h) return h.name;
    return weekdayOf(date) >= 6 ? "Weekend" : null;
  }

  isProvisional(date: string): boolean {
    return this.holidays.get(date)?.provisional === true;
  }

  sessionPhase(ms: number): SessionPhase {
    const date = istDate(ms);
    if (!this.isTradingDay(date)) return "HOLIDAY";
    const m = istMinutes(ms);
    if (m >= SESSION.preOpenStart && m < SESSION.open) return "PRE_OPEN";
    if (m >= SESSION.open && m < SESSION.close) return "OPEN";
    return "CLOSED";
  }

  isSessionOpen(ms: number): boolean {
    return this.sessionPhase(ms) === "OPEN";
  }

  /** First trading day strictly after `date`. */
  nextTradingDay(date: string): string {
    let d = addDays(date, 1);
    for (let i = 0; i < 30; i++) {
      if (this.isTradingDay(d)) return d;
      d = addDays(d, 1);
    }
    throw new Error(`No trading day within 30 days after ${date}`);
  }

  /** Last trading day strictly before `date`. */
  prevTradingDay(date: string): string {
    let d = addDays(date, -1);
    for (let i = 0; i < 30; i++) {
      if (this.isTradingDay(d)) return d;
      d = addDays(d, -1);
    }
    throw new Error(`No trading day within 30 days before ${date}`);
  }

  /** Number of trading days d with from < d <= to (0 when to <= from). */
  tradingDaysBetween(from: string, to: string): number {
    if (to <= from) return 0;
    let n = 0;
    let d = from;
    const span = daysBetween(from, to);
    for (let i = 0; i < span; i++) {
      d = addDays(d, 1);
      if (this.isTradingDay(d)) n++;
    }
    return n;
  }

  /** Session open (09:15 IST) epoch ms for a date. */
  openMs(date: string): number {
    return istAt(date, SESSION.open);
  }

  /** Session close (15:30 IST) epoch ms for a date. */
  closeMs(date: string): number {
    return istAt(date, SESSION.close);
  }

  /** Next session open at or after `ms` (today's open if the session has not started yet). */
  nextOpenMs(ms: number): number {
    const today = istDate(ms);
    if (this.isTradingDay(today) && istMinutes(ms) < SESSION.open) return this.openMs(today);
    return this.openMs(this.nextTradingDay(today));
  }

  /** Close of the current or next session at or after `ms`. */
  nextCloseMs(ms: number): number {
    const today = istDate(ms);
    if (this.isTradingDay(today) && istMinutes(ms) < SESSION.close) return this.closeMs(today);
    return this.closeMs(this.nextTradingDay(today));
  }

  /** The most recent session close strictly before `ms`. */
  prevCloseMs(ms: number): number {
    const today = istDate(ms);
    if (this.isTradingDay(today) && istMinutes(ms) >= SESSION.close) return this.closeMs(today);
    return this.closeMs(this.prevTradingDay(today));
  }

  /**
   * Weekly expiry date for the week whose nominal expiry weekday falls on or after `date`.
   * When the nominal day is a holiday the contract expires on the previous trading day.
   */
  expiryOnOrAfter(index: IndexId, date: string): string {
    const wd = this.specs[index].weeklyExpiryWeekday;
    const delta = (wd - weekdayOf(date) + 7) % 7;
    const nominal = addDays(date, delta);
    return this.isTradingDay(nominal) ? nominal : this.prevTradingDay(nominal);
  }

  /**
   * Nearest weekly expiry that has not finished trading at `ms`.
   * On expiry day before 15:30 IST this is today.
   */
  nextExpiry(index: IndexId, ms: number): string {
    const today = istDate(ms);
    const afterClose = istMinutes(ms) >= SESSION.close;
    const wd = this.specs[index].weeklyExpiryWeekday;
    let probe = today;
    for (let i = 0; i < 6; i++) {
      const exp = this.expiryOnOrAfter(index, probe);
      if (exp > today || (exp === today && !afterClose && this.isTradingDay(today))) return exp;
      // Step past this week's nominal expiry weekday and look at the following week.
      const nominal = addDays(probe, (wd - weekdayOf(probe) + 7) % 7);
      probe = addDays(nominal, 1);
    }
    throw new Error(`Could not find the next ${index} expiry after ${today}`);
  }

  /** The weekly expiry after `expiry` (the following week's contract). */
  followingExpiry(index: IndexId, expiry: string): string {
    const wd = this.specs[index].weeklyExpiryWeekday;
    // Nominal weekday of the contract that expired (or expires) on `expiry`.
    const nominal = addDays(expiry, (wd - weekdayOf(expiry) + 7) % 7);
    return this.expiryOnOrAfter(index, addDays(nominal, 1));
  }

  expiriesBetween(index: IndexId, fromDate: string, toDate: string): string[] {
    const out: string[] = [];
    let probe = fromDate;
    for (let i = 0; i < 60 && probe <= toDate; i++) {
      const exp = this.expiryOnOrAfter(index, probe);
      if (exp >= fromDate && exp <= toDate && !out.includes(exp)) out.push(exp);
      probe = addDays(probe, 7);
    }
    return out.sort();
  }

  isExpiryDay(index: IndexId, date: string): boolean {
    return this.isTradingDay(date) && this.expiryOnOrAfter(index, date) === date;
  }

  /** Scheduled macro events plus generated weekly-expiry events in [fromMs, toMs], sorted by time. */
  scheduledEvents(fromMs: number, toMs: number, opts: { includeExpiries?: boolean } = {}): ScheduledEvent[] {
    const out = this.events.filter((e) => e.at >= fromMs && e.at <= toMs);
    if (opts.includeExpiries !== false) {
      const fromDate = istDate(fromMs);
      const toDate = istDate(toMs);
      for (const index of ALL_INDICES) {
        for (const exp of this.expiriesBetween(index, fromDate, toDate)) {
          const at = this.closeMs(exp);
          if (at < fromMs || at > toMs) continue;
          out.push({
            id: `expiry-${index.toLowerCase()}-${exp}`,
            kind: "EXPIRY",
            title: `${index} weekly expiry`,
            at,
            impact: "MED",
            indices: [index],
          });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Next macro event (expiries excluded) at or after `ms` with one of the given impacts. */
  nextScheduledEvent(ms: number, impacts: ImpactLevel[] = ["HIGH", "MED"]): ScheduledEvent | null {
    return this.events.find((e) => e.at >= ms && impacts.includes(e.impact)) ?? null;
  }

  /** Most recent macro event within `withinMin` minutes before `ms`. */
  recentScheduledEvent(ms: number, withinMin: number, impacts: ImpactLevel[] = ["HIGH", "MED"]): ScheduledEvent | null {
    let found: ScheduledEvent | null = null;
    for (const e of this.events) {
      if (e.at > ms) break;
      if (ms - e.at <= withinMin * MINUTE_MS && impacts.includes(e.impact)) found = e;
    }
    return found;
  }

  /** Macro events since the previous session close (they drive the opening gap). */
  eventsSinceLastClose(ms: number): ScheduledEvent[] {
    const from = this.prevCloseMs(ms);
    return this.events.filter((e) => e.at > from && e.at <= ms);
  }
}

/** Calendar built from the bundled holiday and event data. */
export const defaultCalendar = new TradingCalendar();
