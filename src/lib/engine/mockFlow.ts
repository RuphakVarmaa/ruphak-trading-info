/**
 * The mock engine's option flow and recommendation. Everything here is synthetic and flagged source "mock":
 *
 * - an index path for the simulated session so far (a seeded random walk from the open, bridged to the
 *   mock's current spot), one point a minute;
 * - for each minute, the mock chain (mockChain.ts: Black-Scholes premiums, skew, spreads) at that minute's
 *   index level, with open interest and volume made to move: writers add calls as the index falls and puts
 *   as it rises (most near the money), volume follows the size of the move, and now and then one strike
 *   trades several times its usual volume;
 * - those minute snapshots go through the engine's real FlowMonitor (src/engine/flow/flowMonitor.ts), and
 *   the recommendation through the engine's real recommend() with the mock setups and the mock chain's
 *   quotes for the expiry a ₹10,000 buyer may use. The research statistics are the engine's own
 *   FLOW_STATS: the mock never invents a measured edge.
 */
import type { IndexId, OptionChainView, OptionFlowView, RecommendationView, TradeSetupView } from "@/engine/api-types";
import { defaultCalendar } from "@/engine/calendar/calendar";
import { DEFAULT_CONFIG } from "@/engine/config";
import { FLOW_STATS } from "@/engine/flow/flowStats";
import { FlowMonitor, type ChainSnapshot, type SideQuote } from "@/engine/flow/flowMonitor";
import { MIN_DAYS_LEFT, recommend, type RecoCandidate } from "@/engine/flow/recommend";
import { buildTodayPlan } from "@/engine/strategy/todayPlan";
import { MINUTE_MS, SESSION, istAt, istDate, istMidnight, istParts, sessionPhaseAt, type HolidayCheck } from "@/lib/ist";
import { CHAIN_SPEC, buildMockChain, weeklyExpiries } from "./mockChain";
import { gauss, hashString, mulberry32 } from "./random";

/** Strikes either side of ATM in the monitored chain (as the market feed subscribes). */
const FLOW_STRIKES = 15;
/** Per-minute index volatility used for the synthetic path, as a share of the level. */
const PATH_SIGMA = 0.00035;

export interface MockFlowInput {
  index: IndexId;
  nowMs: number;
  /** The mock's current spot and the session's open. */
  spot: number;
  open: number;
  prevSpot: number;
  isHoliday: HolidayCheck;
}

const cache = new Map<string, OptionFlowView>();

/** The synthetic index path, one level per minute from 09:15 to the minute of `nowMs`, ending at `spot`. */
export function mockPath(index: IndexId, date: string, open: number, spot: number, minutes: number): number[] {
  const w: number[] = [0];
  for (let m = 1; m <= minutes; m++) {
    const rand = mulberry32(hashString(`flowpath:${date}:${index}:${m}`));
    w.push(w[m - 1] + gauss(rand) * PATH_SIGMA * open);
  }
  const drift = w[minutes] - (spot - open);
  return w.map((x, m) => open + x - (minutes > 0 ? (m / minutes) * drift : drift));
}

function chainAt(input: MockFlowInput, t: number, level: number, expiries: string[]): OptionChainView {
  return buildMockChain({ index: input.index, spot: level, prevSpot: input.prevSpot, nowMs: t, expiries });
}

/** The synthetic minute snapshots of the session so far (see the header). */
export function mockFlowSnapshots(input: MockFlowInput): ChainSnapshot[] {
  const { index, nowMs } = input;
  const date = istDate(nowMs);
  const openMs = istAt(date, SESSION.open);
  const minutes = Math.min(SESSION.close - SESSION.open - 1, Math.floor((nowMs - openMs) / MINUTE_MS));
  if (minutes < 0) return [];
  const spec = CHAIN_SPEC[index];
  const expiries = weeklyExpiries(index, openMs, input.isHoliday);
  const path = mockPath(index, date, input.open, input.spot, minutes);
  const atmNow = Math.round(input.spot / spec.step) * spec.step;
  const strikes = Array.from({ length: 2 * FLOW_STRIKES + 1 }, (_, k) => atmNow + (k - FLOW_STRIKES) * spec.step);
  const first = chainAt(input, openMs, path[0], expiries);
  const byStrike = new Map(first.rows.map((r) => [r.strike, r]));
  // Opening OI (the previous session's) and the running totals per strike and side.
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  for (const s of strikes) {
    for (const side of ["ce", "pe"] as const) {
      const q = byStrike.get(s)?.[side];
      oi.set(`${s}${side}`, q?.prevOi ?? Math.round((spec.oiPeak * 0.05) / spec.lotSize) * spec.lotSize);
      vol.set(`${s}${side}`, 0);
    }
  }
  const out: ChainSnapshot[] = [];
  for (let m = 0; m <= minutes; m++) {
    const t = Math.min(nowMs, openMs + m * MINUTE_MS + 2_000);
    const level = path[m];
    const move = m > 0 ? (path[m] - path[m - 1]) / (PATH_SIGMA * input.open) : 0;
    const chain = chainAt(input, t, level, expiries);
    const rows = new Map(chain.rows.map((r) => [r.strike, r]));
    const rand = mulberry32(hashString(`flowmin:${date}:${index}:${m}`));
    const snapRows = strikes.map((strike) => {
      const r = rows.get(strike);
      const d = (strike - level) / spec.step;
      const near = Math.exp(-((d / 4) ** 2));
      const side = (k: "ce" | "pe"): SideQuote | null => {
        const q = r?.[k];
        if (!q) return null;
        const key = `${strike}${k}`;
        const writers = k === "ce" ? -move : move;
        const growth = 0.0006 * gauss(rand) + 0.004 * near * writers + 0.0005 * near;
        const nextOi = Math.max(spec.lotSize, Math.round((oi.get(key)! * (1 + growth)) / spec.lotSize) * spec.lotSize);
        oi.set(key, nextOi);
        const lots = Math.max(1, (q.oi ?? 0) / spec.lotSize);
        let perMin = (lots / 60) * (0.4 + near) * Math.exp(0.25 * gauss(rand)) * (1 + 0.3 * Math.abs(move));
        if (rand() < 0.002) perMin *= 6 + rand() * 4;
        vol.set(key, vol.get(key)! + Math.round(perMin) * spec.lotSize);
        return { ltp: q.ltp, volume: vol.get(key)!, oi: nextOi, bid: q.bid, ask: q.ask, iv: q.iv, delta: q.delta };
      };
      return { strike, ce: side("ce"), pe: side("pe") };
    });
    out.push({ t, index, expiry: chain.expiry, lotSize: spec.lotSize, spot: Math.round(level * 100) / 100, rows: snapRows });
  }
  return out;
}

/** The mock's option-flow view, computed once per simulated minute. */
export function mockOptionFlow(input: MockFlowInput): OptionFlowView {
  const key = `${input.index}:${Math.floor(input.nowMs / MINUTE_MS)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const monitor = new FlowMonitor({ stats: FLOW_STATS });
  const snaps = mockFlowSnapshots(input);
  for (const s of snaps) monitor.ingest(s);
  const expiry = snaps[snaps.length - 1]?.expiry ?? null;
  const today = istDate(input.nowMs);
  const dte = expiry ? Math.max(0, Math.round((istMidnight(expiry) - istMidnight(today)) / 86_400_000)) : null;
  const view = monitor.view(input.index, input.nowMs, {
    source: "mock",
    dte,
    note: snaps.length === 0 ? "Mock engine: the simulated session has not opened yet." : "Mock engine: synthetic minute snapshots of the mock chain; not market data.",
  });
  if (cache.size > 20) cache.clear();
  cache.set(key, view);
  return view;
}

/** Quotes for the recommendation from the mock chain on the first expiry with ≥ MIN_DAYS_LEFT calendar days. */
export function mockCandidates(index: IndexId, nowMs: number, spot: number, prevSpot: number, isHoliday: HolidayCheck): RecoCandidate[] {
  const today = istDate(nowMs);
  const expiries = weeklyExpiries(index, nowMs, isHoliday, 4);
  const expiry = expiries.find((e) => e > today && (istMidnight(e) - istMidnight(today)) / 86_400_000 >= MIN_DAYS_LEFT);
  if (!expiry) return [];
  const chain = buildMockChain({ index, spot, prevSpot, nowMs, expiries, expiry });
  const spec = CHAIN_SPEC[index];
  const atm = Math.round(spot / spec.step) * spec.step;
  const out: RecoCandidate[] = [];
  for (const r of chain.rows) {
    if (Math.abs(r.strike - atm) > 4 * spec.step) continue;
    for (const [type, q] of [
      ["CE", r.ce],
      ["PE", r.pe],
    ] as const) {
      if (!q || q.ask === null || q.delta === null) continue;
      out.push({
        contract: {
          index,
          expiry,
          strike: r.strike,
          optionType: type,
          tradingSymbol: `${index}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${r.strike}${type}`,
          lotSize: spec.lotSize,
          tickSize: 0.05,
          exchange: index === "NIFTY" ? "NSE" : "BSE",
        },
        bid: q.bid,
        ask: q.ask,
        ltp: q.ltp,
        premium: q.ask,
        delta: q.delta,
        gamma: q.gamma ?? 0,
        thetaPerMin: (q.theta ?? 0) / (SESSION.close - SESSION.open),
        iv: q.iv,
        priceSource: "mock",
      });
    }
  }
  return out;
}

export interface MockRecoInput extends MockFlowInput {
  setups: TradeSetupView[];
  capital?: number;
}

/** The engine's recommend() on the mock's setups, flow and chain. */
export function mockRecommendation(input: MockRecoInput): RecommendationView {
  const { index, nowMs } = input;
  const flow = mockOptionFlow(input);
  const cfg = { ...DEFAULT_CONFIG, gates: { ...DEFAULT_CONFIG.gates, expectedMoveModel: "calibrated" as const } };
  const plan = buildTodayPlan({ nowMs, calendar: defaultCalendar, cfg, snapshot: null }).indices.find((p) => p.index === index) ?? null;
  const today = istDate(nowMs);
  const nearest = weeklyExpiries(index, nowMs, input.isHoliday, 1)[0];
  return recommend({
    index,
    now: nowMs,
    capital: input.capital,
    spot: input.spot,
    setups: input.setups,
    flow,
    stats: FLOW_STATS,
    candidates: mockCandidates(index, nowMs, input.spot, input.prevSpot, input.isHoliday),
    phaseOpen: sessionPhaseAt(nowMs, input.isHoliday) === "OPEN" && istParts(nowMs).weekday <= 5,
    isExpiryDay: nearest === today,
    plan,
    exits: { stopPct: cfg.exits.stopPct, targetPct: cfg.exits.targetPct, squareOffIst: cfg.exits.squareOffIst },
  });
}
