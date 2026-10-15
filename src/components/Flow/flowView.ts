/**
 * Pure helpers for the option-flow panel (no React), unit-tested in flowView.test.ts: lakh/crore figures,
 * the ranked "OI added / removed" list, the writers' totals and their lean, volume against normal, the
 * colour and words for each build-up and event, the premium meter, and how fresh the reading is.
 */
import type { IndexId } from "@/engine/api-types";
import type { FlowSide, UiOptionFlow as OptionFlowView } from "./uiTypes";
import type { EntryTimeStats, FlowStatsFile } from "@/engine/flow/flowStatsTypes";
import { C } from "@/components/shared/colors";
import { fmtLakh, isMarketHours } from "@/components/Options/chainView";
import { REFRESH_CLOSED_MS } from "@/lib/refresh";

export type FlowWindow = keyof OptionFlowView["windows"];
export type FlowRow = OptionFlowView["windows"][FlowWindow]["rows"][number];
export type FlowEvent = OptionFlowView["events"][number];
export type FlowKind = FlowEvent["kind"] | FlowSide["buildup"];
export type FlowSideId = "CE" | "PE";

export const WINDOWS: readonly FlowWindow[] = ["1m", "5m", "15m"];
export const WINDOW_MIN: Record<FlowWindow, number> = { "1m": 1, "5m": 5, "15m": 15 };
export const WINDOW_WORDS: Record<FlowWindow, string> = { "1m": "1 min", "5m": "5 min", "15m": "15 min" };

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** OI and volume in Indian units: 18.4L, 1.24Cr, 8.2k; `signed` adds "+" to additions (removals always carry "−"). */
export function fmtOi(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = fmtLakh(n);
  return signed && n > 0 ? `+${body}` : body;
}

/** "×2.4" (one decimal below 10, none above); "—" when unknown. */
export function fmtTimes(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `×${x >= 10 ? Math.round(x) : x.toFixed(1)}`;
}

/** "+6.2%" / "−3.0%"; "—" when unknown. */
export function fmtPctChg(x: number | null | undefined, decimals = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const s = Math.abs(x).toFixed(decimals);
  if (Number(s) === 0) return `${(0).toFixed(decimals)}%`;
  return `${x < 0 ? "−" : "+"}${s}%`;
}

// ---------------------------------------------------------------------------
// Strikes near the money, ranked by OI change
// ---------------------------------------------------------------------------

/** The strike interval: the smallest gap between listed strikes (50 for NIFTY, 100 for SENSEX); 0 with fewer than two. */
export function strikeStep(strikes: number[]): number {
  const s = [...new Set(strikes)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) step = Math.min(step, s[i] - s[i - 1]);
  return Number.isFinite(step) ? step : 0;
}

/** Signed strikes from the ATM strike: +1 is one strike above it. */
export function stepsFromAtm(strike: number, atm: number, step: number): number {
  return step > 0 ? Math.round((strike - atm) / step) : 0;
}

/** The rows within ±`n` strikes of the ATM strike, ascending. */
export function nearAtm(rows: FlowRow[], atm: number, n = 5): FlowRow[] {
  const step = strikeStep(rows.map((r) => r.strike));
  return rows.filter((r) => Math.abs(stepsFromAtm(r.strike, atm, step)) <= n).sort((a, b) => a.strike - b.strike);
}

export interface RankedSide {
  strike: number;
  side: FlowSideId;
  flow: FlowSide;
  /** Signed strikes from ATM. */
  offset: number;
}

/** Every CE and PE within ATM±`n`, the largest OI change (added or removed) first; sides with no OI change last. */
export function rankSides(rows: FlowRow[], atm: number, n = 5): RankedSide[] {
  const step = strikeStep(rows.map((r) => r.strike));
  const out: RankedSide[] = [];
  for (const r of nearAtm(rows, atm, n)) {
    if (r.ce) out.push({ strike: r.strike, side: "CE", flow: r.ce, offset: stepsFromAtm(r.strike, atm, step) });
    if (r.pe) out.push({ strike: r.strike, side: "PE", flow: r.pe, offset: stepsFromAtm(r.strike, atm, step) });
  }
  const size = (x: RankedSide) => (x.flow.oiChg == null ? -1 : Math.abs(x.flow.oiChg));
  return out.sort((a, b) => size(b) - size(a) || a.strike - b.strike || a.side.localeCompare(b.side));
}

/** The largest |OI change| among the sides shown (the bar scale), at least 1. */
export function maxAbsOiChg(sides: { flow: FlowSide | null }[]): number {
  let m = 0;
  for (const s of sides) if (s.flow?.oiChg != null) m = Math.max(m, Math.abs(s.flow.oiChg));
  return m > 0 ? m : 1;
}

// ---------------------------------------------------------------------------
// Writers' totals and lean
// ---------------------------------------------------------------------------

/** Net OI change on calls and on puts across the rows (OI added on a strike is mostly new writing). */
export function writerTotals(rows: FlowRow[]): { ce: number; pe: number; strikes: number } {
  let ce = 0;
  let pe = 0;
  let strikes = 0;
  for (const r of rows) {
    const c = r.ce?.oiChg;
    const p = r.pe?.oiChg;
    if (c == null && p == null) continue;
    strikes += 1;
    ce += c ?? 0;
    pe += p ?? 0;
  }
  return { ce, pe, strikes };
}

export type Lean = "up" | "down" | "flat";

/**
 * How the writers lean: put writing (or call covering) clearly ahead means support below, so it leans
 * up; call writing (or put covering) ahead leans down. "Clearly" is a gap of a fifth of the larger side.
 */
export function writerLean(ce: number, pe: number): { lean: Lean; text: string } {
  const scale = Math.max(Math.abs(ce), Math.abs(pe));
  if (scale === 0) return { lean: "flat", text: "no change on either side" };
  const gap = pe - ce;
  // Name whichever move drives the lean: new put writing or call covering (up), new call writing or put covering (down).
  if (gap > 0.2 * scale) return { lean: "up", text: Math.max(pe, 0) >= Math.max(-ce, 0) ? "put writers adding faster: support below, leans up" : "call writers covering faster: leans up" };
  if (-gap > 0.2 * scale) return { lean: "down", text: Math.max(ce, 0) >= Math.max(-pe, 0) ? "call writers adding faster: resistance above, leans down" : "put writers covering faster: leans down" };
  return { lean: "flat", text: "balanced: no clear lean" };
}

/** "Call writers added 4.2L vs put writers added 6.8L in 15 min → put writers adding faster: support below, leans up". */
export function writerLine(ce: number, pe: number, window: FlowWindow): string {
  const verb = (n: number) => (n >= 0 ? "added" : "removed");
  return `Call writers ${verb(ce)} ${fmtOi(Math.abs(ce))} vs put writers ${verb(pe)} ${fmtOi(Math.abs(pe))} in ${WINDOW_WORDS[window]} → ${writerLean(ce, pe).text}`;
}

export function leanColor(lean: Lean): string {
  return lean === "up" ? C.green : lean === "down" ? C.red : C.muted;
}

/** "1.12 (+0.05 in 15 min)"; "—" without a PCR. */
export function pcrText(pcr: number | null, chg15m: number | null): string {
  if (pcr == null) return "—";
  if (chg15m == null) return pcr.toFixed(2);
  const c = Math.abs(chg15m).toFixed(2);
  return `${pcr.toFixed(2)} (${Number(c) === 0 ? "±0.00" : `${chg15m < 0 ? "−" : "+"}${c}`} in 15 min)`;
}

// ---------------------------------------------------------------------------
// Build-ups and events: colour, words, meaning
// ---------------------------------------------------------------------------

export const KIND_META: Record<FlowKind, { label: string; short: string; color: string; meaning: string }> = {
  LONG_BUILDUP: { label: "Long build-up", short: "Long BU", color: C.green, meaning: "Price up and OI up: new buyers coming in." },
  SHORT_BUILDUP: { label: "Short build-up", short: "Short BU", color: C.red, meaning: "Price down and OI up: new writers selling it." },
  SHORT_COVERING: { label: "Short covering", short: "Covering", color: C.blue, meaning: "Price up and OI down: writers buying back." },
  LONG_UNWINDING: { label: "Long unwinding", short: "Unwinding", color: C.orange, meaning: "Price down and OI down: buyers getting out." },
  NEUTRAL: { label: "Neutral", short: "Neutral", color: C.muted3, meaning: "No clear change in price and OI together." },
  VOLUME_SPIKE: { label: "Volume spike", short: "Vol spike", color: C.purple, meaning: "Far more contracts traded than usual for this time and strike." },
  DRY_UP: { label: "Premium drying up", short: "Dry-up", color: C.gold, meaning: "Premium leaking away faster than the index is moving: it costs a buyer to wait." },
  OI_WALL: { label: "OI wall", short: "OI wall", color: "#1f7a72", meaning: "A strike with far more open interest than its neighbours: writers defend it." },
};

/** Newest first, at most `n` (the feed shows the last 30). */
export function latestEvents(events: FlowEvent[], n = 30): FlowEvent[] {
  const t = (e: FlowEvent) => {
    const ms = Date.parse(e.at);
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => t(b.e) - t(a.e) || b.i - a.i)
    .slice(0, n)
    .map((x) => x.e);
}

// ---------------------------------------------------------------------------
// Volume against normal
// ---------------------------------------------------------------------------

/** "09:45" for the 15-minute bucket a minute of the day falls in. */
export function bucketLabel(minuteOfDay: number): string {
  const b = Math.floor(minuteOfDay / 15) * 15;
  return `${String(Math.floor(b / 60)).padStart(2, "0")}:${String(b % 60).padStart(2, "0")}`;
}

/**
 * Keys the research may have used for the median 1-minute volume of a strike (index, 15-minute bucket,
 * distance from ATM in strikes as ATM / 1 / 2 / 3+). Every spelling we accept is listed so a lookup that
 * misses returns nothing rather than a wrong figure.
 */
export function volumeBaselineKeys(index: IndexId, minuteOfDay: number, offset: number): string[] {
  const d = Math.abs(offset);
  const hhmm = bucketLabel(minuteOfDay);
  const minute = String(Math.floor(minuteOfDay / 15) * 15);
  const buckets = [hhmm, hhmm.replace(":", ""), minute];
  const money = d === 0 ? ["ATM", "0"] : d >= 3 ? ["3+", "±3+", "ATM±3+", "3"] : [String(d), `±${d}`, `ATM±${d}`];
  const out: string[] = [];
  for (const b of buckets) for (const m of money) for (const sep of ["|", ":", "_"]) out.push([index, b, m].join(sep));
  return out;
}

/** The median 1-minute volume for this index, time of day and distance from ATM, or null without one. */
export function baselineVolumePerMin(baselines: FlowStatsFile["baselines"], index: IndexId, minuteOfDay: number, offset: number): number | null {
  for (const k of volumeBaselineKeys(index, minuteOfDay, offset)) {
    const v = baselines.volumeMedian[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export interface VolTimes {
  x: number;
  /** "history": against the measured median for this time and strike distance; "pace": against this side's own 15-minute pace. */
  basis: "history" | "pace";
}

/**
 * This window's volume against normal: the measured median for the time of day and the strike's distance
 * from ATM when the research has one; otherwise (1- and 5-minute windows only) against the same side's
 * average pace over the last 15 minutes. Null when neither exists.
 */
export function volVsNormal(a: { vol: number | null; window: FlowWindow; baselinePerMin: number | null; vol15m: number | null }): VolTimes | null {
  if (a.vol == null || !Number.isFinite(a.vol)) return null;
  const mins = WINDOW_MIN[a.window];
  if (a.baselinePerMin != null && a.baselinePerMin > 0) return { x: a.vol / (a.baselinePerMin * mins), basis: "history" };
  if (a.window !== "15m" && a.vol15m != null && a.vol15m > 0) return { x: a.vol / ((a.vol15m / 15) * mins), basis: "pace" };
  return null;
}

/** The 15-minute |OI change| % a strike usually stays under (P90 from the research), or null. */
export function oiP90Pct(baselines: FlowStatsFile["baselines"], index: IndexId): number | null {
  for (const k of [index, index.toLowerCase(), `${index}|ATM±2`, `${index}:ATM±2`]) {
    const v = baselines.oiChangeP90Pct[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** True when a 15-minute OI change is beyond what the research found 90% of 15-minute changes stay under. */
export function unusualOi(oiChgPct: number | null, window: FlowWindow, p90: number | null): boolean {
  return window === "15m" && p90 != null && oiChgPct != null && Math.abs(oiChgPct) > p90;
}

// ---------------------------------------------------------------------------
// Premium meter and entry windows
// ---------------------------------------------------------------------------

/** Minutes of the day for "09:45–11:15 IST" (en dash, hyphen or "to"); null when it does not parse. */
export function parseWindow(w: string): [number, number] | null {
  const m = /(\d{1,2}):?(\d{2})\s*(?:–|—|-|to)\s*(\d{1,2}):?(\d{2})/.exec(w);
  if (!m) return null;
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return b > a ? [a, b] : null;
}

/** The research's entry-time row whose window holds this minute of the day. */
export function entryTimeAt(rows: EntryTimeStats[], minuteOfDay: number): EntryTimeStats | null {
  for (const r of rows) {
    const w = parseWindow(r.window);
    if (w && minuteOfDay >= w[0] && minuteOfDay < w[1]) return r;
  }
  return null;
}

/** The window where a point of index move cost the least premium (the history's cheapest time to hold). */
export function cheapestEntryTime(rows: EntryTimeStats[]): EntryTimeStats | null {
  let best: EntryTimeStats | null = null;
  for (const r of rows) if (r.sample > 0 && Number.isFinite(r.costPerPointMove) && (!best || r.costPerPointMove < best.costPerPointMove)) best = r;
  return best;
}

/**
 * The premium meter: the live ATM decay against the history for this time of day. `fill` is 0..1 on a
 * scale of twice the normal (or twice the live figure without history); `ratio` is live / normal.
 */
export function decayMeter(live: number | null, normal: number | null): { fill: number; ratio: number | null; text: string } {
  if (live == null || !Number.isFinite(live)) return { fill: 0, ratio: null, text: "No live decay reading." };
  const scale = normal != null && normal > 0 ? 2 * normal : Math.max(2 * Math.abs(live), 1);
  const fill = Math.max(0, Math.min(1, live / scale));
  const ratio = normal != null && normal > 0 ? live / normal : null;
  const what = `ATM premium losing ${live.toFixed(1)}%/hour`;
  if (ratio == null) return { fill, ratio, text: `${what}; no history for this time yet.` };
  const vs = ratio >= 1.25 ? "faster than" : ratio <= 0.8 ? "slower than" : "about";
  return { fill, ratio, text: `${what}: ${vs} the usual ${normal!.toFixed(1)}%/hour for this time of day.` };
}

export const VERDICT_COLOR: Record<"good" | "neutral" | "expensive", string> = { good: C.green, neutral: C.blue, expensive: C.red };

// ---------------------------------------------------------------------------
// Polling and freshness
// ---------------------------------------------------------------------------

/** `openMs` in market hours (09:15–15:30 IST, Mon–Fri), the closed-market interval otherwise. */
export function marketPollMs(nowMs: number, openMs: number): number {
  return isMarketHours(nowMs) ? openMs : REFRESH_CLOSED_MS;
}

export type Freshness = "live" | "slow" | "stale";

/**
 * How fresh a polled reading is: live within three poll intervals (at least 5 s), slow within ten (at least
 * 30 s), stale beyond. Unknown age (nothing received yet) is stale.
 */
export function freshness(ageMs: number | null, intervalMs: number): Freshness {
  if (ageMs == null || !Number.isFinite(ageMs)) return "stale";
  if (ageMs <= Math.max(3 * intervalMs, 5_000)) return "live";
  if (ageMs <= Math.max(10 * intervalMs, 30_000)) return "slow";
  return "stale";
}

/** The data's own age on the engine's clock; a reading older than 2 minutes in market hours is stale whatever the poll says. */
export function dataStale(asOfMs: number, engineNowMs: number, marketOpen: boolean): boolean {
  return marketOpen && Number.isFinite(asOfMs) && engineNowMs - asOfMs > 120_000;
}

export const SOURCE_WORDS: Record<OptionFlowView["source"], string> = { feed: "Live feed", rest: "Chain snapshots", mock: "Mock data" };
