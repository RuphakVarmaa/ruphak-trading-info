/**
 * The acceptance protocol (PLAN §5): the runs it needs and a verdict on each criterion. A variant may
 * be enabled on a paper account only when every criterion passes. Below the minimum sample the
 * verdict is INSUFFICIENT, never PASS; criteria that need other work (real option prices, the
 * look-ahead review) print N/A with the reason, so the overall verdict cannot be PASS until they land.
 *
 * runProtocol() replays the variant with and without the copy-delay penalty, runs the random-entry
 * placebo with the same exits and costs, and the ±20% one-at-a-time perturbations; evaluateProtocol()
 * turns that evidence (plus the trials ledger) into verdicts; formatProtocol() prints them.
 */
import type { AccountId } from "../accounts";
import { scheduleFor } from "../broker/charges";
import { withOverrides, type DeepPartial, type EngineConfig } from "../config";
import type { TradeRecord } from "../types";
import { mean, stdev } from "../util/math";
import {
  bonferroniAlpha,
  byIndex,
  byWeek,
  contributions,
  dayBlockBootstrap,
  deflatedSharpe,
  moments,
  profitFactor,
  sessionPnls,
  sessionReturns,
  tradeDrawdown,
  type BlockBootstrap,
  type DeflatedSharpe,
} from "./metrics";
import { randomEntryPlacebo, regimeLookup, type PlaceboResult, type PlaceboSizing } from "./placebo";
import { describeCopyDelay, runBacktestAccounts, type BacktestInput, type BacktestOutput, type CopyDelay } from "./runBacktest";
import type { LedgerStats, TrialKind, TrialRecord } from "./trials";

export type Verdict = "PASS" | "FAIL" | "INSUFFICIENT" | "N/A";

export interface ProtocolThresholds {
  minOosTrades: number;
  placeboMinDraws: number;
  /** Strategy mean − placebo mean must be at least this many standard errors of the strategy mean. */
  placeboSeMultiple: number;
  bootstrapResamples: number;
  level: number;
  alpha: number;
  minProfitFactor: number;
  /** Main's drawdown limit in % of capital; small accounts use their weekly loss cap. */
  maxDrawdownPctMain: number;
  /** Largest share of net P&L one index or one week may contribute. */
  maxShare: number;
  perturbFraction: number;
  perturbMinPositiveShare: number;
  /** Worst perturbation, relative to |base net|. */
  perturbFloor: number;
  /** The copy-delay penalty every evaluation includes (§5.4). */
  copyDelay: CopyDelay;
}

export const PROTOCOL: ProtocolThresholds = {
  minOosTrades: 180,
  placeboMinDraws: 3_000,
  placeboSeMultiple: 2,
  bootstrapResamples: 10_000,
  level: 0.95,
  alpha: 0.05,
  minProfitFactor: 1.3,
  maxDrawdownPctMain: 6,
  maxShare: 0.6,
  perturbFraction: 0.2,
  perturbMinPositiveShare: 0.8,
  perturbFloor: -0.5,
  copyDelay: { fillDelayBars: 1, extraTicks: 2 },
};

// ---------------------------------------------------------------------------
// ±20% perturbation driver
// ---------------------------------------------------------------------------

export interface PerturbParam {
  name: string;
  /** Config path(s) the parameter scales. */
  path: string;
  /** Overrides with the parameter scaled by `factor`, relative to `cfg`'s own value. */
  patch(cfg: EngineConfig, factor: number): DeepPartial<EngineConfig>;
}

const clampFrac = (v: number) => Math.min(0.95, Math.max(0.05, v));
const scaled = <K extends string>(r: Record<K, number>, f: number, map: (v: number) => number = (v) => v): Record<K, number> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, map((v as number) * f)])) as Record<K, number>;
const int = (min: number) => (v: number) => Math.max(min, Math.round(v));

/** Every numeric strategy parameter of the conviction engine the driver perturbs (exits apply to each account's own values). */
export const PERTURB_PARAMS: readonly PerturbParam[] = [
  { name: "stop", path: "exits.stopPct", patch: (c, f) => ({ exits: { stopPct: c.exits.stopPct * f } }) },
  { name: "target", path: "exits.targetPct", patch: (c, f) => ({ exits: { targetPct: c.exits.targetPct * f } }) },
  { name: "time-stop", path: "exits.horizonMinByRegime", patch: (c, f) => ({ exits: { horizonMinByRegime: scaled(c.exits.horizonMinByRegime, f, Math.round) } }) },
  { name: "trail-activate", path: "exits.trailActivatePct", patch: (c, f) => ({ exits: { trailActivatePct: c.exits.trailActivatePct * f } }) },
  { name: "trail-giveback", path: "exits.trailGivebackPct", patch: (c, f) => ({ exits: { trailGivebackPct: c.exits.trailGivebackPct * f } }) },
  { name: "time-floor", path: "exits.timeStopMinPnlPct", patch: (c, f) => ({ exits: { timeStopMinPnlPct: c.exits.timeStopMinPnlPct * f } }) },
  { name: "flip-fraction", path: "exits.flipExitFraction", patch: (c, f) => ({ exits: { flipExitFraction: c.exits.flipExitFraction * f } }) },
  { name: "gain", path: "conviction.gain", patch: (c, f) => ({ conviction: { gain: c.conviction.gain * f } }) },
  {
    name: "thresholds",
    path: "conviction.thresholds, conviction.counterTrendThreshold",
    patch: (c, f) => ({ conviction: { thresholds: scaled(c.conviction.thresholds, f, clampFrac), counterTrendThreshold: clampFrac(c.conviction.counterTrendThreshold * f) } }),
  },
  { name: "min-active", path: "conviction.minActiveWeight", patch: (c, f) => ({ conviction: { minActiveWeight: Math.min(1, c.conviction.minActiveWeight * f) } }) },
  { name: "min-edge", path: "gates.minEdgeRatio", patch: (c, f) => ({ gates: { minEdgeRatio: c.gates.minEdgeRatio * f } }) },
  { name: "min-evi", path: "gates.minExpectedVsImplied", patch: (c, f) => ({ gates: { minExpectedVsImplied: c.gates.minExpectedVsImplied * f } }) },
  { name: "kem", path: "gates.kEM", patch: (c, f) => ({ gates: { kEM: c.gates.kEM * f } }) },
  { name: "vol-factor", path: "gates.intradayVolFactor", patch: (c, f) => ({ gates: { intradayVolFactor: c.gates.intradayVolFactor * f } }) },
  { name: "rv-bars", path: "features.rvBars", patch: (c, f) => ({ features: { rvBars: int(2)(c.features.rvBars * f) } }) },
  { name: "divergence-bars", path: "features.divergenceBars", patch: (c, f) => ({ features: { divergenceBars: int(1)(c.features.divergenceBars * f) } }) },
  { name: "opening-range", path: "features.openingRangeMin", patch: (c, f) => ({ features: { openingRangeMin: int(1)(c.features.openingRangeMin * f) } }) },
  { name: "session-lookback", path: "features.sessionLookbackDays", patch: (c, f) => ({ features: { sessionLookbackDays: int(1)(c.features.sessionLookbackDays * f) } }) },
];

/** Parameters by comma-separated name ("all" or empty: every one). Throws on an unknown name. */
export function perturbParams(names: string | undefined): PerturbParam[] {
  const list = (names ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.includes("all")) return [...PERTURB_PARAMS];
  const out: PerturbParam[] = [];
  for (const name of list) {
    const p = PERTURB_PARAMS.find((x) => x.name === name);
    if (!p) throw new Error(`unknown perturbation parameter "${name}" (known: ${PERTURB_PARAMS.map((x) => x.name).join(", ")})`);
    out.push(p);
  }
  return out;
}

export interface PerturbationOutcome {
  param: string;
  factor: number;
  trades: number;
  net: number;
  sessions?: number;
  /** Sharpe ratio of net P&L per session (for the trials ledger). */
  srSession?: number;
  /** Set when the perturbed config was invalid (not counted). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ProtocolRunInput {
  /** Market data and replay settings shared by every run (candles, daily, events, noEvents, calendar, lag, step). */
  base: Omit<BacktestInput, "cfg" | "from" | "to" | "followers" | "fillDelayBars" | "extraTicks" | "recordSignals">;
  cfg: EngineConfig;
  from: string;
  to: string;
  follower: { account: AccountId; cfg: EngineConfig } | null;
  copyDelay: CopyDelay;
  placebo: { draws: number; seed: number; horizonMin?: number; sizing?: PlaceboSizing; window?: { from: string; to: string } };
  /** Parameters perturbed ±fraction one at a time; null skips the robustness runs. */
  perturb: readonly PerturbParam[] | null;
  fraction: number;
}

export interface AccountRuns {
  account: AccountId;
  cfg: EngineConfig;
  /** The copy-delay penalty of the evaluation run. */
  copyDelay: CopyDelay;
  noDelay: BacktestOutput;
  /** The evaluation run: with the copy delay. */
  delayed: BacktestOutput;
  placebo: { noDelay: PlaceboResult; delayed: PlaceboResult };
  perturbations: PerturbationOutcome[] | null;
}

export interface ProtocolRuns {
  main: AccountRuns;
  follower: AccountRuns | null;
}

/** Replays, placebos and perturbations for the protocol (slow: one full replay per perturbation). */
export async function runProtocol(i: ProtocolRunInput, log: (msg: string) => void = () => {}): Promise<ProtocolRuns> {
  const replay = async (cfg: EngineConfig, followerCfg: EngineConfig | null, copy: CopyDelay | null, recordSignals: boolean) => {
    const followers = i.follower && followerCfg ? [{ account: i.follower.account, cfg: followerCfg }] : undefined;
    const r = await runBacktestAccounts({ ...i.base, cfg, from: i.from, to: i.to, followers, recordSignals, ...(copy ?? {}) });
    return { main: r.main, follower: i.follower ? (r.followers[i.follower.account] ?? null) : null };
  };
  log("replay 1/2: the variant with the engine's own fills");
  const noDelay = await replay(i.cfg, i.follower?.cfg ?? null, null, false);
  log(`replay 2/2: with the copy delay (${describeCopyDelay(i.copyDelay)})`);
  const delayed = await replay(i.cfg, i.follower?.cfg ?? null, i.copyDelay, true);

  // Same draws with and without the delay; horizons from the regimes the engine saw at each draw.
  const regimeAt = regimeLookup(delayed.main.signals ?? []);
  const placebo = async (cfg: EngineConfig) => {
    const p = {
      cfg,
      candles: i.base.candles,
      daily: i.base.daily,
      from: i.from,
      to: i.to,
      days: delayed.main.days,
      calendar: i.base.calendar,
      lagMs: i.base.lagMs,
      stepMs: i.base.stepMs,
      regimeAt,
      ...i.placebo,
    };
    return { noDelay: await randomEntryPlacebo(p), delayed: await randomEntryPlacebo({ ...p, ...i.copyDelay }) };
  };
  log(`random-entry placebo: ${i.placebo.draws} draws, seed ${i.placebo.seed}, with and without the copy delay`);
  const mainPlacebo = await placebo(i.cfg);
  const followerPlacebo = i.follower ? await placebo(i.follower.cfg) : null;

  let mainPert: PerturbationOutcome[] | null = null;
  let followerPert: PerturbationOutcome[] | null = null;
  if (i.perturb) {
    mainPert = [];
    followerPert = i.follower ? [] : null;
    const factors = [1 - i.fraction, 1 + i.fraction];
    let k = 0;
    for (const p of i.perturb) {
      for (const f of factors) {
        k++;
        const factor = Math.round(f * 1000) / 1000;
        let cfg: EngineConfig;
        let fcfg: EngineConfig | null = null;
        try {
          cfg = withOverrides(i.cfg, p.patch(i.cfg, f));
          if (i.follower) fcfg = withOverrides(i.follower.cfg, p.patch(i.follower.cfg, f));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          mainPert.push({ param: p.name, factor, trades: 0, net: 0, error });
          followerPert?.push({ param: p.name, factor, trades: 0, net: 0, error });
          continue;
        }
        log(`perturbation ${k}/${i.perturb.length * factors.length}: ${p.name} ×${factor}`);
        const r = await replay(cfg, fcfg, i.copyDelay, false);
        const outcome = (o: BacktestOutput, c: EngineConfig): PerturbationOutcome => {
          const s = tradeStats(o.trades, o.days, c.capitalRupees);
          return { param: p.name, factor, trades: s.trades, net: s.net, sessions: s.sessions, srSession: s.srSession };
        };
        mainPert.push(outcome(r.main, cfg));
        if (followerPert && r.follower && fcfg) followerPert.push(outcome(r.follower, fcfg));
      }
    }
  }
  const main: AccountRuns = { account: "main", cfg: i.cfg, copyDelay: i.copyDelay, noDelay: noDelay.main, delayed: delayed.main, placebo: mainPlacebo, perturbations: mainPert };
  const follower: AccountRuns | null =
    i.follower && noDelay.follower && delayed.follower && followerPlacebo
      ? { account: i.follower.account, cfg: i.follower.cfg, copyDelay: i.copyDelay, noDelay: noDelay.follower, delayed: delayed.follower, placebo: followerPlacebo, perturbations: followerPert }
      : null;
  return { main, follower };
}

// ---------------------------------------------------------------------------
// Statistics of a run
// ---------------------------------------------------------------------------

export interface TradeStats {
  trades: number;
  sessions: number;
  net: number;
  mean: number;
  sd: number;
  /** i.i.d. standard error of the mean per trade. */
  se: number;
  hitRate: number;
  profitFactor: number;
  grossPerTrade: number;
  chargesPerTrade: number;
  /** Sharpe ratio of net P&L per session (sessions without trades count), not annualized. */
  srSession: number;
}

export function tradeStats(trades: readonly TradeRecord[], days: readonly string[], capital: number): TradeStats {
  const pnls = trades.map((t) => t.pnl);
  const n = pnls.length;
  const sd = stdev(pnls);
  const rets = sessionReturns(sessionPnls(trades, days), capital);
  const m = moments(rets);
  return {
    trades: n,
    sessions: days.length,
    net: Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100,
    mean: mean(pnls),
    sd,
    se: n > 1 ? sd / Math.sqrt(n) : 0,
    hitRate: n > 0 ? pnls.filter((p) => p > 0).length / n : 0,
    profitFactor: profitFactor(pnls),
    grossPerTrade: mean(trades.map((t) => t.grossPnl)),
    chargesPerTrade: mean(trades.map((t) => t.charges)),
    srSession: m.sd > 0 ? m.mean / m.sd : 0,
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface Criterion {
  id: number;
  title: string;
  verdict: Verdict;
  summary: string;
  lines: string[];
}

export interface ProtocolContext {
  from: string;
  to: string;
  /** Source of the published rule when the variant is declared frozen (§5.1), else null. */
  frozen: string | null;
  /** Trials ledger after this run's lines were appended (null: no ledger). */
  ledger: LedgerStats | null;
  thresholds: ProtocolThresholds;
  /** Day-block bootstrap to run (criterion 6 needs at least thresholds.bootstrapResamples). */
  bootstrap: { resamples: number; seed: number };
  /** Small accounts evaluated in the same run (main's criterion 12). */
  followers?: { account: AccountId; label: string; verdict: Verdict }[];
}

export interface ProtocolReport {
  account: AccountId;
  label: string;
  from: string;
  to: string;
  verdict: Verdict;
  criteria: Criterion[];
  evaluation: TradeStats;
  noDelay: TradeStats;
  placebo: { delayed: PlaceboResult["summary"]; noDelay: PlaceboResult["summary"]; settings: PlaceboResult["settings"] };
  bootstrap: BlockBootstrap;
  dsr: DeflatedSharpe | null;
  copyDelay: CopyDelay;
}

const rs = (x: number, digits = 0) => `${x < 0 ? "−" : ""}₹${Math.abs(x).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pm = (x: number, digits = 0) => `${x >= 0 ? "+" : "−"}₹${Math.abs(x).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const pval = (p: number) => (p < 0.001 ? p.toExponential(1) : p.toFixed(3));

/** Worst of a set of verdicts: FAIL, then INSUFFICIENT or N/A (not yet decidable), else PASS. */
export function overallVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("INSUFFICIENT") || verdicts.includes("N/A")) return "INSUFFICIENT";
  return "PASS";
}

/** Verdicts on §5 for one account's runs (the account's own trades, placebo, caps). */
export function evaluateProtocol(r: AccountRuns, label: string, ctx: ProtocolContext): ProtocolReport {
  const th = ctx.thresholds;
  const capital = r.cfg.capitalRupees;
  const days = r.delayed.days;
  const ev = tradeStats(r.delayed.trades, days, capital);
  const nd = tradeStats(r.noDelay.trades, r.noDelay.days, capital);
  const pl = r.placebo.delayed.summary;
  const plNd = r.placebo.noDelay.summary;
  const boot = dayBlockBootstrap(sessionPnls(r.delayed.trades, days), { resamples: ctx.bootstrap.resamples, seed: ctx.bootstrap.seed, level: th.level });
  const criteria: Criterion[] = [];
  const add = (id: number, title: string, verdict: Verdict, summary: string, lines: string[] = []) => criteria.push({ id, title, verdict, summary, lines });

  // 1-2. Frozen published parameters; out-of-sample only.
  if (ctx.frozen) {
    add(1, "Published parameters frozen", "PASS", `declared frozen: ${ctx.frozen}`, ["Any deviation from the published values is a separate variant and a separate trial."]);
    add(2, "Out-of-sample only", "PASS", `frozen-parameter rule: the whole sample counts as out-of-sample (${ctx.from} .. ${ctx.to}, ${days.length} sessions)`);
  } else {
    add(1, "Published parameters frozen", "FAIL", "not declared a frozen published rule (--frozen <source>): its parameters are treated as fitted on this data", [
      "The default CONVICTION engine is not a published rule; its weights, thresholds and gates were tuned on recent backtests.",
    ]);
    add(2, "Out-of-sample only", "FAIL", "in-sample run of a fitted rule: only pooled walk-forward out-of-sample trades (42-day train / 14-day test) count", [
      "--protocol evaluates one replay; walk-forward OOS trades are not wired into it yet (see --walk-forward).",
    ]);
  }
  const oos = ctx.frozen ? ev.trades : 0;

  // 3. Minimum sample.
  add(3, "Minimum sample", oos >= th.minOosTrades ? "PASS" : "INSUFFICIENT", `${oos} out-of-sample trades${ctx.frozen ? "" : ` (${ev.trades} in-sample)`} vs ≥ ${th.minOosTrades} required`, [
    `${days.length} sessions in this replay; the 2-year hourly replay alternative needs ≥ 120 OOS sessions (not applicable to 5-minute replays).`,
  ]);

  // 4. Costs, including the copy-delay penalty.
  const copy = r.copyDelay;
  const sched = scheduleFor(ctx.to);
  const costOk = copy.fillDelayBars >= th.copyDelay.fillDelayBars && copy.extraTicks >= th.copyDelay.extraTicks;
  add(4, "Costs (charges, spread, slippage, copy delay)", costOk ? "PASS" : "FAIL", costOk ? `evaluated with every cost; copy delay: ${describeCopyDelay(copy)}` : `copy delay below the §5.4 penalty (${describeCopyDelay(copy)})`, [
    `Charges ${rs(ev.chargesPerTrade)}/trade (dated schedule from ${sched.effectiveFrom}: STT ${sched.sttSellPct}% on sells, brokerage ₹${sched.brokeragePerOrder}/order); synthetic spread max(${r.cfg.pricing.spreadModel.minTicks} tick, ${r.cfg.pricing.spreadModel.pctOfPremium}% of premium); market orders pay ${r.cfg.broker.slippageTicksMarket} ticks beyond visible depth.`,
    `Copy delay costs the strategy ${rs(nd.mean - ev.mean)}/trade (${rs(nd.mean, 0)} → ${rs(ev.mean, 0)}; ${nd.trades} → ${ev.trades} trades, the trade list can change) and the placebo ${rs(plNd.mean - pl.mean)}/trade on the same ${pl.n} draws (${rs(plNd.mean)} → ${rs(pl.mean)}).`,
  ]);

  // 5. Beats the random-entry placebo with the same exits, costs and horizon.
  const seStrategy = Math.max(ev.se, boot.perTrade.se);
  const diff = ev.mean - pl.mean;
  const need = th.placeboSeMultiple * seStrategy;
  const placeboVerdict: Verdict = pl.n < th.placeboMinDraws || ev.trades < 2 ? "INSUFFICIENT" : diff >= need ? "PASS" : "FAIL";
  add(5, "Beats the random-entry placebo", placeboVerdict, `strategy − placebo = ${pm(diff)}/trade vs ${th.placeboSeMultiple} × SE = ${rs(need)} required`, [
    `Strategy ${rs(ev.mean)}/trade, SE ${rs(ev.se)} i.i.d. / ${rs(boot.perTrade.se)} day-block (n = ${ev.trades}); SE used: the larger.`,
    `Placebo ${rs(pl.mean)}/trade, SE ${rs(pl.se)} i.i.d. / ${rs(pl.seDay)} day-clustered (${pl.n} draws, seed ${r.placebo.delayed.settings.seed}, ${r.placebo.delayed.settings.sizing} sizing, horizon: ${r.placebo.delayed.settings.horizon}).`,
    `Placebo hit ${pct(pl.hitRate)}, PF ${pl.profitFactor.toFixed(2)}, gross ${rs(pl.grossPerTrade)} + charges ${rs(pl.chargesPerTrade)}; exits ${Object.entries(pl.byExit).map(([k, v]) => `${k} ${v.n} (${rs(v.avg)})`).join(", ")}.`,
  ]);

  // 6. Day-block bootstrap.
  const bootVerdict: Verdict = boot.resamples < th.bootstrapResamples ? "INSUFFICIENT" : boot.perTrade.lo > 0 && boot.perSession.lo > 0 ? "PASS" : "FAIL";
  const lvl = `${Math.round(th.level * 100)}%`;
  add(6, "Day-block bootstrap", bootVerdict, `${lvl} CI lower bounds ${rs(boot.perTrade.lo)}/trade and ${rs(boot.perSession.lo)}/session (both must be > 0)`, [
    `Per trade: ${rs(boot.perTrade.estimate)} [${rs(boot.perTrade.lo)}, ${rs(boot.perTrade.hi)}], p(mean ≤ 0) = ${pval(boot.perTrade.p)}.`,
    `Per session: ${rs(boot.perSession.estimate)} [${rs(boot.perSession.lo)}, ${rs(boot.perSession.hi)}], p = ${pval(boot.perSession.p)} (${boot.sessions} sessions, sessions without trades count as ₹0).`,
    `${boot.resamples.toLocaleString("en-IN")} resamples of whole sessions, seed ${boot.seed}${boot.emptyResamples ? `; ${boot.emptyResamples} resamples drew no trade` : ""}.`,
  ]);

  // 7. Profit factor, drawdown, concentration.
  const dd = tradeDrawdown(r.delayed.trades, capital);
  const ddLimit = r.account === "main" ? th.maxDrawdownPctMain : r.cfg.risk.weeklyLossCapPct;
  const idx = contributions(r.delayed.trades, byIndex);
  const wk = contributions(r.delayed.trades, byWeek);
  const pfOk = ev.profitFactor >= th.minProfitFactor;
  const ddOk = dd.pctOfCapital <= ddLimit;
  const concOk = ev.net > 0 && (idx[0]?.share ?? 0) <= th.maxShare && (wk[0]?.share ?? 0) <= th.maxShare;
  const concText =
    ev.net > 0
      ? `largest index ${idx[0].key} ${pct(idx[0].share, 0)}, largest week ${wk[0].key} ${pct(wk[0].share, 0)} of net (≤ ${pct(th.maxShare, 0)})`
      : `not meaningful with net ${rs(ev.net)} ≤ 0 (by index: ${idx.map((c) => `${c.key} ${rs(c.net)}`).join(", ")})`;
  add(7, "Profit factor, drawdown, concentration", pfOk && ddOk && concOk ? "PASS" : "FAIL", `PF ${ev.profitFactor.toFixed(2)} (≥ ${th.minProfitFactor}) ${pfOk ? "ok" : "fails"}; max drawdown ${dd.pctOfCapital.toFixed(2)}% (≤ ${ddLimit}%) ${ddOk ? "ok" : "fails"}; concentration ${concOk ? "ok" : "fails"}`, [
    `Drawdown ${rs(dd.abs)} trade by trade (exit order) on ${rs(capital)} capital; limit ${ddLimit}% (${r.account === "main" ? "main" : "the account's weekly loss cap"}).`,
    `Concentration: ${concText}.`,
  ]);

  // 8. Robustness to ±fraction perturbations.
  const perts = (r.perturbations ?? []).filter((p) => !p.error);
  if (!r.perturbations) add(8, "Robustness (±20% one at a time)", "INSUFFICIENT", "perturbation runs were skipped (--no-perturb)");
  else {
    const base = ev.net;
    const positive = perts.filter((p) => p.net > 0).length;
    const rel = (p: PerturbationOutcome) => (base !== 0 ? (p.net - base) / Math.abs(base) : p.net >= 0 ? 0 : -Infinity);
    const worst = perts.reduce<PerturbationOutcome | null>((w, p) => (w === null || rel(p) < rel(w) ? p : w), null);
    const share = perts.length ? positive / perts.length : 0;
    const floorOk = worst === null || rel(worst) >= th.perturbFloor;
    const ok = perts.length > 0 && share >= th.perturbMinPositiveShare && floorOk;
    add(8, `Robustness (±${Math.round(th.perturbFraction * 100)}% one at a time)`, perts.length === 0 ? "INSUFFICIENT" : ok ? "PASS" : "FAIL", `${positive}/${perts.length} perturbations net > 0 (need ≥ ${pct(th.perturbMinPositiveShare, 0)}); worst ${worst ? `${worst.param} ×${worst.factor} ${rs(worst.net)} (${base !== 0 ? pct(rel(worst), 0) : "n/a"} vs base ${rs(base)}, floor ${pct(th.perturbFloor, 0)})` : "n/a"}`, [
      ...perts.map((p) => `${p.param.padEnd(17)} ×${p.factor.toFixed(1)}  ${String(p.trades).padStart(4)} trades  net ${rs(p.net).padStart(10)}${base !== 0 ? `  (${pct(rel(p), 0)} vs base)` : ""}`),
      ...(r.perturbations ?? []).filter((p) => p.error).map((p) => `${p.param} ×${p.factor}: invalid config, not counted (${p.error})`),
    ]);
  }

  // 9. Multiple-testing control.
  let dsr: DeflatedSharpe | null = null;
  if (!ctx.ledger) add(9, "Multiple-testing control", "INSUFFICIENT", "no trials ledger (--trial-ledger): N_trials unknown");
  else {
    const n = ctx.ledger.n;
    const level = bonferroniAlpha(th.alpha, n);
    const p = Math.max(boot.perTrade.p, boot.perSession.p);
    dsr = deflatedSharpe(sessionReturns(sessionPnls(r.delayed.trades, days), capital), n, ctx.ledger.srVariance);
    const vSource = ctx.ledger.srVariance !== null ? `variance of ${ctx.ledger.srTrials} logged strategy trials` : "null sampling variance 1/(T−1) (fewer than 2 logged Sharpe ratios)";
    add(9, "Multiple-testing control", p < level ? "PASS" : "FAIL", `bootstrap p = ${pval(p)} vs Bonferroni ${th.alpha}/${n} = ${pval(level)}; deflated Sharpe ratio ${dsr.dsr.toFixed(3)}`, [
      `N_trials = ${n} lines in ${ctx.ledger.path} (${Object.entries(ctx.ledger.byKind).map(([k, v]) => `${k} ${v}`).join(", ")}${ctx.ledger.invalid ? `, ${ctx.ledger.invalid} unreadable` : ""}); p is the larger of the per-trade and per-session bootstrap p-values.`,
      `DSR (Bailey & López de Prado 2014) on net P&L per session: SR ${dsr.sr.toFixed(3)}/session (${(dsr.sr * Math.sqrt(252)).toFixed(2)} annualized), T ${dsr.T}, skew ${dsr.skew.toFixed(2)}, kurtosis ${dsr.kurtosis.toFixed(2)}; SR₀ ${dsr.sr0.toFixed(3)} from N ${dsr.nTrials} and V[SR] ${dsr.srVariance.toExponential(2)} (${vSource}); PSR(0) ${dsr.psr.toFixed(3)}. DSR ≥ 0.95 would be significant at 5%.`,
    ]);
  }

  // 10-11. Need other work packages.
  add(10, "Real-price sanity", "N/A", "needs WP6: bhavcopy prices for each contract and a calibrated IV multiplier; every premium here is synthetic (Black–Scholes on India VIX)");
  add(11, "No look-ahead", "N/A", "needs WP8's sign-off on this variant's code paths (point-in-time replay audited in PLAN §1.4, not a sign-off)");

  // 12. Both accounts.
  if (r.account !== "main") add(12, "Both accounts", "N/A", `this is ${label}'s own evaluation (its premium-band strikes, one-lot sizing, exits and caps); main is reported separately`);
  else if (!ctx.followers?.length) add(12, "Both accounts", "INSUFFICIENT", "small accounts not evaluated in this run (add --account small10k or small5k); a pass on main does not transfer");
  else {
    const v = overallVerdict(ctx.followers.map((f) => f.verdict));
    add(12, "Both accounts", v, ctx.followers.map((f) => `${f.label}: ${f.verdict}`).join("; "), ["Each small account is judged on its own trades, placebo and caps (report below)."]);
  }

  return {
    account: r.account,
    label,
    from: ctx.from,
    to: ctx.to,
    verdict: overallVerdict(criteria.map((c) => c.verdict)),
    criteria,
    evaluation: ev,
    noDelay: nd,
    placebo: { delayed: pl, noDelay: plNd, settings: r.placebo.delayed.settings },
    bootstrap: boot,
    dsr,
    copyDelay: copy,
  };
}

/** Comparison table: strategy and placebo, with and without the copy delay ("SE day": day-block / day-clustered). */
export function formatComparison(rep: ProtocolReport): string {
  const opt = (x: number | null, f: (v: number) => string) => (x === null ? "" : f(x));
  const row = (name: string, n: number, m: number, se: number, seDay: number | null, hit: number, pf: number, net: number | null) => [
    name,
    String(n),
    rs(m),
    rs(se),
    opt(seDay, (v) => rs(v)),
    pct(hit, 1),
    pf.toFixed(2),
    opt(net, (v) => rs(v)),
  ];
  const { noDelay: nd, evaluation: ev, placebo: pl } = rep;
  const rows = [
    ["", "trades", "₹/trade", "SE iid", "SE day", "hit", "PF", "net"],
    row("strategy, engine fills", nd.trades, nd.mean, nd.se, null, nd.hitRate, nd.profitFactor, nd.net),
    row("strategy, copy delay", ev.trades, ev.mean, ev.se, rep.bootstrap.perTrade.se, ev.hitRate, ev.profitFactor, ev.net),
    row("placebo, engine fills", pl.noDelay.n, pl.noDelay.mean, pl.noDelay.se, pl.noDelay.seDay, pl.noDelay.hitRate, pl.noDelay.profitFactor, null),
    row("placebo, copy delay", pl.delayed.n, pl.delayed.mean, pl.delayed.se, pl.delayed.seDay, pl.delayed.hitRate, pl.delayed.profitFactor, null),
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")).join("\n");
}

/** The protocol report as text: one line per criterion with its numbers underneath. */
export function formatProtocol(rep: ProtocolReport): string {
  const out: string[] = [];
  out.push(`=== Acceptance protocol (PLAN §5): ${rep.label}, ${rep.from} .. ${rep.to} (${rep.evaluation.sessions} sessions) ===`);
  out.push(`Evaluation run (copy delay: ${describeCopyDelay(rep.copyDelay)}): ${rep.evaluation.trades} trades, net ${rs(rep.evaluation.net)}, ${rs(rep.evaluation.mean)}/trade.`);
  out.push("");
  out.push(formatComparison(rep));
  out.push("");
  for (const c of rep.criteria) {
    out.push(`${String(c.id).padStart(2)}  ${c.verdict.padEnd(12)}  ${c.title}: ${c.summary}`);
    for (const l of c.lines) out.push(`                  ${l}`);
  }
  out.push("");
  out.push(`Overall: ${rep.verdict}${rep.verdict === "PASS" ? "" : " (do not enable on any paper account)"}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Ledger lines
// ---------------------------------------------------------------------------

/** Ledger fields of one backtest run (the caller adds ts, wp, variant, params, data, notes). */
export function backtestTrial(out: BacktestOutput, capital: number, kind: TrialKind, account: AccountId): Pick<TrialRecord, "trades" | "net" | "kind" | "account" | "sessions" | "meanPerTrade" | "srSession"> {
  const s = tradeStats(out.trades, out.days, capital);
  return { trades: s.trades, net: s.net, kind, account, sessions: s.sessions, meanPerTrade: Math.round(s.mean * 100) / 100, srSession: Math.round(s.srSession * 1e6) / 1e6 };
}

/** Ledger fields of one placebo run. */
export function placeboTrial(p: PlaceboResult, account: AccountId): Pick<TrialRecord, "trades" | "net" | "kind" | "account" | "meanPerTrade"> {
  return { trades: p.summary.n, net: Math.round(p.trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100, kind: "placebo", account, meanPerTrade: p.summary.mean };
}
