import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentView } from "@/engine/api-types";
import { MockAgent } from "@/lib/engine/mockAgent";
import { istAt } from "@/lib/ist";
import AgentDesk from "./AgentDesk";
import { CalibrationPanel, CostPanel, DemoChip, EscalationList, HonestyBanner, IndexDecisionCard, ReviewPanel, RiskPanel, StatusBar } from "./AgentParts";

/** The mock's view at 11:42 on a trading day, as the demo first shows it. */
const demo = (): AgentView =>
  new MockAgent(() => istAt("2026-10-16", "11:42:05")).view(undefined, { id: "agent", label: "Agent ₹5L", shortLabel: "Agent", paperOnly: true, capitalRupees: 500_000, kind: "agent" });
const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = async () => ({ ok: true as const });

function parts(view: AgentView, hasToken = false): ReactElement[] {
  return [
    createElement(HonestyBanner, { text: view.honesty }),
    createElement(StatusBar, { view }),
    ...view.indices.map((card) => createElement(IndexDecisionCard, { key: card.index, card, view })),
    createElement(EscalationList, { escalations: view.escalations, finalists: view.finalists, generatedAt: view.generatedAt }),
    createElement(RiskPanel, { risk: view.risk, hasToken, onRearm: noop, generatedAt: view.generatedAt }),
    createElement(CalibrationPanel, { cal: view.calibration }),
    createElement(ReviewPanel, { review: view.review, candidate: view.candidate, generatedAt: view.generatedAt, hasToken, onDecide: noop }),
    createElement(CostPanel, { cost: view.cost }),
  ];
}

describe("Agent parts render on the server", () => {
  it("renders every part of the demo view with the words a beginner needs", () => {
    const markup = parts(demo()).map(html).join("\n");
    for (const text of ["paper experiment", "Brier", "in-sample, not proof", "Approve", "Reject", "Re-arm"]) expect(markup).toContain(text);
    // The fired decision: every check passed, and Kelly says there is no measured edge.
    expect(markup).toContain("All 11 checks passed");
    expect(markup).toContain("No measured edge yet: no trade");
    expect(markup).toContain("Blocked by 2 of 11 checks");
    expect(markup).toContain("Deep model re-read");
    expect(markup).toContain("The numbers the model saw");
    expect(markup).toMatch(/Even if every next call paid, that would take about \d+ more graded calls/);
    // Nothing to re-arm in the demo: the button is there but disabled.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-arm the agent<\/button>/);
    expect(html(createElement(DemoChip))).toContain("Demo data");
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
    d.sizing = { p: 0.56, b: 1, kelly: 0.12, riskPct: 1, lots: 1 };
    d.action = "ENTERED";
    d.actionDetail = "Bought 1 lot of NIFTY 22650 CE at ₹121.40";
    d.edge = { passed: false, detail: "the option needs a 0.31% move to break even; NIFTY usually moves 0.12% in 30 minutes" };
    d.outcome = { status: "HIT", ret30Pct: 0.21 };
    card.position = { side: "LONG", tradingSymbol: "NIFTY26O1922650CE", lots: 1, pnlPct: 4.2, finalistId: d.finalistId };
    view.risk = { ...view.risk, drawdownHalt: true, killSwitch: true, killReason: "max drawdown 15% reached: re-arm on the Agent page", drawdownPct: 15.18, codeRiskState: "REDUCE" };
    view.candidate = { ...view.candidate!, status: "APPROVED", decidedAt: "2026-10-16T15:45:00+05:30", decidedBy: "dashboard" };
    view.cost = { ...view.cost, spentUsd: 0.42, reflexLatencyMs: { p50: 2400, p95: 5100 } };
    view.status = { ...view.status, paused: true, lastError: "reflex call timed out" };
    const markup = parts(view, true).map(html).join("\n");
    expect(markup).toContain("Bought on paper");
    expect(markup).toContain("Risk 1.00% of equity → 1 lot");
    expect(markup).toContain("Would block");
    expect(markup).toContain("Holding NIFTY26O1922650CE");
    expect(markup).toContain("Halted: the account fell 15.18% from its peak");
    expect(markup).not.toMatch(/disabled=""[^>]*>Re-arm the agent/);
    expect(markup).toContain("Approved: in use from the next candle");
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
