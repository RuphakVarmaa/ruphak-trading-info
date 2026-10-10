/**
 * WP1 before/after: replays a history snapshot with the data-cleaning flags off and on, using the
 * settings of `npm run backtest -- --no-events --prod-limits`, and lists every trade that differs with
 * the feature values and signals behind it. Appends one line per replay to the trials ledger.
 *
 *   npx tsx scripts/wp1-compare.ts --history <snapshot.json> [--from 2026-07-23 --to 2026-10-08]
 *        [--variants cutoff,bodyclip,both] [--out reports/wp1-compare.json] [--md reports/wp1-compare.md]
 *        [--ledger reports/trials.jsonl | --no-ledger]
 *
 * Each differing trade gets a cause from the decisions the two replays actually made: "signal" when the
 * replay without the trade was stopped by a signal gate (conviction, edge, ...) or, for a changed trade,
 * entered under another regime (another time-stop horizon) or exited on another signal; "book" when only
 * book gates stopped it (open positions, the day's entries, a cooldown, a loss cap): a knock-on of an
 * earlier difference, which is named. Signal causes are traced to the sessions whose 15:15-15:25 bars sit
 * in that decision's feature window; sessions from 3 Aug 2026 on are closing-auction sessions.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BacktestParams } from "../src/engine/api-types";
import type { MarketHistory } from "../src/engine/backtest/history";
import { BacktestRun, configForParams, type BacktestOutput } from "../src/engine/backtest/runBacktest";
import { TradingCalendar } from "../src/engine/calendar/calendar";
import { addDays, istAt, istDate, istIso } from "../src/engine/clock";
import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../src/engine/config";
import { istDateOf, istMinuteOfDay } from "../src/engine/market/candles";
import { computeFeatures, setBodyClipListener, type BodyClip } from "../src/engine/market/features";
import { ReplayMarketDataSource, YAHOO_LAG_MS } from "../src/engine/market/replayMarketData";
import type { ReplayDeps } from "../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type IndexId, type MarketFeatures, type PlanDecision, type TradeRecord } from "../src/engine/types";
import { fail, parseArgs, readJson, ROOT, str, writeJson } from "./lib/node";

const AUCTION_START = "2026-08-03";
const CUTOFF = "15:15";
/** Closed 5-minute bars the classic indicators use (features.ts INDICATOR_BARS). */
const INDICATOR_BARS = 120;

interface Variant {
  label: string;
  features: Partial<EngineConfig["features"]>;
  /** Diagnostic: replay data with the genuine (pre-3-Aug) closing bars physically removed, no cleaning flag. */
  stripPreAuction?: boolean;
}

const VARIANTS: Record<string, Variant> = {
  cutoff: { label: `indicator cutoff ${CUTOFF}`, features: { indicatorCutoffIst: CUTOFF } },
  bodyclip: { label: "body clip", features: { bodyClip: true } },
  both: { label: `cutoff ${CUTOFF} + body clip`, features: { indicatorCutoffIst: CUTOFF, bodyClip: true } },
  genuine: { label: "diagnostic: pre-3-Aug closing bars removed (no flag)", features: {}, stripPreAuction: true },
};

const args = parseArgs();
const historyPath = str(args, "history") ?? fail("--history <snapshot.json> is required (saved by npm run backtest -- --save-history).");
const from = str(args, "from", "2026-07-23")!;
const to = str(args, "to", "2026-10-08")!;
const variantNames = (str(args, "variants", "cutoff,bodyclip,both") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (const v of variantNames) if (!VARIANTS[v]) fail(`unknown variant ${v}; use ${Object.keys(VARIANTS).join(", ")}`);
const ledgerPath = args["no-ledger"] === true ? null : str(args, "ledger", "reports/trials.jsonl")!;
const ledgerNote = str(args, "ledger-note", "");

const history = readJson<MarketHistory & { source: string; savedAt?: string }>(historyPath) ?? fail(`No history snapshot at ${historyPath}.`);
const dataLabel = `${historyPath} (${history.source}, saved ${history.savedAt ?? "?"})`;
const calendar = new TradingCalendar();
const market = new ReplayMarketDataSource({ candles: history.candles, daily: history.daily }, { lagMs: YAHOO_LAG_MS });

/**
 * Diagnostic data: the snapshot with the index bars from 15:15 IST removed on sessions before 3 Aug
 * 2026 only (continuous trading then, so those bars were genuine). Uncleaned features on it differ from
 * the baseline only through those genuine bars wherever the previous session is from 3 Aug on (before
 * that, the previous close also moves to the 15:10 close, which the real cutoff never does).
 */
const CUT_SYMBOLS = new Set<string>([MARKET_SYMBOLS.NIFTY, MARKET_SYMBOLS.SENSEX, MARKET_SYMBOLS.BANKNIFTY]);
const strippedCandles = Object.fromEntries(
  Object.entries(history.candles).map(([sym, arr]) => [sym, CUT_SYMBOLS.has(sym) ? arr.filter((c) => !(istDateOf(c.t) < AUCTION_START && istMinuteOfDay(c.t) >= 915)) : arr]),
);
const preAuctionStripped = new ReplayMarketDataSource({ candles: strippedCandles, daily: history.daily }, { lagMs: YAHOO_LAG_MS });

/** The config `npm run backtest -- --from F --to T --no-events --prod-limits [WP1 switches]` builds. */
function configFor(features: Partial<EngineConfig["features"]>): EngineConfig {
  const params: BacktestParams = { from, to, index: "BOTH", thresholdDelta: 0, stopPct: Math.abs(DEFAULT_CONFIG.exits.stopPct), targetPct: DEFAULT_CONFIG.exits.targetPct, noEvents: true };
  return withOverrides(configForParams(DEFAULT_CONFIG, params), { sizing: { maxOpenPerIndex: 2, maxOpenTotal: 2, maxTradesPerDay: 8 }, features });
}

interface Replay {
  name: string;
  label: string;
  cfg: EngineConfig;
  out: BacktestOutput;
  decisions: Map<string, PlanDecision>;
  clips: BodyClip[];
  /** The data this replay saw, for recomputing its features. */
  market: ReplayMarketDataSource;
  stripPreAuction: boolean;
}

async function replay(name: string, label: string, features: Partial<EngineConfig["features"]>, stripPreAuction = false): Promise<Replay> {
  const cfg = configFor(features);
  const clips: BodyClip[] = [];
  setBodyClipListener((c) => clips.push(c));
  const t0 = Date.now();
  const candles = stripPreAuction ? strippedCandles : history.candles;
  const run = new BacktestRun({ cfg, from, to, candles, daily: history.daily, events: [], noEvents: true });
  let out: BacktestOutput;
  try {
    out = await run.runAll();
  } finally {
    setBodyClipListener(null);
  }
  // Every decision is persisted in a backtest (one per index and 5-minute step); read them back.
  const deps = (run as unknown as { deps?: ReplayDeps }).deps;
  if (!deps?.repo) fail("BacktestRun no longer exposes its deps; update scripts/wp1-compare.ts.");
  const list = await deps.repo.decisions.between(istAt(from, "00:00"), istAt(addDays(to, 1), "00:00"));
  const decisions = new Map(list.map((d) => [`${d.index}|${d.t}`, d]));
  const s = out.summary;
  console.log(`${label}: ${s.trades} trades, net ₹${s.netPnl}, hit ${s.hitRate}, PF ${s.profitFactor} (${((Date.now() - t0) / 1000).toFixed(1)} s, ${clips.length} clips)`);
  return { name, label, cfg, out, decisions, clips, market: stripPreAuction ? preAuctionStripped : market, stripPreAuction };
}

function appendLedger(r: Replay): void {
  if (!ledgerPath) return;
  const s = r.out.summary;
  const { indicatorCutoffIst, bodyClip } = r.cfg.features;
  const line = {
    ts: new Date().toISOString(),
    wp: "WP1",
    variant: r.name === "baseline" ? "baseline (cleaning off)" : r.label,
    params: { from, to, noEvents: true, prodLimits: true, account: "main", indicatorCutoffIst, bodyClip, ...(r.stripPreAuction ? { preAuctionClosingBarsRemoved: true } : {}), tool: "scripts/wp1-compare.ts" },
    data: dataLabel,
    trades: s.trades,
    net: s.netPnl,
    notes: `hit ${s.hitRate}, PF ${s.profitFactor}, gross ₹${s.grossPnl}, charges ₹${s.charges}, maxDD ${s.maxDrawdownPct}%; ${r.clips.length} body clip(s) logged; data cleaning only, nothing tuned${ledgerNote ? `; ${ledgerNote}` : ""}`,
  };
  const p = resolve(ROOT, ledgerPath);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(line) + "\n");
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

const tradeKey = (t: TradeRecord) => `${t.index}|${t.entryMs}|${t.side}`;
const hhmm = (ms: number) => istIso(ms).slice(11, 16);
const when = (ms: number) => `${istDate(ms)} ${hhmm(ms)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Numeric leaves of the features that the cleaning rules can move (calendar and cross-asset fields excluded). */
function featureLeaves(f: MarketFeatures): Record<string, number> {
  const out: Record<string, number> = {};
  const scalar = ["spot", "ret5m", "ret15m", "ret60m", "retFromOpen", "vwapDistPct", "barsSameSideOfVwap", "efficiencyRatio60m", "atrPct5m", "atrPctile20d", "gapPct", "gapResidualPct", "vix", "vixChangePct", "realizedVol2h", "realizedVol20d", "rvIvRatio"] as const;
  for (const k of scalar) out[k] = f[k];
  for (const [k, v] of Object.entries(f.divergence)) out[`divergence.${k}`] = v;
  for (const [k, v] of Object.entries(f.indicators)) out[k] = v;
  for (const [k, v] of Object.entries(f.openingRange)) if (typeof v === "number") out[`openingRange.${k}`] = v;
  out["openingRange.state"] = ["FORMING", "INSIDE", "BROKE_UP", "BROKE_DOWN"].indexOf(f.openingRange.state);
  return out;
}

function fmtNum(x: number): string {
  const a = Math.abs(x);
  return a >= 1000 ? x.toFixed(2) : a >= 10 ? x.toFixed(2) : x.toFixed(3);
}

function featureDiff(a: MarketFeatures, b: MarketFeatures): { key: string; a: number; b: number }[] {
  const la = featureLeaves(a);
  const lb = featureLeaves(b);
  const out: { key: string; a: number; b: number }[] = [];
  for (const k of Object.keys(la)) {
    if (Math.abs(la[k] - lb[k]) > 1e-9 * Math.max(1, Math.abs(la[k]))) out.push({ key: k, a: la[k], b: lb[k] });
  }
  return out;
}

const featureCache = new Map<string, MarketFeatures>();
/** The features a replay saw at `t` (same data, lag and config as its run). */
function featuresAt(index: IndexId, t: number, r: Replay): MarketFeatures {
  const k = `${r.name}|${index}|${t}`;
  let f = featureCache.get(k);
  if (!f) featureCache.set(k, (f = computeFeatures(index, r.market.snapshotSync(t), calendar, r.cfg)));
  return f;
}

/**
 * Sessions whose closing bars (open time >= 15:15 IST) can reach the features of `index` at `t`: the
 * previous session (previous-day high/low, realized vol early in the day) and every session with such a
 * bar among the last INDICATOR_BARS closed bars. Read from the uncleaned series.
 */
function lateBarSessions(index: IndexId, t: number): string[] {
  const snap = market.snapshotSync(t);
  const today = istDate(t);
  const closed = (snap.candles[MARKET_SYMBOLS[index]] ?? []).filter((c) => {
    const m = istMinuteOfDay(c.t);
    return m >= 555 && m < 930 && calendar.isTradingDay(istDateOf(c.t));
  });
  const dates = new Set<string>();
  for (const c of closed.slice(-INDICATOR_BARS)) {
    const d = istDateOf(c.t);
    if (d < today && istMinuteOfDay(c.t) >= 915) dates.add(d);
  }
  dates.add(calendar.prevTradingDay(today));
  return [...dates].sort();
}

function eraOf(dates: string[]): string {
  const auction = dates.filter((d) => d >= AUCTION_START).length;
  if (auction === dates.length) return "auction-era";
  if (auction === 0) return "pre-auction";
  return "mixed";
}

/**
 * Differences between the voting components of two decisions. A value or abstain change comes from the
 * features; a weight or enabled change comes from the per-source performance record (decay), which
 * differs once the two replays have different trade histories. Components without weight in either
 * decision (e.g. TREND, prior weight 0) cannot move the score and are left out.
 */
function componentDiff(a: PlanDecision | undefined, b: PlanDecision | undefined): { text: string; values: boolean; weights: boolean } {
  if (!a || !b) return { text: "", values: false, weights: false };
  const parts: string[] = [];
  let values = a.conviction.regime !== b.conviction.regime;
  let weights = false;
  const view = (c: { abstain?: boolean; value: number }) => (c.abstain ? "abst" : c.value.toFixed(2));
  for (const ca of a.conviction.components) {
    const cb = b.conviction.components.find((c) => c.source === ca.source);
    if (!cb || (ca.weight <= 0 && cb.weight <= 0)) continue;
    if (Math.abs(ca.value - cb.value) > 1e-6 || !!ca.abstain !== !!cb.abstain) {
      values = true;
      parts.push(`${ca.source} ${view(ca)}→${view(cb)}`);
    }
    if (Math.abs(ca.weight - cb.weight) > 1e-6 || ca.enabled !== cb.enabled) {
      weights = true;
      parts.push(`${ca.source} weight ${ca.weight.toFixed(3)}${ca.enabled ? "" : " (off)"}→${cb.weight.toFixed(3)}${cb.enabled ? "" : " (off)"}`);
    }
  }
  const na = a.conviction.note ?? "";
  const nb = b.conviction.note ?? "";
  if (na !== nb) parts.push(`note "${na || "—"}"→"${nb || "—"}"`);
  return { text: parts.join("; "), values, weights };
}

function decisionText(d: PlanDecision | undefined): string {
  if (!d) return "no decision";
  const c = d.conviction;
  const verdict = d.plan ? `PLAN ${d.plan.contract.tradingSymbol}` : `no plan (${d.noPlanReason ?? "?"})`;
  return `${c.regime} score ${c.score.toFixed(3)} vs thr ${c.threshold.toFixed(2)} ${c.stance}; ${verdict}`;
}

/** Gates that depend on the book (positions, entries, losses), not on the market signal. */
const BOOK_GATES = new Set(["halt", "weekly_loss", "loss_streak", "cooldown", "per_index", "max_positions", "trades_today", "orders_today", "no_opposite", "loss_room", "size"]);

interface TradeDiff {
  n: number;
  kind: "removed" | "added" | "changed";
  index: IndexId;
  entryMs: number;
  side: string;
  base: TradeRecord | null;
  variant: TradeRecord | null;
  /**
   * signal: the features moved a voting signal or the regime at this decision; perf: same signal views,
   * but source weights from the performance record differ (earlier trades differed); book: only book
   * gates (positions, entries, losses) differ. perf and book are knock-ons of earlier differences.
   */
  cause: "signal" | "perf" | "book";
  /** What decided it: the blocking gates, or the regime/exit change. */
  why: string;
  /** Decision time compared (the entry, or the earlier exit for a trade changed on exit). */
  at: number;
  lateSessions: string[];
  era: string;
  features: { key: string; a: number; b: number }[];
  /** Baseline features vs the same with only the pre-3-Aug closing bars removed (genuine bars' share). */
  preAuction: { key: string; a: number; b: number }[];
  components: string;
  baseDecision: string;
  variantDecision: string;
  /** Full convictions behind the two decisions, for audit (JSON only). */
  convictions: { baseline: PlanDecision["conviction"] | null; variant: PlanDecision["conviction"] | null };
}

function tradeCell(t: TradeRecord | null): string {
  if (!t) return "—";
  return `${t.tradingSymbol} ×${t.qty}, exit ${hhmm(t.exitMs)} ${t.exitReason}, ₹${r2(t.pnl)}`;
}

/** Why a decision has no plan: "signal" if any signal gate failed, else "book" (only book gates failed). */
function blockedBy(d: PlanDecision | undefined): { cause: "signal" | "perf" | "book"; gates: string } {
  if (!d) return { cause: "signal", gates: "no decision" };
  const failed = d.gates.filter((g) => g.passed === false);
  const signal = failed.filter((g) => !BOOK_GATES.has(g.gate));
  const list = (failed.length ? failed : [{ gate: d.noPlanReason ?? "?" }]).map((g) => g.gate).join(", ");
  return { cause: signal.length > 0 || failed.length === 0 ? "signal" : "book", gates: list };
}

function diffTrades(base: Replay, v: Replay): TradeDiff[] {
  const a = new Map(base.out.trades.map((t) => [tradeKey(t), t]));
  const b = new Map(v.out.trades.map((t) => [tradeKey(t), t]));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => Number(x.split("|")[1]) - Number(y.split("|")[1]));
  const out: TradeDiff[] = [];
  for (const k of keys) {
    const ta = a.get(k) ?? null;
    const tb = b.get(k) ?? null;
    let kind: TradeDiff["kind"];
    if (ta && !tb) kind = "removed";
    else if (!ta && tb) kind = "added";
    else if (ta && tb && (ta.tradingSymbol !== tb.tradingSymbol || ta.qty !== tb.qty || ta.exitMs !== tb.exitMs || ta.exitReason !== tb.exitReason || r2(ta.pnl) !== r2(tb.pnl))) kind = "changed";
    else continue;
    const ref = (ta ?? tb)!;
    const index = ref.index as IndexId;
    let at = ref.entryMs;
    let da = base.decisions.get(`${index}|${at}`);
    let db = v.decisions.get(`${index}|${at}`);
    let cause: TradeDiff["cause"];
    let why: string;
    if (kind === "removed") ({ cause, gates: why } = blockedBy(db));
    else if (kind === "added") ({ cause, gates: why } = blockedBy(da));
    else if (ta!.qty !== tb!.qty || ta!.tradingSymbol !== tb!.tradingSymbol) {
      cause = "book";
      why = "size or contract";
    } else if (da && db && da.conviction.regime !== db.conviction.regime) {
      cause = "signal";
      why = `regime ${da.conviction.regime}→${db.conviction.regime}: time stop ${base.cfg.exits.horizonMinByRegime[da.conviction.regime]}→${v.cfg.exits.horizonMinByRegime[db.conviction.regime]} min`;
    } else {
      // Same entry and regime: the exits parted; compare the decision at the earlier exit.
      at = Math.min(ta!.exitMs, tb!.exitMs);
      da = base.decisions.get(`${index}|${at}`);
      db = v.decisions.get(`${index}|${at}`);
      cause = "signal";
      why = `exit ${ta!.exitReason}@${hhmm(ta!.exitMs)} vs ${tb!.exitReason}@${hhmm(tb!.exitMs)}`;
    }
    const comp = componentDiff(da, db);
    // A signal-gate difference with unchanged signal views but different source weights is a perf knock-on.
    if (cause === "signal" && !comp.values && comp.weights) cause = "perf";
    const baseF = featuresAt(index, at, base);
    const features = featureDiff(baseF, featuresAt(index, at, v));
    const preAuction = featureDiff(baseF, computeFeatures(index, preAuctionStripped.snapshotSync(at), calendar, base.cfg));
    const lateSessions = lateBarSessions(index, at);
    out.push({
      n: out.length + 1,
      kind,
      index,
      entryMs: ref.entryMs,
      side: ref.side,
      base: ta,
      variant: tb,
      cause,
      why,
      at,
      lateSessions,
      era: eraOf(lateSessions),
      features,
      preAuction,
      components: comp.text,
      baseDecision: decisionText(da),
      variantDecision: decisionText(db),
      convictions: { baseline: da?.conviction ?? null, variant: db?.conviction ?? null },
    });
  }
  for (const d of out) {
    if (d.cause === "book") {
      // Follows from an earlier difference the same day in the replay that lacks the trade.
      const day = istDate(d.entryMs);
      const missingIn = d.kind === "removed" ? "variant" : "base";
      const earlier = out.filter((e) => e !== d && istDate(e.entryMs) === day && e.entryMs <= d.entryMs && e[missingIn] !== null);
      if (earlier.length) d.why += ` (after #${earlier.map((e) => e.n).join(", #")})`;
    } else if (d.cause === "perf") {
      // The performance record is rebuilt at each day's end from recent trades: earlier differences feed it.
      const closed = out.filter((e) => e !== d && Math.min(e.base?.exitMs ?? Infinity, e.variant?.exitMs ?? Infinity) < d.at);
      d.why += `; source weights differ after earlier differences${closed.length ? ` (#${closed.slice(-3).map((e) => e.n).join(", #")}${closed.length > 3 ? " and before" : ""})` : ""}`;
    }
  }
  return out;
}

/** Decision points (index x 5-minute step) whose features differ, grouped by date. */
function decisionScope(base: Replay, v: Replay): { points: number; changedFeatures: number; changedStance: number; changedPlan: number; byDate: Record<string, number> } {
  let points = 0;
  let changedFeatures = 0;
  let changedStance = 0;
  let changedPlan = 0;
  const byDate: Record<string, number> = {};
  for (const [k, da] of base.decisions) {
    const db = v.decisions.get(k);
    if (!db) continue;
    points++;
    const ia = JSON.stringify(da.indicators ?? {});
    const ib = JSON.stringify(db.indicators ?? {});
    const ca = JSON.stringify(da.conviction.components.map((c) => [c.source, c.value, c.abstain]));
    const cb = JSON.stringify(db.conviction.components.map((c) => [c.source, c.value, c.abstain]));
    if (ia !== ib || ca !== cb || da.conviction.regime !== db.conviction.regime) {
      changedFeatures++;
      const d = istDate(da.t);
      byDate[d] = (byDate[d] ?? 0) + 1;
    }
    if (da.conviction.stance !== db.conviction.stance) changedStance++;
    if (!!da.plan !== !!db.plan) changedPlan++;
  }
  return { points, changedFeatures, changedStance, changedPlan, byDate };
}

/** The replay's own decisions must match a fresh feature computation (same snapshot, lag and config). */
function selfCheck(r: Replay): number {
  let mismatches = 0;
  let checked = 0;
  for (const d of r.decisions.values()) {
    if (checked++ % 37 !== 0) continue; // a spread-out sample keeps this fast
    const f = featuresAt(d.index, d.t, r);
    const view = { ...f.indicators, spot: f.spot, atrPct5m: f.atrPct5m, vwapDistPct: f.vwapDistPct, openingRange: f.openingRange };
    if (JSON.stringify(view) !== JSON.stringify(d.indicators)) mismatches++;
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function summaryRow(r: Replay, base: Replay): (string | number)[] {
  const s = r.out.summary;
  const b = base.out.summary;
  return [r.label, s.trades, s.hitRate, s.netPnl, s.profitFactor, s.grossPnl, s.charges, s.maxDrawdownPct, r === base ? "" : s.trades - b.trades, r === base ? "" : r2(s.netPnl - b.netPnl)];
}

function mdTable(rows: (string | number)[][]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|");
  return [rows[0].map(esc).join(" | "), rows[0].map(() => "---").join(" | "), ...rows.slice(1).map((r) => r.map(esc).join(" | "))].map((l) => `| ${l} |`).join("\n");
}

function featureText(f: { key: string; a: number; b: number }[], max = 12): string {
  const shown = f.slice(0, max).map((x) => `${x.key} ${fmtNum(x.a)}→${fmtNum(x.b)}`);
  return shown.join("; ") + (f.length > max ? `; +${f.length - max} more` : "");
}

async function main() {
  console.log(`Snapshot ${dataLabel}; ${from} .. ${to}; settings of npm run backtest -- --no-events --prod-limits.`);
  const base = await replay("baseline", "baseline (cleaning off)", {});
  appendLedger(base);
  if (base.out.summary.trades !== 51 || base.out.summary.netPnl !== -9595.92) {
    console.log(`note: baseline is ${base.out.summary.trades} trades / ₹${base.out.summary.netPnl}, not the reference 51 / ₹-9,595.92 (different snapshot or range?)`);
  }
  const variants: Replay[] = [];
  for (const name of variantNames) {
    const r = await replay(name, VARIANTS[name].label, VARIANTS[name].features, VARIANTS[name].stripPreAuction === true);
    appendLedger(r);
    variants.push(r);
  }
  const checks = [base, ...variants].map((r) => `${r.label}: ${selfCheck(r)} mismatches`);
  console.log(`Decision/feature self-check (sampled): ${checks.join("; ")}`);

  const md: string[] = [];
  md.push(`<!-- generated by scripts/wp1-compare.ts --history ${historyPath} --from ${from} --to ${to} -->`);
  md.push(`Data: ${dataLabel}. Range ${from} .. ${to}, ${base.out.days.length} sessions, main account, no events, production limits.`);
  md.push("");
  md.push(mdTable([["run", "trades", "hit", "net ₹", "PF", "gross ₹", "charges ₹", "maxDD %", "Δ trades", "Δ net ₹"], ...[base, ...variants].map((r) => summaryRow(r, base))]));
  const json: Record<string, unknown> = { data: dataLabel, from, to, summaries: Object.fromEntries([base, ...variants].map((r) => [r.name, r.out.summary])), variants: {} };

  for (const v of variants) {
    const diffs = diffTrades(base, v);
    const scope = decisionScope(base, v);
    const counts = { removed: 0, added: 0, changed: 0 };
    for (const d of diffs) counts[d.kind]++;
    const same = base.out.trades.length - counts.removed - counts.changed;
    md.push("");
    md.push(`### ${v.label}`);
    md.push("");
    md.push(
      `${diffs.length} trade(s) differ: ${counts.removed} removed, ${counts.added} added, ${counts.changed} changed; ${same} of ${base.out.trades.length} baseline trades identical. ` +
        `Decision points with different features or signals: ${scope.changedFeatures} of ${scope.points} (stance changed at ${scope.changedStance}, plan/no-plan at ${scope.changedPlan}).`,
    );
    if (v.clips.length) {
      md.push("");
      md.push("Body clips applied (each logged once):");
      md.push("");
      md.push(mdTable([["bar", "symbol", "body", "other index", "OHLC as published", "flattened to"], ...v.clips.map((c) => [when(c.t), c.symbol, `${c.bodyPct.toFixed(3)}%`, `${c.otherSymbol} ${c.otherBodyPct.toFixed(3)}%`, `${fmtNum(c.bar.o)} / ${fmtNum(c.bar.h)} / ${fmtNum(c.bar.l)} / ${fmtNum(c.bar.c)}`, fmtNum(c.clipped.c)])]));
    }
    if (diffs.length) {
      const sum = (xs: TradeDiff[], pick: (d: TradeDiff) => number) => r2(xs.reduce((s, d) => s + pick(d), 0));
      const removed = diffs.filter((d) => d.kind === "removed");
      const added = diffs.filter((d) => d.kind === "added");
      const changed = diffs.filter((d) => d.kind === "changed");
      md.push("");
      md.push(
        `P&L of the differences: removed trades ₹${sum(removed, (d) => d.base!.pnl)} (taken out), added ₹${sum(added, (d) => d.variant!.pnl)}, changed Δ₹${sum(changed, (d) => d.variant!.pnl - d.base!.pnl)}. ` +
          `Causes: ${diffs.filter((d) => d.cause === "signal").length} signal, ${diffs.filter((d) => d.cause === "perf").length} perf (knock-on), ${diffs.filter((d) => d.cause === "book").length} book (knock-on).`,
      );
      md.push("");
      md.push(mdTable([["#", "kind", "index", "entry (IST)", "side", "baseline", "variant", "cause", "late bars in window (era)", "pre-3-Aug late bars' effect", "decision baseline → variant", "signals changed", "features changed (baseline→variant)"], ...diffs.map((d) => [
        d.n,
        d.kind,
        d.index,
        when(d.entryMs),
        d.side,
        tradeCell(d.base),
        tradeCell(d.variant),
        `${d.cause}: ${d.why}` + (d.at !== d.entryMs ? ` (compared at ${hhmm(d.at)})` : ""),
        `${d.lateSessions.join(", ")} (${d.era})`,
        d.preAuction.length ? featureText(d.preAuction, 4) : "none",
        `${d.baseDecision} → ${d.variantDecision}`,
        d.components || "—",
        d.features.length ? featureText(d.features) : "identical",
      ])]));
    }
    md.push("");
    md.push(`Sessions whose decision inputs (indicators, signals or regime) changed, with the number of decision points (index x 5-minute step): ${Object.entries(scope.byDate).map(([d, n]) => `${d} ${n}`).join(", ") || "none"}.`);
    (json.variants as Record<string, unknown>)[v.name] = { label: v.label, clips: v.clips.map((c) => ({ ...c, at: when(c.t) })), scope, diffs: diffs.map((d) => ({ ...d, entry: when(d.entryMs), atIst: when(d.at) })) };
  }
  const mdPath = str(args, "md", "reports/wp1-compare.md")!;
  const jsonPath = str(args, "out", "reports/wp1-compare.json")!;
  const pm = resolve(ROOT, mdPath);
  mkdirSync(dirname(pm), { recursive: true });
  writeFileSync(pm, md.join("\n") + "\n");
  console.log(`\nSaved ${pm} and ${writeJson(jsonPath, json)}${ledgerPath ? `; ledger ${resolve(ROOT, ledgerPath)}` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
