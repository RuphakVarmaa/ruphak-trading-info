/**
 * WP16 research helpers (reports/wp16-put-spreads.md; research only, nothing in the live engine
 * imports this): the strikes of a weekly vertical credit spread placed a number of expected moves out
 * of the money with a width in strike steps or in expected moves, its value at cash settlement, an
 * approximation of its margin, the expiry-week key that clusters overlapping positions, two-leg fills
 * on 1-minute bars (both legs in one minute, as a spread order), the n-th session before a date, the
 * turn-of-the-month windows, the circular block-bootstrap gap between the mean of flagged days and of
 * the other days, and the dated STT on futures sales. Every definition is frozen in the report's §1.
 *
 * Pure and web-standard (no node: imports), like intraday1m.ts, expiryCalendar.ts and overnight.ts.
 */
import { syncMinute } from "./expiryCalendar";
import { fillPrice, type FillMode, type MinuteSeries } from "./intraday1m";
import { seededRandom } from "./metrics";
import { strikeBeyond } from "./shortPremium";
import { quantile, stdev } from "../util/math";

// ---------------------------------------------------------------------------
// Strikes, settlement value, width and margin
// ---------------------------------------------------------------------------

/** A bull put spread (short put, long put further below) or its mirror, a bear call spread. */
export type SpreadSide = "put" | "call";

/** The long leg's distance from the short leg: a number of strike steps, or a multiple of the expected move. */
export type WidthSpec = { kind: "steps"; steps: number } | { kind: "em"; mult: number };

export interface SpreadStrikes {
  short: number;
  long: number;
  /** Where the rule aimed each leg (index points). */
  shortTarget: number;
  longTarget: number;
}

/**
 * The strikes of a vertical credit spread `m` expected moves out of the money.
 * - Short leg: the listed strike strictly out of the money (below `level` for a put, above it for a
 *   call) nearest level ∓ m·em; a tie goes to the strike nearer the level.
 * - Long leg, width in steps: exactly short ∓ steps·step, which must be listed.
 * - Long leg, width in expected moves: the listed strike strictly beyond the short one nearest
 *   short ∓ mult·em (a tie goes to the strike nearer the short one).
 * Null when a leg has no listed strike, or the inputs are not positive and finite.
 */
export function spreadStrikes(strikes: readonly number[], level: number, em: number, m: number, width: WidthSpec, side: SpreadSide, step: number): SpreadStrikes | null {
  if (!(level > 0) || !(em > 0) || !(m > 0) || !Number.isFinite(level + em + m)) return null;
  const dir = side === "put" ? -1 : 1;
  const beyond = side === "put" ? "below" : "above";
  const shortTarget = level + dir * m * em;
  const short = strikeBeyond(strikes, level, shortTarget, beyond);
  if (short === null) return null;
  if (width.kind === "steps") {
    if (!(width.steps > 0) || !(step > 0)) return null;
    const longTarget = short + dir * width.steps * step;
    const listed = strikes.some((k) => Math.abs(k - longTarget) < 1e-9);
    return listed ? { short, long: longTarget, shortTarget, longTarget } : null;
  }
  if (!(width.mult > 0)) return null;
  const longTarget = short + dir * width.mult * em;
  const long = strikeBeyond(strikes, short, longTarget, beyond);
  return long === null ? null : { short, long, shortTarget, longTarget };
}

/** Width of a vertical spread in index points. */
export function spreadWidth(s: Pick<SpreadStrikes, "short" | "long">): number {
  return Math.abs(s.short - s.long);
}

/**
 * What the seller of the spread owes per unit at an index level (cash settlement at intrinsic value):
 * put max(Ks − S, 0) − max(Kl − S, 0); call max(S − Ks, 0) − max(S − Kl, 0). Always in [0, width].
 */
export function spreadValueAt(side: SpreadSide, s: Pick<SpreadStrikes, "short" | "long">, level: number): number {
  if (side === "put") return Math.max(s.short - level, 0) - Math.max(s.long - level, 0);
  return Math.max(level - s.short, 0) - Math.max(level - s.long, 0);
}

/** First day of the SEBI measure: a further 2% extreme-loss margin on short options on their expiry day (circular of 1 Oct 2024). */
export const EXPIRY_ELM_FROM = "2024-11-20";

/**
 * Margin of one lot of a vertical credit spread, approximated as in WP10 §6: SPAN about the width × lot
 * (a hedged spread's scenario loss), plus exposure margin of 2% of the short leg's notional (index
 * level × lot), plus another 2% when the short option is held on its own expiry day from 20 Nov 2024.
 */
export function spreadMargin(o: { width: number; lot: number; level: number; onExpiryDay: boolean; date: string }): { span: number; exposure: number; elm: number; total: number } {
  const span = o.width * o.lot;
  const exposure = 0.02 * o.level * o.lot;
  const elm = o.onExpiryDay && o.date >= EXPIRY_ELM_FROM ? 0.02 * o.level * o.lot : 0;
  return { span, exposure, elm, total: span + exposure + elm };
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

const utcMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** The Monday (YYYY-MM-DD) of the ISO week of a date: the expiry-week cluster key. */
export function weekKey(date: string): string {
  const t = utcMs(date);
  if (!Number.isFinite(t)) throw new Error(`Invalid date ${date}`);
  const wd = (new Date(t).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(t - wd * 86_400_000).toISOString().slice(0, 10);
}

/** The `n`-th session strictly before `day` in an ascending list (n = 1: the session before); null when there is none. */
export function nthSessionBefore(sessions: readonly string[], day: string, n: number): string | null {
  if (!(n >= 1)) return null;
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - n;
  return i >= 0 ? sessions[i] : null;
}

// ---------------------------------------------------------------------------
// Two-leg fills on 1-minute bars
// ---------------------------------------------------------------------------

/**
 * A spread order on 1-minute bars: both legs fill in the first minute in [m, m + wait] in which both
 * have a bar (a combination order). Entry: the short leg sells, the long leg buys; the conservative
 * fill sells at the bar's low and buys at its high, mid fills at closes. Null without such a minute.
 */
export function spreadEntry(short: MinuteSeries, long: MinuteSeries, m: number, wait: number, mode: Exclude<FillMode, "print">): { m: number; shortIn: number; longIn: number } | null {
  const at = syncMinute([short, long], m, wait);
  if (at === null) return null;
  return { m: at, shortIn: fillPrice(short.at(at)!, "sell", mode), longIn: fillPrice(long.at(at)!, "buy", mode) };
}

/**
 * Closing the spread on a later day: both legs in the first minute in [m, m + wait] in which both have
 * a bar (the short leg buys back, the long leg sells); without one, each leg at its last close at or
 * before m that day (a stale exit). Null when a leg has no bar at all by m.
 */
export function spreadExit(short: MinuteSeries | null, long: MinuteSeries | null, m: number, wait: number, mode: Exclude<FillMode, "print">): { m: number; shortOut: number; longOut: number; stale: boolean } | null {
  if (!short || !long) return null;
  const at = syncMinute([short, long], m, wait);
  if (at !== null) return { m: at, shortOut: fillPrice(short.at(at)!, "buy", mode), longOut: fillPrice(long.at(at)!, "sell", mode), stale: false };
  const a = short.lastUpTo(m);
  const b = long.lastUpTo(m);
  if (!a || !b) return null;
  return { m, shortOut: a.c, longOut: b.c, stale: true };
}

// ---------------------------------------------------------------------------
// Turn of the month
// ---------------------------------------------------------------------------

export interface TomWindow {
  /** YYYY-MM of the month whose last session is T−1. */
  month: string;
  /** The session whose close starts the window (the session before the window's first day). */
  start: string;
  /** The window's sessions in order: the last `before` sessions of the month, then the first `after` of the next. */
  days: string[];
  /** The window's last session, whose close ends it. */
  end: string;
}

/**
 * Turn-of-the-month windows of an ascending list of regular sessions: for every month followed by
 * another month with sessions, the last `before` sessions of the month and the first `after` sessions
 * of the next one ([−1, +3] by default: the last trading day and the first three of the next month).
 * A window needs a session before its first day (its start) and all of its own sessions in the list.
 */
export function tomWindows(sessions: readonly string[], before = 1, after = 3): TomWindow[] {
  const out: TomWindow[] = [];
  if (!(before >= 1) || !(after >= 1)) return out;
  for (let i = 0; i + 1 < sessions.length; i++) {
    const month = sessions[i].slice(0, 7);
    if (sessions[i + 1].slice(0, 7) === month) continue; // sessions[i] is the month's last session (T−1)
    const firstIx = i - before + 1;
    const lastIx = i + after;
    if (firstIx < 1 || lastIx >= sessions.length) continue;
    const days = sessions.slice(firstIx, lastIx + 1);
    // The before-days must lie in the month and the after-days in the next one.
    const next = sessions[i + 1].slice(0, 7);
    if (!days.slice(0, before).every((d) => d.slice(0, 7) === month) || !days.slice(before).every((d) => d.slice(0, 7) === next)) continue;
    out.push({ month, start: sessions[firstIx - 1], days, end: sessions[lastIx] });
  }
  return out;
}

export interface MeanGap {
  /** Mean of x over the flagged sessions minus the mean over the others. */
  gap: number;
  se: number;
  lo: number;
  hi: number;
  /** One-sided p for "gap ≤ 0": (1 + #{resamples ≤ 0}) / (1 + resamples). */
  p: number;
  nIn: number;
  nOut: number;
  resamples: number;
}

/**
 * Circular block bootstrap (Politis & Romano 1992) of the gap between the mean of a session series over
 * flagged sessions and over the others: each resample joins ⌈n / block⌉ blocks of `block` consecutive
 * sessions starting at uniform positions (wrapping), cut to n. Resamples without a flagged or without
 * an unflagged session are left out. Percentile interval; seeded.
 */
export function meanGapBootstrap(x: readonly number[], flag: readonly boolean[], o: { block: number; resamples?: number; seed?: number; level?: number }): MeanGap {
  const n = x.length;
  if (flag.length !== n) throw new Error("x and flag differ in length");
  const block = Math.max(1, Math.floor(o.block));
  const resamples = Math.max(1, Math.floor(o.resamples ?? 10_000));
  const level = o.level ?? 0.95;
  const rnd = seededRandom(o.seed ?? 7);
  let sIn = 0;
  let nIn = 0;
  let sOut = 0;
  let nOut = 0;
  for (let i = 0; i < n; i++) {
    if (flag[i]) {
      sIn += x[i];
      nIn++;
    } else {
      sOut += x[i];
      nOut++;
    }
  }
  const gap = nIn > 0 && nOut > 0 ? sIn / nIn - sOut / nOut : NaN;
  const dist: number[] = [];
  const nBlocks = Math.ceil(n / block);
  for (let b = 0; b < resamples && n > 0; b++) {
    let a = 0;
    let ka = 0;
    let c = 0;
    let kc = 0;
    let taken = 0;
    for (let j = 0; j < nBlocks && taken < n; j++) {
      const start = Math.floor(rnd() * n);
      for (let t = 0; t < block && taken < n; t++, taken++) {
        const i = (start + t) % n;
        if (flag[i]) {
          a += x[i];
          ka++;
        } else {
          c += x[i];
          kc++;
        }
      }
    }
    if (ka > 0 && kc > 0) dist.push(a / ka - c / kc);
  }
  const tail = (1 - level) / 2;
  return {
    gap,
    se: dist.length > 1 ? stdev(dist) : NaN,
    lo: dist.length ? quantile(dist, tail) : NaN,
    hi: dist.length ? quantile(dist, 1 - tail) : NaN,
    p: (1 + dist.filter((v) => v <= 0).length) / (1 + dist.length),
    nIn,
    nOut,
    resamples,
  };
}

/**
 * STT on the sale of an index future, % of notional, by the Finance Act dates the option schedule
 * already encodes (WP10's RESEARCH_CHARGE_SCHEDULES) and R6 §1.4 [K1]: 0.01% → 0.0125% (1 Apr 2023) →
 * 0.02% (1 Oct 2024) → 0.05% (1 Apr 2026). WP15's FUT_STT.
 */
export function futuresSttPct(date: string): number {
  if (date >= "2026-04-01") return 0.05;
  if (date >= "2024-10-01") return 0.02;
  if (date >= "2023-04-01") return 0.0125;
  return 0.01;
}
