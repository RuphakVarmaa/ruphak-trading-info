import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import type { IndexId } from "../types";
import { closesMap } from "./outcomes";
import { candidateFrom, GUIDANCE_MARKER, gradeDay, MAX_GUIDANCE_CHARS, modelFires, replayScore, type ReplayBar } from "./review";
import type { DecisionOutcome, DecisionRecord, Finalist, IndexSnapshot, InstructionRecord, ReflexDecision, ReviewOut } from "./types";

const DAY = "2026-10-19";
const at = (hhmm: string) => istAt(DAY, hhmm);
const cal = defaultCalendar;

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d", date: DAY, barCloseMs: at("10:35"), index: "NIFTY", finalistKind: "GENERIC", source: "REFLEX", callId: "c", instructionVersion: "core-1/v",
    effective: true, sizing: null, execution: null, outcome: null,
    finalistId: "gen:NIFTY", regime: "TRENDING", direction: "LONG", directionConfidence: 0.85, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "",
    ...over,
  };
}

const closes = (rows: [IndexId, string, number][]): Map<IndexId, Map<number, number>> => {
  const out = new Map<IndexId, Map<number, number>>();
  for (const index of ["NIFTY", "SENSEX"] as const) out.set(index, closesMap(rows.filter((r) => r[0] === index).map(([, t, close]) => ({ barCloseMs: at(t), close }))));
  return out;
};

describe("gradeDay", () => {
  const stored = closes([
    ["NIFTY", "10:35", 25_000],
    ["NIFTY", "11:05", 25_010],
    ["SENSEX", "10:35", 82_000],
    ["SENSEX", "11:05", 81_900],
  ]);
  const after = at("16:20");

  it("labels every decision whose window has ended, superseded rows too", () => {
    const rows = [
      decision({ id: "long" }),
      decision({ id: "short", index: "SENSEX", finalistId: "gen:SENSEX", direction: "SHORT" }),
      decision({ id: "late", barCloseMs: at("15:05") }),
      decision({ id: "gap", barCloseMs: at("11:00") }),
      decision({ id: "old", effective: false, direction: "NEUTRAL" }),
    ];
    const out = new Map(gradeDay(rows, stored, cal, after).map((g) => [g.id, g.outcome]));
    expect(out.get("long")).toMatchObject({ status: "HIT", y: 1, paid: false, source: "STORED", gradedMs: after });
    expect(out.get("short")).toMatchObject({ status: "HIT", y: 1, paid: false, ret30Pct: expect.closeTo(-100 / 820, 12) });
    expect(out.get("late")).toMatchObject({ status: "CENSORED", y: null });
    expect(out.get("gap")).toMatchObject({ status: "MISSING", y: null });
    expect(out.get("old")).toMatchObject({ status: "NEUTRAL", y: 1 });
  });

  it("leaves decisions whose window has not ended ungraded", () => {
    const rows = [decision({ id: "young" }), decision({ id: "late", barCloseMs: at("15:05") })];
    expect(gradeDay(rows, stored, cal, at("11:04")).map((g) => [g.id, g.outcome.status])).toEqual([["late", "CENSORED"]]);
    expect(gradeDay(rows, stored, cal, at("11:05")).map((g) => g.id)).toEqual(["young", "late"]);
  });

  it("grades from the bar archive when it has both bars", () => {
    const archive = closes([
      ["NIFTY", "10:35", 25_000],
      ["NIFTY", "11:05", 24_990],
    ]);
    const [g] = gradeDay([decision()], stored, cal, after, archive);
    expect(g.outcome).toMatchObject({ status: "MISS", source: "BARS_5M" });
  });

  it("never replaces a label with MISSING, nor an archive label with a stored-close one", () => {
    const hit: DecisionOutcome = { status: "HIT", y: 1, ret30Pct: 0.04, paid: false, source: "BARS_5M", gradedMs: 1 };
    expect(gradeDay([decision({ outcome: hit })], new Map(), cal, after)).toEqual([]);
    expect(gradeDay([decision({ outcome: hit })], stored, cal, after)).toEqual([]);
    const missing: DecisionOutcome = { status: "MISSING", y: null, ret30Pct: null, paid: null, source: null, gradedMs: 1 };
    expect(gradeDay([decision({ outcome: missing })], stored, cal, after)[0].outcome.status).toBe("HIT");
    const storedLabel: DecisionOutcome = { ...hit, source: "STORED" };
    const archive = closes([
      ["NIFTY", "10:35", 25_000],
      ["NIFTY", "11:05", 25_040],
    ]);
    expect(gradeDay([decision({ outcome: storedLabel })], stored, cal, after, archive)[0].outcome).toMatchObject({ source: "BARS_5M", paid: true });
  });
});

describe("candidateFrom", () => {
  const base: InstructionRecord = { version: "core-1/aaaa1111", guidance: "- Prefer NEUTRAL when returns disagree.\n- Be wary late in a strong move.", createdMs: 0, source: "BUILTIN", candidateId: null, active: true };
  const out = (guidance: string | null): ReviewOut => ({
    summary: "", fills: [], misses: [], mistakes: [], lessons: [],
    candidate: guidance === null ? null : { guidance, rationale: "  The reflex chased late moves.  ", wouldBeWrongIf: "Brier worsens over five sessions." },
  });
  const make = (guidance: string | null) => candidateFrom(out(guidance), base, DAY, 1_234, () => "cand-1");

  it("returns a SCORING candidate from the review's proposal, keeping the text it was written against (D7)", () => {
    expect(make("\r\n- Prefer NEUTRAL when ADX is below 20.\r\n- Wait for the flow to agree.\u0007  ")).toEqual({
      id: "cand-1", date: DAY, createdMs: 1_234, baseVersion: "core-1/aaaa1111", baseGuidance: base.guidance,
      guidance: "- Prefer NEUTRAL when ADX is below 20.\n- Wait for the flow to agree.",
      rationale: "The reflex chased late moves.", wouldBeWrongIf: "Brier worsens over five sessions.",
      status: "SCORING", replay: null, decidedMs: null, decidedBy: null,
    });
  });

  it("refuses no proposal, an empty or over-long text, the base text again, and the guidance marker", () => {
    expect(make(null)).toBeNull();
    expect(make("   \n ")).toBeNull();
    expect(make("x".repeat(MAX_GUIDANCE_CHARS + 1))).toBeNull();
    expect(make(`  ${"x".repeat(MAX_GUIDANCE_CHARS)}  `)?.guidance).toHaveLength(MAX_GUIDANCE_CHARS);
    expect(make(base.guidance)).toBeNull();
    expect(make("- Prefer NEUTRAL when returns   disagree.\n\n- Be wary late in a strong move.  ")).toBeNull();
    expect(make(`- Keep this.\n${GUIDANCE_MARKER}`)).toBeNull();
    expect(make("- Keep this. << guidance >>")).toBeNull();
  });
});

const snapshot = (o: Partial<NonNullable<IndexSnapshot["o"]>> | null = {}): IndexSnapshot => ({
  c: 25000, r5: 12, r15: -8, r60: 31, ro: 45, vw: 18, vz: 0.9, orh: -11, orl: 21, ors: "I", pdh: -35, pdl: 64, pdc: 45,
  rsi: 58, adx: 24, di: 6, st: 1, rv: 11, atr: 0.08, vix: 13.4, vixc: -2.1,
  o: o === null ? null : { k: 25000, cm: 112.5, cs: 0.89, pm: 98.1, ps: 1.02, iv: 13, ivx: -0.6, pcr: 0.92, mp: -5, cw: 40, pw: -60, bc: [3, 5, 1, 2], bp: [2, 1, 4, 0], oa: 58, ...o },
  cv: 0.21, rg: "TU", pv: "C", pn: "kkckk", ew: 1, dte: 3, xd: 0,
  bk: { pos: "-", lots: 0, pnl: null, dd: 1.15, dl: 0.35 },
});

const finalist = (id: string, index: IndexId, side: "LONG" | "SHORT" | null = null): Finalist => ({
  id, kind: side ? "IDEA" : "GENERIC", index, label: id, side, contract: null, entryHigh: null, condition: null, wrongIf: null, bearCase: null, why: [], horizon: null, briefId: null,
});
const gN = finalist("gen:NIFTY", "NIFTY");
const gS = finalist("gen:SENSEX", "SENSEX");

const call = (finalistId: string, direction: ReflexDecision["direction"], directionConfidence: number, over: Partial<ReflexDecision> = {}): ReflexDecision => ({
  finalistId, regime: "TRENDING", direction, directionConfidence, toxicFlow: false, setupQuality: 3, riskState: "SAFE", reason: "", ...over,
});

describe("modelFires", () => {
  it("applies the model side of the gate on the stored snapshot", () => {
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85), snapshot(), gN)).toBe(true);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.8), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85, { setupQuality: 1 }), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "NEUTRAL", 0.95), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85, { regime: "CRISIS" }), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85, { toxicFlow: true }), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85, { riskState: "NEAR_LIMIT" }), snapshot(), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85), snapshot({ cs: 3 }), gN)).toBe(false);
    expect(modelFires(call("gen:NIFTY", "LONG", 0.85), null, gN)).toBe(false);
    expect(modelFires(call("gen:SENSEX", "LONG", 0.85), snapshot(), gN)).toBe(false);
    const idea = finalist("idea:b:1", "NIFTY", "LONG");
    expect(modelFires(call(idea.id, "LONG", 0.85), snapshot(), idea)).toBe(true);
    expect(modelFires(call(idea.id, "SHORT", 0.85), snapshot(), idea)).toBe(false);
  });
});

describe("replayScore", () => {
  const bars: ReplayBar[] = ["10:00", "10:05", "10:10"].map((t) => ({ barCloseMs: at(t), snapshots: { NIFTY: snapshot(), SENSEX: snapshot() }, finalists: [gN, gS] }));
  const stored = closes([
    ["NIFTY", "10:00", 25_000],
    ["NIFTY", "10:30", 25_025],
    ["NIFTY", "10:05", 25_000],
    ["NIFTY", "10:35", 24_990],
    ["NIFTY", "10:10", 25_000],
    ["SENSEX", "10:00", 82_000],
    ["SENSEX", "10:30", 82_000],
    ["SENSEX", "10:05", 82_000],
    ["SENSEX", "10:35", 82_100],
  ]);
  const live = (finalistId: string, index: IndexId, direction: ReflexDecision["direction"], c: number, over: Partial<DecisionRecord> = {}) =>
    decision({ finalistId, index, direction, directionConfidence: c, ...over });

  const result = replayScore({
    bars,
    candidate: [
      [call("gen:NIFTY", "LONG", 0.9), call("gen:SENSEX", "NEUTRAL", 0.6)],
      [call("gen:NIFTY", "LONG", 0.7, { setupQuality: 2 }), call("gen:NIFTY", "SHORT", 0.99), call("idea:gone:1", "LONG", 0.99)],
      [call("gen:NIFTY", "LONG", 0.95)],
    ],
    currentReplayed: [[call("gen:NIFTY", "SHORT", 0.85)], [call("gen:NIFTY", "SHORT", 0.82)]],
    current: [
      [live("gen:NIFTY", "NIFTY", "LONG", 0.6), live("gen:NIFTY", "NIFTY", "SHORT", 0.99, { source: "ESCALATION" })],
      [live("gen:SENSEX", "SENSEX", "LONG", 0.7)],
      [],
    ],
    closes: stored,
    calendar: cal,
    nowMs: at("16:20"),
    costUsd: 0.12,
    complete: false,
  });

  it("scores the three runs on exactly the calls all three labelled, and reports each run's own count (C5)", () => {
    // Each run's labelled calls. Candidate: NIFTY 10:00 LONG 0.9 hit (+0.1%), NIFTY 10:05 LONG 0.7 missed (−0.04%);
    // the 10:10 call has no 10:40 close. Current text replayed: NIFTY 10:00 SHORT 0.85 missed, 10:05 SHORT 0.82 hit.
    // Live reflex rows only (the escalation's SHORT 0.99 is left out): NIFTY 10:00 LONG 0.6 hit, SENSEX 10:05 LONG 0.7 hit.
    expect(result).toMatchObject({ gradedCandidate: 2, gradedCurrent: 2, gradedLive: 2 });
    // Only NIFTY at 10:00 is labelled by all three (live has no NIFTY call at 10:05).
    expect(result.gradedCommon).toBe(1);
    expect(result.graded).toBe(1);
    expect(result.brierCandidate).toBeCloseTo(0.01, 12);
    expect(result.brierCurrentReplayed).toBeCloseTo(0.7225, 12);
    expect(result.brierCurrentLive).toBeCloseTo(0.16, 12);
  });

  it("never lets a text win by answering NEUTRAL on the hard calls (the probe of review C5)", () => {
    // 10 candles: on 5 easy ones the index rises 0.1% (a LONG hits); on 5 hard ones it falls 0.1% (a LONG misses).
    const easy = ["09:30", "09:35", "09:40", "09:45", "09:50"];
    const hard = ["11:30", "11:35", "11:40", "11:45", "11:50"];
    const m = new Map<number, number>();
    for (const t of [...easy, ...hard]) m.set(at(t), 25_000);
    for (const t of ["10:00", "10:05", "10:10", "10:15", "10:20"]) m.set(at(t), 25_025);
    for (const t of ["12:00", "12:05", "12:10", "12:15", "12:20"]) m.set(at(t), 24_975);
    const days: ReplayBar[] = [...easy, ...hard].map((t) => ({ barCloseMs: at(t), snapshots: {}, finalists: [gN] }));
    // The current text (replayed, and live) says LONG 0.7 everywhere; the candidate says the same on the easy candles
    // and NEUTRAL on the hard ones.
    const current = days.map(() => [call("gen:NIFTY", "LONG", 0.7)]);
    const candidate = days.map((_, i) => (i < 5 ? [call("gen:NIFTY", "LONG", 0.7)] : [call("gen:NIFTY", "NEUTRAL", 0.7)]));
    const liveRows = days.map((b) => [decision({ barCloseMs: b.barCloseMs, direction: "LONG", directionConfidence: 0.7 })]);
    const r = replayScore({ bars: days, candidate, currentReplayed: current, current: liveRows, closes: new Map([["NIFTY", m]]), calendar: cal, nowMs: at("16:20"), costUsd: 0, complete: true });
    // Scored on the 5 calls every run labelled, the two texts are identical: no win by abstaining.
    expect(r).toMatchObject({ gradedCandidate: 5, gradedCurrent: 10, gradedLive: 10, gradedCommon: 5, graded: 5 });
    expect(r.brierCandidate).toBeCloseTo(0.09, 12);
    expect(r.brierCurrentReplayed).toBeCloseTo(0.09, 12);
    expect(r.brierCurrentLive).toBeCloseTo(0.09, 12);
    // A failed call (no answer) drops its candle from the comparison too.
    const failed = replayScore({ bars: days, candidate: candidate.map((x, i) => (i === 0 ? [] : x)), currentReplayed: current, current: liveRows, closes: new Map([["NIFTY", m]]), calendar: cal, nowMs: at("16:20"), costUsd: 0, complete: true });
    expect(failed).toMatchObject({ gradedCandidate: 4, gradedCommon: 4 });
  });

  it("counts the calls that pass the model side of the gate and their hit rate", () => {
    expect(result.firesCandidate).toBe(2);
    expect(result.hitRateCandidate).toBe(1);
    expect(result.firesCurrent).toBe(2);
    expect(result.hitRateCurrent).toBe(0.5);
  });

  it("is labelled in-sample and carries the replay's progress and cost", () => {
    expect(result).toMatchObject({ bars: 3, costUsd: 0.12, complete: false, cursorBarMs: at("10:10"), label: "in-sample, not proof" });
    const empty = replayScore({ bars: [], candidate: [], currentReplayed: [], current: [], closes: new Map(), calendar: cal, nowMs: 0, costUsd: 0, complete: true });
    expect(empty).toEqual({
      bars: 0, graded: 0, brierCandidate: null, brierCurrentReplayed: null, brierCurrentLive: null, firesCandidate: 0, firesCurrent: 0,
      hitRateCandidate: null, hitRateCurrent: null, costUsd: 0, complete: true, cursorBarMs: null, label: "in-sample, not proof",
      gradedCandidate: 0, gradedCurrent: 0, gradedLive: 0, gradedCommon: 0,
    });
  });
});
