/**
 * A whole session of the options agent on 7 Oct 2026 (replayed 5-minute bars, synthetic option prices): bars
 * judged by a scripted fake reflex model in an in-process AgentBrain, executed through the code gate, the planner and
 * the risk layer on the agent's scoped paper book, then graded and reviewed after the close. The TE runner's own
 * steps (kill-switch coupling, the drawdown halt, re-arm) are mirrored here in a few lines; the runner itself is
 * tested in the worker.
 */
import { describe, expect, it } from "vitest";
import { accountConfig } from "../accounts";
import type { OptionFlowView } from "../api-types";
import { formatHHMM, istAt, istDate, istIso, istMinutes, MINUTE_MS } from "../clock";
import { makeConfig } from "../config";
import { submitExit } from "../pipeline/execution";
import { loadRiskState } from "../pipeline/riskState";
import { runEndOfDay } from "../pipeline/dayLifecycle";
import { runPositionCycle } from "../pipeline/positionCycle";
import { runTradingCycle } from "../pipeline/tradingCycle";
import { sequentialIds, silentLogger } from "../ports";
import { loadMarketFixtures } from "../testing/fixtures";
import { createFollowerDeps, createReplayDeps, type ReplayDeps } from "../testing/replayHarness";
import { MARKET_SYMBOLS, type DayLedger, type IndexId, type TradeRecord } from "../types";
import { agentPositionPass, bookAsOf, bookFrom, buildReflexInput, executeAgentBatch, initialBook } from "./agentCycle";
import { AgentBrain } from "./brain";
import { causalMarketSnapshot, latestClosedBarMs } from "./causal";
import { AGENT_LIMITS, AGENT_POLICY, OUTCOME, REVIEW_CALL } from "./constants";
import type { DeepJudge, DeepRequest, DeepResponse, ReflexJudge, ReflexRequest, ReflexResponse } from "./judge";
import { drawdownBreached, riskSnapshotFrom } from "./risk";
import { MemoryAgentStore } from "./store";
import { agentSample } from "./storeContract";
import type { AgentBookState, AgentPositionTag, AgentRiskSnapshot, AgentTradeRecord, DecisionRecord, ExecutionRecord, ReflexDecision, ReflexInput, ReviewOut } from "./types";

const DAY = "2026-10-07";
const fixtures = loadMarketFixtures();
const mainCfg = makeConfig({ gates: { maxDataAgeSec: 100_000, minOi: 0 } });
const agentCfg = accountConfig(mainCfg, "agent");
const INDICES: IndexId[] = ["NIFTY", "SENSEX"];
const STEP_OFFSET_MS = 2 * MINUTE_MS;

type Script = Record<string, Partial<Record<IndexId, Partial<ReflexDecision>>>>;
const LONG = { direction: "LONG" as const, directionConfidence: 0.9, setupQuality: 3 as const };
/** 10:30 both indices; 10:35 NIFTY again (its slot is taken) and REDUCE on SENSEX; 14:25 NIFTY, held to the square-off. */
const DAY_SCRIPT: Script = {
  "10:30": { NIFTY: LONG, SENSEX: { ...LONG, directionConfidence: 0.88 } },
  "10:35": { NIFTY: LONG, SENSEX: { riskState: "REDUCE" } },
  "14:25": { NIFTY: LONG },
};

class ScriptedReflex implements ReflexJudge {
  readonly kind = "fake" as const;
  readonly model = "claude-haiku-5-5";
  calls: ReflexRequest[] = [];
  constructor(private readonly script: Script) {}
  async judge(req: ReflexRequest): Promise<ReflexResponse> {
    this.calls.push(req);
    const at = formatHHMM(istMinutes(req.input.barCloseMs));
    const decisions = req.finalists.map((f) => ({
      finalistId: f.id, regime: "TRENDING" as const, direction: "NEUTRAL" as const, directionConfidence: 0.45, toxicFlow: false, setupQuality: 1 as const, riskState: "SAFE" as const, reason: "no clear move",
      ...(this.script[at]?.[f.index] ?? {}),
    }));
    return { status: "OK", decisions, dropped: [], usage: { inputTokens: 1_700, outputTokens: 600, cacheReadTokens: 1_300, cacheCreationTokens: 0 }, model: this.model, latencyMs: 1_500, error: null };
  }
}

const REVIEW: ReviewOut = {
  summary: "A quiet RBI day; two entries at 10:30, one stopped by time.",
  fills: ["NIFTY call 10:32–12:32: time stop"],
  misses: [],
  mistakes: ["entered both indices at once before the trend was clear"],
  lessons: ["wait for the flow to agree"],
  candidate: { guidance: "- Prefer NEUTRAL until the option flow agrees with the trend.", rationale: "entries without flow support lost", wouldBeWrongIf: "the next sessions show the same losses" },
};

class FakeDeep implements DeepJudge {
  readonly model = "claude-opus-5-5";
  calls = 0;
  async structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    this.calls++;
    return { status: "OK", parsed: req.schema.parse(REVIEW), usage: { inputTokens: 20_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0 }, model: this.model, latencyMs: 60_000, error: null };
  }
}

function flowView(index: IndexId, spot: number, t: number): OptionFlowView {
  const step = index === "NIFTY" ? 50 : 100;
  const atm = Math.round(spot / step) * step;
  const side = (mid: number) => ({ oi: 120_000, ltp: mid, bid: mid - 0.5, ask: mid + 0.5, iv: 13, delta: 0.5, oiChg: 0, oiChgPct: 0, vol: 1_000, volMultiple: 1, ltpChgPct: 0, ivChg: 0, buildup: "NEUTRAL" });
  const rows = [-2, -1, 0, 1, 2].map((k) => ({ strike: atm + k * step, ce: side(120 - 20 * k), pe: side(115 + 20 * k) }));
  const w = (minutes: number) => ({ minutes, from: istIso(t - minutes * MINUTE_MS), rows });
  return {
    index, source: "feed", asOf: istIso(t - 30_000), expiry: null, lotSize: null, spot, atm, step, minutes: 60, note: null,
    windows: { "1m": w(1), "5m": w(5), "15m": w(15) }, events: [],
    summary: { pcr: 0.9, pcrChg15m: null, resistance: { strike: atm + 2 * step, oi: 150_000 }, support: { strike: atm - 2 * step, oi: 150_000 } },
  } as unknown as OptionFlowView;
}

/** The settled 5-minute archive (bars_5m) for the review: t is the bar's open. */
const archive = async (index: IndexId, fromMs: number, toMs: number) => (fixtures.candles[MARKET_SYMBOLS[index]] ?? []).filter((c) => c.t >= fromMs && c.t < toMs).map((c) => ({ t: c.t, c: c.c }));

interface Session {
  main: ReplayDeps;
  deps: ReplayDeps;
  store: MemoryAgentStore;
  brain: AgentBrain;
  reflex: ScriptedReflex;
  deep: FakeDeep;
  inputs: Map<number, ReflexInput>;
  books: AgentBookState[];
  positions: Record<string, AgentPositionTag>;
  peak: number | null;
  ddHalt: boolean;
  lastSubmitted: number;
  lastRisk: AgentRiskSnapshot | null;
  records: ExecutionRecord[];
  sentTrades: Set<string>;
}

async function newSession(mode: "paper" | "shadow", script: Script): Promise<Session> {
  const main = createReplayDeps({ cfg: mainCfg, startMs: istAt(DAY, "09:15"), candles: fixtures.candles, daily: fixtures.daily });
  const deps = createFollowerDeps(main, agentCfg, "agent");
  const store = new MemoryAgentStore();
  const reflex = new ScriptedReflex(script);
  const deep = new FakeDeep();
  const brain = new AgentBrain({
    store,
    settings: { mode, reflexModel: reflex.model, escalationModel: deep.model, reviewModel: deep.model, dailyUsdCap: 3, escalationsPerDay: 8 },
    reflex,
    escalation: deep,
    review: deep,
    advisor: async () => null,
    barsFallback: archive,
    calendar: main.calendar,
    cfg: agentCfg,
    now: () => main.clock.now(),
    newId: sequentialIds("agent-brain"),
    logger: silentLogger,
  });
  // Measured history good enough for the sizing probability to clear one half (each window counted once).
  const version = (await brain.status()).instructionVersion;
  const rows: DecisionRecord[] = [];
  for (let i = 0; i < 400; i++) {
    const t = istAt("2026-08-20", "09:30") + Math.floor(i / 9) * 24 * 60 * MINUTE_MS + (i % 9) * 40 * MINUTE_MS;
    rows.push(agentSample.decision({ id: `h${i}`, date: istDate(t), barCloseMs: t, instructionVersion: version, directionConfidence: 0.9, outcome: agentSample.outcome({ status: "HIT", y: 1, paid: i % 5 !== 0 }) }));
  }
  await store.putDecisions(rows);
  return { main, deps, store, brain, reflex, deep, inputs: new Map(), books: [], positions: {}, peak: null, ddHalt: false, lastSubmitted: 0, lastRisk: null, records: [], sentTrades: new Set() };
}

/** The runner's risk step (SPEC §5.2 steps 2–4): couple main's kill switch, track the peak, halt at a 15% drawdown. */
async function riskStep(s: Session, t: number): Promise<void> {
  const [agent, main] = await Promise.all([s.deps.repo.settings.get(), s.main.repo.settings.get()]);
  if (main.killSwitch && !agent.killSwitch) await s.deps.repo.settings.update({ killSwitch: true, killReason: `main kill switch engaged at ${formatHHMM(istMinutes(t))}` }, "agent");
  const settings = await s.deps.repo.settings.get();
  const risk = riskSnapshotFrom(await loadRiskState(s.deps.repo, s.deps.cfg, settings, t, s.deps.mode), s.peak, {
    killSwitch: settings.killSwitch, killReason: settings.killReason, mainKillSwitch: main.killSwitch, ddHalt: s.ddHalt, nowMs: t,
  });
  s.peak = risk.peakEquity;
  s.lastRisk = risk;
  if (drawdownBreached(risk) && !s.ddHalt) {
    s.ddHalt = true;
    await s.deps.repo.settings.update({ killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page" }, "agent");
    await agentPositionPass(s.deps);
  }
}

/** The operator's re-arm: the halt and the kill switch cleared, the peak restarted at the current equity. */
async function rearm(s: Session, t: number): Promise<void> {
  s.ddHalt = false;
  await s.deps.repo.settings.update({ killSwitch: false, killReason: null }, "owner");
  const settings = await s.deps.repo.settings.get();
  const risk = riskSnapshotFrom(await loadRiskState(s.deps.repo, s.deps.cfg, settings, t, s.deps.mode), null, { killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, nowMs: t });
  s.peak = risk.equity;
}

/** Today's closed agent trades not sent yet, tagged with their finalist (SPEC §5.2 step 6). */
async function newTrades(s: Session): Promise<AgentTradeRecord[]> {
  const out: AgentTradeRecord[] = [];
  for (const tr of await s.deps.repo.trades.between(istAt(DAY, "09:00"), istAt(DAY, "16:00"), s.deps.mode)) {
    if (s.sentTrades.has(tr.positionId)) continue;
    s.sentTrades.add(tr.positionId);
    const tag = s.positions[tr.positionId];
    out.push({
      positionId: tr.positionId, date: DAY, index: tr.index, side: tr.side, finalistId: tag?.finalistId ?? null, decisionId: tag?.decisionId ?? null, tradingSymbol: tr.tradingSymbol,
      entryMs: tr.entryMs, exitMs: tr.exitMs, lots: Math.round(tr.qty / (tr.index === "NIFTY" ? 65 : 20)), pnlRupees: tr.pnl, pnlPctPremium: tr.pnlPctPremium, exitReason: tr.exitReason, agentExit: null,
    });
  }
  return out;
}

async function step(s: Session, t: number, mode: "paper" | "shadow"): Promise<void> {
  s.main.clock.set(t);
  const r = await runTradingCycle(s.main, { noEvents: true });
  await riskStep(s, t);
  // The bar: from the market data (also the 15:30 bar after the close, for grading).
  const market = await s.main.market.snapshot(t);
  const bar = latestClosedBarMs(market, INDICES, t, s.main.calendar);
  if (bar && bar.barCloseMs > s.lastSubmitted && bar.complete.length) {
    s.lastSubmitted = bar.barCloseMs;
    const T = bar.barCloseMs;
    const causal = causalMarketSnapshot(market, T);
    const flows: Partial<Record<IndexId, OptionFlowView>> = {};
    for (const index of bar.complete) {
      const bars = causal.candles[MARKET_SYMBOLS[index]] ?? [];
      flows[index] = flowView(index, bars[bars.length - 1].c, T);
    }
    const input = buildReflexInput({
      barCloseMs: T, indices: INDICES, complete: bar.complete, market, calendar: s.main.calendar, cfg: agentCfg, events: [], perf: r.perf ?? [], flows,
      book: bookAsOf(s.books, T, initialBook(s.lastRisk && s.lastRisk.t <= T ? s.lastRisk : null, agentCfg.capitalRupees, T)), nowMs: t,
    });
    s.inputs.set(T, input);
    await s.brain.submitBar(input);
    await s.brain.runDue(t, t + 10 * MINUTE_MS);
    const batch = await s.brain.takeDecisions(T - 1);
    if (batch && t - batch.barCloseMs <= AGENT_POLICY.maxDecisionAgeMs && r.phase === "OPEN") {
      const rec = await executeAgentBatch(s.deps, batch, {
        mode, nowMs: t, calendar: s.main.calendar, features: r.features, pressure: r.pressure, convictions: r.convictions, snapshots: input.snapshots,
        noEntries: null, mainSettings: () => s.main.repo.settings.get(), peakEquity: s.peak, ddHalt: s.ddHalt, positions: s.positions, trades: [], acceptSyntheticQuotes: true,
      });
      s.records.push(rec);
      await s.brain.recordExecution({ ...rec, trades: await newTrades(s) });
      s.books.push(bookFrom(rec.risk, await s.deps.repo.positions.open(s.deps.mode), (p) => p.contract.lotSize));
    }
  }
  await runPositionCycle(s.main, { convictions: r.convictions });
  if (!(mode === "shadow" && (await s.deps.repo.positions.open(s.deps.mode)).length === 0)) await agentPositionPass(s.deps);
}

async function runSession(mode: "paper" | "shadow", script: Script, hooks: { before?: (s: Session) => Promise<void>; at?: Record<string, (s: Session, t: number) => Promise<void>> } = {}): Promise<Session> {
  const s = await newSession(mode, script);
  if (hooks.before) await hooks.before(s);
  for (let t = istAt(DAY, "09:15") + STEP_OFFSET_MS; t <= istAt(DAY, "15:30") + STEP_OFFSET_MS; t += 5 * MINUTE_MS) {
    const hook = hooks.at?.[formatHHMM(istMinutes(t))];
    if (hook) await hook(s, t);
    await step(s, t, mode);
  }
  s.main.clock.set(istAt(DAY, "16:00"));
  await runEndOfDay(s.deps, { grade: false, performance: false });
  const trades = await newTrades(s);
  if (trades.length && s.lastRisk) await s.brain.recordExecution({ barCloseMs: s.lastSubmitted, t: istAt(DAY, "16:00"), decisions: [], exits: [], trades, risk: s.lastRisk });
  return s;
}

const executions = (s: Session, at: string) =>
  s.records
    .filter((r) => formatHHMM(istMinutes(r.barCloseMs)) === at)
    .flatMap((r) => r.decisions.map((d) => ({ ...d.execution, decisionId: d.decisionId })));
const allTrades = (s: Session): Promise<TradeRecord[]> => s.deps.repo.trades.between(0, Number.MAX_SAFE_INTEGER, s.deps.mode);

describe("a whole session of the options agent (7 Oct replay, paper)", () => {
  it("judges 70 bars, stores 75, enters each fired decision within the limits, exits on REDUCE and squares off at 15:05", async () => {
    const s = await runSession("paper", DAY_SCRIPT);
    expect(s.reflex.calls).toHaveLength(70);
    expect(new Set((await s.store.bars(DAY)).map((b) => b.barCloseMs)).size).toBe(75);
    expect((await s.store.batches(DAY)).every((b) => b.status === "OK")).toBe(true);

    // 10:30: both indices fire and both are bought, sized within the limits.
    const at1030 = executions(s, "10:30");
    expect(at1030.filter((e) => e.action === "ENTERED")).toHaveLength(2);
    for (const e of at1030.filter((x) => x.action === "ENTERED")) {
      expect(e.sizing!.lots).toBeGreaterThanOrEqual(1);
      expect(e.sizing!.lots).toBeLessThanOrEqual(AGENT_LIMITS.maxLotsPerPosition);
      expect(e.sizing!.riskPct).toBeLessThanOrEqual(AGENT_LIMITS.maxRiskPctPerTrade);
      expect(e.sizing!.riskRupees).toBeLessThanOrEqual((agentCfg.capitalRupees * AGENT_LIMITS.maxRiskPctPerTrade) / 100 + 0.5);
    }
    // 10:35: NIFTY's slot is taken (one per index); SENSEX's REDUCE closes it at this batch.
    const at1035 = executions(s, "10:35");
    expect(at1035.find((e) => e.action === "ENTERED")).toBeUndefined();
    expect(at1035.map((e) => e.action)).toContain("EXITED");
    const reduceRec = s.records.find((r) => formatHHMM(istMinutes(r.barCloseMs)) === "10:35")!;
    expect(reduceRec.exits).toEqual([expect.objectContaining({ reason: "AGENT_REDUCE", status: "FILLED" })]);

    const trades = await allTrades(s);
    const sensex = trades.find((t) => t.index === "SENSEX")!;
    expect(sensex.exitReason).toBe("SIGNAL_FLIP");
    expect(formatHHMM(istMinutes(sensex.exitMs))).toBe("10:37");
    // Never more than 2 open, never 2 on one index.
    for (const a of trades) {
      const overlapping = trades.filter((b) => b.entryMs < a.exitMs && a.entryMs < b.exitMs);
      expect(overlapping.length).toBeLessThanOrEqual(AGENT_LIMITS.maxOpenTotal);
      expect(overlapping.filter((b) => b.index === a.index)).toHaveLength(1);
    }
    // 14:25: bought and held to the 15:05 square-off.
    expect(executions(s, "14:25").filter((e) => e.action === "ENTERED")).toHaveLength(1);
    const last = trades.find((t) => formatHHMM(istMinutes(t.entryMs)) === "14:27")!;
    expect(last.exitReason).toBe("SQUARE_OFF");
    expect(last.exitMs).toBeLessThanOrEqual(istAt(DAY, "15:10"));
    expect(await s.deps.repo.positions.open(s.deps.mode)).toEqual([]);
    expect(trades).toHaveLength(3);
    // The brain holds every trade, the REDUCE one marked as the agent's own exit.
    const stored = await s.store.trades(DAY, DAY);
    expect(stored).toHaveLength(3);
    expect(stored.find((t) => t.index === "SENSEX")?.agentExit).toBe("AGENT_REDUCE");
    expect(stored.every((t) => t.finalistId !== null)).toBe(true);
  });

  it("grades 30-minute outcomes after the close and writes a review whose candidate waits, scored in-sample", async () => {
    const s = await runSession("paper", DAY_SCRIPT);
    s.main.clock.set(istAt(DAY, "16:00"));
    await s.brain.scheduleReview(DAY);
    let wake: number | null = istAt(DAY, "16:20");
    for (let i = 0; i < 10 && wake !== null; i++) {
      s.main.clock.set(Math.max(wake, s.main.clock.now()));
      wake = await s.brain.runDue(s.main.clock.now(), s.main.clock.now() + 10 * MINUTE_MS);
    }
    const review = (await s.store.review(DAY))!;
    expect(review.status).toBe("DONE");
    expect(review.report?.summary).toBe(REVIEW.summary);
    expect(review.calibration?.graded).toBeGreaterThan(0);

    // A 10:30 call is graded on the 11:00 close, from the archive.
    const closes = new Map((fixtures.candles[MARKET_SYMBOLS.NIFTY] ?? []).map((c) => [c.t + 5 * MINUTE_MS, c.c] as const));
    const t0 = istAt(DAY, "10:30");
    const ret = ((closes.get(t0 + OUTCOME.horizonBars * 5 * MINUTE_MS)! / closes.get(t0)!) - 1) * 100;
    const d1030 = (await s.store.decisionsForBar(t0)).find((d) => d.index === "NIFTY")!;
    expect(d1030.outcome).toMatchObject({ status: ret >= OUTCOME.deadbandPct ? "HIT" : "MISS", source: "BARS_5M" });
    expect(d1030.outcome!.ret30Pct).toBeCloseTo(ret, 6);
    // Calls whose 30 minutes run past the close are censored.
    const late = (await s.store.decisionsForBar(istAt(DAY, "15:05"))).find((d) => d.index === "NIFTY")!;
    expect(late.outcome?.status).toBe("CENSORED");

    const cand = (await s.store.latestCandidate())!;
    expect(cand.status).toBe("PENDING");
    expect(cand.guidance).toBe(REVIEW.candidate!.guidance);
    expect(cand.replay).toMatchObject({ bars: 70, complete: true, label: "in-sample, not proof" });
    // Both texts replayed on every judged bar.
    expect(s.reflex.calls).toHaveLength(70 + 2 * 70);
    expect((await s.store.calls(DAY)).filter((c) => c.kind === "REPLAY")).toHaveLength(140);
    expect(Math.ceil(70 / REVIEW_CALL.replayBarsPerAlarm)).toBeLessThanOrEqual(10);
  });

  it("does not send a second sell when an exit order already rests: EXIT_PENDING (AMENDMENTS #9)", async () => {
    const s = await runSession(
      "paper",
      { "10:30": { NIFTY: LONG }, "10:35": { NIFTY: { riskState: "REDUCE" } } },
      {
        at: {
          // After the 10:30 entry: a target limit far above the market rests on the position.
          "10:37": async (sess, t) => {
            sess.main.clock.set(t);
            const [pos] = await sess.deps.repo.positions.open(sess.deps.mode);
            await submitExit(sess.deps, pos, { reason: "TARGET", orderType: "LIMIT", limitPrice: 9_999, detail: "resting target" });
          },
        },
      },
    );
    const rec = s.records.find((r) => formatHHMM(istMinutes(r.barCloseMs)) === "10:35")!;
    expect(rec.exits).toEqual([expect.objectContaining({ reason: "AGENT_REDUCE", status: "EXIT_PENDING" })]);
    expect(executions(s, "10:35").find((e) => e.action === "EXIT_PENDING")).toBeDefined();
    const sells = (await s.deps.repo.orders.between(istAt(DAY, "10:30"), istAt(DAY, "10:40"), s.deps.mode)).filter((o) => o.side === "SELL");
    expect(sells.map((o) => o.reason)).toEqual(["TARGET"]);
  });
});

describe("a whole session of the options agent (7 Oct replay, shadow)", () => {
  it("records what it would have done and writes no order, position or trade", async () => {
    const s = await runSession("shadow", DAY_SCRIPT);
    expect(s.reflex.calls).toHaveLength(70);
    const at1030 = executions(s, "10:30");
    expect(at1030.filter((e) => e.action === "SHADOW_ENTRY")).toHaveLength(2);
    expect(at1030[0].detail).toMatch(/^would buy \d lot\(s\) of /);
    const stored = (await s.store.decisionsForBar(istAt(DAY, "10:30"))).filter((d) => d.execution?.action === "SHADOW_ENTRY");
    expect(stored).toHaveLength(2);
    expect(await s.deps.repo.orders.between(0, Number.MAX_SAFE_INTEGER, s.deps.mode)).toEqual([]);
    expect(await s.deps.repo.positions.open(s.deps.mode)).toEqual([]);
    expect(await allTrades(s)).toEqual([]);
  });
});

describe("the 15% drawdown halt", () => {
  it("engages the kill switch, refuses entries until the operator re-arms, then trades again", async () => {
    const s = await runSession("paper", { "10:30": { NIFTY: LONG }, "14:25": { NIFTY: LONG } }, {
      before: async (sess) => {
        // A loss in the previous week: today starts at ₹4,25,000 against a peak of ₹5,00,000 (15% down).
        await sess.deps.repo.ledger.save({ date: "2026-10-01", mode: sess.deps.mode, realized: -75_000, unrealized: 0, charges: 0, trades: 3, wins: 0, losses: 3, consecutiveLosses: 3, ordersPlaced: 6, maxIntradayDrawdown: 75_000, peakEquity: 500_000, startEquity: 500_000, updatedMs: istAt("2026-10-01", "15:30") } as DayLedger);
        sess.peak = 500_000;
      },
      at: { "11:02": async (sess, t) => rearm(sess, t) },
    });
    expect(s.records.length).toBeGreaterThan(0);
    const at1030 = executions(s, "10:30").find((e) => e.sizing !== null || e.gate.lines.length > 0)!;
    expect(at1030.action).toBe("NO_ENTRY");
    expect(executions(s, "10:30").some((e) => e.action === "ENTERED")).toBe(false);
    expect(at1030.gate.lines.some((l) => (l.gate === "entry_mode" || l.gate === "risk_state" || l.gate === "kill_switch") && l.passed === false)).toBe(true);
    const at1425 = executions(s, "14:25").find((e) => e.decisionId && e.action === "ENTERED");
    expect(at1425).toBeDefined();
    expect((await s.deps.repo.settings.get()).killSwitch).toBe(false);
  });

  it("flattens open positions when the drawdown is reached during the session, and takes no new entry", async () => {
    const s = await runSession("paper", { "10:30": { NIFTY: LONG, SENSEX: LONG }, "14:25": { NIFTY: LONG } }, {
      at: {
        // A 15% loss lands in today's ledger after the 10:30 entries.
        "10:52": async (sess, t) => {
          sess.main.clock.set(t);
          const l = (await sess.deps.repo.ledger.get(DAY, sess.deps.mode))!;
          await sess.deps.repo.ledger.save({ ...l, realized: l.realized - 75_000 });
        },
      },
    });
    expect(s.ddHalt).toBe(true);
    const settings = await s.deps.repo.settings.get();
    expect(settings.killSwitch).toBe(true);
    expect(settings.killReason).toBe("max drawdown 15% reached: re-arm on the Agent page");
    const trades = await allTrades(s);
    expect(trades.filter((t) => formatHHMM(istMinutes(t.entryMs)) === "10:32")).toHaveLength(2);
    for (const t of trades) {
      expect(t.exitMs).toBeLessThanOrEqual(istAt(DAY, "10:53"));
      expect(t.exitReason).toBe("KILL_SWITCH");
    }
    expect(executions(s, "14:25").some((e) => e.action === "ENTERED")).toBe(false);
  });
});
