/**
 * WP13 research helpers (reports/wp13-expiry-calendar-events.md; research only, nothing in the live
 * engine imports this): the expected move for the rest of a session, the first minute in which every
 * leg of a multi-leg order traded, the calendar spread's no-arbitrage check, positions held over one
 * or more nights (entered on one day's 1-minute bars and closed on a later day's), bootstrap blocks
 * keyed by something other than the entry day, the walk-forward pick, the ±20% robustness rule and
 * the verdict of a list of criteria. Every definition is frozen in the report's §1.
 *
 * Pure and web-standard (no node: imports), like intraday1m.ts and shortPremium.ts.
 */
import { fillPrice, laterMode, type FillMode, type LegFill, type MinuteSeries } from "./intraday1m";
import type { SessionPnl } from "./metrics";

/** Minutes in the regular session (09:15-15:30). */
export const SESSION_MINUTES = 375;
/** The close of the regular session, 15:30 as a minute of the day. */
export const CLOSE_MIN = 15 * 60 + 30;

/**
 * Expected 1-sigma index move over what is left of the session after an order at `orderMin`:
 * level × VIX/100 × √(((close − orderMin) / 375) / 252). Zero at or after the close.
 */
export function remainingSessionEm(level: number, vixPct: number, orderMin: number, closeMin = CLOSE_MIN): number {
  const left = Math.max(0, closeMin - orderMin) / SESSION_MINUTES;
  return level * (vixPct / 100) * Math.sqrt(left / 252);
}

/** The first minute in [from, from + wait] in which every series has a bar; null when there is none. */
export function syncMinute(series: readonly MinuteSeries[], from: number, wait: number): number | null {
  for (let m = from; m <= from + wait; m++) if (series.every((s) => s.at(m) !== undefined)) return m;
  return null;
}

/**
 * Calendar spread at one strike: the later expiry's straddle must be worth more than the earlier
 * expiry's (time value only grows with time to expiry). Prices from one synchronous minute.
 */
export function calendarNoArbitrage(o: { nearCall: number; nearPut: number; farCall: number; farPut: number }): boolean {
  return o.farCall + o.farPut - (o.nearCall + o.nearPut) > 0;
}

export interface OvernightLeg {
  /** The leg's bars on the entry day. */
  entry: MinuteSeries;
  /** The same contract's bars on the exit day (null when it has none in the extract). */
  exit: MinuteSeries | null;
  side: "short" | "long";
  /**
   * Exit price when the leg has no bar at all on the exit day up to the end of the exit window: for
   * a leg expiring that day, its intrinsic value at the index level (the price it settles near).
   * Without it such a leg has no exit price.
   */
  exitFallback?: number | null;
}

export interface OvernightSpec {
  legs: readonly OvernightLeg[];
  entryMin: number;
  /** Each leg fills in its first bar within [entryMin, entryMin + entryWait] on the entry day. */
  entryWait: number;
  exitMin: number;
  /** Each leg fills in its first bar within [exitMin, exitMin + exitWait] on the exit day, else at its last close before (stale). */
  exitWait: number;
  mode: Exclude<FillMode, "print">;
}

export type OvernightResult = { legs: LegFill[]; entryMin: number; exitMin: number; entryValue: number } | { skip: "no entry bar" | "no exit price" };

/**
 * A position opened on one day and closed at a clock time on a later day, without a stop: shorts sell
 * at the bar's low (conservative) or close (mid) and buy back at the high or close; longs the reverse.
 * A leg with no bar in the exit window exits at its last close before exitMin that day (stale); with
 * no bar at all that day by the end of the window, at its `exitFallback` (stale), else the trade has
 * no exit price and is not booked (the caller counts it).
 */
export function runOvernight(s: OvernightSpec): OvernightResult {
  const entries = s.legs.map((l) => l.entry.firstFrom(s.entryMin, s.entryWait));
  if (entries.some((b) => b === undefined)) return { skip: "no entry bar" };
  const later = laterMode(s.mode);
  const legs: LegFill[] = [];
  for (let i = 0; i < s.legs.length; i++) {
    const l = s.legs[i];
    const eb = entries[i]!;
    const entry = fillPrice(eb, l.side === "long" ? "buy" : "sell", s.mode);
    const xb = l.exit?.firstFrom(s.exitMin, s.exitWait);
    if (xb) {
      legs.push({ side: l.side, entry, exit: fillPrice(xb, l.side === "long" ? "sell" : "buy", later), entryMin: eb.m, exitMin: xb.m, staleExit: false });
      continue;
    }
    const prev = l.exit?.lastUpTo(s.exitMin);
    const px = prev ? prev.c : l.exitFallback;
    if (px === undefined || px === null) return { skip: "no exit price" };
    legs.push({ side: l.side, entry, exit: px, entryMin: eb.m, exitMin: s.exitMin, staleExit: true });
  }
  const entryValue = legs.reduce((a, l) => a + (l.side === "long" ? l.entry : -l.entry), 0);
  return { legs, entryMin: Math.max(...legs.map((l) => l.entryMin)), exitMin: s.exitMin, entryValue };
}

/**
 * Bootstrap blocks: one block per key in `keys` (in key order), each holding the net P&L of the
 * trades whose block key it is. Keys without a trade are empty blocks (they count as ₹0 per block).
 * Trades with a key outside `keys` get a block of their own.
 */
export function blocksOf(trades: readonly { block: string; net: number }[], keys: readonly string[]): SessionPnl[] {
  const by = new Map<string, number[]>(keys.map((k) => [k, []]));
  for (const t of trades) {
    const l = by.get(t.block);
    if (l) l.push(t.net);
    else by.set(t.block, [t.net]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnls]) => ({ day, pnls }));
}

/** The `k` worst blocks by summed net (ascending), with their trade counts. */
export function worstBlocks(trades: readonly { block: string; net: number }[], k: number): { block: string; net: number; n: number }[] {
  const by = new Map<string, { net: number; n: number }>();
  for (const t of trades) {
    const a = by.get(t.block) ?? { net: 0, n: 0 };
    a.net += t.net;
    a.n++;
    by.set(t.block, a);
  }
  return [...by]
    .map(([block, a]) => ({ block, ...a }))
    .sort((x, y) => x.net - y.net || x.block.localeCompare(y.block))
    .slice(0, Math.max(0, k));
}

/** The last session strictly before `day` in an ascending list; null when there is none. */
export function sessionBefore(sessions: readonly string[], day: string): string | null {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? sessions[lo - 1] : null;
}

/** The last day of the first ⌈frac·n⌉ sorted days (the walk-forward cut); null for no days. */
export function cutDate(days: readonly string[], frac = 0.6): string | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return sorted[Math.max(0, Math.ceil(frac * sorted.length) - 1)];
}

/**
 * The walk-forward pick: the candidate with the highest finite in-sample score, ties broken by name
 * (alphabetical), so the choice is deterministic. Null when no candidate has a finite score.
 */
export function pickBest<T>(candidates: readonly T[], score: (c: T) => number, name: (c: T) => string): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    const s = score(c);
    if (!Number.isFinite(s)) continue;
    if (best === null) {
      best = c;
      continue;
    }
    const sb = score(best);
    if (s > sb || (s === sb && name(c) < name(best))) best = c;
  }
  return best;
}

/**
 * The ±20% robustness rule (plan §12, protocol criterion 8): at least 80% of the perturbed variants
 * net > 0, and the worst nets no less than base − 50% × |base|.
 */
export function robustness(baseNet: number, perturbed: readonly number[]): { positive: number; total: number; worst: number | null; pass: boolean } {
  const positive = perturbed.filter((x) => x > 0).length;
  const worst = perturbed.length ? Math.min(...perturbed) : null;
  const pass = perturbed.length > 0 && positive / perturbed.length >= 0.8 && worst !== null && worst >= baseNet - 0.5 * Math.abs(baseNet);
  return { positive, total: perturbed.length, worst, pass };
}

export type CriterionVerdict = "PASS" | "FAIL" | "INSUFFICIENT" | "NOT RUN" | "N/A";

/**
 * Overall verdict of a list of criteria: FAIL when any criterion fails or was not run (a step is
 * skipped only after an earlier failure), else INSUFFICIENT when the sample is too small, else PASS.
 */
export function overallVerdict(vs: readonly CriterionVerdict[]): "PASS" | "FAIL" | "INSUFFICIENT" {
  if (vs.includes("FAIL") || vs.includes("NOT RUN")) return "FAIL";
  if (vs.includes("INSUFFICIENT")) return "INSUFFICIENT";
  return "PASS";
}
