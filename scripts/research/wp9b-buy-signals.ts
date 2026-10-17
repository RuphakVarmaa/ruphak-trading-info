/**
 * WP9b research runner: the plan's no-entry rules N2-N4 and the noise-area morning-only ITM variant on
 * two years of Yahoo hourly bars, the rules' effect on random entries, and data diagnostics
 * (reports/wp9b-buy-signals.md). The 5-minute protocol runs use the backtest CLI (`--protocol`).
 *
 *   npx tsx scripts/research/wp9b-buy-signals.ts --only hourly --hourly <y1h dir> --daily <dir> [--variants H1,H2] [--accounts main,small10k]
 *   npx tsx scripts/research/wp9b-buy-signals.ts --only filters --hourly <y1h dir> --daily <dir>
 *   npx tsx scripts/research/wp9b-buy-signals.ts --only diag --history <hist.json> --archive <archive.json> --runs <dir of protocol-*.json>
 *   npx tsx scripts/research/wp9b-buy-signals.ts --only summary --runs <dir[,dir] of protocol-*.json and hourly-*.json>
 *
 *   --daily     directory with Yahoo daily charts d1_10y_%5EINDIAVIX.json, d1_10y_%5ENSEI.json, d1_10y_%5EBSESN.json (N2's inputs)
 *   --draws 3000 --seed 7 --bootstrap 100000 --trials reports/trials.jsonl --out-dir .cache/research/wp9b
 *
 * hourly   WP3's 2-year approximation (scripts/research/published-strategies.ts): decisions at the hourly
 *          closes 10:15 ... 14:15 seen 90 s later, square-off at the 15:15 close, today's lot sizes and expiry
 *          weekdays on the 2023-2026 index paths, through the engine's planner (every gate, N2-N4 when on),
 *          paper broker, risk state and position cycle. On hourly bars N3 is one morning decision (10:15,
 *          entered 10:16:30) and an exit at the 11:15 close. Each variant gets the acceptance protocol's
 *          verdicts (evaluateProtocol): +2 ticks per side at market as the copy cost (one bar of delay is an
 *          hour here, so criterion 4 fails by construction), a placebo matched to the rule (its decision
 *          times when it enters, a random side, its exits), ±20% perturbations of the rule's parameters, a
 *          day-block bootstrap, Bonferroni and the deflated Sharpe ratio over the trials ledger.
 * filters  the rules on random entries (no signal), paired where possible: the same draws priced with
 *          and without N4's contract; one-hour holds by hour of day (N3's premise); draws on N2-blocked
 *          and N2-allowed days.
 * diag     N2's blocked days on the 5-minute samples; first 15-minute candles measured from the candle's
 *          close; the index-level move of every protocol run's trades.
 * summary  one table of the saved protocol and hourly verdicts (trades, ₹/trade, placebo gap, CI, p, PF).
 *
 * Every run that prices options appends lines to the trials ledger. Option prices are synthetic.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountConfig, accountSpec, type AccountId } from "../../src/engine/accounts";
import { computeCharges, roundTripChargesPerUnit } from "../../src/engine/broker/charges";
import { limitFill, marketFill, marketableLimit, quoteProblem, type FillParams } from "../../src/engine/broker/fillModel";
import { clusteredSe, dayBlockBootstrap, sessionPnls, summarize } from "../../src/engine/backtest/metrics";
import { summarizePlacebo, type PlaceboResult, type PlaceboTrade } from "../../src/engine/backtest/placebo";
import { defaultPerturbParams, evaluateProtocol, formatProtocol, PROTOCOL, tradeStats, type AccountRuns, type PerturbationOutcome, type PerturbParam } from "../../src/engine/backtest/protocol";
import { seededRandom, widenQuote, type BacktestOutput } from "../../src/engine/backtest/runBacktest";
import { TrialLedger, type TrialRecord } from "../../src/engine/backtest/trials";
import { TradingCalendar, loadBundledHolidays } from "../../src/engine/calendar/calendar";
import { MINUTE_MS, addDays, istAt, istDate, istMinutes, weekdayOf } from "../../src/engine/clock";
import { makeConfig, withOverrides, type DeepPartial, type EngineConfig } from "../../src/engine/config";
import { isMonthlyExpiry, optionGrowwSymbol, optionTradingSymbol } from "../../src/engine/instruments/syntheticInstruments";
import { istDateOf } from "../../src/engine/market/candles";
import { neutralFeatures } from "../../src/engine/market/features";
import { parseYahooChart } from "../../src/engine/market/yahooClient";
import { runEndOfDay } from "../../src/engine/pipeline/dayLifecycle";
import { submitEntry } from "../../src/engine/pipeline/execution";
import { runPositionCycle } from "../../src/engine/pipeline/positionCycle";
import { loadRiskState } from "../../src/engine/pipeline/riskState";
import type { InstrumentProvider } from "../../src/engine/ports";
import { SyntheticOptionQuotes, syntheticQuote } from "../../src/engine/pricing/syntheticOptionPricer";
import { haltReason } from "../../src/engine/risk/limits";
import { defaultSettings } from "../../src/engine/settings";
import { evaluateExits, markPosition } from "../../src/engine/strategy/exits";
import { liquidityGates } from "../../src/engine/strategy/gates";
import { chooseContract, choosePremiumBandContract } from "../../src/engine/strategy/optionSelect";
import { planEntry } from "../../src/engine/strategy/planner";
import { firstCandlePlan, firstCandleParams, idleSignal, noiseAreaDecision, publishedConviction, sessionsAt, type PublishedSignal } from "../../src/engine/strategy/published";
import type { NoiseAreaParams } from "../../src/engine/strategy/published/noiseArea";
import { n2Blocks, n2Daily, n2Enabled, n3Allows, n3Enabled, positionExitByMs } from "../../src/engine/strategy/rules";
import { sizePosition } from "../../src/engine/strategy/sizing";
import { createReplayDeps, type ReplayDeps } from "../../src/engine/testing/replayHarness";
import { MARKET_SYMBOLS, type Candle, type Conviction, type IndexId, type OptionContract, type Position, type Quote, type TradeRecord, type TradeSide } from "../../src/engine/types";
import { fail, parseArgs, str, table } from "../lib/node";

const args = parseArgs();
const ONLY = new Set((str(args, "only", "hourly") ?? "").split(","));
const HOURLY = str(args, "hourly", "");
const DAILY_DIR = str(args, "daily", "");
const OUT = resolve(str(args, "out-dir", ".cache/research/wp9b")!);
const TRIALS = resolve(str(args, "trials", "reports/trials.jsonl")!);
const SEED = Number(str(args, "seed", "7"));
const DRAWS = Number(str(args, "draws", "3000"));
const RESAMPLES = Number(str(args, "bootstrap", "100000"));
const ACCOUNTS = (str(args, "accounts", "main,small10k") ?? "").split(",") as AccountId[];
mkdirSync(OUT, { recursive: true });

const HOUR = 60 * MINUTE_MS;
const LAG = 90_000;
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];
const COPY_TICKS = 2;
/** Main at production's limits, one position per index as the published rules require. */
const MAIN_LIMITS: DeepPartial<EngineConfig> = { sizing: { maxOpenPerIndex: 1, maxOpenTotal: 2, maxTradesPerDay: 8 } };
const r2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Variants (declared before any run; reports/wp9b-buy-signals.md §2)
// ---------------------------------------------------------------------------------------------

const NA: DeepPartial<EngineConfig> = { strategy: { mode: "NOISE_AREA" } };
const NA_SRC = "Zarattini, Aziz & Barbon (2024), SSRN 4824172: noise area 14 sessions, VM 1 (WP3 build; hourly approximation)";
const VARIANTS: Record<string, { patch: DeepPartial<EngineConfig>; frozen: string; note: string }> = {
  H0: { patch: NA, frozen: NA_SRC, note: "noise area as WP3 ran it (harness check against WP3's H NA-base; a re-run, not a new rule)" },
  H1: { patch: { ...NA, rules: { n2: { enabled: true } } }, frozen: `${NA_SRC}; plan §4 N2`, note: "noise area + N2" },
  H2: { patch: { ...NA, rules: { n3: { enabled: true } } }, frozen: `${NA_SRC}; plan §4 N3`, note: "noise area + N3 (one 10:15 decision, out at the 11:15 close)" },
  H3: { patch: { ...NA, rules: { n4: { enabled: true } } }, frozen: `${NA_SRC}; plan §4 N4`, note: "noise area + N4" },
  H4: { patch: { ...NA, rules: { n2: { enabled: true }, n3: { enabled: true }, n4: { enabled: true } } }, frozen: `${NA_SRC}; plan §4 N2, N3, N4`, note: "noise area + N2 + N3 + N4" },
  H5: { patch: { ...NA, rules: { n3: { enabled: true } }, pricing: { ivSource: "calibrated" } }, frozen: `${NA_SRC}; plan §4 N3; calibrated IV (WP6)`, note: "noise area + N3, ATM, calibrated IV (the ITM comparator)" },
  H6: { patch: { ...NA, rules: { n3: { enabled: true } }, selection: { itmSteps: 1 }, pricing: { ivSource: "calibrated" } }, frozen: `${NA_SRC}; plan §4 N3; plan §7 one strike ITM; calibrated IV (WP6)`, note: "noise area + N3, 1 strike ITM, calibrated IV" },
  H7: { patch: { ...NA, rules: { n3: { enabled: true } }, selection: { itmSteps: 2 }, pricing: { ivSource: "calibrated" } }, frozen: `${NA_SRC}; plan §4 N3; 2 strikes ITM (brief: 1-2); calibrated IV (WP6)`, note: "noise area + N3, 2 strikes ITM, calibrated IV" },
};

function configFor(patch: DeepPartial<EngineConfig>): EngineConfig {
  return withOverrides(makeConfig(MAIN_LIMITS), patch);
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

const ledger = new TrialLedger(
  {
    read: () => (existsSync(TRIALS) ? readFileSync(TRIALS, "utf8") : null),
    append: (text: string) => {
      mkdirSync(resolve(TRIALS, ".."), { recursive: true });
      appendFileSync(TRIALS, text);
    },
  },
  TRIALS,
);

function line(variant: string, fields: Omit<TrialRecord, "ts" | "wp" | "variant" | "data">, data: string): TrialRecord {
  return { ts: new Date().toISOString(), wp: "WP9b", variant, data, ...fields };
}

// ---------------------------------------------------------------------------------------------
// Hourly data (as WP3) and the daily closes N2 reads
// ---------------------------------------------------------------------------------------------

interface HourlySession {
  date: string;
  /** Bars opening 09:15 ... 14:15 (60 minutes each). */
  bars: Candle[];
  open: number;
  close: number;
}

interface Hourly {
  sessions: Record<IndexId, Map<string, HourlySession>>;
  vix: Candle[];
  /** Last hourly VIX close of each session (the 15:15 bar). */
  vixClose: Map<string, number>;
  dates: string[];
  holidays: string[];
}

function readChart(dir: string, file: string, sym: string): Candle[] {
  return parseYahooChart(JSON.parse(readFileSync(join(dir, file), "utf8")), sym).candles;
}

function loadHourly(): Hourly {
  if (!HOURLY) fail("--hourly <dir> is required");
  const raw: Record<IndexId, Candle[]> = { NIFTY: readChart(HOURLY, "NSEI.json", "^NSEI"), SENSEX: readChart(HOURLY, "BSESN.json", "^BSESN") };
  const vix = readChart(HOURLY, "INDIAVIX.json", "^INDIAVIX").filter((c) => c.c > 0);
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
  const holidays: string[] = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) if (weekdayOf(d) <= 5 && !seen.has(d)) holidays.push(d);
  const vixClose = new Map<string, number>();
  for (const c of vix) vixClose.set(istDate(c.t), c.c);
  return { sessions, vix, vixClose, dates, holidays };
}

/** Daily bars of India VIX and the two indices for N2 (Yahoo daily, 10 years). */
function loadDaily(): Record<string, Candle[]> {
  if (!DAILY_DIR) fail("--daily <dir> is required (d1_10y_%5EINDIAVIX.json, d1_10y_%5ENSEI.json, d1_10y_%5EBSESN.json)");
  return {
    [MARKET_SYMBOLS.INDIAVIX]: readChart(DAILY_DIR, "d1_10y_%5EINDIAVIX.json", "^INDIAVIX"),
    [MARKET_SYMBOLS.NIFTY]: readChart(DAILY_DIR, "d1_10y_%5ENSEI.json", "^NSEI"),
    [MARKET_SYMBOLS.SENSEX]: readChart(DAILY_DIR, "d1_10y_%5EBSESN.json", "^BSESN"),
  };
}

function hourlyCalendar(h: Hourly): TradingCalendar {
  const bundled = loadBundledHolidays();
  const known = new Set(bundled.map((x) => x.date));
  return new TradingCalendar({ holidays: [...bundled, ...h.holidays.filter((d) => !known.has(d)).map((date) => ({ date, name: "no Yahoo bars (holiday)" }))] });
}

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

interface HourlyMarket {
  dates: string[];
  ticks(date: string): number[];
  spot(index: IndexId, t: number): number | null;
  vix(t: number): number | null;
  /** India VIX now against the previous session's close, percent (N2's "on the day"). */
  vixChangePct(t: number): number;
  signal(index: IndexId, t: number): PublishedSignal;
}

/** WP3's hourly noise area: decisions at the hourly closes 10:15 ... 14:15 (seen 90 s later). */
function hourlyMarket(h: Hourly, cfg: EngineConfig, firstDate: string): HourlyMarket {
  const vixAt = closeLookup(h.vix, HOUR, 0);
  const p: NoiseAreaParams = { ...cfg.strategy.noiseArea, anchorMin: 15, decisionEveryMin: 60 };
  const dates = h.dates.filter((d) => d >= firstDate);
  const all = h.dates;
  const pos = new Map(all.map((d, i) => [d, i]));
  const cache = new Map<string, PublishedSignal>();
  const k = (t: number) => Math.round((t - LAG - istAt(istDate(t), "10:15")) / HOUR);
  const signal = (index: IndexId, t: number): PublishedSignal => {
    const key = `${index}|${t}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const date = istDate(t);
    const i = pos.get(date) ?? -1;
    const kk = k(t);
    let sig: PublishedSignal = idleSignal(cfg, "no decision");
    if (i >= 1 && kk >= 0 && kk <= 5) {
      const s = h.sessions[index].get(date)!;
      const history = all.slice(Math.max(0, i - p.lookbackSessions), i).map((d) => ({ date: d, open: h.sessions[index].get(d)!.open, bars: h.sessions[index].get(d)!.bars }));
      const prevClose = h.sessions[index].get(all[i - 1])!.close;
      const dec = noiseAreaDecision({ date, open: s.open, bars: s.bars.slice(0, kk + 1) }, history, prevClose, p, HOUR, kk);
      if (dec) sig = dec;
    }
    cache.set(key, sig);
    return sig;
  };
  return {
    dates,
    ticks: (date) => Array.from({ length: 6 }, (_, j) => istAt(date, "10:15") + j * HOUR + LAG),
    spot: (index, t) => {
      const s = h.sessions[index].get(istDate(t));
      const kk = k(t);
      return s && kk >= 0 && kk <= 5 ? s.bars[kk].c : null;
    },
    vix: (t) => vixAt(t - LAG),
    vixChangePct: (t) => {
      const i = pos.get(istDate(t)) ?? -1;
      const prev = i >= 1 ? h.vixClose.get(all[i - 1]) : undefined;
      const now = vixAt(t - LAG);
      return prev && now ? (now / prev - 1) * 100 : 0;
    },
    signal,
  };
}

// ---------------------------------------------------------------------------------------------
// Instruments for any date and strike (as WP3)
// ---------------------------------------------------------------------------------------------

function makeContract(cfg: EngineConfig, index: IndexId, expiry: string, strike: number, type: "CE" | "PE"): OptionContract {
  const spec = cfg.indexSpecs[index];
  const tradingSymbol = optionTradingSymbol(spec.underlying, expiry, strike, type, isMonthlyExpiry(index, expiry, cfg));
  return { index, exchange: spec.exchange, tradingSymbol, growwSymbol: optionGrowwSymbol(spec.exchange, spec.underlying, expiry, strike, type), exchangeToken: `SYN-${tradingSymbol}`, expiry, strike, type, lotSize: spec.lotSize, tickSize: spec.tickSize };
}

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
// The engine on hourly bars
// ---------------------------------------------------------------------------------------------

/** The rule through the engine's planner, broker, risk state and position cycle, exits before entries (as WP3's hourly harness). */
async function harnessRun(market: HourlyMarket, acfg: EngineConfig, calendar: TradingCalendar, daily: Record<string, Candle[]>): Promise<{ trades: TradeRecord[]; positions: Position[] }> {
  const start = istAt(market.dates[0], "09:00");
  const deps = createReplayDeps({ cfg: acfg, startMs: start, candles: {}, daily, calendar, lagMs: 0 });
  const instruments = anyInstruments(acfg, calendar, () => deps.clock.now());
  const d: ReplayDeps = { ...deps, instruments };
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
        convictions[index] = publishedConviction(index, t, market.signal(index, t), "RANGE", acfg);
      }
      await runPositionCycle(d, { convictions, events: [] });
      const settings = await d.repo.settings.get();
      const risk = await loadRiskState(d.repo, acfg, settings, t, d.mode);
      const halt = haltReason(risk, acfg);
      for (const index of acfg.indices) {
        const conviction = convictions[index];
        const spot = spots[index];
        if (!conviction || spot === undefined) continue;
        const f = { ...neutralFeatures(index, { t, candles: {}, daily: {}, ltp: { [index]: spot }, dataAgeSec: LAG / 1000 }, calendar), spot, vix, vixChangePct: market.vixChangePct(t), dataAgeSec: LAG / 1000 };
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
    }
    d.clock.set(istAt(date, "16:00"));
    await runEndOfDay(d, { grade: false, performance: false });
  }
  const end = istAt(addDays(market.dates[market.dates.length - 1], 1), "00:00");
  const trades = (await d.repo.trades.between(start, end, "BACKTEST")).sort((a, b) => a.entryMs - b.entryMs);
  const positions = await d.repo.positions.closedBetween(start, end, "BACKTEST");
  return { trades, positions };
}

const fillParams = (cfg: EngineConfig, c: OptionContract): FillParams => ({ tickSize: c.tickSize, slippageTicksMarket: cfg.broker.slippageTicksMarket, depthLevels: cfg.broker.partialFillDepthLevels, maxQuoteAgeMs: cfg.gates.maxDataAgeSec * 1000 });

/** The same trades with the copier's cost: at market, +2 ticks against us on each side (no bar delay: a bar is an hour here). */
function repriceCopy(trades: TradeRecord[], positions: Position[], cfg: EngineConfig, market: HourlyMarket, calendar: TradingCalendar): TradeRecord[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return trades.map((t) => {
    const p = byId.get(t.positionId);
    if (!p || p.exitMs === undefined) return t;
    const qty = t.qty;
    const c = p.contract;
    const q = (ms: number): Quote => widenQuote(syntheticQuote(c, { t: ms, spot: market.spot(c.index, ms) ?? 0, vix: market.vix(ms) ?? 0 }, calendar, cfg), COPY_TICKS, c.tickSize);
    const entry = marketFill("BUY", qty, q(t.entryMs), fillParams(cfg, c)).avgPrice;
    const exit = marketFill("SELL", qty, q(t.exitMs), fillParams(cfg, c)).avgPrice;
    const date = istDate(t.entryMs);
    const charges = computeCharges("BUY", entry, qty, c.exchange, date).total + computeCharges("SELL", exit, qty, c.exchange, date).total;
    const gross = (exit - entry) * qty;
    return { ...t, entryPremium: entry, exitPremium: exit, grossPnl: r2(gross), charges: r2(charges), pnl: r2(gross - charges), pnlPctPremium: entry > 0 ? r2(((gross - charges) / (entry * qty)) * 100) : 0 };
  });
}

// ---------------------------------------------------------------------------------------------
// Placebo on hourly bars (mirrors src/engine/backtest/placebo.ts)
// ---------------------------------------------------------------------------------------------

interface DrawSpec {
  date: string;
  index: IndexId;
  side: TradeSide;
  t0: number;
}

interface PlaceboOpts {
  cfg: EngineConfig;
  market: HourlyMarket;
  calendar: TradingCalendar;
  daily: Record<string, Candle[]>;
  /** "rule": the rule's decision ticks when it enters, its own exits. "hold": any decision tick, held to the exit time with the premium stop only. */
  kind: "rule" | "hold";
  /** Hold policy for "hold": to the square-off (or N3's exit), or one hour (the next tick). */
  holdHours?: number;
  copy: boolean;
}

type DrawResult = PlaceboTrade | string;

async function simulateDraw(o: PlaceboOpts, s: DrawSpec): Promise<DrawResult> {
  const { cfg, market, calendar } = o;
  const { date, index, side, t0 } = s;
  const spot0 = market.spot(index, t0);
  const vix0 = market.vix(t0);
  if (!spot0 || !vix0) return "no market data";
  if (calendar.isExpiryDay(index, date) && (calendar.closeMs(date) - t0) / MINUTE_MS <= cfg.gates.expiryDayNoEntryMinBeforeClose) return "expiry-day cutoff";
  if (n3Enabled(cfg) && !n3Allows(t0, cfg)) return "outside N3's window";
  if (o.kind === "rule" && market.signal(index, t0).entry === null) return "no rule entry";
  if (n2Enabled(cfg) && n2Blocks(n2Daily(o.daily[MARKET_SYMBOLS.INDIAVIX] ?? [], o.daily[MARKET_SYMBOLS[index]] ?? [], date, cfg), market.vixChangePct(t0), cfg).length > 0) return "N2 blocks";
  const quotes = new SyntheticOptionQuotes(calendar, cfg);
  const instruments = anyInstruments(cfg, calendar, () => t0);
  const settings = defaultSettings(cfg, t0);
  const cash = cfg.sizing.useCurrentEquity ? cfg.capitalRupees : undefined;
  const lotsFor = (premium: number, c: OptionContract) =>
    sizePosition({ premium, contract: c, perf: undefined, sizeMult: 1, capitalRupees: cfg.capitalRupees, openPremiumRupees: 0, settings, cashRupees: cash, chargeReservePerLot: cash === undefined ? 0 : roundTripChargesPerUnit(premium, c.lotSize, c.exchange, date) * c.lotSize }, cfg).lots;
  const ctx0 = { t: t0, spot: spot0, vix: vix0 };
  let contract: OptionContract | null;
  let q0: Quote | null;
  if (cfg.selection.mode === "PREMIUM_BAND") {
    const pick = await choosePremiumBandContract({ index, spot: spot0, vix: vix0, side, t: t0, instruments, optionQuotes: quotes, calendar, cfg, quoteOk: (q, c) => quoteProblem(q, t0, fillParams(cfg, c)) === null, affordable: (p, c) => lotsFor(p, c) >= 1 });
    contract = pick.quote ? pick.contract : null;
    q0 = pick.quote;
  } else {
    contract = await chooseContract(index, spot0, side, t0, instruments, calendar, cfg);
    q0 = contract ? await quotes.quote(contract, ctx0) : null;
  }
  if (!contract || !q0) return "no contract";
  if (quoteProblem(q0, t0, fillParams(cfg, contract))) return "no usable quote";
  if (liquidityGates(q0, contract, cfg).some((g) => g.passed === false)) return "liquidity gate";
  const lots = lotsFor(q0.ask, contract);
  if (lots < 1) return "sized to zero lots";
  const qty = lots * contract.lotSize;
  const fp = fillParams(cfg, contract);
  let entryPx: number;
  if (o.copy) entryPx = marketFill("BUY", qty, widenQuote(q0, COPY_TICKS, contract.tickSize), fp).avgPrice;
  else {
    const f = limitFill("BUY", qty, marketableLimit("BUY", q0, contract.tickSize), q0);
    if (f.filledQty < qty) return "entry limit not filled";
    entryPx = f.avgPrice;
  }
  const entryCharges = computeCharges("BUY", entryPx, qty, contract.exchange, date).total;
  const exitBy = positionExitByMs(t0, cfg);
  const holdEnd = o.kind === "hold" && o.holdHours ? Math.min(exitBy, t0 + o.holdHours * HOUR - LAG) : exitBy;
  let pos: Position = {
    id: "placebo",
    planId: "placebo",
    index,
    side,
    contract,
    mode: "BACKTEST",
    qty,
    avgEntry: entryPx,
    entryMs: t0,
    entryCharges,
    status: "OPEN",
    markPremium: entryPx,
    markMs: t0,
    peakPremium: entryPx,
    unrealized: 0,
    stops:
      o.kind === "rule"
        ? { stopPct: cfg.exits.stopPct, targetPct: cfg.exits.targetPct, trailActivatePct: cfg.exits.trailActivatePct, trailGivebackPct: cfg.exits.trailGivebackPct, timeStopMs: exitBy, squareOffMs: exitBy }
        : { stopPct: cfg.exits.stopPct, targetPct: 1e9, trailActivatePct: 1e9, trailGivebackPct: 50, timeStopMs: holdEnd, squareOffMs: holdEnd },
    horizonMin: Math.round((holdEnd - t0) / MINUTE_MS),
    convictionAtEntry: 0,
    regimeAtEntry: "RANGE",
    dominantSource: "MOMENTUM",
    attribution: [],
    eventKeysAtEntry: [],
    maePct: 0,
    mfePct: 0,
  };
  for (const t of market.ticks(date).filter((x) => x > t0)) {
    const spot = market.spot(index, t);
    if (spot === null) continue;
    const q = await quotes.quote(contract, { t, spot, vix: market.vix(t) ?? vix0 });
    pos = markPosition(pos, q, t);
    const conviction = o.kind === "rule" ? publishedConviction(index, t, { ...market.signal(index, t), entry: null }, "RANGE", cfg) : undefined;
    const dec = evaluateExits(pos, q, { nowMs: t, conviction }, cfg);
    if (!dec) continue;
    let exitPx: number;
    if (o.copy) exitPx = marketFill("SELL", qty, widenQuote(q, COPY_TICKS, contract.tickSize), fp).avgPrice;
    else if (dec.orderType === "LIMIT") {
      const f = limitFill("SELL", qty, dec.limitPrice ?? q.bid, q);
      exitPx = f.filledQty >= qty ? f.avgPrice : marketFill("SELL", qty, q, fp).avgPrice;
    } else exitPx = marketFill("SELL", qty, q, fp).avgPrice;
    const charges = entryCharges + computeCharges("SELL", exitPx, qty, contract.exchange, date).total;
    const gross = (exitPx - entryPx) * qty;
    return { day: date, index, side, tradingSymbol: contract.tradingSymbol, expiry: contract.expiry, strike: contract.strike, entryMs: t0, exitMs: t, holdingMin: Math.round((t - t0) / MINUTE_MS), regime: null, horizonMin: pos.horizonMin, lots, qty, entryPremium: entryPx, exitPremium: exitPx, grossPnl: r2(gross), charges: r2(charges), pnl: r2(gross - charges), exitReason: dec.reason };
  }
  return "never exited";
}

/** Seeded draws (date, index, side, tick) in a fixed order; untradable draws are redrawn. */
async function placeboRun(o: PlaceboOpts, dates: string[], draws: number, seed: number, entryTicks: (date: string) => number[]): Promise<PlaceboResult> {
  const rnd = seededRandom(seed);
  const trades: PlaceboTrade[] = [];
  const rejected: Record<string, number> = {};
  let attempts = 0;
  while (trades.length < draws) {
    if (attempts >= draws * 300) throw new Error(`placebo: only ${trades.length} of ${draws} draws after ${attempts} attempts (${JSON.stringify(rejected)})`);
    attempts++;
    const date = dates[Math.floor(rnd() * dates.length)];
    const index = INDICES[Math.floor(rnd() * INDICES.length)];
    const side: TradeSide = rnd() < 0.5 ? "BULL" : "BEAR";
    const ticks = entryTicks(date);
    const t0 = ticks[Math.floor(rnd() * ticks.length)];
    const r = await simulateDraw(o, { date, index, side, t0 });
    if (typeof r === "string") rejected[r] = (rejected[r] ?? 0) + 1;
    else trades.push(r);
  }
  const e = o.cfg.exits;
  return {
    settings: {
      draws,
      seed,
      sizing: "engine",
      horizon: o.kind === "rule" ? "the rule's exits for the drawn side (hourly)" : `held ${o.holdHours ? `${o.holdHours} h` : "to the exit time"} (premium stop only)`,
      window: "hourly decision ticks",
      copyDelay: o.copy ? `+${COPY_TICKS} ticks per side at market (no bar delay)` : "none (the engine's own fills)",
      sessions: dates.length,
      slots: 5,
      indices: [...INDICES],
      exits: { stopPct: e.stopPct, targetPct: e.targetPct, trailActivatePct: e.trailActivatePct, trailGivebackPct: e.trailGivebackPct, timeStopMinPnlPct: e.timeStopMinPnlPct, squareOffIst: e.squareOffIst },
    },
    attempts,
    rejected,
    trades,
    summary: summarizePlacebo(trades),
  };
}

// ---------------------------------------------------------------------------------------------
// Hourly protocol runs
// ---------------------------------------------------------------------------------------------

function output(trades: TradeRecord[], days: string[], capital: number): BacktestOutput {
  return { from: days[0], to: days[days.length - 1], days, skippedDays: [], trades, ledgers: [], summary: summarize(trades, [], capital, 0), attribution: [], equityCurve: [], decisions: 0, notes: [] };
}

/** Hourly bars decide once an hour, so N3's start and the noise area's 30-minute grid do not apply there. */
function hourlyPerturbParams(cfg: EngineConfig): PerturbParam[] {
  return defaultPerturbParams(cfg).filter((p) => p.name !== "noise-every" && p.name !== "n3-start");
}

async function hourlyVariant(name: string, h: Hourly, calendar: TradingCalendar, daily: Record<string, Candle[]>): Promise<void> {
  const v = VARIANTS[name] ?? fail(`unknown variant ${name}`);
  const cfg = configFor(v.patch);
  const firstDate = h.dates[14];
  const sessions = h.dates.filter((d) => d >= firstDate);
  const dataNote = `yahoo 1h ${h.dates[0]}..${h.dates[h.dates.length - 1]}, ${sessions.length} sessions traded; decisions at hourly closes 10:15..14:15 (+90 s), square-off at the 15:15 close; N2 from Yahoo daily closes; today's contract specs; synthetic option prices (${cfg.pricing.ivSource} IV)`;
  const markets = new Map<string, HourlyMarket>();
  const marketFor = (c: EngineConfig) => {
    const key = JSON.stringify(c.strategy.noiseArea);
    let m = markets.get(key);
    if (!m) markets.set(key, (m = hourlyMarket(h, c, firstDate)));
    return m;
  };
  const market = marketFor(cfg);
  const entryTicks = (date: string) => market.ticks(date).slice(0, 5);
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${name} ${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
  const runs: Partial<Record<AccountId, AccountRuns>> = {};
  const lines: TrialRecord[] = [];
  const perturb = hourlyPerturbParams(cfg);
  // A small account's own book stops once losses leave too little for a lot (WP3); main's signals priced
  // with its contract on a fresh account per trade give its per-trade economics (WP3's "signals" measure).
  let mainEntries: DrawSpec[] = [];
  const fresh: Record<string, unknown> = {};
  for (const account of ACCOUNTS) {
    const acfg = accountConfig(cfg, account);
    log(`${account}: replay`);
    const r = await harnessRun(market, acfg, calendar, daily);
    const copied = repriceCopy(r.trades, r.positions, acfg, market, calendar);
    log(`${account}: ${r.trades.length} trades; placebo`);
    const pl = { cfg: acfg, market, calendar, daily, kind: "rule" as const };
    const placeboNo = await placeboRun({ ...pl, copy: false }, sessions, DRAWS, SEED, entryTicks);
    const placeboCopy = await placeboRun({ ...pl, copy: true }, sessions, DRAWS, SEED, entryTicks);
    if (account === "main") mainEntries = r.trades.map((t) => ({ date: istDate(t.entryMs), index: t.index as IndexId, side: t.side, t0: t.entryMs }));
    else if (mainEntries.length > 0) {
      const res = await Promise.all(mainEntries.map((s) => simulateDraw({ ...pl, copy: true }, s)));
      const ft = res.filter((x): x is PlaceboTrade => typeof x !== "string");
      const boot = dayBlockBootstrap(sessionPnls(ft, sessions), { resamples: RESAMPLES, seed: SEED });
      const st = tradeStats(ft as unknown as TradeRecord[], sessions, acfg.capitalRupees);
      const se = Math.max(st.se, boot.perTrade.se);
      const gap = st.mean - placeboCopy.summary.mean;
      fresh[account] = { trades: st.trades, mean: r2(st.mean), se: r2(se), ci: [r2(boot.perTrade.lo), r2(boot.perTrade.hi)], p: boot.perTrade.p, placebo: placeboCopy.summary.mean, gap: r2(gap), gapSe: se > 0 ? r2(gap / se) : null, pf: r2(st.profitFactor), skipped: res.length - ft.length };
      log(`${account}: main's signals on a fresh ${account} account per trade: ${JSON.stringify(fresh[account])}`);
      lines.push(line(`H ${name} ${v.note} / ${account} main's signals, fresh account per trade, +2 ticks`, { params: { hourly: true, variant: name, patch: v.patch, account, signals: mainEntries.length }, notes: `per-trade economics of main's entries with ${account}'s contract and exits, no capital depletion`, trades: st.trades, net: st.net, kind: "strategy", account, sessions: st.sessions, meanPerTrade: r2(st.mean), srSession: Math.round(st.srSession * 1e6) / 1e6 }, dataNote));
    }
    const perts: PerturbationOutcome[] = [];
    for (const p of perturb) {
      for (const f of [0.8, 1.2]) {
        let pcfg: EngineConfig;
        try {
          pcfg = withOverrides(acfg, p.patch(acfg, f));
        } catch (err) {
          perts.push({ param: p.name, factor: f, trades: 0, net: 0, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const pm = marketFor(pcfg);
        const pr = await harnessRun(pm, pcfg, calendar, daily);
        const s = tradeStats(repriceCopy(pr.trades, pr.positions, pcfg, pm, calendar), sessions, pcfg.capitalRupees);
        perts.push({ param: p.name, factor: f, trades: s.trades, net: s.net, sessions: s.sessions, srSession: s.srSession });
        log(`${account}: ${p.name} x${f}: ${s.trades} trades, net ${s.net}`);
      }
    }
    runs[account] = { account, cfg: acfg, copyDelay: { fillDelayBars: 0, extraTicks: COPY_TICKS }, noDelay: output(r.trades, sessions, acfg.capitalRupees), delayed: output(copied, sessions, acfg.capitalRupees), placebo: { noDelay: placeboNo, delayed: placeboCopy }, perturbations: perts };
    const label = `H ${name} ${v.note}`;
    const fields = (trades: TradeRecord[], kind: "strategy" | "copy-delay") => {
      const s = tradeStats(trades, sessions, acfg.capitalRupees);
      return { trades: s.trades, net: s.net, kind, account, sessions: s.sessions, meanPerTrade: r2(s.mean), srSession: Math.round(s.srSession * 1e6) / 1e6 };
    };
    const params = { hourly: true, variant: name, patch: v.patch, account };
    lines.push(line(`${label} / ${account} engine fills`, { params, notes: "hourly harness, engine fills", ...fields(r.trades, "strategy") }, dataNote));
    lines.push(line(`${label} / ${account} +2 ticks`, { params, notes: "same trades, +2 ticks per side at market", ...fields(copied, "copy-delay") }, dataNote));
    for (const [tag, p] of [["placebo", placeboNo], ["placebo +2 ticks", placeboCopy]] as const) {
      lines.push(line(`${label} / ${account} ${tag}`, { params: { ...params, draws: DRAWS, seed: SEED }, notes: `rule-matched placebo: ${p.settings.horizon}; mean ${p.summary.mean} SE ${p.summary.se}`, trades: p.summary.n, net: r2(p.trades.reduce((a, t) => a + t.pnl, 0)), kind: "placebo", account, meanPerTrade: p.summary.mean }, dataNote));
    }
    for (const p of perts) if (!p.error) lines.push(line(`${label} / ${account} ${p.param} x${p.factor}`, { params: { ...params, perturb: { param: p.param, factor: p.factor } }, notes: "±20% one-at-a-time, +2 ticks per side", trades: p.trades, net: p.net, kind: "perturbation", account, sessions: p.sessions, srSession: p.srSession }, dataNote));
  }
  ledger.append(...lines);
  const stats = ledger.stats();
  const ctx = { from: sessions[0], to: sessions[sessions.length - 1], frozen: v.frozen, ledger: stats, thresholds: PROTOCOL, bootstrap: { resamples: RESAMPLES, seed: SEED } };
  const reports: Record<string, unknown> = {};
  const follower = ACCOUNTS.find((a) => a !== "main");
  const fRep = follower && runs[follower] ? evaluateProtocol(runs[follower]!, `${accountSpec(follower).label} (hourly)`, ctx) : null;
  if (runs.main) {
    const mRep = evaluateProtocol(runs.main, `Main account (hourly, ${name})`, { ...ctx, followers: fRep && follower ? [{ account: follower, label: fRep.label, verdict: fRep.verdict }] : undefined });
    console.log(`\n${formatProtocol(mRep)}`);
    reports.main = mRep;
  }
  if (fRep) {
    console.log(`\n${formatProtocol(fRep)}`);
    reports[follower!] = fRep;
  }
  const tradesOut = Object.fromEntries(Object.entries(runs).map(([a, r]) => [a, { trades: r!.delayed.trades, noDelay: r!.noDelay.trades }]));
  writeFileSync(join(OUT, `hourly-${name}.json`), JSON.stringify({ variant: name, note: v.note, frozen: v.frozen, data: dataNote, ledger: stats, reports, fresh, trades: tradesOut }, null, 1));
  console.log(`\nLogged ${lines.length} trial(s) to ${stats.path} (${stats.n} in total). ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// ---------------------------------------------------------------------------------------------
// The rules on random entries (no signal), 2 years of hourly bars
// ---------------------------------------------------------------------------------------------

interface Group {
  label: string;
  n: number;
  mean: number;
  seDay: number;
}

function group(label: string, trades: PlaceboTrade[]): Group {
  const byDay = new Map<string, number[]>();
  for (const t of trades) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t.pnl]);
  const n = trades.length;
  return { label, n, mean: n ? r2(trades.reduce((a, t) => a + t.pnl, 0) / n) : 0, seDay: r2(clusteredSe([...byDay.values()])) };
}

/** Mean and day-clustered SE of paired differences (b - a) on the same draws. */
function paired(label: string, a: PlaceboTrade[], b: PlaceboTrade[]): Group {
  const byDay = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) byDay.set(a[i].day, [...(byDay.get(a[i].day) ?? []), b[i].pnl - a[i].pnl]);
  const diffs = [...byDay.values()].flat();
  return { label, n: diffs.length, mean: diffs.length ? r2(diffs.reduce((x, y) => x + y, 0) / diffs.length) : 0, seDay: r2(clusteredSe([...byDay.values()])) };
}

async function filters(h: Hourly, calendar: TradingCalendar, daily: Record<string, Candle[]>): Promise<void> {
  const firstDate = h.dates[14];
  const sessions = h.dates.filter((d) => d >= firstDate);
  const dataNote = `yahoo 1h ${sessions[0]}..${sessions[sessions.length - 1]} (${sessions.length} sessions); random entries at hourly closes 10:15..14:15 (+90 s); synthetic option prices`;
  const out: Record<string, unknown> = {};
  const lines: TrialRecord[] = [];
  for (const account of ACCOUNTS) {
    const base = accountConfig(configFor({}), account);
    const market = hourlyMarket(h, base, firstDate);
    const rnd = seededRandom(SEED + 101);
    // One fixed set of draws, evaluated under each variant (paired).
    const specs: DrawSpec[] = [];
    while (specs.length < DRAWS) {
      const date = sessions[Math.floor(rnd() * sessions.length)];
      const index = INDICES[Math.floor(rnd() * INDICES.length)];
      const side: TradeSide = rnd() < 0.5 ? "BULL" : "BEAR";
      const ticks = market.ticks(date).slice(0, 5);
      specs.push({ date, index, side, t0: ticks[Math.floor(rnd() * ticks.length)] });
    }
    const evaluate = async (cfg: EngineConfig, holdHours?: number) => {
      const o: PlaceboOpts = { cfg, market, calendar, daily, kind: "hold", holdHours, copy: true };
      return Promise.all(specs.map((s) => simulateDraw(o, s)));
    };
    const ok = (r: DrawResult[]) => r.filter((x): x is PlaceboTrade => typeof x !== "string");
    const toClose = await evaluate(base);
    const n4cfg = withOverrides(base, { rules: { n4: { enabled: true } } });
    const n4 = await evaluate(n4cfg);
    const hour = await evaluate(base, 1);
    // N4: the same draws where N4 changes the contract (the day before an expiry).
    const a: PlaceboTrade[] = [];
    const b: PlaceboTrade[] = [];
    toClose.forEach((r, i) => {
      const s = n4[i];
      if (typeof r !== "string" && typeof s !== "string" && r.expiry !== s.expiry) {
        a.push(r);
        b.push(s);
      }
    });
    // N2: the draws N2 would block, against the rest (to the close; not paired).
    const n2cfg = withOverrides(base, { rules: { n2: { enabled: true } } });
    const blocked = ok(toClose).filter((t) => n2Blocks(n2Daily(daily[MARKET_SYMBOLS.INDIAVIX] ?? [], daily[MARKET_SYMBOLS[t.index]] ?? [], t.day, n2cfg), market.vixChangePct(t.entryMs), n2cfg).length > 0);
    const blockedSet = new Set(blocked);
    const allowed = ok(toClose).filter((t) => !blockedSet.has(t));
    // N3: one-hour holds by the hour they start (10:15 is N3's morning hour on hourly bars).
    const byHour = [10, 11, 12, 13, 14].map((hh) => group(`1-hour hold from ${hh}:15`, ok(hour).filter((t) => Math.floor(istMinutes(t.entryMs) / 60) === hh)));
    const rows: Group[] = [
      group("all draws, held to the 15:15 close", ok(toClose)),
      group("N2 allows the draw", allowed),
      group("N2 blocks the draw", blocked),
      group("draws where N4 changes the contract: nearest weekly (1 session left)", a),
      group("same draws, N4's contract (next weekly)", b),
      paired("N4 minus nearest, paired", a, b),
      ...byHour,
    ];
    console.log(`\n=== Rules on random entries: ${accountSpec(account).label}, ${DRAWS} draws, +2 ticks per side ===`);
    console.log(table([["group", "n", "₹/trade", "SE (day)"], ...rows.map((g) => [g.label, g.n, g.mean, g.seDay])]));
    out[account] = rows;
    for (const [tag, list] of [["to close", ok(toClose)], ["N4 contract", ok(n4)], ["1-hour holds", ok(hour)]] as const) {
      lines.push(line(`filters ${account} ${tag}`, { params: { hourly: true, account, draws: DRAWS, seed: SEED + 101 }, notes: "random entries, premium stop only, +2 ticks per side; the rules' effect on zero-edge trades", trades: list.length, net: r2(list.reduce((s, t) => s + t.pnl, 0)), kind: "placebo", account, meanPerTrade: list.length ? r2(list.reduce((s, t) => s + t.pnl, 0) / list.length) : 0 }, dataNote));
    }
  }
  ledger.append(...lines);
  writeFileSync(join(OUT, "filters.json"), JSON.stringify(out, null, 1));
  console.log(`\nLogged ${lines.length} trial(s) to ${TRIALS} (${ledger.stats().n} in total).`);
}

// ---------------------------------------------------------------------------------------------
// Diagnostics on the 5-minute samples (no option prices)
// ---------------------------------------------------------------------------------------------

function diag(): void {
  const hist = str(args, "history", "") || fail("--history is required for diag");
  const arch = str(args, "archive", "") || fail("--archive is required for diag");
  const runsDir = str(args, "runs", "");
  const calendar = new TradingCalendar();
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { candles: Record<string, Candle[]>; daily: Record<string, Candle[]> };
  const H = read(hist);
  const A = read(arch);
  const out: Record<string, unknown> = {};
  const cfg = makeConfig({ rules: { n2: { enabled: true } } });

  // N2's previous-close conditions on each session of the samples.
  const days = [...new Set(A.candles[MARKET_SYMBOLS.NIFTY].map((c) => istDateOf(c.t)))].filter((d) => d >= "2026-07-23" && calendar.isTradingDay(d)).sort();
  const n2Rows: (string | number)[][] = [];
  const n2Count: Record<string, number> = {};
  for (const d of days) {
    for (const index of INDICES) {
      const dd = n2Daily(A.daily[MARKET_SYMBOLS.INDIAVIX] ?? [], A.daily[MARKET_SYMBOLS[index]] ?? [], d, cfg);
      const blocks = n2Blocks(dd, 0, cfg);
      for (const b of blocks) {
        const k = b.replace(/[+-]?\d+(\.\d+)?/g, "x");
        n2Count[k] = (n2Count[k] ?? 0) + 1;
      }
      n2Rows.push([d, index, dd?.vix5dChangePct?.toFixed(1) ?? "n/a", dd?.vixPctile !== null && dd ? Math.round(dd.vixPctile! * 100) : "n/a", dd?.run5dPct?.toFixed(2) ?? "n/a", blocks.length ? "blocked" : "allowed"]);
    }
  }
  const blockedN = n2Rows.filter((r) => r[5] === "blocked").length;
  console.log(`\n=== N2 on the 5-minute samples (previous-close conditions; the intraday VIX jump comes on top) ===`);
  console.log(`${blockedN} of ${n2Rows.length} index-sessions blocked; by condition: ${JSON.stringify(n2Count)}`);
  console.log(table([["date", "index", "VIX 5d %", "VIX pctile", "index 5d %", "N2"], ...n2Rows]));
  out.n2 = { rows: n2Rows, blocked: blockedN, total: n2Rows.length, byCondition: n2Count };

  // First 15-minute candles, measured from the candle's close (and, for contrast, from the open).
  const p = firstCandleParams(makeConfig({}));
  const fcRows: (string | number)[][] = [];
  const legs: { day: string; index: IndexId; body: number; to1115: number; to1505: number; fromOpen1505: number }[] = [];
  const allDays = [...new Set(A.candles[MARKET_SYMBOLS.NIFTY].map((c) => istDateOf(c.t)))].filter((d) => calendar.isTradingDay(d)).sort();
  for (const d of allDays) {
    for (const index of INDICES) {
      const s = sessionsAt(A.candles[MARKET_SYMBOLS[index]], calendar, istAt(d, "23:00"), 5 * MINUTE_MS, 0).today;
      if (!s) continue;
      const plan = firstCandlePlan(s.bars, istAt(d, "09:15"), p, 5 * MINUTE_MS);
      if (!plan.side || plan.close === null || plan.open === null) continue;
      const closeAt = (hhmm: string) => s.bars.find((b) => b.t + 5 * MINUTE_MS === istAt(d, hhmm))?.c ?? null;
      const c1115 = closeAt("11:15");
      const c1505 = closeAt("15:05");
      if (c1115 === null || c1505 === null) continue;
      const sign = plan.side === "BULL" ? 1 : -1;
      const leg = { day: d, index, body: plan.bodyPct!, to1115: sign * Math.log(c1115 / plan.close) * 1e4, to1505: sign * Math.log(c1505 / plan.close) * 1e4, fromOpen1505: sign * Math.log(c1505 / plan.open) * 1e4 };
      legs.push(leg);
      fcRows.push([d, index, plan.bodyPct!.toFixed(3), leg.to1115.toFixed(1), leg.to1505.toFixed(1), leg.fromOpen1505.toFixed(1)]);
    }
  }
  const stat = (xs: number[], daysOf: string[]) => {
    const byDay = new Map<string, number[]>();
    xs.forEach((x, i) => byDay.set(daysOf[i], [...(byDay.get(daysOf[i]) ?? []), x]));
    const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const se = clusteredSe([...byDay.values()]);
    return { n: xs.length, days: byDay.size, meanBps: r2(m), seBps: r2(se), t: se > 0 ? r2(m / se) : 0, hit: r2(xs.filter((x) => x > 0).length / Math.max(1, xs.length)) };
  };
  const dayOf = legs.map((l) => l.day);
  const fc = {
    sessions: allDays.length,
    candles: legs.length,
    to1115: stat(legs.map((l) => l.to1115), dayOf),
    to1505: stat(legs.map((l) => l.to1505), dayOf),
    fromOpenTo1505: stat(legs.map((l) => l.fromOpen1505), dayOf),
    nifty1505: stat(legs.filter((l) => l.index === "NIFTY").map((l) => l.to1505), legs.filter((l) => l.index === "NIFTY").map((l) => l.day)),
  };
  console.log(`\n=== First 15-minute candles > 0.24% (archive, ${allDays.length} sessions ${allDays[0]}..${allDays[allDays.length - 1]}) ===`);
  console.log(table([["date", "index", "body %", "09:30→11:15 bps", "09:30→15:05 bps", "09:15→15:05 bps (counts the candle)"], ...fcRows]));
  console.log(JSON.stringify(fc, null, 1));
  out.firstCandle = { rows: fcRows, stats: fc };

  // Index-level move of each protocol run's evaluation trades (entry to exit, signed by side).
  if (runsDir) {
    const rows: (string | number)[][] = [];
    const idx: Record<string, unknown> = {};
    for (const f of readdirSync(runsDir).filter((x) => /^protocol-.*\.json$/.test(x)).sort()) {
      const j = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { history: string; main: { runs: { delayed: { trades: TradeRecord[] } } } };
      const src = f.includes("-arch") ? A : H;
      const look = (index: IndexId) => closeLookup(src.candles[MARKET_SYMBOLS[index]], 5 * MINUTE_MS, LAG);
      const lk: Record<IndexId, (t: number) => number | null> = { NIFTY: look("NIFTY"), SENSEX: look("SENSEX") };
      const moves: number[] = [];
      const ds: string[] = [];
      for (const t of j.main.runs.delayed.trades) {
        const a = lk[t.index](t.entryMs);
        const b = lk[t.index](t.exitMs);
        if (!a || !b) continue;
        moves.push((t.side === "BULL" ? 1 : -1) * Math.log(b / a) * 1e4);
        ds.push(istDate(t.entryMs));
      }
      const s = stat(moves, ds);
      idx[f] = s;
      rows.push([f.replace(/^protocol-|\.json$/g, ""), s.n, s.meanBps, s.seBps, s.t, s.hit]);
    }
    // Hourly runs: the index level at each tick is the close of the hourly bar the tick acts on.
    const hourlyFiles = readdirSync(runsDir).filter((x) => /^hourly-H\d\.json$/.test(x)).sort();
    if (hourlyFiles.length && HOURLY) {
      const h = loadHourly();
      const level = (index: IndexId, t: number) => {
        const s = h.sessions[index].get(istDate(t));
        const k = Math.round((t - LAG - istAt(istDate(t), "10:15")) / HOUR);
        return s && k >= 0 && k <= 5 ? s.bars[k].c : null;
      };
      for (const f of hourlyFiles) {
        const j = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { trades: Record<string, { noDelay: TradeRecord[] }> };
        const moves: number[] = [];
        const ds: string[] = [];
        for (const t of j.trades.main?.noDelay ?? []) {
          const a = level(t.index as IndexId, t.entryMs);
          const b = level(t.index as IndexId, t.exitMs);
          if (!a || !b) continue;
          moves.push((t.side === "BULL" ? 1 : -1) * Math.log(b / a) * 1e4);
          ds.push(istDate(t.entryMs));
        }
        const s = stat(moves, ds);
        idx[f] = s;
        rows.push([f.replace(/\.json$/, ""), s.n, s.meanBps, s.seBps, s.t, s.hit]);
      }
    }
    console.log(`\n=== Index-level move of each run's main-account trades (entry→exit, signed by side; 5-minute: copy-delay run) ===`);
    console.log(table([["run", "trades", "mean bps", "SE (day)", "t", "right"], ...rows]));
    out.indexMoves = idx;
  }
  writeFileSync(join(OUT, "diag.json"), JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------------------------
// Summary tables from the saved protocol reports (5-minute CLI runs and hourly runs)
// ---------------------------------------------------------------------------------------------

interface SavedReport {
  verdict: string;
  evaluation: { trades: number; mean: number; se: number; net: number; profitFactor: number; hitRate: number };
  placebo: { delayed: { mean: number; n: number } };
  bootstrap: { perTrade: { lo: number; hi: number; p: number; se: number }; perSession: { lo: number; hi: number; p: number } };
  criteria: { id: number; verdict: string; summary: string }[];
  dsr: { dsr: number } | null;
}

function summary(): void {
  const dirs = (str(args, "runs", "") ?? "").split(",").filter(Boolean);
  if (dirs.length === 0) fail("--runs <dir[,dir]> is required for summary");
  const rows: (string | number)[][] = [];
  const add = (name: string, account: string, rep: SavedReport) => {
    const ev = rep.evaluation;
    const se = Math.max(ev.se, rep.bootstrap.perTrade.se);
    const gap = ev.mean - rep.placebo.delayed.mean;
    const c = (id: number) => rep.criteria.find((x) => x.id === id);
    const perts = /^(\d+)\/(\d+)/.exec(c(8)?.summary ?? "");
    rows.push([
      name,
      account,
      ev.trades,
      Math.round(ev.mean),
      Math.round(rep.placebo.delayed.mean),
      `${gap >= 0 ? "+" : ""}${Math.round(gap)}`,
      se > 0 ? (gap / se).toFixed(2) : "n/a",
      `${Math.round(rep.bootstrap.perTrade.lo)} … ${Math.round(rep.bootstrap.perTrade.hi)}`,
      Math.max(rep.bootstrap.perTrade.p, rep.bootstrap.perSession.p).toFixed(3),
      ev.profitFactor.toFixed(2),
      perts ? `${perts[1]}/${perts[2]}` : "–",
      rep.criteria.map((x) => `${x.id}${x.verdict[0]}`).join(" "),
      rep.verdict,
    ]);
  };
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => /^(protocol|hourly)-.*\.json$/.test(x)).sort()) {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const name = f.replace(/\.json$/, "").replace(/^protocol-/, "");
      if (f.startsWith("protocol-")) {
        add(name, "main", j.main as SavedReport);
        if (j.follower) add(name, "small10k", j.follower as SavedReport);
      } else {
        const reps = j.reports as Record<string, SavedReport>;
        for (const [account, rep] of Object.entries(reps)) add(name, account, rep);
      }
    }
  }
  console.log(table([["run", "account", "trades", "₹/trade", "placebo ₹/trade", "gap ₹", "gap/SE", "95% CI ₹/trade", "p", "PF", "perturb > 0", "criteria", "verdict"], ...rows]));
  console.log("\n| run | account | trades | ₹/trade | placebo ₹/trade | gap ₹ (in SE) | 95% CI ₹/trade | p | PF | ±20% > 0 | verdict |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} (${r[6]}) | ${r[7]} | ${r[8]} | ${r[9]} | ${r[10]} | ${r[12]} |`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`WP9b runner: ${[...ONLY].join(", ")}; trials ${TRIALS}; out ${OUT}`);
  if (ONLY.has("summary")) summary();
  if (ONLY.has("diag")) diag();
  if (ONLY.has("hourly") || ONLY.has("filters")) {
    const h = loadHourly();
    const daily = loadDaily();
    const calendar = hourlyCalendar(h);
    console.log(`Hourly data: ${h.dates.length} complete sessions ${h.dates[0]}..${h.dates[h.dates.length - 1]}, ${h.holidays.length} holidays inferred`);
    if (ONLY.has("filters")) await filters(h, calendar, daily);
    if (ONLY.has("hourly")) {
      const list = (str(args, "variants", Object.keys(VARIANTS).join(",")) ?? "").split(",").filter(Boolean);
      for (const name of list) await hourlyVariant(name, h, calendar, daily);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
