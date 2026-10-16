import { describe, expect, it } from "vitest";
import type { AgentCalibrationView, AgentGateLineView } from "@/engine/api-types";
import {
  actionWords,
  breakEvenP,
  brierVerdict,
  dayTime,
  directionWords,
  gateGroups,
  gateHeadline,
  guidanceDiff,
  guidanceItems,
  istTime,
  modelsWords,
  modeWords,
  normalQuantile,
  outcomeWords,
  pct,
  riskWords,
  sizingOutlook,
  sizingOutlookWords,
  sizingWords,
  snapshotNote,
  stateWords,
  usd,
} from "./agentText";

const line = (gate: string, passed: boolean | null, words = gate): AgentGateLineView => ({ gate, passed, words });

/** The cautious p the engine would report for `paid` of `n` effective calls, in the same normal approximation. */
function cautiousP(paid: number, n: number): number {
  const total = n + 100;
  const m = (paid + 50) / total;
  return m - 0.8416212335729143 * Math.sqrt((m * (1 - m)) / (total + 1));
}

const cal = (o: Partial<AgentCalibrationView>): Pick<AgentCalibrationView, "sizingP" | "sizingN" | "sizingMode" | "payoffB" | "payoffTrades"> => ({
  sizingP: null,
  sizingN: 0,
  sizingMode: "pooled",
  payoffB: 1,
  payoffTrades: 0,
  ...o,
});

describe("words for the model's call and the code's action", () => {
  it("says which option each direction buys", () => {
    expect(directionWords("LONG")).toBe("Up: buy a call (CE)");
    expect(directionWords("SHORT")).toBe("Down: buy a put (PE)");
    expect(directionWords("NEUTRAL")).toBe("No direction: no trade");
  });

  it("names every action, including shadow mode's would-be ones and the not-yet state", () => {
    expect(actionWords("NO_ENTRY")).toBe("No trade");
    expect(actionWords("SHADOW_ENTRY")).toMatch(/^Would have bought \(shadow mode: no order placed\)$/);
    expect(actionWords("ENTERED")).toBe("Bought on paper");
    expect(actionWords("EXIT_PENDING")).toMatch(/already waiting/);
    expect(actionWords(null)).toMatch(/next tick/);
  });

  it("words risk, mode and status plainly", () => {
    expect(riskWords("SAFE")).toBe("Safe");
    expect(riskWords("NEAR_LIMIT")).toBe("Near a limit");
    expect(riskWords("REDUCE")).toBe("Reduce: close positions");
    expect(modeWords("shadow").label).toBe("Shadow");
    expect(modeWords("shadow").detail).toMatch(/no order is placed/);
    expect(modeWords("paper").detail).toMatch(/never real money/);
    expect(modeWords("off").label).toBe("Off");
    expect(stateWords("COST_CAP")).toMatch(/cost cap/);
    expect(stateWords("CLOSED")).toBe("Not judging now: candles are judged from 09:20 to 15:05 IST on trading days");
  });

  it("names one model once, or each model's job", () => {
    expect(modelsWords({ reflex: "demo (no model call)", escalation: "demo (no model call)", review: "demo (no model call)" })).toBe("Model: demo (no model call)");
    expect(modelsWords({ reflex: "fast-1", escalation: "deep-2", review: "deep-2" })).toBe("Each candle: fast-1 · escalations: deep-2 · nightly review: deep-2");
  });
});

describe("money, percent and time", () => {
  it("formats dollars for the cost cap", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.004)).toBe("under $0.01");
    expect(usd(0.4249)).toBe("$0.42");
    expect(usd(3)).toBe("$3.00");
    expect(usd(null)).toBe("—");
  });

  it("formats percents with an optional sign", () => {
    expect(pct(1.25)).toBe("1.25%");
    expect(pct(0.12, 2, true)).toBe("+0.12%");
    expect(pct(-0.5, 1)).toBe("−0.5%");
    expect(pct(null)).toBe("—");
  });

  it("adds the day only when it is not the reference's IST day", () => {
    expect(istTime("2026-10-16T11:40:00+05:30")).toBe("11:40 IST");
    expect(dayTime("2026-10-16T11:40:00+05:30", "2026-10-16T11:42:05+05:30")).toBe("11:40 IST");
    expect(dayTime("2026-10-15T16:23:00+05:30", "2026-10-16T11:42:05+05:30")).toBe("Thu 15 Oct, 16:23 IST");
    expect(dayTime(null, "2026-10-16T11:42:05+05:30")).toBe("—");
  });
});

describe("the code's gate in words", () => {
  it("splits what blocked from what passed and what is information only", () => {
    const g = gateGroups([line("fresh", true), line("confidence", false), line("one_sided", null), line("setup_quality", false)]);
    expect(g.blocked.map((l) => l.gate)).toEqual(["confidence", "setup_quality"]);
    expect(g.passed.map((l) => l.gate)).toEqual(["fresh"]);
    expect(g.info.map((l) => l.gate)).toEqual(["one_sided"]);
  });

  it("heads a fired gate, a blocked one and one not run yet", () => {
    expect(gateHeadline({ fired: true, summary: "", lines: [line("a", true), line("b", true), line("c", null)] })).toEqual({ tone: "fired", words: "All 2 checks passed" });
    expect(gateHeadline({ fired: false, summary: "", lines: [line("a", true), line("b", false)] })).toEqual({ tone: "blocked", words: "Blocked by 1 of 2 checks" });
    expect(gateHeadline(null).tone).toBe("pending");
  });
});

describe("sizing in words", () => {
  it("says there is no measured edge when Kelly sizes nothing", () => {
    const w = sizingWords({ p: 0.43, b: 1, kelly: -0.14, riskPct: 0, lots: 0 });
    expect(w.headline).toBe("No measured edge yet: no trade");
    expect(w.detail).toMatch(/never the model's own confidence/);
    expect(w.detail).toMatch(/needs p above 0\.50/);
  });

  it("shows the quarter-Kelly risk and the 1% cap", () => {
    const capped = sizingWords({ p: 0.56, b: 1, kelly: 0.12, riskPct: 1, lots: 1 });
    expect(capped.headline).toBe("Risk 1.00% of equity → 1 lot");
    expect(capped.detail).toMatch(/A quarter of it is 3\.00% of equity, capped at 1% a trade: 1 lot\./);
    const small = sizingWords({ p: 0.505, b: 1, kelly: 0.01, riskPct: 0.25, lots: 0 });
    expect(small.detail).toMatch(/0\.25% of equity: 0 lots: one lot would risk more than that/);
    expect(small.detail).not.toMatch(/capped/);
  });

  it("knows the break-even chance for a payoff ratio", () => {
    expect(breakEvenP(1)).toBe(0.5);
    expect(breakEvenP(1.5)).toBeCloseTo(0.4, 10);
    expect(breakEvenP(0)).toBe(1);
  });
});

describe("outcomes", () => {
  it("grades a decision in plain words", () => {
    expect(outcomeWords({ status: "PENDING", ret30Pct: null })).toMatch(/nightly review/);
    expect(outcomeWords({ status: "HIT", ret30Pct: -0.21 })).toBe("Right: over the next 30 minutes the index moved −0.21%, the called way");
    expect(outcomeWords({ status: "MISS", ret30Pct: 0.01 })).toBe("Wrong: over the next 30 minutes the index moved +0.01%");
    expect(outcomeWords({ status: "CENSORED", ret30Pct: null })).toMatch(/under 30 minutes/);
  });

  it("reads a guidance text as points and shows what a proposal adds and drops", () => {
    const current = "- Prefer NEUTRAL when returns disagree, or when the close is\n  inside the opening range.\n- Be wary late in a strong move.";
    const proposed = "- Prefer NEUTRAL when returns disagree, or when the close is inside the opening range.\n- Give 0.45 while the close is inside the opening range.";
    expect(guidanceItems(current)).toEqual(["Prefer NEUTRAL when returns disagree, or when the close is inside the opening range.", "Be wary late in a strong move."]);
    const d = guidanceDiff(current, proposed);
    expect(d.added).toEqual(["Give 0.45 while the close is inside the opening range."]);
    expect(d.removed).toEqual(["Be wary late in a strong move."]);
    expect(d.proposed.map((p) => p.change)).toEqual(["same", "added"]);
    expect(d.current.map((p) => p.change)).toEqual(["same", "removed"]);
    expect(guidanceDiff(current, current).added).toEqual([]);
  });

  it("counts the snapshot's numbers and tokens", () => {
    expect(snapshotNote({ snapshot: [{ key: "c", label: "Close", value: "1" }], snapshotTokensEst: 312 })).toBe("1 number · about 312 tokens (limit 400)");
    expect(snapshotNote({ snapshot: null, snapshotTokensEst: null })).toBe("0 numbers");
  });
});

describe("calibration", () => {
  it("compares the Brier score with always guessing the base rate", () => {
    expect(brierVerdict(null, null, 0).tone).toBe("none");
    expect(brierVerdict(0.2514, 0.2475, 236).tone).toBe("same");
    expect(brierVerdict(0.2514, 0.2475, 236).words).toMatch(/can be luck/);
    expect(brierVerdict(0.2, 0.25, 400)).toEqual({ words: "Better than always guessing the base rate, by 20.0%.", tone: "better" });
    expect(brierVerdict(0.3, 0.25, 400).tone).toBe("worse");
  });

  it("computes the normal quantile", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.2)).toBeCloseTo(-0.841621, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
  });

  it("with no history, needs about nine paying calls in a row before sizing could move", () => {
    const o = sizingOutlook(cal({ sizingP: cautiousP(0, 0), sizingN: 0 }));
    expect(o.needP).toBe(0.5);
    expect(o.above).toBe(false);
    expect(o.bestCaseMore).toBe(9);
    expect(o.ratePaid).toBeNull();
    expect(o.tradesForB).toBe(30);
  });

  it("at a paid rate under the break-even, says sizing never moves at that rate", () => {
    const o = sizingOutlook(cal({ sizingP: cautiousP(0.3 * 21, 21), sizingN: 21 }));
    expect(o.ratePaid).toBeCloseTo(0.3, 6);
    expect(o.rateTooLow).toBe(true);
    expect(o.bestCaseMore).toBeGreaterThan(9);
    const words = sizingOutlookWords(o, 0.43).join(" ");
    expect(words).toMatch(/Even if every next call paid, that would take about \d+ more graded calls\./);
    expect(words).toMatch(/it never would: about 30% of the calls that count for sizing paid/);
    expect(words).toMatch(/until 30 agent trades have closed \(30 more\)/);
  });

  it("says when sizing can already move, and when there is nothing to measure", () => {
    const above = sizingOutlook(cal({ sizingP: 0.53, sizingN: 400 }));
    expect(above.above).toBe(true);
    expect(sizingOutlookWords(above, 0.53)[0]).toMatch(/can be above zero now/);
    const none = sizingOutlook(cal({ sizingP: null }));
    expect(none.bestCaseMore).toBeNull();
    expect(sizingOutlookWords(none, null)[0]).toMatch(/until there are graded calls/);
    // A measured b above 1 lowers the chance Kelly needs.
    expect(sizingOutlook(cal({ sizingP: 0.45, sizingN: 50, payoffB: 1.5, payoffTrades: 40 })).needP).toBeCloseTo(0.4, 10);
  });
});
