/**
 * WP6 research on real exchange end-of-day option prices (the bhavcopy cache written by
 * scripts/fetch-bhavcopy.ts). Research only: nothing here changes the engine's behaviour.
 *
 *   npx tsx scripts/research/real_prices.ts coverage
 *   npx tsx scripts/research/real_prices.ts replicate                       # Bhat-Pandey-Rao (2024) day/night returns
 *   npx tsx scripts/research/real_prices.ts calibrate --fit-to 2026-06-30   # IV multiplier, skew, spread diagnostics
 *   npx tsx scripts/research/real_prices.ts sanity --bt <backtest.json> --history <snapshot.json>
 *   options: --from 2019-01-01 --to 2026-10-08  --dir .cache/bhavcopy  --out reports/wp6
 *
 * Conventions (stated in reports/wp6-real-prices.md):
 *  - "open" = the contract's first trade of the day (options have no pre-open auction);
 *    "close" = NSE's closing price (VWAP of the last 30 minutes, 15:00-15:30, from 3 Aug 2026 15:10-15:40)
 *    or BSE's published close; neither is a single tradeable quote.
 *  - ATM = listed strike nearest the index level known at entry (Yahoo daily open for day legs, the
 *    official index close for night legs), nearest weekly that does not expire that day (the engine's rule).
 *  - Time to expiry uses the engine's trading-time clock (yearsToExpiry, 375-minute sessions) with
 *    holidays inferred from the NSE archive (weekdays without a file).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  dayRangeCheck,
  inferHolidays,
  loadRealPriceBook,
  nearestStrike,
  parityForward,
  resolveOptionRow,
  settledClose,
  shortSessions,
  type BhavExchange,
  type BhavOptionType,
  type BhavRow,
  type RealPriceBook,
} from "../../src/engine/backtest/realPrices";
import { computeCharges } from "../../src/engine/broker/charges";
import { TradingCalendar, loadBundledHolidays } from "../../src/engine/calendar/calendar";
import { addDays, daysBetween, istAt, istDate } from "../../src/engine/clock";
import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../../src/engine/config";
import { bsGreeks, bsPrice, impliedVol } from "../../src/engine/pricing/blackScholes";
import { yearsToExpiry } from "../../src/engine/pricing/timeToExpiry";
import type { Candle } from "../../src/engine/types";
import { ROOT, fail, num, parseArgs, str, table } from "../lib/node";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface ResearchIndex {
  id: "NIFTY" | "SENSEX";
  exchange: BhavExchange;
  yahoo: string;
  step: number;
}

export const RESEARCH_INDICES: readonly ResearchIndex[] = [
  { id: "NIFTY", exchange: "NSE", yahoo: "^NSEI", step: 50 },
  { id: "SENSEX", exchange: "BSE", yahoo: "^BSESN", step: 100 },
];

export interface ResearchData {
  book: RealPriceBook;
  loaded: Record<BhavExchange, string[]>;
  /** Yahoo daily candles by symbol and IST date. */
  daily: Map<string, Map<string, Candle>>;
  calendar: TradingCalendar;
  /** Short special sessions (Muhurat, DR drills) excluded from return studies. */
  special: Set<string>;
  inferredHolidays: string[];
  cfg: EngineConfig;
}

/** Loads NIFTY and SENSEX options (expiries within 45 days) and futures plus Yahoo daily bars. */
export async function loadResearchData(o: { from: string; to: string; dir?: string }): Promise<ResearchData> {
  const dir = resolve(ROOT, o.dir ?? ".cache/bhavcopy");
  const reader = {
    read: async (p: string) => {
      const f = resolve(dir, p);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
  };
  const keep = new Set(RESEARCH_INDICES.map((i) => i.id as string));
  const { book, loaded } = await loadRealPriceBook(reader, {
    from: o.from,
    to: o.to,
    filter: (r) => keep.has(r.symbol) && (r.kind === "FUT" || daysBetween(r.date, r.expiry) <= 45),
  });
  const dailyPath = resolve(dir, "index-daily.json");
  const raw = existsSync(dailyPath) ? (JSON.parse(readFileSync(dailyPath, "utf8")) as { series: Record<string, Candle[]> }) : null;
  const daily = new Map<string, Map<string, Candle>>();
  for (const [sym, arr] of Object.entries(raw?.series ?? {})) daily.set(sym, new Map(arr.map((c) => [istDate(c.t), c])));
  const nse = book.dates("NIFTY");
  const first = nse[0] ?? o.from;
  const last = nse.at(-1) ?? o.to;
  const inferredHolidays = inferHolidays(nse, first, last);
  const calendar = new TradingCalendar({
    holidays: [
      ...inferredHolidays.map((date) => ({ date, name: "no NSE bhavcopy" })),
      ...loadBundledHolidays().filter((h) => h.date > last),
    ],
  });
  // Short sessions are found on NIFTY's volume and applied to both exchanges (same session calendar).
  const special = new Set(shortSessions(book, "NIFTY"));
  return { book, loaded, daily, calendar, special, inferredHolidays, cfg: DEFAULT_CONFIG };
}

function candle(data: ResearchData, yahoo: string, date: string): Candle | undefined {
  return data.daily.get(yahoo)?.get(date);
}

/** Index open on a date (Yahoo daily). */
export function spotOpen(data: ResearchData, idx: ResearchIndex, date: string): number | null {
  const c = candle(data, idx.yahoo, date);
  return c && c.o > 0 ? c.o : null;
}

/** Official index close: NSE's UndrlygPric when present, else Yahoo daily close. */
export function spotClose(data: ResearchData, idx: ResearchIndex, date: string): number | null {
  const u = data.book.rows(idx.id, date).find((r) => r.underlying !== null && r.underlying > 0)?.underlying;
  if (u) return u;
  const c = candle(data, idx.yahoo, date);
  return c && c.c > 0 ? c.c : null;
}

export function vixOn(data: ResearchData, date: string, field: "o" | "c"): number | null {
  const c = candle(data, "^INDIAVIX", date);
  const v = c?.[field];
  return v !== undefined && v > 0 ? v : null;
}

/** Trading-time years from `hhmm` IST on `date` to the expiry close (the engine's clock). */
export function tYears(data: ResearchData, date: string, hhmm: string, expiry: string): number {
  return yearsToExpiry(istAt(date, hhmm), expiry, data.calendar, data.cfg);
}

/** First listed expiry strictly after `date` (the engine never buys the contract expiring today). */
export function nextExpiry(book: RealPriceBook, symbol: string, date: string): string | undefined {
  return book.expiries(symbol, date).find((e) => e > date);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface Stats {
  n: number;
  mean: number;
  se: number;
  t: number;
  median: number;
  hit: number;
  p05: number;
  min: number;
}

export function stats(xs: number[]): Stats {
  const v = xs.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0, mean: NaN, se: NaN, t: NaN, median: NaN, hit: NaN, p05: NaN, min: NaN };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  const se = sd / Math.sqrt(n);
  const sorted = [...v].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return { n, mean, se, t: mean / se, median: q(0.5), hit: v.filter((x) => x > 0).length / n, p05: q(0.05), min: sorted[0] };
}

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "–");
const fx = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");

/** Markdown table. */
export function md(rows: (string | number)[][]): string {
  const [head, ...body] = rows;
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...body.map((r) => `| ${r.map((c) => (typeof c === "number" ? String(c) : c)).join(" | ")} |`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

export interface SpreadScenario {
  name: string;
  /** Full bid-ask spread for a premium. */
  spread: (price: number) => number;
}

const TICK = 0.05;
export const SPREAD_SCENARIOS: readonly SpreadScenario[] = [
  { name: "none", spread: () => 0 },
  { name: "1 tick", spread: () => TICK },
  {
    name: "engine model (max(1 tick, 0.4%))",
    spread: (p) => Math.max(1, Math.ceil((0.004 * p) / TICK - 1e-9)) * TICK,
  },
  { name: "1% of premium", spread: (p) => Math.max(TICK, Math.ceil((0.01 * p) / TICK - 1e-9) * TICK) },
];

/** Net P&L per unit of a round trip: long buys at entry and sells at exit, short the reverse. */
export function netPerUnit(
  side: "long" | "short",
  entry: number,
  exit: number,
  lot: number,
  exchange: BhavExchange,
  date: string,
  sc: SpreadScenario,
): number {
  const hsIn = sc.spread(entry) / 2;
  const hsOut = sc.spread(exit) / 2;
  if (side === "long") {
    const buy = entry + hsIn;
    const sell = Math.max(0, exit - hsOut);
    const ch = computeCharges("BUY", buy, lot, exchange, date).total + computeCharges("SELL", sell, lot, exchange, date).total;
    return sell - buy - ch / lot;
  }
  const sell = Math.max(0, entry - hsIn);
  const buy = exit + hsOut;
  const ch = computeCharges("SELL", sell, lot, exchange, date).total + computeCharges("BUY", buy, lot, exchange, date).total;
  return sell - buy - ch / lot;
}

// ---------------------------------------------------------------------------
// Bhat-Pandey-Rao replication: day (open -> close) and night (close -> next open) legs
// ---------------------------------------------------------------------------

export interface Leg {
  index: ResearchIndex["id"];
  exchange: BhavExchange;
  kind: "day" | "night";
  date: string;
  exitDate: string;
  expiry: string;
  /** Sessions after `date` up to the expiry (>= 1). */
  dte: number;
  strike: number;
  ref: number;
  /** Calendar days spanned (night legs: 1 on weekdays, 3 over a weekend). */
  gapDays: number;
  lot: number;
  call: { entry: number; exit: number; delta: number | null };
  put: { entry: number; exit: number; delta: number | null };
  /** Index level at entry and exit. */
  sEntry: number;
  sExit: number;
}

function entryDelta(price: number, spot: number, strike: number, t: number, r: number, type: BhavOptionType): number | null {
  const iv = impliedVol(price, { spot, strike, tYears: t, r, type });
  return iv === null ? null : bsGreeks({ spot, strike, tYears: t, vol: iv, r, type }).delta;
}

const tradedWith = (r: BhavRow | undefined, field: "open" | "close"): r is BhavRow => !!r && r.contracts > 0 && r[field] !== null && (r[field] as number) > 0;

/**
 * A print below 10% of its reference price while the index moved less than 3% is an erroneous
 * trade, not a market move (e.g. SENSEX 65500 CE and PE both "opening" at 2.05 on 2023-09-04
 * against day VWAPs of 334 and 259).
 */
export function badPrint(price: number, ref: number | null | undefined, indexMove: number | null): boolean {
  return ref !== null && ref !== undefined && ref > 0 && price < 0.1 * ref && indexMove !== null && Math.abs(indexMove) < 0.03;
}

/** Legs dropped by the bad-print filter in the last buildLegs call (for the report). */
export const droppedBadPrints: string[] = [];

/** All day and night ATM legs for one index over the loaded dates (special sessions excluded). */
export function buildLegs(data: ResearchData, idx: ResearchIndex, from: string, to: string): Leg[] {
  const { book } = data;
  const r = data.cfg.pricing.r;
  const legs: Leg[] = [];
  const dates = book.dates(idx.id);
  dates.forEach((date, i) => {
    if (date < from || date > to || data.special.has(date)) return;
    const expiry = nextExpiry(book, idx.id, date);
    if (!expiry) return;
    const strikes = book.strikes(idx.id, date, expiry);
    const dte = book.sessionsToExpiry(idx.id, date, expiry);
    // Day leg: buy at the open, sell at the close.
    const so = spotOpen(data, idx, date);
    const sc = spotClose(data, idx, date);
    const prev = i > 0 ? dates[i - 1] : undefined;
    const prevSpot = prev ? spotClose(data, idx, prev) : null;
    if (so && sc) {
      const k = nearestStrike(strikes, so);
      const c = k === null ? undefined : book.option(idx.id, date, expiry, k, "CE");
      const p = k === null ? undefined : book.option(idx.id, date, expiry, k, "PE");
      const gap = prevSpot ? so / prevSpot - 1 : null;
      const bad =
        k !== null &&
        prev !== undefined &&
        [c, p].some((x) => x?.open && badPrint(x.open, book.option(idx.id, prev, expiry, k, x.type!)?.close, gap));
      if (bad) droppedBadPrints.push(`${idx.id} day ${date}`);
      if (!bad && k !== null && tradedWith(c, "open") && tradedWith(c, "close") && tradedWith(p, "open") && tradedWith(p, "close")) {
        const t = tYears(data, date, "09:15", expiry);
        legs.push({
          index: idx.id,
          exchange: idx.exchange,
          kind: "day",
          date,
          exitDate: date,
          expiry,
          dte,
          strike: k,
          ref: so,
          gapDays: 0,
          lot: c.lot ?? p.lot ?? 1,
          call: { entry: c.open!, exit: c.close!, delta: entryDelta(c.open!, so, k, t, r, "CE") },
          put: { entry: p.open!, exit: p.close!, delta: entryDelta(p.open!, so, k, t, r, "PE") },
          sEntry: so,
          sExit: sc,
        });
      }
    }
    // Night leg: sell/buy at today's close, reverse at the next session's open (same contract).
    const next = book.nextDate(idx.id, date);
    if (!next || next > to || data.special.has(next) || !sc) return;
    const so1 = spotOpen(data, idx, next);
    if (!so1) return;
    const k = nearestStrike(strikes, sc);
    if (k === null) return;
    const c0 = book.option(idx.id, date, expiry, k, "CE");
    const p0 = book.option(idx.id, date, expiry, k, "PE");
    const c1 = book.option(idx.id, next, expiry, k, "CE");
    const p1 = book.option(idx.id, next, expiry, k, "PE");
    if (!tradedWith(c0, "close") || !tradedWith(p0, "close") || !tradedWith(c1, "open") || !tradedWith(p1, "open")) return;
    if (badPrint(c1.open!, c0.close, so1 / sc - 1) || badPrint(p1.open!, p0.close, so1 / sc - 1)) {
      droppedBadPrints.push(`${idx.id} night ${date}`);
      return;
    }
    const t = tYears(data, date, "15:15", expiry);
    legs.push({
      index: idx.id,
      exchange: idx.exchange,
      kind: "night",
      date,
      exitDate: next,
      expiry,
      dte,
      strike: k,
      ref: sc,
      gapDays: daysBetween(date, next),
      lot: c0.lot ?? p0.lot ?? 1,
      call: { entry: c0.close!, exit: c1.open!, delta: entryDelta(c0.close!, sc, k, t, r, "CE") },
      put: { entry: p0.close!, exit: p1.open!, delta: entryDelta(p0.close!, sc, k, t, r, "PE") },
      sEntry: sc,
      sExit: so1,
    });
  });
  return legs;
}

export type Instrument = "call" | "put" | "straddle";

/** Gross long return of a leg's call, put or straddle (per unit of premium paid). */
export function grossReturn(l: Leg, ins: Instrument): number {
  if (ins === "call") return l.call.exit / l.call.entry - 1;
  if (ins === "put") return l.put.exit / l.put.entry - 1;
  return (l.call.exit + l.put.exit) / (l.call.entry + l.put.entry) - 1;
}

/** Delta-hedged long return (hedged with the index at the entry Black-Scholes delta). */
export function hedgedReturn(l: Leg, ins: Instrument): number {
  const ds = l.sExit - l.sEntry;
  if (ins === "call") return l.call.delta === null ? NaN : (l.call.exit - l.call.entry - l.call.delta * ds) / l.call.entry;
  if (ins === "put") return l.put.delta === null ? NaN : (l.put.exit - l.put.entry - l.put.delta * ds) / l.put.entry;
  if (l.call.delta === null || l.put.delta === null) return NaN;
  const pnl = l.call.exit + l.put.exit - l.call.entry - l.put.entry - (l.call.delta + l.put.delta) * ds;
  return pnl / (l.call.entry + l.put.entry);
}

/** Net return per unit of premium of a long or short position after charges (one lot) and a spread scenario. */
export function netReturn(l: Leg, ins: Instrument, side: "long" | "short", sc: SpreadScenario): number {
  const legs = ins === "call" ? [l.call] : ins === "put" ? [l.put] : [l.call, l.put];
  let pnl = 0;
  let prem = 0;
  for (const x of legs) {
    pnl += netPerUnit(side, x.entry, x.exit, l.lot, l.exchange, l.exitDate, sc);
    prem += x.entry;
  }
  return pnl / prem;
}

/**
 * Measurement checks that do not depend on the opening print: where the open and the close sit in
 * the day's range and against the day's VWAP, and ATM straddle returns between prices that are
 * averages (close = last-30-minute VWAP, vwap = whole-day VWAP) rather than first trades.
 */
function measurementDiagnostics(data: ResearchData, idx: ResearchIndex, from: string, to: string): { markdown: string; json: Record<string, unknown> } {
  const { book } = data;
  const pos = { open: [] as number[], close: [] as number[] };
  const vsVwap = { open: [] as number[], close: [] as number[] };
  let openIsHigh = 0;
  let openIsLow = 0;
  let n = 0;
  const cc: number[] = [];
  const vc: number[] = [];
  const cv: number[] = [];
  const ov: number[] = [];
  for (const date of book.dates(idx.id)) {
    if (date < from || date > to || data.special.has(date)) continue;
    const expiry = nextExpiry(book, idx.id, date);
    const so = spotOpen(data, idx, date);
    const sc = spotClose(data, idx, date);
    if (!expiry || !so || !sc) continue;
    const strikes = book.strikes(idx.id, date, expiry);
    const ko = nearestStrike(strikes, so);
    if (ko !== null) {
      const legsO = (["CE", "PE"] as const).map((t) => book.option(idx.id, date, expiry, ko, t));
      for (const r of legsO) {
        if (!tradedWith(r, "open") || r.high === null || r.low === null || !(r.high > r.low)) continue;
        n++;
        pos.open.push((r.open! - r.low) / (r.high - r.low));
        pos.close.push((r.close! - r.low) / (r.high - r.low));
        if (r.open === r.high) openIsHigh++;
        if (r.open === r.low) openIsLow++;
        if (r.vwap) {
          vsVwap.open.push(r.open! / r.vwap - 1);
          vsVwap.close.push(r.close! / r.vwap - 1);
        }
      }
      const [c, p] = legsO;
      if (c?.vwap && p?.vwap && tradedWith(c, "close") && tradedWith(p, "close")) {
        vc.push((c.close! + p.close!) / (c.vwap + p.vwap) - 1);
        if (tradedWith(c, "open") && tradedWith(p, "open")) ov.push((c.vwap + p.vwap) / (c.open! + p.open!) - 1);
      }
    }
    const next = book.nextDate(idx.id, date);
    const kc = nearestStrike(strikes, sc);
    if (!next || next > to || data.special.has(next) || kc === null) continue;
    const c0 = book.option(idx.id, date, expiry, kc, "CE");
    const p0 = book.option(idx.id, date, expiry, kc, "PE");
    const c1 = book.option(idx.id, next, expiry, kc, "CE");
    const p1 = book.option(idx.id, next, expiry, kc, "PE");
    if (!tradedWith(c0, "close") || !tradedWith(p0, "close")) continue;
    const s0 = c0.close! + p0.close!;
    // Into an expiry day the holder gets the settlement value (intrinsic), on both exchanges.
    const v1 = (r: BhavRow | undefined) => (r && (r.contracts > 0 || r.expiry === r.date) ? settledClose(r) : null);
    const cv1 = v1(c1);
    const pv1 = v1(p1);
    if (cv1 !== null && pv1 !== null) cc.push((cv1 + pv1) / s0 - 1);
    if (c1?.vwap && p1?.vwap && c1.contracts > 0 && p1.contracts > 0) cv.push((c1.vwap + p1.vwap) / s0 - 1);
  }
  const share = (xs: number[], f: (x: number) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);
  const json = {
    contractDays: n,
    openIsHigh: openIsHigh / Math.max(1, n),
    openIsLow: openIsLow / Math.max(1, n),
    openPosMedian: median(pos.open),
    openTopDecile: share(pos.open, (x) => x >= 0.9),
    openBottomDecile: share(pos.open, (x) => x <= 0.1),
    closePosMedian: median(pos.close),
    openVsVwapMedian: median(vsVwap.open),
    closeVsVwapMedian: median(vsVwap.close),
    straddleCloseToClose: stats(cc),
    straddleOpenToVwap: stats(ov),
    straddleVwapToClose: stats(vc),
    straddleCloseToNextVwap: stats(cv),
  };
  const markdown = [
    `\n#### ${idx.id}: what the open and close prints look like (ATM call and put, nearest weekly after the day)\n`,
    md([
      ["measure", "value"],
      ["contract-days", n],
      ["open is the day's high / low", `${pct(json.openIsHigh, 1)} / ${pct(json.openIsLow, 1)}`],
      ["open in the top / bottom 10% of the day's range", `${pct(json.openTopDecile, 1)} / ${pct(json.openBottomDecile, 1)}`],
      ["median position in the range (0 = low, 1 = high): open / close", `${fx(json.openPosMedian, 2)} / ${fx(json.closePosMedian, 2)}`],
      ["median open / day VWAP - 1", pct(json.openVsVwapMedian, 1)],
      ["median close / day VWAP - 1", pct(json.closeVsVwapMedian, 1)],
    ]),
    `\nATM straddle long returns between averaged prices (no opening print):\n`,
    md([
      ["interval", "n", "mean", "t", "median"],
      ["close -> next close (one session incl. the night)", json.straddleCloseToClose.n, pct(json.straddleCloseToClose.mean), fx(json.straddleCloseToClose.t), pct(json.straddleCloseToClose.median)],
      ["close -> next day VWAP (night + morning)", json.straddleCloseToNextVwap.n, pct(json.straddleCloseToNextVwap.mean), fx(json.straddleCloseToNextVwap.t), pct(json.straddleCloseToNextVwap.median)],
      ["day VWAP -> close (afternoon)", json.straddleVwapToClose.n, pct(json.straddleVwapToClose.mean), fx(json.straddleVwapToClose.t), pct(json.straddleVwapToClose.median)],
      ["open -> day VWAP (morning, uses the opening print)", json.straddleOpenToVwap.n, pct(json.straddleOpenToVwap.mean), fx(json.straddleOpenToVwap.t), pct(json.straddleOpenToVwap.median)],
    ]),
  ].join("\n");
  return { markdown, json };
}

function replicationTables(legs: Leg[]): { markdown: string; json: Record<string, unknown> } {
  const out: string[] = [];
  const json: Record<string, unknown> = {};
  const ins: Instrument[] = ["call", "put", "straddle"];
  for (const index of ["NIFTY", "SENSEX"] as const) {
    const mine = legs.filter((l) => l.index === index);
    if (mine.length === 0) continue;
    const first = mine.map((l) => l.date).sort()[0];
    const last = mine.map((l) => l.exitDate).sort().at(-1);
    out.push(`\n#### ${index} ATM weekly (nearest expiry after the day), ${first} .. ${last}\n`);
    const rows: (string | number)[][] = [["leg", "option", "n", "long gross mean", "t", "median", "short gross mean", "long Δ-hedged", "t (Δh)", "short net: charges only", "short net: charges + engine spread", "long net: charges + engine spread"]];
    for (const kind of ["day", "night"] as const) {
      const ls = mine.filter((l) => l.kind === kind);
      for (const i of ins) {
        const g = stats(ls.map((l) => grossReturn(l, i)));
        const h = stats(ls.map((l) => hedgedReturn(l, i)));
        const sNet0 = stats(ls.map((l) => netReturn(l, i, "short", SPREAD_SCENARIOS[0])));
        const sNetE = stats(ls.map((l) => netReturn(l, i, "short", SPREAD_SCENARIOS[2])));
        const lNetE = stats(ls.map((l) => netReturn(l, i, "long", SPREAD_SCENARIOS[2])));
        rows.push([kind, i, g.n, pct(g.mean), fx(g.t), pct(g.median), pct(-g.mean), pct(h.mean), fx(h.t), pct(sNet0.mean), pct(sNetE.mean), pct(lNetE.mean)]);
        json[`${index}.${kind}.${i}`] = { gross: g, hedged: h, shortNetCharges: sNet0, shortNetEngineSpread: sNetE, longNetEngineSpread: lNetE };
      }
    }
    out.push(md(rows));
    // Straddle by days to expiry and by night type.
    const byDte: (string | number)[][] = [["leg", "sessions to expiry", "n", "straddle long gross", "t", "short net (charges + engine spread)"]];
    for (const kind of ["day", "night"] as const) {
      for (const [label, lo, hi] of [["1", 1, 1], ["2", 2, 2], ["3", 3, 3], ["4-5", 4, 5], ["6+", 6, 99]] as const) {
        const ls = mine.filter((l) => l.kind === kind && l.dte >= lo && l.dte <= hi);
        if (ls.length < 5) continue;
        const g = stats(ls.map((l) => grossReturn(l, "straddle")));
        const s = stats(ls.map((l) => netReturn(l, "straddle", "short", SPREAD_SCENARIOS[2])));
        byDte.push([kind, label, g.n, pct(g.mean), fx(g.t), pct(s.mean)]);
      }
    }
    out.push(`\nStraddle by sessions to expiry:\n\n${md(byDte)}`);
    const nights = mine.filter((l) => l.kind === "night");
    const days = mine.filter((l) => l.kind === "day");
    const split: (string | number)[][] = [["subset", "n", "straddle long gross", "t", "Δ-hedged", "short net (charges + engine spread)"]];
    const addSplit = (label: string, ls: Leg[]) => {
      if (ls.length < 5) return;
      const g = stats(ls.map((l) => grossReturn(l, "straddle")));
      const h = stats(ls.map((l) => hedgedReturn(l, "straddle")));
      const s = stats(ls.map((l) => netReturn(l, "straddle", "short", SPREAD_SCENARIOS[2])));
      split.push([label, g.n, pct(g.mean), fx(g.t), pct(h.mean), pct(s.mean)]);
    };
    addSplit("nights, next day (1 calendar day)", nights.filter((l) => l.gapDays === 1));
    addSplit("nights over weekends/holidays (>= 2 days)", nights.filter((l) => l.gapDays >= 2));
    const absMove = (l: Leg) => Math.abs(l.sExit / l.sEntry - 1);
    for (const [label, ls] of [["night", nights], ["day", days]] as const) {
      const cut = [...ls.map(absMove)].sort((a, b) => a - b)[Math.floor(0.9 * (ls.length - 1))] ?? Infinity;
      addSplit(`${label}s without a jump (|index move| < p90 = ${pct(cut)})`, ls.filter((l) => absMove(l) < cut));
      addSplit(`${label}s with a jump (top decile |index move|)`, ls.filter((l) => absMove(l) >= cut));
    }
    for (const y of [...new Set(mine.map((l) => l.date.slice(0, 4)))].sort()) {
      addSplit(`nights ${y}`, nights.filter((l) => l.date.startsWith(y)));
      addSplit(`days ${y}`, days.filter((l) => l.date.startsWith(y)));
    }
    out.push(`\nStraddle subsets:\n\n${md(split)}`);
    // Spread sensitivity of the short straddle (night) and long straddle (day).
    const sens: (string | number)[][] = [["spread scenario", "short straddle night (net)", "t", "long straddle day (net)", "t", "short straddle day (net)"]];
    for (const sc of SPREAD_SCENARIOS) {
      const a = stats(nights.map((l) => netReturn(l, "straddle", "short", sc)));
      const b = stats(days.map((l) => netReturn(l, "straddle", "long", sc)));
      const c = stats(days.map((l) => netReturn(l, "straddle", "short", sc)));
      sens.push([sc.name, pct(a.mean), fx(a.t), pct(b.mean), fx(b.t), pct(c.mean)]);
    }
    out.push(`\nCosts (charges for one lot at the dated schedule, plus half the spread on each side):\n\n${md(sens)}`);
  }
  return { markdown: out.join("\n"), json };
}

// ---------------------------------------------------------------------------
// Calibration of the synthetic pricer against real premiums
// ---------------------------------------------------------------------------

/** Straddle implied vol (engine convention: spot, rate r, trading-time years). */
export function straddleIv(price: number, spot: number, strike: number, t: number, r: number): number | null {
  if (!(price > 0) || !(spot > 0) || !(t > 0)) return null;
  const f = (v: number) => bsPrice({ spot, strike, tYears: t, vol: v, r, type: "CE" }) + bsPrice({ spot, strike, tYears: t, vol: v, r, type: "PE" }) - price;
  let lo = 0.005;
  let hi = 5;
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface AtmObs {
  index: ResearchIndex["id"];
  date: string;
  expiry: string;
  dte: number;
  when: "open" | "close";
  spot: number;
  strike: number;
  straddle: number;
  t: number;
  iv: number;
  vix: number;
  vixPrevClose: number | null;
  /** Calendar days in the coming night (close obs) or the night just passed (open obs). */
  nightDays: number;
}

/** ATM straddle IV observations at the open and the close, for the nearest two weekly expiries. */
export function atmObservations(data: ResearchData, idx: ResearchIndex, from: string, to: string): AtmObs[] {
  const { book } = data;
  const r = data.cfg.pricing.r;
  const out: AtmObs[] = [];
  const dates = book.dates(idx.id);
  dates.forEach((date, i) => {
    if (date < from || date > to || data.special.has(date)) return;
    const prev = i > 0 ? dates[i - 1] : undefined;
    const next = dates[i + 1];
    const expiries = book.expiries(idx.id, date).filter((e) => e > date).slice(0, 2);
    for (const expiry of expiries) {
      const dte = book.sessionsToExpiry(idx.id, date, expiry);
      if (dte > 10) continue;
      const strikes = book.strikes(idx.id, date, expiry);
      for (const when of ["open", "close"] as const) {
        const spot = when === "open" ? spotOpen(data, idx, date) : spotClose(data, idx, date);
        const vix = vixOn(data, date, when === "open" ? "o" : "c");
        if (!spot || !vix) continue;
        const k = nearestStrike(strikes, spot);
        if (k === null) continue;
        const c = book.option(idx.id, date, expiry, k, "CE");
        const p = book.option(idx.id, date, expiry, k, "PE");
        if (!tradedWith(c, when) || !tradedWith(p, when)) continue;
        const straddle = c[when]! + p[when]!;
        const t = tYears(data, date, when === "open" ? "09:15" : "15:15", expiry);
        const iv = straddleIv(straddle, spot, k, t, r);
        if (iv === null) continue;
        out.push({
          index: idx.id,
          date,
          expiry,
          dte,
          when,
          spot,
          strike: k,
          straddle,
          t,
          iv,
          vix,
          vixPrevClose: prev ? vixOn(data, prev, "c") : null,
          nightDays: when === "close" ? (next ? daysBetween(date, next) : 1) : prev ? daysBetween(prev, date) : 1,
        });
      }
    }
  });
  return out;
}

export interface SkewObs {
  index: ResearchIndex["id"];
  date: string;
  dte: number;
  steps: number;
  z: number;
  ratio: number;
  type: BhavOptionType;
}

/** OTM smile at the close: IV(K) / ATM straddle IV against standardized moneyness z = ln(K/F)/(iv sqrt t). */
export function skewObservations(data: ResearchData, idx: ResearchIndex, atm: AtmObs[], maxSteps = 10): SkewObs[] {
  const { book } = data;
  const r = data.cfg.pricing.r;
  const out: SkewObs[] = [];
  for (const a of atm) {
    if (a.when !== "close") continue;
    const fwd = parityForward(book, idx.id, a.date, a.expiry, "close", { r, tYears: a.t });
    if (!fwd) continue;
    const spotFwd = fwd.forward * Math.exp(-r * a.t);
    for (let s = -maxSteps; s <= maxSteps; s++) {
      if (s === 0) continue;
      const k = a.strike + s * idx.step;
      const type: BhavOptionType = k >= fwd.forward ? "CE" : "PE";
      const row = book.option(idx.id, a.date, a.expiry, k, type);
      if (!tradedWith(row, "close") || row.close! < 1) continue;
      const iv = impliedVol(row.close!, { spot: spotFwd, strike: k, tYears: a.t, r, type });
      if (iv === null) continue;
      const atmIv = straddleIv(a.straddle, spotFwd, a.strike, a.t, r);
      if (!atmIv) continue;
      out.push({ index: idx.id, date: a.date, dte: a.dte, steps: s, z: Math.log(k / fwd.forward) / (atmIv * Math.sqrt(a.t)), ratio: iv / atmIv, type });
    }
  }
  return out;
}

/** Least-squares fit of ratio = 1 + a z + b z^2 (z clipped to the fitted range). */
export function fitSkew(obs: SkewObs[], zMin = -4, zMax = 3): { a: number; b: number; n: number; zMin: number; zMax: number } {
  const pts = obs.filter((o) => o.z >= zMin && o.z <= zMax && o.ratio > 0.3 && o.ratio < 3);
  // Normal equations for y - 1 = a z + b z^2.
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  for (const p of pts) {
    const y = p.ratio - 1;
    const z1 = p.z;
    const z2 = p.z * p.z;
    s11 += z1 * z1;
    s12 += z1 * z2;
    s22 += z2 * z2;
    r1 += z1 * y;
    r2 += z2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  const a = det !== 0 ? (r1 * s22 - r2 * s12) / det : 0;
  const b = det !== 0 ? (s11 * r2 - s12 * r1) / det : 0;
  return { a, b, n: pts.length, zMin, zMax };
}

const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN;
};
const quantile = (xs: number[], q: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))] : NaN;
};

const DTE_BUCKETS: readonly [string, number, number][] = [["1", 1, 1], ["2", 2, 2], ["3", 3, 3], ["4", 4, 4], ["5", 5, 5], ["6+", 6, 10]];

export interface CalibrationResult {
  fitFrom: string;
  fitTo: string;
  /** Median IV / VIX of the ATM straddle by sessions to expiry 1..6 (index 0 = 1 session). */
  multipliers: Record<string, { open: number[]; close: number[]; n: { open: number[]; close: number[] } }>;
  skew: Record<string, { a: number; b: number; n: number; zMin: number; zMax: number }>;
}

function calibrate(data: ResearchData, fitFrom: string, fitTo: string, reportTo: string): { markdown: string; result: CalibrationResult } {
  const out: string[] = [];
  const result: CalibrationResult = { fitFrom, fitTo, multipliers: {}, skew: {} };
  for (const idx of RESEARCH_INDICES) {
    const obs = atmObservations(data, idx, fitFrom, reportTo);
    const fit = obs.filter((o) => o.date <= fitTo);
    const oos = obs.filter((o) => o.date > fitTo);
    const ratio = (o: AtmObs) => o.iv / (o.vix / 100);
    const rows: (string | number)[][] = [["sessions to expiry", "close: n", "close IV/VIX median", "IQR", "open: n", "open IV/VIX median", "IQR", "open IV/prev-close VIX", "median ATM straddle (close)"]];
    const mult = { open: [] as number[], close: [] as number[], n: { open: [] as number[], close: [] as number[] } };
    for (const [label, lo, hi] of DTE_BUCKETS) {
      const c = fit.filter((o) => o.when === "close" && o.dte >= lo && o.dte <= hi);
      const op = fit.filter((o) => o.when === "open" && o.dte >= lo && o.dte <= hi);
      const mc = median(c.map(ratio));
      const mo = median(op.map(ratio));
      mult.close.push(Math.round(mc * 1000) / 1000);
      mult.open.push(Math.round(mo * 1000) / 1000);
      mult.n.close.push(c.length);
      mult.n.open.push(op.length);
      rows.push([
        label,
        c.length,
        fx(mc, 3),
        `${fx(quantile(c.map(ratio), 0.25), 2)}–${fx(quantile(c.map(ratio), 0.75), 2)}`,
        op.length,
        fx(mo, 3),
        `${fx(quantile(op.map(ratio), 0.25), 2)}–${fx(quantile(op.map(ratio), 0.75), 2)}`,
        fx(median(op.filter((o) => o.vixPrevClose).map((o) => o.iv / (o.vixPrevClose! / 100))), 3),
        fx(median(c.map((o) => o.straddle)), 1),
      ]);
    }
    result.multipliers[idx.id] = mult;
    out.push(`\n#### ${idx.id}: ATM straddle implied vol / India VIX (fit ${fit[0]?.date ?? "?"} .. ${fitTo}; engine today uses ${DEFAULT_CONFIG.pricing.vixMultiplier[idx.id]})\n`);
    out.push(md(rows));
    // By year (close, all DTE 1-5) to show drift.
    const yr: (string | number)[][] = [["year", "n (close, 1-5 sessions)", "IV/VIX median"]];
    for (const y of [...new Set(obs.map((o) => o.date.slice(0, 4)))].sort()) {
      const c = obs.filter((o) => o.when === "close" && o.dte <= 5 && o.date.startsWith(y));
      yr.push([y, c.length, fx(median(c.map(ratio)), 3)]);
    }
    out.push(`\nBy year:\n\n${md(yr)}`);
    // Skew.
    const sk = skewObservations(data, idx, fit.filter((o) => o.dte <= 6));
    // Each wing separately: puts (z < 0) and calls (z > 0).
    const put = fitSkew(sk, -4, 0);
    const call = fitSkew(sk, 0, 3);
    const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
    result.skew[`${idx.id}.put`] = { ...put, a: r4(put.a), b: r4(put.b) };
    result.skew[`${idx.id}.call`] = { ...call, a: r4(call.a), b: r4(call.b) };
    const wing = (z: number) => (z < 0 ? 1 + put.a * z + put.b * z * z : 1 + call.a * z + call.b * z * z);
    const skRows: (string | number)[][] = [["strikes from ATM", "n", "IV / ATM IV (median)", "median z", "fitted wing"]];
    for (let s = -8; s <= 8; s++) {
      if (s === 0) continue;
      const xs = sk.filter((o) => o.steps === s);
      if (xs.length < 20) continue;
      const z = median(xs.map((o) => o.z));
      skRows.push([s, xs.length, fx(median(xs.map((o) => o.ratio)), 3), fx(z, 2), fx(wing(z), 3)]);
    }
    out.push(
      `\nSmile at the close (OTM puts below the forward, OTM calls above; sessions to expiry 1-6), IV/ATM IV = 1 + a z + b z^2 per wing: ` +
        `puts a = ${fx(put.a, 4)}, b = ${fx(put.b, 4)} (${put.n} points), calls a = ${fx(call.a, 4)}, b = ${fx(call.b, 4)} (${call.n} points)\n\n${md(skRows)}`,
    );
    // Out-of-sample check of the multiplier (close obs): straddle pricing error, engine default vs calibrated.
    if (oos.length > 0) {
      const errs = (useCal: boolean) =>
        oos
          .filter((o) => o.when === "close" && o.dte <= 6)
          .map((o) => {
            const m = useCal ? mult.close[Math.min(5, o.dte - 1)] : DEFAULT_CONFIG.pricing.vixMultiplier[idx.id];
            const vol = (o.vix / 100) * m;
            const r = data.cfg.pricing.r;
            const model = bsPrice({ spot: o.spot, strike: o.strike, tYears: o.t, vol, r, type: "CE" }) + bsPrice({ spot: o.spot, strike: o.strike, tYears: o.t, vol, r, type: "PE" });
            return model / o.straddle - 1;
          });
      const d = errs(false);
      const c = errs(true);
      out.push(
        `\nOut of sample (${fitTo} < date <= ${reportTo}, close, 1-6 sessions, n = ${d.length}): model ATM straddle / real - 1: ` +
          `default VIX x ${DEFAULT_CONFIG.pricing.vixMultiplier[idx.id]} median ${pct(median(d))} (IQR ${pct(quantile(d, 0.25))} .. ${pct(quantile(d, 0.75))}); ` +
          `calibrated median ${pct(median(c))} (IQR ${pct(quantile(c, 0.25))} .. ${pct(quantile(c, 0.75))}).`,
      );
    }
  }
  return { markdown: out.join("\n"), result };
}

/**
 * Spread diagnostics: (a) what the engine's spread model implies, in ticks, at real premiums;
 * (b) an upper bound on NIFTY's effective spread from put-call parity residuals of last trades
 * (UDiFF files only): for strikes near the money, D(K) = C_last - P_last + K should be the same for
 * every strike if trades were simultaneous and at mid; the cross-strike dispersion bounds the
 * bid-ask bounce (asynchrony adds to it, so this over-states the spread).
 */
function spreadDiagnostics(data: ResearchData, from: string, to: string): string {
  const out: string[] = [];
  const rows: (string | number)[][] = [["index", "sessions to expiry", "moneyness", "median real close premium", "engine spread ₹", "engine spread (ticks)", "as % of premium"]];
  for (const idx of RESEARCH_INDICES) {
    for (const [label, lo, hi] of DTE_BUCKETS.slice(0, 5)) {
      for (const steps of [0, 2, 4, 8]) {
        const prem: number[] = [];
        for (const date of data.book.dates(idx.id)) {
          if (date < from || date > to) continue;
          const expiry = nextExpiry(data.book, idx.id, date);
          if (!expiry) continue;
          const dte = data.book.sessionsToExpiry(idx.id, date, expiry);
          if (dte < lo || dte > hi) continue;
          const sc = spotClose(data, idx, date);
          if (!sc) continue;
          const k0 = nearestStrike(data.book.strikes(idx.id, date, expiry), sc);
          if (k0 === null) continue;
          for (const [k, type] of [[k0 + steps * idx.step, "CE"], [k0 - steps * idx.step, "PE"]] as const) {
            const row = data.book.option(idx.id, date, expiry, k, type);
            if (tradedWith(row, "close")) prem.push(row.close!);
          }
        }
        if (prem.length < 10) continue;
        const m = median(prem);
        const sp = SPREAD_SCENARIOS[2].spread(m);
        rows.push([idx.id, label, steps === 0 ? "ATM" : `${steps} strikes OTM`, fx(m, 2), fx(sp, 2), Math.round(sp / TICK), pct(sp / m, 2)]);
      }
    }
  }
  out.push(md(rows));
  // Parity-residual bound (NIFTY, UDiFF only: needs last traded prices).
  const resid: { last: number[]; close: number[] } = { last: [], close: [] };
  for (const date of data.book.dates("NIFTY")) {
    if (date < from || date > to) continue;
    const expiry = nextExpiry(data.book, "NIFTY", date);
    const sc = spotClose(data, RESEARCH_INDICES[0], date);
    if (!expiry || !sc) continue;
    const k0 = nearestStrike(data.book.strikes("NIFTY", date, expiry), sc);
    if (k0 === null) continue;
    for (const field of ["last", "close"] as const) {
      const ds: number[] = [];
      for (let s = -3; s <= 3; s++) {
        const k = k0 + s * 50;
        const c = data.book.option("NIFTY", date, expiry, k, "CE");
        const p = data.book.option("NIFTY", date, expiry, k, "PE");
        if (!c || !p || c.contracts < 1000 || p.contracts < 1000) continue;
        const cv = c[field];
        const pv = p[field];
        if (cv === null || pv === null) continue;
        ds.push(cv - pv + k);
      }
      if (ds.length < 5) continue;
      const m = median(ds);
      for (const d of ds) resid[field].push(d - m);
    }
  }
  const robustSd = (xs: number[]) => 1.4826 * median(xs.map((x) => Math.abs(x - median(xs))));
  if (resid.last.length > 0) {
    out.push(
      `\nNIFTY parity residuals across the 7 strikes around ATM (nearest weekly, both legs >= 1,000 contracts), ${resid.last.length} residuals: ` +
        `robust sd with last trades ₹${fx(robustSd(resid.last), 3)} -> implied upper bound on the full spread ≈ √2 × sd = ₹${fx(Math.SQRT2 * robustSd(resid.last), 2)}; ` +
        `with closing prices (30-minute VWAPs, bounce averaged out) ₹${fx(robustSd(resid.close), 3)}.`,
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Real-price sanity check of backtest trades (evaluation protocol §5.10)
// ---------------------------------------------------------------------------

interface BtTrade {
  index: string;
  tradingSymbol: string;
  entryMs: number;
  exitMs: number;
  entryPremium: number;
  exitPremium: number;
  qty: number;
  pnl: number;
  exitReason: string;
}

export interface SanityRow {
  symbol: string;
  index: string;
  date: string;
  entry: number;
  exit: number;
  row: BhavRow | undefined;
  entryCheck: ReturnType<typeof dayRangeCheck>;
  exitCheck: ReturnType<typeof dayRangeCheck>;
}

export function sanityRows(book: RealPriceBook, trades: BtTrade[]): SanityRow[] {
  return trades.map((t) => {
    const date = istDate(t.entryMs);
    const p = resolveOptionRow(book, t.tradingSymbol, date);
    return {
      symbol: t.tradingSymbol,
      index: t.index,
      date,
      entry: t.entryPremium,
      exit: t.exitPremium,
      row: p,
      entryCheck: dayRangeCheck(p, t.entryPremium),
      exitCheck: istDate(t.exitMs) === date ? dayRangeCheck(p, t.exitPremium) : dayRangeCheck(resolveOptionRow(book, t.tradingSymbol, istDate(t.exitMs)), t.exitPremium),
    };
  });
}

export function sanitySummary(rows: SanityRow[], label: string): { markdown: string; json: Record<string, unknown> } {
  const lines: (string | number)[][] = [["run", "index", "trades", "with real row", "entry in range", "exit in range", "both in range", "entry above high", "entry below low", "median entry position", "median entry / VWAP - 1", "median exit / VWAP - 1"]];
  const json: Record<string, unknown> = {};
  for (const index of ["ALL", "NIFTY", "SENSEX"]) {
    const rs = rows.filter((r) => index === "ALL" || r.index === index);
    if (rs.length === 0) continue;
    const with_ = rs.filter((r) => r.entryCheck.inRange !== null && r.exitCheck.inRange !== null);
    const share = (f: (r: SanityRow) => boolean) => (with_.length ? with_.filter(f).length / with_.length : NaN);
    const s = {
      trades: rs.length,
      withRow: with_.length,
      entryIn: share((r) => r.entryCheck.inRange === true),
      exitIn: share((r) => r.exitCheck.inRange === true),
      bothIn: share((r) => r.entryCheck.inRange === true && r.exitCheck.inRange === true),
      entryAbove: share((r) => (r.entryCheck.position ?? 0) > 1),
      entryBelow: share((r) => (r.entryCheck.position ?? 0) < 0),
      entryPos: median(with_.map((r) => r.entryCheck.position ?? NaN)),
      entryVsVwap: median(with_.map((r) => r.entryCheck.vsVwap ?? NaN)),
      exitVsVwap: median(with_.map((r) => r.exitCheck.vsVwap ?? NaN)),
    };
    json[index] = s;
    lines.push([label, index, s.trades, s.withRow, pct(s.entryIn, 0), pct(s.exitIn, 0), pct(s.bothIn, 0), pct(s.entryAbove, 0), pct(s.entryBelow, 0), fx(s.entryPos, 2), pct(s.entryVsVwap, 1), pct(s.exitVsVwap, 1)]);
  }
  return { markdown: md(lines), json };
}

// ---------------------------------------------------------------------------
// Ledger and CLI
// ---------------------------------------------------------------------------

export function logTrial(entry: { wp: string; variant: string; params: unknown; data: string; trades: number | null; net: number | null; notes: string }): void {
  const p = resolve(ROOT, "reports/trials.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function save(outDir: string, name: string, content: string): string {
  const p = resolve(ROOT, outDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2] ?? "coverage";
  const from = str(args, "from", "2019-01-01")!;
  const to = str(args, "to", "2026-10-08")!;
  const outDir = str(args, "out", "reports/wp6")!;
  const t0 = Date.now();
  const data = await loadResearchData({ from, to, dir: str(args, "dir", undefined) });
  console.log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE sessions in ${((Date.now() - t0) / 1000).toFixed(1)} s; special sessions excluded: ${[...data.special].sort().join(", ") || "none"}.`);

  if (cmd === "coverage") {
    const rows: (string | number)[][] = [["exchange", "year", "sessions", "first", "last"]];
    for (const ex of ["NSE", "BSE"] as const) {
      const byYear = new Map<string, string[]>();
      for (const d of data.loaded[ex]) byYear.set(d.slice(0, 4), [...(byYear.get(d.slice(0, 4)) ?? []), d]);
      for (const [y, ds] of [...byYear].sort()) rows.push([ex, y, ds.length, ds[0], ds.at(-1)!]);
    }
    const nseSet = new Set(data.loaded.NSE);
    const bseSet = new Set(data.loaded.BSE);
    // Continuous BSE coverage starts at the first file followed by another within five days
    // (isolated special-session files before the May 2023 SENSEX relaunch do not count).
    const bseFrom = data.loaded.BSE.find((d, i, a) => a[i + 1] !== undefined && daysBetween(d, a[i + 1]) <= 5) ?? "9999";
    const bseGaps = data.loaded.NSE.filter((d) => d >= bseFrom && !bseSet.has(d));
    const nseGaps = data.loaded.BSE.filter((d) => !nseSet.has(d));
    let text = `### Coverage\n\n${md(rows)}\n\nNSE sessions without a BSE file (BSE archive gaps, from ${bseFrom}): ${bseGaps.length} (${bseGaps.join(", ")})\n\nBSE sessions without an NSE file: ${nseGaps.length} (${nseGaps.join(", ")})\n`;
    // Close vs last (NSE UDiFF): how often the close differs from the last trade for ATM weeklies.
    const cl: number[] = [];
    let same = 0;
    let n = 0;
    for (const date of data.book.dates("NIFTY")) {
      const expiry = nextExpiry(data.book, "NIFTY", date);
      const sc = spotClose(data, RESEARCH_INDICES[0], date);
      if (!expiry || !sc) continue;
      const k = nearestStrike(data.book.strikes("NIFTY", date, expiry), sc);
      for (const type of ["CE", "PE"] as const) {
        const row = k === null ? undefined : data.book.option("NIFTY", date, expiry, k, type);
        if (!row || row.last === null || row.close === null || row.contracts <= 0) continue;
        n++;
        if (row.last === row.close) same++;
        cl.push(row.last / row.close - 1);
      }
    }
    text += `\nNIFTY ATM weekly, UDiFF files (have LastPric): ${n} contract-days; close equals the last trade on ${same} (${pct(same / Math.max(1, n), 1)}); median |last/close - 1| = ${pct(median(cl.map(Math.abs)), 2)}, p90 ${pct(quantile(cl.map(Math.abs), 0.9), 2)}.\n`;
    // Yahoo close vs NSE's UndrlygPric.
    const dev: number[] = [];
    for (const date of data.book.dates("NIFTY")) {
      const u = data.book.rows("NIFTY", date).find((r) => r.underlying)?.underlying;
      const y = candle(data, "^NSEI", date)?.c;
      if (u && y) dev.push(Math.abs(y / u - 1));
    }
    text += `Yahoo ^NSEI daily close vs NSE UndrlygPric: ${dev.length} days, median |diff| ${pct(median(dev), 3)}, max ${pct(Math.max(...dev), 3)}.\n`;
    text += `Inferred NSE holidays (weekdays without a file): ${data.inferredHolidays.length}.\n`;
    console.log(text);
    save(outDir, "coverage.md", text);
    return;
  }

  if (cmd === "replicate") {
    const legs = RESEARCH_INDICES.flatMap((idx) => buildLegs(data, idx, from, to));
    const { markdown, json } = replicationTables(legs);
    const diag = RESEARCH_INDICES.map((idx) => measurementDiagnostics(data, idx, from, to));
    const text = `${markdown}\n${diag.map((d) => d.markdown).join("\n")}\n\nLegs dropped as bad prints (price < 10% of its reference while the index moved < 3%): ${droppedBadPrints.length} (${droppedBadPrints.join(", ")}).\n`;
    console.log(text);
    save(outDir, "replication.md", text);
    save(outDir, "replication.json", JSON.stringify({ ...json, diagnostics: Object.fromEntries(RESEARCH_INDICES.map((idx, i) => [idx.id, diag[i].json])) }, null, 1));
    for (const idx of RESEARCH_INDICES) {
      const ls = legs.filter((l) => l.index === idx.id);
      const night = stats(ls.filter((l) => l.kind === "night").map((l) => grossReturn(l, "straddle")));
      const day = stats(ls.filter((l) => l.kind === "day").map((l) => grossReturn(l, "straddle")));
      logTrial({
        wp: "WP6",
        variant: `bhat2024-replication-${idx.id}`,
        params: { atm: "nearest strike to index open (day) / close (night)", expiry: "nearest weekly after the day", from, to },
        data: `bhavcopy ${idx.exchange} + Yahoo daily`,
        trades: ls.length,
        net: null,
        notes: `ATM straddle long gross: night mean ${pct(night.mean)} (t ${fx(night.t)}, n ${night.n}); day mean ${pct(day.mean)} (t ${fx(day.t)}, n ${day.n}). Per-leg returns, not rupees.`,
      });
    }
    return;
  }

  if (cmd === "calibrate") {
    const fitTo = str(args, "fit-to", "2026-06-30")!;
    const fitFrom = str(args, "fit-from", "2024-01-01")!;
    const { markdown, result } = calibrate(data, fitFrom, fitTo, to);
    const spreads = spreadDiagnostics(data, fitFrom, to);
    const text = `${markdown}\n\n#### Spread model at real premiums (closing premiums, ${fitFrom} .. ${to})\n\n${spreads}\n`;
    console.log(text);
    console.log(JSON.stringify(result, null, 1));
    save(outDir, "calibration.md", text);
    save(outDir, "calibration.json", JSON.stringify(result, null, 1));
    logTrial({ wp: "WP6", variant: "iv-calibration", params: { fitFrom, fitTo }, data: "bhavcopy NSE+BSE + Yahoo daily VIX", trades: null, net: null, notes: `multipliers ${JSON.stringify(result.multipliers.NIFTY?.close)} NIFTY close, ${JSON.stringify(result.multipliers.SENSEX?.close)} SENSEX close` });
    return;
  }

  if (cmd === "sanity") {
    const btPath = str(args, "bt", undefined) ?? fail("--bt <backtest.json> is required");
    const bt = JSON.parse(readFileSync(resolve(ROOT, btPath), "utf8")) as { strategy: { trades: BtTrade[] } };
    const rows = sanityRows(data.book, bt.strategy.trades);
    const { markdown, json } = sanitySummary(rows, str(args, "label", "backtest")!);
    const detail = md([
      ["date", "contract", "entry", "exit", "real low", "real high", "real VWAP", "entry in", "exit in"],
      ...rows.map((r) => [r.date, r.symbol, r.entry, r.exit, fx(r.row?.low ?? NaN), fx(r.row?.high ?? NaN), fx(r.row?.vwap ?? NaN), String(r.entryCheck.inRange), String(r.exitCheck.inRange)]),
    ]);
    console.log(markdown);
    console.log(detail);
    save(outDir, `sanity-${str(args, "label", "backtest")}.md`, `${markdown}\n\n${detail}\n`);
    save(outDir, `sanity-${str(args, "label", "backtest")}.json`, JSON.stringify(json, null, 1));
    return;
  }
  fail(`unknown command ${cmd} (coverage | replicate | calibrate | sanity)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { addDays, num, table, withOverrides };
