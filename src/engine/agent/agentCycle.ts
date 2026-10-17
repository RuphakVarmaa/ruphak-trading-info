/**
 * The TE-side agent cycle: build the bar's reflex input, execute a batch of decisions through the code gate, the
 * planner and the risk layer, and run the agent's code exits. Pure over EngineDeps (also used by the replay tests).
 *
 * The model only judges. Every threshold, size, order and exit here is code: the code gate (policy.ts), quarter
 * Kelly on measured results only (kelly.ts), every engine gate except the measured-edge checks (relaxed exactly as
 * for the paper practice quota, whose verdict is still recorded), and a kill-switch re-read right before each order.
 */
import type { OptionFlowView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { istDate, istMidnight } from "../clock";
import type { EngineConfig } from "../config";
import { BAR_5M_MS } from "../market/candles";
import { computeFeatures } from "../market/features";
import { submitEntry, submitExit } from "../pipeline/execution";
import { runPositionCycle, type PositionReport } from "../pipeline/positionCycle";
import { practiceConfig } from "../pipeline/practiceCycle";
import { isPendingEntry, loadRiskState, pendingEntry } from "../pipeline/riskState";
import type { EngineDeps } from "../ports";
import { syntheticVol } from "../pricing/syntheticOptionPricer";
import { yearsToExpiry } from "../pricing/timeToExpiry";
import { evaluateEdge } from "../strategy/gates";
import { planEntry, type PlanContext } from "../strategy/planner";
import {
  MARKET_SYMBOLS,
  type Conviction,
  type EngineSettings,
  type EventPressure,
  type IndexId,
  type MarketFeatures,
  type MarketSnapshot,
  type OptionContract,
  type Position,
  type Quote,
  type RiskState,
  type ScoredEvent,
  type SignalPerformance,
  type TradePlan,
} from "../types";
import { causalEvents, causalMarketSnapshot } from "./causal";
import { AGENT_LIMITS, AGENT_POLICY } from "./constants";
import { agentRiskPct } from "./kelly";
import { agentExitTriggers, codeGate, gateSummary, quoteGateLines, quoteToxicity } from "./policy";
import { riskSnapshotFrom } from "./risk";
import { buildIndexSnapshot, encodeSnapshot, estimateTokens } from "./snapshot";
import type {
  AgentAction,
  AgentBookState,
  AgentPositionTag,
  AgentRiskSnapshot,
  AgentTradeRecord,
  DecisionExecution,
  DecisionRecord,
  EdgeVerdict,
  ExecutionRecord,
  Finalist,
  GateLine,
  GateVerdict,
  IndexSnapshot,
  ReflexBatch,
  ReflexInput,
  SizingTrace,
} from "./types";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// The bar's input (causal: nothing after the bar close can reach it)
// ---------------------------------------------------------------------------

export interface BuildInputArgs {
  barCloseMs: number;
  indices: readonly IndexId[];
  complete: readonly IndexId[];
  /** report.snapshot: may hold data after the bar close; truncated inside. */
  market: MarketSnapshot;
  calendar: TradingCalendar;
  cfg: EngineConfig;
  events: ScoredEvent[];
  perf: SignalPerformance[];
  /** The option flow as of the bar close (MarketFeedDO.getOptionFlowAsOf); a sample after the close is ignored. */
  flows: Partial<Record<IndexId, OptionFlowView | null>>;
  /** The agent's own book at or before the bar close (bookAsOf); a later book is refused. */
  book: AgentBookState;
  nowMs: number;
}

/**
 * One closed bar for the AgentDO: a snapshot per complete index and each index's bar close (for grading, also when
 * its snapshot is missing). Built only from data timestamped at or before the close, so the result (apart from
 * builtMs) is the same with or without later data present (snapshot.leak.test.ts, agentCycle.test.ts).
 */
export function buildReflexInput(a: BuildInputArgs): ReflexInput {
  const T = a.barCloseMs;
  // The book must be as of the close too: a later one could carry an exit made after it.
  if (a.book.t > T) throw new Error(`the agent's book is from after the bar close (${a.book.t} > ${T}); use bookAsOf`);
  const market = causalMarketSnapshot(a.market, T);
  const events = causalEvents(a.events, T);
  const snapshots: ReflexInput["snapshots"] = {};
  const tokensEst: ReflexInput["tokensEst"] = {};
  const closes: ReflexInput["closes"] = {};
  const problems: string[] = [];
  for (const index of a.indices) {
    const bars = market.candles[MARKET_SYMBOLS[index]] ?? [];
    const last = bars[bars.length - 1];
    if (last && last.t === T - BAR_5M_MS) closes[index] = last.c;
    if (!a.complete.includes(index)) {
      problems.push(`${index}: the candle was not complete in time, so it has no snapshot`);
      continue;
    }
    try {
      const s = buildIndexSnapshot({ index, barCloseMs: T, market, calendar: a.calendar, cfg: a.cfg, events, perf: a.perf, flow: a.flows[index] ?? null, book: a.book });
      snapshots[index] = s;
      tokensEst[index] = estimateTokens(encodeSnapshot(s));
    } catch (err) {
      problems.push(`${index}: no snapshot (${errText(err)})`);
    }
  }
  return { barCloseMs: T, date: istDate(T), builtMs: a.nowMs, snapshots, tokensEst, closes, problems };
}

/** The newest recorded book with t ≤ barCloseMs, else the fallback. */
export function bookAsOf(ring: readonly AgentBookState[], barCloseMs: number, fallback: AgentBookState): AgentBookState {
  let best: AgentBookState | null = null;
  for (const b of ring) if (b.t <= barCloseMs && (!best || b.t >= best.t)) best = b;
  return best ?? fallback;
}

/**
 * The fallback book (AMENDMENTS #26): from the latest stored risk at or before the bar close (no position detail; a
 * risk from an earlier day has no loss used today), else flat at `capital` with t = the day start.
 * `t` is either the bar close, and then a risk recorded after it is never used, or that day's start (no bar closes
 * at midnight), when the caller has already picked a risk at or before the bar; then only a later day's risk is
 * refused. buildReflexInput refuses a book from after the close in any case.
 */
export function initialBook(risk: AgentRiskSnapshot | null, capital: number, t: number): AgentBookState {
  const date = istDate(t);
  const dayStart = istMidnight(date);
  if (risk && (t === dayStart ? risk.date <= date : risk.t <= t)) {
    return { t: risk.t, equity: risk.equity, peakEquity: risk.peakEquity, ddPct: risk.ddPct, dayLossPct: risk.date === date ? risk.dayLossPct : 0, positions: [] };
  }
  return { t: dayStart, equity: capital, peakEquity: capital, ddPct: 0, dayLossPct: 0, positions: [] };
}

/** The book TE records each step: the risk snapshot plus the open positions marked at their last premium. */
export function bookFrom(risk: AgentRiskSnapshot, positions: readonly Position[], lotSizeOf: (p: Position) => number): AgentBookState {
  return {
    t: risk.t,
    equity: risk.equity,
    peakEquity: risk.peakEquity,
    ddPct: risk.ddPct,
    dayLossPct: risk.dayLossPct,
    positions: positions
      .filter((p) => p.status === "OPEN" && p.qty > 0)
      .map((p) => ({ index: p.index, side: p.side, lots: Math.round(p.qty / Math.max(1, lotSizeOf(p))), avgEntry: p.avgEntry, markPremium: p.markPremium, markMs: p.markMs })),
  };
}

/** A conviction with no view (score 0, not passing) and the config's threshold, for an index without one this tick. */
export function neutralConviction(index: IndexId, t: number, cfg: EngineConfig): Conviction {
  return { index, t, score: 0, components: [], regime: "RANGE", threshold: cfg.conviction.thresholds.RANGE, passes: false, sizeMult: 1, stance: "NEUTRAL", note: "no conviction this tick" };
}

// ---------------------------------------------------------------------------
// Planning helpers
// ---------------------------------------------------------------------------

/**
 * The planner's config for an agent entry: the measured-edge checks relaxed exactly as for the paper practice
 * quota (practiceConfig), the size from quarter Kelly, and nothing else changed. Unlike practice, the losing-streak
 * limit is not raised.
 */
export function agentPlannerConfig(cfg: EngineConfig, riskPct: number): EngineConfig {
  return {
    ...cfg,
    gates: practiceConfig(cfg).gates,
    // perf is empty and kellyMinTrades out of reach, so only riskPct sizes the trade; no minimum risk floor.
    sizing: { ...cfg.sizing, defaultRiskPct: riskPct, minRiskPct: 0, kellyMinTrades: Number.MAX_SAFE_INTEGER },
  };
}

/**
 * The engine's conviction turned to the agent's side, as the practice quota does: the planner buys the side of the
 * score, so the score takes the decision's sign and at least the threshold. It is never stored as a signal (the
 * plan carries an "agent" gate and VOL_REGIME, and the plan decision is not appended to decisions).
 */
export function agentConviction(base: Conviction, direction: "LONG" | "SHORT"): Conviction {
  const sign = direction === "LONG" ? 1 : -1;
  return { ...base, score: sign * Math.max(Math.abs(base.score), base.threshold), passes: true, stance: sign > 0 ? "BULLISH" : "BEARISH", sizeMult: 1 };
}

const pct2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "∞");

/**
 * The measured-edge verdict, recorded and never gating (AMENDMENTS #19b). Score-free: the move this option needs
 * over the holding time to cover time decay, the spread and charges (its break-even move) against the move the
 * index usually makes in that time (the measured one-sigma move). The engine's own conviction never enters it.
 */
export function edgeVerdict(a: { cfg: EngineConfig; spot: number; quote: Quote; contract: OptionContract; calendar: TradingCalendar; vix: number; horizonMin: number; t: number }): EdgeVerdict {
  const cfg: EngineConfig = { ...a.cfg, gates: { ...a.cfg.gates, expectedMoveModel: "calibrated" } };
  const vol = a.quote.iv && a.quote.iv > 0 ? a.quote.iv / 100 : syntheticVol(a.contract.index, a.vix, cfg);
  const e = evaluateEdge(
    { spot: a.spot, premium: a.quote.ask, bid: a.quote.bid, contract: a.contract, tYears: yearsToExpiry(a.t, a.contract.expiry, a.calendar, cfg), vol, score: 0, horizonMin: a.horizonMin, t: a.t },
    cfg,
  );
  const need = e.breakevenMovePct;
  const usual = e.calibrated?.realizedMovePct ?? Number.NaN;
  const passed = Number.isFinite(need) && Number.isFinite(usual) && usual >= need;
  return {
    passed,
    rows: [
      {
        gate: "move_vs_breakeven",
        label: "Move this option needs vs the move the index usually makes",
        passed,
        detail:
          `it needs a ${pct2(need)}% move in ${a.horizonMin} min to cover time decay, the spread and charges; the index usually moves about ${pct2(usual)}% in that time, ` +
          `so the measured-edge check would ${passed ? "pass" : "block"} it`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Executing a batch
// ---------------------------------------------------------------------------

export interface ExecuteContext {
  mode: "shadow" | "paper";
  nowMs: number;
  calendar: TradingCalendar;
  features: Partial<Record<IndexId, MarketFeatures>>;
  pressure: Partial<Record<IndexId, EventPressure>>;
  convictions: Partial<Record<IndexId, Conviction>>;
  snapshots: Partial<Record<IndexId, IndexSnapshot>>;
  noEntries: string | null;
  mainSettings: () => Promise<EngineSettings>;
  peakEquity: number | null;
  ddHalt: boolean;
  /**
   * positionId → finalist. Entries are added here (also an entry still resting, by its position id); the runner
   * removes closed positions after tagging their trades.
   */
  positions: Record<string, AgentPositionTag>;
  /** Today's agent trades the runner already holds; not read here. */
  trades: readonly AgentTradeRecord[];
  acceptSyntheticQuotes?: boolean;
  /** Milliseconds left in the runner's time budget; once ≤ 0 the remaining entries are not executed. Exits always run. */
  timeLeftMs?: () => number;
  /** The operator's pause, read with the kill switches right before each order: true stops the batch's remaining entries (its exits already ran). */
  paused?: () => boolean;
}

const KIND_ORDER: Record<Finalist["kind"], number> = { IDEA: 0, GENERIC: 1 };
const MODE_EXIT: Record<ExecuteContext["mode"], AgentAction> = { paper: "EXITED", shadow: "SHADOW_EXIT" };
const rupees = (x: number) => `₹${Math.round(x).toLocaleString("en-IN")}`;
const sameContract = (a: OptionContract, b: NonNullable<Finalist["contract"]>) => a.expiry === b.expiry && a.strike === b.strike && a.type === b.type;

interface Attempt {
  gate: GateVerdict;
  lines: GateLine[];
  action: AgentAction;
  detail: string;
  planId: string | null;
  positionId: string | null;
  tradingSymbol: string | null;
  edge: EdgeVerdict | null;
  sizing: SizingTrace | null;
}

/**
 * Executes one fresh batch (SPEC §5.2.1 as amended): decision exits first (a position with a resting exit order, or
 * no longer open in a fresh read, is left alone: EXIT_PENDING), then entries, best decisions first, each through
 * the code gate, quarter Kelly, the planner with every engine gate except the measured-edge checks, the post-plan
 * checks and a kill-switch re-read right before the order. Shadow mode places no orders and opens no positions or
 * trades; it records what paper mode would have done. One record per decision (effective and exit-only).
 */
export async function executeAgentBatch(deps: EngineDeps, batch: ReflexBatch, x: ExecuteContext): Promise<ExecutionRecord> {
  const now = x.nowMs;
  const stored = await deps.repo.settings.get();
  // In memory only: an account's stored settings always allow one lot per order; the agent's pinned maximum is 3.
  const settings: EngineSettings = { ...stored, maxLotsPerOrder: AGENT_LIMITS.maxLotsPerPosition };
  const mainAtStart = await x.mainSettings();
  const flags = () => ({ killSwitch: settings.killSwitch, killReason: settings.killReason, mainKillSwitch: mainAtStart.killSwitch, ddHalt: x.ddHalt, nowMs: now });
  let risk: RiskState = await loadRiskState(deps.repo, deps.cfg, settings, now, deps.mode);
  let snap = riskSnapshotFrom(risk, x.peakEquity, flags());

  const finalists = new Map(batch.finalists.map((f) => [f.id, f] as const));
  const exitNotes = new Map<string, { action: AgentAction; detail: string }>();
  const exits: ExecutionRecord["exits"] = [];

  // 1. Exits the decisions call for (REDUCE, CRISIS, a confident opposite call).
  const exitInputs = [...batch.decisions, ...batch.exitOnly];
  const openOrders = await deps.repo.orders.open(deps.mode);
  let exited = false;
  for (const pos of risk.openPositions) {
    const tag = x.positions[pos.id];
    if (!tag) continue;
    const trig = agentExitTriggers(tag, exitInputs, snap.codeRisk);
    if (!trig) continue;
    const note = (action: AgentAction, detail: string) => {
      if (trig.decisionId) exitNotes.set(trig.decisionId, { action, detail });
    };
    try {
      const resting = openOrders.some((o) => o.positionId === pos.id && o.reason !== "ENTRY");
      const fresh = await deps.repo.positions.get(pos.id);
      if (resting || !fresh || fresh.status !== "OPEN") {
        const why = resting ? "an exit order already rests on it" : "it is no longer open";
        exits.push({ positionId: pos.id, decisionId: trig.decisionId, reason: trig.reason, status: "EXIT_PENDING" });
        note("EXIT_PENDING", `${trig.reason} for ${pos.contract.tradingSymbol} not sent: ${why}`);
        continue;
      }
      if (x.mode === "shadow") {
        exits.push({ positionId: pos.id, decisionId: trig.decisionId, reason: trig.reason, status: "SHADOW_EXIT" });
        note(MODE_EXIT.shadow, `would exit ${pos.contract.tradingSymbol} (${trig.reason}: ${trig.detail})`);
        continue;
      }
      const { order } = await submitExit(deps, fresh, { reason: "SIGNAL_FLIP", orderType: "MARKET", detail: `agent: ${trig.detail}` });
      exited = true;
      exits.push({ positionId: pos.id, decisionId: trig.decisionId, reason: trig.reason, status: order.status });
      note(MODE_EXIT.paper, `exited ${pos.contract.tradingSymbol} at market (${trig.reason}: ${trig.detail}), order ${order.status}`);
    } catch (err) {
      exits.push({ positionId: pos.id, decisionId: trig.decisionId, reason: trig.reason, status: `ERROR: ${errText(err)}` });
      note("NOT_EXECUTED", `the ${trig.reason} exit of ${pos.contract.tradingSymbol} failed (${errText(err)}); the code exits still run every tick`);
    }
  }
  if (exited) {
    // The exits changed the book (realized P&L, open slots): re-read it before any entry.
    risk = await loadRiskState(deps.repo, deps.cfg, settings, now, deps.mode);
    snap = riskSnapshotFrom(risk, x.peakEquity, flags());
  }

  // 2. Entries: the strongest setups first, then the most confident, an Advisor idea before a generic call.
  const attempts = new Map<string, Attempt>();
  const ordered = [...batch.decisions].sort(
    (a, b) => b.setupQuality - a.setupQuality || b.directionConfidence - a.directionConfidence || KIND_ORDER[a.finalistKind] - KIND_ORDER[b.finalistKind],
  );
  for (const d of ordered) {
    try {
      attempts.set(d.id, await tryEntry(deps, d, finalists.get(d.finalistId) ?? null, batch, x, settings, risk, flags));
    } catch (err) {
      const gate: GateVerdict = { fired: false, lines: [{ gate: "order", passed: false, detail: errText(err) }], codeToxic: [], codeRisk: snap.codeRisk, effectiveRisk: snap.codeRisk };
      attempts.set(d.id, { gate, lines: gate.lines, action: "NO_ENTRY", detail: `error: ${errText(err)}`, planId: null, positionId: null, tradingSymbol: null, edge: null, sizing: null });
    }
  }

  // 3. One execution record per decision: an entry result wins; otherwise the exit it caused, if any.
  const record: ExecutionRecord["decisions"] = [];
  for (const d of [...batch.decisions, ...batch.exitOnly]) {
    const a = attempts.get(d.id);
    const ex = exitNotes.get(d.id);
    const entered = a && (a.action === "ENTERED" || a.action === "ENTRY_PENDING" || a.action === "SHADOW_ENTRY");
    let execution: DecisionExecution;
    if (a) {
      execution = {
        t: now,
        gate: { ...a.gate, lines: a.lines },
        action: entered || !ex ? a.action : ex.action,
        detail: ex ? (entered ? `${ex.detail}; then ${a.detail}` : `${ex.detail}; ${a.detail}`) : a.detail,
        planId: a.planId,
        positionId: a.positionId,
        tradingSymbol: a.tradingSymbol,
        edge: a.edge,
        sizing: a.sizing,
      };
    } else {
      const gate: GateVerdict = { fired: false, lines: [{ gate: "batch_ok", passed: false, detail: "exit-only: no decision of this bar took this escalation in, so it can only close a position" }], codeToxic: [], codeRisk: snap.codeRisk, effectiveRisk: snap.codeRisk };
      execution = { t: now, gate, action: ex ? ex.action : "NOT_EXECUTED", detail: ex ? ex.detail : "exit-only: no exit was needed", planId: null, positionId: null, tradingSymbol: null, edge: null, sizing: null };
    }
    record.push({ decisionId: d.id, execution });
  }
  return { barCloseMs: batch.barCloseMs, t: now, decisions: record, exits, trades: [], risk: riskSnapshotFrom(risk, x.peakEquity, flags()) };
}

/** One decision's entry attempt; updates `risk` in place when an order goes out (or, in shadow mode, would). */
async function tryEntry(
  deps: EngineDeps,
  d: DecisionRecord,
  finalist: Finalist | null,
  batch: ReflexBatch,
  x: ExecuteContext,
  settings: EngineSettings,
  risk: RiskState,
  flags: () => Parameters<typeof riskSnapshotFrom>[2],
): Promise<Attempt> {
  const now = x.nowMs;
  const index = d.index;
  const snap = riskSnapshotFrom(risk, x.peakEquity, flags());
  const pending = risk.pendingEntries ?? [];
  const openOnIndex = risk.openPositions.filter((p) => p.index === index).length + pending.filter((p) => p.index === index).length;
  const entriesToday = risk.entriesToday.NIFTY + risk.entriesToday.SENSEX + pending.length;
  const out = (gate: GateVerdict, lines: GateLine[], action: AgentAction, detail: string, more: Partial<Attempt> = {}): Attempt => ({
    gate: { ...gate, fired: action === "ENTERED" || action === "ENTRY_PENDING" || action === "SHADOW_ENTRY" },
    lines,
    action,
    detail,
    planId: null,
    positionId: null,
    tradingSymbol: null,
    edge: null,
    sizing: null,
    ...more,
  });

  if (!finalist) {
    const gate: GateVerdict = { fired: false, lines: [{ gate: "batch_ok", passed: false, detail: `finalist ${d.finalistId} is not in this batch` }], codeToxic: [], codeRisk: snap.codeRisk, effectiveRisk: snap.codeRisk };
    return out(gate, gate.lines, "NO_ENTRY", `finalist ${d.finalistId} is not in this batch`);
  }

  // The code gate (policy.ts). The context also carries the main engine's no-entries reason.
  const gateCtx = { nowMs: now, openOnIndex, entriesToday, maxTradesPerDay: deps.cfg.sizing.maxTradesPerDay, noEntries: x.noEntries };
  const v = codeGate(d, finalist, x.snapshots[index] ?? null, snap, gateCtx);
  const lines: GateLine[] = [...v.lines];
  if (!lines.some((l) => l.gate === "entry_mode")) {
    const why = x.noEntries ?? (x.ddHalt || snap.ddHalt ? "the 15% drawdown halt is on" : null);
    lines.push({ gate: "entry_mode", passed: why === null, detail: why ?? "entries allowed" });
  }
  if (!v.fired || lines.some((l) => l.passed === false)) return out(v, lines, "NO_ENTRY", v.fired ? gateWordsFallback(lines) : gateSummary(v));
  if (d.direction === "NEUTRAL") return out(v, lines, "NO_ENTRY", "no direction");
  const direction = d.direction;

  if (x.timeLeftMs && x.timeLeftMs() <= 0) {
    lines.push({ gate: "time_budget", passed: false, detail: "the step's time budget ran out before this entry" });
    return out(v, lines, "NOT_EXECUTED", "the step's time budget ran out before this entry");
  }

  // Quarter Kelly on the measured probability and payoff only; ≤ 0 means no trade.
  const p = d.sizing?.p ?? null;
  const b = batch.payoff.b;
  if (p === null) {
    lines.push({ gate: "kelly", passed: false, detail: "no sizing probability was stored with the decision" });
    return out(v, lines, "NO_ENTRY", "no sizing probability: no trade");
  }
  const k = agentRiskPct(p, b);
  const n = d.sizing?.n ?? null;
  const sizing: SizingTrace = { p, b, kelly: k.kelly, quarterKelly: k.quarterKelly, riskPct: k.riskPct, lots: 0, riskRupees: 0, limitedBy: k.reason, n };
  // A probability with no graded call behind it is the prior alone: it never sizes a trade, whatever b is.
  if (!(n !== null && n > 0)) {
    const none = "no graded calls of this kind yet";
    lines.push({ gate: "kelly", passed: false, detail: none });
    return out(v, lines, "NO_ENTRY", `${none}: no trade`, { sizing: { ...sizing, riskPct: 0, limitedBy: none } });
  }
  if (!(k.riskPct > 0)) {
    lines.push({ gate: "kelly", passed: false, detail: `p ${p.toFixed(3)}, b ${b.toFixed(2)}, Kelly ${k.kelly.toFixed(3)}` });
    return out(v, lines, "NO_ENTRY", `Kelly ≤ 0: no measured edge yet (p=${p.toFixed(3)}, b=${b.toFixed(2)})`, { sizing });
  }
  lines.push({ gate: "kelly", passed: true, detail: `p ${p.toFixed(3)}, b ${b.toFixed(2)}: risk ${k.riskPct.toFixed(2)}% of equity` });

  // The engine's planner with the agent's pinned config, every gate but the measured-edge checks.
  const f = x.features[index] ?? computeFeatures(index, await deps.market.snapshot(now), x.calendar, deps.cfg);
  const conviction = agentConviction(x.convictions[index] ?? neutralConviction(index, now, deps.cfg), direction);
  const ideaContract = finalist.kind === "IDEA" ? finalist.contract : null;
  // An idea is bought on its own contract (the planner's pickContract); a generic call on the ATM one.
  const pickContract = ideaContract ? (i: IndexId) => deps.instruments.resolve(i, ideaContract.expiry, ideaContract.strike, ideaContract.type) : undefined;
  const planCtx: PlanContext & { pickContract?: (index: IndexId) => Promise<OptionContract | null> } = {
    ...deps,
    cfg: agentPlannerConfig(deps.cfg, k.riskPct),
    calendar: x.calendar,
    accountChecksFirst: true,
    ...(pickContract ? { pickContract } : {}),
  };
  const decision = await planEntry({ index, t: now, features: f, pressure: x.pressure[index] ?? null, conviction, risk, perf: [] }, planCtx);
  if (!decision.plan) {
    lines.push({ gate: "plan", passed: false, detail: decision.noPlanReason ?? "no plan" });
    return out(v, lines, "NO_ENTRY", `the engine's checks blocked it: ${decision.noPlanReason ?? "no plan"}`, { sizing, tradingSymbol: decision.contract?.tradingSymbol ?? null });
  }
  const plan = decision.plan;
  const sizeGate = plan.gates.find((g) => g.gate === "size");
  sizing.lots = plan.lots;
  sizing.riskRupees = plan.riskRupees;
  sizing.limitedBy = sizeGate?.detail ?? sizing.limitedBy;
  const more = { sizing, tradingSymbol: plan.contract.tradingSymbol };
  lines.push({ gate: "plan", passed: true, detail: `${plan.lots} lot(s) of ${plan.contract.tradingSymbol} at about ₹${plan.refPremium}` });
  if (ideaContract && !sameContract(plan.contract, ideaContract)) {
    lines.push({ gate: "idea_contract", passed: false, detail: `the plan picked ${plan.contract.tradingSymbol}, not the idea's ${ideaContract.tradingSymbol}` });
    return out(v, lines, "NO_ENTRY", "the plan did not use the idea's contract", more);
  }

  // Post-plan checks: the quarter-Kelly budget (the sizer may allow one lot above it), the live quote, the buy zone.
  const budget = (risk.capitalRupees * k.riskPct) / 100;
  const capOk = plan.riskRupees <= budget + 0.5;
  lines.push({ gate: "kelly_cap", passed: capOk, detail: `${rupees(plan.riskRupees)} at risk vs ${rupees(budget)} allowed` });
  if (!capOk) return out(v, lines, "NO_ENTRY", `one lot risks ${rupees(plan.riskRupees)}, more than the ${rupees(budget)} quarter Kelly allows`, more);

  const q = await deps.optionQuotes.quote(plan.contract, { t: now, spot: f.spot, vix: f.vix });
  // policy.ts: quote_toxic blocks (no quote, a model price, no depth); one_sided_book is information only (#27, D4).
  const quoteOpts = { acceptSyntheticQuotes: x.acceptSyntheticQuotes };
  const blocking = quoteToxicity(q, quoteOpts);
  lines.push(...quoteGateLines(q, quoteOpts));
  if (blocking.length) return out(v, lines, "NO_ENTRY", `the live quote is not usable: ${blocking.join(", ")}`, more);
  if (ideaContract) {
    if (finalist.entryHigh === null) lines.push({ gate: "idea_band", passed: null, detail: "the brief gave no buy zone" });
    else {
      const top = finalist.entryHigh * AGENT_POLICY.ideaPremiumTolerance;
      const inBand = plan.refPremium <= top;
      lines.push({ gate: "idea_band", passed: inBand, detail: `ask ₹${plan.refPremium} vs buy-zone top ₹${finalist.entryHigh} (+${Math.round((AGENT_POLICY.ideaPremiumTolerance - 1) * 100)}%)` });
      if (!inBand) return out(v, lines, "NO_ENTRY", `the ask ₹${plan.refPremium} is above the brief's buy zone`, more);
    }
  }

  let edge: EdgeVerdict | null = null;
  try {
    edge = edgeVerdict({ cfg: deps.cfg, spot: f.spot, quote: q, contract: plan.contract, calendar: x.calendar, vix: f.vix, horizonMin: plan.horizonMin, t: now });
  } catch {
    edge = null;
  }
  const withEdge = { ...more, edge };

  // The kill switches (main's and the agent's), the drawdown halt and the mode, read again right before the order.
  const [main, agent] = await Promise.all([x.mainSettings(), deps.repo.settings.get()]);
  const stop = main.killSwitch ? `main kill switch on${main.killReason ? `: ${main.killReason}` : ""}` : agent.killSwitch ? `agent kill switch on${agent.killReason ? `: ${agent.killReason}` : ""}` : x.ddHalt ? "the 15% drawdown halt is on" : null;
  lines.push({ gate: "kill_switch", passed: stop === null, detail: stop ?? "off" });
  if (stop) return out(v, lines, "NO_ENTRY", `kill switch: ${stop}`, withEdge);

  if (x.mode !== "paper") {
    // Shadow: no order, no position, no trade. Hold the slot in memory so the batch's other decisions see it.
    (risk.pendingEntries ??= []).push({ index, side: plan.side });
    return out(v, lines, "SHADOW_ENTRY", `would buy ${plan.lots} lot(s) of ${plan.contract.tradingSymbol} at about ₹${plan.refPremium} (shadow mode: no order)`, withEdge);
  }

  const tagged: TradePlan = {
    ...plan,
    dominantSource: "VOL_REGIME",
    gates: [
      ...plan.gates,
      { gate: "agent", label: "Agent decision (paper experiment)", passed: true, detail: `${finalist.label}: ${direction} ${d.directionConfidence.toFixed(2)} setup ${d.setupQuality} (decision ${d.id})` },
    ],
  };
  const { order, position } = await submitEntry(deps, tagged, x.pressure[index] ?? null);
  risk.ordersToday += 1;
  if (order.status === "REJECTED") {
    lines.push({ gate: "order", passed: false, detail: order.error ?? "rejected" });
    return out(v, lines, "NO_ENTRY", `the paper order was rejected: ${order.error ?? "no reason given"}`, { ...withEdge, planId: plan.id });
  }
  const positionId = position?.id ?? order.positionId ?? null;
  if (positionId) x.positions[positionId] = { finalistId: finalist.id, decisionId: d.id, index, side: direction };
  if (position) {
    risk.openPositions.push(position);
    risk.entriesToday[index] += 1;
  } else if (isPendingEntry(order)) (risk.pendingEntries ??= []).push(pendingEntry(order));
  lines.push({ gate: "order", passed: true, detail: `${order.status}${order.avgFillPrice ? ` at ₹${order.avgFillPrice}` : ""}` });
  return out(v, lines, position ? "ENTERED" : "ENTRY_PENDING", `${position ? "bought" : "order resting for"} ${plan.lots} lot(s) of ${plan.contract.tradingSymbol}${order.avgFillPrice ? ` at ₹${order.avgFillPrice}` : ""}`, {
    ...withEdge,
    planId: plan.id,
    positionId,
  });
}

/** The first blocking line, when the code gate fired but a line added here (the entry mode) blocks. */
function gateWordsFallback(lines: GateLine[]): string {
  const f = lines.find((l) => l.passed === false);
  return f ? `${f.gate}: ${f.detail}` : "blocked";
}

/** The agent's code exits (stop, target, trail, time stop, square-off, halt): runPositionCycle(deps, {}). No conviction is passed, so main's signals never flip an agent position. */
export function agentPositionPass(deps: EngineDeps): Promise<PositionReport> {
  return runPositionCycle(deps, {});
}
