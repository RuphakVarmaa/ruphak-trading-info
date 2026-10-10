/**
 * WP11: option strategies on real 1-minute option prices (reports/wp11-real-intraday.md; every
 * definition is frozen in its §1, committed before any P&L was computed). Research only: nothing
 * here changes the engine.
 *
 * Data: Hugging Face dataset "India Index & Options - 1-minute OHLC" by TradeMarkk
 * (thetrademarkk/india-index-options-1m, revision 0f4800e4), licence CC-BY-NC-4.0, non-commercial
 * research use only; reduced to compact extracts by scripts/research/wp11_extract.py. Raw data is
 * never committed.
 *
 *   npx tsx scripts/research/wp11-real-intraday.ts verify --x <extract dir> --dir <bhavcopy cache> --hourly <yahoo 1h dir> [--out reports/wp11]
 *   npx tsx scripts/research/wp11-real-intraday.ts run    --x <extract dir> --dir <bhavcopy cache> [--out reports/wp11] [--bootstrap 100000] [--ledger]
 *
 *   --x        the extract directory (index/<SYM>.csv.gz, opt/<SYM>/<day>_<expiry>.csv.gz, manifest.json)
 *   --dir      the compact bhavcopy cache of scripts/fetch-bhavcopy.ts with index-daily.json (exchange reference)
 *   --hourly   Yahoo 1-hour chart JSONs NSEI.json and BSESN.json (spot cross-check)
 *   --out      where tables and summary JSON go (reports/ is gitignored; raw data is never written there)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  aggregate,
  drawInt,
  hhmmToMin,
  itmStrike,
  minToHhmm,
  MinuteSeries,
  nearestListed,
  OPEN_MIN,
  pairedGap,
  perturbDistance,
  runPosition,
  walkForwardSplit,
  type FillMode,
  type MinuteBar,
  type PositionLeg,
  type PositionResult,
} from "../../src/engine/backtest/intraday1m";
import { dayBlockBootstrap, deflatedSharpe, profitFactor, seededRandom, type BlockBootstrap, type SessionPnl } from "../../src/engine/backtest/metrics";
import type { BhavRow } from "../../src/engine/backtest/realPrices";
import { expectedMove, flyNoArbitrage, maxDrawdown, modeLot, strikeBeyond, structurePnl, tailShare, worstRun, type LegSpec } from "../../src/engine/backtest/shortPremium";
import { formatTrial, parseTrials, sharpeVariance, type TrialRecord } from "../../src/engine/backtest/trials";
import { addDays, istAt, MINUTE_MS } from "../../src/engine/clock";
import { istMinuteOfDay } from "../../src/engine/market/candles";
import type { SessionBars } from "../../src/engine/strategy/published";
import { firstCandlePlan } from "../../src/engine/strategy/published/firstCandle";
import { noiseAreaDecision, type NoiseAreaParams } from "../../src/engine/strategy/published/noiseArea";
import { orb5Plan } from "../../src/engine/strategy/published/orb5";
import type { Candle, Exchange } from "../../src/engine/types";
import { quantile } from "../../src/engine/util/math";
import { ROOT, fail, num, parseArgs, str } from "../lib/node";
import { loadResearchData, md, RESEARCH_INDICES, type ResearchData, type ResearchIndex } from "./real_prices";

export type IndexId = ResearchIndex["id"];

const median = (xs: readonly number[]) => quantile(xs, 0.5);
export type OptType = "CE" | "PE";

// ---------------------------------------------------------------------------
// Extract loading
// ---------------------------------------------------------------------------

export interface Manifest {
  [sym: string]: {
    step: number;
    sessions: string[];
    expiries: string[];
    expiry_gaps_over_8_days: [string, string][];
    pairs: Record<string, { role: string; rows: number; strikes: number; kmin: number; kmax: number; window: [number, number]; em: number; vixPrev: number }>;
    missing_pairs: string[];
    files: Record<string, Record<string, number | string>>;
    index_checks: Record<string, number>;
  };
}

function gunzipText(path: string): string {
  return gunzipSync(readFileSync(path)).toString("utf8");
}

/** Index 1-minute bars by session (09:00..15:59 as extracted). */
export function loadIndex(x: string, sym: IndexId): Map<string, MinuteBar[]> {
  const out = new Map<string, MinuteBar[]>();
  const lines = gunzipText(resolve(x, "index", `${sym}.csv.gz`)).split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const p = line.split(",");
    const day = p[0];
    let arr = out.get(day);
    if (!arr) out.set(day, (arr = []));
    arr.push({ m: Number(p[1]), o: Number(p[2]), h: Number(p[3]), l: Number(p[4]), c: Number(p[5]), v: 0, oi: 0 });
  }
  return out;
}

/** One contract day file: series by `${strike}${C|P}`. */
export interface ChainDay {
  day: string;
  expiry: string;
  role: string;
  series: Map<string, MinuteSeries>;
  /** Strikes with at least one bar, per type, ascending. */
  strikes: Record<OptType, number[]>;
}

export const key = (k: number, t: OptType) => `${k}${t === "CE" ? "C" : "P"}`;

export function loadChainDay(x: string, sym: IndexId, day: string, expiry: string, role: string): ChainDay | null {
  const p = resolve(x, "opt", sym, `${day}_${expiry}.csv.gz`);
  if (!existsSync(p)) return null;
  const lines = gunzipText(p).split("\n");
  const raw = new Map<string, MinuteBar[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(",");
    const v = Number(f[7]);
    // A bar without volume (only in the sampled bars from 2025) repeats the last price: no trade that minute.
    if (!(v > 0)) continue;
    const k = `${f[1]}${f[2]}`;
    let arr = raw.get(k);
    if (!arr) raw.set(k, (arr = []));
    arr.push({ m: Number(f[0]), o: Number(f[3]), h: Number(f[4]), l: Number(f[5]), c: Number(f[6]), v, oi: Number(f[8]) });
  }
  const series = new Map<string, MinuteSeries>();
  const strikes: Record<OptType, number[]> = { CE: [], PE: [] };
  for (const [k, bars] of raw) {
    series.set(k, new MinuteSeries(bars));
    const strike = Number(k.slice(0, -1));
    strikes[k.endsWith("C") ? "CE" : "PE"].push(strike);
  }
  strikes.CE.sort((a, b) => a - b);
  strikes.PE.sort((a, b) => a - b);
  return { day, expiry, role, series, strikes };
}

export function loadManifest(x: string): Manifest {
  return JSON.parse(readFileSync(resolve(x, "manifest.json"), "utf8")) as Manifest;
}

/** Expiry conventions: A = nearest on or after the day (the expiring contract on its expiry day), B = nearest strictly after. */
export function expiryFor(expiries: readonly string[], day: string, conv: "A" | "B"): string | null {
  for (const e of expiries) if (conv === "A" ? e >= day : e > day) return e;
  return null;
}

/** Lot size in force for a contract on a day: the modal lot of its bhavcopy rows (null when the bhavcopy has none). */
export function lotOf(data: ResearchData, sym: IndexId, day: string, expiry: string): number | null {
  return modeLot(data.book.rows(sym, day).filter((r) => r.kind === "OPT" && r.expiry === expiry).map((r) => r.lot));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "–");
export const fx = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
export const rs = (x: number) => (Number.isFinite(x) ? `${x < 0 ? "−" : ""}₹${Math.round(Math.abs(x)).toLocaleString("en-IN")}` : "–");

// ---------------------------------------------------------------------------
// Step 1: verification against the exchange files and the spot series
// ---------------------------------------------------------------------------

interface ContractCheck {
  day: string;
  expiry: string;
  strike: number;
  type: OptType;
  atm: boolean;
  liquid: boolean;
  firstMin: number;
  openDiff: number;
  openRel: number;
  hiDiff: number;
  loDiff: number;
  hiWithin: boolean;
  loWithin: boolean;
  closeRel: number | null;
  closeRelClose: number | null;
  lastDiff: number | null;
  volRatio: number | null;
  oiRatio: number | null;
}

const TICK = 0.05;
const near = (a: number, b: number, tol = TICK / 2 + 1e-9) => Math.abs(a - b) <= tol;

function checkContract(day: string, expiry: string, strike: number, type: OptType, s: MinuteSeries, row: BhavRow, atm: boolean): ContractCheck | null {
  if (!(row.contracts > 0) || row.open === null || row.high === null || row.low === null) return null;
  const first = s.first!;
  const hi = Math.max(...s.bars.map((b) => b.h));
  const lo = Math.min(...s.bars.map((b) => b.l));
  // NSE's closing price: VWAP of the trades in the last 30 minutes (15:00-15:30); bars starting 15:00..15:29.
  const last30 = s.between(15 * 60, 15 * 60 + 30).filter((b) => b.v > 0);
  let closeRel: number | null = null;
  let closeRelClose: number | null = null;
  if (last30.length > 0 && row.close !== null && row.close > 0) {
    const v = last30.reduce((a, b) => a + b.v, 0);
    const vwapTyp = last30.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0) / v;
    const vwapClose = last30.reduce((a, b) => a + b.c * b.v, 0) / v;
    closeRel = vwapTyp / row.close - 1;
    closeRelClose = vwapClose / row.close - 1;
  }
  const lastBar = s.last!;
  const units = row.lot !== null && row.lot > 0 ? row.contracts * row.lot : null;
  const vol = s.bars.reduce((a, b) => a + b.v, 0);
  return {
    day,
    expiry,
    strike,
    type,
    atm,
    liquid: row.contracts >= 1000,
    firstMin: first.m,
    openDiff: first.o - row.open,
    openRel: first.o / row.open - 1,
    hiDiff: hi - row.high,
    loDiff: lo - row.low,
    hiWithin: hi <= row.high + TICK / 2,
    loWithin: lo >= row.low - TICK / 2,
    closeRel,
    closeRelClose,
    lastDiff: row.last !== null ? lastBar.c - row.last : null,
    volRatio: units ? vol / units : null,
    oiRatio: row.oi !== null && row.oi > 0 ? lastBar.oi / row.oi : null,
  };
}

function rate(xs: boolean[]): string {
  return xs.length ? `${pct(xs.filter(Boolean).length / xs.length)} (${xs.filter(Boolean).length}/${xs.length})` : "–";
}

function checkTable(label: string, cs: ContractCheck[]): (string | number)[] {
  const open915 = cs.filter((c) => c.firstMin === OPEN_MIN);
  const closes = cs.filter((c) => c.closeRel !== null);
  const lasts = cs.filter((c) => c.lastDiff !== null);
  const vols = cs.filter((c) => c.volRatio !== null).map((c) => c.volRatio!);
  return [
    label,
    cs.length,
    rate(open915.map((c) => near(c.openDiff, 0))),
    rate(cs.map((c) => near(c.openDiff, 0))),
    rate(cs.map((c) => near(c.hiDiff, 0) && near(c.loDiff, 0))),
    rate(cs.map((c) => c.hiWithin && c.loWithin)),
    rate(closes.map((c) => Math.abs(c.closeRel!) <= 0.005)),
    rate(closes.map((c) => Math.abs(c.closeRel!) <= 0.01)),
    closes.length ? pct(median(closes.map((c) => Math.abs(c.closeRel!))), 2) : "–",
    rate(lasts.map((c) => near(c.lastDiff!, 0))),
    vols.length ? `${fx(median(vols), 3)} [${fx(quantile(vols, 0.05), 3)}, ${fx(quantile(vols, 0.95), 3)}]` : "–",
  ];
}

const CHECK_HEAD = [
  "contracts",
  "n",
  "09:15 bar open = bhav OPEN (±½ tick; first bar at 09:15)",
  "first bar open = bhav OPEN (any first minute)",
  "1-min high & low = bhav HIGH & LOW",
  "1-min range inside bhav range",
  "15:00–15:30 VWAP within 0.5% of bhav CLOSE",
  "within 1%",
  "median |VWAP ÷ CLOSE − 1|",
  "last bar close = bhav LAST (NSE UDiFF)",
  "Σ volume ÷ (contracts × lot): median [p5, p95]",
];

interface YahooBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function loadYahooChart(path: string): YahooBar[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as { chart: { result: { timestamp: number[]; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } };
  const r = j.chart.result[0];
  const q = r.indicators.quote[0];
  const out: YahooBar[] = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o !== null && h !== null && l !== null && c !== null) out.push({ t: t * 1000, o, h, l, c });
  });
  return out;
}

/** IST date and minute of an epoch-ms time. */
function istDayMin(ms: number): { day: string; min: number } {
  const d = new Date(ms + 330 * 60_000);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** India VIX close of the last session before `day` (Yahoo daily), or null. */
export function vixBefore(data: ResearchData, day: string): number | null {
  const m = data.daily.get("^INDIAVIX");
  if (!m) return null;
  let best: string | null = null;
  for (const d of m.keys()) if (d < day && (best === null || d > best)) best = d;
  const c = best ? m.get(best)?.c : undefined;
  return c !== undefined && c > 0 ? c : null;
}

/** The exchange's nearest listed expiry on or after (A) / strictly after (B) the day, from the bhavcopy. */
export function bhavExpiry(data: ResearchData, sym: IndexId, day: string, conv: "A" | "B"): string | null {
  return expiryFor(data.book.expiries(sym, day), day, conv);
}

/** Strikes with bars for both the call and the put. */
export function bothListed(chain: ChainDay): number[] {
  const pe = new Set(chain.strikes.PE);
  return chain.strikes.CE.filter((k) => pe.has(k));
}

const ORDER_MINUTES = ["09:15", "09:16", "09:20", "09:30", "11:15", "15:00", "15:20"];

function coverage(data: ResearchData, x: string, sym: IndexId, man: Manifest[string], index: Map<string, MinuteBar[]>, days: string[]): { text: string } {
  let noB = 0;
  let missingFile = 0;
  let used = 0;
  const atmShare: number[] = [];
  const atAll = new Map<string, number>();
  const wingAt = new Map<string, number>();
  const wingSame = new Map<string, number>();
  for (const day of days) {
    const e = bhavExpiry(data, sym, day, "B");
    if (!e) {
      noB++;
      continue;
    }
    if (!man.pairs[`${day}_${e}`]) {
      missingFile++;
      continue;
    }
    const chain = loadChainDay(x, sym, day, e, man.pairs[`${day}_${e}`].role);
    const open = index.get(day)?.find((b) => b.m === OPEN_MIN)?.o;
    if (!chain || open === undefined) continue;
    used++;
    const ks = bothListed(chain);
    const k = ks.length ? ks.reduce((a, b) => (Math.abs(b - open) < Math.abs(a - open) || (Math.abs(b - open) === Math.abs(a - open) && b < a) ? b : a)) : null;
    if (k === null) continue;
    const c = chain.series.get(key(k, "CE"))!;
    const p = chain.series.get(key(k, "PE"))!;
    atmShare.push((c.between(OPEN_MIN, 930).length + p.between(OPEN_MIN, 930).length) / 750);
    const vix = vixBefore(data, day);
    const em = vix ? open * (vix / 100) * Math.sqrt(1 / 252) : null;
    for (const hm of ORDER_MINUTES) {
      const [h, mm] = hm.split(":").map(Number);
      const m = h * 60 + mm;
      if (c.at(m) && p.at(m)) atAll.set(hm, (atAll.get(hm) ?? 0) + 1);
      if (em === null || hm >= "15:00") continue;
      for (const w of [1, 2]) {
        const kc = chain.strikes.CE.filter((s) => s > k).reduce<number | null>((best, s) => (best === null || Math.abs(s - (k + w * em)) < Math.abs(best - (k + w * em)) ? s : best), null);
        const kp = chain.strikes.PE.filter((s) => s < k).reduce<number | null>((best, s) => (best === null || Math.abs(s - (k - w * em)) < Math.abs(best - (k - w * em)) ? s : best), null);
        if (kc === null || kp === null) continue;
        const wc = chain.series.get(key(kc, "CE"))!;
        const wp = chain.series.get(key(kp, "PE"))!;
        const tag = `${w}EM ${hm}`;
        if (wc.firstFrom(m, 2) && wp.firstFrom(m, 2)) wingAt.set(tag, (wingAt.get(tag) ?? 0) + 1);
        if (c.at(m) && p.at(m) && wc.at(m) && wp.at(m)) wingSame.set(tag, (wingSame.get(tag) ?? 0) + 1);
      }
    }
  }
  const rows: (string | number)[][] = [["order minute", "ATM call and put both have a bar", "1 EM wings have a bar within 2 min", "all four legs (1 EM) in that minute", "2 EM wings within 2 min", "all four legs (2 EM) in that minute"]];
  for (const hm of ORDER_MINUTES) {
    const f = (mp: Map<string, number>, t: string) => pct((mp.get(t) ?? 0) / Math.max(1, used));
    rows.push([hm, f(atAll, hm), hm >= "15:00" ? "–" : f(wingAt, `1EM ${hm}`), hm >= "15:00" ? "–" : f(wingSame, `1EM ${hm}`), hm >= "15:00" ? "–" : f(wingAt, `2EM ${hm}`), hm >= "15:00" ? "–" : f(wingSame, `2EM ${hm}`)]);
  }
  const text = `\n**Coverage of the traded contracts (convention B: the exchange's nearest expiry after the day)**: ${days.length} sessions; no B expiry listed ${noB}; B contract missing from the dataset ${missingFile}; usable ${used}. ATM straddle (strike nearest the index open): median share of the 375 session minutes with a bar ${pct(median(atmShare))} (p10 ${pct(quantile(atmShare, 0.1))}).\n\n${md(rows)}\n`;
  return { text };
}

/**
 * Anatomy of the opening-print mismatches, per month, for the ATM call and put of every kept
 * contract (strike nearest the index open): how often the dataset's first 09:15 bar opens at the
 * bhavcopy OPEN, the signed gap when it does not, whether the bhavcopy OPEN lies inside the 09:15
 * bar's range, and how often the bhavcopy OPEN is the day's HIGH or LOW.
 */
function openAnatomy(data: ResearchData, x: string, sym: IndexId, man: Manifest[string], index: Map<string, MinuteBar[]>, days: string[]): string {
  const byMonth = new Map<string, { n: number; match: number; signed: number[]; inside: number; openIsHigh: number; openIsExtreme: number; hiMatch: number; loMatch: number; hfBelow: number }>();
  for (const day of days) {
    const open = index.get(day)?.find((b) => b.m === OPEN_MIN)?.o;
    if (open === undefined) continue;
    for (const conv of ["A", "B"] as const) {
      const e = bhavExpiry(data, sym, day, conv);
      if (!e || (conv === "B" && e === bhavExpiry(data, sym, day, "A")) || !man.pairs[`${day}_${e}`]) continue;
      const chain = loadChainDay(x, sym, day, e, man.pairs[`${day}_${e}`].role);
      if (!chain) continue;
      const ks = bothListed(chain);
      if (!ks.length) continue;
      const k = ks.reduce((a, b) => (Math.abs(b - open) < Math.abs(a - open) ? b : a));
      for (const t of ["CE", "PE"] as const) {
        const s = chain.series.get(key(k, t));
        const row = data.book.option(sym, day, e, k, t);
        const b0 = s?.at(OPEN_MIN);
        if (!s || !b0 || !row || row.open === null || row.high === null || row.low === null || !(row.contracts > 0)) continue;
        const mo = day.slice(0, 7);
        let a = byMonth.get(mo);
        if (!a) byMonth.set(mo, (a = { n: 0, match: 0, signed: [], inside: 0, openIsHigh: 0, openIsExtreme: 0, hiMatch: 0, loMatch: 0, hfBelow: 0 }));
        a.n++;
        if (near(b0.o, row.open)) a.match++;
        else {
          a.signed.push(b0.o / row.open - 1);
          if (b0.o < row.open) a.hfBelow++;
        }
        if (row.open >= b0.l - TICK / 2 && row.open <= b0.h + TICK / 2) a.inside++;
        if (near(row.open, row.high)) a.openIsHigh++;
        if (near(row.open, row.high) || near(row.open, row.low)) a.openIsExtreme++;
        if (near(Math.max(...s.bars.map((z) => z.h)), row.high)) a.hiMatch++;
        if (near(Math.min(...s.bars.map((z) => z.l)), row.low)) a.loMatch++;
      }
    }
  }
  const rows: (string | number)[][] = [["month", "ATM legs", "09:15 open = bhav OPEN", "bhav OPEN inside the 09:15 bar's range", "1-min high = bhav HIGH", "1-min low = bhav LOW", "bhav OPEN is the day's HIGH", "mismatches: median (09:15 open ÷ bhav OPEN − 1)", "mismatches with the 09:15 open below the bhav OPEN"]];
  for (const [mo, a] of [...byMonth].sort()) {
    rows.push([mo, a.n, pct(a.match / a.n), pct(a.inside / a.n), pct(a.hiMatch / a.n), pct(a.loMatch / a.n), pct(a.openIsHigh / a.n), a.signed.length ? pct(median(a.signed), 2) : "–", a.signed.length ? pct(a.hfBelow / a.signed.length) : "–"]);
  }
  return `\n**Opening prints, month by month (${sym}, ATM call and put of the A and B contracts):**\n\n${md(rows)}\n`;
}

async function verify(args: ReturnType<typeof parseArgs>): Promise<void> {
  const x = str(args, "x") ?? fail("--x <extract dir> is required");
  const dir = str(args, "dir") ?? fail("--dir <bhavcopy cache> is required");
  const hourlyDir = str(args, "hourly");
  const outDir = resolve(ROOT, str(args, "out", "reports/wp11")!);
  const nRandom = Number(str(args, "days", "40"));
  const manifest = loadManifest(x);
  const t0 = Date.now();
  const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir });
  console.log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE bhavcopies in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
  const sections: string[] = [];
  const summary: Record<string, unknown> = {};
  for (const idx of RESEARCH_INDICES) {
    const sym = idx.id;
    const man = manifest[sym];
    const index = loadIndex(x, sym);
    const days = man.sessions.filter((d) => data.book.dates(sym).includes(d));
    const rnd = seededRandom(sym === "NIFTY" ? 11 : 13);
    const pool = [...days];
    const sample: string[] = [];
    while (sample.length < Math.min(nRandom, pool.length)) sample.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    sample.sort();
    const checksAll: ContractCheck[] = [];
    const checksSample: ContractCheck[] = [];
    const sampleSet = new Set(sample);
    let pairsSeen = 0;
    for (const day of days) {
      const bars = index.get(day);
      const open = bars?.find((b) => b.m === OPEN_MIN)?.o;
      for (const [pk, info] of Object.entries(man.pairs)) {
        if (!pk.startsWith(`${day}_`)) continue;
        const expiry = pk.slice(11);
        const chain = loadChainDay(x, sym, day, expiry, info.role);
        if (!chain) continue;
        pairsSeen++;
        const atmK = open !== undefined ? [...chain.strikes.CE].sort((a, b) => Math.abs(a - open) - Math.abs(b - open))[0] : null;
        for (const [k, s] of chain.series) {
          const strike = Number(k.slice(0, -1));
          const type: OptType = k.endsWith("C") ? "CE" : "PE";
          const row = data.book.option(sym, day, expiry, strike, type);
          if (!row) continue;
          const c = checkContract(day, expiry, strike, type, s, row, strike === atmK);
          if (!c) continue;
          checksAll.push(c);
          if (sampleSet.has(day)) checksSample.push(c);
        }
      }
    }
    // Spot: index 1-minute data against Yahoo daily (and NSE's UndrlygPric) and Yahoo hourly bars.
    const ydaily = data.daily.get(idx.yahoo)!;
    const spot: { day: string; openDiff: number; hiRel: number; loRel: number; closeRel: number | null; undRel: number | null }[] = [];
    for (const day of days) {
      const bars = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= 930);
      const y = ydaily.get(day);
      if (!bars.length || !y) continue;
      const o = bars.find((b) => b.m === OPEN_MIN)?.o;
      if (o === undefined) continue;
      const last = bars[bars.length - 1];
      const und = data.book.rows(sym, day).find((r) => r.underlying !== null && r.underlying > 0)?.underlying ?? null;
      spot.push({
        day,
        openDiff: o / y.o - 1,
        hiRel: Math.max(...bars.map((b) => b.h)) / y.h - 1,
        loRel: Math.min(...bars.map((b) => b.l)) / y.l - 1,
        closeRel: last.c / y.c - 1,
        undRel: und ? last.c / und - 1 : null,
      });
    }
    let hourly: { n: number; medO: number; medH: number; medL: number; medC: number; within002: number } | null = null;
    if (hourlyDir) {
      const file = resolve(hourlyDir, sym === "NIFTY" ? "NSEI.json" : "BSESN.json");
      if (existsSync(file)) {
        const ys = loadYahooChart(file);
        const rel: { o: number; h: number; l: number; c: number }[] = [];
        for (const yb of ys) {
          const { day, min } = istDayMin(yb.t);
          const bars = index.get(day);
          if (!bars) continue;
          const end = Math.min(min + 60, 930);
          const sub = bars.filter((b) => b.m >= min && b.m < end);
          if (sub.length < 10) continue;
          rel.push({ o: sub[0].o / yb.o - 1, h: Math.max(...sub.map((b) => b.h)) / yb.h - 1, l: Math.min(...sub.map((b) => b.l)) / yb.l - 1, c: sub[sub.length - 1].c / yb.c - 1 });
        }
        const a = (f: (r: { o: number; h: number; l: number; c: number }) => number) => median(rel.map((r) => Math.abs(f(r))));
        hourly = { n: rel.length, medO: a((r) => r.o), medH: a((r) => r.h), medL: a((r) => r.l), medC: a((r) => r.c), within002: rel.filter((r) => Math.max(Math.abs(r.o), Math.abs(r.h), Math.abs(r.l), Math.abs(r.c)) <= 0.0002).length / Math.max(1, rel.length) };
      }
    }
    // Coverage of the contracts the candidates trade (no prices used): the B contract's ATM straddle
    // and the iron fly's wings, bar presence at the pre-registered order minutes.
    const cov = coverage(data, x, sym, man, index, days);
    const atmS = checksSample.filter((c) => c.atm);
    const liqS = checksSample.filter((c) => c.liquid);
    const atmA = checksAll.filter((c) => c.atm);
    const liqA = checksAll.filter((c) => c.liquid);
    const rows: (string | number)[][] = [
      CHECK_HEAD,
      checkTable(`${sample.length} random days: every kept contract`, checksSample),
      checkTable(`${sample.length} random days: ATM (strike nearest the index open)`, atmS),
      checkTable(`${sample.length} random days: ≥ 1,000 contracts traded`, liqS),
      checkTable(`all ${days.length} days: every kept contract`, checksAll),
      checkTable(`all days: ATM`, atmA),
      checkTable(`all days: ≥ 1,000 contracts`, liqA),
    ];
    const byYear: (string | number)[][] = [["year", ...CHECK_HEAD.slice(1)]];
    for (const yr of [...new Set(checksAll.map((c) => c.day.slice(0, 4)))].sort()) byYear.push(checkTable(yr, atmA.filter((c) => c.day.startsWith(yr))));
    const sm = (f: (s: (typeof spot)[number]) => number | null) => {
      const v = spot.map(f).filter((z): z is number => z !== null).map(Math.abs);
      return v.length ? `median ${pct(median(v), 3)}, p99 ${pct(quantile(v, 0.99), 3)}, max ${pct(Math.max(...v), 3)}; ≤ 0.01%: ${pct(v.filter((z) => z <= 0.0001).length / v.length)}` : "–";
    };
    const firstPrintMiss = atmA.filter((c) => c.firstMin === OPEN_MIN && !near(c.openDiff, 0));
    const text = [
      `\n### ${sym}\n`,
      `Sessions with an extract and a bhavcopy: ${days.length} (${days[0]} … ${days[days.length - 1]}); day-contract files compared: ${pairsSeen}; random days (seeded): ${sample.join(", ")}.\n`,
      md(rows),
      `\nATM contracts by year (all days):\n\n${md(byYear)}\n`,
      `ATM contracts whose 09:15 bar open differs from the bhavcopy OPEN by more than half a tick: ${firstPrintMiss.length} of ${atmA.filter((c) => c.firstMin === OPEN_MIN).length}; median |difference| ${firstPrintMiss.length ? pct(median(firstPrintMiss.map((c) => Math.abs(c.openRel))), 2) : "–"}. Close cross-check with the bar close instead of the typical price: within 0.5% ${rate(checksAll.filter((c) => c.closeRelClose !== null).map((c) => Math.abs(c.closeRelClose!) <= 0.005))}. Open interest at the last bar ÷ bhavcopy OI: median ${fx(median(checksAll.filter((c) => c.oiRatio !== null).map((c) => c.oiRatio!)), 3)}.\n`,
      `**Spot** (${spot.length} sessions, 1-minute index vs Yahoo daily ${idx.yahoo}): 09:15 bar open vs Yahoo open: ${sm((s) => s.openDiff)}; day high: ${sm((s) => s.hiRel)}; day low: ${sm((s) => s.loRel)}; last bar close vs Yahoo close: ${sm((s) => s.closeRel)}; vs NSE UndrlygPric (UDiFF days): ${sm((s) => s.undRel)}.`,
      hourly ? `Hourly: ${hourly.n} Yahoo 1-hour bars rebuilt from the 1-minute bars: median |diff| open ${pct(hourly.medO, 3)}, high ${pct(hourly.medH, 3)}, low ${pct(hourly.medL, 3)}, close ${pct(hourly.medC, 3)}; all four within 0.02% on ${pct(hourly.within002)} of bars.\n` : "",
      cov.text,
    ].join("\n");
    console.log(text);
    sections.push(text);
    summary[sym] = { sample, days: days.length, pairsSeen, contractsAll: checksAll.length, contractsSample: checksSample.length, spot: spot.length, hourly };
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "verify.md"), `## Verification\n${sections.join("\n")}\n`);
  writeFileSync(resolve(outDir, "verify.json"), JSON.stringify(summary, null, 1));
  console.log(`Wrote ${resolve(outDir, "verify.md")}`);
}

// ---------------------------------------------------------------------------
// Step 2: the candidates on real 1-minute prices (frozen in the report's §1)
// ---------------------------------------------------------------------------

export const CAPITAL = 500_000;
const ENTRY_WAIT = 2;
const EXIT_WAIT = 5;
const PREMIUM_STOP = 0.3;
const WINDOW_START = hhmmToMin("09:25");
const LAST_ENTRY_DECISION = hhmmToMin("14:00");
const SQUARE_OFF = hhmmToMin("15:05");
const MIN_INDEX_BARS = 370;
const BOOT_FIRST = 20_000;
const BOOT_FINAL = 100_000;
const SELL_ENTRIES = ["09:15", "09:16", "09:20", "09:30", "11:15"];
const SELL_EXITS = ["15:00", "15:20"];
const SELL_STOPS: (number | null)[] = [null, 0.3, 0.5];
const TIMING_ENTRIES = ["09:15", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
const PLACEBO_DRAWS = 8;
const SELL_PLACEBO_WINDOW: [number, number] = [OPEN_MIN, hhmmToMin("14:00")];
/** Last session whose option bars hold every trade (verification, report §2); later bars are built from sampled prices. */
const ERA_END = "2024-12-31";

type Mode = Exclude<FillMode, "print">;
const MODES: readonly Mode[] = ["conservative", "mid"];
type Side = "BULL" | "BEAR";

export interface Trade {
  day: string;
  net: number;
  gross: number;
  charges: number;
  /** ₹ per lot of premium at the entry fills: received by the short legs (sellers) or paid for the long legs (buyers). */
  premium: number;
  entryMin: number;
  exitMin: number;
  reason: string;
  side: string;
  dte: number;
  stale: number;
}

interface Day {
  sym: IndexId;
  day: string;
  exchange: Exchange;
  idx: MinuteSeries;
  bars5: Candle[];
  open: number;
  prevClose: number | null;
  vixPrev: number | null;
  chain: { A: ChainDay | null; B: ChainDay | null };
  lot: { A: number | null; B: number | null };
  dte: { A: number; B: number };
  /** The exchange's first prints (bhavcopy OPEN) of the B contract's call and put at strike k. */
  bhavOpen: (k: number, t: OptType) => number | null;
}

const toCandles = (day: string, bars: readonly MinuteBar[]): Candle[] => bars.map((b) => ({ t: istAt(day, b.m), o: b.o, h: b.h, l: b.l, c: b.c, v: 0 }));

/** The index's last known level when an order goes in at minute m: the 09:15 open for a 09:15 order, else the close of the bar before m. */
function levelAt(d: Day, m: number): number | null {
  if (m <= OPEN_MIN) return d.open;
  return d.idx.lastUpTo(m - 1)?.c ?? null;
}

function pnlOf(d: Day, conv: "A" | "B", res: PositionResult, side: string): Trade {
  const lot = d.lot[conv]!;
  const legs: LegSpec[] = res.legs.map((l) => ({ side: l.side, entry: l.entry, exit: l.exit, settled: false }));
  const p = structurePnl(legs, { lot, exchange: d.exchange, entryDate: d.day, exitDate: d.day, spread: () => 0 });
  const longPrem = res.legs.filter((l) => l.side === "long").reduce((a, l) => a + l.entry * lot, 0);
  const shorts = res.legs.some((l) => l.side === "short");
  return {
    day: d.day,
    net: p.net,
    gross: p.gross,
    charges: p.charges,
    premium: shorts ? p.premium : longPrem,
    entryMin: res.entryMin,
    exitMin: res.exitMin,
    reason: res.exitReason,
    side,
    dte: d.dte[conv],
    stale: res.legs.filter((l) => l.staleExit).length,
  };
}

type Outcome = { trade: Trade } | { skip: string };

const leg = (chain: ChainDay, k: number, t: OptType, side: "short" | "long"): PositionLeg | null => {
  const s = chain.series.get(key(k, t));
  return s ? { series: s, side } : null;
};

interface SellSpec {
  conv: "A" | "B";
  /** 0 for the straddle, else the wings' distance in daily expected moves. */
  wings: number;
  entry: number;
  exit: number;
  stop: number | null;
  mode: FillMode;
}

/** C4/C5: a short ATM straddle (or iron fly) entered at a clock time and bought back at a clock time. */
function sellOne(d: Day, s: SellSpec): Outcome {
  const chain = d.chain[s.conv];
  if (!chain || d.lot[s.conv] === null) return { skip: "no contract" };
  const level = levelAt(d, s.entry);
  if (level === null) return { skip: "no index level" };
  const k = nearestListed(bothListed(chain), level);
  if (k === null) return { skip: "no ATM strike" };
  const c = leg(chain, k, "CE", "short");
  const p = leg(chain, k, "PE", "short");
  if (!c || !p) return { skip: "no ATM strike" };
  let legs: PositionLeg[] = [c, p];
  let entryMin = s.entry;
  let entryWait = ENTRY_WAIT;
  if (s.wings > 0) {
    if (d.vixPrev === null) return { skip: "no VIX" };
    const em = expectedMove(level, d.vixPrev);
    const kc = strikeBeyond(chain.strikes.CE, k, k + s.wings * em, "above");
    const kp = strikeBeyond(chain.strikes.PE, k, k - s.wings * em, "below");
    if (kc === null || kp === null) return { skip: "no wing strike" };
    const wc = leg(chain, kc, "CE", "long")!;
    const wp = leg(chain, kp, "PE", "long")!;
    legs = [c, p, wc, wp];
    // Sync check: the first minute within the entry window in which all four legs traded.
    let t: number | null = null;
    for (let m = s.entry; m <= s.entry + ENTRY_WAIT; m++) {
      if (legs.every((l) => l.series.at(m))) {
        t = m;
        break;
      }
    }
    if (t === null) return { skip: "legs not synchronous" };
    const at = (l: PositionLeg) => l.series.at(t)!.c;
    if (flyNoArbitrage({ k, kc, kp, c: at(c), p: at(p), wc: at(wc), wp: at(wp) }) !== "ok") return { skip: "no-arbitrage check" };
    entryMin = t;
    entryWait = 0;
  }
  const res = runPosition({ legs, entryMin, entryWait, exitMin: s.exit, exitWait: EXIT_WAIT, stopFrac: s.stop, mode: s.mode });
  if (!res) return { skip: "no bar in the entry window" };
  return { trade: pnlOf(d, s.conv, res, s.wings > 0 ? `fly${s.wings}` : "straddle") };
}

interface BuySpec {
  side: Side;
  level: number;
  entry: number;
  exit: number;
  reason: "time" | "rule";
  itm: number;
  stop: number;
  mode: FillMode;
}

/** A long ATM (or ITM) call for BULL / put for BEAR on the B contract. */
function buyOne(d: Day, b: BuySpec): Outcome {
  const chain = d.chain.B;
  if (!chain || d.lot.B === null) return { skip: "no contract" };
  const type: OptType = b.side === "BULL" ? "CE" : "PE";
  const atm = nearestListed(bothListed(chain), b.level);
  if (atm === null) return { skip: "no ATM strike" };
  const k = itmStrike(chain.strikes[type], atm, type, b.itm);
  if (k === null) return { skip: "no ITM strike" };
  const l = leg(chain, k, type, "long")!;
  const res = runPosition({ legs: [l], entryMin: b.entry, entryWait: ENTRY_WAIT, exitMin: b.exit, exitWait: EXIT_WAIT, exitReason: b.reason, stopFrac: b.stop, mode: b.mode });
  if (!res) return { skip: "no bar in the entry window" };
  return { trade: pnlOf(d, "B", res, b.side) };
}

/** End minute (IST) of a bar starting at t (epoch ms) of length barMin. */
const endMinOf = (c: Candle, barMin: number) => istMinuteOfDay(c.t) + barMin;

// ---- C1: first 15-minute candle -------------------------------------------------------------

interface FcParams {
  rangeMin: number;
  minBodyPct: number;
  stop: number;
  exit: number;
  barMin: number;
}

function firstCandleSignal(d: Day, p: FcParams): { side: Side; level: number; entry: number } | null {
  const bars = p.barMin === 5 ? d.bars5 : toCandles(d.day, aggregate(d.idx.bars, p.barMin));
  const plan = firstCandlePlan(bars, istAt(d.day, OPEN_MIN), { rangeMin: p.rangeMin, minBodyPct: p.minBodyPct, windowStartMin: WINDOW_START }, p.barMin * MINUTE_MS);
  if (!plan.side || plan.entryBarT === null || plan.entryLevel === null) return null;
  const bar = bars.find((b) => b.t === plan.entryBarT)!;
  return { side: plan.side, level: plan.entryLevel, entry: endMinOf(bar, p.barMin) + 1 };
}

// ---- C2: noise area ---------------------------------------------------------------------------

interface NaParams {
  lookback: number;
  band: number;
  itm: number;
  stop: number;
}

interface NaDecision {
  endMin: number;
  level: number;
  entry: Side | null;
  exitBull: boolean;
  exitBear: boolean;
}

function naDecisions(d: Day, history: SessionBars[], p: NaParams): NaDecision[] | null {
  if (d.prevClose === null) return null;
  const params: NoiseAreaParams = { lookbackSessions: p.lookback, bandMult: p.band, decisionEveryMin: 30, anchorMin: 0, stop: "OPPOSITE_BAND", sizing: "ENGINE", volTargetPct: 2, maxLeverage: 4 };
  const today: SessionBars = { date: d.day, open: d.open, bars: d.bars5 };
  const out: NaDecision[] = [];
  for (let i = 0; i < d.bars5.length; i++) {
    const end = endMinOf(d.bars5[i], 5);
    if (end > hhmmToMin("15:00")) break;
    const sig = noiseAreaDecision(today, history, d.prevClose, params, 5 * MINUTE_MS, i);
    if (!sig) continue;
    out.push({ endMin: end, level: sig.level ?? d.bars5[i].c, entry: sig.entry, exitBull: sig.exitBull !== null, exitBear: sig.exitBear !== null });
  }
  return out;
}

/** The first decision after index `from` that closes `side`, or null (held to the square-off). */
function naExitAfter(ds: readonly NaDecision[], from: number, side: Side): number | null {
  for (let j = from + 1; j < ds.length; j++) if (side === "BULL" ? ds[j].exitBull : ds[j].exitBear) return j;
  return null;
}

/** The base model's trades for one day: entries at band breaks, exit and reverse at crossovers, 15:05 square-off, premium stop with a 30-minute cooldown, at most 8 entries. */
function naTrades(d: Day, ds: readonly NaDecision[], p: NaParams, mode: FillMode, skips: Record<string, number>): { trade: Trade; decision: number }[] {
  const out: { trade: Trade; decision: number }[] = [];
  let cooldownUntil = -1;
  let entries = 0;
  let i = 0;
  while (i < ds.length) {
    const dec = ds[i];
    const fill = dec.endMin + 1;
    if (!dec.entry || dec.endMin > LAST_ENTRY_DECISION || fill < cooldownUntil || entries >= 8) {
      i++;
      continue;
    }
    const side = dec.entry;
    const j = naExitAfter(ds, i, side);
    const exit = j === null ? SQUARE_OFF : Math.min(ds[j].endMin + 1, SQUARE_OFF);
    const o = buyOne(d, { side, level: dec.level, entry: fill, exit, reason: j === null ? "time" : "rule", itm: p.itm, stop: p.stop, mode });
    entries++;
    if ("skip" in o) {
      // No fill: the signal is retried at the next decision.
      skips[o.skip] = (skips[o.skip] ?? 0) + 1;
      i++;
      continue;
    }
    out.push({ trade: o.trade, decision: i });
    if (o.trade.reason === "stop") {
      cooldownUntil = o.trade.exitMin + 30;
      while (i < ds.length && ds[i].endMin + 1 <= o.trade.exitMin) i++;
      continue;
    }
    if (j === null) break;
    i = j; // the crossover decision: the loop re-enters the opposite side there when the band is broken
  }
  return out;
}

// ---- C3: 5-minute opening-range breakout ------------------------------------------------------

interface OrbParams {
  entry: "PUBLISHED" | "ENGINE_WINDOW";
  rangeMin: number;
  targetR: number;
  itm: number;
  stop: number;
}

function orbSignal(d: Day, p: OrbParams, forceSide?: Side): { side: Side; level: number; entry: number; exit: number; reason: "time" | "rule" } | null {
  const barMin = p.rangeMin === 5 ? 5 : 1;
  const bars = barMin === 5 ? d.bars5 : toCandles(d.day, d.idx.between(OPEN_MIN, 930));
  const plan = orb5Plan(bars, istAt(d.day, OPEN_MIN), { rangeMin: p.rangeMin, targetR: p.targetR, entry: p.entry, windowStartMin: WINDOW_START }, barMin * MINUTE_MS, forceSide);
  if (!plan.side || plan.entryBarT === null || plan.entryLevel === null || plan.stop === null || plan.target === null) return null;
  const entryBar = bars.find((b) => b.t === plan.entryBarT)!;
  const signalEnd = endMinOf(entryBar, barMin);
  // Index stop and target on the closed 5-minute bars that start at or after the signal.
  let exit = SQUARE_OFF;
  let reason: "time" | "rule" = "time";
  for (const b of d.bars5) {
    const start = istMinuteOfDay(b.t);
    if (start < signalEnd) continue;
    const end = start + 5;
    if (end + 1 >= SQUARE_OFF) break;
    const hitStop = plan.side === "BULL" ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTarget = plan.side === "BULL" ? b.h >= plan.target : b.l <= plan.target;
    if (hitStop || hitTarget) {
      exit = end + 1;
      reason = "rule";
      break;
    }
  }
  return { side: plan.side, level: plan.entryLevel, entry: signalEnd + 1, exit, reason };
}

// ---------------------------------------------------------------------------
// Runs, statistics and the bar
// ---------------------------------------------------------------------------

interface Run {
  name: string;
  index: IndexId;
  family: string;
  kind: "strategy" | "placebo" | "perturbation";
  mode: FillMode;
  params: Record<string, unknown>;
  trades: Trade[];
  sessions: string[];
  skips: Record<string, number>;
  /** Placebo trades by session (strategy runs that have a placebo). */
  placebo?: { random?: Map<string, number[]>; sameMoment?: Map<string, number[]> };
}

interface SubStats {
  label: string;
  n: number;
  mean: number;
  lo: number;
  hi: number;
  pf: number;
  net: number;
}

interface Stats {
  n: number;
  sessions: number;
  net: number;
  mean: number;
  meanPct: number;
  hit: number;
  pf: number;
  boot: BlockBootstrap;
  years: { year: string; n: number; net: number; mean: number }[];
  halves: SubStats[];
  /** The dataset's two eras: every trade in the bars to Dec 2024, sampled prices from Jan 2025 (report §2). */
  eras: SubStats[];
  sr: number;
  sessionNet: number[];
  tail: { worstDay: number; worstDayDate: string; worst20Days: number; worst20Run: number; maxDD: number; worst5Share: number; worst5Sum: number };
  charges: number;
  premium: number;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);

function sessionsOf(trades: readonly Trade[], days: readonly string[]): SessionPnl[] {
  const by = new Map<string, number[]>(days.map((d) => [d, []]));
  for (const t of trades) {
    const l = by.get(t.day);
    if (l) l.push(t.net);
    else by.set(t.day, [t.net]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnls]) => ({ day, pnls }));
}

function statsOf(trades: readonly Trade[], days: readonly string[], cut: string, resamples: number): Stats {
  const nets = trades.map((t) => t.net);
  const sess = sessionsOf(trades, days);
  const boot = dayBlockBootstrap(sess, { resamples, seed: 7 });
  const yearsSet = [...new Set(trades.map((t) => t.day.slice(0, 4)))].sort();
  const years = yearsSet.map((year) => {
    const ts = trades.filter((t) => t.day.startsWith(year));
    return { year, n: ts.length, net: sum(ts.map((t) => t.net)), mean: avg(ts.map((t) => t.net)) };
  });
  const sub = (label: string, f: (d: string) => boolean) => {
    const ts = trades.filter((t) => f(t.day));
    const b = dayBlockBootstrap(sessionsOf(ts, days.filter(f)), { resamples: 10_000, seed: 7 });
    return { label, n: ts.length, mean: avg(ts.map((t) => t.net)), lo: b.perTrade.lo, hi: b.perTrade.hi, pf: profitFactor(ts.map((t) => t.net)), net: sum(ts.map((t) => t.net)) };
  };
  const halves = [sub("first 60%", (d) => d <= cut), sub("last 40%", (d) => d > cut)];
  const eras = [sub("complete bars (to Dec 2024)", (d) => d <= ERA_END), sub("sampled bars (from Jan 2025)", (d) => d > ERA_END)];
  const sessionNet = sess.map((s) => sum(s.pnls));
  const rets = sessionNet.map((x) => x / CAPITAL);
  const m = avg(rets);
  const sd = Math.sqrt(sum(rets.map((r) => (r - m) ** 2)) / Math.max(1, rets.length - 1));
  const traded = sess.filter((s) => s.pnls.length > 0).map((s) => sum(s.pnls));
  const worstIdx = sessionNet.reduce((bi, x, i) => (x < sessionNet[bi] ? i : bi), 0);
  const ts = tailShare(traded, 0.05);
  return {
    n: trades.length,
    sessions: days.length,
    net: sum(nets),
    mean: avg(nets),
    meanPct: sum(nets) / Math.max(1e-9, sum(trades.map((t) => t.premium))),
    hit: trades.length ? trades.filter((t) => t.net > 0).length / trades.length : NaN,
    pf: profitFactor(nets),
    boot,
    years,
    halves,
    eras,
    sr: sd > 0 ? m / sd : 0,
    sessionNet,
    tail: {
      worstDay: sessionNet.length ? sessionNet[worstIdx] : NaN,
      worstDayDate: sess[worstIdx]?.day ?? "",
      worst20Days: sum([...traded].sort((a, b) => a - b).slice(0, 20)),
      worst20Run: worstRun(sessionNet, 20).sum,
      maxDD: maxDrawdown(sessionNet).depth,
      worst5Share: ts.multiple,
      worst5Sum: ts.worstSum,
    },
    charges: avg(trades.map((t) => t.charges)),
    premium: avg(trades.map((t) => t.premium)),
  };
}

// ---------------------------------------------------------------------------
// The day loop
// ---------------------------------------------------------------------------

const stopLabel = (s: number | null) => (s === null ? "no stop" : `stop +${Math.round(s * 100)}%`);
const sellName = (sym: IndexId, conv: "A" | "B", wings: number, e: string, x: string, s: number | null, mode: FillMode) =>
  `${sym} ${wings > 0 ? `C5 fly ${wings}EM` : `C4 straddle ${conv}`} ${e}→${x} ${stopLabel(s)} ${mode}`;

/** D1: the B contract's ATM straddle (strike nearest the index open) through the day, ÷ the same straddle at the day's VWAPs − 1. */
const PROFILE_POINTS = ["bhav OPEN (exchange first print)", "09:15 bar open", "09:15 bar low", "09:15 bar close", "09:16", "09:20", "09:30", "10:00", "11:15", "13:00", "15:00", "15:20"] as const;

function openingProfile(d: Day): Record<string, number> | null {
  const chain = d.chain.B;
  if (!chain) return null;
  const k = nearestListed(bothListed(chain), d.open);
  if (k === null) return null;
  const c = chain.series.get(key(k, "CE"))!;
  const p = chain.series.get(key(k, "PE"))!;
  const dayVwap = (s: MinuteSeries) => {
    let pv = 0;
    let v = 0;
    for (const b of s.bars) {
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      v += b.v;
    }
    return v > 0 ? pv / v : NaN;
  };
  const ref = dayVwap(c) + dayVwap(p);
  const c0 = c.at(OPEN_MIN);
  const p0 = p.at(OPEN_MIN);
  if (!(ref > 0) || !c0 || !p0) return null;
  const out: Record<string, number> = {};
  const bo = [d.bhavOpen(k, "CE"), d.bhavOpen(k, "PE")];
  if (bo[0] !== null && bo[1] !== null) out[PROFILE_POINTS[0]] = (bo[0] + bo[1]) / ref - 1;
  out[PROFILE_POINTS[1]] = (c0.o + p0.o) / ref - 1;
  out[PROFILE_POINTS[2]] = (c0.l + p0.l) / ref - 1;
  out[PROFILE_POINTS[3]] = (c0.c + p0.c) / ref - 1;
  for (const hm of PROFILE_POINTS.slice(4)) {
    const m = hhmmToMin(hm);
    const a = c.lastUpTo(m);
    const b = p.lastUpTo(m);
    if (a && b) out[hm] = (a.c + b.c) / ref - 1;
  }
  return out;
}

class Registry {
  readonly runs = new Map<string, Run>();
  /** D1 observations by index and era. */
  readonly profile = new Map<string, Record<string, number>[]>();

  run(name: string, index: IndexId, family: string, kind: Run["kind"], mode: FillMode, params: Record<string, unknown>): Run {
    let r = this.runs.get(name);
    if (!r) this.runs.set(name, (r = { name, index, family, kind, mode, params, trades: [], sessions: [], skips: {} }));
    return r;
  }

  /** Records an evaluation on a session (eligible) and its outcome. */
  record(r: Run, day: string, o: Outcome | null): Trade | null {
    if (r.sessions[r.sessions.length - 1] !== day) r.sessions.push(day);
    if (o === null) return null;
    if ("skip" in o) {
      r.skips[o.skip] = (r.skips[o.skip] ?? 0) + 1;
      return null;
    }
    r.trades.push(o.trade);
    return o.trade;
  }

  placebo(r: Run, which: "random" | "sameMoment", day: string, nets: number[]): void {
    r.placebo ??= {};
    const m = (r.placebo[which] ??= new Map<string, number[]>());
    m.set(day, [...(m.get(day) ?? []), ...nets]);
  }
}

interface Perturbation {
  base: string;
  name: string;
  /** Evaluates the perturbed variant on one day (null when it does not apply that day). */
  evalDay: (d: Day, hist: SessionBars[]) => Outcome[] | null;
}

/** Everything the frozen grid computes for one session. */
function evaluateDay(d: Day, hist: SessionBars[], R: Registry, rnd: () => number): void {
  const sym = d.sym;
  // ---- C4 straddle (conventions A and B) and C5 iron fly (B), with their random-entry-time placebos ----
  const sellStructures: { conv: "A" | "B"; wings: number }[] = [
    { conv: "A", wings: 0 },
    { conv: "B", wings: 0 },
    { conv: "B", wings: 1 },
    { conv: "B", wings: 2 },
  ];
  for (const st of sellStructures) {
    if (!d.chain[st.conv] || d.lot[st.conv] === null) continue;
    const family = st.wings > 0 ? "C5" : "C4";
    for (const x of SELL_EXITS) {
      for (const stop of SELL_STOPS) {
        for (const mode of [...MODES, "print" as const]) {
          const runs: Run[] = [];
          for (const e of SELL_ENTRIES) {
            // The first print exists in the bars only while they hold every trade (to Dec 2024).
            if (mode === "print" && (e !== "09:15" || d.day > ERA_END)) continue;
            const r = R.run(sellName(sym, st.conv, st.wings, e, x, stop, mode), sym, family, "strategy", mode, { family, structure: st.wings > 0 ? "iron fly" : "straddle", conv: st.conv, wingsEM: st.wings, entry: e, exit: x, stopPct: stop, fill: mode, index: sym });
            R.record(r, d.day, sellOne(d, { conv: st.conv, wings: st.wings, entry: hhmmToMin(e), exit: hhmmToMin(x), stop, mode }));
            runs.push(r);
          }
          if (mode === "print") continue;
          // Placebo: the same structure, exit and stop entered at random minutes 09:15..14:00.
          const pr = R.run(`${sym} ${family} placebo ${st.wings > 0 ? `fly ${st.wings}EM` : `straddle ${st.conv}`} random entry→${x} ${stopLabel(stop)} ${mode}`, sym, family, "placebo", mode, { family, placebo: "random entry minute 09:15-14:00", conv: st.conv, wingsEM: st.wings, exit: x, stopPct: stop, fill: mode, draws: PLACEBO_DRAWS, index: sym });
          const nets: number[] = [];
          for (let k = 0; k < PLACEBO_DRAWS; k++) {
            const t = R.record(pr, d.day, sellOne(d, { conv: st.conv, wings: st.wings, entry: drawInt(rnd(), ...SELL_PLACEBO_WINDOW), exit: hhmmToMin(x), stop, mode }));
            if (t) nets.push(t.net);
          }
          for (const r of runs) R.placebo(r, "random", d.day, nets);
        }
      }
    }
  }
  // ---- C6 premium timing: buy the ATM straddle at T, sell 60 minutes later ----
  for (const conv of ["A", "B"] as const) {
    const chain = d.chain[conv];
    if (!chain || d.lot[conv] === null) continue;
    if (conv === "A" && d.dte.A !== 0) continue; // convention A adds only the expiry-day (0 sessions left) rows
    for (const T of TIMING_ENTRIES) {
      const entry = hhmmToMin(T);
      const exit = Math.min(entry + 60, hhmmToMin("15:29"));
      for (const mode of MODES) {
        const r = R.run(`${sym} C6 timing ${conv === "A" ? "expiry day" : "B"} ${T}+60 ${mode}`, sym, "C6", "strategy", mode, { family: "C6", structure: "long straddle", conv, entry: T, holdMin: exit - entry, fill: mode, index: sym });
        const level = levelAt(d, entry);
        const k = level === null ? null : nearestListed(bothListed(chain), level);
        if (k === null) {
          R.record(r, d.day, { skip: "no ATM strike" });
          continue;
        }
        const res = runPosition({ legs: [leg(chain, k, "CE", "long")!, leg(chain, k, "PE", "long")!], entryMin: entry, entryWait: ENTRY_WAIT, exitMin: exit, exitWait: EXIT_WAIT, stopFrac: null, mode });
        R.record(r, d.day, res ? { trade: pnlOf(d, conv, res, "straddle") } : { skip: "no bar in the entry window" });
      }
    }
  }
  if (!d.chain.B || d.lot.B === null) return;
  // ---- D1: the opening straddle through the day (prices only, no trades) ----
  const prof = openingProfile(d);
  if (prof) {
    const tag = `${sym} ${d.day <= ERA_END ? "to Dec 2024" : "from Jan 2025"}`;
    let arr = R.profile.get(tag);
    if (!arr) R.profile.set(tag, (arr = []));
    arr.push(prof);
  }
  // ---- C1 first 15-minute candle (WP9b C5/C6) ----
  for (const exitHm of ["11:15", "15:05"]) {
    const exit = hhmmToMin(exitHm);
    const sig = firstCandleSignal(d, { rangeMin: 15, minBodyPct: 0.24, stop: PREMIUM_STOP, exit, barMin: 5 });
    for (const mode of MODES) {
      const r = R.run(`${sym} C1 first candle →${exitHm} ${mode}`, sym, "C1", "strategy", mode, { family: "C1", rule: "first 15-min candle |body| > 0.24%", entry: "09:31 (candle close 09:30 + 1 min)", exit: exitHm, strike: "ATM", contract: "B", premiumStopPct: -30, fill: mode, index: sym });
      if (!sig) {
        R.record(r, d.day, null);
        continue;
      }
      const t = R.record(r, d.day, buyOne(d, { side: sig.side, level: sig.level, entry: sig.entry, exit, reason: "time", itm: 0, stop: PREMIUM_STOP, mode }));
      if (!t) continue;
      // Same moment, random side: the expectation is the mean of the rule's side and the other side.
      const other = buyOne(d, { side: sig.side === "BULL" ? "BEAR" : "BULL", level: sig.level, entry: sig.entry, exit, reason: "time", itm: 0, stop: PREMIUM_STOP, mode });
      if ("trade" in other) R.placebo(r, "sameMoment", d.day, [(t.net + other.trade.net) / 2]);
      // Random entry minute 09:31..(exit − 30), random side, same exit and stop.
      const nets: number[] = [];
      for (let k = 0; k < PLACEBO_DRAWS; k++) {
        const m = drawInt(rnd(), sig.entry, exit - 30);
        const side: Side = rnd() < 0.5 ? "BULL" : "BEAR";
        const lv = levelAt(d, m);
        if (lv === null) continue;
        const o = buyOne(d, { side, level: lv, entry: m, exit, reason: "time", itm: 0, stop: PREMIUM_STOP, mode });
        if ("trade" in o) nets.push(o.trade.net);
      }
      R.placebo(r, "random", d.day, nets);
    }
  }
  // ---- C2 noise area, base model (WP3), ATM and 1 strike ITM ----
  for (const itm of [0, 1]) {
    const p: NaParams = { lookback: 14, band: 1, itm, stop: PREMIUM_STOP };
    const ds = naDecisions(d, hist, p);
    for (const mode of MODES) {
      const r = R.run(`${sym} C2 noise area ${itm ? "1-ITM" : "ATM"} ${mode}`, sym, "C2", "strategy", mode, { family: "C2", rule: "noise area base model (14 sessions, VM 1, HH:00/HH:30)", strike: itm ? "1 ITM" : "ATM", contract: "B", premiumStopPct: -30, fill: mode, index: sym });
      if (ds === null) continue; // no previous close: not eligible
      const trades = naTrades(d, ds, p, mode, r.skips);
      if (r.sessions[r.sessions.length - 1] !== d.day) r.sessions.push(d.day);
      for (const { trade, decision } of trades) {
        r.trades.push(trade);
        const dec = ds[decision];
        const side = trade.side as Side;
        const opp: Side = side === "BULL" ? "BEAR" : "BULL";
        const j = naExitAfter(ds, decision, opp);
        const o = buyOne(d, { side: opp, level: dec.level, entry: dec.endMin + 1, exit: j === null ? SQUARE_OFF : Math.min(ds[j].endMin + 1, SQUARE_OFF), reason: j === null ? "time" : "rule", itm, stop: PREMIUM_STOP, mode });
        if ("trade" in o) R.placebo(r, "sameMoment", d.day, [(trade.net + o.trade.net) / 2]);
      }
      if (trades.length > 0) {
        const decisions = ds.map((x, i) => i).filter((i) => ds[i].endMin <= LAST_ENTRY_DECISION);
        const nets: number[] = [];
        for (let k = 0; k < PLACEBO_DRAWS && decisions.length > 0; k++) {
          const i = decisions[drawInt(rnd(), 0, decisions.length - 1)];
          const side: Side = rnd() < 0.5 ? "BULL" : "BEAR";
          const j = naExitAfter(ds, i, side);
          const o = buyOne(d, { side, level: ds[i].level, entry: ds[i].endMin + 1, exit: j === null ? SQUARE_OFF : Math.min(ds[j].endMin + 1, SQUARE_OFF), reason: j === null ? "time" : "rule", itm, stop: PREMIUM_STOP, mode });
          if ("trade" in o) nets.push(o.trade.net);
        }
        R.placebo(r, "random", d.day, nets);
      }
    }
  }
  // ---- C3 5-minute opening-range breakout (WP4), published and engine-window entries, ATM and 1 ITM ----
  for (const entry of ["PUBLISHED", "ENGINE_WINDOW"] as const) {
    for (const itm of [0, 1]) {
      const p: OrbParams = { entry, rangeMin: 5, targetR: 10, itm, stop: PREMIUM_STOP };
      const sig = orbSignal(d, p);
      for (const mode of MODES) {
        const r = R.run(`${sym} C3 ORB ${entry === "PUBLISHED" ? "published" : "window"} ${itm ? "1-ITM" : "ATM"} ${mode}`, sym, "C3", "strategy", mode, { family: "C3", rule: "5-min opening-range breakout, stop at the range's far side, 10R target", entry, strike: itm ? "1 ITM" : "ATM", contract: "B", premiumStopPct: -30, fill: mode, index: sym });
        if (!sig) {
          R.record(r, d.day, null);
          continue;
        }
        const t = R.record(r, d.day, buyOne(d, { side: sig.side, level: sig.level, entry: sig.entry, exit: sig.exit, reason: sig.reason, itm, stop: PREMIUM_STOP, mode }));
        if (!t) continue;
        const forced = orbSignal(d, p, sig.side === "BULL" ? "BEAR" : "BULL");
        if (forced) {
          const o = buyOne(d, { side: forced.side, level: forced.level, entry: forced.entry, exit: forced.exit, reason: forced.reason, itm, stop: PREMIUM_STOP, mode });
          if ("trade" in o) R.placebo(r, "sameMoment", d.day, [(t.net + o.trade.net) / 2]);
        }
        const nets: number[] = [];
        for (let k = 0; k < PLACEBO_DRAWS; k++) {
          const m = drawInt(rnd(), sig.entry, hhmmToMin("14:30"));
          const side: Side = rnd() < 0.5 ? "BULL" : "BEAR";
          const lv = levelAt(d, m);
          if (lv === null) continue;
          const o = buyOne(d, { side, level: lv, entry: m, exit: SQUARE_OFF, reason: "time", itm, stop: PREMIUM_STOP, mode });
          if ("trade" in o) nets.push(o.trade.net);
        }
        R.placebo(r, "random", d.day, nets);
      }
    }
  }
}

/** The ±20% perturbation set of a strategy variant (conservative fill), from its name. */
function perturbationsOf(run: Run): Perturbation[] {
  const p = run.params;
  const out: Perturbation[] = [];
  const mode = run.mode;
  if (run.family === "C4" || run.family === "C5") {
    const conv = p.conv as "A" | "B";
    const wings = p.wingsEM as number;
    const e = hhmmToMin(p.entry as string);
    const x = hhmmToMin(p.exit as string);
    const stop = p.stopPct as number | null;
    const one = (name: string, s: Partial<SellSpec>): Perturbation => ({
      base: run.name,
      name: `${run.name} [${name}]`,
      evalDay: (d) => (d.chain[conv] && d.lot[conv] !== null ? [sellOne(d, { conv, wings, entry: e, exit: x, stop, mode, ...s })] : null),
    });
    for (const dist of perturbDistance(e - OPEN_MIN)) out.push(one(`entry ${minToHhmm(OPEN_MIN + dist)}`, { entry: OPEN_MIN + dist }));
    for (const dist of perturbDistance(930 - x, 1)) out.push(one(`exit ${minToHhmm(930 - dist)}`, { exit: 930 - dist }));
    if (stop !== null) for (const f of [0.8, 1.2]) out.push(one(`stop ×${f}`, { stop: stop * f }));
    if (wings > 0) for (const f of [0.8, 1.2]) out.push(one(`wings ×${f}`, { wings: wings * f }));
    return out;
  }
  if (run.family === "C1") {
    const exit = hhmmToMin(p.exit as string);
    const fc = (name: string, q: Partial<FcParams>): Perturbation => ({
      base: run.name,
      name: `${run.name} [${name}]`,
      evalDay: (d) => {
        if (!d.chain.B || d.lot.B === null) return null;
        const fp: FcParams = { rangeMin: 15, minBodyPct: 0.24, stop: PREMIUM_STOP, exit, barMin: 5, ...q };
        const sig = firstCandleSignal(d, fp);
        return sig ? [buyOne(d, { side: sig.side, level: sig.level, entry: sig.entry, exit, reason: "time", itm: 0, stop: fp.stop, mode })] : [];
      },
    });
    return [fc("body ×0.8", { minBodyPct: 0.192 }), fc("body ×1.2", { minBodyPct: 0.288 }), fc("candle 12 min", { rangeMin: 12, barMin: 3 }), fc("candle 18 min", { rangeMin: 18, barMin: 3 }), fc("stop ×0.8", { stop: 0.24 }), fc("stop ×1.2", { stop: 0.36 })];
  }
  if (run.family === "C2") {
    const itm = p.strike === "1 ITM" ? 1 : 0;
    const na = (name: string, q: Partial<NaParams>): Perturbation => ({
      base: run.name,
      name: `${run.name} [${name}]`,
      evalDay: (d, hist) => {
        if (!d.chain.B || d.lot.B === null) return null;
        const np: NaParams = { lookback: 14, band: 1, itm, stop: PREMIUM_STOP, ...q };
        const ds = naDecisions(d, hist, np);
        if (ds === null) return null;
        return naTrades(d, ds, np, mode, {}).map((t) => ({ trade: t.trade }));
      },
    });
    return [na("lookback 11", { lookback: 11 }), na("lookback 17", { lookback: 17 }), na("band ×0.8", { band: 0.8 }), na("band ×1.2", { band: 1.2 }), na("stop ×0.8", { stop: 0.24 }), na("stop ×1.2", { stop: 0.36 })];
  }
  if (run.family === "C3") {
    const itm = p.strike === "1 ITM" ? 1 : 0;
    const entry = p.entry as OrbParams["entry"];
    const orb = (name: string, q: Partial<OrbParams>): Perturbation => ({
      base: run.name,
      name: `${run.name} [${name}]`,
      evalDay: (d) => {
        if (!d.chain.B || d.lot.B === null) return null;
        const op: OrbParams = { entry, rangeMin: 5, targetR: 10, itm, stop: PREMIUM_STOP, ...q };
        const sig = orbSignal(d, op);
        return sig ? [buyOne(d, { side: sig.side, level: sig.level, entry: sig.entry, exit: sig.exit, reason: sig.reason, itm, stop: op.stop, mode })] : [];
      },
    });
    return [orb("target 8R", { targetR: 8 }), orb("target 12R", { targetR: 12 }), orb("range 4 min", { rangeMin: 4 }), orb("range 6 min", { rangeMin: 6 }), orb("stop ×0.8", { stop: 0.24 }), orb("stop ×1.2", { stop: 0.36 })];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading the sessions of one index
// ---------------------------------------------------------------------------

interface IndexData {
  sym: IndexId;
  days: string[];
  build: (day: string) => Day;
  sessionBars: (day: string) => SessionBars;
}

function indexData(data: ResearchData, x: string, man: Manifest[string], idxDef: ResearchIndex): IndexData {
  const sym = idxDef.id;
  const index = loadIndex(x, sym);
  const bookDays = new Set(data.book.dates(sym));
  const ydaily = data.daily.get(idxDef.yahoo)!;
  const ydays = [...ydaily.keys()].sort();
  const days = man.sessions.filter((day) => {
    const bars = index.get(day) ?? [];
    const session = bars.filter((b) => b.m >= OPEN_MIN && b.m < 930);
    return bookDays.has(day) && !data.special.has(day) && session.length >= MIN_INDEX_BARS && session[0]?.m === OPEN_MIN;
  });
  const cache = new Map<string, SessionBars>();
  const sessionBars = (day: string): SessionBars => {
    let s = cache.get(day);
    if (!s) {
      const bars = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m < 930);
      s = { date: day, open: bars[0]?.m === OPEN_MIN ? bars[0].o : null, bars: toCandles(day, aggregate(bars, 5)) };
      cache.set(day, s);
    }
    return s;
  };
  const build = (day: string): Day => {
    const bars = (index.get(day) ?? []).filter((b) => b.m >= OPEN_MIN && b.m <= 930);
    const sb = sessionBars(day);
    const chainOf = (conv: "A" | "B"): ChainDay | null => {
      const e = bhavExpiry(data, sym, day, conv);
      if (!e) return null;
      const info = man.pairs[`${day}_${e}`];
      return info ? loadChainDay(x, sym, day, e, info.role) : null;
    };
    const A = chainOf("A");
    const B = A && A.expiry > day ? A : chainOf("B");
    let pi = ydays.findIndex((d) => d >= day) - 1;
    if (pi < 0) pi = ydays[ydays.length - 1] < day ? ydays.length - 1 : -1;
    const prev = pi >= 0 ? ydaily.get(ydays[pi]) : undefined;
    return {
      sym,
      day,
      exchange: idxDef.exchange,
      idx: new MinuteSeries(bars),
      bars5: sb.bars,
      open: bars[0].o,
      prevClose: prev && prev.c > 0 ? prev.c : null,
      vixPrev: vixBefore(data, day),
      chain: { A, B },
      lot: { A: A ? lotOf(data, sym, day, A.expiry) : null, B: B ? lotOf(data, sym, day, B.expiry) : null },
      dte: { A: A ? data.book.sessionsToExpiry("NIFTY", day, A.expiry) : NaN, B: B ? data.book.sessionsToExpiry("NIFTY", day, B.expiry) : NaN },
      bhavOpen: (k, t) => {
        const r = B ? data.book.option(sym, day, B.expiry, k, t) : undefined;
        return r && r.contracts > 0 && r.open !== null && r.open > 0 ? r.open : null;
      },
    };
  };
  return { sym, days, build, sessionBars };
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

type Verdict = "PASS" | "FAIL" | "INSUFFICIENT" | "N/A" | "NOT RUN";

interface Criterion {
  name: string;
  verdict: Verdict;
  detail: string;
}

interface Judged {
  run: Run;
  stats: Stats;
  gaps: { random: ReturnType<typeof pairedGap> | null; sameMoment: ReturnType<typeof pairedGap> | null };
  perts: { name: string; n: number; net: number }[] | null;
  criteria: Criterion[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT";
  p: number;
  dsr: number;
  dsrNull: number;
  /** Fails at the conservative fill, but its bar-close twin meets every criterion that was run for it. */
  midOnly: boolean;
}

function placeboGap(run: Run, which: "random" | "sameMoment"): ReturnType<typeof pairedGap> | null {
  const m = run.placebo?.[which];
  if (!m) return null;
  const by = new Map<string, number[]>();
  for (const t of run.trades) by.set(t.day, [...(by.get(t.day) ?? []), t.net]);
  const days = [...by].map(([day, nets]) => ({ n: nets.length, s: avg(nets), p: avg(m.get(day) ?? []) }));
  return pairedGap(days);
}

/** Criteria 1, 3, 4, 5 (the ones that decide whether the perturbations are worth running). */
function passesCore(s: Stats): boolean {
  const yrs = s.years.filter((y) => y.n >= 20);
  return s.n >= 180 && s.boot.perTrade.lo > 0 && s.boot.perSession.lo > 0 && s.pf >= 1.3 && yrs.length > 0 && yrs.every((y) => y.net > 0);
}

function judge(run: Run, s: Stats, perts: { name: string; n: number; net: number }[] | null, ledgerN: number, srVar: number | null): Judged {
  const c: Criterion[] = [];
  c.push({ name: "≥ 180 trades", verdict: s.n >= 180 ? "PASS" : "INSUFFICIENT", detail: `${s.n}` });
  const gaps = { random: placeboGap(run, "random"), sameMoment: placeboGap(run, "sameMoment") };
  const gapTxt = (g: ReturnType<typeof pairedGap> | null, label: string) => (g ? `${label} ${rs(g.gap)}/trade, ${fx(g.t)} SE (${g.sessions} sessions)` : "");
  if (!gaps.random && !gaps.sameMoment) c.push({ name: "placebo gap ≥ 2 SE", verdict: "N/A", detail: "no placebo for this variant" });
  else {
    const ok = [gaps.random, gaps.sameMoment].filter((g) => g !== null).every((g) => g!.t >= 2);
    c.push({ name: "placebo gap ≥ 2 SE", verdict: ok ? "PASS" : "FAIL", detail: [gapTxt(gaps.random, "random entry time"), gapTxt(gaps.sameMoment, "same moment, random side")].filter(Boolean).join("; ") });
  }
  const ciOk = s.boot.perTrade.lo > 0 && s.boot.perSession.lo > 0;
  c.push({ name: "95% CI > 0 per trade and per session", verdict: ciOk ? "PASS" : "FAIL", detail: `per trade ${rs(s.boot.perTrade.lo)} … ${rs(s.boot.perTrade.hi)}; per session ${rs(s.boot.perSession.lo)} … ${rs(s.boot.perSession.hi)} (${s.boot.resamples.toLocaleString("en-IN")} resamples)` });
  c.push({ name: "PF ≥ 1.3", verdict: s.pf >= 1.3 ? "PASS" : "FAIL", detail: fx(s.pf) });
  const yrs = s.years.filter((y) => y.n >= 20);
  const bad = yrs.filter((y) => !(y.net > 0));
  c.push({ name: "net > 0 in every year (≥ 20 trades)", verdict: yrs.length > 0 && bad.length === 0 ? "PASS" : "FAIL", detail: bad.length ? `negative: ${bad.map((y) => `${y.year} ${rs(y.net)}`).join(", ")}` : `${yrs.length} years positive` });
  if (perts === null) c.push({ name: "±20% robustness", verdict: "NOT RUN", detail: "run only for variants that pass trades, CI, PF and every year" });
  else {
    const pos = perts.filter((p) => p.net > 0).length;
    const worst = perts.reduce<{ name: string; net: number } | null>((m, p) => (m === null || p.net < m.net ? p : m), null);
    const ok = perts.length > 0 && pos / perts.length >= 0.8 && (worst === null || worst.net >= s.net - 0.5 * Math.abs(s.net));
    c.push({ name: "±20% robustness", verdict: ok ? "PASS" : "FAIL", detail: `${pos}/${perts.length} positive; worst ${worst ? `${worst.name.replace(`${run.name} `, "")} ${rs(worst.net)}` : "–"} vs base ${rs(s.net)}` });
  }
  const p = Math.max(s.boot.perTrade.p, s.boot.perSession.p);
  const rets = s.sessionNet.map((x) => x / CAPITAL);
  const dsr = deflatedSharpe(rets, ledgerN, srVar);
  const dsrNull = deflatedSharpe(rets, ledgerN, null);
  const alpha = 0.05 / ledgerN;
  c.push({ name: "Bonferroni and deflated Sharpe", verdict: p < alpha && dsr.dsr >= 0.95 ? "PASS" : "FAIL", detail: `p ${p.toExponential(1)} vs 0.05/${ledgerN} = ${alpha.toExponential(1)}; DSR ${fx(dsr.dsr, 3)} (SR ${fx(dsr.sr, 3)}/session, SR₀ ${fx(dsr.sr0, 3)}); with V = 1/(T−1): DSR ${fx(dsrNull.dsr, 3)}` });
  const oos = s.halves[1];
  c.push({ name: "out of sample (last 40%): mean > 0, CI > 0, PF ≥ 1.3", verdict: oos.n > 0 && oos.lo > 0 && oos.pf >= 1.3 ? "PASS" : "FAIL", detail: `${oos.n} trades, ${rs(oos.mean)}/trade (${rs(oos.lo)} … ${rs(oos.hi)}), PF ${fx(oos.pf)}` });
  const e1 = s.eras[0];
  c.push({ name: "complete-bar era (to Dec 2024): mean > 0, CI > 0", verdict: e1.n > 0 && e1.lo > 0 ? "PASS" : "FAIL", detail: `${e1.n} trades, ${rs(e1.mean)}/trade (${rs(e1.lo)} … ${rs(e1.hi)}), PF ${fx(e1.pf)}; sampled era: ${s.eras[1].n} trades, ${rs(s.eras[1].mean)}/trade (${rs(s.eras[1].lo)} … ${rs(s.eras[1].hi)})` });
  const vs = c.map((x) => x.verdict);
  const verdict = vs.includes("FAIL") ? "FAIL" : vs.includes("INSUFFICIENT") || vs.includes("NOT RUN") ? (vs.includes("NOT RUN") ? "FAIL" : "INSUFFICIENT") : "PASS";
  return { run, stats: s, gaps, perts, criteria: c, verdict, p, dsr: dsr.dsr, dsrNull: dsrNull.dsr, midOnly: false };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER = resolve(ROOT, "reports/trials.jsonl");
const DATA_TAG = "TradeMarkk 1-minute NIFTY/SENSEX options and index (HF thetrademarkk/india-index-options-1m @0f4800e4, CC-BY-NC-4.0), NIFTY 2021-05..2026-07, SENSEX 2023-08..2026-07; lots from the bhavcopy cache";

function trialOf(run: Run, s: { n: number; net: number; mean: number; sessions: number; sr: number; pf: number; lo?: number; hi?: number }): TrialRecord {
  return {
    ts: new Date().toISOString(),
    wp: "WP11",
    variant: run.name,
    params: run.params,
    data: DATA_TAG,
    trades: s.n,
    net: Math.round(s.net * 100) / 100,
    notes: `${run.family} ${run.kind}; ${run.mode} fills (sell at the 1-min low / buy at the high, or the close); ₹/lot per trade ${fx(s.mean)}, PF ${fx(s.pf)}${s.lo !== undefined ? `, day-block 95% CI ${fx(s.lo)}..${fx(s.hi!)}` : ""}; one lot at the lot in force; dated charges`,
    kind: run.kind,
    account: "main",
    sessions: s.sessions,
    meanPerTrade: Math.round(s.mean * 100) / 100,
    srSession: Math.round(s.sr * 1e6) / 1e6,
  };
}

/** Plain statistics for a placebo or perturbation run (no bootstrap). */
function quickStats(trades: readonly Trade[], days: readonly string[]): { n: number; net: number; mean: number; sessions: number; sr: number; pf: number } {
  const nets = trades.map((t) => t.net);
  const sess = sessionsOf(trades, days).map((s) => sum(s.pnls) / CAPITAL);
  const m = avg(sess);
  const sd = Math.sqrt(sum(sess.map((r) => (r - m) ** 2)) / Math.max(1, sess.length - 1));
  return { n: trades.length, net: sum(nets), mean: avg(nets), sessions: days.length, sr: sd > 0 ? m / sd : 0, pf: profitFactor(nets) };
}

// ---------------------------------------------------------------------------
// Report tables
// ---------------------------------------------------------------------------

const HEAD = ["variant", "trades", "₹/trade", "95% CI ₹/trade", "% of premium", "hit", "PF", "years +", "first 60% ₹/trade (PF)", "last 40% ₹/trade [CI] (PF)", "to Dec 2024 / from 2025 ₹/trade", "placebo gap (SE)", "verdict"];

function row(j: Judged, prefix: string): (string | number)[] {
  const s = j.stats;
  const yrs = s.years.filter((y) => y.n >= 20);
  const g = [j.gaps.random, j.gaps.sameMoment].filter((x) => x !== null).map((x) => `${rs(x!.gap)} (${fx(x!.t, 1)})`).join(" / ") || "–";
  return [
    j.run.name.replace(prefix, ""),
    s.n,
    rs(s.mean),
    `${rs(s.boot.perTrade.lo)} … ${rs(s.boot.perTrade.hi)}`,
    pct(s.meanPct),
    pct(s.hit, 0),
    fx(s.pf),
    `${yrs.filter((y) => y.net > 0).length}/${yrs.length}`,
    `${rs(s.halves[0].mean)} (${fx(s.halves[0].pf)})`,
    `${rs(s.halves[1].mean)} [${rs(s.halves[1].lo)} … ${rs(s.halves[1].hi)}] (${fx(s.halves[1].pf)})`,
    `${rs(s.eras[0].mean)} / ${rs(s.eras[1].mean)}`,
    g,
    j.midOnly ? "MID ONLY" : j.verdict,
  ];
}

const TAIL_HEAD = ["variant", "trades", "net ₹ total", "worst day (date)", "20 worst days", "worst 20-session run", "max drawdown (% of ₹5 lakh)", "worst 5% of days ÷ total net", "charges ₹/trade", "premium ₹/trade"];

function tailRow(j: Judged, prefix: string): (string | number)[] {
  const s = j.stats;
  return [
    j.run.name.replace(prefix, ""),
    s.n,
    rs(s.net),
    `${rs(s.tail.worstDay)} (${s.tail.worstDayDate})`,
    rs(s.tail.worst20Days),
    rs(s.tail.worst20Run),
    `${rs(s.tail.maxDD)} (${pct(s.tail.maxDD / CAPITAL)})`,
    `${rs(s.tail.worst5Sum)} = ${fx(s.tail.worst5Share)}×`,
    rs(s.charges),
    rs(s.premium),
  ];
}

function yearRows(j: Judged): string {
  return md([["year", "trades", "net ₹", "₹/trade"], ...j.stats.years.map((y) => [y.year, y.n, rs(y.net), rs(y.mean)])]);
}

function timingTable(R: Registry, sym: IndexId, mode: Mode): string {
  const buckets: [string, (t: Trade) => boolean, string][] = [
    ["0 (expiry day)", () => true, "expiry day"],
    ["1", (t) => t.dte === 1, "B"],
    ["2–5", (t) => t.dte >= 2 && t.dte <= 5, "B"],
    ["6+", (t) => t.dte >= 6, "B"],
    ["all B (≥ 1)", () => true, "B"],
  ];
  const head = ["buy at", ...buckets.map(([b]) => `DTE ${b}: net ₹/lot (gross % of premium) n`)];
  const rows: (string | number)[][] = [head];
  for (const T of TIMING_ENTRIES) {
    const cells: (string | number)[] = [T];
    for (const [, f, conv] of buckets) {
      const run = R.runs.get(`${sym} C6 timing ${conv} ${T}+60 ${mode}`);
      const ts = (run?.trades ?? []).filter(f);
      if (!ts.length) {
        cells.push("–");
        continue;
      }
      const gross = sum(ts.map((t) => t.gross)) / sum(ts.map((t) => t.premium));
      cells.push(`${rs(avg(ts.map((t) => t.net)))} (${pct(gross)}) ${ts.length}`);
    }
    rows.push(cells);
  }
  return md(rows);
}

// ---------------------------------------------------------------------------
// run: everything
// ---------------------------------------------------------------------------

async function runAll(args: ReturnType<typeof parseArgs>): Promise<void> {
  const x = str(args, "x") ?? fail("--x <extract dir> is required");
  const dir = str(args, "dir") ?? fail("--dir <bhavcopy cache> is required");
  const outDir = resolve(ROOT, str(args, "out", "reports/wp11")!);
  const final = num(args, "bootstrap", BOOT_FINAL);
  const only = str(args, "only");
  const t0 = Date.now();
  const manifest = loadManifest(x);
  const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir });
  console.log(`Loaded ${data.loaded.NSE.length} NSE and ${data.loaded.BSE.length} BSE bhavcopies in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
  const R = new Registry();
  const indexes = new Map<IndexId, IndexData>();
  const cut = new Map<IndexId, string>();
  for (const idxDef of RESEARCH_INDICES) {
    if (only && only !== idxDef.id) continue;
    const I = indexData(data, x, manifest[idxDef.id], idxDef);
    indexes.set(idxDef.id, I);
    const rnd = seededRandom(idxDef.id === "NIFTY" ? 101 : 103);
    const hist: SessionBars[] = [];
    let i = 0;
    for (const day of I.days) {
      evaluateDay(I.build(day), hist.slice(-20), R, rnd);
      hist.push(I.sessionBars(day));
      if (hist.length > 25) hist.shift();
      if (++i % 100 === 0) console.log(`  ${idxDef.id}: ${i}/${I.days.length} sessions (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    const ref = R.runs.get(`${idxDef.id} C4 straddle B 09:15→15:20 no stop conservative`);
    const split = walkForwardSplit(ref?.sessions ?? I.days);
    cut.set(idxDef.id, split.train[split.train.length - 1]);
    console.log(`${idxDef.id}: ${I.days.length} sessions; B-contract sample ${ref?.sessions.length ?? 0} (${ref?.sessions[0]} … ${ref?.sessions.at(-1)}); walk-forward cut after ${cut.get(idxDef.id)}`);
  }

  // Statistics of every strategy run; a 100,000-resample bootstrap where the 20,000 one has both lower bounds above zero.
  const stats = new Map<string, Stats>();
  for (const r of R.runs.values()) {
    if (r.kind !== "strategy") continue;
    let s = statsOf(r.trades, r.sessions, cut.get(r.index)!, BOOT_FIRST);
    if (s.boot.perTrade.lo > 0 && s.boot.perSession.lo > 0) s = statsOf(r.trades, r.sessions, cut.get(r.index)!, final);
    stats.set(r.name, s);
  }
  console.log(`Statistics of ${stats.size} strategy runs (${((Date.now() - t0) / 1000).toFixed(0)} s).`);

  // ±20% perturbations, only for conservative-fill variants that pass trades, CI, PF and every year (a second pass over the data).
  const needPerts = [...R.runs.values()].filter((r) => r.kind === "strategy" && r.family !== "C6" && r.mode === "conservative" && passesCore(stats.get(r.name)!));
  const pertRuns = new Map<string, Run>();
  if (needPerts.length > 0) {
    console.log(`Perturbing ${needPerts.length} variant(s): ${needPerts.map((r) => r.name).join("; ")}`);
    const list = needPerts.flatMap((r) => perturbationsOf(r).map((p) => ({ p, base: r })));
    for (const [sym, I] of indexes) {
      const mine = list.filter((z) => z.base.index === sym);
      if (!mine.length) continue;
      const hist: SessionBars[] = [];
      for (const day of I.days) {
        const d = I.build(day);
        for (const { p, base } of mine) {
          const pr = pertRuns.get(p.name) ?? { name: p.name, index: sym, family: base.family, kind: "perturbation" as const, mode: base.mode, params: { ...base.params, perturbation: p.name.slice(base.name.length + 1) }, trades: [], sessions: [], skips: {} };
          pertRuns.set(p.name, pr);
          const outs = p.evalDay(d, hist.slice(-20));
          if (outs === null) continue;
          pr.sessions.push(day);
          for (const o of outs) if ("trade" in o) pr.trades.push(o.trade);
        }
        hist.push(I.sessionBars(day));
        if (hist.length > 25) hist.shift();
      }
    }
  }

  // Ledger: one line per run (strategy, placebo, perturbation) not yet logged; N and V[SR] after the append.
  const lines: TrialRecord[] = [];
  for (const r of R.runs.values()) {
    if (r.kind === "strategy") {
      const s = stats.get(r.name)!;
      lines.push(trialOf(r, { n: s.n, net: s.net, mean: s.mean, sessions: s.sessions, sr: s.sr, pf: s.pf, lo: s.boot.perTrade.lo, hi: s.boot.perTrade.hi }));
    } else lines.push(trialOf(r, quickStats(r.trades, r.sessions)));
  }
  for (const r of pertRuns.values()) lines.push(trialOf(r, quickStats(r.trades, r.sessions)));
  // The buyers' placebos live inside their strategy runs: one ledger line per placebo kind.
  for (const r of R.runs.values()) {
    for (const which of ["random", "sameMoment"] as const) {
      const m = r.placebo?.[which];
      if (!m || r.family === "C4" || r.family === "C5") continue;
      const trades: Trade[] = [...m].flatMap(([day, nets]) => nets.map((net) => ({ day, net, gross: NaN, charges: NaN, premium: NaN, entryMin: 0, exitMin: 0, reason: "", side: "", dte: NaN, stale: 0 })));
      const pr: Run = { ...r, name: `${r.name} placebo ${which === "random" ? "random entry time" : "same moment, random side"}`, kind: "placebo", params: { ...r.params, placebo: which }, trades, sessions: [...m.keys()] };
      lines.push(trialOf(pr, quickStats(trades, pr.sessions)));
    }
  }
  const existing = parseTrials(readFileSync(LEDGER, "utf8"));
  const ledgerBefore = existing.records.length + existing.invalid;
  const logged = new Set(existing.records.filter((r) => r.wp === "WP11").map((r) => r.variant));
  const fresh = lines.filter((l) => !logged.has(l.variant));
  if (args.ledger === true && fresh.length > 0) appendFileSync(LEDGER, fresh.map(formatTrial).join(""));
  const ledgerN = ledgerBefore + fresh.length;
  const srVar = sharpeVariance(lines.filter((l) => l.kind !== "placebo" && !l.variant.includes(" C6 "))).variance;
  console.log(`Ledger: ${ledgerBefore} lines before, ${fresh.length} new (${args.ledger === true ? "appended" : "NOT appended: no --ledger"}), N = ${ledgerN}; V[SR] of this study's strategy lines ${srVar?.toExponential(2)}.`);

  // Judge every strategy variant.
  const judged: Judged[] = [];
  for (const r of R.runs.values()) {
    if (r.kind !== "strategy") continue;
    const perts = [...pertRuns.values()].filter((p) => p.name.startsWith(`${r.name} [`)).map((p) => ({ name: p.name, n: p.trades.length, net: sum(p.trades.map((t) => t.net)) }));
    judged.push(judge(r, stats.get(r.name)!, needPerts.includes(r) ? perts : null, ledgerN, srVar));
  }
  // "Mid only": a conservative variant that fails while its bar-close twin meets every criterion that was run for it.
  const byName = new Map(judged.map((j) => [j.run.name, j]));
  for (const j of judged) {
    if (j.run.mode !== "conservative" || j.verdict === "PASS" || j.run.family === "C6") continue;
    const twin = byName.get(j.run.name.replace(/ conservative$/, " mid"));
    if (twin && twin.criteria.every((c) => c.verdict === "PASS" || c.verdict === "N/A" || c.verdict === "NOT RUN")) {
      j.midOnly = true;
    }
  }

  // Tables.
  const sections: string[] = [];
  const summary: Record<string, unknown>[] = [];
  for (const [sym] of indexes) {
    const mine = judged.filter((j) => j.run.index === sym);
    sections.push(`\n## ${sym} (walk-forward cut after ${cut.get(sym)})\n`);
    for (const fam of ["C1", "C2", "C3", "C4", "C5"]) {
      const fj = mine.filter((j) => j.run.family === fam);
      if (!fj.length) continue;
      const pass = fj.filter((j) => j.verdict === "PASS");
      sections.push(`\n### ${sym} ${fam}: ${fj.length} variants, ${pass.length} pass\n\n${md([HEAD, ...fj.map((j) => row(j, `${sym} `))])}\n`);
      if (fam === "C4" || fam === "C5") sections.push(`\n#### ${sym} ${fam}: tails (one lot; ₹5 lakh account)\n\n${md([TAIL_HEAD, ...fj.filter((j) => j.run.mode !== "mid").map((j) => tailRow(j, `${sym} `))])}\n`);
      const skips = new Map<string, number>();
      for (const j of fj) for (const [k, v] of Object.entries(j.run.skips)) skips.set(k, Math.max(skips.get(k) ?? 0, v));
      if (skips.size) sections.push(`Sessions skipped (largest count over the family's variants): ${[...skips].map(([k, v]) => `${k} ${v}`).join("; ")}.\n`);
    }
    // Criterion detail for the best conservative variant of each family (by first-60% mean) and for every pass.
    for (const fam of ["C1", "C2", "C3", "C4", "C5"]) {
      const fj = mine.filter((j) => j.run.family === fam && j.run.mode === "conservative");
      if (!fj.length) continue;
      const best = [...fj].sort((a, b) => b.stats.halves[0].mean - a.stats.halves[0].mean)[0];
      for (const j of new Set([best, ...fj.filter((z) => z.verdict === "PASS")])) {
        sections.push(`\n#### ${j.run.name}${j === best ? " (the family's best conservative variant on the first 60%)" : ""}\n\n${md([["criterion", "verdict", "detail"], ...j.criteria.map((c) => [c.name, c.verdict, c.detail])])}\n\nBy year:\n\n${yearRows(j)}\n`);
      }
    }
    sections.push(`\n### ${sym} C6: premium timing, ATM straddle bought at T and sold 60 minutes later (mid fills: the bar close)\n\n${timingTable(R, sym, "mid")}\n\nConservative fills (buy at the 1-minute high, sell at the low):\n\n${timingTable(R, sym, "conservative")}\n`);
    const prow: (string | number)[][] = [["straddle at", "to Dec 2024: median", "mean", "share > 0", "n", "from Jan 2025: median", "mean", "share > 0", "n"]];
    for (const pt of PROFILE_POINTS) {
      const cells: (string | number)[] = [pt];
      for (const era of ["to Dec 2024", "from Jan 2025"]) {
        const xs = (R.profile.get(`${sym} ${era}`) ?? []).map((o) => o[pt]).filter((v) => v !== undefined && Number.isFinite(v));
        cells.push(xs.length ? pct(median(xs)) : "–", xs.length ? pct(avg(xs)) : "–", xs.length ? pct(xs.filter((v) => v > 0).length / xs.length, 0) : "–", xs.length);
      }
      prow.push(cells);
    }
    sections.push(`\n### ${sym} D1: the B contract's ATM straddle (strike nearest the index open) during the day, ÷ the same straddle at the day's 1-minute VWAPs − 1\n\n${md(prow)}\n`);
  }
  for (const j of judged) {
    summary.push({
      name: j.run.name,
      family: j.run.family,
      index: j.run.index,
      mode: j.run.mode,
      n: j.stats.n,
      mean: j.stats.mean,
      lo: j.stats.boot.perTrade.lo,
      hi: j.stats.boot.perTrade.hi,
      sessLo: j.stats.boot.perSession.lo,
      meanPct: j.stats.meanPct,
      pf: j.stats.pf,
      hit: j.stats.hit,
      halves: j.stats.halves,
      eras: j.stats.eras,
      sr: j.stats.sr,
      net: j.stats.net,
      sessions: j.stats.sessions,
      charges: j.stats.charges,
      premium: j.stats.premium,
      years: j.stats.years,
      tail: j.stats.tail,
      gaps: j.gaps,
      p: j.p,
      dsr: j.dsr,
      dsrNull: j.dsrNull,
      verdict: j.verdict,
      midOnly: j.midOnly,
      criteria: j.criteria,
      skips: j.run.skips,
    });
  }
  mkdirSync(outDir, { recursive: true });
  const head = `# WP11 tables (generated)\n\nLedger: ${ledgerBefore} → ${ledgerN} lines (${fresh.length} new); Bonferroni 0.05/${ledgerN} = ${(0.05 / ledgerN).toExponential(2)}; V[SR] of this study's strategy and perturbation lines ${srVar?.toExponential(2)}.\n`;
  writeFileSync(resolve(outDir, "tables.md"), head + sections.join("\n"));
  writeFileSync(resolve(outDir, "summary.json"), JSON.stringify({ ledgerBefore, ledgerN, srVar, cut: Object.fromEntries(cut), judged: summary, perturbations: [...pertRuns.values()].map((p) => ({ name: p.name, ...quickStats(p.trades, p.sessions) })) }, null, 1));
  console.log(`Wrote ${resolve(outDir, "tables.md")} in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${judged.filter((j) => j.verdict === "PASS").length} variant(s) pass.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const cmd = process.argv[2];
  if (cmd === "verify") return verify(args);
  if (cmd === "run") return runAll(args);
  if (cmd === "debug") {
    // Prints one session's inputs and a few trades in full, to check the fills by hand.
    const x = str(args, "x") ?? fail("--x <extract dir> is required");
    const sym = (str(args, "index") ?? "NIFTY") as IndexId;
    const day = str(args, "day") ?? fail("--day YYYY-MM-DD is required");
    const data = await loadResearchData({ from: addDays(day, -40), to: addDays(day, 10), dir: str(args, "dir") ?? fail("--dir is required") });
    const I = indexData(data, x, loadManifest(x)[sym], RESEARCH_INDICES.find((i) => i.id === sym)!);
    const d = I.build(day);
    const show = (m: number) => `${minToHhmm(m)} idx ${d.idx.at(m)?.o}/${d.idx.at(m)?.h}/${d.idx.at(m)?.l}/${d.idx.at(m)?.c}`;
    console.log(`${sym} ${day}: open ${d.open}, prev close ${d.prevClose}, VIX ${d.vixPrev}, A ${d.chain.A?.expiry} (lot ${d.lot.A}, DTE ${d.dte.A}), B ${d.chain.B?.expiry} (lot ${d.lot.B}, DTE ${d.dte.B})`);
    for (const m of [555, 556, 899, 900, 920]) console.log(`  ${show(m)}`);
    const chain = d.chain.B!;
    const k = nearestListed(bothListed(chain), d.open)!;
    for (const t of ["CE", "PE"] as const) {
      const s = chain.series.get(key(k, t))!;
      for (const m of [555, 556, 900, 920]) {
        const b = s.at(m);
        console.log(`  B ${k}${t} ${minToHhmm(m)}: ${b ? `o ${b.o} h ${b.h} l ${b.l} c ${b.c} v ${b.v}` : "no bar"}`);
      }
      console.log(`  B ${k}${t} bhav OPEN ${d.bhavOpen(k, t)}`);
    }
    for (const mode of ["conservative", "mid", "print"] as const) {
      const o = sellOne(d, { conv: "B", wings: 0, entry: 555, exit: 900, stop: null, mode });
      console.log(`  C4 B 09:15→15:00 ${mode}:`, JSON.stringify(o));
    }
    console.log("  C5 1EM 09:15→15:00 mid:", JSON.stringify(sellOne(d, { conv: "B", wings: 1, entry: 555, exit: 900, stop: null, mode: "mid" })));
    const sig = firstCandleSignal(d, { rangeMin: 15, minBodyPct: 0.24, stop: PREMIUM_STOP, exit: 905, barMin: 5 });
    console.log("  C1 signal:", JSON.stringify(sig), sig ? JSON.stringify(buyOne(d, { ...sig, exit: 905, reason: "time", itm: 0, stop: PREMIUM_STOP, mode: "mid" })) : "");
    console.log("  C3 signal:", JSON.stringify(orbSignal(d, { entry: "PUBLISHED", rangeMin: 5, targetR: 10, itm: 0, stop: PREMIUM_STOP })));
    return;
  }
  if (cmd === "anatomy") {
    const x = str(args, "x") ?? fail("--x <extract dir> is required");
    const data = await loadResearchData({ from: "2021-05-01", to: "2026-07-31", dir: str(args, "dir") ?? fail("--dir is required") });
    const manifest = loadManifest(x);
    let text = "";
    for (const idx of RESEARCH_INDICES) {
      const index = loadIndex(x, idx.id);
      const days = manifest[idx.id].sessions.filter((d) => data.book.dates(idx.id).includes(d));
      text += openAnatomy(data, x, idx.id, manifest[idx.id], index, days);
    }
    console.log(text);
    const outDir = resolve(ROOT, str(args, "out", "reports/wp11")!);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "anatomy.md"), text);
    return;
  }
  fail(`unknown command ${cmd ?? ""}: verify | run`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
