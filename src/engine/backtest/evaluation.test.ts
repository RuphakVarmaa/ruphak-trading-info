import { describe, expect, it } from "vitest";
import { istAt, MINUTE_MS } from "../clock";
import { DEFAULT_CONFIG, withOverrides } from "../config";
import type { TradeRecord } from "../types";
import {
  bonferroniAlpha,
  byIndex,
  byWeek,
  clusteredSe,
  contributions,
  dayBlockBootstrap,
  deflatedSharpe,
  expectedMaxSharpe,
  moments,
  normCdf,
  normInv,
  probabilisticSharpe,
  seededRandom,
  sessionPnls,
  summarize,
  tradeDrawdown,
} from "./metrics";
import { summarizePlacebo, type PlaceboResult, type PlaceboTrade } from "./placebo";
import { evaluateProtocol, formatProtocol, overallVerdict, PERTURB_PARAMS, perturbParams, PROTOCOL, type AccountRuns, type ProtocolContext } from "./protocol";
import type { BacktestOutput } from "./runBacktest";
import { formatTrial, parseTrials, sharpeVariance, TrialLedger, type TrialRecord } from "./trials";

describe("normal distribution", () => {
  it("matches reference values and inverts", () => {
    expect(normCdf(0)).toBe(0.5);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 12);
    expect(normInv(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normInv(0.01)).toBeCloseTo(-2.3263478740408408, 12);
    expect(normInv(1e-10)).toBeCloseTo(-6.361340902404056, 9);
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    for (const p of [0.001, 0.2, 0.5, 0.77, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 12);
  });
});

describe("probabilistic and deflated Sharpe ratio", () => {
  it("reproduces the Bailey & López de Prado (2014) worked example (DSR ≈ 0.9004)", () => {
    // Annualized SR 2.5 over 5 years of daily data, skew -3, kurtosis 10, 100 trials with V[SR] 0.5 (annualized).
    const sr0 = expectedMaxSharpe(100, 0.5 / 250);
    expect(sr0 * Math.sqrt(250)).toBeCloseTo(1.7894, 3);
    expect(probabilisticSharpe(2.5 / Math.sqrt(250), 1250, -3, 10, sr0)).toBeCloseTo(0.9004, 4);
  });

  it("deflates more with more trials and needs no deflation for one", () => {
    expect(expectedMaxSharpe(1, 0.01)).toBe(0);
    expect(expectedMaxSharpe(10, 0.01)).toBeLessThan(expectedMaxSharpe(1000, 0.01));
    const rnd = seededRandom(3);
    const rets = Array.from({ length: 250 }, () => 0.001 + (rnd() - 0.5) * 0.02);
    const one = deflatedSharpe(rets, 1);
    const many = deflatedSharpe(rets, 500);
    expect(one.dsr).toBeCloseTo(one.psr, 12);
    expect(many.dsr).toBeLessThan(one.dsr);
    expect(many.srVariance).toBeCloseTo(1 / 249, 12);
    expect(deflatedSharpe(rets, 500, 0.02).srVariance).toBe(0.02);
  });

  it("computes moments", () => {
    const m = moments([1, 2, 3, 4, 100]);
    expect(m.mean).toBe(22);
    expect(m.skew).toBeGreaterThan(1);
    expect(m.kurtosis).toBeGreaterThan(3);
    expect(moments([5, 5, 5])).toMatchObject({ sd: 0, skew: 0, kurtosis: 3 });
  });

  it("splits the family-wise level across trials", () => {
    expect(bonferroniAlpha(0.05, 50)).toBeCloseTo(0.001, 12);
    expect(bonferroniAlpha(0.05, 0)).toBe(0.05);
  });
});

const trade = (day: string, pnl: number, over: Partial<TradeRecord> = {}): TradeRecord => ({
  positionId: "p",
  index: "NIFTY",
  side: "BULL",
  mode: "BACKTEST",
  tradingSymbol: "X",
  entryMs: istAt(day, "10:00"),
  exitMs: istAt(day, "11:00"),
  holdingMin: 60,
  entryPremium: 100,
  exitPremium: 100,
  qty: 65,
  pnl,
  grossPnl: pnl + 70,
  pnlPctPremium: pnl / 65,
  charges: 70,
  maePct: 0,
  mfePct: 0,
  regime: "RANGE",
  exitReason: "TIME_STOP",
  convictionAtEntry: 0.5,
  dominantSource: "MOMENTUM",
  attribution: [],
  ...over,
});

describe("day-block bootstrap", () => {
  const days = ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"];

  it("groups trades by session and keeps sessions without trades", () => {
    const s = sessionPnls([trade("2026-10-05", 10), trade("2026-10-05", -4), trade("2026-10-07", 3)], days);
    expect(s.map((x) => x.pnls)).toEqual([[], [10, -4], [], [3]]);
  });

  it("is reproducible, brackets the estimate and counts empty sessions per session", () => {
    const rnd = seededRandom(11);
    const many = Array.from({ length: 60 }, (_, i) => `2026-0${7 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`);
    const trades = many.flatMap((d, i) => (i % 3 === 0 ? [] : [trade(d, 200 + (rnd() - 0.5) * 2000), trade(d, -100 + (rnd() - 0.5) * 2000)]));
    const sessions = sessionPnls(trades, many);
    const a = dayBlockBootstrap(sessions, { resamples: 2_000, seed: 5 });
    const b = dayBlockBootstrap(sessions, { resamples: 2_000, seed: 5 });
    expect(a).toEqual(b);
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    expect(a.perTrade.estimate).toBeCloseTo(total / trades.length, 9);
    expect(a.perSession.estimate).toBeCloseTo(total / many.length, 9);
    expect(a.perTrade.lo).toBeLessThan(a.perTrade.estimate);
    expect(a.perTrade.hi).toBeGreaterThan(a.perTrade.estimate);
    expect(a.sessions).toBe(60);
    expect(a.trades).toBe(80);
  });

  it("gives a positive lower bound and the smallest p-value when every session wins", () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, pnls: [100 + i] }));
    const r = dayBlockBootstrap(sessions, { resamples: 1_000, seed: 1 });
    expect(r.perTrade.lo).toBeGreaterThan(0);
    expect(r.perSession.lo).toBeGreaterThan(0);
    expect(r.perTrade.p).toBeCloseTo(1 / 1001, 12);
  });

  it("clusters standard errors by session (singletons give the i.i.d. SE)", () => {
    const xs = [3, -1, 4, 1, -5, 9, 2, -6];
    const iid = Math.sqrt(xs.reduce((s, x) => s + (x - 0.875) ** 2, 0) / 7) / Math.sqrt(8);
    expect(clusteredSe(xs.map((x) => [x]))).toBeCloseTo(iid, 12);
    // Perfectly correlated pairs: clustering doubles the effective noise relative to i.i.d.
    expect(clusteredSe([[5, 5], [-5, -5], [5, 5], [-5, -5]])).toBeGreaterThan(clusteredSe([[5], [5], [-5], [-5], [5], [5], [-5], [-5]]));
  });
});

describe("drawdown and concentration", () => {
  it("measures trade-by-trade drawdown in exit order", () => {
    const ts = [trade("2026-10-01", 1000), trade("2026-10-05", -3000), trade("2026-10-06", 500), trade("2026-10-07", -1000)];
    const dd = tradeDrawdown(ts, 100_000);
    expect(dd.abs).toBe(3500);
    expect(dd.pctOfCapital).toBeCloseTo(3.5, 12);
    // Order of the input does not matter: trades are taken in exit order.
    expect(tradeDrawdown([...ts].reverse(), 100_000).abs).toBe(3500);
  });

  it("shares net P&L by index and week", () => {
    const ts = [trade("2026-10-01", 300), trade("2026-10-05", 900, { index: "SENSEX" }), trade("2026-10-06", -200)];
    const idx = contributions(ts, byIndex);
    expect(idx[0]).toMatchObject({ key: "SENSEX", net: 900 });
    expect(idx.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 12);
    const wk = contributions(ts, byWeek);
    expect(wk.map((c) => c.key).sort()).toEqual(["2026-09-28", "2026-10-05"]);
  });
});

describe("trials ledger", () => {
  const rec = (over: Partial<TrialRecord> = {}): TrialRecord => ({ ts: "2026-10-09T10:00:00.000Z", wp: "WP0", variant: "v", params: { a: 1 }, data: "snap", trades: 51, net: -9595.92, notes: "n", ...over });

  it("formats valid lines and refuses invalid ones", () => {
    expect(formatTrial(rec())).toMatch(/^\{.*\}\n$/);
    expect(() => formatTrial(rec({ net: Number.NaN }))).toThrow(/net/);
    expect(() => formatTrial({ ...rec(), ts: "yesterday" })).toThrow(/ts/);
  });

  it("appends only and counts every line, damaged ones included", () => {
    const file: { text: string | null } = { text: null };
    const ledger = new TrialLedger({ read: () => file.text, append: (t) => (file.text = (file.text ?? "") + t) }, "mem");
    expect(ledger.stats().n).toBe(0);
    ledger.append(rec({ kind: "strategy", srSession: -0.1 }), rec({ kind: "placebo", srSession: 5 }));
    ledger.append(rec({ kind: "perturbation", srSession: 0.1 }));
    file.text += "{not json\n\n";
    const s = ledger.stats();
    expect(s).toMatchObject({ n: 4, valid: 3, invalid: 1, byKind: { strategy: 1, placebo: 1, perturbation: 1 } });
    // Placebo runs are not strategies: their Sharpe ratios stay out of the variance.
    expect(s.srTrials).toBe(2);
    expect(s.srVariance).toBeCloseTo(0.02, 12);
    expect(parseTrials(file.text ?? "").records).toHaveLength(3);
    expect(sharpeVariance([rec({ srSession: 1 })]).variance).toBeNull();
  });
});

describe("perturbation driver", () => {
  it("scales each parameter by ±20% into a valid config", () => {
    for (const p of PERTURB_PARAMS) {
      for (const f of [0.8, 1.2]) expect(() => withOverrides(DEFAULT_CONFIG, p.patch(DEFAULT_CONFIG, f))).not.toThrow();
    }
    const stop = withOverrides(DEFAULT_CONFIG, perturbParams("stop")[0].patch(DEFAULT_CONFIG, 1.2));
    expect(stop.exits.stopPct).toBeCloseTo(-36, 9);
    const h = withOverrides(DEFAULT_CONFIG, perturbParams("time-stop")[0].patch(DEFAULT_CONFIG, 0.8));
    expect(h.exits.horizonMinByRegime).toEqual({ TREND_UP: 96, TREND_DOWN: 96, RANGE: 72, HIGH_VOL: 48, EVENT: 144 });
    const thr = withOverrides(DEFAULT_CONFIG, perturbParams("thresholds")[0].patch(DEFAULT_CONFIG, 1.2));
    expect(thr.conviction.thresholds.RANGE).toBeCloseTo(0.66, 9);
    expect(perturbParams("all")).toHaveLength(PERTURB_PARAMS.length);
    expect(perturbParams("stop,target").map((p) => p.name)).toEqual(["stop", "target"]);
    expect(() => perturbParams("lookback")).toThrow(/unknown/);
  });
});

/** A complete BacktestOutput around a trade list (only trades, days and notes matter to the verdicts). */
function fakeRun(trades: TradeRecord[], days: string[]): BacktestOutput {
  return { from: days[0], to: days[days.length - 1], days, skippedDays: [], trades, ledgers: [], summary: summarize(trades, [], 500_000), attribution: [], equityCurve: [], decisions: 0, notes: [] };
}

function fakePlacebo(mean: number, n: number, seed = 9): PlaceboResult {
  const rnd = seededRandom(seed);
  const trades: PlaceboTrade[] = Array.from({ length: n }, (_, i) => {
    const pnl = Math.round(mean + (rnd() - 0.5) * 3000);
    return { day: `d${i % 50}`, index: "NIFTY", side: "BULL", tradingSymbol: "X", expiry: "2025-01-07", strike: 24000, entryMs: 0, exitMs: 90 * MINUTE_MS, holdingMin: 90, regime: null, horizonMin: 90, lots: 1, qty: 65, entryPremium: 100, exitPremium: 100, grossPnl: pnl + 69, charges: 69, pnl, exitReason: "TIME_STOP" };
  });
  const settings = { draws: n, seed, sizing: "engine" as const, horizon: "fixed", window: "w", copyDelay: "c", sessions: 50, slots: 61, indices: ["NIFTY" as const], exits: { stopPct: -30, targetPct: 50, trailActivatePct: 30, trailGivebackPct: 50, timeStopMinPnlPct: 10, squareOffIst: "15:05" } };
  return { settings, attempts: n, rejected: {}, trades, summary: summarizePlacebo(trades) };
}

function sessionsOf(n: number): string[] {
  const out: string[] = [];
  for (let d = Date.UTC(2025, 0, 1); out.length < n; d += 86_400_000) {
    const w = new Date(d).getUTCDay();
    if (w !== 0 && w !== 6) out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

function fakeAccountRuns(o: { perTrade: (i: number) => number; trades: number; days: number; placeboMean: number; perturbNet?: number[] | null }): AccountRuns {
  const days = sessionsOf(o.days);
  const trades = Array.from({ length: o.trades }, (_, i) => trade(days[i % days.length], o.perTrade(i), { index: i % 2 ? "SENSEX" : "NIFTY", exitMs: istAt(days[i % days.length], "11:00") + i }));
  const run = fakeRun(trades, days);
  const perts = o.perturbNet === null ? null : (o.perturbNet ?? []).map((net, k) => ({ param: `p${k}`, factor: k % 2 ? 1.2 : 0.8, trades: o.trades, net }));
  return { account: "main", cfg: DEFAULT_CONFIG, copyDelay: PROTOCOL.copyDelay, noDelay: run, delayed: run, placebo: { noDelay: fakePlacebo(o.placeboMean, 3000), delayed: fakePlacebo(o.placeboMean, 3000) }, perturbations: perts };
}

const ctx = (over: Partial<ProtocolContext> = {}): ProtocolContext => ({
  from: "2025-01-01",
  to: "2025-12-31",
  frozen: null,
  ledger: { path: "mem", n: 10, valid: 10, invalid: 0, byKind: { strategy: 10 }, srVariance: null, srTrials: 0 },
  thresholds: PROTOCOL,
  bootstrap: { resamples: 10_000, seed: 7 },
  ...over,
});

describe("acceptance protocol verdicts", () => {
  it("fails a losing in-sample variant like today's engine and marks what it cannot decide", () => {
    const rnd = seededRandom(1);
    const runs = fakeAccountRuns({ trades: 51, days: 54, perTrade: () => -188 + (rnd() - 0.5) * 7000, placeboMean: -364, perturbNet: [-9000, -12000, 3000, -7000] });
    const rep = evaluateProtocol(runs, "Main account", ctx());
    const v = Object.fromEntries(rep.criteria.map((c) => [c.id, c.verdict]));
    expect(v).toMatchObject({ 1: "FAIL", 2: "FAIL", 3: "INSUFFICIENT", 4: "PASS", 7: "FAIL", 8: "FAIL", 10: "N/A", 11: "N/A", 12: "INSUFFICIENT" });
    expect(rep.criteria).toHaveLength(12);
    expect(rep.verdict).toBe("FAIL");
    const text = formatProtocol(rep);
    for (let id = 1; id <= 12; id++) expect(text).toMatch(new RegExp(`^ {0,1}${id}  (PASS|FAIL|INSUFFICIENT|N/A)`, "m"));
    expect(text).toMatch(/Overall: FAIL/);
  });

  it("passes every decidable criterion for a strong frozen rule but never reports an overall PASS while 10-11 are open", () => {
    const runs = fakeAccountRuns({ trades: 400, days: 200, perTrade: (i) => 1500 + ((i * 7919) % 1000) - 500, placeboMean: -364, perturbNet: Array(36).fill(500_000) });
    const rep = evaluateProtocol(runs, "Main account", ctx({ frozen: "Example (2024)", followers: [{ account: "small10k", label: "₹10k account", verdict: "INSUFFICIENT" }] }));
    const v = Object.fromEntries(rep.criteria.map((c) => [c.id, c.verdict]));
    for (const id of [1, 2, 3, 4, 5, 6, 8, 9]) expect(v[id]).toBe("PASS");
    // A steady winner spread across both indices and many weeks: only the drawdown/PF/concentration criterion is left to judge.
    expect(v[7]).toBe("PASS");
    expect(v[10]).toBe("N/A");
    expect(v[12]).toBe("INSUFFICIENT");
    expect(rep.verdict).toBe("INSUFFICIENT");
  });

  it("is insufficient without a ledger, without perturbations or with too few placebo draws", () => {
    const runs = fakeAccountRuns({ trades: 300, days: 150, perTrade: (i) => 900 + ((i * 31) % 400), placeboMean: -300, perturbNet: null });
    runs.placebo.delayed = fakePlacebo(-300, 500);
    const rep = evaluateProtocol(runs, "Main account", ctx({ ledger: null, frozen: "x" }));
    const v = Object.fromEntries(rep.criteria.map((c) => [c.id, c.verdict]));
    expect(v[5]).toBe("INSUFFICIENT");
    expect(v[8]).toBe("INSUFFICIENT");
    expect(v[9]).toBe("INSUFFICIENT");
  });

  it("cannot decide multiple testing once the Bonferroni level is below the bootstrap's smallest p-value", () => {
    const runs = fakeAccountRuns({ trades: 400, days: 200, perTrade: (i) => 1500 + ((i * 7919) % 1000) - 500, placeboMean: -364, perturbNet: Array(36).fill(500_000) });
    const ledger = (n: number) => ({ path: "mem", n, valid: n, invalid: 0, byKind: { strategy: n }, srVariance: null, srTrials: 0 });
    const verdict9 = (n: number, resamples: number) => evaluateProtocol(runs, "Main account", ctx({ frozen: "x", ledger: ledger(n), bootstrap: { resamples, seed: 7 } })).criteria.find((c) => c.id === 9)!;
    // 10,000 resamples resolve p down to 1/10,001: enough for 0.05/500, not for 0.05/501.
    expect(verdict9(500, 10_000).verdict).toBe("PASS");
    const c = verdict9(501, 10_000);
    expect(c.verdict).toBe("INSUFFICIENT");
    expect(c.summary).toMatch(/--bootstrap 10020 or more/);
    expect(verdict9(501, 10_020).verdict).toBe("PASS");
  });

  it("combines verdicts", () => {
    expect(overallVerdict(["PASS", "PASS"])).toBe("PASS");
    expect(overallVerdict(["PASS", "N/A"])).toBe("INSUFFICIENT");
    expect(overallVerdict(["INSUFFICIENT", "FAIL", "PASS"])).toBe("FAIL");
  });
});
