/**
 * Readers for the research → live bridge (FLOW_STATS in flowStats.generated.ts, types in flowStatsTypes.ts):
 *
 * - baselines: `volumeMedian` (median 1-minute volume) and `oiChangeP90Pct` (typical 15-minute |ΔOI| % at
 *   ATM±2) are keyed by the research. The key we ask for is "NIFTY|09:30|ATM" (index, the 15-minute bucket's
 *   start, moneyness ATM / 1 / 2 / 3+, optionally "|CE" or "|PE"), but any key naming those parts in another
 *   order or with other separators is read too ("SENSEX:0930:±2", "NIFTY_10:15_3+_PE", "NIFTY|570|1" with the
 *   bucket as minutes of the day). A field a key leaves out matches every value; the most specific keys win
 *   and ties are combined by their median;
 * - entry times: `entryTimes[index]` windows ("09:30–10:30", optionally with a DTE tag such as "DTE 2–5",
 *   "DTE 6+" or "expiry day") and the verdict for now;
 * - rules: the positive-verdict check (verdict "positive" AND ci95[0] > 0 AND a test sample) and the rules'
 *   time strings.
 *
 * Pure and web-standard. Never invents a number: a missing baseline or statistic is null, and callers say so.
 */
import { SESSION, formatHHMM } from "../clock";
import type { FlowEntryWindowView, IndexId } from "../api-types";
import { FLOW_STATS } from "./flowStats.generated";
import type { EntryTimeStats, FlowStatsFile, RuleStats } from "./flowStatsTypes";

export { FLOW_STATS };
export type { EntryTimeStats, FlowStatsFile, RuleStats };

export type MoneynessBucket = "ATM" | "1" | "2" | "3+";

/** Strikes from the ATM strike, unsigned: ATM, 1, 2, or 3 and more. */
export function moneynessBucket(strike: number, atm: number, step: number): MoneynessBucket {
  if (!(step > 0)) return strike === atm ? "ATM" : "3+";
  const n = Math.round(Math.abs(strike - atm) / step);
  return n === 0 ? "ATM" : n === 1 ? "1" : n === 2 ? "2" : "3+";
}

/** Start (minutes of the IST day) of the 15-minute bucket holding `minutesOfDay`. */
export function bucket15(minutesOfDay: number): number {
  return Math.floor(minutesOfDay / 15) * 15;
}

/** The baseline key format the research is asked to write: "NIFTY|09:30|ATM", optionally with "|CE" / "|PE". */
export function baselineKey(index: IndexId, bucketMin: number, moneyness: MoneynessBucket, side?: "CE" | "PE"): string {
  return `${index}|${formatHHMM(bucketMin)}|${moneyness}${side ? `|${side}` : ""}`;
}

export interface ParsedBaselineKey {
  index: IndexId | null;
  /** Minutes of the IST day. */
  bucket: number | null;
  moneyness: MoneynessBucket | null;
  side: "CE" | "PE" | null;
}

function moneynessOf(n: number): MoneynessBucket {
  return n === 0 ? "ATM" : n === 1 ? "1" : n === 2 ? "2" : "3+";
}

/** The parts a research key names; null for a part it does not name. */
export function parseBaselineKey(key: string): ParsedBaselineKey {
  const out: ParsedBaselineKey = { index: null, bucket: null, moneyness: null, side: null };
  let rest = key;
  const hm = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/.exec(rest) ?? /(?<!\d)(\d{2})(\d{2})(?!\d)/.exec(rest);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h <= 23 && m <= 59) {
      out.bucket = h * 60 + m;
      rest = rest.slice(0, hm.index) + " " + rest.slice(hm.index + hm[0].length);
    }
  }
  for (const tok of rest.split(/[^A-Za-z0-9+±-]+/).filter(Boolean)) {
    const t = tok.toUpperCase();
    if (t === "NIFTY" || t === "SENSEX") out.index = t;
    else if (/^(CE|CALLS?)$/.test(t)) out.side = "CE";
    else if (/^(PE|PUTS?)$/.test(t)) out.side = "PE";
    else if (t === "ATM") out.moneyness = "ATM";
    else if (out.bucket === null && /^\d{3}$/.test(t) && Number(t) >= SESSION.preOpenStart && Number(t) <= SESSION.close) out.bucket = Number(t);
    else {
      const m = /^(?:ITM|OTM|M|[±+-])?(\d{1,2})\+?$/.exec(t);
      if (m) out.moneyness = moneynessOf(Number(m[1]));
    }
  }
  return out;
}

export interface BaselineQuery {
  index: IndexId;
  bucket?: number | null;
  moneyness?: MoneynessBucket | null;
  side?: "CE" | "PE" | null;
}

const FIELDS = ["index", "bucket", "moneyness", "side"] as const;

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A research baseline record with tolerant keys (see the header). */
export class KeyedBaseline {
  private readonly entries: { k: ParsedBaselineKey; v: number }[] = [];

  constructor(rec: Record<string, number> | null | undefined) {
    for (const [key, v] of Object.entries(rec ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
      const k = parseBaselineKey(key);
      if (FIELDS.every((f) => k[f] === null)) continue;
      this.entries.push({ k, v });
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** The most specific entries consistent with the query (median of ties), or null. */
  lookup(q: BaselineQuery): number | null {
    let best = -1;
    let vals: number[] = [];
    for (const e of this.entries) {
      let spec = 0;
      let ok = true;
      for (const f of FIELDS) {
        const ev = e.k[f];
        if (ev === null) continue;
        const qv = q[f];
        if (qv === undefined || qv === null || qv !== ev) {
          ok = false;
          break;
        }
        spec++;
      }
      if (!ok) continue;
      if (spec > best) [best, vals] = [spec, [e.v]];
      else if (spec === best) vals.push(e.v);
    }
    return vals.length > 0 ? medianOf(vals) : null;
  }
}

export interface StatsBaselines {
  volume: KeyedBaseline;
  oiP90: KeyedBaseline;
}

const baselineCache = new WeakMap<FlowStatsFile, StatsBaselines>();

/** The parsed baselines of a stats file (memoized per file object). */
export function statsBaselines(stats: FlowStatsFile): StatsBaselines {
  let b = baselineCache.get(stats);
  if (!b) {
    b = { volume: new KeyedBaseline(stats.baselines?.volumeMedian), oiP90: new KeyedBaseline(stats.baselines?.oiChangeP90Pct) };
    baselineCache.set(stats, b);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export interface ParsedWindow {
  /** Minutes of the IST day, [from, to). */
  from: number;
  to: number;
  /** Days-to-expiry range the window was measured on (inclusive), or null for any. */
  dteMin: number | null;
  dteMax: number | null;
}

/** "09:30–10:30 IST", "09:30-10:30 · DTE 2–5", "14:00 to 15:00 expiry day"; null without a time range. */
export function parseWindow(s: string): ParsedWindow | null {
  const m = /(\d{1,2}):(\d{2})\s*(?:[–—-]|to)\s*(\d{1,2}):(\d{2})/i.exec(s ?? "");
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (!(to > from)) return null;
  let dteMin: number | null = null;
  let dteMax: number | null = null;
  const d = /DTE\s*[=:]?\s*(\d+)\s*(?:(\+)|[–—-]\s*(\d+))?/i.exec(s);
  if (d) {
    dteMin = Number(d[1]);
    dteMax = d[2] ? null : d[3] !== undefined ? Number(d[3]) : dteMin;
  } else if (/expiry\s*day/i.test(s)) {
    dteMin = 0;
    dteMax = 0;
  }
  return { from, to, dteMin, dteMax };
}

/** The first "HH:MM" in a string as minutes of the day ("13:30 IST" → 810), or null. */
export function firstHHMM(s: string | null | undefined): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(s ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

const dteMatches = (w: ParsedWindow, dte: number | null) => w.dteMin === null || (dte !== null && dte >= w.dteMin && (w.dteMax === null || dte <= w.dteMax));

const n2 = (x: number) => (Math.round(x * 100) / 100).toString();

/**
 * Whether now is a good time to pay for an option, from the measured entry windows: the window covering
 * now against the cheapest measured window (by cost per point of index move). "unknown" without statistics.
 */
export function entryWindowVerdict(stats: FlowStatsFile, index: IndexId, minutesOfDay: number, dte: number | null): FlowEntryWindowView {
  if (minutesOfDay < SESSION.open || minutesOfDay >= SESSION.close) {
    return { verdict: "closed", text: "The market is closed.", now: null, best: null };
  }
  const all = (stats.entryTimes?.[index] ?? [])
    .map((e) => ({ e, w: parseWindow(e.window) }))
    .filter((x): x is { e: EntryTimeStats; w: ParsedWindow } => x.w !== null && x.e.sample > 0 && Number.isFinite(x.e.costPerPointMove));
  if (all.length === 0) return { verdict: "unknown", text: "No measured entry-time statistics yet.", now: null, best: null };
  const specific = dte !== null ? all.filter((x) => x.w.dteMin !== null && dteMatches(x.w, dte)) : [];
  const pool = specific.length > 0 ? specific : all.filter((x) => dteMatches(x.w, dte));
  if (pool.length === 0) return { verdict: "unknown", text: "No measured entry window matches today's days to expiry.", now: null, best: null };
  const best = pool.filter((x) => x.e.costPerPointMove > 0).sort((a, b) => a.e.costPerPointMove - b.e.costPerPointMove)[0] ?? null;
  const now = pool.find((x) => minutesOfDay >= x.w.from && minutesOfDay < x.w.to) ?? null;
  if (!now) {
    return {
      verdict: "unknown",
      text: `No measured window covers ${formatHHMM(minutesOfDay)}${best ? `; the cheapest measured window is ${best.e.window}` : ""}.`,
      now: null,
      best: best?.e ?? null,
    };
  }
  const ratio = best && best.e.costPerPointMove > 0 ? now.e.costPerPointMove / best.e.costPerPointMove : null;
  const facts = `premium decay ${n2(now.e.avgPremiumDecayPctPerHour)}%/h against an average index move of ${n2(now.e.avgAbsIndexMovePct)}%, cost ${n2(now.e.costPerPointMove)} per point of move (${now.e.sample} sessions)`;
  if (ratio === null) return { verdict: "average", text: `Now (${now.e.window}): ${facts}.`, now: now.e, best: best?.e ?? null };
  if (ratio <= 1.15) return { verdict: "good", text: `Now is a good time to buy (${now.e.window}): ${facts}; the cheapest measured window.`, now: now.e, best: best!.e };
  if (ratio >= 1.5) {
    return {
      verdict: "expensive",
      text: `Now is an expensive time to buy (${now.e.window}): ${facts}; ${n2(ratio)}× the cost in ${best!.e.window}.`,
      now: now.e,
      best: best!.e,
    };
  }
  return { verdict: "average", text: `Now is an average time to buy (${now.e.window}): ${facts}; ${n2(ratio)}× the cheapest window (${best!.e.window}).`, now: now.e, best: best!.e };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A rule may raise a grade only with verdict "positive", a 95% interval above zero and a test sample. */
export function isPositiveRule(r: RuleStats): boolean {
  return r.verdict === "positive" && Array.isArray(r.ci95) && Number.isFinite(r.ci95[0]) && r.ci95[0] > 0 && r.sample > 0;
}

/** True when the stats file carries anything measured (not the placeholder). */
export function statsLoaded(stats: FlowStatsFile): boolean {
  return stats.rules.length > 0 || (stats.entryTimes?.NIFTY?.length ?? 0) > 0 || (stats.entryTimes?.SENSEX?.length ?? 0) > 0;
}
