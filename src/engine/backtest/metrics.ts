/**
 * Backtest metrics: expectancy, hit rate, profit factor, Sharpe/Sortino on daily P&L, drawdown,
 * attribution, and the evaluation statistics of the acceptance protocol: day-block bootstrap
 * confidence intervals, the probabilistic and deflated Sharpe ratios (Bailey & López de Prado),
 * Bonferroni thresholds, trade-sequence drawdown and P&L concentration.
 */
import { istDate, istWeekStart } from "../clock";
import type { DayLedger, IndexId, SignalSource, TradeRecord } from "../types";
import { SIGNAL_SOURCES } from "../types";
import { mean, quantile, stdev } from "../util/math";

export interface Summary {
  trades: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  netPnl: number;
  grossPnl: number;
  charges: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  avgHoldingMin: number;
  tradesPerDay: number;
  /** Share of fills priced from real option data (vs the synthetic pricer). */
  realPriceShare: number;
  /** Charges as a share of gross profit on winning trades (friction). */
  costShare: number;
  days: number;
}

export interface SourceStats {
  source: SignalSource;
  index: IndexId | "ALL";
  trades: number;
  wins: number;
  hitRate: number;
  expectancyPct: number;
  expectancyRupees: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  tStat: number;
  /** P&L attributed by entry attribution shares (sums to net P&L across sources). */
  attributedPnl: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function profitFactor(pnls: number[]): number {
  const wins = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const losses = -pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0);
  if (losses === 0) return wins > 0 ? 99 : 0;
  return Math.min(99, wins / losses);
}

export function tStat(xs: number[]): number {
  if (xs.length < 2) return 0;
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / (sd / Math.sqrt(xs.length)) : 0;
}

/** Daily equity path from ledgers (sorted by date): start equity, then end-of-day equity per day. */
export function equityPath(ledgers: DayLedger[], startEquity: number): { date: string; equity: number; ret: number }[] {
  let equity = startEquity;
  return [...ledgers]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) => {
      const net = l.realized + l.unrealized - l.charges;
      const ret = equity > 0 ? net / equity : 0;
      equity += net;
      return { date: l.date, equity, ret };
    });
}

export function maxDrawdown(path: { equity: number }[], startEquity: number): { abs: number; pct: number } {
  let peak = startEquity;
  let abs = 0;
  let pct = 0;
  for (const p of path) {
    peak = Math.max(peak, p.equity);
    const dd = peak - p.equity;
    if (dd > abs) abs = dd;
    if (peak > 0 && dd / peak > pct) pct = dd / peak;
  }
  return { abs, pct };
}

export function summarize(trades: TradeRecord[], ledgers: DayLedger[], startEquity: number, realPriceShare = 0): Summary {
  const pnls = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.pnl > 0);
  const path = equityPath(ledgers, startEquity);
  const rets = path.map((p) => p.ret);
  const sd = stdev(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const dd = maxDrawdown(path, startEquity);
  const winGross = wins.reduce((s, t) => s + Math.max(0, t.grossPnl), 0);
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  return {
    trades: trades.length,
    hitRate: trades.length ? r4(wins.length / trades.length) : 0,
    expectancyPct: trades.length ? r2(mean(trades.map((t) => t.pnlPctPremium))) : 0,
    expectancyRupees: trades.length ? r2(mean(pnls)) : 0,
    netPnl: r2(pnls.reduce((s, p) => s + p, 0)),
    grossPnl: r2(trades.reduce((s, t) => s + t.grossPnl, 0)),
    charges: r2(charges),
    maxDrawdown: r2(dd.abs),
    maxDrawdownPct: r2(dd.pct * 100),
    profitFactor: r2(profitFactor(pnls)),
    sharpe: rets.length > 1 && sd > 0 ? r2((mean(rets) / sd) * Math.sqrt(252)) : 0,
    sortino: rets.length > 1 && downside > 0 ? r2((mean(rets) / downside) * Math.sqrt(252)) : 0,
    avgHoldingMin: trades.length ? Math.round(mean(trades.map((t) => t.holdingMin))) : 0,
    tradesPerDay: ledgers.length ? r2(trades.length / ledgers.length) : 0,
    realPriceShare: r4(realPriceShare),
    costShare: winGross > 0 ? r4(charges / winGross) : 0,
    days: ledgers.length,
  };
}

/** Per-source statistics by dominant source, plus P&L attributed by entry shares. */
export function attribution(trades: TradeRecord[]): SourceStats[] {
  const out: SourceStats[] = [];
  for (const source of SIGNAL_SOURCES) {
    const own = trades.filter((t) => t.dominantSource === source);
    const attributed = trades.reduce((s, t) => s + t.pnl * (t.attribution.find((a) => a.source === source)?.share ?? 0), 0);
    if (own.length === 0 && Math.abs(attributed) < 0.005) continue;
    const pct = own.map((t) => t.pnlPctPremium);
    const winsPct = pct.filter((p) => p > 0);
    const lossPct = pct.filter((p) => p <= 0);
    out.push({
      source,
      index: "ALL",
      trades: own.length,
      wins: own.filter((t) => t.pnl > 0).length,
      hitRate: own.length ? r4(own.filter((t) => t.pnl > 0).length / own.length) : 0,
      expectancyPct: own.length ? r2(mean(pct)) : 0,
      expectancyRupees: own.length ? r2(mean(own.map((t) => t.pnl))) : 0,
      avgWinPct: winsPct.length ? r2(mean(winsPct)) : 0,
      avgLossPct: lossPct.length ? r2(mean(lossPct)) : 0,
      profitFactor: r2(profitFactor(own.map((t) => t.pnl))),
      tStat: r2(tStat(pct)),
      attributedPnl: r2(attributed),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation statistics for the acceptance protocol
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) for reproducible placebo draws, shuffles and bootstrap resamples. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal CDF: Hart's algorithm 5666 in West's (2005) double-precision form. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      c = e / d / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Inverse standard normal CDF: Wichura's AS 241 (PPND16), about 1e-16 relative accuracy. */
export function normInv(p: number): number {
  if (!(p > 0)) return p === 0 ? -Infinity : NaN;
  if (!(p < 1)) return p === 1 ? Infinity : NaN;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    const num =
      ((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r +
        133.14166789178437745) *
        r +
      3.387132872796366608;
    const den =
      ((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r +
        42.313330701600911252) *
        r +
      1;
    return (q * num) / den;
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let num: number;
  let den: number;
  if (r <= 5) {
    r -= 1.6;
    num =
      ((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r +
        4.6303378461565452959) *
        r +
      1.42343711074968357734;
    den =
      ((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r +
        2.05319162663775882187) *
        r +
      1;
  } else {
    r -= 5;
    num =
      ((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r +
        5.4637849111641143699) *
        r +
      6.6579046435011037772;
    den =
      ((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r +
        0.59983220655588793769) *
        r +
      1;
  }
  return q < 0 ? -num / den : num / den;
}

/** Mean, sample standard deviation, skewness m3/m2^1.5 and non-excess kurtosis m4/m2² (normal: 0 and 3). */
export function moments(xs: readonly number[]): { mean: number; sd: number; skew: number; kurtosis: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, skew: 0, kurtosis: 3 };
  const m = mean(xs);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return { mean: m, sd: stdev(xs), skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurtosis: m2 > 0 ? m4 / (m2 * m2) : 3 };
}

/** Net P&L of one session's trades (an empty list for a session without trades). */
export interface SessionPnl {
  day: string;
  pnls: number[];
}

/** Trades grouped by the IST date of entry, with every session of `days` present (sessions without trades count). */
export function sessionPnls(trades: readonly Pick<TradeRecord, "entryMs" | "pnl">[], days: readonly string[]): SessionPnl[] {
  const by = new Map<string, number[]>(days.map((d) => [d, []]));
  for (const t of trades) {
    const day = istDate(t.entryMs);
    const list = by.get(day);
    if (list) list.push(t.pnl);
    else by.set(day, [t.pnl]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnls]) => ({ day, pnls }));
}

/** Net P&L per session as a return on `capital` (sessions without trades are 0). */
export function sessionReturns(sessions: readonly SessionPnl[], capital: number): number[] {
  return sessions.map((s) => (capital > 0 ? s.pnls.reduce((a, b) => a + b, 0) / capital : 0));
}

/**
 * Standard error of the mean of all values when values in the same group (a session) are correlated:
 * the cluster-robust (CR1) estimator sqrt(G / (G − 1) · Σ_g (Σ_{i∈g} (x_i − x̄))²) / n.
 */
export function clusteredSe(groups: readonly (readonly number[])[]): number {
  const all = groups.flat();
  const g = groups.filter((x) => x.length > 0).length;
  if (all.length < 2 || g < 2) return 0;
  const m = mean(all);
  let s = 0;
  for (const grp of groups) {
    let r = 0;
    for (const x of grp) r += x - m;
    s += r * r;
  }
  return Math.sqrt((g / (g - 1)) * s) / all.length;
}

export interface BootstrapStat {
  /** The statistic on the original sample. */
  estimate: number;
  /** Percentile confidence interval. */
  lo: number;
  hi: number;
  /** Standard deviation of the bootstrap distribution. */
  se: number;
  /** One-sided bootstrap p-value for "true value <= 0": (1 + #{resamples <= 0}) / (1 + resamples). */
  p: number;
}

export interface BlockBootstrap {
  resamples: number;
  seed: number;
  level: number;
  sessions: number;
  trades: number;
  /** Mean net ₹ per trade. */
  perTrade: BootstrapStat;
  /** Mean net ₹ per session (sessions without trades count as 0). */
  perSession: BootstrapStat;
  /** Resamples that drew no trade at all (left out of the per-trade distribution). */
  emptyResamples: number;
}

/**
 * Day-block bootstrap: each resample draws as many sessions as the sample has, with replacement,
 * and keeps all trades of a drawn session together, so the correlation of trades taken on the same
 * day (same market) is preserved. Percentile intervals; seeded, so results reproduce.
 */
export function dayBlockBootstrap(sessions: readonly SessionPnl[], o: { resamples?: number; seed?: number; level?: number } = {}): BlockBootstrap {
  const resamples = Math.max(1, Math.floor(o.resamples ?? 10_000));
  const seed = o.seed ?? 7;
  const level = o.level ?? 0.95;
  const rnd = seededRandom(seed);
  const d = sessions.length;
  const sums = sessions.map((s) => s.pnls.reduce((a, b) => a + b, 0));
  const counts = sessions.map((s) => s.pnls.length);
  const total = sums.reduce((a, b) => a + b, 0);
  const n = counts.reduce((a, b) => a + b, 0);
  const perTrade: number[] = [];
  const perSession: number[] = [];
  let emptyResamples = 0;
  for (let b = 0; b < resamples && d > 0; b++) {
    let s = 0;
    let k = 0;
    for (let j = 0; j < d; j++) {
      const i = Math.floor(rnd() * d);
      s += sums[i];
      k += counts[i];
    }
    perSession.push(s / d);
    if (k > 0) perTrade.push(s / k);
    else emptyResamples++;
  }
  const tail = (1 - level) / 2;
  const stat = (estimate: number, dist: number[]): BootstrapStat => ({
    estimate,
    lo: quantile(dist, tail),
    hi: quantile(dist, 1 - tail),
    se: stdev(dist),
    p: (1 + dist.filter((x) => x <= 0).length) / (1 + dist.length),
  });
  return {
    resamples,
    seed,
    level,
    sessions: d,
    trades: n,
    perTrade: stat(n > 0 ? total / n : 0, perTrade),
    perSession: stat(d > 0 ? total / d : 0, perSession),
    emptyResamples,
  };
}

const EULER_GAMMA = 0.5772156649015329;

/**
 * Probabilistic Sharpe ratio (Bailey & López de Prado 2012): the probability that the true Sharpe
 * ratio exceeds `benchmark`, given the estimate `sr` from `T` observations with skewness `skew` and
 * non-excess kurtosis `kurtosis`. Sharpe ratios are per observation period (not annualized).
 */
export function probabilisticSharpe(sr: number, T: number, skew: number, kurtosis: number, benchmark = 0): number {
  if (!(T > 1)) return NaN;
  const v = 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr;
  if (!(v > 0)) return NaN;
  return normCdf(((sr - benchmark) * Math.sqrt(T - 1)) / Math.sqrt(v));
}

/**
 * Expected maximum of `nTrials` independent Sharpe ratio estimates with variance `variance` when
 * every true Sharpe ratio is zero (Bailey & López de Prado 2014):
 * SR₀ = √V · ((1 − γ) Φ⁻¹(1 − 1/N) + γ Φ⁻¹(1 − 1/(N·e))), γ the Euler–Mascheroni constant; 0 for one trial.
 */
export function expectedMaxSharpe(nTrials: number, variance: number): number {
  const n = Math.floor(nTrials);
  if (!(n > 1) || !(variance > 0)) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / n) + EULER_GAMMA * normInv(1 - 1 / (n * Math.E)));
}

export interface DeflatedSharpe {
  /** Sharpe ratio per observation (not annualized). */
  sr: number;
  T: number;
  skew: number;
  kurtosis: number;
  nTrials: number;
  /** Variance of the trials' Sharpe ratio estimates used for SR₀. */
  srVariance: number;
  /** Expected maximum Sharpe ratio of the trials under the null: the deflated benchmark. */
  sr0: number;
  /** Probabilistic Sharpe ratio against 0 (no deflation). */
  psr: number;
  /** Deflated Sharpe ratio: PSR against SR₀. Above 0.95 is significant at 5% after deflation. */
  dsr: number;
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014, Journal of Portfolio Management 40(5)) of a
 * return series selected after `nTrials` trials. `srVariance` is the variance of the Sharpe ratios
 * estimated across the trials (same period); without it, the sampling variance of a Sharpe ratio
 * estimate under the null, 1/(T − 1), is used.
 */
export function deflatedSharpe(returns: readonly number[], nTrials: number, srVariance?: number | null): DeflatedSharpe {
  const m = moments(returns);
  const T = returns.length;
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const variance = srVariance !== undefined && srVariance !== null && srVariance > 0 ? srVariance : T > 1 ? 1 / (T - 1) : 0;
  const sr0 = expectedMaxSharpe(nTrials, variance);
  return {
    sr,
    T,
    skew: m.skew,
    kurtosis: m.kurtosis,
    nTrials: Math.max(1, Math.floor(nTrials)),
    srVariance: variance,
    sr0,
    psr: probabilisticSharpe(sr, T, m.skew, m.kurtosis, 0),
    dsr: probabilisticSharpe(sr, T, m.skew, m.kurtosis, sr0),
  };
}

/** Bonferroni per-test significance level for `nTrials` tests at family-wise level `alpha`. */
export function bonferroniAlpha(alpha: number, nTrials: number): number {
  return alpha / Math.max(1, Math.floor(nTrials));
}

/** Largest peak-to-trough fall of cumulative net P&L, trade by trade in exit order (rupees and % of capital). */
export function tradeDrawdown(trades: readonly Pick<TradeRecord, "exitMs" | "pnl">[], capital: number): { abs: number; pctOfCapital: number } {
  let cum = 0;
  let peak = 0;
  let abs = 0;
  for (const t of [...trades].sort((a, b) => a.exitMs - b.exitMs)) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    abs = Math.max(abs, peak - cum);
  }
  return { abs: r2(abs), pctOfCapital: capital > 0 ? (abs / capital) * 100 : 0 };
}

export interface Contribution {
  key: string;
  trades: number;
  net: number;
  /** Share of the total net P&L (meaningful only when the total is positive). */
  share: number;
}

/** Net P&L by group (index, ISO week, ...) with each group's share of the total, largest share first. */
export function contributions(trades: readonly TradeRecord[], keyOf: (t: TradeRecord) => string): Contribution[] {
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const by = new Map<string, { trades: number; net: number }>();
  for (const t of trades) {
    const k = keyOf(t);
    const e = by.get(k) ?? { trades: 0, net: 0 };
    e.trades++;
    e.net += t.pnl;
    by.set(k, e);
  }
  return [...by].map(([key, e]) => ({ key, trades: e.trades, net: r2(e.net), share: total !== 0 ? e.net / total : 0 })).sort((a, b) => b.share - a.share);
}

/** Grouping keys for contributions(): the index, and the Monday of the IST week of entry. */
export const byIndex = (t: TradeRecord): string => t.index;
export const byWeek = (t: TradeRecord): string => istWeekStart(t.entryMs);
