import { describe, expect, it } from "vitest";
import { istAt, istIso } from "../clock";
import { fakeBrief } from "../testing/fakeAgent";
import { fnv1aHex } from "../util/hash";
import { AGENT_DEFAULTS } from "./config";
import { CHARS_PER_TOKEN_BOUND, PROSE_CHARS_PER_TOKEN, REVIEW_CALL, USER_MESSAGE_TOKEN_LIMIT } from "./constants";
import { MODEL_PRICES } from "./cost";
import { FINALIST_TEXT, compileFinalists } from "./finalists";
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
import { SNAPSHOT_WIRE_KEYS, encodeSnapshot, worstCaseSnapshot } from "./snapshot";
import type { AgentTradeRecord, CalibrationSummary, CallRecord, DecisionRecord, Finalist, IndexSnapshot, ReflexInput, StoredBar } from "./types";

const T = istAt("2026-10-19", "10:35");

/** In the snapshot's units: returns and distances in basis points; the ATR, the spreads and the book in percent. */
const typical: IndexSnapshot = {
  c: 25012, r5: 12, r15: -8, r60: 31, ro: 45, vw: -18, vz: 0.9,
  orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
  rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
  o: { k: 25000, cm: 112.5, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58 },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
  bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
};

/** Every number at its widest encoding (snapshot.ts's own worst case). */
const widest: IndexSnapshot = worstCaseSnapshot();

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
    expect(REFLEX_CORE_VERSION).toBe("core-2");
    expect(fnv1aHex(REFLEX_CORE)).toBe("751510a4");
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
    expect(SNAPSHOT_LEGEND.flatMap((e) => e.keys)).toEqual([...SNAPSHOT_WIRE_KEYS.top]);
    expect(OPTION_LEGEND.flatMap((e) => e.keys)).toEqual(Object.keys(wire.o as Record<string, unknown>));
    expect(Object.keys(JSON.parse(encodeSnapshot({ ...typical, o: null })) as object)).toEqual(Object.keys(wire));
    for (const e of [...SNAPSHOT_LEGEND, ...OPTION_LEGEND]) expect(REFLEX_CORE).toContain(`- ${e.keys.join(" ")}: ${e.text}`);
    expect(REFLEX_CORE).toContain("bps are basis points (100 bps = 1%)");
    expect(REFLEX_CORE).toContain("max pain within the ±15 monitored strikes");
    // Fields the amended snapshot dropped are not described; the book goes as an array.
    for (const gone of ["cd", "th", "ors", "pv", "ew"]) expect([...SNAPSHOT_LEGEND, ...OPTION_LEGEND].some((e) => e.keys.includes(gone))).toBe(false);
    expect(Array.isArray(wire.bk)).toBe(true);
  });

  it("gives each field encodeSnapshot's unit: basis points only for returns and distances", () => {
    const text = (key: string) => [...SNAPSHOT_LEGEND, ...OPTION_LEGEND].find((e) => e.keys.includes(key))!.text;
    const inBps = new Set(["r5", "r15", "r60", "ro", "vw", "orh", "orl", "pdh", "pdl", "pdc", "mp", "cw", "pw"]);
    for (const e of [...SNAPSHOT_LEGEND, ...OPTION_LEGEND]) expect(/\bbps\b/.test(e.text), e.keys.join(" ")).toBe(e.keys.some((k) => inBps.has(k)));
    expect(text("atr")).toContain("(% of the close)");
    expect(text("cs")).toContain("spread (% of the mid)");
    expect(text("ps")).toContain("spread (% of the mid)");
    expect(text("vixc")).toContain("(%)");
    expect(text("bk")).toContain("account drawdown from its peak (%), today's loss used (% of equity)");
    // What the wire form leaves out is still readable: the entry window from the bar time, the plan's verdict from pn.
    expect(REFLEX_CORE.replace(/\s+/g, " ")).toContain("It buys only from 09:25 to 14:30 IST");
    expect(text("orh")).toContain("09:15 to 09:30");
    expect(text("pn")).toContain("any b means the plan says no new trades");
  });

  it("keeps the built-in guidance to keys the snapshot has", () => {
    const keys = new Set([...SNAPSHOT_LEGEND, ...OPTION_LEGEND].flatMap((e) => e.keys));
    for (const k of ["r5", "r15", "di", "vz", "ivx", "oa", "pn", "orh", "orl"]) expect(keys.has(k)).toBe(true);
    for (const k of ["vz", "ivx", "oa", "pn", "orh", "orl"]) expect(BUILTIN_GUIDANCE).toMatch(new RegExp(`\\b${k}\\b`));
    expect(BUILTIN_GUIDANCE).not.toMatch(/\bpv\b|\bew\b|\bors\b|\bcd\b|\bth\b/);
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

  it("keeps reflexUser itself within USER_MESSAGE_TOKEN_LIMIT at its largest: two widest snapshots, six finalists and the brief, prose at len/3", () => {
    const longText = "Only if NIFTY closes above 25,250 on a 5-minute candle and the call writers at 25,300 start covering. ".repeat(6);
    const ideas = [1, 2, 3, 4].map((n) => idea(n, { id: `idea:adv-2026-10-19-1:adv-2026-10-19-1-${n}`, entryHigh: 12345.65, condition: longText, wrongIf: longText, bearCase: longText, why: [longText, longText, longText] }));
    const worst = input({ NIFTY: widest, SENSEX: widest });
    const finalists = [generic("NIFTY"), generic("SENSEX"), ...ideas];
    const bigBrief = { headline: longText, factors: [longText, longText, longText, longText, longText] };
    const text = reflexUser(worst, finalists, bigBrief);
    expect(text).toContain(`"NIFTY":${encodeSnapshot(widest)},"SENSEX":${encodeSnapshot(widest)}`);
    // Every prose string the message carries (each clipped to its limit), JSON-quoted as it is sent.
    const msg = JSON.parse(text) as { finalists: { condition?: string; wrongIf?: string; bearCase?: string; why?: string[] }[]; brief: { headline: string; factors: string[] } };
    const prose = [...msg.finalists.flatMap((f) => [f.condition, f.wrongIf, f.bearCase, ...(f.why ?? [])]), msg.brief.headline, ...msg.brief.factors].filter((x): x is string => typeof x === "string");
    expect(prose).toHaveLength(4 * 5 + 1 + FINALIST_TEXT.factors);
    const proseChars = prose.reduce((n, x) => n + JSON.stringify(x).length, 0);
    const est = Math.ceil((text.length - proseChars) / CHARS_PER_TOKEN_BOUND) + Math.ceil(proseChars / PROSE_CHARS_PER_TOKEN);
    expect(est).toBeLessThanOrEqual(USER_MESSAGE_TOKEN_LIMIT);
    expect(estimateReflexUserTokens(worst, finalists, bigBrief)).toBe(est);
    // The estimate is never below the whole message at the prose rate, nor below its two snapshots at the numeric rate.
    expect(est).toBeGreaterThanOrEqual(Math.ceil(text.length / PROSE_CHARS_PER_TOKEN));
    expect(est).toBeGreaterThan((2 * encodeSnapshot(widest).length) / CHARS_PER_TOKEN_BOUND);
  });

  it("gives a compiled idea its side, contract, buy-zone top (2 decimals) and texts; a generic its id, kind and index", () => {
    const brief = fakeBrief(istIso(istAt("2026-10-19", "09:25")), [{ entry: { low: 100, high: 110.5333, ask: 105, asOf: istIso(istAt("2026-10-19", "09:25")) }, why: ["one"] }]);
    const [gen, f] = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief });
    expect(promptFinalist(gen)).toEqual({ id: "gen:NIFTY", kind: "GENERIC", index: "NIFTY" });
    expect(promptFinalist(f)).toEqual({
      id: `idea:${brief.id}:${brief.ideas[0].id}`,
      kind: "IDEA",
      index: "NIFTY",
      side: "LONG",
      contract: "NIFTY 25000 CE 26 Oct",
      buyZoneTop: 110.53,
      condition: brief.ideas[0].condition,
      wrongIf: brief.ideas[0].wrongIf,
      bearCase: brief.ideas[0].bearCase,
      why: ["one"],
    });
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

  it("names it when the guidance shown is not the session's own text", () => {
    const text = reviewUser({ date: "2026-10-19", decisions: [base], trades: [], calibration, calls: [], guidance: "- The active text.", guidanceNote: "the session ran with guidance core-2/0bad0bad, whose text is not stored", closes: {} });
    expect(text).toContain("Judgement guidance in force during the session:\n(Note: the session ran with guidance core-2/0bad0bad, whose text is not stored.)\n- The active text.");
  });

  describe("stays within REVIEW_CALL.userTokenBound (M1)", () => {
    const D = "2026-10-19";
    const B = (i: number) => istAt(D, "09:20") + i * 5 * 60_000;
    const longId = (n: number, len: number) => `idea:adv-${D}-1:${"x".repeat(Math.max(0, len - 30))}-${n}`.slice(0, len);
    const LONG_GATE = "setup_quality: setupQuality 1 is below the minimum of 2 needed to enter; the code also saw WIDE_SPREAD and STALE_OPTIONS on the put side";
    const guidance = "- ".concat("Prefer NEUTRAL when the returns disagree and the flow is mixed. ".repeat(60)).slice(0, 3_000);
    /** A whole day: 70 bars × the finalists, the longest gate texts, `esc` escalations (each with the reflex row it replaced). */
    function day(o: { finalists: string[]; esc: number; fired?: (i: number, f: number) => boolean; idLen?: number }) {
      const rows: DecisionRecord[] = [];
      for (let i = 0; i < 70; i++) {
        o.finalists.forEach((f, k) => {
          const fired = o.fired?.(i, k) ?? false;
          const row: DecisionRecord = {
            ...base,
            id: `d${i}-${k}`,
            barCloseMs: B(i),
            index: k % 2 ? "SENSEX" : "NIFTY",
            finalistId: f,
            direction: i % 3 ? "NEUTRAL" : "LONG",
            directionConfidence: 0.4 + (i % 5) / 20,
            setupQuality: 1,
            regime: "MEAN_REVERTING",
            riskState: "NEAR_LIMIT",
            execution: {
              ...base.execution!,
              action: fired ? "SHADOW_ENTRY" : "NOT_EXECUTED",
              gate: { ...base.execution!.gate, fired, lines: fired ? [] : [{ gate: "setup_quality", passed: false, detail: LONG_GATE }] },
            },
            outcome: { status: i > 65 ? "CENSORED" : "MISS", y: i > 65 ? null : 0, ret30Pct: i > 65 ? null : -0.123, paid: i > 65 ? null : false, source: i > 65 ? null : "BARS_5M", gradedMs: 0 },
          };
          rows.push(row);
        });
      }
      for (let e = 0; e < o.esc; e++) {
        const i = 3 + 8 * e;
        const replaced = rows.find((r) => r.barCloseMs === B(i) && r.finalistId === o.finalists[0])!;
        replaced.effective = false;
        rows.push({ ...replaced, id: `e${e}`, source: "ESCALATION", effective: true, direction: "NEUTRAL", directionConfidence: 0.5 });
      }
      return rows;
    }
    const closes = { NIFTY: Array.from({ length: 75 }, (_, i) => ({ t: barTime(B(i)), c: 25_012.35 + i })), SENSEX: Array.from({ length: 75 }, (_, i) => ({ t: barTime(B(i)), c: 82_010.15 + i })) };
    const calls = Array.from({ length: 80 }, (_, i) => call(i < 72 ? "REFLEX" : "ESCALATION", "OK", 0.001 + i / 1e6));
    const est = (text: string) => Math.ceil(text.length / PROSE_CHARS_PER_TOKEN);
    const decisionRows = (text: string) => text.split("\n").filter((l) => /^\d{2}:\d{2}(–\d{2}:\d{2} \(\d+ rows\))?\|/.test(l));
    const six = ["gen:NIFTY", "gen:SENSEX", ...[1, 2, 3, 4].map((n) => longId(n, 40))];

    it("keeps an ordinary day whole: every row, nothing folded", () => {
      const rows = day({ finalists: ["gen:NIFTY", "gen:SENSEX"], esc: 3 });
      const text = reviewUser({ date: D, decisions: rows.filter((r) => r.effective), trades: [trade], calibration, calls, guidance: BUILTIN_GUIDANCE, closes });
      expect(est(text)).toBeLessThanOrEqual(REVIEW_CALL.userTokenBound);
      expect(decisionRows(text)).toHaveLength(140);
      expect(text).not.toContain("rows)|");
    });

    it("fits the longest day the agent can have: 70 bars × 6 finalists, 8 escalations, the longest gate texts, a 3,000-character guidance", () => {
      const rows = day({ finalists: six, esc: 8, fired: (i, k) => k === 0 && i % 20 === 7 });
      const text = reviewUser({ date: D, decisions: rows.filter((r) => r.effective), trades: [trade], calibration, calls, guidance, closes });
      expect(est(text)).toBeLessThanOrEqual(REVIEW_CALL.userTokenBound);
      // Every escalation's row and every row that fired is there.
      expect(decisionRows(text).filter((l) => l.includes(`|${six[0]}|E|y|NEUTRAL|0.50|`))).toHaveLength(8);
      expect(decisionRows(text).filter((l) => l.includes("|SHADOW_ENTRY|"))).toHaveLength(4);
      expect(text).toContain(guidance);
    });

    it("folds quiet runs (and then drops superseded rows) when the rows are longer still, keeping every row that matters", () => {
      // Finalist ids at the 120-character cell limit: the full table is about 40K tokens.
      const ids = ["gen:NIFTY", "gen:SENSEX", ...[1, 2, 3, 4].map((n) => longId(n, 120))];
      const rows = day({ finalists: ids, esc: 8, fired: (i, k) => k === 2 && i % 10 === 4 });
      expect(rows).toHaveLength(428);
      const text = reviewUser({ date: D, decisions: rows, trades: [trade], calibration, calls, guidance, closes });
      expect(est(text)).toBeLessThanOrEqual(REVIEW_CALL.userTokenBound);
      expect(text).toContain("a row whose bar is a time range stands for that many consecutive calls of one finalist that neither fired, traded nor exited");
      const folded = decisionRows(text).filter((l) => / \(\d+ rows\)\|/.test(l));
      expect(folded.length).toBeGreaterThan(0);
      // A folded row: the time range, the count per direction, the confidence range and the outcome counts.
      expect(folded[0]).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2} \(\d+ rows\)\|(NIFTY|SENSEX)\|[^|]+\|R\|y\|\d+ (LONG|NEUTRAL)(, \d+ (LONG|NEUTRAL))?\|0\.\d{2}(–0\.\d{2})?\|-\|-\|-\|-\|not fired\|-\|\d+ (MISS|CENSORED)/);
      // Every escalation row, every fired row and the traded row's decision are listed in full.
      expect(decisionRows(text).filter((l) => l.includes("|E|y|"))).toHaveLength(8);
      expect(decisionRows(text).filter((l) => l.includes("|SHADOW_ENTRY|"))).toHaveLength(7);
      // The rows the folding stands for add up to every in-force row.
      const counted = decisionRows(text).reduce((n, l) => n + Number(/ \((\d+) rows\)\|/.exec(l)?.[1] ?? 1), 0);
      expect(counted).toBeLessThanOrEqual(rows.length);
    });

    it("keeps only the rows that fired, traded, exited or escalated, and counts the rest, when even folding is too long", () => {
      // Every second row fired: nothing quiet is left to fold.
      const ids = ["gen:NIFTY", "gen:SENSEX", ...[1, 2, 3, 4].map((n) => longId(n, 120))];
      const rows = day({ finalists: ids, esc: 8, fired: (i, k) => (i + k) % 2 === 0 });
      const text = reviewUser({ date: D, decisions: rows, trades: [trade], calibration, calls, guidance, closes });
      expect(est(text)).toBeLessThanOrEqual(REVIEW_CALL.userTokenBound);
      expect(text).toContain("only the rows that fired, traded or exited and the escalations' rows are listed");
      expect(text).toMatch(/\(\d+ rows omitted\)/);
      expect(decisionRows(text).filter((l) => l.includes("|E|y|"))).toHaveLength(8);
      expect(decisionRows(text).every((l) => l.includes("|SHADOW_ENTRY|") || l.includes("|E|y|"))).toBe(true);
    });

    it("never exceeds the bound, even with every row firing and an over-long trade list", () => {
      const ids = ["gen:NIFTY", "gen:SENSEX", ...[1, 2, 3, 4].map((n) => longId(n, 120))];
      const rows = day({ finalists: ids, esc: 8, fired: () => true });
      const trades = Array.from({ length: 600 }, (_, i) => ({ ...trade, positionId: `p${i}`, finalistId: longId(i, 120) }));
      const text = reviewUser({ date: D, decisions: rows, trades, calibration, calls, guidance, closes });
      expect(est(text)).toBeLessThanOrEqual(REVIEW_CALL.userTokenBound);
    });
  });
});

describe("barTime", () => {
  it("is the IST time the bar closed", () => {
    expect(barTime(istAt("2026-10-19", "09:20"))).toBe("09:20");
    expect(barTime(istAt("2026-10-19", "15:05") + 30_000)).toBe("15:05");
  });
});
