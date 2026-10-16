import { describe, expect, it } from "vitest";
import type { OptionFlowView } from "../api-types";
import { istAt, istIso, MINUTE_MS } from "../clock";
import type { Quote } from "../types";
import {
  agentExitTriggers,
  codeGate,
  codeRiskState,
  codeToxicity,
  GATE_LABELS,
  gateSummary,
  quoteGateLines,
  quoteImbalance,
  quoteToxicity,
  stricterRisk,
  type GateContext,
} from "./policy";
import { optionBlock } from "./snapshot";
import type { AgentPositionTag, AgentRiskSnapshot, DecisionRecord, Finalist, IndexSnapshot, OptionBlock } from "./types";

const T = istAt("2026-10-19", "10:35");

function snapshot(o: Partial<OptionBlock> | null = {}): IndexSnapshot {
  return {
    c: 25012, r5: 12, r15: -8, r60: 31, ro: 45, vw: 18, vz: 0.9, orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
    rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
    o: o === null ? null : { k: 25000, cm: 112.5, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58, ...o },
    cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
    bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
  };
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d1", date: "2026-10-19", barCloseMs: T, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", callId: "c1", instructionVersion: "core-1/abcd1234",
    effective: true, sizing: null, execution: null, outcome: null,
    finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.85, toxicFlow: false, setupQuality: 3, riskState: "SAFE",
    reason: "r5, r15 and the VWAP side agree",
    ...over,
  };
}

const generic: Finalist = {
  id: "gen:NIFTY", kind: "GENERIC", index: "NIFTY", label: "NIFTY now", side: null, contract: null, entryHigh: null,
  condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
};
const idea: Finalist = {
  ...generic, id: "idea:b1:i1", kind: "IDEA", label: "NIFTY 25100 CE", side: "LONG",
  contract: { expiry: "2026-10-23", strike: 25100, type: "CE", tradingSymbol: "NIFTY26O2325100CE", lotSize: 65 },
  entryHigh: 110, condition: "above VWAP", wrongIf: "below 24950", horizon: "TODAY", briefId: "b1",
};

function risk(over: Partial<AgentRiskSnapshot> = {}): AgentRiskSnapshot {
  return {
    t: T + MINUTE_MS, date: "2026-10-19", equity: 500_000, peakEquity: 500_000, ddPct: 0, dayLossPct: 0, openPositions: 0,
    killSwitch: false, killReason: null, mainKillSwitch: false, ddHalt: false, codeRisk: "SAFE",
    ...over,
  };
}

const ctx = (over: Partial<GateContext> = {}): GateContext => ({ nowMs: T + 90_000, openOnIndex: 0, entriesToday: 0, maxTradesPerDay: 6, ...over });
const line = (v: ReturnType<typeof codeGate>, gate: string) => v.lines.find((l) => l.gate === gate)!;
const gate = (over: Partial<DecisionRecord> = {}, o: { f?: Finalist; s?: IndexSnapshot | null; r?: Partial<AgentRiskSnapshot>; c?: Partial<GateContext> } = {}) =>
  codeGate(decision(over), o.f ?? generic, o.s === undefined ? snapshot() : o.s, risk(o.r), ctx(o.c));

describe("codeGate", () => {
  it("fires when every line passes and records all eleven lines in order", () => {
    const v = gate();
    expect(v.fired).toBe(true);
    expect(v.lines.map((l) => l.gate)).toEqual(Object.keys(GATE_LABELS));
    expect(v.lines.every((l) => l.passed === true)).toBe(true);
    expect(v).toMatchObject({ codeToxic: [], codeRisk: "SAFE", effectiveRisk: "SAFE" });
    expect(gateSummary(v)).toBe("Fired: all 11 checks passed");
    expect(line(v, "setup_quality").detail).toBe("Setup quality 3 of 3 (needs 2)");
  });

  it("needs a confidence strictly above 0.80: 0.80 does not fire, 0.8001 does", () => {
    expect(gate({ directionConfidence: 0.8 }).fired).toBe(false);
    expect(line(gate({ directionConfidence: 0.8 }), "confidence")).toMatchObject({ passed: false, detail: "Confidence 0.8 (needs above 0.80)" });
    expect(gate({ directionConfidence: 0.8001 }).fired).toBe(true);
    expect(gate({ directionConfidence: 1 }).fired).toBe(true);
    for (const bad of [1.0001, Number.NaN, -0.9]) expect(gate({ directionConfidence: bad }).fired).toBe(false);
  });

  it("passes setup quality 2 and blocks 1", () => {
    expect(gate({ setupQuality: 2 }).fired).toBe(true);
    const v = gate({ setupQuality: 1 });
    expect(v.fired).toBe(false);
    expect(line(v, "setup_quality")).toMatchObject({ passed: false, detail: "Setup quality 1 of 3 (needs 2)" });
  });

  it("executes a decision up to four minutes after its close, not later, and never before it", () => {
    expect(gate({}, { c: { nowMs: T + 4 * MINUTE_MS } }).fired).toBe(true);
    const old = gate({}, { c: { nowMs: T + 4 * MINUTE_MS + 1 } });
    expect(old.fired).toBe(false);
    expect(line(old, "fresh").detail).toMatch(/^Too old: 4 min after the candle closed \(limit 4 min\)$/);
    expect(gate({}, { c: { nowMs: T - 1 } }).fired).toBe(false);
  });

  it("needs an OK batch and the decision in force for this finalist", () => {
    expect(line(gate({}, { c: { batchStatus: "FAILED" } }), "batch_ok")).toMatchObject({ passed: false, detail: "The reflex call for this candle did not succeed (FAILED)" });
    expect(line(gate({ effective: false }), "batch_ok").passed).toBe(false);
    expect(line(gate({ finalistId: "gen:SENSEX" }), "batch_ok").passed).toBe(false);
    expect(line(gate({ source: "ESCALATION" }), "batch_ok")).toMatchObject({ passed: true, detail: "The escalation's answer is in force for this candle" });
  });

  it("blocks NEUTRAL, CRISIS and the model's toxic-flow flag", () => {
    expect(line(gate({ direction: "NEUTRAL" }), "direction")).toMatchObject({ passed: false, detail: "Direction NEUTRAL: no trade" });
    expect(gate({ direction: "SHORT" }).fired).toBe(true);
    expect(line(gate({ regime: "CRISIS" }), "regime")).toMatchObject({ passed: false, detail: "Regime CRISIS: no new trades" });
    expect(gate({ regime: "HIGH_VOL" }).fired).toBe(true);
    expect(line(gate({ toxicFlow: true }), "toxic_model").passed).toBe(false);
  });

  it("buys an idea only on its own side", () => {
    expect(gate({ finalistId: idea.id, finalistKind: "IDEA" }, { f: idea }).fired).toBe(true);
    const against = gate({ finalistId: idea.id, finalistKind: "IDEA", direction: "SHORT" }, { f: idea });
    expect(line(against, "idea_side")).toMatchObject({ passed: false, detail: "The idea is LONG but the call is SHORT" });
    // An idea buys its own contract: the call's spread is checked even on a SHORT call.
    expect(against.codeToxic).toEqual([]);
  });

  it("checks the code's own toxicity on the snapshot: option data, age 180 s and spread 1.5%", () => {
    expect(line(gate({}, { s: null }), "toxic_code").passed).toBe(false);
    expect(gate({}, { s: snapshot(null) }).codeToxic).toEqual(["NO_OPTION_DATA"]);
    expect(gate({}, { s: snapshot({ oa: 180 }) }).fired).toBe(true);
    const stale = gate({}, { s: snapshot({ oa: 181 }) });
    expect(stale.codeToxic).toEqual(["STALE_OPTIONS"]);
    expect(line(stale, "toxic_code").detail).toBe("Option data not usable: option data 181 s old at the close (limit 180 s)");
    expect(gate({}, { s: snapshot({ cs: 1.5 }) }).fired).toBe(true);
    const wide = gate({}, { s: snapshot({ cs: 1.51 }) });
    expect(wide.codeToxic).toEqual(["WIDE_SPREAD"]);
    expect(line(wide, "toxic_code").detail).toBe("Option data not usable: call spread 1.51% (limit 1.5%)");
    // A LONG buys the call: a wide put does not matter, and the other way round.
    expect(gate({}, { s: snapshot({ ps: 4 }) }).fired).toBe(true);
    expect(gate({ direction: "SHORT" }, { s: snapshot({ ps: 4 }) }).codeToxic).toEqual(["WIDE_SPREAD"]);
    expect(gate({}, { s: snapshot({ cs: null }) }).codeToxic).toEqual(["WIDE_SPREAD"]);
  });

  it("needs the stricter of the model's and the code's risk to be SAFE", () => {
    const model = gate({ riskState: "NEAR_LIMIT" });
    expect(model).toMatchObject({ fired: false, codeRisk: "SAFE", effectiveRisk: "NEAR_LIMIT" });
    const code = gate({}, { c: { openOnIndex: 1 } });
    expect(code).toMatchObject({ fired: false, codeRisk: "NEAR_LIMIT", effectiveRisk: "NEAR_LIMIT" });
    expect(line(code, "risk_state").detail).toBe("Risk NEAR_LIMIT (model SAFE, code NEAR_LIMIT: a position is already open on this index)");
    expect(gate({}, { r: { ddPct: 13.5 } })).toMatchObject({ fired: false, effectiveRisk: "REDUCE" });
  });

  it("blocks entries while main is degraded, after the drawdown halt and under either kill switch", () => {
    const off = (v: ReturnType<typeof codeGate>) => [v.fired, line(v, "entry_mode").passed];
    expect(off(gate({}, { c: { noEntries: "main degraded" } }))).toEqual([false, false]);
    expect(off(gate({}, { r: { ddHalt: true } }))).toEqual([false, false]);
    expect(off(gate({}, { r: { killSwitch: true, killReason: "operator" } }))).toEqual([false, false]);
    expect(off(gate({}, { r: { mainKillSwitch: true } }))).toEqual([false, false]);
    expect(line(gate({}, { r: { ddHalt: true } }), "entry_mode").detail).toBe("Entries off: drawdown halt (15%): re-arm on the Agent page");
  });

  it("summarises a blocked decision by its failing lines", () => {
    const v = gate({ setupQuality: 1, directionConfidence: 0.62 });
    expect(gateSummary(v)).toBe("Blocked: Setup quality 1 of 3 (needs 2); Confidence 0.62 (needs above 0.80)");
    const many = gate({ setupQuality: 0, directionConfidence: 0.3, direction: "NEUTRAL", regime: "CRISIS", toxicFlow: true });
    expect(gateSummary(many)).toMatch(/^Blocked: .*\(and 2 more\)$/);
  });
});

describe("codeRiskState", () => {
  const state = (over: Partial<AgentRiskSnapshot>, onIndex = 0, entries = 0) => codeRiskState(risk(over), onIndex, entries, 6);

  it("reduces from a 13.5% drawdown or a loss of 0.8 × the 3% cap (2.4% of equity)", () => {
    expect(state({ ddPct: 13.5 })).toBe("REDUCE");
    expect(state({ ddPct: 13.49 })).toBe("NEAR_LIMIT");
    expect(state({ dayLossPct: 2.4 })).toBe("REDUCE");
    expect(state({ dayLossPct: 2.39 })).toBe("NEAR_LIMIT");
  });

  it("is near the limit from a 10% drawdown, 1.5% lost today, two positions, one on the index or one entry short of the day's six", () => {
    expect(state({ ddPct: 10 })).toBe("NEAR_LIMIT");
    expect(state({ ddPct: 9.99 })).toBe("SAFE");
    expect(state({ dayLossPct: 1.5 })).toBe("NEAR_LIMIT");
    expect(state({ dayLossPct: 1.49 })).toBe("SAFE");
    expect(state({ openPositions: 2 })).toBe("NEAR_LIMIT");
    expect(state({ openPositions: 1 })).toBe("SAFE");
    expect(state({}, 1)).toBe("NEAR_LIMIT");
    expect(state({}, 0, 5)).toBe("NEAR_LIMIT");
    expect(state({}, 0, 4)).toBe("SAFE");
  });

  it("fails closed on numbers it cannot read", () => {
    expect(state({ ddPct: Number.NaN })).toBe("REDUCE");
    expect(codeRiskState(risk(), 0, 0, Number.NaN)).toBe("NEAR_LIMIT");
  });
});

describe("stricterRisk", () => {
  it("orders SAFE < NEAR_LIMIT < REDUCE", () => {
    expect(stricterRisk("SAFE", "SAFE")).toBe("SAFE");
    expect(stricterRisk("SAFE", "NEAR_LIMIT")).toBe("NEAR_LIMIT");
    expect(stricterRisk("NEAR_LIMIT", "SAFE")).toBe("NEAR_LIMIT");
    expect(stricterRisk("REDUCE", "NEAR_LIMIT")).toBe("REDUCE");
    expect(stricterRisk("SAFE", "REDUCE")).toBe("REDUCE");
  });
});

describe("codeToxicity", () => {
  it("checks both options when there is no side to buy", () => {
    expect(codeToxicity(snapshot({ cs: 0.89, ps: 1.02 }), null)).toEqual([]);
    expect(codeToxicity(snapshot({ cs: 0.89, ps: 1.6 }), null)).toEqual(["WIDE_SPREAD"]);
    expect(codeToxicity(snapshot({ oa: 400, cs: 3 }), "LONG")).toEqual(["STALE_OPTIONS", "WIDE_SPREAD"]);
    expect(codeToxicity(null, "SHORT")).toEqual(["NO_OPTION_DATA"]);
  });

  it("reads the spreads in the unit snapshot.ts writes them (percent of the mid)", () => {
    // ATM call 100 / 101 (about 1.0% of the mid) and put 100 / 103 (about 3.0%).
    const side = (bid: number, ask: number) => ({ oi: 100_000, ltp: bid, bid, ask, iv: 13, delta: 0.5, oiChg: 0, oiChgPct: 0, vol: 0, volMultiple: null, ltpChgPct: 0, ivChg: 0, buildup: "NEUTRAL" as const });
    const flow = {
      index: "NIFTY", source: "feed", asOf: istIso(T - 58_000), expiry: "2026-10-20", lotSize: 65, spot: 25012, atm: 25000, step: 50, minutes: 80, note: null,
      windows: { "1m": { minutes: 1, from: null, rows: [{ strike: 25000, ce: side(100, 101), pe: side(100, 103) }] }, "5m": { minutes: 5, from: null, rows: [] } },
      events: [], summary: { pcr: 0.9 }, honestSummary: [], statsGeneratedAt: null,
    } as unknown as OptionFlowView;
    const o = optionBlock(flow, 25012, 13.4, T);
    expect(o).not.toBeNull();
    expect(o).toMatchObject({ cs: 1, ps: 2.96 });
    const s = { ...snapshot(), o };
    expect(codeToxicity(s, "LONG")).toEqual([]);
    expect(codeToxicity(s, "SHORT")).toEqual(["WIDE_SPREAD"]);
  });
});

function quote(over: Partial<Quote> = {}): Quote {
  return { symbol: "NIFTY26O2025000CE", t: T + 60_000, ltp: 112, bid: 111.9, ask: 112.1, bidQty: 650, askQty: 975, source: "upstox", ...over };
}

describe("quoteToxicity", () => {
  it("blocks a synthetic quote unless the test allows it, and an empty book", () => {
    expect(quoteToxicity(quote())).toEqual([]);
    expect(quoteToxicity(quote({ source: "synthetic" }))).toEqual(["SYNTHETIC_QUOTE"]);
    expect(quoteToxicity(quote({ source: "synthetic" }), { acceptSyntheticQuotes: true })).toEqual([]);
    expect(quoteToxicity(quote({ bidQty: 0, askQty: 0 }))).toEqual(["NO_DEPTH"]);
    expect(quoteToxicity(null)).toEqual(["NO_QUOTE"]);
  });

  it("never blocks on a one-sided book (#27): it is recorded with passed null", () => {
    const lopsided = quote({ bidQty: 75, askQty: 1_950 });
    expect(quoteImbalance(lopsided)).toBeCloseTo(0.9259, 4);
    expect(quoteToxicity(lopsided)).toEqual([]);
    const [toxic, info] = quoteGateLines(lopsided);
    expect(toxic).toMatchObject({ gate: "quote_toxic", passed: true });
    expect(info).toMatchObject({ gate: "one_sided_book", passed: null });
    expect(info.detail).toMatch(/^Information only: one-sided book 0\.93 \(75 bid vs 1950 offered, top of book;/);
    const [, balanced] = quoteGateLines(quote());
    expect(balanced.detail).toMatch(/^Information only: book balance 0\.2 /);
  });

  it("sums the depth levels when the quote has them", () => {
    const deep = quote({ bidQty: 75, askQty: 1_950, depth: { buy: [{ price: 111.9, qty: 75 }, { price: 111.8, qty: 1_500 }], sell: [{ price: 112.1, qty: 1_950 }] } });
    expect(quoteImbalance(deep)).toBeCloseTo(375 / 3_525, 9);
    expect(quoteGateLines(deep)[1].detail).toMatch(/summed depth/);
    expect(quoteToxicity(quote({ bidQty: 0, askQty: 0, depth: { buy: [{ price: 111.9, qty: 65 }], sell: [] } }))).toEqual([]);
  });
});

describe("agentExitTriggers", () => {
  const tag: AgentPositionTag = { finalistId: "gen:NIFTY", decisionId: "d0", index: "NIFTY", side: "LONG" };

  it("exits on a CRISIS call on the index first, then REDUCE, then a confident opposite call", () => {
    const rows = [
      decision({ id: "own", riskState: "REDUCE" }),
      decision({ id: "idea", finalistId: idea.id, finalistKind: "IDEA", direction: "SHORT", directionConfidence: 0.9 }),
      decision({ id: "crisis", finalistId: "idea:b1:i2", regime: "CRISIS" }),
    ];
    expect(agentExitTriggers(tag, rows, "SAFE")).toMatchObject({ reason: "AGENT_CRISIS", decisionId: "crisis" });
    expect(agentExitTriggers(tag, rows.slice(0, 2), "SAFE")).toMatchObject({ reason: "AGENT_REDUCE", decisionId: "own" });
    expect(agentExitTriggers(tag, [decision({ id: "own" }), rows[1]], "SAFE")).toMatchObject({ reason: "AGENT_OPPOSITE", decisionId: "idea" });
    expect(agentExitTriggers(tag, [decision({ id: "own" })], "SAFE")).toBeNull();
  });

  it("reduces on the code's own REDUCE even without the position's finalist", () => {
    expect(agentExitTriggers(tag, [], "REDUCE")).toMatchObject({ reason: "AGENT_REDUCE", decisionId: null });
    expect(agentExitTriggers(tag, [decision({ id: "own", riskState: "NEAR_LIMIT" })], "NEAR_LIMIT")).toBeNull();
  });

  it("needs an opposite call above 0.80 on the same index", () => {
    const short = (c: number, index: "NIFTY" | "SENSEX" = "NIFTY") => decision({ id: `s${c}`, finalistId: `gen:${index}`, index, direction: "SHORT", directionConfidence: c });
    expect(agentExitTriggers(tag, [short(0.8)], "SAFE")).toBeNull();
    expect(agentExitTriggers(tag, [short(0.8001)], "SAFE")).toMatchObject({ reason: "AGENT_OPPOSITE" });
    expect(agentExitTriggers(tag, [short(0.95, "SENSEX")], "SAFE")).toBeNull();
    expect(agentExitTriggers(tag, [decision({ id: "long", directionConfidence: 0.99 })], "SAFE")).toBeNull();
    // A put position exits on a confident LONG.
    expect(agentExitTriggers({ ...tag, side: "SHORT" }, [decision({ id: "long", directionConfidence: 0.81 })], "SAFE")).toMatchObject({ reason: "AGENT_OPPOSITE" });
  });

  it("still exits on the index's other decisions when the position's finalist is gone", () => {
    const gone: AgentPositionTag = { ...tag, finalistId: "idea:old:i9" };
    expect(agentExitTriggers(gone, [decision({ id: "crisis", regime: "CRISIS" })], "SAFE")).toMatchObject({ reason: "AGENT_CRISIS" });
    expect(agentExitTriggers(gone, [decision({ id: "own", riskState: "REDUCE" })], "SAFE")).toBeNull();
  });
});
