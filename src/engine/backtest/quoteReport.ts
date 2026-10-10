/**
 * What the recorded option quotes (D1 `option_quotes`, src/engine/market/quoteRecorder.ts: the Groww Trade
 * API or Upstox's Market Data API, by each row's `source`) say about
 * selling the at-the-money straddle at the open: the question WP11 left open (reports/wp11-real-intraday.md
 * §9). `npm run quotes-report` reads the table and prints; every number is computed here. Research only:
 * nothing in the engine imports this, and nothing here places an order.
 *
 * Per session and index, for convention B (the nearest expiry that is not today's, the engine's rule) and A
 * (the contract expiring today on its expiry day, otherwise the same as B):
 * - the straddle is the listed strike nearest the snapshot's recorded spot (a tie goes to the lower strike)
 *   whose call and put both have a bid and an ask;
 * - entries: each snapshot in 09:15:15-09:16:30 (the first is the trade), the first snapshot in the 09:20
 *   and 09:30 minutes, and the 11:15 slot. The SELL value is the two bids; it is compared with the two
 *   legs' last trades in the entry minute (for a 09:15 sale the close of the 09:15 1-minute bar, the price
 *   WP11's near-miss assumed) and with the last trades at the snapshot;
 * - exits: the same strike's two asks at the 15:00 and 15:20 snapshots (the buy-back) against its last trades;
 * - the spread (ask - bid) as % of the mid, by slot;
 * - net per lot for the seller at the touch (sold at the bids, bought back at the asks) and at the last
 *   trades (WP11's mid fill), after charges at the dated schedule (src/engine/broker/charges.ts).
 * With at least 60 sessions the plan's §12 statistics run on the net per lot at the touch, with
 * day-clustered bootstrap intervals; before that the report says there are not enough sessions.
 *
 * Pure and web-standard (no node: imports).
 */
import { computeCharges } from "../broker/charges";
import { DAY_MS, MINUTE_MS, istAt, istDate, istMidnight, parseHHMM } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { MANUAL_SLOT, OPEN_SLOT, nearestStrike, type ExpiryKind, type QuoteRow } from "../market/quoteRecorder";
import type { Exchange, IndexId } from "../types";
import { mean, quantile } from "../util/math";
import { bonferroniAlpha, dayBlockBootstrap, deflatedSharpe, profitFactor, sessionReturns, type BlockBootstrap, type DeflatedSharpe, type SessionPnl } from "./metrics";
import type { TrialRecord } from "./trials";

export const MIN_SESSIONS = 60;
export const ENTRY_IDS = ["09:15", "09:20", "09:30", "11:15"] as const;
export const EXIT_IDS = ["15:00", "15:20"] as const;
export const CONVENTIONS = ["B", "A"] as const;
export type EntryId = (typeof ENTRY_IDS)[number];
export type ExitId = (typeof EXIT_IDS)[number];
export type Convention = (typeof CONVENTIONS)[number];

/** The opening-sale window: snapshots from 09:15:15 to 09:16:30 IST, inclusive. */
export const OPEN_SALE_WINDOW_MS = { from: parseHHMM("09:15") * MINUTE_MS + 15_000, to: parseHHMM("09:16") * MINUTE_MS + 30_000 } as const;
/** WP11 §9: the mid-fill edge of a 09:15 sale was 1.1-3.0% of premium; it survives only if the bid sits within about 0.5-1.5% of it. */
export const WP11_MID_EDGE_PCT = { lo: 1.1, hi: 3.0 } as const;
export const WP11_BID_TOLERANCE_PCT = { lo: 0.5, hi: 1.5 } as const;

const exchangeOf = (index: IndexId): Exchange => DEFAULT_CONFIG.indexSpecs[index].exchange;
const msOfDay = (ms: number) => ms - istMidnight(istDate(ms));
/** Whole rupees with a real minus sign: "−₹1,234". */
const inr = (x: number) => (Number.isFinite(x) ? `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}` : String(x));

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** One index and expiry kind at one snapshot. */
export interface ChainSnapshot {
  snapshotMs: number;
  slot: string;
  index: IndexId;
  kind: ExpiryKind;
  expiry: string;
  spot: number | null;
  lot: number;
  legs: Map<number, { CE?: QuoteRow; PE?: QuoteRow }>;
}

/** One session of one index. */
export interface SessionQuotes {
  date: string;
  index: IndexId;
  /** Chain snapshots by expiry kind, in time order. */
  byKind: Record<ExpiryKind, ChainSnapshot[]>;
  /** Every row of a trading symbol that day, in fetch order (for the last trade in a minute). */
  bySymbol: Map<string, QuoteRow[]>;
}

/** Rows grouped by session and index (manual snapshots left out), sorted by date then index. */
export function groupQuotes(rows: readonly QuoteRow[]): SessionQuotes[] {
  const sessions = new Map<string, SessionQuotes>();
  const chains = new Map<string, ChainSnapshot>();
  for (const r of rows) {
    if (r.slot === MANUAL_SLOT) continue;
    const date = istDate(r.snapshotMs);
    const sk = `${date}|${r.indexId}`;
    let s = sessions.get(sk);
    if (!s) sessions.set(sk, (s = { date, index: r.indexId, byKind: { next: [], expiring: [] }, bySymbol: new Map() }));
    const ck = `${sk}|${r.expiryKind}|${r.snapshotMs}`;
    let c = chains.get(ck);
    if (!c) {
      chains.set(ck, (c = { snapshotMs: r.snapshotMs, slot: r.slot, index: r.indexId, kind: r.expiryKind, expiry: r.expiry, spot: r.spot, lot: r.lotSize, legs: new Map() }));
      s.byKind[r.expiryKind].push(c);
    }
    if (c.spot === null && r.spot !== null) c.spot = r.spot;
    const leg = c.legs.get(r.strike) ?? {};
    leg[r.optionType] = r;
    c.legs.set(r.strike, leg);
    const list = s.bySymbol.get(r.tradingSymbol) ?? [];
    list.push(r);
    s.bySymbol.set(r.tradingSymbol, list);
  }
  for (const s of sessions.values()) {
    for (const k of ["next", "expiring"] as const) s.byKind[k].sort((a, b) => a.snapshotMs - b.snapshotMs);
    for (const list of s.bySymbol.values()) list.sort((a, b) => a.fetchedMs - b.fetchedMs);
  }
  return [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date) || a.index.localeCompare(b.index));
}

/** Convention B: never the expiring contract. A: the contract expiring today when there is one, else B's. */
export function chainsFor(s: SessionQuotes, conv: Convention): ChainSnapshot[] {
  return conv === "A" && s.byKind.expiring.length > 0 ? s.byKind.expiring : s.byKind.next;
}

// ---------------------------------------------------------------------------
// Straddles, last trades, entries and exits
// ---------------------------------------------------------------------------

export interface StraddleQuote {
  strike: number;
  ce: QuoteRow;
  pe: QuoteRow;
  /** Per unit: the two bids, the two asks, the two last trades (null unless both have one). */
  bid: number;
  ask: number;
  ltp: number | null;
  /** (ask - bid) / mid x 100 of the straddle. */
  spreadPct: number;
}

const twoSided = (r: QuoteRow | undefined): r is QuoteRow => !!r && r.bid !== null && r.ask !== null && r.bid > 0 && r.ask >= r.bid;

/** The straddle at `strike`, when both legs have a bid and an ask. */
export function straddleAt(c: ChainSnapshot, strike: number): StraddleQuote | null {
  const leg = c.legs.get(strike);
  if (!leg || !twoSided(leg.CE) || !twoSided(leg.PE)) return null;
  const bid = leg.CE.bid! + leg.PE.bid!;
  const ask = leg.CE.ask! + leg.PE.ask!;
  const ltp = leg.CE.ltp !== null && leg.PE.ltp !== null ? leg.CE.ltp + leg.PE.ltp : null;
  return { strike, ce: leg.CE, pe: leg.PE, bid, ask, ltp, spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100 };
}

/** The at-the-money straddle: the strike nearest the snapshot's spot (tie lower) among those with two-sided legs. */
export function atmStraddle(c: ChainSnapshot): StraddleQuote | null {
  if (c.spot === null) return null;
  const usable = [...c.legs.keys()].filter((k) => straddleAt(c, k) !== null);
  const k = nearestStrike(usable, c.spot);
  return k === null ? null : straddleAt(c, k);
}

export interface MinuteTrade {
  price: number;
  /** Exchange time of that trade (null when the source sent no last-trade time and the price is the LTP of the minute's last quote). */
  tradeMs: number | null;
  /** True when a quote fetched after the minute ended still showed this trade: it is the minute's last trade. */
  exact: boolean;
}

/**
 * The last trade of one contract in the minute starting at `minuteMs`, as the recorder saw it: the latest
 * last-trade time inside the minute across that day's quotes of the contract. Without last-trade times, the
 * LTP of the last quote fetched inside the minute (never exact). Null when no quote shows a trade in the minute.
 */
export function minuteLastTrade(rows: readonly QuoteRow[], minuteMs: number): MinuteTrade | null {
  const end = minuteMs + MINUTE_MS;
  let best: QuoteRow | null = null;
  for (const r of rows) {
    if (r.ltp === null || r.lastTradeMs === null || r.lastTradeMs < minuteMs || r.lastTradeMs >= end) continue;
    if (!best || r.lastTradeMs > best.lastTradeMs! || (r.lastTradeMs === best.lastTradeMs && r.fetchedMs > best.fetchedMs)) best = r;
  }
  if (best) {
    const t = best.lastTradeMs!;
    return { price: best.ltp!, tradeMs: t, exact: rows.some((r) => r.fetchedMs >= end && r.lastTradeMs === t) };
  }
  if (rows.some((r) => r.lastTradeMs !== null)) return null;
  const inMinute = rows.filter((r) => r.ltp !== null && r.fetchedMs >= minuteMs && r.fetchedMs < end);
  const last = inMinute.at(-1);
  return last ? { price: last.ltp!, tradeMs: null, exact: false } : null;
}

/** The minute whose last trade a sale at `entry` is compared with (WP11's mid fill was that 1-minute bar's close). */
export function referenceMinute(date: string, entry: EntryId): number {
  return istAt(date, entry);
}

/** The entry snapshots of a convention's chains: every one in 09:15:15-09:16:30, or the first of the 09:20 or 09:30 minute, or the 11:15 slot. */
export function entrySnapshots(chains: readonly ChainSnapshot[], entry: EntryId): ChainSnapshot[] {
  if (entry === "11:15") return chains.filter((c) => c.slot === "11:15").slice(0, 1);
  const open = chains.filter((c) => c.slot === OPEN_SLOT);
  if (entry === "09:15") return open.filter((c) => msOfDay(c.snapshotMs) >= OPEN_SALE_WINDOW_MS.from && msOfDay(c.snapshotMs) <= OPEN_SALE_WINDOW_MS.to);
  const from = parseHHMM(entry) * MINUTE_MS;
  const to = from + MINUTE_MS + (entry === "09:30" ? 1 : 0); // 09:31:00 itself is still in the recorder's window
  return open.filter((c) => msOfDay(c.snapshotMs) >= from && msOfDay(c.snapshotMs) < to).slice(0, 1);
}

export interface EntryQuote {
  snapshotMs: number;
  strike: number;
  spot: number;
  /** Per unit: the bids, the last trades at the snapshot, the legs' last trades in the reference minute. */
  bid: number;
  ltp: number | null;
  minuteLast: number | null;
  minuteExact: boolean;
  /** (bid - minute's last trades) / minute's last trades x 100: what selling at the bid gives up (negative = worse). */
  slipVsMinutePct: number | null;
  /** (bid - last trades at the snapshot) / last trades x 100. */
  slipVsLtpPct: number | null;
  spreadPct: number;
}

/** The sale at one entry snapshot (null when it has no usable at-the-money straddle). */
export function entryQuote(s: SessionQuotes, c: ChainSnapshot, entry: EntryId): EntryQuote | null {
  const st = atmStraddle(c);
  if (!st || c.spot === null) return null;
  const minute = referenceMinute(s.date, entry);
  const ce = minuteLastTrade(s.bySymbol.get(st.ce.tradingSymbol) ?? [], minute);
  const pe = minuteLastTrade(s.bySymbol.get(st.pe.tradingSymbol) ?? [], minute);
  const minuteLast = ce && pe ? ce.price + pe.price : null;
  return {
    snapshotMs: c.snapshotMs,
    strike: st.strike,
    spot: c.spot,
    bid: st.bid,
    ltp: st.ltp,
    minuteLast,
    minuteExact: !!(ce?.exact && pe?.exact),
    slipVsMinutePct: minuteLast !== null && minuteLast > 0 ? ((st.bid - minuteLast) / minuteLast) * 100 : null,
    slipVsLtpPct: st.ltp !== null && st.ltp > 0 ? ((st.bid - st.ltp) / st.ltp) * 100 : null,
    spreadPct: st.spreadPct,
  };
}

/** Charges of a straddle order (one order per leg) at the dated schedule. */
export function straddleCharges(side: "BUY" | "SELL", cePrice: number, pePrice: number, lot: number, exchange: Exchange, date: string): number {
  return computeCharges(side, cePrice, lot, exchange, date).total + computeCharges(side, pePrice, lot, exchange, date).total;
}

export interface StraddleSale {
  date: string;
  index: IndexId;
  convention: Convention;
  entry: EntryId;
  exit: ExitId;
  expiry: string;
  strike: number;
  lot: number;
  entryMs: number;
  exitMs: number;
  /** Per unit. */
  sellBid: number;
  sellMinuteLast: number | null;
  buyAsk: number;
  buyLtp: number | null;
  /** ₹ received per lot at the bids (the premium the % figures use). */
  premium: number;
  /** ₹ per lot after charges, sold at the bids and bought back at the asks: what a seller could have got. */
  netTouch: number;
  /** ₹ per lot after charges at the last trades (the entry minute's, then the exit snapshot's): WP11's mid-fill assumption. */
  netLast: number | null;
  /** (bids - the entry minute's last trades) / those x 100. */
  entrySlipPct: number | null;
  /** (bids - the last trades at the entry snapshot) / those x 100. */
  entrySlipVsLtpPct: number | null;
  /** (ask - last trades) / last trades x 100 at the buy-back. */
  exitSlipPct: number | null;
}

/** The straddle sold at an entry and bought back at an exit of one session, or null when a snapshot or a quote is missing. */
export function straddleSale(s: SessionQuotes, conv: Convention, entry: EntryId, exit: ExitId): StraddleSale | null {
  const chains = chainsFor(s, conv);
  const e = entrySnapshots(chains, entry)[0];
  if (!e) return null;
  const eq = entryQuote(s, e, entry);
  const st = atmStraddle(e);
  if (!eq || !st) return null;
  const x = chains.find((c) => c.slot === exit);
  const out = x ? straddleAt(x, st.strike) : null;
  if (!x || !out) return null;
  const lot = e.lot;
  const ex = exchangeOf(s.index);
  const exitDate = istDate(x.snapshotMs);
  const netTouch = lot * (st.bid - out.ask) - straddleCharges("SELL", st.ce.bid!, st.pe.bid!, lot, ex, s.date) - straddleCharges("BUY", out.ce.ask!, out.pe.ask!, lot, ex, exitDate);
  let netLast: number | null = null;
  const minute = referenceMinute(s.date, entry);
  const ceRef = minuteLastTrade(s.bySymbol.get(st.ce.tradingSymbol) ?? [], minute);
  const peRef = minuteLastTrade(s.bySymbol.get(st.pe.tradingSymbol) ?? [], minute);
  if (ceRef && peRef && out.ce.ltp !== null && out.pe.ltp !== null) {
    netLast = lot * (ceRef.price + peRef.price - out.ce.ltp - out.pe.ltp) - straddleCharges("SELL", ceRef.price, peRef.price, lot, ex, s.date) - straddleCharges("BUY", out.ce.ltp, out.pe.ltp, lot, ex, exitDate);
  }
  return {
    date: s.date,
    index: s.index,
    convention: conv,
    entry,
    exit,
    expiry: e.expiry,
    strike: st.strike,
    lot,
    entryMs: e.snapshotMs,
    exitMs: x.snapshotMs,
    sellBid: st.bid,
    sellMinuteLast: eq.minuteLast,
    buyAsk: out.ask,
    buyLtp: out.ltp,
    premium: st.bid * lot,
    netTouch: Math.round(netTouch * 100) / 100,
    netLast: netLast === null ? null : Math.round(netLast * 100) / 100,
    entrySlipPct: eq.slipVsMinutePct,
    entrySlipVsLtpPct: eq.slipVsLtpPct,
    exitSlipPct: out.ltp !== null && out.ltp > 0 ? ((out.ask - out.ltp) / out.ltp) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// The opening window and the spreads
// ---------------------------------------------------------------------------

export interface OpeningWindow {
  date: string;
  index: IndexId;
  convention: Convention;
  quotes: EntryQuote[];
  /** Mean over the window's snapshots (null without any). */
  meanSlipVsMinutePct: number | null;
  meanSlipVsLtpPct: number | null;
}

/** Every 09:15:15-09:16:30 snapshot of a session: the bids against the 09:15 minute's last trades. */
export function openingWindow(s: SessionQuotes, conv: Convention): OpeningWindow {
  const quotes = entrySnapshots(chainsFor(s, conv), "09:15")
    .map((c) => entryQuote(s, c, "09:15"))
    .filter((q): q is EntryQuote => q !== null);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length > 0 ? mean(v) : null;
  };
  return { date: s.date, index: s.index, convention: conv, quotes, meanSlipVsMinutePct: avg(quotes.map((q) => q.slipVsMinutePct)), meanSlipVsLtpPct: avg(quotes.map((q) => q.slipVsLtpPct)) };
}

/** The spread bucket of a snapshot: its IST minute inside the open window, else its slot. */
export function spreadBucket(c: ChainSnapshot): string {
  if (c.slot !== OPEN_SLOT) return c.slot;
  const m = Math.floor(msOfDay(c.snapshotMs) / MINUTE_MS);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export interface SpreadStat {
  index: IndexId;
  kind: ExpiryKind;
  bucket: string;
  n: number;
  /** The at-the-money straddle's (ask - bid) / mid, % : median, 75th percentile and mean. */
  median: number;
  p75: number;
  mean: number;
  /** Median of its two legs' own spreads, %. */
  legMedian: number;
}

/** The at-the-money straddle's spread by index, expiry kind and bucket, across sessions. */
export function spreadsBySlot(sessions: readonly SessionQuotes[]): SpreadStat[] {
  const groups = new Map<string, { index: IndexId; kind: ExpiryKind; bucket: string; s: number[]; legs: number[] }>();
  for (const s of sessions) {
    for (const kind of ["next", "expiring"] as const) {
      for (const c of s.byKind[kind]) {
        const st = atmStraddle(c);
        if (!st) continue;
        const bucket = spreadBucket(c);
        const key = `${s.index}|${kind}|${bucket}`;
        const g = groups.get(key) ?? { index: s.index, kind, bucket, s: [], legs: [] };
        g.s.push(st.spreadPct);
        for (const l of [st.ce, st.pe]) g.legs.push(((l.ask! - l.bid!) / ((l.ask! + l.bid!) / 2)) * 100);
        groups.set(key, g);
      }
    }
  }
  return [...groups.values()]
    .map((g) => ({ index: g.index, kind: g.kind, bucket: g.bucket, n: g.s.length, median: quantile(g.s, 0.5), p75: quantile(g.s, 0.75), mean: mean(g.s), legMedian: quantile(g.legs, 0.5) }))
    .sort((a, b) => a.index.localeCompare(b.index) || a.kind.localeCompare(b.kind) || a.bucket.localeCompare(b.bucket));
}

// ---------------------------------------------------------------------------
// Statistics (plan §12; WP11 §1.6)
// ---------------------------------------------------------------------------

export type CriterionVerdict = "PASS" | "FAIL" | "INSUFFICIENT" | "N/A";

export interface Criterion {
  name: string;
  verdict: CriterionVerdict;
  detail: string;
}

export interface VariantStats {
  variant: string;
  trades: number;
  sessions: number;
  net: number;
  boot: BlockBootstrap;
  pf: number;
  years: { year: string; trades: number; net: number }[];
  bonferroniAlpha: number;
  dsr: DeflatedSharpe;
  oos: { sessions: number; trades: number; mean: number; lo: number; hi: number; pf: number };
  criteria: Criterion[];
  verdict: "FAIL" | "INSUFFICIENT" | "NO FAILURE";
}

export interface StatsOptions {
  /** Trials for Bonferroni and the deflated Sharpe ratio (the ledger's lines plus this run's variants). */
  nTrials: number;
  /** Variance of the ledger's per-session Sharpe ratios (null: the null variance 1/(T-1)). */
  srVariance: number | null;
  /** Day-block bootstrap resamples (default 20,000), and the rerun when both lower bounds are above zero (default 100,000). */
  resamples?: number;
  confirmResamples?: number;
  seed?: number;
  capital?: number;
  minTrades?: number;
  minProfitFactor?: number;
  alpha?: number;
}

export const variantName = (index: IndexId, conv: Convention, entry: EntryId, exit: ExitId) => `${index} ${conv} ${entry} -> ${exit}`;

/** Sessions with every listed day present (no trade = an empty list), for the day-block bootstrap. */
export function sessionsOf(trades: readonly { date: string; pnl: number }[], days: readonly string[]): SessionPnl[] {
  const by = new Map<string, number[]>(days.map((d) => [d, []]));
  for (const t of trades) {
    const list = by.get(t.date);
    if (list) list.push(t.pnl);
    else by.set(t.date, [t.pnl]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnls]) => ({ day, pnls }));
}

/**
 * The §12 bar for one variant's net per lot at the touch: ≥ 180 trades; day-block 95% CI above zero per
 * trade and per session; PF ≥ 1.3; net > 0 in every calendar year with ≥ 20 trades; Bonferroni and the
 * deflated Sharpe ratio; the last 40% of sessions positive with a CI above zero and PF ≥ 1.3. The placebo
 * and the ±20% perturbations need entries at random times, which the recorder does not take: N/A.
 */
export function variantStats(variant: string, trades: readonly StraddleSale[], days: readonly string[], o: StatsOptions): VariantStats {
  const resamples = o.resamples ?? 20_000;
  const seed = o.seed ?? 7;
  const capital = o.capital ?? 500_000;
  const minTrades = o.minTrades ?? 180;
  const minPf = o.minProfitFactor ?? 1.3;
  const alpha = bonferroniAlpha(o.alpha ?? 0.05, o.nTrials);
  const pnls = trades.map((t) => t.netTouch);
  const sessions = sessionsOf(trades.map((t) => ({ date: t.date, pnl: t.netTouch })), days);
  let boot = dayBlockBootstrap(sessions, { resamples, seed });
  // As WP11 §1.5: with both lower bounds above zero, rerun with 100,000 resamples so a p-value can reach Bonferroni's level.
  if (boot.perTrade.lo > 0 && boot.perSession.lo > 0 && resamples < (o.confirmResamples ?? 100_000)) boot = dayBlockBootstrap(sessions, { resamples: o.confirmResamples ?? 100_000, seed });
  const pf = profitFactor(pnls);
  const byYear = new Map<string, number[]>();
  for (const t of trades) {
    const y = t.date.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), t.netTouch]);
  }
  const years = [...byYear].sort(([a], [b]) => a.localeCompare(b)).map(([year, xs]) => ({ year, trades: xs.length, net: xs.reduce((a, b) => a + b, 0) }));
  const dsr = deflatedSharpe(sessionReturns(sessions, capital), o.nTrials, o.srVariance);
  const sorted = [...new Set(days)].sort();
  const cut = Math.ceil(0.6 * sorted.length);
  const testDays = sorted.slice(cut);
  const testSet = new Set(testDays);
  const testTrades = trades.filter((t) => testSet.has(t.date));
  const testBoot = dayBlockBootstrap(sessionsOf(testTrades.map((t) => ({ date: t.date, pnl: t.netTouch })), testDays), { resamples, seed });
  const oos = { sessions: testDays.length, trades: testTrades.length, mean: testBoot.perTrade.estimate, lo: testBoot.perTrade.lo, hi: testBoot.perTrade.hi, pf: profitFactor(testTrades.map((t) => t.netTouch)) };
  const ci = (b: { estimate: number; lo: number; hi: number }) => `${inr(b.estimate)} (${inr(b.lo)} … ${inr(b.hi)})`;
  const yearsChecked = years.filter((y) => y.trades >= 20);
  const p = Math.max(boot.perTrade.p, boot.perSession.p);
  const criteria: Criterion[] = [
    { name: "≥ 180 trades", verdict: trades.length >= minTrades ? "PASS" : "INSUFFICIENT", detail: `${trades.length} trades` },
    { name: "placebo gap ≥ 2 SE", verdict: "N/A", detail: "needs entries at random times; the recorder takes fixed slots" },
    {
      name: "day-block 95% CI above zero (per trade and per session)",
      verdict: trades.length > 0 && boot.perTrade.lo > 0 && boot.perSession.lo > 0 ? "PASS" : "FAIL",
      detail: `${ci(boot.perTrade)} a trade; ${ci(boot.perSession)} a session`,
    },
    { name: "profit factor ≥ 1.3", verdict: pf >= minPf ? "PASS" : "FAIL", detail: `PF ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}` },
    {
      name: "net > 0 in every year with ≥ 20 trades",
      verdict: yearsChecked.length === 0 ? "N/A" : yearsChecked.every((y) => y.net > 0) ? "PASS" : "FAIL",
      detail: years.map((y) => `${y.year}: ${y.trades} trades, ${inr(y.net)}`).join("; ") || "no trades",
    },
    { name: "±20% robustness", verdict: "N/A", detail: "needs nearby entry and exit times; the recorder takes fixed slots" },
    {
      name: "Bonferroni and deflated Sharpe ≥ 0.95",
      verdict: p < alpha && dsr.dsr >= 0.95 ? "PASS" : "FAIL",
      detail: `p ${p.toExponential(1)} vs ${alpha.toExponential(1)} (N ${Math.floor(o.nTrials)}); DSR ${Number.isFinite(dsr.dsr) ? dsr.dsr.toFixed(2) : "n/a"}`,
    },
    {
      name: "last 40% of sessions: mean > 0, CI above zero, PF ≥ 1.3",
      verdict: testTrades.length > 0 && oos.mean > 0 && oos.lo > 0 && oos.pf >= minPf ? "PASS" : "FAIL",
      detail: `${oos.trades} trades on ${oos.sessions} sessions: ${ci({ estimate: oos.mean, lo: oos.lo, hi: oos.hi })}, PF ${Number.isFinite(oos.pf) ? oos.pf.toFixed(2) : "∞"}`,
    },
  ];
  const verdict = criteria.some((c) => c.verdict === "FAIL") ? "FAIL" : criteria.some((c) => c.verdict === "INSUFFICIENT") ? "INSUFFICIENT" : "NO FAILURE";
  return { variant, trades: trades.length, sessions: sorted.length, net: pnls.reduce((a, b) => a + b, 0), boot, pf, years, bonferroniAlpha: alpha, dsr, oos, criteria, verdict };
}

/** Day-clustered mean of a per-observation measure (e.g. the entry slippage), with its bootstrap interval. */
export function clusteredMean(obs: readonly { date: string; value: number }[], o: { resamples?: number; seed?: number } = {}): { n: number; days: number; mean: number; lo: number; hi: number; median: number } | null {
  if (obs.length === 0) return null;
  const days = [...new Set(obs.map((x) => x.date))];
  const boot = dayBlockBootstrap(sessionsOf(obs.map((x) => ({ date: x.date, pnl: x.value })), days), { resamples: o.resamples ?? 20_000, seed: o.seed ?? 7 });
  return { n: obs.length, days: days.length, mean: boot.perTrade.estimate, lo: boot.perTrade.lo, hi: boot.perTrade.hi, median: quantile(obs.map((x) => x.value), 0.5) };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export interface QuoteReport {
  rows: number;
  /** Distinct IST dates with any recorded quote. */
  sessions: string[];
  enoughSessions: boolean;
  bySession: SessionQuotes[];
  opening: OpeningWindow[];
  /** Every computable sale: index x convention x entry x exit x session. */
  sales: StraddleSale[];
  spreads: SpreadStat[];
  /**
   * Day-clustered entry slippage (%) per index, convention and entry (the entry's first snapshot): the bids
   * against the entry minute's last trades (`stat`, the question) and against the last trades at the same
   * snapshot (`vsLtp`, the spread alone, without the price moving inside the minute).
   */
  slippage: { index: IndexId | "both"; convention: Convention; entry: EntryId; stat: ReturnType<typeof clusteredMean>; vsLtp: ReturnType<typeof clusteredMean> }[];
  /** Null until MIN_SESSIONS sessions exist. */
  stats: VariantStats[] | null;
  dataQuality: {
    quotes: number;
    withBidAsk: number;
    withLastTradeTime: number;
    snapshots: number;
    openSnapshotsPerSession: number | null;
    /** Recorded rows by `source` (the Groww Trade API, Upstox). */
    bySource: Record<string, number>;
  };
}

export function buildQuoteReport(rows: readonly QuoteRow[], o: StatsOptions & { minSessions?: number }): QuoteReport {
  const bySession = groupQuotes(rows);
  const recorded = rows.filter((r) => r.slot !== MANUAL_SLOT);
  const sessions = [...new Set(bySession.map((s) => s.date))].sort();
  const enough = sessions.length >= (o.minSessions ?? MIN_SESSIONS);
  const sales: StraddleSale[] = [];
  const opening: OpeningWindow[] = [];
  for (const s of bySession) {
    for (const conv of CONVENTIONS) {
      if (conv === "A" && s.byKind.expiring.length === 0) continue; // A = B on a day without an expiring contract
      opening.push(openingWindow(s, conv));
      for (const entry of ENTRY_IDS) for (const exit of EXIT_IDS) {
        const sale = straddleSale(s, conv, entry, exit);
        if (sale) sales.push(sale);
      }
    }
  }
  // Convention A on days without an expiring contract is B's trade: add those copies for A's statistics.
  const aSales: StraddleSale[] = [];
  for (const s of bySession) {
    if (s.byKind.expiring.length > 0) continue;
    for (const sale of sales) if (sale.date === s.date && sale.index === s.index && sale.convention === "B") aSales.push({ ...sale, convention: "A" });
  }
  const allSales = [...sales, ...aSales];

  const slippage: QuoteReport["slippage"] = [];
  for (const conv of CONVENTIONS) {
    for (const entry of ENTRY_IDS) {
      for (const index of ["NIFTY", "SENSEX", "both"] as const) {
        const obs: { date: string; value: number }[] = [];
        const ltp: { date: string; value: number }[] = [];
        for (const s of bySession) {
          if (index !== "both" && s.index !== index) continue;
          const e = entrySnapshots(chainsFor(s, conv), entry)[0];
          const q = e ? entryQuote(s, e, entry) : null;
          if (typeof q?.slipVsMinutePct === "number") obs.push({ date: s.date, value: q.slipVsMinutePct });
          if (typeof q?.slipVsLtpPct === "number") ltp.push({ date: s.date, value: q.slipVsLtpPct });
        }
        slippage.push({ index, convention: conv, entry, stat: clusteredMean(obs, o), vsLtp: clusteredMean(ltp, o) });
      }
    }
  }

  let stats: VariantStats[] | null = null;
  if (enough) {
    stats = [];
    for (const index of ["NIFTY", "SENSEX"] as const) {
      const days = [...new Set(bySession.filter((s) => s.index === index).map((s) => s.date))].sort();
      for (const conv of CONVENTIONS) for (const entry of ENTRY_IDS) for (const exit of EXIT_IDS) {
        const trades = allSales.filter((t) => t.index === index && t.convention === conv && t.entry === entry && t.exit === exit);
        stats.push(variantStats(variantName(index, conv, entry, exit), trades, days, o));
      }
    }
  }

  const openCounts = bySession.map((s) => s.byKind.next.filter((c) => c.slot === OPEN_SLOT).length);
  return {
    rows: rows.length,
    sessions,
    enoughSessions: enough,
    bySession,
    opening,
    sales: allSales.sort((a, b) => a.date.localeCompare(b.date) || a.index.localeCompare(b.index) || a.convention.localeCompare(b.convention) || a.entry.localeCompare(b.entry) || a.exit.localeCompare(b.exit)),
    spreads: spreadsBySlot(bySession),
    slippage,
    stats,
    dataQuality: {
      quotes: recorded.length,
      withBidAsk: recorded.filter((r) => r.bid !== null && r.ask !== null).length,
      withLastTradeTime: recorded.filter((r) => r.lastTradeMs !== null).length,
      snapshots: new Set(recorded.map((r) => r.snapshotMs)).size,
      openSnapshotsPerSession: openCounts.length > 0 ? quantile(openCounts, 0.5) : null,
      bySource: recorded.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {}),
    },
  };
}

/** Ledger lines (reports/trials.jsonl) for the variants the §12 statistics evaluated. */
export function trialRecords(stats: readonly VariantStats[], o: { ts: string; data: string; capital?: number }): TrialRecord[] {
  return stats.map((s) => ({
    ts: o.ts,
    wp: "QUOTES",
    variant: `straddle sale at the touch: ${s.variant}`,
    params: { fill: "bids in, asks out", source: "D1 option_quotes" },
    data: o.data,
    trades: s.trades,
    net: Math.round(s.net * 100) / 100,
    notes: `recorded option quotes; ${inr(s.boot.perSession.estimate)} a session; verdict ${s.verdict}`,
    kind: "strategy",
    sessions: s.sessions,
    meanPerTrade: s.trades > 0 ? Math.round((s.net / s.trades) * 100) / 100 : 0,
    srSession: Number.isFinite(s.dsr.sr) ? s.dsr.sr : 0,
  }));
}

/** IST dates from `fromDate` (inclusive) to `toDate` (inclusive) as epoch-ms bounds for the page query. */
export function dateBounds(fromDate?: string, toDate?: string): { fromMs?: number; toMs?: number } {
  return { fromMs: fromDate ? istMidnight(fromDate) : undefined, toMs: toDate ? istMidnight(toDate) + DAY_MS : undefined };
}
