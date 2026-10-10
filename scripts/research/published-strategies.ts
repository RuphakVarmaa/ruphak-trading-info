/**
 * WP3/WP4 research runner: the published noise-area (Zarattini, Aziz & Barbon 2024/25) and 5-minute
 * ORB (Zarattini & Aziz 2023) rules on our instrument, tested honestly.
 *
 *   npx tsx scripts/research/published-strategies.ts --history <hist.json> --hourly <dir with NSEI/BSESN/INDIAVIX.json>
 *        --only engine|overlay|perturb|bias|delay|placebo|hourly|hourly-perturb|hourly-placebo|validate  [--out-dir dir] [--trials reports/trials.jsonl]
 *
 * engine          5-minute replays through the production cycles (BacktestRun): main (production limits,
 *                 one position per index) plus the ₹10k and ₹5k accounts as followers. The engine's
 *                 end-of-day per-source performance update (its Kelly/decay overlay) is disabled in these
 *                 runs, so they measure the published rule itself.
 * overlay         the same with the overlay on: what the engine would actually do in that mode.
 * perturb         ±20% of the noise area's lookback, band multiplier and decision interval and of ORB's
 *                 target R, one at a time (robustness only; nothing is chosen from these).
 * bias            pricer sensitivity: IV multiplier x 0.9 (the synthetic pricer overprices weeklies by ~10-12%).
 * delay           copy delay: each engine trade re-priced with entry and exit one 5-minute bar later and
 *                 2 extra ticks against us on each side (same decisions).
 * placebo         random entries on the same days and decision grid with the strategy's own exit rule
 *                 ("rule"), and with a holding time drawn from the strategy's own trades ("hold").
 * hourly*         2-year approximation on Yahoo hourly bars: decisions at hourly closes (10:15 ... 14:15),
 *                 bands from hourly closes, square-off at the 15:15 close, through the engine's planner,
 *                 paper broker, risk state and position cycle (exits before entries, so reversals are
 *                 exact); placebo as above.
 * validate        the hourly harness on the 5-minute snapshot (engine order) against the engine replay.
 *
 * Every run appends a line to the trials ledger. Option prices are synthetic (Black-Scholes on India VIX).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACCOUNT_IDS, accountConfig, type AccountId } from "../../src/engine/accounts";
import { computeCharges } from "../../src/engine/broker/charges";
import { BacktestRun, seededRandom } from "../../src/engine/backtest/runBacktest";
import { TradingCalendar, loadBundledHolidays } from "../../src/engine/calendar/calendar";
import { MINUTE_MS, SESSION, addDays, istAt, istDate, istMinutes, weekdayOf } from "../../src/engine/clock";
import { makeConfig, withOverrides, type DeepPartial, type EngineConfig } from "../../src/engine/config";
import { atmStrike } from "../../src/engine/instruments/instrumentMaster";
import { isMonthlyExpiry, optionGrowwSymbol, optionTradingSymbol } from "../../src/engine/instruments/syntheticInstruments";
import { neutralFeatures } from "../../src/engine/market/features";
import { ReplayMarketDataSource } from "../../src/engine/market/replayMarketData";
import { parseYahooChart } from "../../src/engine/market/yahooClient";
import { runEndOfDay } from "../../src/engine/pipeline/dayLifecycle";
import { submitEntry } from "../../src/engine/pipeline/execution";
import { runPositionCycle } from "../../src/engine/pipeline/positionCycle";
import { loadRiskState } from "../../src/engine/pipeline/riskState";
import type { InstrumentProvider } from "../../src/engine/ports";
import { SyntheticOptionQuotes, syntheticQuote } from "../../src/engine/pricing/syntheticOptionPricer";
import { haltReason } from "../../src/engine/risk/limits";
import { evaluateExits, markPosition } from "../../src/engine/strategy/exits";
import { choosePremiumBandContract } from "../../src/engine/strategy/optionSelect";
import { planEntry } from "../../src/engine/strategy/planner";
import {
  sessionsAt,
  idleSignal,
  noiseAreaDecision,
  orb5State,
  publishedConviction,
  publishedSignal,
  volTargetMultiplier,
  type PublishedSignal,
  type SessionBars,
} from "../../src/engine/strategy/published";
import type { NoiseAreaParams } from "../../src/engine/strategy/published/noiseArea";
import { orb5Params } from "../../src/engine/strategy/published/orb5";
import { sizePosition } from "../../src/engine/strategy/sizing";
import { createReplayDeps, type ReplayDeps } from "../../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type Conviction, type DayLedger, type IndexId, type OptionContract, type Position, type TradeSide } from "../../src/engine/types";
import { roundToTick } from "../../src/engine/util/math";
import { fail, parseArgs, str, table } from "../lib/node";

const args = parseArgs();
const HIST = str(args, "history") ?? fail("--history <hist.json> is required");
const HOURLY = str(args, "hourly", "");
const OUT = resolve(str(args, "out-dir", ".cache/research/wp34")!);
const TRIALS = resolve(str(args, "trials", "reports/trials.jsonl")!);
const ONLY = new Set((str(args, "only", "engine") ?? "").split(","));
const SEED = Number(str(args, "seed", "7"));
const DRAWS = Number(str(args, "draws", "3000"));
mkdirSync(OUT, { recursive: true });

const FROM = "2026-07-23";
const TO = "2026-10-08";
const BAR5 = 5 * MINUTE_MS;
const HOUR = 60 * MINUTE_MS;
const LAG = 90_000;
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];
const ACCOUNTS: AccountId[] = [...ACCOUNT_IDS];
/** Main at production's limits (8 entries a day, 2 open in total), one position per index as the rules require. */
const MAIN_LIMITS: DeepPartial<EngineConfig> = { sizing: { maxOpenPerIndex: 1, maxOpenTotal: 2, maxTradesPerDay: 8 } };

const VARIANTS: Record<string, { wp: "WP3" | "WP4"; patch: DeepPartial<EngineConfig> }> = {
  "NA-base": { wp: "WP3", patch: { strategy: { mode: "NOISE_AREA" } } },
  "NA-vwap": { wp: "WP3", patch: { strategy: { mode: "NOISE_AREA", noiseArea: { stop: "BAND_VWAP" } } } },
  "NA-base-voltarget": { wp: "WP3", patch: { strategy: { mode: "NOISE_AREA", noiseArea: { sizing: "VOL_TARGET" } } } },
  "ORB-window": { wp: "WP4", patch: { strategy: { mode: "ORB5" } } },
  "ORB-published": { wp: "WP4", patch: { strategy: { mode: "ORB5", orb5: { entry: "PUBLISHED" } }, gates: { noEntryBeforeIst: "09:20" } } },
};

function configFor(patch: DeepPartial<EngineConfig>): EngineConfig {
  return withOverrides(makeConfig(MAIN_LIMITS), patch);
}

// ---------------------------------------------------------------------------------------------
// Results, statistics, ledger
// ---------------------------------------------------------------------------------------------

interface TradeLite {
  index: IndexId;
  side: TradeSide;
  entryMs: number;
  exitMs: number;
  pnl: number;
  gross: number;
  charges: number;
  exitReason: string;
  holdingMin: number;
}

interface Stats {
  trades: number;
  net: number;
  mean: number;
  se: number;
  hit: number;
  pf: number;
  maxDD: number;
  perSession: number;
  ciTrade: [number, number];
  ciSession: [number, number];
  pBoot: number;
  gross: number;
  charges: number;
  sessions: number;
  byExit: Record<string, { n: number; net: number }>;
  byIndex: Record<string, { n: number; net: number }>;
}

const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Day-block bootstrap (resample sessions with replacement) of mean net per trade and per session. */
function stats(trades: TradeLite[], sessions: string[], seed = 11, reps = 10_000): Stats {
  const n = trades.length;
  const pnls = trades.map((t) => t.pnl);
  const net = pnls.reduce((a, b) => a + b, 0);
  const mean = n ? net / n : 0;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const wins = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const losses = -pnls.filter((p) => p <= 0).reduce((a, b) => a + b, 0);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitMs - b.exitMs)) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const byDay = new Map<string, number[]>();
  for (const s of sessions) byDay.set(s, []);
  for (const t of trades) {
    const d = istDate(t.entryMs);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(t.pnl);
  }
  const days = [...byDay.values()];
  const rnd = seededRandom(seed);
  const perTrade: number[] = [];
  const perSession: number[] = [];
  for (let r = 0; r < reps && days.length > 0; r++) {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rnd() * days.length)];
      for (const p of d) sum += p;
      cnt += d.length;
    }
    if (cnt > 0) perTrade.push(sum / cnt);
    perSession.push(sum / days.length);
  }
  perTrade.sort((a, b) => a - b);
  perSession.sort((a, b) => a - b);
  const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
  const group = (key: (t: TradeLite) => string) => {
    const m: Record<string, { n: number; net: number }> = {};
    for (const t of trades) {
      const k = key(t);
      m[k] ??= { n: 0, net: 0 };
      m[k].n++;
      m[k].net = r0(m[k].net + t.pnl);
    }
    return m;
  };
  return {
    trades: n,
    net: r0(net),
    mean: r0(mean),
    se: n > 1 ? r0(sd / Math.sqrt(n)) : 0,
    hit: n ? r2(pnls.filter((p) => p > 0).length / n) : 0,
    pf: losses > 0 ? r2(wins / losses) : 0,
    maxDD: r0(dd),
    perSession: days.length ? r0(net / days.length) : 0,
    ciTrade: [r0(q(perTrade, 0.025)), r0(q(perTrade, 0.975))],
    ciSession: [r0(q(perSession, 0.025)), r0(q(perSession, 0.975))],
    pBoot: perTrade.length ? r2(perTrade.filter((x) => x <= 0).length / perTrade.length) : 1,
    gross: r0(trades.reduce((a, t) => a + t.gross, 0)),
    charges: r0(trades.reduce((a, t) => a + t.charges, 0)),
    sessions: days.length,
    byExit: group((t) => t.exitReason),
    byIndex: group((t) => t.index),
  };
}

function trial(entry: { wp: string; variant: string; params: unknown; data: string; trades: number; net: number; notes: string }): void {
  mkdirSync(resolve(TRIALS, ".."), { recursive: true });
  appendFileSync(TRIALS, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

const results: Record<string, unknown> = {};
function save(name: string): void {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(results, null, 1));
}

function printStats(title: string, rows: [string, Stats][]): void {
  console.log(`\n=== ${title} ===`);
  console.log(
    table([
      ["run", "trades", "net ₹", "₹/trade", "SE", "95% CI ₹/trade", "₹/session", "95% CI ₹/session", "p(mean<=0)", "hit", "PF", "maxDD ₹"],
      ...rows.map(([k, s]) => [k, s.trades, s.net, s.mean, s.se, `${s.ciTrade[0]}..${s.ciTrade[1]}`, s.perSession, `${s.ciSession[0]}..${s.ciSession[1]}`, s.pBoot, s.hit, s.pf, s.maxDD]),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// 5-minute engine replays
// ---------------------------------------------------------------------------------------------

const hist = JSON.parse(readFileSync(resolve(HIST), "utf8")) as { candles: Record<string, Candle[]>; daily: Record<string, Candle[]> };
const calendar5 = new TradingCalendar();

interface Book {
  account: AccountId;
  trades: TradeLite[];
  positions: Position[];
  ledgers: DayLedger[];
  sessions: string[];
}

function lite(t: { index: IndexId; side: TradeSide; entryMs: number; exitMs: number; pnl: number; grossPnl: number; charges: number; exitReason: string; holdingMin: number }): TradeLite {
  return { index: t.index, side: t.side, entryMs: t.entryMs, exitMs: t.exitMs, pnl: t.pnl, gross: t.grossPnl, charges: t.charges, exitReason: t.exitReason, holdingMin: t.holdingMin };
}

async function engineRun(cfg: EngineConfig, overlay: boolean): Promise<Record<AccountId, Book>> {
  const followers = (["small10k", "small5k"] as const).map((account) => ({ account, cfg: accountConfig(cfg, account) }));
  const run = new BacktestRun({ cfg, from: FROM, to: TO, candles: hist.candles, daily: hist.daily, noEvents: true, followers });
  const inner = run as unknown as { deps: ReplayDeps; followerDeps: Map<AccountId, ReplayDeps> };
  // Research only: without the end-of-day per-source performance update, Kelly sizing and the decay
  // monitor never see the rule's own losing streak, so the published rule runs unconditionally.
  if (!overlay) inner.deps.repo.perf.upsertMany = async () => {};
  await run.runAll();
  const out = {} as Record<AccountId, Book>;
  for (const account of ACCOUNTS) {
    const res = await run.result(account === "main" ? undefined : account);
    const deps = account === "main" ? inner.deps : inner.followerDeps.get(account)!;
    const positions = await deps.repo.positions.closedBetween(istAt(FROM, "00:00"), istAt(addDays(TO, 1), "00:00"), "BACKTEST");
    out[account] = { account, trades: res.trades.map(lite), positions, ledgers: res.ledgers, sessions: res.days };
  }
  return out;
}

/** Sessions on which the strategy could decide (the noise area needs 13 of 14 prior sessions). */
function tradableSessions(books: Record<AccountId, Book>, cfg: EngineConfig): string[] {
  const days = books.main.sessions;
  if (cfg.strategy.mode !== "NOISE_AREA") return days;
  const all = [...new Set((hist.candles[MARKET_SYMBOLS.NIFTY] ?? []).map((c) => istDate(c.t)))].sort();
  const need = cfg.strategy.noiseArea.lookbackSessions - 1;
  return days.filter((d) => all.indexOf(d) >= need);
}

const engineCache = new Map<string, Record<AccountId, Book>>();

async function engineVariant(name: string, patch: DeepPartial<EngineConfig>, wp: string, overlay: boolean, label = name): Promise<Record<AccountId, Book>> {
  const cfg = configFor(patch);
  const t0 = Date.now();
  const books = await engineRun(cfg, overlay);
  engineCache.set(label, books);
  const sessions = tradableSessions(books, cfg);
  const rows: [string, Stats][] = [];
  for (const account of ACCOUNTS) {
    const s = stats(books[account].trades, sessions);
    rows.push([`${label} ${account}`, s]);
    results[`${label}|${account}`] = { stats: s, trades: books[account].trades };
    trial({
      wp,
      variant: `${label}${overlay ? "+overlay" : ""}`,
      params: { account, strategy: cfg.strategy.mode === "ORB5" ? { mode: "ORB5", ...cfg.strategy.orb5 } : { mode: "NOISE_AREA", ...cfg.strategy.noiseArea }, window: [cfg.gates.noEntryBeforeIst, cfg.gates.noEntryAfterIst], vixMultiplier: cfg.pricing.vixMultiplier, overlay, limits: account === "main" ? MAIN_LIMITS : "account" },
      data: `yahoo 5m snapshot hist.json ${FROM}..${TO} (${books.main.sessions.length} sessions, ${sessions.length} tradable), engine replay, synthetic option prices`,
      trades: s.trades,
      net: s.net,
      notes: `mean ${s.mean}/trade SE ${s.se}; CI ${s.ciTrade.join("..")}; hit ${s.hit}; PF ${s.pf}`,
    });
  }
  printStats(`${label} (${overlay ? "engine as-is, Kelly/decay overlay on" : "published rule, overlay off"}; ${((Date.now() - t0) / 1000).toFixed(0)} s)`, rows);
  return books;
}

// ---------------------------------------------------------------------------------------------
// Copy delay: the same trades re-priced one 5-minute bar later with 2 extra ticks each side
// ---------------------------------------------------------------------------------------------

function closeLookup(candles: Candle[], barMs: number, lag: number) {
  const ts = candles.map((c) => c.t);
  return (t: number): number | null => {
    let lo = 0;
    let hi = ts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] + barMs <= t - lag) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? candles[ans].c : null;
  };
}

const spot5: Record<IndexId, (t: number) => number | null> = {
  NIFTY: closeLookup(hist.candles[MARKET_SYMBOLS.NIFTY], BAR5, LAG),
  SENSEX: closeLookup(hist.candles[MARKET_SYMBOLS.SENSEX], BAR5, LAG),
};
const vix5 = closeLookup(hist.candles[MARKET_SYMBOLS.INDIAVIX], BAR5, LAG);

function reprice(positions: Position[], cfg: EngineConfig, delayBars: number, extraTicks: number): TradeLite[] {
  const out: TradeLite[] = [];
  for (const p of positions) {
    if (p.exitMs === undefined) continue;
    const qty = p.exitedQty ?? p.qty;
    const tick = p.contract.tickSize;
    const quoteAt = (t: number) => syntheticQuote(p.contract, { t, spot: spot5[p.index](t) ?? 0, vix: vix5(t) ?? 0 }, calendar5, cfg);
    const t1 = p.entryMs + delayBars * BAR5;
    const t2 = p.exitMs + delayBars * BAR5;
    const entry = roundToTick(quoteAt(t1).ask + extraTicks * tick, tick);
    const exit = Math.max(tick, roundToTick(quoteAt(t2).bid - extraTicks * tick, tick));
    const date = istDate(p.entryMs);
    const charges = computeCharges("BUY", entry, qty, p.contract.exchange, date).total + computeCharges("SELL", exit, qty, p.contract.exchange, date).total;
    const gross = (exit - entry) * qty;
    out.push({ index: p.index, side: p.side, entryMs: t1, exitMs: t2, pnl: r2(gross - charges), gross: r2(gross), charges: r2(charges), exitReason: p.exitReason ?? "?", holdingMin: Math.round((t2 - t1) / MINUTE_MS) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Instruments for any date and strike (2-year runs and placebos)
// ---------------------------------------------------------------------------------------------

function makeContract(cfg: EngineConfig, index: IndexId, expiry: string, strike: number, type: "CE" | "PE"): OptionContract {
  const spec = cfg.indexSpecs[index];
  const tradingSymbol = optionTradingSymbol(spec.underlying, expiry, strike, type, isMonthlyExpiry(index, expiry, cfg));
  return { index, exchange: spec.exchange, tradingSymbol, growwSymbol: optionGrowwSymbol(spec.exchange, spec.underlying, expiry, strike, type), exchangeToken: `SYN-${tradingSymbol}`, expiry, strike, type, lotSize: spec.lotSize, tickSize: spec.tickSize };
}

/** Every weekly expiry near the clock's date, every strike on the grid (as the exchange lists them). */
function anyInstruments(cfg: EngineConfig, calendar: TradingCalendar, now: () => number): InstrumentProvider {
  return {
    expiries: async (index) => {
      const d = istDate(now());
      return calendar.expiriesBetween(index, addDays(d, -7), addDays(d, 42));
    },
    strikes: async () => [],
    resolve: async (index, expiry, strike, type) => makeContract(cfg, index, expiry, strike, type),
  };
}

// ---------------------------------------------------------------------------------------------
// Generic replay harness over any bar size (used for the 2-year hourly approximation)
// ---------------------------------------------------------------------------------------------

interface Market {
  /** Session dates in order. */
  dates: string[];
  /** Decision ticks of a date (epoch ms, already including the data lag). */
  ticks(date: string): number[];
  spot(index: IndexId, t: number): number | null;
  vix(t: number): number | null;
  /** The strategy's signal for an index at a tick. */
  signal(index: IndexId, t: number, cfg: EngineConfig): PublishedSignal;
}

async function harnessRun(market: Market, cfg: EngineConfig, account: AccountId, calendar: TradingCalendar, order: "exits-first" | "entries-first"): Promise<{ trades: TradeLite[]; positions: Position[] }> {
  const acfg = accountConfig(cfg, account);
  const start = istAt(market.dates[0], "09:00");
  const deps = createReplayDeps({ cfg: acfg, startMs: start, candles: {}, calendar, lagMs: 0 });
  const instruments = anyInstruments(acfg, calendar, () => deps.clock.now());
  const d: ReplayDeps = { ...deps, instruments, optionQuotes: new SyntheticOptionQuotes(calendar, acfg) };
  for (const date of market.dates) {
    for (const t of market.ticks(date)) {
      d.clock.set(t);
      const convictions: Partial<Record<IndexId, Conviction>> = {};
      const spots: Partial<Record<IndexId, number>> = {};
      const vix = market.vix(t) ?? 0;
      for (const index of acfg.indices) {
        const spot = market.spot(index, t);
        if (spot === null) continue;
        spots[index] = spot;
        d.marketContext.set(index, { spot, vix, t });
        convictions[index] = publishedConviction(index, t, market.signal(index, t, acfg), "RANGE", acfg);
      }
      const exits = () => runPositionCycle(d, { convictions, events: [] });
      if (order === "exits-first") await exits();
      const settings = await d.repo.settings.get();
      const risk = await loadRiskState(d.repo, acfg, settings, t, d.mode);
      const halt = haltReason(risk, acfg);
      for (const index of acfg.indices) {
        const conviction = convictions[index];
        const spot = spots[index];
        if (!conviction || spot === undefined) continue;
        const f = { ...neutralFeatures(index, { t, candles: {}, daily: {}, ltp: { [index]: spot }, dataAgeSec: LAG / 1000 }, calendar), spot, vix, dataAgeSec: LAG / 1000 };
        const decision = await planEntry({ index, t, features: f, pressure: null, conviction, risk, perf: [] }, { ...d, calendar });
        if (decision.plan && !halt && calendar.sessionPhase(t) === "OPEN") {
          const { position } = await submitEntry(d, decision.plan, null);
          risk.ordersToday += 1;
          if (position) {
            risk.openPositions.push(position);
            risk.entriesToday[index] += 1;
          }
        }
      }
      if (order === "entries-first") await exits();
    }
    d.clock.set(istAt(date, "16:00"));
    await runEndOfDay(d, { grade: false, performance: false });
  }
  const trades = await d.repo.trades.between(start, istAt(addDays(market.dates[market.dates.length - 1], 1), "00:00"), "BACKTEST");
  const positions = await d.repo.positions.closedBetween(start, istAt(addDays(market.dates[market.dates.length - 1], 1), "00:00"), "BACKTEST");
  return { trades: trades.map(lite).sort((a, b) => a.entryMs - b.entryMs), positions };
}

// --- 5-minute market for the harness (validation against the engine replay) -------------------

function market5(cfgForSignals: EngineConfig): Market {
  const replay = new ReplayMarketDataSource({ candles: hist.candles, daily: hist.daily }, { lagMs: LAG });
  const days = [...new Set(hist.candles[MARKET_SYMBOLS.NIFTY].map((c) => istDate(c.t)))].filter((d) => d >= FROM && d <= TO && calendar5.isTradingDay(d)).sort();
  const cache = new Map<string, PublishedSignal>();
  let snapAt: { t: number; snap: ReturnType<ReplayMarketDataSource["snapshotSync"]> } | null = null;
  return {
    dates: days,
    ticks: (date) => {
      const out: number[] = [];
      for (let t = istAt(date, "09:15") + LAG; t <= istAt(date, "15:30") + LAG; t += BAR5) out.push(t);
      return out;
    },
    spot: (index, t) => spot5[index](t),
    vix: (t) => vix5(t),
    signal: (index, t) => {
      const key = `${index}|${t}`;
      let s = cache.get(key);
      if (!s) {
        if (!snapAt || snapAt.t !== t) snapAt = { t, snap: replay.snapshotSync(t) };
        s = publishedSignal(index, t, snapAt.snap, calendar5, cfgForSignals);
        cache.set(key, s);
      }
      return s;
    },
  };
}

/** Today's 5-minute session bars (clipped as the engine clips them) published by tick `t`, cached per index and date. */
function orbBars5(): (index: IndexId, date: string, t: number) => Candle[] {
  const dayCache = new Map<string, Candle[]>();
  return (index, date, t) => {
    const key = `${index}|${date}`;
    let bars = dayCache.get(key);
    if (!bars) {
      bars = sessionsAt(hist.candles[MARKET_SYMBOLS[index]], calendar5, istAt(date, "23:00"), BAR5, 0).today?.bars ?? [];
      dayCache.set(key, bars);
    }
    return bars.filter((c) => c.t + BAR5 <= t - LAG);
  };
}

// --- Hourly market: Yahoo 1h bars, 2 years -----------------------------------------------------

interface HourlySession {
  date: string;
  /** Bars opening 09:15 ... 14:15 (60 minutes each). */
  bars: Candle[];
  open: number;
  /** Session close: the close of the 15:15-15:30 bar (the exchange close). */
  close: number;
}

function loadHourly(): { sessions: Record<IndexId, Map<string, HourlySession>>; vix: Candle[]; dates: string[]; holidays: string[] } {
  if (!HOURLY) fail("--hourly <dir> is required for the hourly runs");
  const read = (f: string, sym: string) => parseYahooChart(JSON.parse(readFileSync(join(HOURLY, f), "utf8")), sym).candles;
  const raw: Record<IndexId, Candle[]> = { NIFTY: read("NSEI.json", "^NSEI"), SENSEX: read("BSESN.json", "^BSESN") };
  const vix = read("INDIAVIX.json", "^INDIAVIX").filter((c) => c.c > 0);
  const sessions = {} as Record<IndexId, Map<string, HourlySession>>;
  const seen = new Set<string>();
  for (const index of INDICES) {
    const byDate = new Map<string, Candle[]>();
    for (const c of raw[index]) {
      const d = istDate(c.t);
      seen.add(d);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(c);
    }
    const m = new Map<string, HourlySession>();
    for (const [d, bars] of byDate) {
      const starts = bars.map((b) => istMinutes(b.t));
      const want = [555, 615, 675, 735, 795, 855, 915];
      if (!want.every((w) => starts.includes(w))) continue;
      const core = want.slice(0, 6).map((w) => bars.find((b) => istMinutes(b.t) === w)!);
      const last = bars.find((b) => istMinutes(b.t) === 915)!;
      m.set(d, { date: d, bars: core, open: core[0].o, close: last.c });
    }
    sessions[index] = m;
  }
  const dates = [...sessions.NIFTY.keys()].filter((d) => sessions.SENSEX.has(d)).sort();
  // Weekdays with no bars at all are exchange holidays (they shift expiries and time to expiry).
  const holidays: string[] = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) if (weekdayOf(d) <= 5 && !seen.has(d)) holidays.push(d);
  return { sessions, vix, dates, holidays };
}

function hourlyMarket(h: ReturnType<typeof loadHourly>, cfg: EngineConfig, firstDate: string): Market {
  const vixAt = closeLookup(h.vix, HOUR, 0);
  const p: NoiseAreaParams = { ...cfg.strategy.noiseArea, anchorMin: 15, decisionEveryMin: 60 };
  const dates = h.dates.filter((d) => d >= firstDate);
  const allDates = h.dates;
  const cache = new Map<string, PublishedSignal>();
  const sessionBars = (index: IndexId, date: string): SessionBars => {
    const s = h.sessions[index].get(date)!;
    return { date, open: s.open, bars: s.bars };
  };
  const signalAt = (index: IndexId, t: number): PublishedSignal => {
    const key = `${index}|${t}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const date = istDate(t);
    const i = allDates.indexOf(date);
    const k = Math.round((t - LAG - istAt(date, "10:15")) / HOUR); // checkpoint: bar k ends at 10:15 + k hours
    let sig: PublishedSignal = idleSignal(cfg, "no decision");
    if (i >= 1 && k >= 0 && k <= 5) {
      const history = allDates.slice(Math.max(0, i - p.lookbackSessions), i).map((d) => sessionBars(index, d));
      const prevClose = h.sessions[index].get(allDates[i - 1])!.close;
      const today = { ...sessionBars(index, date), bars: sessionBars(index, date).bars.slice(0, k + 1) };
      const dec = noiseAreaDecision(today, history, prevClose, p, HOUR, k);
      const closes = allDates.slice(Math.max(0, i - 15), i).map((d) => h.sessions[index].get(d)!.close);
      const sizeMult = p.sizing === "VOL_TARGET" ? volTargetMultiplier(closes, p.volTargetPct, p.maxLeverage) : 1;
      if (dec) sig = { ...dec, sizeMult };
    }
    cache.set(key, sig);
    return sig;
  };
  return {
    dates,
    // Bars end 10:15 ... 15:15 (seen 90 s later); the last tick is after the 15:05 square-off, at the 15:15 close.
    ticks: (date) => Array.from({ length: 6 }, (_, k) => istAt(date, "10:15") + k * HOUR + LAG),
    spot: (index, t) => {
      const date = istDate(t);
      const s = h.sessions[index].get(date);
      if (!s) return null;
      const k = Math.round((t - LAG - istAt(date, "10:15")) / HOUR);
      return k >= 0 && k <= 5 ? s.bars[k].c : null;
    },
    vix: (t) => vixAt(t - LAG),
    signal: (index, t) => signalAt(index, t),
  };
}

function hourlyCalendar(h: ReturnType<typeof loadHourly>): TradingCalendar {
  const bundled = loadBundledHolidays();
  const known = new Set(bundled.map((x) => x.date));
  return new TradingCalendar({ holidays: [...bundled, ...h.holidays.filter((d) => !known.has(d)).map((date) => ({ date, name: "no Yahoo bars (holiday)" }))] });
}

// ---------------------------------------------------------------------------------------------
// Placebos: random entries with the strategy's own exits ("rule") or a matched holding time ("hold")
// ---------------------------------------------------------------------------------------------

interface PlaceboOpts {
  name: string;
  cfg: EngineConfig;
  account: AccountId;
  market: Market;
  calendar: TradingCalendar;
  /** Sessions the strategy could trade. */
  dates: string[];
  /** Entry ticks to draw from on a date. */
  entryTicks: (date: string) => number[];
  kind: "rule" | "hold";
  /** Holding minutes of the strategy's own trades (for "hold"). */
  holds: number[];
  /** ORB: index levels for a random side (otherwise the market's signal decides the index exits). */
  orbBars?: (index: IndexId, date: string, t: number) => Candle[];
  barMs: number;
  /** Instead of random draws, these entries (main's own signals), each from a fresh account. */
  fixed?: { t: number; index: IndexId; side: TradeSide }[];
}

async function placebo(o: PlaceboOpts): Promise<TradeLite[]> {
  const acfg = accountConfig(o.cfg, o.account);
  const rnd = seededRandom(SEED + o.name.length * 7919 + o.account.length * 104729 + (o.kind === "hold" ? 31 : 0));
  const quotes = new SyntheticOptionQuotes(o.calendar, acfg);
  let clock = 0;
  const instruments = anyInstruments(acfg, o.calendar, () => clock);
  const settings = { ...(await createReplayDeps({ cfg: acfg, startMs: 0, candles: {}, calendar: o.calendar }).repo.settings.get()) };
  const out: TradeLite[] = [];
  let guard = 0;
  let next = 0;
  const target = o.fixed ? o.fixed.length : DRAWS;
  while (o.fixed ? next < o.fixed.length : out.length < target && guard++ < DRAWS * 50) {
    const fx = o.fixed?.[next++];
    const date = fx ? istDate(fx.t) : o.dates[Math.floor(rnd() * o.dates.length)];
    const ticksForEntry = fx ? [fx.t] : o.entryTicks(date);
    if (ticksForEntry.length === 0) continue;
    const index = fx ? fx.index : INDICES[Math.floor(rnd() * 2)];
    const side: TradeSide = fx ? fx.side : rnd() < 0.5 ? "BULL" : "BEAR";
    const t0 = ticksForEntry[Math.floor(rnd() * ticksForEntry.length)];
    const spot0 = o.market.spot(index, t0);
    const vix0 = o.market.vix(t0);
    if (!spot0 || !vix0) continue;
    if (o.calendar.isExpiryDay(index, date) && (SESSION.close - istMinutes(t0)) <= acfg.gates.expiryDayNoEntryMinBeforeClose) continue;
    const orbP = acfg.strategy.mode === "ORB5" ? orb5Params(acfg) : null;
    if (o.kind === "rule" && orbP && o.orbBars) {
      const st = orb5State(o.orbBars(index, date, t0), istAt(date, "09:15"), orbP, o.barMs, side);
      if (st.entry !== side) continue;
    }
    clock = t0;
    // Contract and size exactly as the account would choose them.
    let contract: OptionContract | null = null;
    let ask = 0;
    if (acfg.selection.mode === "PREMIUM_BAND") {
      const pick = await choosePremiumBandContract({
        index, spot: spot0, vix: vix0, side, t: t0, instruments, optionQuotes: quotes, calendar: o.calendar, cfg: acfg,
        quoteOk: (q) => q.bid > 0 && q.ask >= q.bid,
        affordable: (premium, c) => sizePosition({ premium, contract: c, perf: undefined, sizeMult: 1, capitalRupees: acfg.capitalRupees, openPremiumRupees: 0, settings, cashRupees: acfg.capitalRupees }, acfg).lots >= 1,
      });
      if (!pick.quote || !pick.contract) continue;
      contract = pick.contract;
      ask = pick.quote.ask;
    } else {
      const today = istDate(t0);
      let expiry = o.calendar.nextExpiry(index, t0);
      if (expiry === today) expiry = o.calendar.followingExpiry(index, expiry);
      contract = makeContract(acfg, index, expiry, atmStrike(spot0, acfg.indexSpecs[index].strikeStep), side === "BULL" ? "CE" : "PE");
      ask = syntheticQuote(contract, { t: t0, spot: spot0, vix: vix0 }, o.calendar, acfg).ask;
    }
    const size = sizePosition({ premium: ask, contract, perf: undefined, sizeMult: 1, capitalRupees: acfg.capitalRupees, openPremiumRupees: 0, settings, cashRupees: acfg.sizing.useCurrentEquity ? acfg.capitalRupees : undefined }, acfg);
    if (size.lots < 1) continue;
    const qty = size.qty;
    const entryCharges = computeCharges("BUY", ask, qty, contract.exchange, date).total;
    const squareOff = istAt(date, acfg.exits.squareOffIst);
    let pos: Position = {
      id: "placebo", planId: "placebo", index, side, contract, mode: "BACKTEST", qty, avgEntry: ask, entryMs: t0, entryCharges, status: "OPEN", markPremium: ask, markMs: t0, peakPremium: ask, unrealized: 0,
      stops: { stopPct: acfg.exits.stopPct, targetPct: acfg.exits.targetPct, trailActivatePct: acfg.exits.trailActivatePct, trailGivebackPct: acfg.exits.trailGivebackPct, timeStopMs: squareOff, squareOffMs: squareOff },
      horizonMin: 0, convictionAtEntry: 0, regimeAtEntry: "RANGE", dominantSource: "MOMENTUM", attribution: [], eventKeysAtEntry: [], maePct: 0, mfePct: 0,
    };
    const hold = o.kind === "hold" ? o.holds[Math.floor(rnd() * o.holds.length)] : Infinity;
    const allTicks = o.market.ticks(date).filter((t) => t > t0);
    let done: TradeLite | null = null;
    for (const t of allTicks) {
      const spot = o.market.spot(index, t);
      const vix = o.market.vix(t) ?? vix0;
      if (!spot) continue;
      const q = syntheticQuote(contract, { t, spot, vix }, o.calendar, acfg);
      pos = markPosition(pos, q, t);
      let sig: PublishedSignal = idleSignal(acfg, "placebo");
      if (o.kind === "rule") sig = orbP && o.orbBars ? orb5State(o.orbBars(index, date, t), istAt(date, "09:15"), orbP, o.barMs, side) : o.market.signal(index, t, acfg);
      const conviction = publishedConviction(index, t, { ...sig, entry: null }, "RANGE", acfg);
      let dec = evaluateExits(pos, q, { nowMs: t, conviction }, acfg);
      if (!dec && t - t0 >= hold * MINUTE_MS) dec = { reason: "TIME_STOP", orderType: "MARKET", detail: "matched holding time" };
      if (!dec) continue;
      const exit = q.bid;
      const exitCharges = computeCharges("SELL", exit, qty, contract.exchange, date).total;
      const gross = (exit - ask) * qty;
      done = { index, side, entryMs: t0, exitMs: t, pnl: r2(gross - entryCharges - exitCharges), gross: r2(gross), charges: r2(entryCharges + exitCharges), exitReason: dec.reason, holdingMin: Math.round((t - t0) / MINUTE_MS) };
      break;
    }
    if (done) out.push(done);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`WP3/WP4 runner: ${[...ONLY].join(", ")}; history ${HIST}; out ${OUT}; trials ${TRIALS}`);

  if (ONLY.has("engine") || ONLY.has("delay") || ONLY.has("placebo") || ONLY.has("validate")) {
    for (const [name, v] of Object.entries(VARIANTS)) await engineVariant(name, v.patch, v.wp, false);
    save("engine");
  }

  if (ONLY.has("overlay")) {
    for (const name of ["NA-base", "NA-vwap", "ORB-window", "ORB-published"]) await engineVariant(name, VARIANTS[name].patch, VARIANTS[name].wp, true, `${name}+overlay`);
    save("overlay");
  }

  if (ONLY.has("perturb")) {
    const pert: Record<string, [string, DeepPartial<EngineConfig>]> = {};
    const set = str(args, "perturb-set", "all");
    for (const base of set === "orb" ? [] : ["NA-base", "NA-vwap"]) {
      const stop = base === "NA-vwap" ? "BAND_VWAP" : "OPPOSITE_BAND";
      for (const [k, v] of [["lookbackSessions", 11], ["lookbackSessions", 17], ["bandMult", 0.8], ["bandMult", 1.2], ["decisionEveryMin", 25], ["decisionEveryMin", 35]] as const) {
        pert[`${base} ${k}=${v}`] = ["WP3", { strategy: { mode: "NOISE_AREA", noiseArea: { stop, [k]: v } } }];
      }
    }
    for (const base of set === "noise" ? [] : ["ORB-window", "ORB-published"]) {
      for (const r of [8, 12]) pert[`${base} targetR=${r}`] = ["WP4", { ...VARIANTS[base].patch, strategy: { mode: "ORB5", orb5: { entry: base === "ORB-published" ? "PUBLISHED" : "ENGINE_WINDOW", targetR: r } } }];
    }
    for (const [label, [wp, patch]] of Object.entries(pert)) await engineVariant(label, patch, wp, false, label);
    save(`perturb-${set}`);
  }

  if (ONLY.has("bias")) {
    for (const name of ["NA-base", "NA-vwap", "ORB-window", "ORB-published"]) {
      const patch = { ...VARIANTS[name].patch, pricing: { vixMultiplier: { NIFTY: 0.9, SENSEX: 1.05 * 0.9 } } };
      await engineVariant(name, patch, VARIANTS[name].wp, false, `${name} IVx0.9`);
    }
    save("bias");
  }

  if (ONLY.has("delay")) {
    const rows: [string, Stats][] = [];
    for (const name of Object.keys(VARIANTS)) {
      const books = engineCache.get(name)!;
      const cfg = configFor(VARIANTS[name].patch);
      for (const account of ACCOUNTS) {
        const acfg = accountConfig(cfg, account);
        const check = reprice(books[account].positions, acfg, 0, 0);
        const engineNet = books[account].trades.reduce((a, t) => a + t.pnl, 0);
        const checkNet = check.reduce((a, t) => a + t.pnl, 0);
        if (Math.abs(engineNet - checkNet) > 1 + 0.001 * Math.abs(engineNet)) console.log(`WARNING ${name} ${account}: re-pricing without delay gives ${checkNet.toFixed(2)} vs engine ${engineNet.toFixed(2)}`);
        const sessions = tradableSessions(books, cfg);
        const delayed = reprice(books[account].positions, acfg, 1, 2);
        const s = stats(delayed, sessions);
        rows.push([`${name} ${account} +5min+2ticks`, s]);
        results[`${name}|${account}|delay`] = { stats: s, undelayedCheckNet: r2(checkNet), engineNet: r2(engineNet) };
        trial({ wp: VARIANTS[name].wp, variant: `${name} copy-delay`, params: { account, delayBars: 1, extraTicksEachSide: 2 }, data: `same trades as ${name} (5m snapshot) re-priced`, trades: s.trades, net: s.net, notes: `engine net ${r0(engineNet)} -> ${s.net} with delay` });
      }
    }
    printStats("Copy delay: entry and exit one bar (5 min) later, +2 ticks each side", rows);
    save("delay");
  }

  if (ONLY.has("placebo")) {
    const rows: [string, Stats][] = [];
    for (const name of Object.keys(VARIANTS)) {
      if (name === "NA-base-voltarget") continue;
      const cfg = configFor(VARIANTS[name].patch);
      const books = engineCache.get(name)!;
      const market = market5(cfg);
      const sessions = tradableSessions(books, cfg);
      const isOrb = cfg.strategy.mode === "ORB5";
      const entryTicks = (date: string) => {
        if (isOrb) return [istAt(date, cfg.strategy.orb5.entry === "PUBLISHED" ? "09:20" : "09:25") + LAG];
        const out: number[] = [];
        for (let m = 9 * 60 + 30; m <= 14 * 60; m += cfg.strategy.noiseArea.decisionEveryMin) out.push(istAt(date, m) + LAG);
        return out;
      };
      // Today's session bars (clipped as the engine clips them), cached per index and date; at a tick
      // only the bars closed and published by then are used.
      const dayCache = new Map<string, Candle[]>();
      const orbBars = (index: IndexId, date: string, t: number) => {
        const key = `${index}|${date}`;
        let bars = dayCache.get(key);
        if (!bars) {
          bars = sessionsAt(hist.candles[MARKET_SYMBOLS[index]], calendar5, istAt(date, "23:00"), BAR5, 0).today?.bars ?? [];
          dayCache.set(key, bars);
        }
        return bars.filter((c) => c.t + BAR5 <= t - LAG);
      };
      for (const account of ACCOUNTS) {
        const holds = books[account].trades.map((t) => t.holdingMin);
        for (const kind of ["rule", "hold"] as const) {
          if (kind === "hold" && holds.length === 0) continue;
          const tr = await placebo({ name, cfg, account, market, calendar: calendar5, dates: sessions, entryTicks: kind === "rule" ? entryTicks : (d) => Array.from({ length: 61 }, (_, k) => istAt(d, "09:25") + k * BAR5 + LAG), kind, holds, orbBars: isOrb ? orbBars : undefined, barMs: BAR5 });
          const s = stats(tr, sessions);
          rows.push([`${name} ${account} placebo-${kind}`, s]);
          results[`${name}|${account}|placebo-${kind}`] = { stats: s };
          trial({ wp: VARIANTS[name].wp, variant: `${name} placebo-${kind}`, params: { account, draws: DRAWS, seed: SEED, kind }, data: `5m snapshot ${FROM}..${TO}`, trades: s.trades, net: s.net, notes: `random ${kind === "rule" ? "side and decision time, strategy's own exits" : "time and side, holding time drawn from the strategy's trades"}; mean ${s.mean} SE ${s.se}` });
        }
      }
    }
    printStats("Placebos (5-minute snapshot)", rows);
    save("placebo");
  }

  if (ONLY.has("signals")) {
    // Per-trade economics of main's own signals with each small account's contract (premium band, one
    // lot), each trade from a fresh account: the engine runs stop trading those accounts once losses
    // leave too little equity for a lot, which says nothing about expectancy per trade.
    const rows: [string, Stats][] = [];
    const eng = JSON.parse(readFileSync(join(OUT, "engine.json"), "utf8")) as Record<string, { trades: TradeLite[] }>;
    const days5 = [...new Set(hist.candles[MARKET_SYMBOLS.NIFTY].map((c) => istDate(c.t)))].sort();
    for (const name of ["NA-base", "NA-vwap", "ORB-window", "ORB-published"]) {
      const cfg = configFor(VARIANTS[name].patch);
      const isOrb = cfg.strategy.mode === "ORB5";
      const need = isOrb ? 0 : cfg.strategy.noiseArea.lookbackSessions - 1;
      const sessions = days5.filter((d, i) => d >= FROM && d <= TO && calendar5.isTradingDay(d) && i >= need);
      const fixed = eng[`${name}|main`].trades.map((t) => ({ t: t.entryMs, index: t.index, side: t.side }));
      for (const account of ["small10k", "small5k"] as const) {
        const tr = await placebo({ name, cfg, account, market: market5(cfg), calendar: calendar5, dates: sessions, entryTicks: () => [], kind: "rule", holds: [], orbBars: isOrb ? orbBars5() : undefined, barMs: BAR5, fixed });
        const s = stats(tr, sessions);
        rows.push([`${name} ${account} main's signals, fresh account`, s]);
        results[`${name}|${account}|signals`] = { stats: s };
        trial({ wp: VARIANTS[name].wp, variant: `${name} main-signals fresh-account`, params: { account, signals: fixed.length }, data: `5m snapshot ${FROM}..${TO}`, trades: s.trades, net: s.net, notes: `main's entries, ${account}'s premium-band contract, one lot, same exits, no capital depletion; mean ${s.mean} SE ${s.se}` });
      }
    }
    printStats("Main's signals with the small accounts' contracts (5-minute snapshot, fresh account per trade)", rows);
    const hourlyFile = join(OUT, "hourly-hourly+hourly-placebo.json");
    if (HOURLY) {
      const hres = JSON.parse(readFileSync(hourlyFile, "utf8")) as Record<string, { trades: TradeLite[] }>;
      const h = loadHourly();
      const calendarH = hourlyCalendar(h);
      const firstDate = h.dates[14];
      const sessions = h.dates.filter((d) => d >= firstDate);
      const hrows: [string, Stats][] = [];
      for (const [label, name] of [["H NA-base", "NA-base"], ["H NA-vwap", "NA-vwap"]] as const) {
        const cfg = configFor(VARIANTS[name].patch);
        const fixed = hres[`${label}|main`].trades.map((t) => ({ t: t.entryMs, index: t.index, side: t.side }));
        for (const account of ["small10k", "small5k"] as const) {
          const tr = await placebo({ name: label, cfg, account, market: hourlyMarket(h, cfg, firstDate), calendar: calendarH, dates: sessions, entryTicks: () => [], kind: "rule", holds: [], barMs: HOUR, fixed });
          const s = stats(tr, sessions);
          hrows.push([`${label} ${account} main's signals, fresh account`, s]);
          results[`${label}|${account}|signals`] = { stats: s };
          trial({ wp: "WP3", variant: `${label} main-signals fresh-account`, params: { account, signals: fixed.length, hourly: true }, data: "yahoo 1h 2-year approximation", trades: s.trades, net: s.net, notes: `main's entries, ${account}'s premium-band contract, one lot, same exits; mean ${s.mean} SE ${s.se}` });
        }
      }
      printStats("Main's signals with the small accounts' contracts (2-year hourly approximation, fresh account per trade)", hrows);
    }
    save("signals");
  }

  if (ONLY.has("validate")) {
    const rows: [string, Stats][] = [];
    for (const name of ["NA-base", "ORB-window"]) {
      const cfg = configFor(VARIANTS[name].patch);
      const books = engineCache.get(name)!;
      for (const account of ACCOUNTS) {
        const r = await harnessRun(market5(cfg), cfg, account, calendar5, "entries-first");
        const s = stats(r.trades, tradableSessions(books, cfg));
        rows.push([`${name} ${account} harness`, s], [`${name} ${account} engine`, stats(books[account].trades, tradableSessions(books, cfg))]);
        const a = books[account].trades.map((t) => `${t.entryMs}|${t.index}|${t.side}|${t.exitMs}|${t.pnl}`);
        const b = r.trades.map((t) => `${t.entryMs}|${t.index}|${t.side}|${t.exitMs}|${t.pnl}`);
        const same = a.filter((x) => b.includes(x)).length;
        console.log(`validate ${name} ${account}: engine ${a.length} trades, harness ${b.length}, identical ${same}`);
        results[`${name}|${account}|validate`] = { engine: a.length, harness: b.length, identical: same };
      }
    }
    printStats("Harness vs engine on the 5-minute snapshot", rows);
    save("validate");
  }

  if (ONLY.has("hourly") || ONLY.has("hourly-perturb") || ONLY.has("hourly-placebo")) {
    const h = loadHourly();
    const calendarH = hourlyCalendar(h);
    // The first 14 sessions only build the bands.
    const firstDate = h.dates[14];
    const sessions = h.dates.filter((d) => d >= firstDate);
    const dataNote = `yahoo 1h ${h.dates[0]}..${h.dates[h.dates.length - 1]}, ${sessions.length} sessions traded (first 14 build sigma); decisions at hourly closes 10:15..14:15, square-off at the 15:15 close; today's contract specs and expiry weekdays; synthetic option prices`;
    console.log(`Hourly data: ${h.dates.length} complete sessions, ${h.holidays.length} holidays inferred; trading ${firstDate}..${h.dates[h.dates.length - 1]}`);
    const runs: [string, DeepPartial<EngineConfig>][] = [];
    if (ONLY.has("hourly")) runs.push(["H NA-base", VARIANTS["NA-base"].patch], ["H NA-vwap", VARIANTS["NA-vwap"].patch], ["H NA-base-voltarget", VARIANTS["NA-base-voltarget"].patch]);
    if (ONLY.has("hourly-perturb")) {
      for (const stop of ["OPPOSITE_BAND", "BAND_VWAP"] as const) {
        for (const [k, v] of [["lookbackSessions", 11], ["lookbackSessions", 17], ["bandMult", 0.8], ["bandMult", 1.2]] as const) {
          runs.push([`H NA-${stop === "BAND_VWAP" ? "vwap" : "base"} ${k}=${v}`, { strategy: { mode: "NOISE_AREA", noiseArea: { stop, [k]: v } } }]);
        }
      }
    }
    const rows: [string, Stats][] = [];
    for (const [label, patch] of runs) {
      const cfg = configFor(patch);
      const market = hourlyMarket(h, cfg, firstDate);
      for (const account of ACCOUNTS) {
        const t0 = Date.now();
        const r = await harnessRun(market, cfg, account, calendarH, "exits-first");
        const s = stats(r.trades, sessions);
        const tickCost = stats(repriceHourly(r.positions, accountConfig(cfg, account), h, calendarH), sessions);
        rows.push([`${label} ${account}`, s], [`${label} ${account} +2 ticks each side`, tickCost]);
        results[`${label}|${account}`] = { stats: s, tickCost, trades: r.trades };
        trial({ wp: "WP3", variant: label, params: { account, strategy: { ...cfg.strategy.noiseArea, decisionEveryMin: 60, decisionAnchorMin: 15 }, hourly: true, overlay: false }, data: dataNote, trades: s.trades, net: s.net, notes: `mean ${s.mean} SE ${s.se}; CI ${s.ciTrade.join("..")}; +2 ticks each side: ${tickCost.net}; ${((Date.now() - t0) / 1000).toFixed(0)} s` });
        if (ONLY.has("hourly-placebo") && label === "H NA-base" || ONLY.has("hourly-placebo") && label === "H NA-vwap") {
          const holds = r.trades.map((t) => t.holdingMin);
          for (const kind of ["rule", "hold"] as const) {
            const entryTicks = (d: string) => (kind === "rule" ? Array.from({ length: 5 }, (_, k) => istAt(d, "10:15") + k * HOUR + LAG) : Array.from({ length: 5 }, (_, k) => istAt(d, "10:15") + k * HOUR + LAG));
            const tr = await placebo({ name: label, cfg, account, market, calendar: calendarH, dates: sessions, entryTicks, kind, holds, barMs: HOUR });
            const ps = stats(tr, sessions);
            rows.push([`${label} ${account} placebo-${kind}`, ps]);
            results[`${label}|${account}|placebo-${kind}`] = { stats: ps };
            trial({ wp: "WP3", variant: `${label} placebo-${kind}`, params: { account, draws: DRAWS, seed: SEED, kind }, data: dataNote, trades: ps.trades, net: ps.net, notes: `mean ${ps.mean} SE ${ps.se}` });
          }
        }
      }
      printStats(`Hourly approximation: ${label}`, rows.filter(([k]) => k.startsWith(label)));
      save(`hourly-${[...ONLY].join("+")}`);
    }
  }
}

/** Hourly trades re-priced with 2 extra ticks against us on each side (the copy delay itself cannot be modelled on hourly bars). */
function repriceHourly(positions: Position[], cfg: EngineConfig, h: ReturnType<typeof loadHourly>, calendar: TradingCalendar): TradeLite[] {
  const vixAt = closeLookup(h.vix, HOUR, 0);
  const spotAt = (index: IndexId, t: number) => {
    const date = istDate(t);
    const k = Math.round((t - LAG - istAt(date, "10:15")) / HOUR);
    return h.sessions[index].get(date)?.bars[k]?.c ?? 0;
  };
  return positions
    .filter((p) => p.exitMs !== undefined)
    .map((p) => {
      const qty = p.exitedQty ?? p.qty;
      const tick = p.contract.tickSize;
      const q = (t: number) => syntheticQuote(p.contract, { t, spot: spotAt(p.index, t), vix: vixAt(t - LAG) ?? 0 }, calendar, cfg);
      const entry = roundToTick(q(p.entryMs).ask + 2 * tick, tick);
      const exit = Math.max(tick, roundToTick(q(p.exitMs!).bid - 2 * tick, tick));
      const date = istDate(p.entryMs);
      const charges = computeCharges("BUY", entry, qty, p.contract.exchange, date).total + computeCharges("SELL", exit, qty, p.contract.exchange, date).total;
      const gross = (exit - entry) * qty;
      return { index: p.index, side: p.side, entryMs: p.entryMs, exitMs: p.exitMs!, pnl: r2(gross - charges), gross: r2(gross), charges: r2(charges), exitReason: p.exitReason ?? "?", holdingMin: Math.round((p.exitMs! - p.entryMs) / MINUTE_MS) };
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
