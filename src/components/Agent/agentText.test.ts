import { describe, expect, it } from "vitest";
import type { AgentCalibrationView, AgentGateLineView, AgentRiskView } from "@/engine/api-types";
import {
  aboutCalls,
  actionWords,
  breakEvenP,
  brierVerdict,
  candidateStatusWords,
  dayTime,
  decidedOnWords,
  directionWords,
  ENTRY_STOP,
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
  rearmWords,
  replayCoverageWords,
  replayScoredWords,
  replayStopWords,
  reviewNotice,
  riskHeadline,
  riskWords,
  sizingOutlook,
  sizingOutlookWords,
  sizingWords,
  snapshotNote,
  stateWords,
  usd,
} from "./agentText";

/** Nothing may say or imply that the agent has, found or measured an edge: once the allowed negations are gone, no "edge" is left. */
const claimsEdge = (s: string) => /\bedge\b/i.test(s.replace(/not proof of an edge/gi, "").replace(/no edge for option buyers/gi, ""));

const RISK: AgentRiskView = {
  asOf: "2026-10-16T11:41:55+05:30",
  equity: 500_000,
  peakEquity: 500_000,
  drawdownPct: 0,
  maxDrawdownPct: 15,
  dayLossPct: 0,
  dailyLossCapPct: 3,
  openPositions: 0,
  maxOpenPositions: 2,
  maxLotsPerPosition: 3,
  killSwitch: false,
  killReason: null,
  mainKillSwitch: false,
  drawdownHalt: false,
  codeRiskState: "SAFE",
};

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
  it("says which option the agent would buy for each direction, never as an instruction to the reader", () => {
    expect(directionWords("LONG")).toBe("Up: the agent would buy a call (CE)");
    expect(directionWords("SHORT")).toBe("Down: the agent would buy a put (PE)");
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
  it("at size zero says past calls have not cleared break-even, on how many calls, and never claims an edge", () => {
    const w = sizingWords({ p: 0.43, b: 1, kelly: -0.14, riskPct: 0, lots: 0, n: 21.4 });
    expect(w.headline).toBe("Size zero: confident past calls have not cleared break-even (measured on about 21 calls)");
    expect(w.size).toBeNull();
    expect(w.detail).toMatch(/never the model's own confidence/);
    expect(w.detail).toMatch(/needs p above 0\.50/);
    for (const s of [w.headline, w.detail]) expect(claimsEdge(s)).toBe(false);
    // The number behind p unknown (an older record): no count.
    expect(sizingWords({ p: 0.43, b: 1, kelly: -0.14, riskPct: 0, lots: 0 }).headline).toBe("Size zero: confident past calls have not cleared break-even");
  });

  it("with no graded calls of the decision's kind, says so, and that p is only the starting estimate", () => {
    const w = sizingWords({ p: 0.458, b: 1, kelly: -0.08, riskPct: 0, lots: 0, n: 0 });
    expect(w.headline).toBe("Size zero: no graded calls of this kind yet");
    expect(w.detail).toMatch(/with no graded calls of this kind yet, only the cautious starting estimate/);
  });

  it("above zero allows a small size, says it is in-sample and not proof of an edge, then the risk and the lots", () => {
    const capped = sizingWords({ p: 0.56, b: 1, kelly: 0.12, riskPct: 1, lots: 1, n: 412 });
    expect(capped.headline).toBe(
      "Small size allowed: confident past calls moved enough to pay often enough to clear break-even (measured on about 412 calls, in-sample; not proof of an edge)",
    );
    expect(capped.size).toBe("Risk 1.00% of equity → 1 lot");
    expect(capped.detail).toMatch(/A quarter of it is 3\.00% of equity, capped at 1% a trade: 1 lot\./);
    expect(claimsEdge(capped.headline)).toBe(false);
    expect(sizingWords({ p: 0.56, b: 1, kelly: 0.12, riskPct: 1, lots: 2 }).headline).toMatch(/break-even \(in-sample; not proof of an edge\)$/);
    const small = sizingWords({ p: 0.505, b: 1, kelly: 0.01, riskPct: 0.25, lots: 0 });
    expect(small.detail).toMatch(/0\.25% of equity: 0 lots: one lot would risk more than that/);
    expect(small.detail).not.toMatch(/capped/);
  });

  it("when the quarter-Kelly cap blocks the trade (0 lots), the size row says 0 lots and why, never 1 lot", () => {
    // The kelly_cap block of the dashboard review's probe (kellycap.test.ts): the engine now records 0 lots.
    const w = sizingWords({ p: 0.53, b: 1, kelly: 0.06, riskPct: 0.15, lots: 0, n: 300 });
    expect(w.size).toBe("Risk 0.15% of equity → 0 lots: one lot would risk more than that");
    expect(w.size).not.toMatch(/→ 1 lot/);
  });

  it("rounds the overlap-weighted count, and says at least one call once any counts", () => {
    expect(aboutCalls(0)).toBe("about 0 calls");
    expect(aboutCalls(0.4)).toBe("about 1 call");
    expect(aboutCalls(20.6)).toBe("about 21 calls");
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

describe("the nightly review and its candidate", () => {
  it("shows a review waiting for its retry, or skipped, calmly; only a failed one is an error", () => {
    expect(reviewNotice({ status: "PENDING", error: "the 5-minute bar archive is not complete yet; trying again" })).toEqual({
      tone: "warn",
      words: "Waiting: the 5-minute bar archive is not complete yet; trying again",
    });
    expect(reviewNotice({ status: "SKIPPED", error: "nothing to review: no decision was in force and no trade was made on 2026-10-19; the day was graded and scored" })).toEqual({
      tone: "neutral",
      words: "Skipped: nothing to review: no decision was in force and no trade was made on 2026-10-19; the day was graded and scored",
    });
    expect(reviewNotice({ status: "FAILED", error: "TIMEOUT: no answer" })).toEqual({ tone: "error", words: "The review failed: TIMEOUT: no answer" });
    expect(reviewNotice({ status: "DONE", error: null })).toBeNull();
  });

  it("says an approved candidate is in use only while its text is the active one", () => {
    expect(candidateStatusWords("APPROVED", true)).toBe("Approved: in use");
    expect(candidateStatusWords("APPROVED", false)).toBe("Approved earlier; no longer in use");
    // A view that does not say: an approval is taken as in use.
    expect(candidateStatusWords("APPROVED")).toBe("Approved: in use");
    expect(candidateStatusWords("PENDING", false)).toBe("Waiting for your decision");
  });

  it("says how many of the day's candles the replay judged again", () => {
    expect(replayCoverageWords({ bars: 60, barsTotal: 75 })).toBe("60 of the day's 75 candles were judged again with each text, on identical inputs.");
    // An older replay without barsTotal: what it judged is all that is known.
    expect(replayCoverageWords({ bars: 75 })).toBe("75 of the day's 75 candles were judged again with each text, on identical inputs.");
    expect(replayCoverageWords({ bars: 1, barsTotal: 1 })).toBe("1 of the day's 1 candle was judged again with each text, on identical inputs.");
  });

  it("scores the replay on the calls every run labelled, with each run's own count, and flags too few to compare", () => {
    const base = { graded: 5, gradedCandidate: 5, gradedCurrent: 10, gradedLive: 10, gradedCommon: 5 };
    // The probe's case (probe-replay.test.ts): the proposed text says no direction on the 5 hard calls.
    expect(replayScoredWords(base)).toBe("Scored on 5 calls that all three runs labelled (proposed 5, current 10, live 10): too few to compare.");
    expect(replayScoredWords({ ...base, graded: 58, gradedCandidate: 58, gradedCurrent: 66, gradedLive: 64, gradedCommon: 58 })).toBe(
      "Scored on 58 calls that all three runs labelled (proposed 58, current 66, live 64).",
    );
    // An older replay scored each run on its own calls: it says so instead of claiming the same calls.
    expect(replayScoredWords({ graded: 64 })).toBe(
      "Scored on 64 graded calls of the proposed text; this older replay scored each run on its own calls, so the three scores are not over the same calls.",
    );
  });

  it("names why an incomplete replay stopped, and blames the cost cap only when it was the cost cap", () => {
    expect(replayStopWords({ complete: true, bars: 75, stopReason: null })).toBeNull();
    expect(replayStopWords({ complete: false, bars: 40, stopReason: "cost_cap" })).toBe("The replay stopped early at the cost cap, so it covers only part of the day.");
    expect(replayStopWords({ complete: false, bars: 40, stopReason: "interrupted" })).toBe("The replay was interrupted (the agent restarted), so it covers only part of the day.");
    expect(replayStopWords({ complete: false, bars: 0, stopReason: "no_key" })).toBe("The replay could not run (no API key), so no candle was judged again.");
    expect(replayStopWords({ complete: false, bars: 40 })).toBe("The replay stopped early, so it covers only part of the day.");
    for (const r of ["interrupted", "no_key", undefined] as const) expect(replayStopWords({ complete: false, bars: 40, stopReason: r })).not.toMatch(/cost cap/);
  });
});

describe("the risk headline and re-arm", () => {
  it("takes the entry stops from the code's limits: 1.5% day loss, 10% drawdown, 5 entries a day", () => {
    expect(ENTRY_STOP).toEqual({ dayLossPct: 1.5, drawdownPct: 10, entriesToday: 5 });
  });

  it("is green only when nothing stops entries, in the order the code checks", () => {
    expect(riskHeadline(RISK)).toEqual({ tone: "ok", words: "Within every limit: new entries are allowed when a decision passes every check." });
    // The dashboard review's render.test.ts: a 3.2% day loss (cap 3%) and a 1.6% one (near the limit) are not "within every limit".
    const capped = riskHeadline({ ...RISK, dayLossPct: 3.2, codeRiskState: "REDUCE" });
    expect(capped.tone).toBe("stopped");
    expect(capped.words).toBe("Stopped for today: today's loss 3.20% reached the 3% cap; positions closed, no new entries until the next session.");
    const near = riskHeadline({ ...RISK, dayLossPct: 1.6, codeRiskState: "NEAR_LIMIT" });
    expect(near.tone).toBe("blocked");
    expect(near.words).toBe(
      "No new entries now: the code's risk state is Near a limit; entries need Safe (day loss under 1.5%, drawdown under 10%, fewer than 2 positions open and fewer than 5 entries today).",
    );
    expect(riskHeadline({ ...RISK, drawdownPct: 15.18, drawdownHalt: true, killSwitch: true, codeRiskState: "REDUCE" }).words).toBe(
      "Halted: the account fell 15.18% from its peak (the limit is 15%). No new entries until you re-arm.",
    );
    expect(riskHeadline({ ...RISK, killSwitch: true, killReason: "main kill switch engaged at 11:30", dayLossPct: 3.2 }).words).toBe("Kill switch on: main kill switch engaged at 11:30. No new entries.");
  });

  it("re-arms after a halt (the peak restarts), clears a kill switch alone (the peak stays), and is off while main's switch is on", () => {
    const halted = rearmWords({ ...RISK, drawdownHalt: true, killSwitch: true });
    expect(halted).toMatchObject({ label: "Re-arm the agent", enabled: true, confirmLabel: "Re-arm", peakRestarts: true });
    const kill = rearmWords({ ...RISK, killSwitch: true, peakEquity: 568_000 });
    expect(kill).toMatchObject({ label: "Clear the kill switch", enabled: true, confirmLabel: "Clear it", peakRestarts: false });
    expect(kill.note).toBe("Clears the agent's kill switch; the drawdown is still measured from its peak of ₹5,68,000 (admin token needed).");
    const mainOn = rearmWords({ ...RISK, killSwitch: true, mainKillSwitch: true });
    expect(mainOn).toMatchObject({ enabled: false, note: "Reset main's kill switch first: the engine refuses until then." });
    expect(rearmWords({ ...RISK, drawdownHalt: true, killSwitch: true, mainKillSwitch: true }).enabled).toBe(false);
    expect(rearmWords(RISK)).toMatchObject({ label: "Re-arm the agent", enabled: false, note: "Nothing to re-arm: no halt and the kill switch is off." });
  });
});

describe("which candle a decision is from", () => {
  it("names the decision's candle only when the card heads with another one", () => {
    expect(decidedOnWords("2026-10-16T15:05:00+05:30", "2026-10-16T15:25:00+05:30")).toBe("Decided on the 15:05 candle");
    // The same instant written another way is the same candle.
    expect(decidedOnWords("2026-10-16T15:05:00+05:30", "2026-10-16T09:35:00.000Z")).toBeNull();
    expect(decidedOnWords("2026-10-16T15:05:00+05:30", null)).toBe("Decided on the 15:05 candle");
  });
});
