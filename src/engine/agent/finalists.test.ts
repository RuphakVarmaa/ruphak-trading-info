import { describe, expect, it } from "vitest";
import type { AdvisorFactor, AdvisorIdea, AdvisorReport } from "../api-types";
import { istAt, istIso } from "../clock";
import { AGENT_POLICY } from "./constants";
import { FINALIST_TEXT, briefAsOf, briefContext, clipText, compileFinalists, finalistPrompt, genericFinalist } from "./finalists";

// Mon 19 Oct 2026: NIFTY's weekly expires today (Tue 20 Oct is a holiday); SENSEX's on Thu 22 Oct.
const DAY = "2026-10-19";
const T = istAt(DAY, "10:35");

let n = 0;
function idea(o: Partial<AdvisorIdea> = {}, c: Partial<AdvisorIdea["contract"]> = {}): AdvisorIdea {
  n++;
  return {
    id: `adv-202610190925-${n}`,
    horizon: "TODAY",
    contract: { index: "NIFTY", expiry: "2026-10-27", strike: 25_100, optionType: "CE", tradingSymbol: `NIFTY26O27${25_100 + n}CE`, lotSize: 65, label: `NIFTY 27-OCT-2026 ${25_100 + n} CE`, ...c },
    entry: { low: 100, high: 110.5, ask: 105, asOf: istIso(istAt(DAY, "09:25")) },
    stop: 70,
    target: 160,
    exitBy: `${DAY}T15:00:00+05:30`,
    lots: 1,
    costPerLot: 6_825,
    maxLossPerLot: 2_275,
    rewardPerLot: 3_575,
    breakevenAtExpiry: 25_210,
    delta: 0.5,
    iv: 12,
    probItm: 0.5,
    why: ["Calls are being covered above 25,000.", "The index holds above VWAP."],
    wrongIf: "NIFTY closes a 5-minute bar below 24,950.",
    confidence: "MEDIUM",
    condition: "Only if NIFTY closes a 5-minute bar above 25,050.",
    bearCase: "FII selling could resume after the RBI minutes.",
    ...o,
  };
}

const factor = (label: string, reading: AdvisorFactor["reading"], detail: string): AdvisorFactor => ({ key: "OTHER", label, reading, detail, source: "test" });

function brief(createdMs: number, ideas: AdvisorIdea[], o: Partial<AdvisorReport> = {}): AdvisorReport {
  return {
    id: "adv-202610190925",
    createdAt: istIso(createdMs),
    model: "test",
    durationMs: 1_000,
    costUsd: null,
    market: { nifty: 25_000, sensex: 82_000, vix: 13, phase: "OPEN" },
    headline: "WAIT: no clean setup yet.",
    today: { action: "WAIT", summary: "Wait for the condition.", ideaId: null },
    outlook: [],
    factors: [
      factor("FII flows", "SUPPORTS_DOWN", "Foreign funds sold ₹2,300 crore yesterday."),
      factor("Global cues", "NO_DATA", "No data."),
      factor("Options positioning", "SUPPORTS_UP", "Put writers added at 25,000."),
    ],
    ideas,
    zeroHero: { applicable: false, expiry: null, summary: "" },
    premium: { verdict: "NORMAL", detail: "" },
    alsoKnow: [],
    avoid: [],
    sources: [],
    honesty: "No measured edge.",
    ...o,
  };
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe("compileFinalists", () => {
  it("always has one generic finalist per index, first and in order, and nothing else without a brief", () => {
    const fs = compileFinalists({ indices: ["NIFTY", "SENSEX"], nowMs: T, brief: null });
    expect(fs).toEqual([genericFinalist("NIFTY"), genericFinalist("SENSEX")]);
    expect(fs[0]).toMatchObject({ id: "gen:NIFTY", kind: "GENERIC", side: null, contract: null, entryHigh: null, briefId: null, why: [] });
    expect(ids(compileFinalists({ indices: ["SENSEX", "SENSEX"], nowMs: T, brief: null }))).toEqual(["gen:SENSEX"]);
  });

  it("uses a brief only when it was written at or before the bar close, on the same IST date", () => {
    const one = [idea()];
    const used = (createdMs: number) => compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: brief(createdMs, one) }).length > 1;
    expect(used(istAt(DAY, "09:25"))).toBe(true);
    expect(used(T)).toBe(true);
    // istIso keeps whole seconds, so a brief written in the second after the close is after it.
    expect(used(T + 1_000)).toBe(false);
    expect(used(T + 30_000)).toBe(false);
    expect(used(istAt("2026-10-16", "15:00"))).toBe(false);
    expect(compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: { ...brief(T, one), createdAt: "not a date" } })).toHaveLength(1);
    expect(briefAsOf(brief(T + 30_000, one), T)).toBeNull();
    expect(briefAsOf(brief(T - 1_000, one), T)?.id).toBe("adv-202610190925");
  });

  it("takes ideas on the given indices with a contract expiring after today, and skips malformed ones", () => {
    const good = idea();
    const ideas = [
      idea({}, { expiry: DAY }), // NIFTY's contract expiring today: never bought
      idea({}, { expiry: "2026-10-16" }),
      idea({}, { index: "SENSEX", expiry: "2026-10-22", optionType: "PE" }),
      idea({}, { strike: 0 }),
      idea({}, { lotSize: 0 }),
      idea({}, { tradingSymbol: " " }),
      idea({}, { optionType: "XX" as "CE" }),
      idea({ entry: { low: 0, high: 0, ask: 0, asOf: "" } }),
      { ...idea(), contract: undefined as unknown as AdvisorIdea["contract"] },
      good,
    ];
    const nifty = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: brief(istAt(DAY, "09:25"), ideas) });
    expect(ids(nifty)).toEqual(["gen:NIFTY", `idea:adv-202610190925:${good.id}`]);
    const both = compileFinalists({ indices: ["NIFTY", "SENSEX"], nowMs: T, brief: brief(istAt(DAY, "09:25"), ideas) });
    expect(both.filter((f) => f.kind === "IDEA").map((f) => f.index)).toEqual(["SENSEX", "NIFTY"]);
  });

  it("keeps at most four ideas, today's idea first and then the brief's order, each id once", () => {
    const six = [idea(), idea(), idea(), idea(), idea(), idea()];
    const b = brief(istAt(DAY, "09:25"), [six[0], six[0], ...six.slice(1)], { today: { action: "BUY", summary: "", ideaId: six[4].id } });
    const fs = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: b });
    expect(AGENT_POLICY.maxIdeas).toBe(4);
    expect(ids(fs)).toEqual(["gen:NIFTY", ...[six[4], six[0], six[1], six[2]].map((x) => `idea:adv-202610190925:${x.id}`)]);
  });

  it("compiles an idea with its fixed side, contract, buy zone, texts and brief", () => {
    const call = idea({ horizon: "WEEK" });
    const put = idea({}, { optionType: "PE", strike: 24_900, label: "" });
    const [, c, p] = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: brief(istAt(DAY, "09:25"), [call, put]) });
    expect(c).toEqual({
      id: `idea:adv-202610190925:${call.id}`,
      kind: "IDEA",
      index: "NIFTY",
      label: call.contract.label,
      side: "LONG",
      contract: { expiry: "2026-10-27", strike: 25_100, type: "CE", tradingSymbol: call.contract.tradingSymbol, lotSize: 65 },
      entryHigh: 110.5,
      condition: call.condition,
      wrongIf: call.wrongIf,
      bearCase: call.bearCase,
      why: call.why,
      horizon: "WEEK",
      briefId: "adv-202610190925",
    });
    expect(p).toMatchObject({ side: "SHORT", label: "NIFTY 24900 PE 27 Oct", contract: { type: "PE", strike: 24_900 } });
  });

  it("cuts texts to their limits, strips control characters and reads blanks as missing", () => {
    const long = "x".repeat(500);
    const f = compileFinalists({
      indices: ["NIFTY"],
      nowMs: T,
      brief: brief(istAt(DAY, "09:25"), [idea({ condition: long, wrongIf: "a\nb\tc\u0000d", bearCase: "   ", why: ["", long, "y", "z"] })]),
    })[1];
    expect(f.condition).toHaveLength(FINALIST_TEXT.condition);
    expect(f.condition!.endsWith("…")).toBe(true);
    expect(f.wrongIf).toBe("a b c d");
    expect(f.bearCase).toBeNull();
    expect(f.why).toEqual([`${"x".repeat(FINALIST_TEXT.why - 1)}…`, "y"]);
    // Briefs stored before the condition and bear case existed lack them.
    const old = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: brief(istAt(DAY, "09:25"), [idea({ condition: undefined, bearCase: undefined })]) })[1];
    expect(old).toMatchObject({ condition: null, bearCase: null });
    expect(clipText(42, 10)).toBe("");
    expect(clipText("abcdef", 4)).toBe("abc…");
  });
});

describe("finalistPrompt", () => {
  it("gives a generic its id, kind and index only", () => {
    expect(finalistPrompt(genericFinalist("SENSEX"))).toEqual({ id: "gen:SENSEX", kind: "GENERIC", index: "SENSEX" });
  });

  it("gives an idea its side, contract, buy-zone top and texts", () => {
    const x = idea({ why: ["one"] }, { strike: 25_100 });
    const f = compileFinalists({ indices: ["NIFTY"], nowMs: T, brief: brief(istAt(DAY, "09:25"), [x]) })[1];
    expect(finalistPrompt(f)).toEqual({
      id: `idea:adv-202610190925:${x.id}`,
      kind: "IDEA",
      index: "NIFTY",
      side: "LONG",
      contract: "NIFTY 25100 CE 27 Oct",
      buyZoneTop: 110.5,
      condition: x.condition,
      wrongIf: x.wrongIf,
      bearCase: x.bearCase,
      why: ["one"],
    });
  });
});

describe("briefContext", () => {
  it("is the headline and up to four factors with data, as of the bar close", () => {
    const b = brief(istAt(DAY, "09:25"), []);
    expect(briefContext(b, T)).toEqual({
      headline: "WAIT: no clean setup yet.",
      factors: ["FII flows: SUPPORTS_DOWN — Foreign funds sold ₹2,300 crore yesterday.", "Options positioning: SUPPORTS_UP — Put writers added at 25,000."],
    });
  });

  it("is null for a brief written after the bar close or on another day, and for no brief", () => {
    expect(briefContext(brief(T + 30_000, []), T)).toBeNull();
    expect(briefContext(brief(istAt("2026-10-16", "09:25"), []), T)).toBeNull();
    expect(briefContext(null, T)).toBeNull();
  });

  it("cuts the headline and each factor", () => {
    const many = Array.from({ length: 7 }, (_, i) => factor(`Factor ${i}`, "RISK", "d".repeat(300)));
    const c = briefContext(brief(istAt(DAY, "09:25"), [], { headline: "h".repeat(400), factors: many }), T)!;
    expect(c.headline).toHaveLength(FINALIST_TEXT.headline);
    expect(c.factors).toHaveLength(FINALIST_TEXT.factors);
    for (const f of c.factors) expect(f.length).toBeLessThanOrEqual(FINALIST_TEXT.factor);
    expect(c.factors[0].startsWith("Factor 0: RISK — ddd")).toBe(true);
  });
});
