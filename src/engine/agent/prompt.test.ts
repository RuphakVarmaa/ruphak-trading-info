import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import { fnv1aHex } from "../util/hash";
import { AGENT_DEFAULTS } from "./config";
import { USER_MESSAGE_TOKEN_LIMIT } from "./constants";
import { MODEL_PRICES } from "./cost";
import {
  BUILTIN_GUIDANCE,
  ESCALATION_SYSTEM,
  GUIDANCE_MARKER,
  OPTION_LEGEND,
  PROMPT_TEXT,
  REFLEX_CORE,
  REFLEX_CORE_VERSION,
  REVIEW_SYSTEM,
  SNAPSHOT_LEGEND,
  barTime,
  escalationUser,
  estimateReflexUserTokens,
  instructionVersion,
  promptFinalist,
  promptFinalists,
  reflexSystem,
  reflexUser,
  reviewUser,
} from "./prompt";
import { encodeSnapshot } from "./snapshot";
import type { AgentTradeRecord, CalibrationSummary, CallRecord, DecisionRecord, Finalist, IndexSnapshot, ReflexInput, StoredBar } from "./types";

const T = istAt("2026-10-19", "10:35");

const typical: IndexSnapshot = {
  c: 25012, r5: 12, r15: -8, r60: 31, ro: 45, vw: -18, vz: 0.9,
  orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
  rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 8, vix: 13.4, vixc: -2.1,
  o: { k: 25000, cm: 112.5, cs: 89, pm: 98.1, ps: 102, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
  bk: { pos: "-", lots: 0, pnl: null, dd: 115, dl: 35 },
};

/** Every number at its widest. */
const widest: IndexSnapshot = {
  c: 199_999, r5: -999, r15: -999, r60: -999, ro: -999, vw: -999, vz: -9.9,
  orh: -999, orl: -999, ors: "D", pdh: -999, pdl: -999, pdc: -999,
  rsi: 100, adx: 100, di: -100, st: -1, rv: 999, atr: 999, vix: 99.9, vixc: -99.9,
  o: { k: 199_900, cm: 9999.9, cs: 999, pm: 9999.9, ps: 999, iv: 999, ivx: -99.9, pcr: 9.99, mp: -999, cw: -999, pw: -999, bc: [11, 11, 11, 11], bp: [11, 11, 11, 11], oa: 999 },
  cv: -0.99, rg: "EV", pv: "X", pn: "uuuuu", ew: 0, dte: 99, xd: 1,
  bk: { pos: "S", lots: 9, pnl: 999.9, dd: 9999, dl: 999 },
};

const input = (snapshots: ReflexInput["snapshots"] = { NIFTY: typical, SENSEX: { ...typical, c: 82010 } }): ReflexInput => ({
  barCloseMs: T,
  date: "2026-10-19",
  builtMs: T + 40_000,
  snapshots,
  tokensEst: {},
  closes: { NIFTY: 25012, SENSEX: 82010 },
  problems: [],
});

const generic = (index: "NIFTY" | "SENSEX"): Finalist => ({
  id: `gen:${index}`,
  kind: "GENERIC",
  index,
  label: `${index}: best long or short now`,
  side: null,
  contract: null,
  entryHigh: null,
  condition: null,
  wrongIf: null,
  bearCase: null,
  why: [],
  horizon: null,
  briefId: null,
});
const idea = (n: number, p: Partial<Finalist> = {}): Finalist => ({
  ...generic("NIFTY"),
  id: `idea:adv-2026-10-19-1:adv-2026-10-19-1-${n}`,
  kind: "IDEA",
  label: "NIFTY 25100 CE",
  side: "LONG",
  contract: { expiry: "2026-10-23", strike: 25100, type: "CE", tradingSymbol: "NIFTY26O2325100CE", lotSize: 65 },
  entryHigh: 110.5,
  condition: "Only if NIFTY holds above 25,050.",
  wrongIf: "NIFTY closes a candle below 24,980.",
  bearCase: "Call writers are adding at 25,100.",
  why: ["Covering above 25,000.", "Flows turned positive."],
  horizon: "WEEK",
  briefId: "adv-2026-10-19-1",
  ...p,
});
const brief = { headline: "Wait for a clean break; premiums are fair.", factors: ["FII flows: SUPPORTS_DOWN — FIIs sold ₹1,200 crore.", "Trend: SUPPORTS_UP — above VWAP."] };

describe("the reflex system prompt", () => {
  it("has the guidance marker exactly once, and reflexSystem puts the guidance in its place", () => {
    expect(REFLEX_CORE.split(GUIDANCE_MARKER)).toHaveLength(2);
    const sys = reflexSystem(BUILTIN_GUIDANCE);
    expect(sys).not.toContain(GUIDANCE_MARKER);
    expect(sys.endsWith(`\n${BUILTIN_GUIDANCE}`)).toBe(true);
    expect(sys.length).toBe(REFLEX_CORE.length - GUIDANCE_MARKER.length + BUILTIN_GUIDANCE.length);
  });

  it("takes the guidance literally, whatever characters it holds", () => {
    const odd = "- Use $& and $' and $1 as they are.";
    expect(reflexSystem(odd)).toContain(odd);
  });

  it("is long enough to be cached (512 tokens at the most generous 4 characters a token)", () => {
    expect(reflexSystem(BUILTIN_GUIDANCE).length).toBeGreaterThan(512 * 4);
  });

  it("names the core and the guidance in its version, stable and changing with the text", () => {
    const v = instructionVersion(BUILTIN_GUIDANCE);
    expect(v).toMatch(new RegExp(`^${REFLEX_CORE_VERSION}/[0-9a-f]{8}$`));
    expect(instructionVersion(BUILTIN_GUIDANCE)).toBe(v);
    expect(instructionVersion(`${BUILTIN_GUIDANCE}\n- One more rule.`)).not.toBe(v);
    expect(v).toBe(`${REFLEX_CORE_VERSION}/${fnv1aHex(BUILTIN_GUIDANCE)}`);
  });

  it("keeps the core fixed: a change to it needs a new REFLEX_CORE_VERSION and a new pin here", () => {
    // Calibration tells prompt texts apart by instructionVersion, which hashes only the guidance.
    expect(REFLEX_CORE_VERSION).toBe("core-1");
    expect(fnv1aHex(REFLEX_CORE)).toBe("dbdfe294");
  });

  it("asks for calibrated confidence the way the nightly scoring labels it (#23)", () => {
    expect(REFLEX_CORE).toContain("give 0.45 when you do not know (the move must exceed 0.03%)");
    expect(REFLEX_CORE).toContain("at least 0.03%");
    expect(REFLEX_CORE).toContain("within 0.15% either");
    expect(REFLEX_CORE).toContain("NEUTRAL on its own line");
    expect(REFLEX_CORE).toContain("everything is closed by 15:05 IST");
    expect(REFLEX_CORE).toContain("found no rule that beat those costs");
  });

  it("explains every key encodeSnapshot writes, in its order, in basis points where it uses them", () => {
    const wire = JSON.parse(encodeSnapshot(typical)) as Record<string, unknown>;
    expect(SNAPSHOT_LEGEND.flatMap((e) => e.keys)).toEqual(Object.keys(wire));
    expect(OPTION_LEGEND.flatMap((e) => e.keys)).toEqual(Object.keys(wire.o as Record<string, unknown>));
    expect(Object.keys(JSON.parse(encodeSnapshot({ ...typical, o: null })) as object)).toEqual(Object.keys(wire));
    for (const e of [...SNAPSHOT_LEGEND, ...OPTION_LEGEND]) expect(REFLEX_CORE).toContain(`- ${e.keys.join(" ")}: ${e.text}`);
    expect(REFLEX_CORE).toContain("bps are basis points (100 bps = 1%)");
    expect(REFLEX_CORE).toContain("max pain within the ±15 monitored strikes");
    // Fields the amended snapshot dropped are not described.
    for (const gone of ["cd", "th"]) expect(SNAPSHOT_LEGEND.some((e) => e.keys.includes(gone))).toBe(false);
  });

  it("keeps the built-in guidance to keys the snapshot has", () => {
    const keys = new Set([...SNAPSHOT_LEGEND, ...OPTION_LEGEND].flatMap((e) => e.keys));
    for (const k of ["r5", "r15", "di", "vz", "ivx", "oa", "pn"]) expect(keys.has(k)).toBe(true);
    expect(BUILTIN_GUIDANCE).not.toMatch(/\bpv\b|\bew\b|\bors\b/);
  });

  it("names no model in any prompt", () => {
    const ids = [...Object.keys(MODEL_PRICES), AGENT_DEFAULTS.reflexModel, AGENT_DEFAULTS.escalationModel, AGENT_DEFAULTS.reviewModel];
    for (const text of [REFLEX_CORE, BUILTIN_GUIDANCE, ESCALATION_SYSTEM, REVIEW_SYSTEM]) {
      for (const id of ids) expect(text).not.toContain(id);
      expect(text).not.toMatch(/\b(claude|haiku|opus|sonnet|fable|mythos)\b/i);
      expect(text).not.toMatch(/guarantee|sure profit|risk-free/i);
    }
  });
});

describe("the reflex user message", () => {
  it("is JSON with the bar time, the date, each snapshot as encodeSnapshot writes it, the finalists and the brief", () => {
    const text = reflexUser(input(), [generic("NIFTY"), generic("SENSEX"), idea(1)], brief);
    const msg = JSON.parse(text) as { bar: string; date: string; indices: Record<string, unknown>; finalists: Record<string, unknown>[]; brief: unknown };
    expect(msg.bar).toBe("10:35");
    expect(msg.date).toBe("2026-10-19");
    expect(Object.keys(msg.indices)).toEqual(["NIFTY", "SENSEX"]);
    expect(text).toContain(`"NIFTY":${encodeSnapshot(typical)}`);
    expect(msg.finalists[0]).toEqual({ id: "gen:NIFTY", kind: "GENERIC", index: "NIFTY" });
    expect(msg.finalists[2]).toEqual({
      id: "idea:adv-2026-10-19-1:adv-2026-10-19-1-1",
      kind: "IDEA",
      index: "NIFTY",
      side: "LONG",
      contract: "NIFTY 25100 CE 23 Oct",
      buyZoneTop: 110.5,
      condition: "Only if NIFTY holds above 25,050.",
      wrongIf: "NIFTY closes a candle below 24,980.",
      bearCase: "Call writers are adding at 25,100.",
      why: ["Covering above 25,000.", "Flows turned positive."],
    });
    expect(msg.brief).toEqual(brief);
    expect(JSON.parse(reflexUser(input(), [generic("NIFTY")], null)).brief).toBeNull();
  });

  it("leaves out an index without a snapshot, and its finalists", () => {
    const only = input({ NIFTY: typical });
    const text = reflexUser(only, [generic("NIFTY"), generic("SENSEX"), idea(1, { index: "SENSEX" })], null);
    const msg = JSON.parse(text) as { indices: Record<string, unknown>; finalists: { id: string }[] };
    expect(Object.keys(msg.indices)).toEqual(["NIFTY"]);
    expect(msg.finalists.map((f) => f.id)).toEqual(["gen:NIFTY"]);
    expect(promptFinalists(only, [generic("SENSEX")])).toEqual([]);
  });

  it("asks about each finalist once, in the order given", () => {
    const list = promptFinalists(input(), [generic("SENSEX"), generic("NIFTY"), generic("SENSEX")]);
    expect(list.map((f) => f.id)).toEqual(["gen:SENSEX", "gen:NIFTY"]);
  });

  it("clips the brief's prose to its limits and cleans it", () => {
    const long = idea(1, { condition: `Only if\nNIFTY ${"x".repeat(500)}`, wrongIf: "w".repeat(500), bearCase: "b".repeat(500), why: ["a".repeat(500), "b", "c"] });
    const f = promptFinalist(long);
    expect((f.condition as string).startsWith("Only if NIFTY x")).toBe(true);
    expect(f.condition).toHaveLength(PROMPT_TEXT.condition);
    expect(f.wrongIf).toHaveLength(PROMPT_TEXT.wrongIf);
    expect(f.bearCase).toHaveLength(PROMPT_TEXT.bearCase);
    expect(f.why).toEqual(["a".repeat(PROMPT_TEXT.why), "b"]);
    expect(promptFinalist(idea(2, { condition: null, bearCase: "   " }))).toMatchObject({ condition: null, bearCase: null });
    const b = JSON.parse(reflexUser(input(), [generic("NIFTY")], { headline: "h".repeat(400), factors: ["f".repeat(300), "2", "3", "4", "5"] })).brief;
    expect(b.headline).toHaveLength(PROMPT_TEXT.headline);
    expect(b.factors).toEqual(["f".repeat(PROMPT_TEXT.factor), "2", "3", "4"]);
  });

  it("stays under USER_MESSAGE_TOKEN_LIMIT at its worst: two widest snapshots, six finalists and the brief at their longest", () => {
    const longText = "Only if NIFTY closes above 25,250 on a 5-minute candle and the call writers at 25,300 start covering. ".repeat(6);
    const ideas = [1, 2, 3, 4].map((n) => idea(n, { id: `idea:adv-2026-10-19-1:adv-2026-10-19-1-${n}`, entryHigh: 12345.65, condition: longText, wrongIf: longText, bearCase: longText, why: [longText, longText, longText] }));
    const worst = input({ NIFTY: widest, SENSEX: widest });
    const finalists = [generic("NIFTY"), generic("SENSEX"), ...ideas];
    const bigBrief = { headline: longText, factors: [longText, longText, longText, longText, longText] };
    const est = estimateReflexUserTokens(worst, finalists, bigBrief);
    expect(est).toBeLessThan(USER_MESSAGE_TOKEN_LIMIT);
    // The estimate is never below the whole message at the prose rate, nor below its two snapshots at the numeric rate.
    const text = reflexUser(worst, finalists, bigBrief);
    expect(est).toBeGreaterThanOrEqual(Math.ceil(text.length / 3));
    expect(est).toBeGreaterThan((2 * encodeSnapshot(widest).length) / 1.2);
  });
});

describe("the escalation messages", () => {
  const reflex: DecisionRecord = {
    finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.55, toxicFlow: false, setupQuality: 2, riskState: "SAFE", reason: "Up, but the flow is mixed.",
    id: "d1", date: "2026-10-19", barCloseMs: T, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", callId: "c1", instructionVersion: instructionVersion(BUILTIN_GUIDANCE),
    effective: true, sizing: null, execution: null, outcome: null,
  };
  const bar = (index: "NIFTY" | "SENSEX", hhmm: string, snapshot: IndexSnapshot | null): StoredBar => ({ barCloseMs: istAt("2026-10-19", hhmm), date: "2026-10-19", index, close: 25000, snapshot, tokensEst: null, builtMs: 0 });

  it("keeps the deep model's instructions fixed and quotes the reflex's rules and legend", () => {
    expect(ESCALATION_SYSTEM).not.toContain(GUIDANCE_MARKER);
    expect(ESCALATION_SYSTEM).toContain("LOW_CONFIDENCE (its confidence was below 0.60 on a setup of 2 or more)");
    expect(ESCALATION_SYSTEM).toContain(`- ${OPTION_LEGEND[0].keys[0]}: ${OPTION_LEGEND[0].text}`);
    expect(ESCALATION_SYSTEM).toContain("give 0.45 when you do not know");
    expect(ESCALATION_SYSTEM).toContain("The judgement guidance in force is in the user message.");
    expect(ESCALATION_SYSTEM).not.toContain("You are the reflex");
  });

  it("gives the trigger, the finalist, the reflex's judgement, both snapshots, the index's last six candles and the guidance", () => {
    const history = [
      ...["10:00", "10:05", "10:10", "10:15", "10:20", "10:25"].map((h) => bar("NIFTY", h, typical)),
      bar("NIFTY", "10:30", null),
      bar("NIFTY", "10:35", typical),
      bar("SENSEX", "10:30", typical),
    ];
    const text = escalationUser({ finalist: generic("NIFTY"), reflex, trigger: "LOW_CONFIDENCE", snapshots: { NIFTY: typical, SENSEX: widest }, history, guidance: "- Custom guidance." });
    expect(text).toContain("Trigger: LOW_CONFIDENCE (the reflex's confidence was below 0.60 on a setup of 2 or more).");
    expect(text).toContain("The candle closed at 10:35 IST on 2026-10-19.");
    expect(text).toContain('Finalist: {"id":"gen:NIFTY","kind":"GENERIC","index":"NIFTY"}');
    expect(text).toContain('"directionConfidence":0.55');
    expect(text).toContain(`Snapshots at this candle: {"NIFTY":${encodeSnapshot(typical)},"SENSEX":${encodeSnapshot(widest)}}`);
    const past = /The previous (\d+) candles of NIFTY, oldest first: (\[.*\])/.exec(text);
    expect(past?.[1]).toBe("6");
    const rows = JSON.parse(past![2]) as { bar: string; snapshot: unknown; close?: number }[];
    expect(rows.map((r) => r.bar)).toEqual(["10:05", "10:10", "10:15", "10:20", "10:25", "10:30"]);
    expect(rows[5]).toEqual({ bar: "10:30", close: 25000, snapshot: null });
    expect(text).toContain("Judgement guidance in force:\n- Custom guidance.");
    expect(escalationUser({ finalist: generic("NIFTY"), reflex, trigger: "CRISIS_FLIP", snapshots: { NIFTY: typical }, history: [], guidance: "" })).toContain("CRISIS_FLIP (the reflex called the regime CRISIS");
  });
});

describe("the nightly review messages", () => {
  const base: DecisionRecord = {
    finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.86, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "Clean trend.",
    id: "d1", date: "2026-10-19", barCloseMs: T, index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", callId: "c1", instructionVersion: "core-1/abc",
    effective: true, sizing: null,
    execution: {
      t: T + 70_000, action: "NO_ENTRY", detail: "", planId: null, positionId: null, tradingSymbol: null, edge: null, sizing: null,
      gate: { fired: false, codeToxic: [], codeRisk: "SAFE", effectiveRisk: "SAFE", lines: [{ gate: "fresh", passed: true, detail: "ok" }, { gate: "toxic_code", passed: false, detail: "WIDE_SPREAD | put side" }] },
    },
    outcome: { status: "HIT", y: 1, ret30Pct: 0.21, paid: true, source: "BARS_5M", gradedMs: 0 },
  };
  const calibration: CalibrationSummary = {
    asOfMs: 0, graded: 42, brier: 0.2512, baselineBrier: 0.2476,
    byIndex: [{ index: "NIFTY", n: 21, brier: 0.24 }, { index: "SENSEX", n: 21, brier: 0.262 }],
    byKind: [{ kind: "GENERIC", n: 40, brier: 0.25 }],
    byVersion: [{ version: "core-1/abc", n: 42, brier: 0.2512 }],
    bySource: [{ source: "REFLEX", n: 40, brier: 0.25 }, { source: "ESCALATION", n: 2, brier: 0.3 }],
    neutral: { n: 300, brier: 0.2, baselineBrier: 0.21 },
    buckets: [{ from: 0.8, to: 0.9, n: 5, statedMean: 0.84, hitRate: 0.4, paidRate: 0.2 }],
    sizingMode: "pooled", sizingP: 0.47, sizingN: 12.25, paidRate: 0.31,
  };
  const trade: AgentTradeRecord = { positionId: "p1", date: "2026-10-19", index: "NIFTY", side: "BULL", finalistId: "gen:NIFTY", decisionId: "d1", tradingSymbol: "NIFTY26O2325000CE", entryMs: T + 70_000, exitMs: istAt("2026-10-19", "11:12"), lots: 2, pnlRupees: -1234.4, pnlPctPremium: -12.34, exitReason: "STOP", agentExit: null };
  const call = (kind: CallRecord["kind"], status: CallRecord["status"], costUsd: number): CallRecord => ({ id: `${kind}${costUsd}`, date: "2026-10-19", kind, barCloseMs: T, model: AGENT_DEFAULTS.reflexModel, instructionVersion: null, startedMs: T, latencyMs: 900, status, error: null, usage: null, costUsd });

  it("keeps the review's instructions fixed: rules, no profit promises, and the reflex's legend for reference", () => {
    expect(REVIEW_SYSTEM).not.toContain(GUIDANCE_MARKER);
    expect(REVIEW_SYSTEM).toContain("at most 2,500 characters");
    expect(REVIEW_SYSTEM).toContain("never promise profit");
    expect(REVIEW_SYSTEM).toContain("you may not change thresholds, sizes, limits");
    expect(REVIEW_SYSTEM).toContain(`- ${SNAPSHOT_LEGEND[0].keys[0]}: ${SNAPSHOT_LEGEND[0].text}`);
  });

  it("lays out the session: guidance, calibration, calls, trades, decision rows and closes", () => {
    const superseded: DecisionRecord = { ...base, id: "d0", effective: false, directionConfidence: 0.55, execution: null, outcome: null };
    const escalated: DecisionRecord = { ...base, id: "d2", source: "ESCALATION", barCloseMs: T + 300_000 };
    const text = reviewUser({
      date: "2026-10-19",
      decisions: [escalated, base, superseded],
      trades: [trade],
      calibration,
      calls: [call("REFLEX", "OK", 0.0008), call("REFLEX", "TIMEOUT", 0.0065), call("ESCALATION", "OK", 0.08)],
      guidance: "- The guidance.",
      closes: { NIFTY: [{ t: "2026-10-19T10:35:00+05:30", c: 25012.4 }, { t: "10:40", c: 25020 }] },
    });
    expect(text).toContain("Judgement guidance in force during the session:\n- The guidance.");
    expect(text).toContain("- all: n 42, Brier 0.251, baseline 0.248");
    expect(text).toContain("- by source: REFLEX n 40 Brier 0.250; ESCALATION n 2 Brier 0.300");
    expect(text).toContain("- NEUTRAL calls (y = 1 when the index stayed within 0.15%): n 300, Brier 0.200, baseline 0.210");
    expect(text).toContain("0.80 to 0.90: n 5, stated 0.84, hit 0.40, paid 0.20");
    expect(text).toContain("- sizing probability: 0.470 (pooled, effective n 12.3)");
    expect(text).toContain("Model calls (total $0.0873):");
    expect(text).toContain("- REFLEX: 2 (OK 1, TIMEOUT 1), $0.0073");
    expect(text).toContain("- 10:36 to 11:12 NIFTY call (LONG) NIFTY26O2325000CE, 2 lots: net ₹-1,234 (-12.3% of premium), exit STOP, finalist gen:NIFTY");
    const rows = text.split("\n").filter((l) => /^\d{2}:\d{2}\|/.test(l));
    expect(rows).toEqual([
      "10:35|NIFTY|gen:NIFTY|R|y|LONG|0.86|3|TRENDING|SAFE|n|toxic_code: WIDE_SPREAD / put side|NO_ENTRY|HIT|0.21",
      "10:35|NIFTY|gen:NIFTY|R|n|LONG|0.55|3|TRENDING|SAFE|n|-|-|PENDING|-",
      "10:40|NIFTY|gen:NIFTY|E|y|LONG|0.86|3|TRENDING|SAFE|n|toxic_code: WIDE_SPREAD / put side|NO_ENTRY|HIT|0.21",
    ]);
    expect(text).toContain("NIFTY: 10:35 25012.4, 10:40 25020");
    expect(text).not.toContain("SENSEX:");
  });

  it("says so when there was nothing to review", () => {
    const empty: CalibrationSummary = { ...calibration, graded: 0, brier: null, baselineBrier: null, byIndex: [], byKind: [], byVersion: [], bySource: [], buckets: [], sizingP: null, paidRate: null, neutral: { n: 0, brier: null, baselineBrier: null } };
    const text = reviewUser({ date: "2026-10-19", decisions: [], trades: [], calibration: empty, calls: [], guidance: BUILTIN_GUIDANCE, closes: {} });
    expect(text).toContain("- all: n 0, Brier -, baseline -");
    expect(text).toContain("Model calls: none.");
    expect(text).toContain("Trades (0):\n- none");
    expect(text).toContain("Decisions (0;");
  });
});

describe("barTime", () => {
  it("is the IST time the bar closed", () => {
    expect(barTime(istAt("2026-10-19", "09:20"))).toBe("09:20");
    expect(barTime(istAt("2026-10-19", "15:05") + 30_000)).toBe("15:05");
  });
});
