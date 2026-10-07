/**
 * Entry planning for one index on one tick. Always returns a PlanDecision (the dashboard shows
 * the suggested contract, edge and every gate even when no trade is taken); `plan` is set only
 * when the conviction and every applicable gate pass and sizing yields at least one lot.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS } from "../clock";
import type { EngineConfig } from "../config";
import { yearsToExpiry } from "../pricing/timeToExpiry";
import { syntheticVol } from "../pricing/syntheticOptionPricer";
import { marketableLimit, quoteProblem } from "../broker/fillModel";
import type { IdGenerator, InstrumentProvider, OptionQuoteSource } from "../ports";
import type {
  Conviction,
  EventPressure,
  GateResult,
  IndexId,
  MarketFeatures,
  PlanDecision,
  Position,
  RiskState,
  SignalPerformance,
  TradePlan,
} from "../types";
import { riskGates } from "../risk/limits";
import { attributionShares, dominantSource, findPerf } from "./conviction";
import { convictionGate, edgeGates, evaluateEdge, eventFreshnessGate, liquidityGates, sessionGates, squareOffMs, type EdgeResult } from "./gates";
import { chooseContract } from "./optionSelect";
import { sizePosition } from "./sizing";

export interface PlanContext {
  cfg: EngineConfig;
  calendar: TradingCalendar;
  instruments: InstrumentProvider;
  optionQuotes: OptionQuoteSource;
  newId: IdGenerator;
}

export interface PlanArgs {
  index: IndexId;
  t: number;
  features: MarketFeatures;
  pressure: EventPressure | null;
  conviction: Conviction;
  risk: RiskState;
  perf: SignalPerformance[];
}

const allPass = (gates: GateResult[]) => gates.every((g) => g.passed !== false);

function openPremium(positions: Position[]): number {
  return positions.reduce((s, p) => s + p.avgEntry * p.qty, 0);
}

export async function planEntry(a: PlanArgs, ctx: PlanContext): Promise<PlanDecision> {
  const { cfg } = ctx;
  const { index, t, features: f, conviction: c } = a;
  const decision: PlanDecision = {
    id: ctx.newId(),
    index,
    t,
    conviction: c,
    gates: [],
    plan: null,
    contract: null,
    refPremium: null,
    expectedMovePct: null,
    impliedMovePct: null,
    edgeRatio: null,
    noPlanReason: null,
  };
  const gates: GateResult[] = [convictionGate(c), ...sessionGates(f, t, ctx.calendar, cfg)];
  const side = c.score >= 0 ? "BULL" : "BEAR";
  const dom = dominantSource(c);
  gates.push(eventFreshnessGate(dom, a.pressure, cfg));
  gates.push(...riskGates(index, side, a.risk, cfg));

  const marketOpen = ctx.calendar.sessionPhase(t) === "OPEN";
  if (!marketOpen) {
    decision.gates = gates;
    decision.noPlanReason = "market closed";
    return decision;
  }

  // Suggested contract and its economics, computed even when a gate fails (for display).
  const contract = await chooseContract(index, f.spot, side, t, ctx.instruments, ctx.calendar, cfg);
  decision.contract = contract;
  if (!contract) {
    gates.push({ gate: "contract", label: "Contract available", passed: false, detail: "no listed contract for the ATM strike" });
    decision.gates = gates;
    decision.noPlanReason = "no contract";
    return decision;
  }
  let edge: EdgeResult | null = null;
  let premium: number | null = null;
  let limitPrice: number | null = null;
  try {
    const q = await ctx.optionQuotes.quote(contract, { t, spot: f.spot, vix: f.vix });
    const problem = quoteProblem(q, t, {
      tickSize: contract.tickSize,
      slippageTicksMarket: cfg.broker.slippageTicksMarket,
      depthLevels: cfg.broker.partialFillDepthLevels,
      maxQuoteAgeMs: cfg.gates.maxDataAgeSec * 1000,
    });
    gates.push({ gate: "quote", label: "Usable option quote", passed: problem === null, detail: problem ?? `${q.source} bid ${q.bid} / ask ${q.ask}` });
    if (problem === null) {
      premium = q.ask;
      limitPrice = marketableLimit("BUY", q, contract.tickSize);
      gates.push(...liquidityGates(q, contract, cfg));
      const horizonMin = Math.max(5, Math.min(cfg.exits.horizonMinByRegime[c.regime], Math.floor((squareOffMs(t, cfg) - t) / MINUTE_MS)));
      const vol = q.iv && q.iv > 0 ? q.iv / 100 : syntheticVol(index, f.vix, cfg);
      edge = evaluateEdge({ spot: f.spot, premium: q.ask, bid: q.bid, contract, tYears: yearsToExpiry(t, contract.expiry, ctx.calendar, cfg), vol, score: c.score, horizonMin, t }, cfg);
      gates.push(...edgeGates(edge, cfg));
      decision.refPremium = q.ask;
      decision.expectedMovePct = edge.expectedMovePct;
      decision.impliedMovePct = edge.impliedMovePct;
      decision.edgeRatio = edge.edgeRatio;
    }
  } catch (err) {
    gates.push({ gate: "quote", label: "Usable option quote", passed: false, detail: `quote failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (premium === null || edge === null) {
    decision.gates = gates;
    decision.noPlanReason = "no usable quote";
    return decision;
  }

  const size = sizePosition(
    {
      premium,
      contract,
      perf: findPerf(a.perf, dom, index),
      sizeMult: c.sizeMult,
      capitalRupees: a.risk.capitalRupees,
      openPremiumRupees: openPremium(a.risk.openPositions),
      settings: a.risk.settings,
    },
    cfg,
  );
  gates.push({
    gate: "size",
    label: "At least one lot within risk limits",
    passed: size.lots >= 1,
    detail: size.lots >= 1 ? `${size.lots} lot(s), ₹${Math.round(size.riskRupees).toLocaleString("en-IN")} at risk (${size.limitedBy})` : `0 lots (${size.limitedBy})`,
  });
  decision.gates = gates;

  if (!allPass(gates)) {
    const failed = gates.find((g) => g.passed === false)!;
    decision.noPlanReason = failed.gate === "conviction" ? "conviction below threshold" : `${failed.label}: ${failed.detail}`;
    return decision;
  }

  const horizonMin = Math.max(5, Math.min(cfg.exits.horizonMinByRegime[c.regime], Math.floor((squareOffMs(t, cfg) - t) / MINUTE_MS)));
  const plan: TradePlan = {
    id: ctx.newId(),
    index,
    t,
    side,
    contract,
    lots: size.lots,
    qty: size.qty,
    entryType: "LIMIT",
    limitPrice: limitPrice ?? undefined,
    refPremium: premium,
    refSpot: f.spot,
    horizonMin,
    expectedMovePct: edge.expectedMovePct,
    impliedMovePct: edge.impliedMovePct,
    breakevenMovePct: edge.breakevenMovePct,
    edgeRatio: edge.edgeRatio,
    stops: {
      stopPct: cfg.exits.stopPct,
      targetPct: cfg.exits.targetPct,
      trailActivatePct: cfg.exits.trailActivatePct,
      trailGivebackPct: cfg.exits.trailGivebackPct,
      timeStopMs: t + horizonMin * MINUTE_MS,
      squareOffMs: squareOffMs(t, cfg),
    },
    riskRupees: size.riskRupees,
    riskPct: size.riskPct,
    kellyFraction: size.kellyFraction,
    conviction: c,
    gates,
    dominantSource: dom,
  };
  decision.plan = plan;
  return decision;
}

/** Attribution shares and event keys captured at entry, stored on the position. */
export function entryAttribution(plan: TradePlan, pressure: EventPressure | null) {
  return {
    attribution: attributionShares(plan.conviction),
    eventKeysAtEntry: plan.dominantSource === "EVENT" ? (pressure?.topContributors ?? []).slice(0, 3).map((x) => x.clusterKey) : [],
  };
}
