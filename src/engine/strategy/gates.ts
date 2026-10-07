/**
 * Entry gates. Every result is stored with the decision so the dashboard can show exactly
 * why the engine did or did not trade.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { istAt, istDate, istMinutes, parseHHMM } from "../clock";
import type { EngineConfig } from "../config";
import { bsGreeks } from "../pricing/blackScholes";
import type { Conviction, EventPressure, GateResult, MarketFeatures, OptionContract, Quote } from "../types";
import { roundTripChargesPerUnit } from "../broker/charges";
import { sigmaPct } from "./signals";

export function sessionGates(f: MarketFeatures, t: number, calendar: TradingCalendar, cfg: EngineConfig): GateResult[] {
  const out: GateResult[] = [];
  const phase = calendar.sessionPhase(t);
  out.push({ gate: "market_open", label: "Market open", passed: phase === "OPEN", detail: phase === "OPEN" ? "session open" : `market ${phase.toLowerCase().replace("_", "-")}` });
  const m = istMinutes(t);
  const from = parseHHMM(cfg.gates.noEntryBeforeIst);
  const to = parseHHMM(cfg.gates.noEntryAfterIst);
  out.push({
    gate: "entry_window",
    label: `Entry window ${cfg.gates.noEntryBeforeIst}–${cfg.gates.noEntryAfterIst} IST`,
    passed: m >= from && m <= to,
    detail: m < from ? "too early" : m > to ? "too late for a new entry" : "inside window",
  });
  if (f.isExpiryDay) {
    out.push({
      gate: "expiry_day",
      label: "Expiry-day cutoff",
      passed: f.minutesToClose > cfg.gates.expiryDayNoEntryMinBeforeClose,
      detail: `${f.index} expiry today, ${f.minutesToClose} min to close`,
    });
  } else {
    out.push({ gate: "expiry_day", label: "Expiry-day cutoff", passed: null, detail: "not an expiry day" });
  }
  out.push({
    gate: "data_fresh",
    label: "Market data fresh",
    passed: f.dataAgeSec <= cfg.gates.maxDataAgeSec,
    detail: `${Math.round(f.dataAgeSec)} s old (max ${cfg.gates.maxDataAgeSec} s)`,
  });
  const next = f.nextScheduledEvent;
  const pre = next !== null && next.minutesAway <= cfg.gates.preEventBlackoutMin;
  const recent = f.recentScheduledEvent;
  const post = recent !== null && recent.minutesAgo < cfg.gates.postEventWaitMin;
  out.push({
    gate: "event_blackout",
    label: "Scheduled-event blackout",
    passed: !pre && !post,
    detail: pre ? `${next!.name} in ${next!.minutesAway} min` : post ? `${recent!.name} ${recent!.minutesAgo} min ago` : "no scheduled event nearby",
  });
  return out;
}

/** An event-driven entry must act on fresh news, not chase a story the market has digested. */
export function eventFreshnessGate(dominant: string, p: EventPressure | null, cfg: EngineConfig): GateResult {
  if (dominant !== "EVENT") return { gate: "event_fresh", label: "Event freshness", passed: null, detail: "not an event-driven entry" };
  const age = p?.topContributors[0]?.ageMin ?? null;
  const ok = age !== null && age <= cfg.gates.maxEventAgeMinForEventPlay;
  return { gate: "event_fresh", label: "Event freshness", passed: ok, detail: age === null ? "no live story" : `top story ${age} min old (max ${cfg.gates.maxEventAgeMinForEventPlay})` };
}

export function liquidityGates(q: Quote, contract: OptionContract, cfg: EngineConfig): GateResult[] {
  const mid = (q.bid + q.ask) / 2;
  const spreadPct = mid > 0 ? ((q.ask - q.bid) / mid) * 100 : Infinity;
  const out: GateResult[] = [
    { gate: "spread", label: `Bid-ask spread ≤ ${cfg.gates.maxSpreadPct}%`, passed: spreadPct <= cfg.gates.maxSpreadPct, detail: Number.isFinite(spreadPct) ? `${spreadPct.toFixed(2)}%` : "no quote" },
  ];
  if (q.oi === undefined) out.push({ gate: "open_interest", label: "Open interest", passed: null, detail: q.source === "synthetic" ? "synthetic quote (no OI)" : "OI not reported" });
  else out.push({ gate: "open_interest", label: `Open interest ≥ ${cfg.gates.minOi.toLocaleString("en-IN")}`, passed: q.oi >= cfg.gates.minOi, detail: q.oi.toLocaleString("en-IN") });
  out.push({ gate: "contract", label: "Contract tradable", passed: contract.lotSize > 0, detail: contract.tradingSymbol });
  return out;
}

export interface EdgeInput {
  spot: number;
  /** Premium we would pay (ask). */
  premium: number;
  bid: number;
  contract: OptionContract;
  tYears: number;
  /** Annualized implied vol as a decimal. */
  vol: number;
  score: number;
  horizonMin: number;
  t: number;
}

export interface EdgeResult {
  impliedMovePct: number;
  expectedMovePct: number;
  breakevenMovePct: number;
  edgeRatio: number;
  delta: number;
  thetaPerDay: number;
  thetaOverHorizon: number;
  costsPerUnit: number;
}

/**
 * The theta gate. Expected underlying move over the holding horizon = |conviction| × kEM × the
 * 1-sigma implied move. Edge per unit = |Δ| × expected move in points − theta over the horizon −
 * round-trip costs (charges plus the half-spread paid on each side). edgeRatio = edge / premium.
 */
export function evaluateEdge(i: EdgeInput, cfg: EngineConfig): EdgeResult {
  const g = bsGreeks({ spot: i.spot, strike: i.contract.strike, tYears: i.tYears, vol: i.vol, r: cfg.pricing.r, type: i.contract.type });
  const impliedMovePct = sigmaPct(i.vol * 100, i.horizonMin, cfg) * cfg.gates.intradayVolFactor;
  const expectedMovePct = Math.abs(i.score) * cfg.gates.kEM * impliedMovePct;
  const emPoints = (expectedMovePct / 100) * i.spot;
  const thetaOverHorizon = Math.abs(g.thetaPerDay) * (i.horizonMin / cfg.pricing.tradingMinutesPerDay);
  const charges = roundTripChargesPerUnit(i.premium, i.contract.lotSize, i.contract.exchange, istDate(i.t));
  const spreadCost = Math.max(0, i.premium - i.bid); // pay the ask, later sell at the bid
  const costsPerUnit = charges + spreadCost;
  const delta = Math.abs(g.delta);
  const edge = delta * emPoints - thetaOverHorizon - costsPerUnit;
  const breakevenPoints = delta > 1e-6 ? (thetaOverHorizon + costsPerUnit) / delta : Infinity;
  return {
    impliedMovePct,
    expectedMovePct,
    breakevenMovePct: (breakevenPoints / i.spot) * 100,
    edgeRatio: i.premium > 0 ? edge / i.premium : -Infinity,
    delta,
    thetaPerDay: g.thetaPerDay,
    thetaOverHorizon,
    costsPerUnit,
  };
}

export function edgeGates(e: EdgeResult, cfg: EngineConfig): GateResult[] {
  return [
    {
      gate: "edge_ratio",
      label: `Edge after theta and costs ≥ ${(cfg.gates.minEdgeRatio * 100).toFixed(0)}% of premium`,
      passed: e.edgeRatio >= cfg.gates.minEdgeRatio,
      detail: `${(e.edgeRatio * 100).toFixed(1)}% (θ ${e.thetaOverHorizon.toFixed(2)}, costs ${e.costsPerUnit.toFixed(2)} per unit)`,
    },
    {
      gate: "expected_vs_implied",
      label: "Expected move vs implied move",
      passed: e.expectedMovePct >= cfg.gates.minExpectedVsImplied * e.impliedMovePct,
      detail: `expected ${e.expectedMovePct.toFixed(2)}% vs implied ${e.impliedMovePct.toFixed(2)}%`,
    },
  ];
}

export function convictionGate(c: Conviction): GateResult {
  return {
    gate: "conviction",
    label: `Conviction beyond ±${c.threshold.toFixed(2)} (${c.regime})`,
    passed: c.passes,
    detail: `score ${c.score >= 0 ? "+" : ""}${c.score.toFixed(2)}`,
  };
}

/** Square-off instant (IST) for the trading day of `t`. */
export function squareOffMs(t: number, cfg: EngineConfig): number {
  return istAt(istDate(t), cfg.exits.squareOffIst);
}
