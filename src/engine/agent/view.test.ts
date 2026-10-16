import { describe, expect, it } from "vitest";
import type { AccountView } from "../api-types";
import { TradingCalendar } from "../calendar/calendar";
import { istAt, istIso, MINUTE_MS } from "../clock";
import { AGENT_HONESTY } from "./constants";
import { agentSample as s } from "./storeContract";
import type { AgentSettings, CalibrationSummary, DecisionRecord, Finalist, IndexSnapshot } from "./types";
import { buildAgentView, emptyAgentView, gateWords, snapshotFields, withAccountSettings, type AgentViewInput } from "./view";

const DAY = "2026-10-19";
const T = istAt(DAY, "10:35");
const cal = new TradingCalendar();
const settings: AgentSettings = { mode: "shadow", reflexModel: "reflex-x", escalationModel: "deep-x", reviewModel: "deep-y", dailyUsdCap: 3, escalationsPerDay: 8 };
const account: AccountView = { id: "agent", label: "Agent ₹5L", shortLabel: "Agent", paperOnly: true, capitalRupees: 500_000, kind: "agent" };

const snap = (o: Partial<IndexSnapshot> = {}): IndexSnapshot => ({
  c: 25_012, r5: 12, r15: -8, r60: 31, ro: 45, vw: 18, vz: 0.9, orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
  rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 8, vix: 13.4, vixc: -2.1,
  o: { k: 25_000, cm: 112.4, cs: 89, pm: 98.1, ps: 102, iv: 13, ivx: -0.4, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkckb", ew: 1, dte: 3, xd: 0,
  bk: { pos: "L", lots: 1, pnl: 4.2, dd: 115, dl: 35 },
  ...o,
});

const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({
  id: `gen:${index}`, kind: "GENERIC", index, label: `${index}: best long or short now`, side: null, contract: null, entryHigh: null,
  condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
});
const idea: Finalist = {
  id: "idea:b1:i1", kind: "IDEA", index: "NIFTY", label: "NIFTY 25100 CE 23 Oct", side: "LONG",
  contract: { expiry: "2026-10-23", strike: 25_100, type: "CE", tradingSymbol: "NIFTY26O2325100CE", lotSize: 65 }, entryHigh: 110,
  condition: "Only if NIFTY holds above 25,050", wrongIf: "NIFTY closes below 24,950", bearCase: "FII selling continues", why: ["call short covering"], horizon: "TODAY", briefId: "b1",
};

function input(o: Partial<AgentViewInput> = {}): AgentViewInput {
  return {
    date: DAY, nowMs: T + 70_000, settings, enabled: true, paused: false, account,
    instruction: s.instruction({ version: "core-1/1234abcd" }),
    bars: [], batches: [], decisions: [], escalations: [], risk: null, calibration: null,
    payoff: { b: 1, n: 0, measured: null }, trades: [], review: null, reviewCostUsd: null, candidate: null,
    baseGuidance: "- Prefer NEUTRAL.", calls: [], calendar: cal,
    ...o,
  };
}

describe("gateWords", () => {
  it("says in plain words what each check means, with the code's numbers in brackets", () => {
    expect(gateWords({ gate: "confidence", passed: false, detail: "0.72 is not above 0.80" })).toBe("Blocked: The model's confidence is not above 80% (0.72 is not above 0.80)");
    expect(gateWords({ gate: "setup_quality", passed: true, detail: "3 of 3" })).toBe("Passed: The model rated the setup at least 2 out of 3 (3 of 3)");
    expect(gateWords({ gate: "fresh", passed: false, detail: "" })).toBe("Blocked: The decision is too old to act on (more than 4 minutes after the candle closed)");
    expect(gateWords({ gate: "kelly", passed: false, detail: "p=0.48, b=1.00" })).toMatch(/^Blocked: No measured edge yet, so the size is zero \(p=0\.48/);
  });

  it("marks information lines and keeps unknown checks readable", () => {
    expect(gateWords({ gate: "book_imbalance", passed: null, detail: "bid 75 vs ask 1,950" })).toBe("For information: Buyers versus sellers waiting at the best prices (bid 75 vs ask 1,950)");
    expect(gateWords({ gate: "some_new_check", passed: false, detail: "x" })).toBe("Blocked: some new check (x)");
  });
});

describe("snapshotFields", () => {
  it("turns basis points into percents and distances into above or below the close", () => {
    const f = Object.fromEntries(snapshotFields(snap()).map((x) => [x.key, x.value]));
    expect(f.c).toBe("25,012");
    expect(f.r5).toBe("+0.12%");
    expect(f.r15).toBe("−0.08%");
    expect(f.vw).toBe("0.18% above the close");
    expect(f.orh).toBe("0.11% below the close");
    expect(f.ors).toBe("price inside it");
    expect(f.atr).toBe("0.08% of the price");
    expect(f["o.cs"]).toBe("0.89% of the price");
    expect(f["o.bc"]).toBe("3 / 5 / 1 / 2");
    expect(f["o.oa"]).toBe("58 s");
    expect(f.rg).toBe("trend up");
    expect(f.pn).toBe("N1 clear, N2 clear, N4 caution, N7 clear, N9 block");
    expect(f["bk.pos"]).toBe("a call held");
    expect(f["bk.pnl"]).toBe("+4.2%");
    expect(f["bk.dd"]).toBe("1.15%");
    const labels = snapshotFields(snap()).map((x) => x.label);
    expect(labels).toContain("Max pain within the ±15 monitored strikes");
  });

  it("says unknown for missing values and missing for a missing option block", () => {
    const f = Object.fromEntries(snapshotFields(snap({ o: null, vix: null, orh: null, bk: { pos: "-", lots: 0, pnl: null, dd: 0, dl: 0 } })).map((x) => [x.key, x.value]));
    expect(f.o).toBe("missing (no entry without it)");
    expect(f["o.k"]).toBeUndefined();
    expect(f.vix).toBe("unknown");
    expect(f.orh).toBe("unknown");
    expect(f["bk.pnl"]).toBe("flat");
  });
});

describe("emptyAgentView", () => {
  it("is honest and complete before anything ran", () => {
    const v = emptyAgentView(T, settings, false, null);
    expect(v.enabled).toBe(false);
    expect(v.status).toEqual({ state: "OFF", lastBarAt: null, lastError: null, paused: false });
    expect(v.honesty).toBe(AGENT_HONESTY);
    expect(v.honesty).toMatch(/paper/);
    expect(v.date).toBe(DAY);
    expect(v.indices.map((c) => [c.index, c.decisions.length, c.snapshot, c.position])).toEqual([
      ["NIFTY", 0, null, null],
      ["SENSEX", 0, null, null],
    ]);
    expect(v.calibration.graded).toBe(0);
    expect(v.calibration.note).toMatch(/No graded calls yet/);
    expect(v.risk).toMatchObject({ equity: null, maxDrawdownPct: 15, dailyLossCapPct: 3, maxOpenPositions: 2, maxLotsPerPosition: 3, killSwitch: false, drawdownHalt: false, codeRiskState: "SAFE" });
    expect(v.cost).toMatchObject({ spentUsd: 0, capUsd: 3, capReached: false, reflexLatencyMs: { p50: null, p95: null } });
    expect(v.cost.byKind.map((k) => [k.kind, k.calls])).toEqual([
      ["REFLEX", 0],
      ["ESCALATION", 0],
      ["REVIEW", 0],
      ["REPLAY", 0],
    ]);
    expect(v.review).toBeNull();
    expect(v.candidate).toBeNull();
    expect(v.instructionVersion).toBe("built-in");
    expect(v.models).toEqual({ reflex: "reflex-x", escalation: "deep-x", review: "deep-y" });
  });

  it("waits during the session when enabled, and is closed after it", () => {
    expect(emptyAgentView(T, settings, true, account).status.state).toBe("WAITING");
    expect(emptyAgentView(istAt(DAY, "16:30"), settings, true, account).status.state).toBe("CLOSED");
    expect(emptyAgentView(T, { ...settings, mode: "off" }, true, account).status.state).toBe("OFF");
  });
});

describe("withAccountSettings", () => {
  it("overlays the live kill switches without touching the input", () => {
    const v = emptyAgentView(T, settings, true, account);
    const w = withAccountSettings(v, { killSwitch: true, killReason: "main kill switch engaged at 10:40" }, { killSwitch: true });
    expect(w.risk).toMatchObject({ killSwitch: true, killReason: "main kill switch engaged at 10:40", mainKillSwitch: true });
    expect(v.risk.killSwitch).toBe(false);
    const off = withAccountSettings(w, { killSwitch: false, killReason: "stale reason" }, { killSwitch: false });
    expect(off.risk).toMatchObject({ killSwitch: false, killReason: null, mainKillSwitch: false });
  });
});

describe("buildAgentView", () => {
  const fired = s.decision({
    id: "d-n", barCloseMs: T, finalistId: "gen:NIFTY", directionConfidence: 0.86, setupQuality: 3,
    execution: s.execution({
      gate: { fired: true, lines: [{ gate: "confidence", passed: true, detail: "0.86 > 0.80" }, { gate: "book_imbalance", passed: null, detail: "bid 900 vs ask 650" }], codeToxic: [], codeRisk: "SAFE", effectiveRisk: "SAFE" },
      action: "ENTERED", detail: "1 lot", planId: "plan-1", positionId: "pos-1", tradingSymbol: "NIFTY26O2325000CE",
      edge: { passed: false, rows: [{ gate: "move_vs_breakeven", label: "Move this option needs vs the move the index usually makes", passed: false, detail: "needs 0.31%, usually 0.18%" }] },
      sizing: { p: 0.58, b: 1, kelly: 0.16, quarterKelly: 0.04, riskPct: 1, lots: 1, riskRupees: 2_925, limitedBy: "risk budget" },
    }),
  });
  const ideaRow = s.decision({ id: "d-i", barCloseMs: T, finalistId: idea.id, finalistKind: "IDEA", direction: "NEUTRAL", directionConfidence: 0.45, execution: s.execution() });
  const sensex = s.decision({ id: "d-s", barCloseMs: T, index: "SENSEX", finalistId: "gen:SENSEX", direction: "SHORT", outcome: s.outcome({ status: "MISS", y: 0, ret30Pct: 0.02, paid: false }) });
  const superseded: DecisionRecord = { ...fired, id: "d-n-reflex", effective: false, execution: null };
  const batch = s.batch(T, { decisions: [fired, ideaRow, sensex].map((d) => ({ ...d, execution: null })), finalists: [generic("NIFTY"), generic("SENSEX"), idea], briefId: "b1" });
  const calibration: CalibrationSummary = {
    asOfMs: istAt("2026-10-16", "16:25"), graded: 120, brier: 0.247, baselineBrier: 0.248,
    byIndex: [{ index: "NIFTY", n: 70, brier: 0.25 }], byKind: [{ kind: "GENERIC", n: 120, brier: 0.247 }], byVersion: [{ version: "core-1/1234abcd", n: 120, brier: 0.247 }],
    bySource: [{ source: "REFLEX", n: 110, brier: 0.246 }], neutral: { n: 300, brier: 0.2, baselineBrier: 0.21 },
    buckets: [{ from: 0.9, to: 1.0000001, n: 12, statedMean: 0.92, hitRate: 0.5, paidRate: 0.25 }], sizingMode: "pooled", sizingP: 0.47, sizingN: 31.5, paidRate: 0.28,
  };

  const full = () =>
    buildAgentView(
      input({
        bars: [s.bar({ barCloseMs: T, close: 25_012, snapshot: snap(), tokensEst: 290 }), s.bar({ barCloseMs: T, index: "SENSEX", close: 81_900, snapshot: snap({ bk: { pos: "-", lots: 0, pnl: null, dd: 115, dl: 35 } }) })],
        batches: [s.batch(T - 5 * MINUTE_MS), batch],
        decisions: [superseded, fired, ideaRow, sensex],
        escalations: [s.escalation({ id: "e1", status: "DONE", callId: "c-esc", appliedBarMs: T, decision: { finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.86, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "trend and flow agree" } })],
        risk: s.risk({ t: T + 60_000, openPositions: 1, equity: 499_100, peakEquity: 500_000, ddPct: 0.18, dayLossPct: 0.18 }),
        calibration,
        payoff: { b: 1, n: 4, measured: 1.4 },
        trades: [s.trade({ positionId: "old-1", pnlRupees: 800 }), s.trade({ positionId: "old-2", pnlRupees: -1_200 })],
        review: s.review({ date: "2026-10-16", status: "DONE", doneMs: istAt("2026-10-16", "16:31"), model: "deep-y", report: { summary: "Quiet day; two false alarms.", fills: [], misses: ["10:05 move missed"], mistakes: [], lessons: ["wait for flow"], candidate: null } }),
        reviewCostUsd: 0.21,
        candidate: s.candidate({ status: "PENDING", replay: { bars: 70, graded: 64, brierCandidate: 0.24, brierCurrentReplayed: 0.25, brierCurrentLive: 0.26, firesCandidate: 2, firesCurrent: 3, hitRateCandidate: 0.5, hitRateCurrent: 0.33, costUsd: 0.11, complete: true, cursorBarMs: null, label: "in-sample, not proof" } }),
        calls: [
          s.call({ id: "c1", latencyMs: 4_000, costUsd: 0.0008 }),
          s.call({ id: "c2", latencyMs: 9_000, costUsd: 0.0009 }),
          s.call({ id: "c3", latencyMs: 30_000, costUsd: 0.001 }),
          s.call({ id: "c-esc", kind: "ESCALATION", latencyMs: 60_000, costUsd: 0.08 }),
        ],
      }),
    );

  it("shows each index's latest effective decisions with what the code did, in plain words", () => {
    const v = full();
    expect(v.status).toEqual({ state: "WAITING", lastBarAt: istIso(T), lastError: null, paused: false });
    const nifty = v.indices[0];
    expect(nifty.index).toBe("NIFTY");
    expect(nifty.close).toBe(25_012);
    expect(nifty.snapshotTokensEst).toBe(290);
    expect(nifty.snapshot?.find((f) => f.key === "r5")?.value).toBe("+0.12%");
    expect(nifty.decisions.map((d) => d.id)).toEqual(["d-n", "d-i"]);
    const d = nifty.decisions[0];
    expect(d.gate).toEqual({
      fired: true,
      summary: "Every check passed",
      lines: [
        { gate: "confidence", passed: true, words: "Passed: The model's confidence is above 80% (0.86 > 0.80)" },
        { gate: "book_imbalance", passed: null, words: "For information: Buyers versus sellers waiting at the best prices (bid 900 vs ask 650)" },
      ],
    });
    expect(d.action).toBe("ENTERED");
    expect(d.edge).toEqual({ passed: false, detail: "Move this option needs vs the move the index usually makes: needs 0.31%, usually 0.18%" });
    expect(d.sizing).toEqual({ p: 0.58, b: 1, kelly: 0.16, riskPct: 1, lots: 1 });
    expect(d.outcome).toEqual({ status: "PENDING", ret30Pct: null });
    expect(nifty.decisions[1].gate?.summary).toBe("Blocked: The model's confidence is not above 80% (0.72 is not above 0.80)");
    expect(nifty.position).toEqual({ side: "LONG", tradingSymbol: "NIFTY26O2325000CE", lots: 1, pnlPct: 4.2, finalistId: "gen:NIFTY" });
    const sx = v.indices[1];
    expect(sx.decisions.map((x) => [x.id, x.gate, x.outcome.status])).toEqual([["d-s", null, "MISS"]]);
    expect(sx.position).toBeNull();
    expect(v.finalists.map((f) => f.id)).toEqual(["gen:NIFTY", "gen:SENSEX", "idea:b1:i1"]);
    expect(v.finalists[2]).toMatchObject({ side: "LONG", contract: { tradingSymbol: "NIFTY26O2325100CE", strike: 25_100, optionType: "CE", expiry: "2026-10-23" }, bearCase: "FII selling continues" });
  });

  it("shows escalations, risk, calibration, review, candidate and cost", () => {
    const v = full();
    expect(v.escalations).toEqual([
      {
        id: "e1", requestedAt: istIso(s.escalation().requestedMs), index: "NIFTY", finalistId: "gen:NIFTY", trigger: "LOW_CONFIDENCE", status: "DONE",
        decision: { direction: "LONG", directionConfidence: 0.86, setupQuality: 3, regime: "TRENDING", riskState: "SAFE", reason: "trend and flow agree" },
        reason: null, appliedToBarAt: istIso(T), costUsd: 0.08,
      },
    ]);
    expect(v.risk).toMatchObject({ asOf: istIso(T + 60_000), equity: 499_100, drawdownPct: 0.18, openPositions: 1, maxDrawdownPct: 15 });
    expect(v.calibration).toMatchObject({ graded: 120, brier: 0.247, sizingP: 0.47, sizingN: 31.5, payoffB: 1, payoffMeasured: 1.4, payoffTrades: 4, paidRate: 0.28 });
    expect(v.calibration.buckets).toEqual([{ from: 0.9, to: 1, n: 12, statedMean: 0.92, hitRate: 0.5, paidRate: 0.25 }]);
    expect(v.calibration.trades).toEqual({ n: 2, wins: 1, netRupees: -400 });
    expect(v.calibration.note).toMatch(/120 calls graded/);
    expect(v.calibration.note).toMatch(/capped at 1 until 30 agent trades have closed \(4 so far\)/);
    expect(v.review).toMatchObject({ date: "2026-10-16", status: "DONE", costUsd: 0.21, summary: "Quiet day; two false alarms.", misses: ["10:05 move missed"] });
    expect(v.candidate).toMatchObject({ status: "PENDING", currentGuidance: "- Prefer NEUTRAL.", replay: { brierCandidate: 0.24, brierCurrentReplayed: 0.25, brierCurrentLive: 0.26, label: "in-sample, not proof", complete: true } });
    expect(v.cost.spentUsd).toBeCloseTo(0.0827, 9);
    expect(v.cost.byKind.find((k) => k.kind === "REFLEX")).toEqual({ kind: "REFLEX", calls: 3, usd: 0.0027 });
    expect(v.cost.reflexLatencyMs).toEqual({ p50: 9_000, p95: 30_000 });
    expect(v.cost.capReached).toBe(false);
    expect(v.instructionVersion).toBe("core-1/1234abcd");
  });

  it("reports a failed newest batch, a pending bar, the cost cap and a closed session", () => {
    const failed = buildAgentView(input({ batches: [s.batch(T, { status: "FAILED", error: "TIMEOUT: no answer in 20 s" })] }));
    expect(failed.status).toMatchObject({ state: "ERROR", lastError: "TIMEOUT: no answer in 20 s" });
    const pending = buildAgentView(input({ bars: [s.bar({ barCloseMs: T + 5 * MINUTE_MS })], batches: [s.batch(T)] }));
    expect(pending.status).toMatchObject({ state: "RUNNING", lastBarAt: istIso(T + 5 * MINUTE_MS) });
    const capped = buildAgentView(input({ batches: [s.batch(T, { status: "COST_CAP" })], calls: [s.call({ costUsd: 3 })] }));
    expect(capped.status.state).toBe("COST_CAP");
    expect(capped.cost.capReached).toBe(true);
    const evening = buildAgentView(input({ nowMs: istAt(DAY, "18:00"), batches: [s.batch(T)] }));
    expect(evening.status.state).toBe("CLOSED");
    const paused = buildAgentView(input({ paused: true }));
    expect(paused.status.paused).toBe(true);
  });
});
