/**
 * Gap betas before/after: replays a history snapshot with the hand-set gap betas (the baseline) and
 * with other beta sets (the configured defaults, plus any sets in --betas), using the settings of
 * `npm run backtest -- --no-events --prod-limits`, and lists every trade that differs with the
 * GLOBAL_BETA view behind it. Appends one line per replay to the trials ledger.
 *
 *   npx tsx scripts/research/gap-betas-compare.ts --history <snapshot.json> [--from 2026-07-23 --to 2026-10-08]
 *        [--betas <sets.json>] [--md <out.md>] [--out <out.json>] [--ledger reports/trials.jsonl | --no-ledger]
 *        [--ledger-note "..."]
 *
 * --betas holds named sets, {"name": {"ES": 0.3, ...}}; each replaces features.gapBetas whole.
 * Each differing trade gets a cause read from the decisions the two replays made at the same time:
 * "signal" when the GLOBAL_BETA view differs there (the only input the betas move), "perf" when the
 * signal views are equal but source weights differ (the performance record already differs after an
 * earlier difference), "book" when only book gates differ (open positions, the day's entries, a
 * cooldown, a loss cap) or the size changed: knock-ons of an earlier difference.
 *
 * Two checks that do not go through the trade list:
 * - the net P&L difference with a 90% interval from resampling sessions (daily P&L differences);
 * - GLOBAL_BETA as a forecast, threshold-free: at every decision point before 11:45 IST where it votes,
 *   its value against the index's log move over the next 90 minutes (its horizon; to the 15:30 close at
 *   most), from the snapshot's 5-minute closes: correlation, sign hit rate and the mean move in the
 *   signal's direction (bp), with 90% session-bootstrap intervals.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BacktestParams } from "../../src/engine/api-types";
import type { MarketHistory } from "../../src/engine/backtest/history";
import { attribution } from "../../src/engine/backtest/metrics";
import { BacktestRun, configForParams, type BacktestOutput } from "../../src/engine/backtest/runBacktest";
import { addDays, istAt, istDate, istIso, MINUTE_MS, SESSION } from "../../src/engine/clock";
import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../../src/engine/config";
import { istMinuteOfDay, lastIndexAtOrBefore } from "../../src/engine/market/candles";
import { sessionBootstrap } from "../../src/engine/market/gapFit";
import type { ReplayDeps } from "../../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type IndexId, type PlanDecision, type SignalComponent, type TradeRecord } from "../../src/engine/types";
import { quantile } from "../../src/engine/util/math";
import { fail, parseArgs, readJson, ROOT, str, writeJson } from "../lib/node";

/** The hand-set betas in config.ts before the refit (never fitted). */
const HAND_SET_BETAS: Record<string, number> = { ES: 0.45, NQ: 0.1, CL: -0.08, DXY: -0.15, USDINR: -1.5, US10Y: -0.01, N225: 0.1, HSI: 0.1, SSE: 0.05 };

const args = parseArgs();
const historyPath = str(args, "history") ?? fail("--history <snapshot.json> is required (saved by npm run backtest -- --save-history).");
const from = str(args, "from", "2026-07-23")!;
const to = str(args, "to", "2026-10-08")!;
const ledgerPath = args["no-ledger"] === true ? null : str(args, "ledger", "reports/trials.jsonl")!;
const ledgerNote = str(args, "ledger-note", "");
const history = readJson<MarketHistory & { source: string; savedAt?: string }>(historyPath) ?? fail(`No history snapshot at ${historyPath}.`);
const dataLabel = `${historyPath} (${history.source}, saved ${history.savedAt ?? "?"})`;

const sets: { name: string; betas: Record<string, number> }[] = [{ name: "hand-set betas", betas: HAND_SET_BETAS }];
const configured = DEFAULT_CONFIG.features.gapBetas;
if (JSON.stringify(configured) !== JSON.stringify(HAND_SET_BETAS)) sets.push({ name: "configured defaults", betas: configured });
const extraPath = str(args, "betas", undefined);
if (extraPath) {
  const extra = readJson<Record<string, Record<string, number>>>(extraPath) ?? fail(`No beta sets at ${extraPath}.`);
  for (const [name, betas] of Object.entries(extra)) sets.push({ name, betas });
}

/** The config `npm run backtest -- --from F --to T --no-events --prod-limits` builds, with `betas` as the whole gap-beta set. */
function configFor(betas: Record<string, number>): EngineConfig {
  const params: BacktestParams = { from, to, index: "BOTH", thresholdDelta: 0, stopPct: Math.abs(DEFAULT_CONFIG.exits.stopPct), targetPct: DEFAULT_CONFIG.exits.targetPct, noEvents: true };
  const cfg = withOverrides(configForParams(DEFAULT_CONFIG, params), { sizing: { maxOpenPerIndex: 2, maxOpenTotal: 2, maxTradesPerDay: 8 } });
  // Replace, not deep-merge: a key missing from `betas` must not keep its default value.
  return { ...cfg, features: { ...cfg.features, gapBetas: { ...betas } } };
}

interface Replay {
  name: string;
  betas: Record<string, number>;
  cfg: EngineConfig;
  out: BacktestOutput;
  decisions: Map<string, PlanDecision>;
}

async function replay(name: string, betas: Record<string, number>): Promise<Replay> {
  const cfg = configFor(betas);
  const t0 = Date.now();
  const run = new BacktestRun({ cfg, from, to, candles: history.candles, daily: history.daily, events: [], noEvents: true });
  const out = await run.runAll();
  // Every decision is persisted in a backtest (one per index and 5-minute step); read them back.
  const deps = (run as unknown as { deps?: ReplayDeps }).deps;
  if (!deps?.repo) fail("BacktestRun no longer exposes its deps; update scripts/research/gap-betas-compare.ts.");
  const list = await deps.repo.decisions.between(istAt(from, "00:00"), istAt(addDays(to, 1), "00:00"));
  const s = out.summary;
  console.log(`${name}: ${s.trades} trades, net ₹${s.netPnl}, hit ${s.hitRate}, PF ${s.profitFactor} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { name, betas, cfg, out, decisions: new Map(list.map((d) => [`${d.index}|${d.t}`, d])) };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const hhmm = (ms: number) => istIso(ms).slice(11, 16);
const when = (ms: number) => `${istDate(ms)} ${hhmm(ms)}`;
const tradeKey = (t: TradeRecord) => `${t.index}|${t.entryMs}|${t.side}`;
const globalOf = (d: PlanDecision | undefined): SignalComponent | undefined => d?.conviction.components.find((c) => c.source === "GLOBAL_BETA");
const globalAttributed = (r: Replay) => r2(attribution(r.out.trades).find((a) => a.source === "GLOBAL_BETA")?.attributedPnl ?? 0);

function appendLedger(r: Replay): void {
  if (!ledgerPath) return;
  const s = r.out.summary;
  const line = {
    ts: new Date().toISOString(),
    wp: "gap-betas",
    variant: r.name,
    params: { from, to, noEvents: true, prodLimits: true, account: "main", gapBetas: r.betas, tool: "scripts/research/gap-betas-compare.ts" },
    data: dataLabel,
    trades: s.trades,
    net: s.netPnl,
    notes: `hit ${s.hitRate}, PF ${s.profitFactor}, gross ₹${s.grossPnl}, charges ₹${s.charges}, maxDD ${s.maxDrawdownPct}%; GLOBAL_BETA attributed ₹${globalAttributed(r)}${ledgerNote ? `; ${ledgerNote}` : ""}`,
  };
  const p = resolve(ROOT, ledgerPath);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(line) + "\n");
}

/** Gates that depend on the book (positions, entries, losses), not on the market signal. */
const BOOK_GATES = new Set(["halt", "weekly_loss", "loss_streak", "cooldown", "per_index", "max_positions", "trades_today", "orders_today", "no_opposite", "loss_room", "size"]);

function globalText(c: SignalComponent | undefined): string {
  if (!c) return "—";
  return c.abstain ? `abstain (${c.notes ?? ""})` : `${c.value.toFixed(2)} (${c.notes ?? ""})`;
}

function decisionText(d: PlanDecision | undefined): string {
  if (!d) return "no decision";
  const c = d.conviction;
  const failed = d.gates.filter((g) => g.passed === false).map((g) => g.gate);
  const verdict = d.plan ? "PLAN" : `no plan: ${failed.length ? failed.join(", ") : (d.noPlanReason ?? "?")}`;
  return `${c.regime} score ${c.score.toFixed(3)} / thr ${c.threshold.toFixed(2)} ${c.stance}; ${verdict}`;
}

/** Signal views (value or abstain) and weights that differ between two decisions, GLOBAL_BETA included. */
function componentDiff(a: PlanDecision | undefined, b: PlanDecision | undefined): { values: string[]; weights: string[]; global: boolean } {
  const values: string[] = [];
  const weights: string[] = [];
  let global = false;
  if (!a || !b) return { values, weights, global };
  const view = (c: SignalComponent) => (c.abstain ? "abst" : c.value.toFixed(2));
  for (const ca of a.conviction.components) {
    const cb = b.conviction.components.find((c) => c.source === ca.source);
    if (!cb) continue;
    if (Math.abs(ca.value - cb.value) > 1e-9 || !!ca.abstain !== !!cb.abstain) {
      if (ca.source === "GLOBAL_BETA") global = true;
      if (ca.weight > 0 || cb.weight > 0) values.push(`${ca.source} ${view(ca)}→${view(cb)}`);
    }
    if (Math.abs(ca.weight - cb.weight) > 1e-6 || ca.enabled !== cb.enabled) weights.push(`${ca.source} w ${ca.weight.toFixed(3)}→${cb.weight.toFixed(3)}`);
  }
  if (a.conviction.regime !== b.conviction.regime) values.push(`regime ${a.conviction.regime}→${b.conviction.regime}`);
  return { values, weights, global };
}

interface TradeDiff {
  n: number;
  kind: "removed" | "added" | "changed";
  index: IndexId;
  entryMs: number;
  side: string;
  base: TradeRecord | null;
  variant: TradeRecord | null;
  cause: "signal" | "perf" | "book";
  why: string;
  /** Decision time compared (the entry, or the earlier exit of a trade changed on exit). */
  at: number;
  globalBase: string;
  globalVariant: string;
  baseDecision: string;
  variantDecision: string;
  otherChanges: string;
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
    if (kind === "changed" && ta!.qty === tb!.qty && ta!.tradingSymbol === tb!.tradingSymbol) at = Math.min(ta!.exitMs, tb!.exitMs);
    const da = base.decisions.get(`${index}|${at}`);
    const db = v.decisions.get(`${index}|${at}`);
    const comp = componentDiff(da, db);
    let cause: TradeDiff["cause"];
    let why: string;
    if (kind === "changed" && (ta!.qty !== tb!.qty || ta!.tradingSymbol !== tb!.tradingSymbol)) {
      cause = "book";
      why = `size or contract ${ta!.tradingSymbol} ×${ta!.qty} → ${tb!.tradingSymbol} ×${tb!.qty}`;
    } else if (kind === "changed") {
      cause = comp.global || comp.values.length ? "signal" : comp.weights.length ? "perf" : "book";
      why = `exit ${ta!.exitReason}@${hhmm(ta!.exitMs)} vs ${tb!.exitReason}@${hhmm(tb!.exitMs)}`;
    } else {
      const blocked = kind === "removed" ? db : da;
      const failed = (blocked?.gates ?? []).filter((g) => g.passed === false).map((g) => g.gate);
      const signalGates = failed.filter((g) => !BOOK_GATES.has(g));
      if (comp.global || (signalGates.length > 0 && comp.values.length > 0)) cause = "signal";
      else if (signalGates.length > 0 && comp.weights.length > 0) cause = "perf";
      else if (signalGates.length > 0 || failed.length === 0) cause = "signal";
      else cause = "book";
      why = `${kind === "removed" ? "variant" : "baseline"} blocked by ${failed.join(", ") || (blocked?.noPlanReason ?? "no decision")}`;
    }
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
      globalBase: globalText(globalOf(da)),
      globalVariant: globalText(globalOf(db)),
      baseDecision: decisionText(da),
      variantDecision: decisionText(db),
      otherChanges: [...comp.values.filter((x) => !x.startsWith("GLOBAL_BETA")), ...comp.weights].join("; "),
    });
  }
  return out;
}

/** Decision points (index x 5-minute step) where GLOBAL_BETA's view, the stance or the plan differ. */
function scope(base: Replay, v: Replay): { points: number; globalDiffers: number; stance: number; plan: number; days: number } {
  let points = 0;
  let globalDiffers = 0;
  let stance = 0;
  let plan = 0;
  const days = new Set<string>();
  for (const [k, da] of base.decisions) {
    const db = v.decisions.get(k);
    if (!db) continue;
    points++;
    const ga = globalOf(da);
    const gb = globalOf(db);
    if (ga && gb && (Math.abs(ga.value - gb.value) > 1e-9 || !!ga.abstain !== !!gb.abstain)) {
      globalDiffers++;
      days.add(istDate(da.t));
    }
    if (da.conviction.stance !== db.conviction.stance) stance++;
    if (!!da.plan !== !!db.plan) plan++;
  }
  return { points, globalDiffers, stance, plan, days: days.size };
}

const DRAWS = 2000;
const interval = (xs: number[]): [number, number] => [quantile(xs, 0.05), quantile(xs, 0.95)];

/** Net P&L difference (variant − baseline) with a 90% interval from resampling sessions. */
function pnlDifference(base: Replay, v: Replay): { diff: number; lo: number; hi: number; sessionsDiffering: number } {
  const byDay = new Map<string, number>(base.out.days.map((d) => [d, 0]));
  for (const t of v.out.trades) byDay.set(istDate(t.entryMs), (byDay.get(istDate(t.entryMs)) ?? 0) + t.pnl);
  for (const t of base.out.trades) byDay.set(istDate(t.entryMs), (byDay.get(istDate(t.entryMs)) ?? 0) - t.pnl);
  const rows = [...byDay].map(([date, d]) => ({ date, d }));
  const sums = sessionBootstrap(rows, (s) => s.reduce((a, r) => a + r.d, 0), DRAWS, 1);
  const [lo, hi] = interval(sums);
  return { diff: r2(rows.reduce((a, r) => a + r.d, 0)), lo: r2(lo), hi: r2(hi), sessionsDiffering: rows.filter((r) => Math.abs(r.d) > 0.005).length };
}

/** Close of the last 5-minute bar closed by `t` on the same IST date, or null. */
function closeAt(bars: Candle[], t: number): number | null {
  const i = lastIndexAtOrBefore(bars, t - 5 * MINUTE_MS);
  return i >= 0 && istDate(bars[i].t) === istDate(t) ? bars[i].c : null;
}

interface SignalStats {
  points: number;
  votes: number;
  ic: number;
  icLo: number;
  icHi: number;
  hitRate: number;
  hitN: number;
  meanBp: number;
  meanLo: number;
  meanHi: number;
}

/** GLOBAL_BETA's value against the index's next-90-minute log move, at decision points before 11:45 IST. */
function globalSignalStats(r: Replay): SignalStats {
  const pts: { date: string; v: number; fwd: number }[] = [];
  let points = 0;
  for (const d of r.decisions.values()) {
    const g = globalOf(d);
    const m = istMinuteOfDay(d.t);
    if (!g || m < SESSION.open || m >= SESSION.open + 150) continue;
    points++;
    if (g.abstain || g.value === 0) continue;
    const bars = history.candles[MARKET_SYMBOLS[d.index]] ?? [];
    const p0 = closeAt(bars, d.t);
    const p1 = closeAt(bars, Math.min(d.t + 90 * MINUTE_MS, istAt(istDate(d.t), "15:30")));
    if (p0 === null || p1 === null || !(p0 > 0) || !(p1 > 0)) continue;
    pts.push({ date: istDate(d.t), v: g.value, fwd: Math.log(p1 / p0) * 1e4 });
  }
  const corr = (s: typeof pts) => {
    const n = s.length;
    if (n < 3) return NaN;
    const mv = s.reduce((a, p) => a + p.v, 0) / n;
    const mf = s.reduce((a, p) => a + p.fwd, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const p of s) {
      sxy += (p.v - mv) * (p.fwd - mf);
      sxx += (p.v - mv) ** 2;
      syy += (p.fwd - mf) ** 2;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  };
  const signedMean = (s: typeof pts) => (s.length ? s.reduce((a, p) => a + Math.sign(p.v) * p.fwd, 0) / s.length : NaN);
  const hits = pts.filter((p) => p.fwd !== 0);
  const [icLo, icHi] = interval(sessionBootstrap(pts, corr, DRAWS, 1).filter(Number.isFinite));
  const [meanLo, meanHi] = interval(sessionBootstrap(pts, signedMean, DRAWS, 1).filter(Number.isFinite));
  return {
    points,
    votes: pts.length,
    ic: corr(pts),
    icLo,
    icHi,
    hitRate: hits.length ? hits.filter((p) => Math.sign(p.v) === Math.sign(p.fwd)).length / hits.length : NaN,
    hitN: hits.length,
    meanBp: signedMean(pts),
    meanLo,
    meanHi,
  };
}

function tradeCell(t: TradeRecord | null): string {
  if (!t) return "—";
  return `${t.tradingSymbol} ×${t.qty}, exit ${hhmm(t.exitMs)} ${t.exitReason}, ₹${r2(t.pnl)}`;
}

function mdTable(rows: (string | number)[][]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|");
  return [rows[0].map(esc).join(" | "), rows[0].map(() => "---").join(" | "), ...rows.slice(1).map((r) => r.map(esc).join(" | "))].map((l) => `| ${l} |`).join("\n");
}

async function main() {
  console.log(`Snapshot ${dataLabel}; ${from} .. ${to}; settings of npm run backtest -- --no-events --prod-limits.`);
  const replays: Replay[] = [];
  for (const s of sets) {
    const r = await replay(s.name, s.betas);
    appendLedger(r);
    replays.push(r);
  }
  const base = replays[0];
  const md: string[] = [];
  md.push(`<!-- generated by scripts/research/gap-betas-compare.ts --history ${historyPath} --from ${from} --to ${to} -->`);
  md.push(`Data: ${dataLabel}. Range ${from} .. ${to}, ${base.out.days.length} sessions, main account, no events, production limits.`);
  md.push("");
  md.push(
    mdTable([
      ["run", "trades", "hit", "net ₹", "PF", "gross ₹", "charges ₹", "maxDD %", "GLOBAL_BETA attributed ₹", "Δ trades", "Δ net ₹"],
      ...replays.map((r) => {
        const s = r.out.summary;
        return [r.name, s.trades, s.hitRate, s.netPnl, s.profitFactor, s.grossPnl, s.charges, s.maxDrawdownPct, globalAttributed(r), r === base ? "" : s.trades - base.out.summary.trades, r === base ? "" : r2(s.netPnl - base.out.summary.netPnl)];
      }),
    ]),
  );
  const pnlDiffs = replays.slice(1).map((v) => ({ name: v.name, ...pnlDifference(base, v) }));
  md.push("");
  md.push(`Net P&L difference against ${base.name}, with a 90% interval from resampling the ${base.out.days.length} sessions (${DRAWS} draws):`);
  md.push("");
  md.push(mdTable([["run", "Δ net ₹", "90% interval ₹", "sessions with a difference"], ...pnlDiffs.map((d) => [d.name, d.diff, `${d.lo} .. ${d.hi}`, d.sessionsDiffering])]));
  const stats = replays.map((r) => ({ name: r.name, ...globalSignalStats(r) }));
  const f = (x: number, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : "—");
  md.push("");
  md.push(
    "GLOBAL_BETA as a forecast (no thresholds, no trades): at decision points before 11:45 IST where it votes, its value against the index's log move over the next 90 minutes; 90% intervals from resampling sessions.",
  );
  md.push("");
  md.push(
    mdTable([
      ["run", "points before 11:45", "votes", "corr with next 90 min [90%]", "sign hit", "mean move in its direction, bp [90%]"],
      ...stats.map((s) => [s.name, s.points, s.votes, `${f(s.ic)} [${f(s.icLo)}, ${f(s.icHi)}]`, `${f(s.hitRate * 100, 1)}% (${s.hitN})`, `${f(s.meanBp, 1)} [${f(s.meanLo, 1)}, ${f(s.meanHi, 1)}]`]),
    ]),
  );
  const json: Record<string, unknown> = {
    data: dataLabel,
    from,
    to,
    sets,
    summaries: Object.fromEntries(replays.map((r) => [r.name, { ...r.out.summary, globalBetaAttributed: globalAttributed(r) }])),
    pnlDifferences: pnlDiffs,
    globalBetaForecast: stats,
    variants: {},
  };
  for (const v of replays.slice(1)) {
    const diffs = diffTrades(base, v);
    const sc = scope(base, v);
    const counts = { removed: 0, added: 0, changed: 0 };
    for (const d of diffs) counts[d.kind]++;
    md.push("");
    md.push(`### ${v.name} vs ${base.name}`);
    md.push("");
    md.push(
      `${diffs.length} trade(s) differ: ${counts.removed} removed, ${counts.added} added, ${counts.changed} changed; ${base.out.trades.length - counts.removed - counts.changed} of ${base.out.trades.length} baseline trades identical. ` +
        `GLOBAL_BETA's view differs at ${sc.globalDiffers} of ${sc.points} decision points (index x 5-minute step) on ${sc.days} sessions; the stance differs at ${sc.stance} and plan/no-plan at ${sc.plan}.`,
    );
    if (diffs.length) {
      const sum = (xs: TradeDiff[], pick: (d: TradeDiff) => number) => r2(xs.reduce((s, d) => s + pick(d), 0));
      md.push("");
      md.push(
        `P&L of the differences: removed ₹${sum(diffs.filter((d) => d.kind === "removed"), (d) => d.base!.pnl)} (taken out), added ₹${sum(diffs.filter((d) => d.kind === "added"), (d) => d.variant!.pnl)}, ` +
          `changed Δ₹${sum(diffs.filter((d) => d.kind === "changed"), (d) => d.variant!.pnl - d.base!.pnl)}. Causes: ${diffs.filter((d) => d.cause === "signal").length} signal, ` +
          `${diffs.filter((d) => d.cause === "perf").length} perf (knock-on), ${diffs.filter((d) => d.cause === "book").length} book (knock-on).`,
      );
      md.push("");
      md.push(
        mdTable([
          ["#", "kind", "index", "entry (IST)", "side", "baseline", "variant", "cause", "GLOBAL_BETA baseline → variant", "decision baseline → variant", "other changes"],
          ...diffs.map((d) => [
            d.n,
            d.kind,
            d.index,
            when(d.entryMs),
            d.side,
            tradeCell(d.base),
            tradeCell(d.variant),
            `${d.cause}: ${d.why}${d.at !== d.entryMs ? ` (compared at ${hhmm(d.at)})` : ""}`,
            `${d.globalBase} → ${d.globalVariant}`,
            `${d.baseDecision} → ${d.variantDecision}`,
            d.otherChanges || "—",
          ]),
        ]),
      );
    }
    (json.variants as Record<string, unknown>)[v.name] = { scope: sc, diffs: diffs.map((d) => ({ ...d, entry: when(d.entryMs), atIst: when(d.at) })) };
  }
  const mdPath = str(args, "md", undefined);
  if (mdPath) {
    const p = resolve(ROOT, mdPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, md.join("\n") + "\n");
    console.log(`Saved ${p}`);
  } else console.log(`\n${md.join("\n")}`);
  const outPath = str(args, "out", undefined);
  if (outPath) console.log(`Saved ${writeJson(outPath, json)}`);
  if (ledgerPath) console.log(`Ledger: ${resolve(ROOT, ledgerPath)} (+${replays.length} lines)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
