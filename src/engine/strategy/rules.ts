/**
 * The plan's no-entry rules N2-N4 (docs/research/options-trading-plan.md §4), WP9b. Each is behind
 * cfg.rules.* and off by default; each only removes trades or moves them to a longer-dated contract,
 * so with every switch off the engine is unchanged. Results: reports/wp9b-buy-signals.md.
 *
 * N2  No entry after a volatility jump or a big run: India VIX more than 10% above its close five
 *     sessions earlier, more than 8% up on the day, or in the top third of its past year; or the index
 *     more than 2% away from its close five sessions earlier. The daily conditions use closes up to the
 *     previous session only, exactly as the evidence behind the rule measured them
 *     (docs/research/notes/q1-premium-timing.md §6; its scripts/panel.py: vix_chg5_prev, vix_pctile,
 *     ret5_prev); "on the day" is the engine's own intraday VIX change (features.vixChangePct, the
 *     measure that also marks the EVENT regime at 8%).
 * N3  Morning only: new entries from 09:30 until 11:15, and every position out at 11:15.
 * N4  Never buy a contract with one session or less left: take the next weekly instead (Mondays
 *     NIFTY, Wednesdays SENSEX), or skip when no listed contract has enough sessions left.
 */
import { istAt, istDate, istMinutes, parseHHMM } from "../clock";
import type { EngineConfig } from "../config";
import { istDateOf } from "../market/candles";
import type { MarketDataSource } from "../ports";
import { MARKET_SYMBOLS, type Candle, type GateResult, type IndexId, type MarketFeatures } from "../types";
import { squareOffMs } from "./gates";

// ---------------------------------------------------------------------------------------------
// N2: volatility jump or a big run
// ---------------------------------------------------------------------------------------------

export function n2Enabled(cfg: EngineConfig): boolean {
  return cfg.rules?.n2?.enabled === true;
}

/** The daily (previous-close) inputs of N2 for one index and session. */
export interface N2Daily {
  /** Date of the latest close used (the previous session when the data is complete). */
  lastSession: string;
  /** India VIX close(D-1) / close(D-6) - 1, percent; null with fewer than 6 closes. */
  vix5dChangePct: number | null;
  /** Share of the prior closes in the window strictly below VIX close(D-1); null with too short a history. */
  vixPctile: number | null;
  /** Prior closes the percentile compared against. */
  vixPctileN: number;
  /** ln(index close(D-1) / close(D-6)) in percent; null with fewer than 6 closes. */
  run5dPct: number | null;
}

/** Finite, positive closes of daily bars dated before `today`, ascending (one per date). */
export function closesBefore(daily: readonly Candle[], today: string): { date: string; c: number }[] {
  const byDate = new Map<string, number>();
  for (const b of daily) {
    const d = istDateOf(b.t);
    if (d < today && Number.isFinite(b.c) && b.c > 0) byDate.set(d, b.c);
  }
  return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, c]) => ({ date, c }));
}

/** Minimum closes in the percentile window, the current one included (Q1's min_periods). */
export const N2_MIN_PCTILE_CLOSES = 120;

/** N2's previous-close conditions from daily bars visible before `today`; null without any VIX close. */
export function n2Daily(vixDaily: readonly Candle[], indexDaily: readonly Candle[], today: string, cfg: EngineConfig): N2Daily | null {
  const vix = closesBefore(vixDaily, today);
  const idx = closesBefore(indexDaily, today);
  if (vix.length === 0) return null;
  const n = vix.length;
  const last = vix[n - 1].c;
  const vix5dChangePct = n >= 6 ? (last / vix[n - 6].c - 1) * 100 : null;
  const window = vix.slice(Math.max(0, n - cfg.rules.n2.vixPctileSessions), n - 1);
  const vixPctile = window.length + 1 >= N2_MIN_PCTILE_CLOSES ? window.filter((x) => x.c < last).length / window.length : null;
  const m = idx.length;
  const run5dPct = m >= 6 ? Math.log(idx[m - 1].c / idx[m - 6].c) * 100 : null;
  return { lastSession: vix[n - 1].date, vix5dChangePct, vixPctile, vixPctileN: window.length, run5dPct };
}

/** Which N2 conditions hold; an input that cannot be computed blocks (the rule fails closed). */
export function n2Blocks(d: N2Daily | null, vixChangePct: number, cfg: EngineConfig): string[] {
  const r = cfg.rules.n2;
  if (!d) return ["no India VIX history"];
  const out: string[] = [];
  if (d.vix5dChangePct === null) out.push("fewer than 6 VIX closes");
  else if (d.vix5dChangePct > r.vix5dJumpPct) out.push(`VIX +${d.vix5dChangePct.toFixed(1)}% over 5 sessions (> ${r.vix5dJumpPct}%)`);
  if (Number.isFinite(vixChangePct) && vixChangePct > r.vixDayJumpPct) out.push(`VIX +${vixChangePct.toFixed(1)}% today (> ${r.vixDayJumpPct}%)`);
  if (d.vixPctile === null) out.push(`fewer than ${N2_MIN_PCTILE_CLOSES} VIX closes for the 1-year percentile`);
  else if (d.vixPctile > r.vixPctileAbove) out.push(`VIX at the ${Math.round(d.vixPctile * 100)}th percentile of its past year (top third)`);
  if (d.run5dPct === null) out.push("fewer than 6 index closes");
  else if (Math.abs(d.run5dPct) > r.run5dPct) out.push(`index ${d.run5dPct >= 0 ? "+" : ""}${d.run5dPct.toFixed(2)}% over 5 sessions (beyond ±${r.run5dPct}%)`);
  return out;
}

export function n2Gate(d: N2Daily | null, f: Pick<MarketFeatures, "vixChangePct">, cfg: EngineConfig): GateResult {
  const blocks = n2Blocks(d, f.vixChangePct, cfg);
  const fmt = (x: number | null, unit = "%") => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}${unit}`);
  const ok = d
    ? `VIX ${fmt(d.vix5dChangePct)} over 5 sessions, ${fmt(f.vixChangePct)} today, ${d.vixPctile === null ? "n/a" : `${Math.round(d.vixPctile * 100)}th`} percentile of its year; index ${fmt(d.run5dPct)} over 5 sessions`
    : "";
  return { gate: "vol_jump", label: "N2: no entry after a volatility jump or a big run", passed: blocks.length === 0, detail: blocks.length ? blocks.join("; ") : ok };
}

const n2Cache = new WeakMap<object, Map<string, { at: number; value: N2Daily | null; complete: boolean }>>();
const N2_RETRY_MS = 10 * 60_000;

/**
 * N2's daily inputs for an index and the session of `t`, from the market data source's daily bars
 * (read once per index and day, re-read every 10 minutes while the previous session's close is
 * still missing). null without a data source or VIX history.
 */
export async function n2DailyFor(market: MarketDataSource | undefined, index: IndexId, t: number, prevSession: string | null, cfg: EngineConfig): Promise<N2Daily | null> {
  if (!market) return null;
  const date = istDate(t);
  let byKey = n2Cache.get(market);
  if (!byKey) n2Cache.set(market, (byKey = new Map()));
  const key = `${index}|${date}|${cfg.rules.n2.vixPctileSessions}`;
  const hit = byKey.get(key);
  if (hit && (hit.complete || t - hit.at < N2_RETRY_MS)) return hit.value;
  let value: N2Daily | null = null;
  try {
    const snap = await market.snapshot(t);
    value = n2Daily(snap.daily[MARKET_SYMBOLS.INDIAVIX] ?? [], snap.daily[MARKET_SYMBOLS[index]] ?? [], date, cfg);
  } catch {
    value = null;
  }
  byKey.set(key, { at: t, value, complete: value !== null && (prevSession === null || value.lastSession >= prevSession) });
  return value;
}

// ---------------------------------------------------------------------------------------------
// N3: morning only
// ---------------------------------------------------------------------------------------------

export function n3Enabled(cfg: EngineConfig): boolean {
  return cfg.rules?.n3?.enabled === true;
}

/** Whether a new entry decided at `t` falls inside N3's morning window [entryFrom, exitBy). */
export function n3Allows(t: number, cfg: EngineConfig): boolean {
  const m = istMinutes(t);
  return m >= parseHHMM(cfg.rules.n3.entryFromIst) && m < parseHHMM(cfg.rules.n3.exitByIst);
}

export function n3Gate(t: number, cfg: EngineConfig): GateResult {
  const { entryFromIst: from, exitByIst: to } = cfg.rules.n3;
  const m = istMinutes(t);
  const ok = n3Allows(t, cfg);
  return { gate: "morning_only", label: `N3: morning entries ${from}–${to} IST, out by ${to}`, passed: ok, detail: ok ? "inside the morning window" : m < parseHHMM(from) ? "too early" : "after the morning window" };
}

/** When a position opened at `t` must be closed: the square-off, or N3's exit when that is earlier. */
export function positionExitByMs(t: number, cfg: EngineConfig): number {
  const sq = squareOffMs(t, cfg);
  return n3Enabled(cfg) ? Math.min(sq, istAt(istDate(t), cfg.rules.n3.exitByIst)) : sq;
}

// ---------------------------------------------------------------------------------------------
// N4: sessions left to expiry
// ---------------------------------------------------------------------------------------------

/** Fewest sessions after today a bought contract must have to its expiry (1: the engine's own rule, never the contract expiring today). */
export function minSessionsLeft(cfg: EngineConfig): number {
  return cfg.rules?.n4?.enabled === true ? cfg.rules.n4.minSessionsLeft : 1;
}
