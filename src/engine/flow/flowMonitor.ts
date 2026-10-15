/**
 * The live option-flow monitor: what option traders are doing at each strike, from successive chain
 * snapshots (per strike and side: LTP, the day's cumulative volume, open interest, bid/ask, IV, delta).
 *
 * - One snapshot per minute per index is kept for the session (at most MAX_SNAPS, oldest dropped; a new
 *   IST date starts a new session). A second snapshot inside the same minute, or an older one, is ignored.
 * - For the 1, 5 and 15-minute windows, per strike and side: ΔOI and ΔOI %, the volume traded in the
 *   window (cumulative volume now minus then), ΔLTP %, ΔIV and the build-up class:
 *     price up + OI up = LONG_BUILDUP, price down + OI up = SHORT_BUILDUP,
 *     price up + OI down = SHORT_COVERING, price down + OI down = LONG_UNWINDING,
 *   NEUTRAL when |ΔOI %| or |ΔLTP %| is under the window's threshold. The OI threshold is half the
 *   research's typical-large 15-minute |ΔOI| % at ATM±2 (FLOW_STATS.baselines.oiChangeP90Pct), scaled by
 *   √(window / 15) with a 0.2% floor; without it the documented defaults DEFAULT_MIN_OI_CHG_PCT. The price
 *   threshold is DEFAULT_MIN_LTP_CHG_PCT.
 * - Volume spikes: a strike's 1-minute volume at least SPIKE_K (5) times normal, where normal is the research's
 *   median 1-minute volume for the index, 15-minute bucket and moneyness (FLOW_STATS.baselines.volumeMedian),
 *   else the session's own running median for that strike and side (after SPIKE_MIN_SAMPLES minutes).
 * - Premium dry-up: over the last 15 minutes at ATM±2 (both sides) the volume traded is under half of normal
 *   AND the summed |ΔOI| is under half of the session's median 15-minute |ΔOI| there.
 * - Premium decay at ATM: the ATM straddle's change not explained by delta × the index move, per hour.
 * - Totals: call vs put OI added at ATM±3 over 15 minutes, the intraday PCR and its 15-minute change (on the
 *   strikes present at both times), the most call OI (resistance) and put OI (support) strikes, and where OI
 *   is being added fastest.
 * - Events (newest first, at most MAX_EVENTS): notable 5-minute build-ups, volume spikes, dry-up starts, PCR
 *   shifts and moves of the OI walls, in plain words with the time.
 *
 * Pure and deterministic: replaying the same snapshots rebuilds the same state (that is how a Durable Object
 * eviction is recovered, flowStore.ts).
 */
import type {
  FlowBuildup,
  FlowEventKind,
  FlowEventView,
  FlowSideView,
  FlowStrikeRow,
  FlowSummaryView,
  FlowWindowKey,
  FlowWindowView,
  IndexId,
  OptionFlowView,
} from "../api-types";
import { MINUTE_MS, formatHHMM, istDate, istIso, istMinutes } from "../clock";
import { FLOW_STATS, bucket15, entryWindowVerdict, moneynessBucket, statsBaselines, type FlowStatsFile } from "./flowStats";

export interface SideQuote {
  ltp: number | null;
  /** The day's cumulative traded quantity. */
  volume: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
  /** Implied volatility, percent. */
  iv: number | null;
  delta: number | null;
}

export interface ChainRow {
  strike: number;
  ce: SideQuote | null;
  pe: SideQuote | null;
}

export interface ChainSnapshot {
  /** Epoch ms of the sample. */
  t: number;
  index: IndexId;
  expiry: string | null;
  lotSize: number | null;
  spot: number;
  rows: ChainRow[];
}

export type FlowSource = OptionFlowView["source"];

export const FLOW_WINDOWS: Record<FlowWindowKey, number> = { "1m": 1, "5m": 5, "15m": 15 };
const WINDOW_KEYS: readonly FlowWindowKey[] = ["1m", "5m", "15m"];
/** Snapshots kept per index (a session has 375 minutes). */
export const MAX_SNAPS = 400;
export const MAX_EVENTS = 100;
/** A volume spike: the 1-minute volume at least this many times normal. */
export const SPIKE_K = 5;
/** Session minutes a strike needs before its own running median can stand for "normal". */
export const SPIKE_MIN_SAMPLES = 10;
/** Dry-up: volume and |ΔOI| both under this share of normal for 15 minutes. */
export const DRY_UP_FRACTION = 0.5;
/** 15-minute |ΔOI| samples the session needs before dry-up can be judged. */
export const DRY_UP_MIN_SAMPLES = 15;
/** Build-up thresholds without research baselines: |ΔOI %| and |ΔLTP %| per window. */
export const DEFAULT_MIN_OI_CHG_PCT: Record<FlowWindowKey, number> = { "1m": 0.3, "5m": 1, "15m": 2 };
export const DEFAULT_MIN_LTP_CHG_PCT: Record<FlowWindowKey, number> = { "1m": 0.5, "5m": 1, "15m": 1.5 };
/** Events are raised for strikes within this many steps of ATM; totals use ATM±3; dry-up ATM±2. */
export const EVENT_STRIKES = 5;
export const SUMMARY_STRIKES = 3;
export const DRY_UP_STRIKES = 2;
/** A 5-minute build-up is an event when |ΔOI %| is at least this multiple of the window's threshold. */
export const NOTABLE_OI_MULT = 2;
/** A PCR change over 15 minutes at least this large is an event. */
export const PCR_SHIFT = 0.1;
/** The latest snapshot older than this is called stale in the view. */
export const STALE_MS = 3 * MINUTE_MS;

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const minuteOf = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;
const pos = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const fin = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** "18.4L", "1.23Cr", "12.3K", "640". */
export function fmtQty(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${round(a / 1e7, 2)}Cr`;
  if (a >= 1e5) return `${round(a / 1e5, 1)}L`;
  if (a >= 1e3) return `${round(a / 1e3, 1)}K`;
  return `${Math.round(a)}`;
}
const signedQty = (n: number) => `${n >= 0 ? "+" : "−"}${fmtQty(n)}`;
const signedPct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(dp)}%`;

export const BUILDUP_LABEL: Record<FlowBuildup, string> = {
  LONG_BUILDUP: "LONG BUILD-UP",
  SHORT_BUILDUP: "SHORT BUILD-UP",
  SHORT_COVERING: "SHORT COVERING",
  LONG_UNWINDING: "LONG UNWINDING",
  NEUTRAL: "NEUTRAL",
};

/** Who is acting: "put writers adding", "call buyers exiting"... */
export function buildupActor(cls: FlowBuildup, side: "CE" | "PE"): string {
  const who = side === "CE" ? "call" : "put";
  switch (cls) {
    case "LONG_BUILDUP":
      return `${who} buyers adding`;
    case "SHORT_BUILDUP":
      return `${who} writers adding`;
    case "SHORT_COVERING":
      return `${who} writers covering`;
    case "LONG_UNWINDING":
      return `${who} buyers exiting`;
    default:
      return "no clear side";
  }
}

/** Price and OI together; NEUTRAL when either change is missing or under its threshold. */
export function classifyBuildup(oiChgPct: number | null, ltpChgPct: number | null, minOiPct: number, minLtpPct: number): FlowBuildup {
  if (!fin(oiChgPct) || !fin(ltpChgPct)) return "NEUTRAL";
  if (Math.abs(oiChgPct) < minOiPct || Math.abs(ltpChgPct) < minLtpPct) return "NEUTRAL";
  if (oiChgPct > 0) return ltpChgPct > 0 ? "LONG_BUILDUP" : "SHORT_BUILDUP";
  return ltpChgPct > 0 ? "SHORT_COVERING" : "LONG_UNWINDING";
}

/** The strike step of a chain (the most common gap between neighbouring strikes), 0 with fewer than two. */
export function strikeStep(rows: readonly { strike: number }[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < rows.length; i++) {
    const d = round(rows[i].strike - rows[i - 1].strike, 4);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 0;
  let n = 0;
  for (const [d, c] of counts) if (c > n || (c === n && d < best)) [best, n] = [d, c];
  return best;
}

/** The strike nearest the spot (the lower one on a tie); 0 without rows. */
export function nearestStrike(rows: readonly { strike: number }[], spot: number): number {
  let best = 0;
  let dist = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.strike - spot);
    if (d < dist) [best, dist] = [r.strike, d];
  }
  return best;
}

function insertSorted(arr: number[], v: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, v);
}

function sortedMedian(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** The ATM straddle's change not explained by delta × the index move, as % of the straddle per hour (positive = decaying). */
export function atmDecayPctPerHour(cur: ChainSnapshot, base: ChainSnapshot, atm: number): number | null {
  const a = cur.rows.find((r) => r.strike === atm);
  const b = base.rows.find((r) => r.strike === atm);
  if (!a?.ce || !a.pe || !b?.ce || !b.pe) return null;
  if (!pos(a.ce.ltp) || !pos(a.pe.ltp) || !pos(b.ce.ltp) || !pos(b.pe.ltp)) return null;
  const minutes = (cur.t - base.t) / MINUTE_MS;
  if (minutes < 3) return null;
  const avg = (x: number | null, y: number | null, def: number) => (fin(x) && fin(y) ? (x + y) / 2 : fin(x) ? x : fin(y) ? y : def);
  const dCe = avg(a.ce.delta, b.ce.delta, 0.5);
  const dPe = avg(a.pe.delta, b.pe.delta, -0.5);
  const then = b.ce.ltp + b.pe.ltp;
  const residual = a.ce.ltp + a.pe.ltp - then - (dCe + dPe) * (cur.spot - base.spot);
  return round((-residual / then) * 100 * (60 / minutes), 1);
}

/** Put-call ratio on OI over the strikes in `strikes` (all when omitted); null without call OI. */
export function snapshotPcr(snap: ChainSnapshot, strikes?: ReadonlySet<number>): number | null {
  let ce = 0;
  let pe = 0;
  for (const r of snap.rows) {
    if (strikes && !strikes.has(r.strike)) continue;
    ce += r.ce?.oi ?? 0;
    pe += r.pe?.oi ?? 0;
  }
  return ce > 0 ? round(pe / ce, 4) : null;
}

interface Series {
  session: string;
  snaps: ChainSnapshot[];
  events: FlowEventView[];
  /** Sorted 1-minute volumes this session, per "strike|side". */
  vol1m: Map<string, number[]>;
  /** Sorted 15-minute |ΔOI| sums at ATM±2 this session. */
  oiAct15: number[];
  /** Dedupe: event key → last time raised. */
  lastEvent: Map<string, number>;
  dryUp: boolean;
  dryUpDetail: string;
  walls: { ce: number | null; pe: number | null };
}

export interface FlowMonitorOptions {
  stats?: FlowStatsFile;
  maxSnaps?: number;
  maxEvents?: number;
}

export interface FlowViewContext {
  source?: FlowSource;
  /** Trading sessions left to the monitored expiry (for the entry-time statistics), when known. */
  dte?: number | null;
  /** Extra words for the view's note (e.g. why the fallback was used). */
  note?: string | null;
}

interface SideDelta {
  cur: SideQuote;
  oiChg: number | null;
  oiChgPct: number | null;
  vol: number | null;
  ltpChgPct: number | null;
  ivChg: number | null;
}

function sideDelta(cur: SideQuote, base: SideQuote | null | undefined): SideDelta {
  if (!base) return { cur, oiChg: null, oiChgPct: null, vol: null, ltpChgPct: null, ivChg: null };
  const oiChg = fin(cur.oi) && fin(base.oi) ? cur.oi - base.oi : null;
  const vol = fin(cur.volume) && fin(base.volume) && cur.volume >= base.volume ? cur.volume - base.volume : null;
  return {
    cur,
    oiChg,
    oiChgPct: oiChg !== null && pos(base.oi) ? round((oiChg / base.oi!) * 100, 2) : null,
    vol,
    ltpChgPct: pos(cur.ltp) && pos(base.ltp) ? round((cur.ltp / base.ltp - 1) * 100, 2) : null,
    ivChg: pos(cur.iv) && pos(base.iv) ? round(cur.iv - base.iv, 2) : null,
  };
}

export class FlowMonitor {
  private readonly series = new Map<IndexId, Series>();
  readonly stats: FlowStatsFile;
  private readonly maxSnaps: number;
  private readonly maxEvents: number;

  constructor(o: FlowMonitorOptions = {}) {
    this.stats = o.stats ?? FLOW_STATS;
    this.maxSnaps = o.maxSnaps ?? MAX_SNAPS;
    this.maxEvents = o.maxEvents ?? MAX_EVENTS;
  }

  /** The session's snapshots for an index, oldest first. */
  snapshots(index: IndexId): readonly ChainSnapshot[] {
    return this.series.get(index)?.snaps ?? [];
  }

  /** The IST date of the index's session, or null before its first snapshot. */
  session(index: IndexId): string | null {
    return this.series.get(index)?.session ?? null;
  }

  reset(index?: IndexId): void {
    if (index) this.series.delete(index);
    else this.series.clear();
  }

  /** Rebuilds an index's state from stored snapshots (replayed in time order). */
  restore(index: IndexId, snaps: readonly ChainSnapshot[]): void {
    this.series.delete(index);
    for (const s of [...snaps].filter((x) => x.index === index).sort((a, b) => a.t - b.t)) this.ingest(s);
  }

  /**
   * Records a snapshot; true when it was kept (the first of a new minute). A new IST date clears the index's
   * session first.
   */
  ingest(snap: ChainSnapshot): boolean {
    if (!pos(snap.spot) || snap.rows.length === 0) return false;
    const session = istDate(snap.t);
    let s = this.series.get(snap.index);
    if (!s || s.session !== session) {
      s = { session, snaps: [], events: [], vol1m: new Map(), oiAct15: [], lastEvent: new Map(), dryUp: false, dryUpDetail: "", walls: { ce: null, pe: null } };
      this.series.set(snap.index, s);
    }
    const prev = s.snaps[s.snaps.length - 1] ?? null;
    if (prev && minuteOf(prev.t) >= minuteOf(snap.t)) return false;
    const cur: ChainSnapshot = { ...snap, rows: [...snap.rows].sort((a, b) => a.strike - b.strike) };
    s.snaps.push(cur);
    if (s.snaps.length > this.maxSnaps) s.snaps.splice(0, s.snaps.length - this.maxSnaps);
    this.update(s, cur, prev);
    return true;
  }

  /** The latest snapshot at least `w` minutes older than `cur`, but not more than 2w + 1 minutes (a gap in the data is no window). */
  private base(s: Series, cur: ChainSnapshot, w: number): ChainSnapshot | null {
    const m = minuteOf(cur.t);
    for (let i = s.snaps.length - 1; i >= 0; i--) {
      const x = s.snaps[i];
      if (x === cur) continue;
      const mx = minuteOf(x.t);
      if (mx > m - w * MINUTE_MS) continue;
      return mx >= m - (2 * w + 1) * MINUTE_MS ? x : null;
    }
    return null;
  }

  /** Minimum |ΔOI %| for a build-up over `w` minutes (see the header). */
  minOiPct(index: IndexId, key: FlowWindowKey): number {
    const p90 = statsBaselines(this.stats).oiP90.lookup({ index });
    if (p90 !== null && p90 > 0) return Math.max(0.2, round(0.5 * p90 * Math.sqrt(FLOW_WINDOWS[key] / 15), 3));
    return DEFAULT_MIN_OI_CHG_PCT[key];
  }

  /** Normal 1-minute volume for a strike and side: the research's median, else the session's running median. */
  private volBase(s: Series, index: IndexId, strike: number, side: "CE" | "PE", atm: number, step: number, t: number): { v: number; src: "research" | "session" } | null {
    const research = statsBaselines(this.stats).volume.lookup({ index, bucket: bucket15(istMinutes(t)), moneyness: moneynessBucket(strike, atm, step), side });
    if (research !== null && research > 0) return { v: research, src: "research" };
    const arr = s.vol1m.get(`${strike}|${side}`);
    if (!arr || arr.length < SPIKE_MIN_SAMPLES) return null;
    const med = sortedMedian(arr);
    return med !== null && med > 0 ? { v: med, src: "session" } : null;
  }

  private event(s: Series, key: string, dedupeMs: number, t: number, e: Omit<FlowEventView, "at">): void {
    const last = s.lastEvent.get(key);
    if (last !== undefined && t - last < dedupeMs) return;
    s.lastEvent.set(key, t);
    s.events.unshift({ at: istIso(t), ...e });
    if (s.events.length > this.maxEvents) s.events.length = this.maxEvents;
  }

  private update(s: Series, cur: ChainSnapshot, prev: ChainSnapshot | null): void {
    const index = cur.index;
    const step = strikeStep(cur.rows);
    const atm = nearestStrike(cur.rows, cur.spot);
    const hm = formatHHMM(istMinutes(cur.t));
    const near = (strike: number, n: number) => step > 0 && Math.abs(strike - atm) <= n * step + 1e-9;
    const base5 = this.base(s, cur, 5);
    const base15 = this.base(s, cur, 15);
    const sides = ["ce", "pe"] as const;
    const SIDE = { ce: "CE", pe: "PE" } as const;

    // 1-minute volumes: spikes against normal, then the running medians.
    const gap = prev ? (minuteOf(cur.t) - minuteOf(prev.t)) / MINUTE_MS : 0;
    if (prev && gap >= 1 && gap <= 3) {
      const prevRows = new Map(prev.rows.map((r) => [r.strike, r]));
      const rows5 = base5 ? new Map(base5.rows.map((r) => [r.strike, r])) : null;
      const minSpikeQty = pos(cur.lotSize) ? 10 * cur.lotSize : 1;
      for (const r of cur.rows) {
        const p = prevRows.get(r.strike);
        for (const k of sides) {
          const q = r[k];
          const pq = p?.[k];
          if (!q || !pq || !fin(q.volume) || !fin(pq.volume) || q.volume < pq.volume) continue;
          const v1 = (q.volume - pq.volume) / gap;
          const side = SIDE[k];
          const b = this.volBase(s, index, r.strike, side, atm, step, prev.t);
          if (b && near(r.strike, EVENT_STRIKES) && v1 >= minSpikeQty && v1 >= SPIKE_K * b.v) {
            const mult = round(v1 / b.v, 1);
            const ref = rows5?.get(r.strike)?.[k] ?? pq;
            const ltpPct = pos(q.ltp) && pos(ref.ltp) ? round((q.ltp / ref.ltp - 1) * 100, 1) : null;
            const who = side === "CE" ? "call" : "put";
            const meaning =
              ltpPct === null ? "heavy trade" : ltpPct >= 1 ? `aggressive ${who} buying` : ltpPct <= -1 ? `heavy ${who} selling` : "heavy two-way trade";
            this.event(s, `spike:${r.strike}${side}`, 3 * MINUTE_MS, cur.t, {
              kind: "VOLUME_SPIKE",
              strike: r.strike,
              side,
              buildup: null,
              oiChg: null,
              ltpChgPct: ltpPct,
              volMultiple: mult,
              text: `${hm} · ${index} ${r.strike} ${side} · volume ${mult}× normal (${fmtQty(v1)} in 1 min)${ltpPct !== null ? `, price ${signedPct(ltpPct)} in ${rows5 ? 5 : 1} min` : ""} → ${meaning}`,
            });
          }
          const key = `${r.strike}|${side}`;
          let arr = s.vol1m.get(key);
          if (!arr) s.vol1m.set(key, (arr = []));
          insertSorted(arr, v1);
        }
      }
    }

    // Notable 5-minute build-ups (the two largest |ΔOI| this minute).
    if (base5) {
      const minOi = this.minOiPct(index, "5m");
      const minLtp = DEFAULT_MIN_LTP_CHG_PCT["5m"];
      const b5 = new Map(base5.rows.map((r) => [r.strike, r]));
      const found: { strike: number; side: "CE" | "PE"; d: SideDelta; cls: FlowBuildup }[] = [];
      for (const r of cur.rows) {
        if (!near(r.strike, EVENT_STRIKES)) continue;
        for (const k of sides) {
          const q = r[k];
          if (!q) continue;
          const d = sideDelta(q, b5.get(r.strike)?.[k]);
          const cls = classifyBuildup(d.oiChgPct, d.ltpChgPct, minOi, minLtp);
          if (cls === "NEUTRAL" || d.oiChg === null || Math.abs(d.oiChgPct ?? 0) < NOTABLE_OI_MULT * minOi) continue;
          found.push({ strike: r.strike, side: SIDE[k], d, cls });
        }
      }
      found.sort((a, b) => Math.abs(b.d.oiChg ?? 0) - Math.abs(a.d.oiChg ?? 0));
      for (const f of found.slice(0, 2)) {
        this.event(s, `oi:${f.strike}${f.side}:${f.cls}`, 5 * MINUTE_MS, cur.t, {
          kind: "OI_BUILDUP",
          strike: f.strike,
          side: f.side,
          buildup: f.cls,
          oiChg: f.d.oiChg,
          ltpChgPct: f.d.ltpChgPct,
          volMultiple: null,
          text: `${hm} · ${index} ${f.strike} ${f.side} · ${signedQty(f.d.oiChg!)} OI in 5 min (${signedPct(f.d.oiChgPct ?? 0)}), price ${signedPct(f.d.ltpChgPct ?? 0)} → ${BUILDUP_LABEL[f.cls]} (${buildupActor(f.cls, f.side)})`,
        });
      }
    }

    // Premium dry-up at ATM±2 over 15 minutes.
    if (base15) {
      const b15 = new Map(base15.rows.map((r) => [r.strike, r]));
      let act = 0;
      let vol = 0;
      let normalVol = 0;
      let volKnown = true;
      let n = 0;
      for (const r of cur.rows) {
        if (!near(r.strike, DRY_UP_STRIKES)) continue;
        for (const k of sides) {
          const q = r[k];
          const bq = b15.get(r.strike)?.[k];
          if (!q || !bq) continue;
          const d = sideDelta(q, bq);
          if (d.oiChg !== null) act += Math.abs(d.oiChg);
          if (d.vol !== null) vol += d.vol;
          const nb = this.volBase(s, index, r.strike, SIDE[k], atm, step, cur.t);
          if (nb) normalVol += nb.v * 15;
          else volKnown = false;
          n++;
        }
      }
      const medAct = s.oiAct15.length >= DRY_UP_MIN_SAMPLES ? sortedMedian(s.oiAct15) : null;
      const was = s.dryUp;
      if (n > 0 && volKnown && normalVol > 0 && medAct !== null && medAct > 0) {
        const vr = vol / normalVol;
        const ar = act / medAct;
        s.dryUp = vr < DRY_UP_FRACTION && ar < DRY_UP_FRACTION;
        s.dryUpDetail = `At ATM±2 over 15 min: volume ${Math.round(vr * 100)}% of normal, |ΔOI| ${Math.round(ar * 100)}% of the session's median.${s.dryUp ? " Premium is drying up: little is trading, so an option bought now mostly pays decay until the market wakes up." : ""}`;
      } else {
        s.dryUp = false;
        s.dryUpDetail = "Not enough history yet to judge the volume against normal.";
      }
      if (s.dryUp && !was) {
        this.event(s, "dryup", 15 * MINUTE_MS, cur.t, {
          kind: "DRY_UP",
          strike: atm,
          side: null,
          buildup: null,
          oiChg: null,
          ltpChgPct: null,
          volMultiple: null,
          text: `${hm} · ${index} ATM ${atm} · premium drying up: ${s.dryUpDetail.replace(/ Premium is drying up.*$/, "")}`,
        });
      }
      if (n > 0) insertSorted(s.oiAct15, act);

      // PCR shift on the strikes present at both times.
      const common = new Set(cur.rows.filter((r) => b15.has(r.strike)).map((r) => r.strike));
      const p0 = snapshotPcr(base15, common);
      const p1 = snapshotPcr(cur, common);
      if (p0 !== null && p1 !== null && Math.abs(p1 - p0) >= PCR_SHIFT) {
        const up = p1 > p0;
        this.event(s, `pcr:${up ? "up" : "down"}`, 15 * MINUTE_MS, cur.t, {
          kind: "PCR_SHIFT",
          strike: null,
          side: null,
          buildup: null,
          oiChg: null,
          ltpChgPct: null,
          volMultiple: null,
          text: `${hm} · ${index} · PCR ${p0.toFixed(2)} → ${p1.toFixed(2)} in 15 min → ${up ? "put OI growing faster (support building)" : "call OI growing faster (resistance building)"}`,
        });
      }
    }

    // OI walls: the most call OI (resistance) and put OI (support). The snapshot holds only the subscribed
    // strikes, which re-centre with the spot: a move is reported only when both strikes were in view both times.
    const walls = maxOiStrikes(cur);
    const prevStrikes = prev ? new Set(prev.rows.map((r) => r.strike)) : null;
    const curStrikes = new Set(cur.rows.map((r) => r.strike));
    for (const [k, label, who] of [
      ["ce", "Resistance", "call"],
      ["pe", "Support", "put"],
    ] as const) {
      const w = walls[k];
      const old = s.walls[k];
      const inView = prevStrikes !== null && w !== null && old !== null && prevStrikes.has(old) && prevStrikes.has(w.strike) && curStrikes.has(old);
      if (w && old !== null && w.strike !== old && inView) {
        this.event(s, `wall:${k}:${w.strike}`, 15 * MINUTE_MS, cur.t, {
          kind: "WALL_SHIFT",
          strike: w.strike,
          side: SIDE[k],
          buildup: null,
          oiChg: null,
          ltpChgPct: null,
          volMultiple: null,
          text: `${hm} · ${index} · ${label} moved ${old} → ${w.strike} (most ${who} OI: ${fmtQty(w.oi)})`,
        });
      }
      if (w) s.walls[k] = w.strike;
    }
  }

  private rows(s: Series, cur: ChainSnapshot, base: ChainSnapshot | null, key: FlowWindowKey, atm: number, step: number): FlowStrikeRow[] {
    const w = FLOW_WINDOWS[key];
    const minOi = this.minOiPct(cur.index, key);
    const minLtp = DEFAULT_MIN_LTP_CHG_PCT[key];
    const b = base ? new Map(base.rows.map((r) => [r.strike, r])) : null;
    const side = (q: SideQuote | null, bq: SideQuote | null | undefined, sd: "CE" | "PE", strike: number): FlowSideView | null => {
      if (!q) return null;
      const d = sideDelta(q, bq);
      const nb = d.vol !== null ? this.volBase(s, cur.index, strike, sd, atm, step, cur.t) : null;
      return {
        oi: q.oi,
        ltp: q.ltp,
        bid: q.bid,
        ask: q.ask,
        iv: q.iv,
        delta: q.delta,
        oiChg: d.oiChg,
        oiChgPct: d.oiChgPct,
        vol: d.vol,
        volMultiple: d.vol !== null && nb ? round(d.vol / w / nb.v, 2) : null,
        ltpChgPct: d.ltpChgPct,
        ivChg: d.ivChg,
        buildup: classifyBuildup(d.oiChgPct, d.ltpChgPct, minOi, minLtp),
      };
    };
    return cur.rows.map((r) => {
      const br = b?.get(r.strike);
      return { strike: r.strike, ce: side(r.ce, br?.ce, "CE", r.strike), pe: side(r.pe, br?.pe, "PE", r.strike) };
    });
  }

  /** The dashboard's view of an index's flow at `nowMs`. */
  view(index: IndexId, nowMs: number, ctx: FlowViewContext = {}): OptionFlowView {
    const source = ctx.source ?? "feed";
    const s = this.series.get(index);
    const cur = s?.snaps[s.snaps.length - 1] ?? null;
    const bestEntryWindow = entryWindowVerdict(this.stats, index, istMinutes(nowMs), ctx.dte ?? null);
    if (!s || !cur) return emptyFlowView(index, source, this.stats, bestEntryWindow, ctx.note ?? "No option-flow snapshot yet: the market feed samples the chain once a minute during market hours.");
    const step = strikeStep(cur.rows);
    const atm = nearestStrike(cur.rows, cur.spot);
    const bases = { "1m": this.base(s, cur, 1), "5m": this.base(s, cur, 5), "15m": this.base(s, cur, 15) };
    const windows = Object.fromEntries(
      WINDOW_KEYS.map((k): [FlowWindowKey, FlowWindowView] => [k, { minutes: FLOW_WINDOWS[k], from: bases[k] ? istIso(bases[k]!.t) : null, rows: this.rows(s, cur, bases[k], k, atm, step) }]),
    ) as Record<FlowWindowKey, FlowWindowView>;

    const notes: string[] = [];
    if (ctx.note) notes.push(ctx.note);
    const age = nowMs - cur.t;
    if (age > STALE_MS) notes.push(`The latest option-flow snapshot is ${Math.round(age / MINUTE_MS)} min old.`);
    if (!bases["15m"]) notes.push(`${s.snaps.length} minute${s.snaps.length === 1 ? "" : "s"} of history so far: the 15-minute changes need 15.`);

    const decayBase = bases["15m"] ?? bases["5m"];
    const research = statsBaselines(this.stats).volume.size > 0;
    const summary: FlowSummaryView = {
      callWritersVsPutWriters: writersLean(cur, bases["15m"], atm, step, "15m"),
      pcr: snapshotPcr(cur),
      pcrChg15m: pcrChange(cur, bases["15m"]),
      resistance: maxOiStrikes(cur).ce,
      support: maxOiStrikes(cur).pe,
      fastestOiAdd: fastestAdd(windows["15m"].rows),
      premiumDryUp: s.dryUp,
      dryUpDetail: s.dryUpDetail || "Needs 15 minutes of history.",
      decayPctPerHourAtm: decayBase ? atmDecayPctPerHour(cur, decayBase, atm) : null,
      volumeBaseline: research ? "research" : [...s.vol1m.values()].some((a) => a.length >= SPIKE_MIN_SAMPLES) ? "session" : "none",
    };
    return {
      index,
      source,
      asOf: istIso(cur.t),
      expiry: cur.expiry,
      lotSize: cur.lotSize,
      spot: cur.spot,
      atm,
      step: step || null,
      minutes: s.snaps.length,
      note: notes.length > 0 ? notes.join(" ") : null,
      windows,
      events: s.events.slice(0, this.maxEvents),
      summary,
      bestEntryWindow,
      honestSummary: [...this.stats.honestSummary],
      statsGeneratedAt: this.stats.generatedAt || null,
    };
  }
}

/** The most call OI and the most put OI strikes. */
export function maxOiStrikes(snap: ChainSnapshot): { ce: { strike: number; oi: number } | null; pe: { strike: number; oi: number } | null } {
  let ce: { strike: number; oi: number } | null = null;
  let pe: { strike: number; oi: number } | null = null;
  for (const r of snap.rows) {
    if (pos(r.ce?.oi) && (!ce || r.ce!.oi! > ce.oi)) ce = { strike: r.strike, oi: r.ce!.oi! };
    if (pos(r.pe?.oi) && (!pe || r.pe!.oi! > pe.oi)) pe = { strike: r.strike, oi: r.pe!.oi! };
  }
  return { ce, pe };
}

function pcrChange(cur: ChainSnapshot, base: ChainSnapshot | null): number | null {
  if (!base) return null;
  const have = new Set(base.rows.map((r) => r.strike));
  const common = new Set(cur.rows.filter((r) => have.has(r.strike)).map((r) => r.strike));
  const p0 = snapshotPcr(base, common);
  const p1 = snapshotPcr(cur, common);
  return p0 !== null && p1 !== null ? round(p1 - p0, 4) : null;
}

function fastestAdd(rows: FlowStrikeRow[]): FlowSummaryView["fastestOiAdd"] {
  let ce: { strike: number; oiChg: number } | null = null;
  let pe: { strike: number; oiChg: number } | null = null;
  for (const r of rows) {
    const c = r.ce?.oiChg;
    const p = r.pe?.oiChg;
    if (fin(c) && c > 0 && (!ce || c > ce.oiChg)) ce = { strike: r.strike, oiChg: c };
    if (fin(p) && p > 0 && (!pe || p > pe.oiChg)) pe = { strike: r.strike, oiChg: p };
  }
  return { ce, pe };
}

/** Call vs put OI added at ATM±3 between `base` and `cur` (or `oiChg` fields of `cur` rows when `base` is "day"). */
export function writersLean(
  cur: ChainSnapshot,
  base: ChainSnapshot | null,
  atm: number,
  step: number,
  window: "15m" | "day",
  dayChanges?: ReadonlyMap<number, { ce: number | null; pe: number | null }>,
): FlowSummaryView["callWritersVsPutWriters"] {
  const span = window === "15m" ? "in 15 min" : "since the previous close";
  if (window === "15m" && !base) return { window, ceOiAdded: null, peOiAdded: null, lean: "UNKNOWN", text: "Needs 15 minutes of history." };
  const b = base ? new Map(base.rows.map((r) => [r.strike, r])) : null;
  let ce = 0;
  let pe = 0;
  let n = 0;
  for (const r of cur.rows) {
    if (!(step > 0) || Math.abs(r.strike - atm) > SUMMARY_STRIKES * step + 1e-9) continue;
    if (window === "day") {
      const d = dayChanges?.get(r.strike);
      if (fin(d?.ce)) [ce, n] = [ce + d.ce, n + 1];
      if (fin(d?.pe)) [pe, n] = [pe + d.pe, n + 1];
      continue;
    }
    const br = b?.get(r.strike);
    if (fin(r.ce?.oi) && fin(br?.ce?.oi)) [ce, n] = [ce + r.ce!.oi! - br!.ce!.oi!, n + 1];
    if (fin(r.pe?.oi) && fin(br?.pe?.oi)) [pe, n] = [pe + r.pe!.oi! - br!.pe!.oi!, n + 1];
  }
  if (n === 0) return { window, ceOiAdded: null, peOiAdded: null, lean: "UNKNOWN", text: "No OI to compare." };
  const scale = Math.abs(ce) + Math.abs(pe);
  const tilt = scale > 0 ? (pe - ce) / scale : 0;
  const lean = tilt >= 0.2 ? "PUT_WRITERS" : tilt <= -0.2 ? "CALL_WRITERS" : "BALANCED";
  const facts = `Put OI ${signedQty(pe)} vs call OI ${signedQty(ce)} at ATM±${SUMMARY_STRIKES} ${span}`;
  const meaning =
    lean === "PUT_WRITERS"
      ? "put writers adding faster: support building below"
      : lean === "CALL_WRITERS"
        ? "call writers adding faster: resistance building above"
        : "balanced";
  return { window, ceOiAdded: ce, peOiAdded: pe, lean, text: `${facts}: ${meaning}.` };
}

const EMPTY_SUMMARY = (detail: string): FlowSummaryView => ({
  callWritersVsPutWriters: { window: "15m", ceOiAdded: null, peOiAdded: null, lean: "UNKNOWN", text: detail },
  pcr: null,
  pcrChg15m: null,
  resistance: null,
  support: null,
  fastestOiAdd: { ce: null, pe: null },
  premiumDryUp: false,
  dryUpDetail: detail,
  decayPctPerHourAtm: null,
  volumeBaseline: "none",
});

/** A view with no snapshot (every number null), carrying `note`. */
export function emptyFlowView(index: IndexId, source: FlowSource, stats: FlowStatsFile, bestEntryWindow: OptionFlowView["bestEntryWindow"], note: string): OptionFlowView {
  const w = (minutes: number): FlowWindowView => ({ minutes, from: null, rows: [] });
  return {
    index,
    source,
    asOf: null,
    expiry: null,
    lotSize: null,
    spot: null,
    atm: null,
    step: null,
    minutes: 0,
    note,
    windows: { "1m": w(1), "5m": w(5), "15m": w(15) },
    events: [],
    summary: EMPTY_SUMMARY("No option-flow snapshot yet."),
    bestEntryWindow,
    honestSummary: [...stats.honestSummary],
    statsGeneratedAt: stats.generatedAt || null,
  };
}

// ---------------------------------------------------------------------------
// Compact storage form (one key per minute per index in the Durable Object)
// ---------------------------------------------------------------------------

/** [strike, ce ltp, volume, oi, bid, ask, iv, delta, pe ltp, volume, oi, bid, ask, iv, delta]; a missing side is 7 nulls. */
export type PackedRow = (number | null)[];
export interface PackedSnapshot {
  v: 1;
  t: number;
  i: IndexId;
  e: string | null;
  l: number | null;
  s: number;
  r: PackedRow[];
}

const SIDE_FIELDS = ["ltp", "volume", "oi", "bid", "ask", "iv", "delta"] as const;

export function packSnapshot(snap: ChainSnapshot): PackedSnapshot {
  const side = (q: SideQuote | null): (number | null)[] => SIDE_FIELDS.map((f) => (q && fin(q[f]) ? q[f] : null));
  return { v: 1, t: snap.t, i: snap.index, e: snap.expiry, l: snap.lotSize, s: snap.spot, r: snap.rows.map((r) => [r.strike, ...side(r.ce), ...side(r.pe)]) };
}

export function unpackSnapshot(p: PackedSnapshot): ChainSnapshot | null {
  if (!p || p.v !== 1 || !Array.isArray(p.r) || (p.i !== "NIFTY" && p.i !== "SENSEX") || !fin(p.t) || !fin(p.s)) return null;
  const side = (vals: (number | null)[]): SideQuote | null => {
    if (vals.every((x) => x === null)) return null;
    const q = {} as SideQuote;
    SIDE_FIELDS.forEach((f, i) => {
      q[f] = fin(vals[i]) ? (vals[i] as number) : null;
    });
    return q;
  };
  const rows: ChainRow[] = [];
  for (const r of p.r) {
    if (!Array.isArray(r) || r.length !== 1 + 2 * SIDE_FIELDS.length || !fin(r[0])) continue;
    rows.push({ strike: r[0] as number, ce: side(r.slice(1, 8)), pe: side(r.slice(8, 15)) });
  }
  return { t: p.t, index: p.i, expiry: p.e ?? null, lotSize: fin(p.l) ? p.l : null, spot: p.s, rows };
}

/** Event kinds, for callers that filter. */
export const FLOW_EVENT_KINDS: readonly FlowEventKind[] = ["OI_BUILDUP", "VOLUME_SPIKE", "DRY_UP", "PCR_SHIFT", "WALL_SHIFT"];
