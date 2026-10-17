import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentCandidateView, AgentDecisionView, AgentMode, AgentRiskView, AgentView } from "@/engine/api-types";
import { AGENT_DEFAULTS } from "@/engine/agent/config";
import { genericFinalist } from "@/engine/agent/finalists";
import { BUILTIN_GUIDANCE } from "@/engine/agent/prompt";
import { agentSample } from "@/engine/agent/storeContract";
import type { DecisionRecord, GateLine, SizingTrace } from "@/engine/agent/types";
import { buildAgentView } from "@/engine/agent/view";
import { TradingCalendar } from "@/engine/calendar/calendar";
import { MockAgent } from "@/lib/engine/mockAgent";
import type { AgentReplayView, AgentSizingView } from "@/lib/engine/types";
import { istAt } from "@/lib/ist";
import AgentDesk, { POLL_ACTIVE_MS, POLL_IDLE_MS, pollEveryMs } from "./AgentDesk";
import { CalibrationPanel, CostPanel, DemoChip, EscalationList, HonestyBanner, IndexDecisionCard, ReviewPanel, RiskPanel, StatusBar } from "./AgentParts";

/** The mock's view at 11:42 on a trading day, as the demo first shows it. */
const demo = (): AgentView =>
  new MockAgent(() => istAt("2026-10-16", "11:42:05")).view(undefined, { id: "agent", label: "Agent ₹5L", shortLabel: "Agent", paperOnly: true, capitalRupees: 500_000, kind: "agent" });
const html = (el: ReactElement) => renderToStaticMarkup(el);
/** The markup as the reader sees it: tags dropped, entities and spaces folded. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const noop = async () => ({ ok: true as const });
const riskPanel = (risk: AgentRiskView, mode: AgentMode = "paper", generatedAt = "2026-10-16T11:42:05+05:30") => html(createElement(RiskPanel, { risk, mode, hasToken: true, onRearm: noop, generatedAt }));
const candidateOf = (v: AgentView): AgentCandidateView => v.candidate!;
/** Nothing may say or imply that the agent has, found or measured an edge: once the allowed negations are gone, no "edge" is left. */
const claimsEdge = (s: string) =>
  /\bedge\b/i.test(
    s
      .replace(/not proof of an edge/gi, "")
      .replace(/no edge for option buyers/gi, "")
      // The name of the engine's check this account skips (recorded for comparison, never a claim).
      .replace(/Measured-edge check/g, ""),
  );

function parts(view: AgentView, hasToken = false): ReactElement[] {
  return [
    createElement(HonestyBanner, { text: view.honesty }),
    createElement(StatusBar, { view }),
    ...view.indices.map((card) => createElement(IndexDecisionCard, { key: card.index, card, view })),
    createElement(EscalationList, { escalations: view.escalations, finalists: view.finalists, generatedAt: view.generatedAt }),
    createElement(RiskPanel, { risk: view.risk, mode: view.mode, hasToken, onRearm: noop, generatedAt: view.generatedAt }),
    createElement(CalibrationPanel, { cal: view.calibration }),
    createElement(ReviewPanel, { review: view.review, candidate: view.candidate, generatedAt: view.generatedAt, hasToken, onDecide: noop }),
    createElement(CostPanel, { cost: view.cost }),
  ];
}

describe("Agent parts render on the server", () => {
  it("renders every part of the demo view with the words a beginner needs", () => {
    const markup = parts(demo()).map(html).join("\n");
    for (const t of ["paper experiment", "Brier", "in-sample, not proof", "Approve", "Reject", "Re-arm"]) expect(markup).toContain(t);
    // The call that passed the model-side checks: the engine's Kelly line blocks it, so the gate did not fire.
    expect(markup).not.toContain("All 11 checks passed");
    expect(markup).toContain("Blocked by 1 of 12 checks");
    expect(markup).toContain("Size zero: confident past calls have not cleared break-even (measured on about 21 calls)");
    expect(markup).toContain("Blocked by 2 of 11 checks");
    expect(markup).toContain("Deep model re-read");
    expect(markup).toContain("The numbers the model saw");
    expect(markup).toMatch(/Even if every next call paid, that would take about \d+ more graded calls/);
    // Nothing to re-arm in the demo: the button is there but disabled.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-arm the agent<\/button>/);
    expect(html(createElement(DemoChip))).toContain("Demo data");
  });

  it("never claims an edge, and words the model's call as what the agent would do, not an instruction", () => {
    const view = demo();
    const markup = text([...parts(view), createElement(AgentDesk, { initial: view, initialSource: "mock" })].map(html).join("\n"));
    expect(markup).not.toMatch(/measured edge/i);
    expect(claimsEdge(markup)).toBe(false);
    expect(markup).toMatch(/the agent would buy a (call|put) \((CE|PE)\)/);
    expect(markup).not.toMatch(/(UP|DOWN) buy a/);
    expect(markup).toContain("NIFTY, either side (generic call)");
  });

  it("shows the replay's coverage, the calls every run labelled and each run's count, and the approval window", () => {
    const markup = text(html(createElement(ReviewPanel, { review: demo().review, candidate: candidateOf(demo()), generatedAt: demo().generatedAt, hasToken: true, onDecide: noop })));
    expect(markup).toContain("75 of the day's 75 candles were judged again with each text, on identical inputs.");
    expect(markup).toContain("Scored on 58 calls that all three runs labelled (proposed 58, current 66, live 64).");
    expect(markup).toContain("proposed 2 · current 5");
    expect(markup).not.toContain("of the calls could be graded");
    expect(markup).not.toContain("too few to compare");
    expect(markup).toContain(
      "Approve before 09:15 IST, or after the day's review and replay finish (about 16:20–16:45 IST), so the review and the replay judge the text the session ran with.",
    );
    expect(markup).not.toContain("after 15:30 IST");
  });

  it("lays the desk out in the beginner's order: honesty, status, decisions, escalations, risk, calibration, review, cost", () => {
    const view = demo();
    const markup = html(createElement(AgentDesk, { initial: view, initialSource: "mock" }));
    const order = ["A paper experiment, not advice", "Shadow mode", 'id="decisions"', 'id="escalations"', 'id="risk"', 'id="calibration"', 'id="review"', 'id="cost"'].map((t) => markup.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain("Demo data");
    expect(markup).toContain('href="/live?account=agent"');
  });

  it("shows the honesty text even before the first view arrives", () => {
    const markup = html(createElement(AgentDesk, { initial: null, initialSource: null }));
    expect(markup).toContain("no edge for option buyers");
    expect(markup).not.toContain('id="decisions"');
  });

  it("renders an entered trade, an open position, the edge verdict, a halt to re-arm and a decided candidate", () => {
    const view = structuredClone(demo());
    const card = view.indices[0];
    const d = card.decisions[0];
    const sizing: AgentSizingView = { p: 0.56, b: 1, kelly: 0.12, riskPct: 1, lots: 1, n: 412 };
    d.sizing = sizing;
    d.action = "ENTERED";
    d.actionDetail = "Bought 1 lot of NIFTY 22650 CE at ₹121.40";
    d.edge = { passed: false, detail: "the option needs a 0.31% move to break even; NIFTY usually moves 0.12% in 30 minutes" };
    d.outcome = { status: "HIT", ret30Pct: 0.21 };
    card.position = { side: "LONG", tradingSymbol: "NIFTY26O1922650CE", lots: 1, pnlPct: 4.2, finalistId: d.finalistId };
    view.risk = { ...view.risk, drawdownHalt: true, killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page", drawdownPct: 15.18, codeRiskState: "REDUCE" };
    const approved: AgentCandidateView = { ...candidateOf(view), status: "APPROVED", inUse: true, decidedAt: "2026-10-16T15:45:00+05:30", decidedBy: "dashboard" };
    view.candidate = approved;
    view.cost = { ...view.cost, spentUsd: 0.42, reflexLatencyMs: { p50: 2400, p95: 5100 } };
    view.status = { ...view.status, paused: true, lastError: "reflex call timed out" };
    const markup = parts(view, true).map(html).join("\n");
    expect(markup).toContain("Bought on paper");
    expect(text(markup)).toContain(
      "Small size allowed: confident past calls moved enough to pay often enough to clear break-even (measured on about 412 calls, in-sample; not proof of an edge)",
    );
    expect(markup).toContain("Risk 1.00% of equity → 1 lot");
    expect(markup).toContain("Would block");
    expect(markup).toContain("Holding NIFTY26O1922650CE");
    expect(markup).toContain("Halted: the account fell 15.18% from its peak");
    expect(markup).not.toMatch(/disabled=""[^>]*>Re-arm the agent/);
    expect(markup).toContain("Approved: in use");
    expect(markup).not.toContain(">Approve</button>");
    expect(markup).toContain("typical 2.4 s, slow (1 in 20) 5.1 s");
    expect(markup).toContain("Paused by the operator");
    expect(markup).toContain("reflex call timed out");
  });

  it("renders a view with nothing in it yet (before the first session) without inventing numbers", () => {
    const card = (index: "NIFTY" | "SENSEX") => ({ index, barAt: null, close: null, snapshot: null, snapshotTokensEst: null, decisions: [], position: null });
    const empty: AgentView = {
      mode: "shadow",
      enabled: true,
      date: "2026-10-19",
      generatedAt: "2026-10-19T08:00:00+05:30",
      honesty: "A measured experiment on paper, not advice.",
      account: null,
      models: { reflex: "fast-1", escalation: "deep-2", review: "deep-2" },
      instructionVersion: "core-1/00000000",
      status: { state: "CLOSED", lastBarAt: null, lastError: null, paused: false },
      indices: [card("NIFTY"), card("SENSEX")],
      finalists: [],
      escalations: [],
      risk: {
        asOf: null,
        equity: null,
        peakEquity: null,
        drawdownPct: null,
        maxDrawdownPct: 15,
        dayLossPct: null,
        dailyLossCapPct: 3,
        openPositions: 0,
        maxOpenPositions: 2,
        maxLotsPerPosition: 3,
        killSwitch: false,
        killReason: null,
        mainKillSwitch: false,
        drawdownHalt: false,
        codeRiskState: "SAFE",
      },
      calibration: {
        asOf: null,
        graded: 0,
        brier: null,
        baselineBrier: null,
        byIndex: [],
        byKind: [],
        bySource: [],
        neutral: { n: 0, brier: null, baselineBrier: null },
        buckets: [],
        sizingMode: "pooled",
        sizingP: null,
        sizingN: 0,
        payoffB: 1,
        payoffMeasured: null,
        payoffTrades: 0,
        paidRate: null,
        trades: { n: 0, wins: 0, netRupees: 0 },
        note: "",
      },
      review: null,
      candidate: null,
      cost: { date: "2026-10-19", spentUsd: 0, capUsd: 3, capReached: false, byKind: [], reflexLatencyMs: { p50: null, p95: null } },
    };
    const markup = html(createElement(AgentDesk, { initial: empty, initialSource: "engine" }));
    for (const text of ["No candle was judged on this day.", "No escalations today", "No graded calls yet.", "until there are graded calls to measure", "Nothing to re-arm", "No review yet", "No proposed guidance is waiting", "No call times measured today."])
      expect(markup).toContain(text);
    expect(markup).not.toContain("Demo data");
    expect(markup).not.toContain("NaN");
  });

  it("explains an empty card when the agent is off", () => {
    const view = new MockAgent(() => istAt("2026-10-16", "11:42"), { mode: "off" }).view();
    const markup = html(createElement(IndexDecisionCard, { card: view.indices[0], view }));
    expect(markup).toContain("The agent is off");
  });
});

describe("the risk panel matches the code's blocks (dashboard review M3, L8)", () => {
  const base = (): AgentRiskView => ({ ...demo().risk, killSwitch: false, drawdownHalt: false, dayLossPct: 0, drawdownPct: 0, codeRiskState: "SAFE" });

  it("at a 3.2% day loss (cap 3%) says stopped for today, never 'within every limit'", () => {
    const t = text(riskPanel({ ...base(), dayLossPct: 3.2, codeRiskState: "REDUCE" }));
    expect(t).toContain("✗ Stopped for today: today's loss 3.20% reached the 3% cap; positions closed, no new entries until the next session.");
    expect(t).not.toContain("Within every limit");
  });

  it("at a 1.6% day loss (risk state near a limit) says no new entries now, and why", () => {
    const t = text(riskPanel({ ...base(), dayLossPct: 1.6, codeRiskState: "NEAR_LIMIT" }));
    expect(t).toContain("✗ No new entries now: the code's risk state is Near a limit; entries need Safe (day loss under 1.5%, drawdown under 10%");
    expect(t).not.toContain("Within every limit");
    // The meters say where entries stop, not only where the hard limits are.
    expect(t).toContain("New entries stop from 1.5% of equity");
    expect(t).toContain("New entries stop from 10%");
  });

  it("is green only within every limit, in the words of the agent's mode", () => {
    expect(text(riskPanel(base()))).toContain("✓ Within every limit: new entries are allowed when a decision passes every check.");
    // Shadow mode places no order and off judges no candle: neither says that entries are allowed.
    const shadow = text(riskPanel(base(), "shadow"));
    expect(shadow).toContain("✓ Within every limit: paper mode would allow new entries when a decision passes every check (shadow mode places no order).");
    expect(shadow).not.toContain("new entries are allowed");
    const off = text(riskPanel(base(), "off"));
    expect(off).toContain("✓ Within every limit. The agent is off: no candle is judged, so no entry is made.");
    expect(off).not.toContain("new entries are allowed");
  });

  it("offers re-arm during a halt, 'clear the kill switch' when only the switch is on, and nothing while main's switch is on", () => {
    const halted = riskPanel({ ...base(), drawdownHalt: true, killSwitch: true, drawdownPct: 15.2, codeRiskState: "REDUCE" });
    expect(halted).toMatch(/<button(?![^>]*disabled)[^>]*>Re-arm the agent<\/button>/);
    expect(text(halted)).toContain("Clears the halt and the agent's kill switch");
    const killOnly = riskPanel({ ...base(), killSwitch: true, killReason: "manual", drawdownPct: 12, peakEquity: 568_000, codeRiskState: "NEAR_LIMIT" });
    expect(killOnly).toMatch(/<button(?![^>]*disabled)[^>]*>Clear the kill switch<\/button>/);
    expect(text(killOnly)).toContain("the drawdown is still measured from its peak of ₹5,68,000");
    expect(killOnly).not.toContain(">Re-arm the agent<");
    const mainOn = riskPanel({ ...base(), killSwitch: true, mainKillSwitch: true, killReason: "main kill switch engaged at 11:30" });
    expect(mainOn).toMatch(/<button[^>]*disabled=""[^>]*>Clear the kill switch<\/button>/);
    expect(text(mainOn)).toContain("Reset main's kill switch first: the engine refuses until then.");
    expect(text(mainOn)).not.toContain("switches the agent's on again at its next tick");
  });
});

describe("a decision shows its own candle and its real size (dashboard review M1, L2)", () => {
  it("says which candle the decisions are from when the card heads with a later one", () => {
    // late2.test.ts: at 15:26 the card's candle was 15:25, but the decisions were made on the 15:05 candle.
    const view = new MockAgent(() => istAt("2026-10-16", "15:26")).view();
    const card = { ...view.indices[0], barAt: "2026-10-16T15:25:00+05:30" };
    expect(card.decisions.every((d) => d.barAt === "2026-10-16T15:05:00+05:30")).toBe(true);
    expect(text(html(createElement(IndexDecisionCard, { card, view })))).toContain("Decided on the 15:05 candle");
    // The card heading with the decisions' own candle says nothing more.
    expect(text(html(createElement(IndexDecisionCard, { card: view.indices[0], view })))).not.toContain("Decided on the");
  });

  it("when the quarter-Kelly cap blocks the trade, the size row says 0 lots, never '→ 1 lot' (kellycap.test.ts)", () => {
    const view = demo();
    const card = view.indices[0];
    const sizing: AgentSizingView = { p: 0.53, b: 1, kelly: 0.06, riskPct: 0.15, lots: 0, n: 300 };
    const d: AgentDecisionView = {
      ...card.decisions[0],
      sizing,
      action: "NO_ENTRY",
      actionDetail: "one lot risks ₹2,340, more than the ₹750 quarter Kelly allows",
      gate: { fired: false, summary: "", lines: [{ gate: "kelly_cap", passed: false, words: "Blocked: Even one lot would risk more than the sizing allows (₹2,340 at risk vs ₹750 allowed)" }] },
    };
    const t = text(html(createElement(IndexDecisionCard, { card: { ...card, decisions: [d] }, view })));
    expect(t).toContain("Risk 0.15% of equity → 0 lots: one lot would risk more than that");
    expect(t).not.toContain("→ 1 lot");
    expect(claimsEdge(t)).toBe(false);
  });
});

describe("the engine's own view on the page (its candle, status and gate words; the page's parts)", () => {
  const DAY = "2026-10-19";
  const T = istAt(DAY, "15:05");
  const s = agentSample;
  const index = ["NIFTY", "SENSEX"] as const;
  /** The bars stored after the last decision candle (15:05) are for grading only; each close is distinct. */
  const bars = ["15:00", "15:05", "15:10", "15:15", "15:20", "15:25"].flatMap((hhmm, k) =>
    index.map((i) => s.bar({ barCloseMs: istAt(DAY, hhmm), date: DAY, index: i, close: (i === "NIFTY" ? 25_100 : 82_100) + 5 * k, builtMs: istAt(DAY, hhmm) + 40_000 })),
  );
  const gate = (lines: GateLine[]) => ({ fired: false, lines, codeToxic: [], codeRisk: "SAFE" as const, effectiveRisk: "SAFE" as const });
  const trace = (o: Partial<SizingTrace>): SizingTrace => ({ p: 0.458, b: 1, kelly: -0.084, quarterKelly: 0, riskPct: 0, lots: 0, riskRupees: 0, limitedBy: "", n: 0, ...o });
  // What the engine's gate (agentCycle.ts tryEntry) records: a call of a kind with no graded history, and a call on an
  // index main's tick computed no features for.
  const noHistory: DecisionRecord = s.decision({
    id: "n", date: DAY, barCloseMs: T, index: "NIFTY", finalistId: "gen:NIFTY", sizing: { p: 0.458, mode: "pooled", n: 0, mean: 0.5 },
    execution: s.execution({
      t: T + 150_000, action: "NO_ENTRY", detail: "no graded calls of this kind yet: no trade",
      gate: gate([{ gate: "confidence", passed: true, detail: "0.85 is above 0.80" }, { gate: "kelly", passed: false, detail: "no graded calls of this kind yet" }]),
      sizing: trace({ limitedBy: "no graded calls of this kind yet" }),
    }),
  });
  const noFeatures: DecisionRecord = s.decision({
    id: "x", date: DAY, barCloseMs: T, index: "SENSEX", finalistId: "gen:SENSEX", directionConfidence: 0.9, sizing: { p: 0.56, mode: "pooled", n: 120, mean: 0.6 },
    execution: s.execution({
      t: T + 150_000, action: "NO_ENTRY", detail: "no market features: main's tick computed no market features for this index; the agent never fetches its own",
      gate: gate([
        { gate: "kelly", passed: true, detail: "p 0.560, b 1.00: risk 0.30% of equity, measured on about 120 graded calls" },
        { gate: "features", passed: false, detail: "main's tick computed no market features for this index; the agent never fetches its own" },
      ]),
      sizing: trace({ p: 0.56, kelly: 0.12, quarterKelly: 0.03, riskPct: 0.3, n: 120 }),
    }),
  });
  const view = (nowMs: number): AgentView =>
    buildAgentView({
      date: DAY, nowMs, settings: { ...AGENT_DEFAULTS, mode: "shadow" }, enabled: true, paused: false,
      account: { id: "agent", label: "Agent ₹5L", shortLabel: "Agent", paperOnly: true, capitalRupees: 500_000, kind: "agent" },
      instruction: s.instruction(), bars,
      batches: [s.batch(T, { date: DAY, finalists: index.map(genericFinalist), decisions: [noHistory, noFeatures] })],
      decisions: [noHistory, noFeatures], escalations: [], risk: null, calibration: null, payoff: { b: 1, n: 0, measured: null }, trades: [],
      review: null, reviewCostUsd: null, candidate: null, baseGuidance: BUILTIN_GUIDANCE, calls: [], calendar: new TradingCalendar(),
    });

  it("after the reflex window, heads each card with the 15:05 candle its decisions were made on and says it is not judging", () => {
    for (const hhmm of ["15:26", "17:00"]) {
      const v = view(istAt(DAY, hhmm));
      expect(text(html(createElement(StatusBar, { view: v })))).toContain("Not judging now");
      const nifty = text(html(createElement(IndexDecisionCard, { card: v.indices.find((c) => c.index === "NIFTY")!, view: v })));
      expect(nifty).toContain("candle closing 15:05 IST · close 25,105.00");
      expect(nifty).not.toContain("Decided on the");
      expect(nifty).toContain("NIFTY, either side (generic call)");
    }
  });

  it("words the engine's gate lines and sizing without claiming an edge: no graded calls yet, and no market features (S3, D6, D8)", () => {
    const v = view(istAt(DAY, "15:26"));
    const [nifty, sensex] = index.map((i) => text(html(createElement(IndexDecisionCard, { card: v.indices.find((c) => c.index === i)!, view: v }))));
    expect(nifty).toContain("Size zero: no graded calls of this kind yet");
    expect(sensex).toContain("Main's tick computed no market features for this index, so no entry");
    expect(sensex).toContain("measured on about 120 calls, in-sample; not proof of an edge");
    // The engine keeps the sizing but sized no lot: the quarter-Kelly cap is not the reason.
    expect(sensex).toContain("Risk 0.30% of equity → 0 lots: the entry was blocked before it was sized");
    expect(sensex).not.toContain("one lot would risk more than that");
    const page = text(parts(v).map(html).join("\n"));
    expect(page).not.toMatch(/measured edge/i);
    expect(claimsEdge(page)).toBe(false);
  });
});

describe("the nightly review and the candidate (dashboard review M5, L1, L3, L4)", () => {
  const view = demo();
  const panel = (review: AgentView["review"], candidate: AgentCandidateView) =>
    html(createElement(ReviewPanel, { review, candidate, generatedAt: view.generatedAt, hasToken: true, onDecide: noop }));

  it("shows a review waiting for the 16:40 retry as waiting, not failed", () => {
    const review = { ...view.review!, status: "PENDING" as const, summary: "", error: "the 5-minute bar archive is not complete yet; trying again" };
    const markup = panel(review, candidateOf(view));
    expect(text(markup)).toContain("Waiting: the 5-minute bar archive is not complete yet; trying again");
    expect(text(markup)).not.toContain("The review failed");
    expect(markup).not.toContain('role="alert"');
  });

  it("shows a skipped review as skipped, calmly", () => {
    const review = { ...view.review!, status: "SKIPPED" as const, summary: "", error: "nothing to review: no decision was in force and no trade was made on 2026-10-16; the day was graded and scored" };
    const markup = panel(review, candidateOf(view));
    expect(text(markup)).toContain("Skipped: nothing to review");
    expect(markup).not.toContain('role="alert"');
  });

  it("names why a replay stopped early, never blaming the cost cap for a missing key", () => {
    const replay: AgentReplayView = {
      ...candidateOf(view).replay!,
      bars: 0,
      barsTotal: 75,
      graded: 0,
      gradedCandidate: 0,
      gradedCurrent: 0,
      gradedLive: 0,
      gradedCommon: 0,
      brierCandidate: null,
      brierCurrentReplayed: null,
      brierCurrentLive: null,
      firesCandidate: 0,
      firesCurrent: 0,
      complete: false,
      stopReason: "no_key",
    };
    const t = text(panel(view.review, { ...candidateOf(view), replay }));
    expect(t).toContain("0 of the day's 75 candles were judged again");
    expect(t).toContain("The replay could not run (no API key), so no candle was judged again.");
    expect(t).not.toContain("cost cap");
    const interrupted = text(panel(view.review, { ...candidateOf(view), replay: { ...replay, bars: 40, complete: false, stopReason: "interrupted" } }));
    expect(interrupted).toContain("The replay was interrupted (the agent restarted), so it covers only part of the day.");
  });

  it("scores the replay on the calls every run labelled, and says when they are too few to compare (probe-replay.test.ts)", () => {
    const replay: AgentReplayView = { ...candidateOf(view).replay!, graded: 5, gradedCandidate: 5, gradedCurrent: 10, gradedLive: 10, gradedCommon: 5 };
    const t = text(panel(view.review, { ...candidateOf(view), replay }));
    expect(t).toContain("Scored on 5 calls that all three runs labelled (proposed 5, current 10, live 10): too few to compare.");
  });

  it("an approved candidate diffs against the text it was written against, not against itself, and says whether it is still in use", () => {
    // flow.test.ts: after approval the text in use is the candidate's own, and the card used to compare it with itself.
    const c = candidateOf(view);
    const approved: AgentCandidateView = { ...c, status: "APPROVED", currentGuidance: c.guidance, baseGuidance: BUILTIN_GUIDANCE, inUse: true, decidedAt: "2026-10-16T16:45:00+05:30", decidedBy: "owner" };
    const t = text(panel(view.review, approved));
    expect(t).not.toContain("The points are the same");
    expect(t).toContain("Added");
    expect(t).toContain("Text it was written against (");
    expect(t).toContain("Approved: in use");
    const replaced = text(panel(view.review, { ...approved, inUse: false }));
    expect(replaced).toContain("Approved earlier; no longer in use");
    // A view without baseGuidance (an older record) falls back to the text in use now.
    const older = text(panel(view.review, { ...c, baseGuidance: undefined }));
    expect(older).toContain("Added");
  });
});

describe("the Agent page's polling (dashboard review L11)", () => {
  it("retries a failed first load at the quick interval, not after 2 minutes", () => {
    expect(pollEveryMs(false, false)).toBe(POLL_ACTIVE_MS);
    expect(pollEveryMs(true, true)).toBe(POLL_ACTIVE_MS);
    expect(pollEveryMs(true, false)).toBe(POLL_IDLE_MS);
    expect(POLL_ACTIVE_MS).toBe(15_000);
  });
});
