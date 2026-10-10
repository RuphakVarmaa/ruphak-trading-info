/**
 * Entry planning for one index on one tick. Always returns a PlanDecision (the dashboard shows
 * the suggested contract, edge and every gate even when no trade is taken); `plan` is set only
 * when the conviction and every applicable gate pass and sizing yields at least one lot.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { MINUTE_MS, istDate } from "../clock";
import type { EngineConfig } from "../config";
import { yearsToExpiry } from "../pricing/timeToExpiry";
import { syntheticVol } from "../pricing/syntheticOptionPricer";
import { roundTripChargesPerUnit } from "../broker/charges";
import { marketableLimit, quoteProblem } from "../broker/fillModel";
import type { IdGenerator, InstrumentProvider, MarketDataSource, OptionQuoteSource } from "../ports";
import type {
  Conviction,
  EventPressure,
  GateResult,
  IndexId,
  MarketFeatures,
  OptionContract,
  PlanDecision,
  Position,
  Quote,
  RiskState,
  SignalPerformance,
  TradePlan,
} from "../types";
import { dailyLoss, riskGates } from "../risk/limits";
import { attributionShares, dominantSource, findPerf } from "./conviction";
import { convictionGate, edgeGates, evaluateEdge, eventFreshnessGate, liquidityGates, sessionGates, volCheapnessGate, type EdgeResult } from "./gates";
import { indicatorView } from "../market/features";
import { sessionVolForecast } from "../market/volForecast";
import { chooseContract, choosePremiumBandContract } from "./optionSelect";
import { n2DailyFor, n2Enabled, n2Gate, n3Enabled, n3Gate, positionExitByMs } from "./rules";
import { sizePosition } from "./sizing";

export interface PlanContext {
  cfg: EngineConfig;
  calendar: TradingCalendar;
  instruments: InstrumentProvider;
  optionQuotes: OptionQuoteSource;
  newId: IdGenerator;
  /**
   * Follower accounts: when an account check fails (kill switch, loss caps, loss streak, entries or
   * positions used up, cooldown), return before the strike search, so no option quotes are fetched.
   */
  accountChecksFirst?: boolean;
  /** Point-in-time market data (the engine passes its deps); read only by gates.volCheapness, once per index and day. */
  market?: MarketDataSource;
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
    indicators: indicatorView(f),
  };
  const gates: GateResult[] = [convictionGate(c), ...sessionGates(f, t, ctx.calendar, cfg)];
  // WP9b (off by default): plan §4 N3 (morning only) and N2 (no entry after a volatility jump or a big run).
  if (n3Enabled(cfg)) gates.push(n3Gate(t, cfg));
  if (n2Enabled(cfg)) {
    let prev: string | null = null;
    try {
      prev = ctx.calendar.prevTradingDay(istDate(t));
    } catch {
      prev = null;
    }
    gates.push(n2Gate(await n2DailyFor(ctx.market, index, t, prev, cfg), f, cfg));
  }
  const side = c.score >= 0 ? "BULL" : "BEAR";
  const dom = dominantSource(c);
  gates.push(eventFreshnessGate(dom, a.pressure, cfg));
  const accountChecks = riskGates(index, side, a.risk, cfg);
  gates.push(...accountChecks);

  const marketOpen = ctx.calendar.sessionPhase(t) === "OPEN";
  if (!marketOpen) {
    decision.gates = gates;
    decision.noPlanReason = "market closed";
    return decision;
  }
  if (ctx.accountChecksFirst && accountChecks.some((g) => g.passed === false)) {
    decision.gates = gates;
    const failed = gates.find((g) => g.passed === false)!;
    decision.noPlanReason = failed.gate === "conviction" ? "conviction below threshold" : `${failed.label}: ${failed.detail}`;
    return decision;
  }

  const quoteOpts = (c: OptionContract) => ({
    tickSize: c.tickSize,
    slippageTicksMarket: cfg.broker.slippageTicksMarket,
    depthLevels: cfg.broker.partialFillDepthLevels,
    maxQuoteAgeMs: cfg.gates.maxDataAgeSec * 1000,
  });
  const perf = findPerf(a.perf, dom, index);
  const chargeReservePerLot = (premium: number, oc: OptionContract) =>
    a.risk.cashRupees === undefined ? 0 : roundTripChargesPerUnit(premium, oc.lotSize, oc.exchange, istDate(t)) * oc.lotSize;
  const sizeFor = (premium: number, oc: OptionContract) =>
    sizePosition(
      {
        premium,
        contract: oc,
        perf,
        sizeMult: c.sizeMult,
        capitalRupees: a.risk.capitalRupees,
        openPremiumRupees: openPremium(a.risk.openPositions),
        settings: a.risk.settings,
        cashRupees: a.risk.cashRupees,
        chargeReservePerLot: chargeReservePerLot(premium, oc),
      },
      cfg,
    );

  // Suggested contract and its economics, computed even when a gate fails (for display).
  let contract: OptionContract | null;
  let bandQuote: Quote | null = null;
  if (cfg.selection.mode === "PREMIUM_BAND") {
    const pick = await choosePremiumBandContract({
      index,
      spot: f.spot,
      vix: f.vix,
      side,
      t,
      instruments: ctx.instruments,
      optionQuotes: ctx.optionQuotes,
      calendar: ctx.calendar,
      cfg,
      quoteOk: (q, c) => quoteProblem(q, t, quoteOpts(c)) === null,
      affordable: (premium, c) => sizeFor(premium, c).lots >= 1,
    });
    contract = pick.contract;
    bandQuote = pick.quote;
    gates.push(pick.gate);
  } else {
    contract = await chooseContract(index, f.spot, side, t, ctx.instruments, ctx.calendar, cfg);
  }
  decision.contract = contract;
  if (!contract) {
    gates.push({ gate: "contract", label: "Contract available", passed: false, detail: cfg.selection.mode === "PREMIUM_BAND" ? "no strike near the money" : "no listed contract for the ATM strike" });
    decision.gates = gates;
    decision.noPlanReason = "no contract";
    return decision;
  }
  let edge: EdgeResult | null = null;
  let premium: number | null = null;
  let limitPrice: number | null = null;
  let quoteSource: Quote["source"] | undefined;
  try {
    const q = bandQuote ?? (await ctx.optionQuotes.quote(contract, { t, spot: f.spot, vix: f.vix }));
    const problem = quoteProblem(q, t, quoteOpts(contract));
    gates.push({ gate: "quote", label: "Usable option quote", passed: problem === null, detail: problem ?? `${q.source} bid ${q.bid} / ask ${q.ask}` });
    if (problem === null) {
      premium = q.ask;
      quoteSource = q.source;
      limitPrice = marketableLimit("BUY", q, contract.tickSize);
      gates.push(...liquidityGates(q, contract, cfg));
      const horizonMin = Math.max(5, Math.min(cfg.exits.horizonMinByRegime[c.regime], Math.floor((positionExitByMs(t, cfg) - t) / MINUTE_MS)));
      const vol = q.iv && q.iv > 0 ? q.iv / 100 : syntheticVol(index, f.vix, cfg);
      edge = evaluateEdge({ spot: f.spot, premium: q.ask, bid: q.bid, contract, tYears: yearsToExpiry(t, contract.expiry, ctx.calendar, cfg), vol, score: c.score, horizonMin, t }, cfg);
      gates.push(...edgeGates(edge, cfg));
      // WP5 (off by default): buy only when the HAR-RV forecast says the option is not rich.
      if (cfg.gates.volCheapness.enabled) gates.push(volCheapnessGate(await sessionVolForecast(ctx.market, index, t, ctx.calendar), vol, cfg));
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

  const size = sizeFor(premium, contract);
  gates.push({
    gate: "size",
    label: "At least one lot within risk limits",
    passed: size.lots >= 1,
    detail: size.lots >= 1 ? `${size.lots} lot(s), ₹${Math.round(size.riskRupees).toLocaleString("en-IN")} at risk (${size.limitedBy})` : `0 lots (${size.limitedBy})`,
  });
  if (cfg.risk.prospectiveLossCap && size.lots >= 1) {
    // Small accounts: a stop-out on this trade must not push today's loss past the daily cap.
    const cap = Math.min(a.risk.settings.dailyLossCapInr, (a.risk.capitalRupees * cfg.risk.dailyLossCapPct) / 100);
    const lost = dailyLoss(a.risk);
    const atRisk = size.riskRupees + chargeReservePerLot(premium, contract) * size.lots;
    gates.push({
      gate: "loss_room",
      label: "Room under the daily loss cap",
      passed: lost + atRisk <= cap,
      detail: `₹${Math.round(lost)} lost today + ₹${Math.round(atRisk)} at risk vs cap ₹${Math.round(cap)}`,
    });
  }
  decision.gates = gates;

  if (!allPass(gates)) {
    const failed = gates.find((g) => g.passed === false)!;
    decision.noPlanReason = failed.gate === "conviction" ? "conviction below threshold" : `${failed.label}: ${failed.detail}`;
    return decision;
  }

  // The square-off, or N3's morning exit when it is on (WP9b; positionExitByMs is squareOffMs otherwise).
  const exitByMs = positionExitByMs(t, cfg);
  const horizonMin = Math.max(5, Math.min(cfg.exits.horizonMinByRegime[c.regime], Math.floor((exitByMs - t) / MINUTE_MS)));
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
      squareOffMs: exitByMs,
    },
    riskRupees: size.riskRupees,
    riskPct: size.riskPct,
    kellyFraction: size.kellyFraction,
    conviction: c,
    gates,
    dominantSource: dom,
    indicators: decision.indicators,
    vix: f.vix,
    retFromOpenPct: f.retFromOpen,
    ...(quoteSource ? { quoteSource } : {}),
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
