import { describe, expect, it } from "vitest";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { InMemoryRepository } from "../repo/memory";
import type { Conviction, GateResult, OptionContract, PlanDecision } from "../types";
import { ADVICE_REFRESH_MS, adviceKey, adviceOf, decisionQuoteSource, recordAdvice, signalSaysEnter, type SignalAdvice } from "./advice";

const T = istAt("2026-10-14", "10:42");

const contract: OptionContract = {
  index: "NIFTY",
  exchange: "NSE",
  tradingSymbol: "NIFTY26O1922500CE",
  growwSymbol: "NSE-NIFTY-19Oct26-22500-CE",
  exchangeToken: "2",
  expiry: "2026-10-19",
  strike: 22500,
  type: "CE",
  lotSize: 65,
  tickSize: 0.05,
};

const gate = (id: string, passed: boolean | null, detail = ""): GateResult => ({ gate: id, label: id, passed, detail });

function conviction(score: number): Conviction {
  return { index: "NIFTY", t: T, score, components: [], regime: "RANGE", threshold: 0.55, passes: Math.abs(score) >= 0.55, sizeMult: 1, stance: score > 0 ? "BULLISH" : "BEARISH" };
}

function decision(over: Partial<PlanDecision> = {}): PlanDecision {
  return {
    id: "d1",
    index: "NIFTY",
    t: T,
    conviction: conviction(0.61),
    gates: [gate("conviction", true), gate("quote", true, "synthetic bid 61.5 / ask 61.75"), gate("edge_ratio", true), gate("size", true), gate("edge_calibrated", false, "2.1%"), gate("move_calibrated", false, "expected 0.1% vs 0.3%")],
    plan: null,
    contract,
    refPremium: 61.75,
    expectedMovePct: 0.28,
    impliedMovePct: 0.4,
    edgeRatio: 0.12,
    noPlanReason: "Edge: 2.1%",
    ...over,
  };
}

describe("signalSaysEnter", () => {
  it("is true only when the measured-edge checks are all that fails", () => {
    expect(signalSaysEnter(decision())).toBe(true);
    expect(signalSaysEnter(decision({ gates: [gate("conviction", true), gate("edge_calibrated", false)] }))).toBe(true);
  });

  it("is false when any other check fails, when nothing fails, or without a quoted contract", () => {
    expect(signalSaysEnter(decision({ gates: [gate("conviction", false), gate("edge_calibrated", false)] }))).toBe(false);
    expect(signalSaysEnter(decision({ gates: [gate("edge_calibrated", false), gate("spread", false, "2.4%")] }))).toBe(false);
    expect(signalSaysEnter(decision({ gates: [gate("conviction", true), gate("edge_ratio", true)] }))).toBe(false);
    expect(signalSaysEnter(decision({ gates: [gate("conviction", true), gate("edge_ratio", true)], plan: {} as PlanDecision["plan"] }))).toBe(false);
    expect(signalSaysEnter(decision({ contract: null }))).toBe(false);
    expect(signalSaysEnter(decision({ refPremium: null }))).toBe(false);
  });
});

describe("adviceOf", () => {
  it("carries the side, contract, ask, spot, horizon, quote source and the pausing checks", () => {
    const a = adviceOf(decision(), 22431.4, DEFAULT_CONFIG);
    expect(a).toMatchObject({ kind: "ENTER", t: T, index: "NIFTY", decisionId: "d1", side: "BULL", premium: 61.75, spot: 22431.4, regime: "RANGE", expectedMovePct: 0.28, horizonMin: 90, quoteSource: "synthetic" });
    expect(a.kind === "ENTER" && a.contract.tradingSymbol).toBe("NIFTY26O1922500CE");
    expect(a.kind === "ENTER" && a.pausedBy).toEqual(["edge_calibrated", "move_calibrated"]);
  });

  it("is BEAR for a negative score and caps the horizon at the square-off", () => {
    const late = istAt("2026-10-14", "14:20");
    const a = adviceOf(decision({ t: late, conviction: { ...conviction(-0.7), t: late } }), 22431.4, DEFAULT_CONFIG);
    expect(a).toMatchObject({ kind: "ENTER", side: "BEAR", horizonMin: 45 });
  });

  it("is WAIT otherwise", () => {
    expect(adviceOf(decision({ gates: [gate("conviction", false)] }), 22431.4, DEFAULT_CONFIG)).toEqual({ kind: "WAIT", t: T, index: "NIFTY", decisionId: "d1" });
  });

  it("reads the quote source from the quote gate", () => {
    expect(decisionQuoteSource([gate("quote", true, "groww bid 61.5 / ask 61.75")])).toBe("groww");
    expect(decisionQuoteSource([gate("quote", true, "upstox bid 61.5 / ask 61.75")])).toBe("upstox");
    expect(decisionQuoteSource([gate("quote", false, "quote failed: timeout")])).toBeNull();
    expect(decisionQuoteSource([])).toBeNull();
  });
});

describe("recordAdvice", () => {
  it("writes on a flip, on a contract change and every minute while it says ENTER, else not", async () => {
    const repo = new InMemoryRepository();
    const key = adviceKey("NIFTY");
    expect((await recordAdvice(repo, decision(), 22431, DEFAULT_CONFIG))?.kind).toBe("ENTER");
    // 30 s later, same contract: nothing new.
    expect(await recordAdvice(repo, decision({ id: "d2", t: T + 30_000 }), 22433, DEFAULT_CONFIG)).toBeNull();
    expect((await repo.state.get<SignalAdvice>(key))?.decisionId).toBe("d1");
    // A minute on: refreshed (new ask and spot).
    const refreshed = await recordAdvice(repo, decision({ id: "d3", t: T + ADVICE_REFRESH_MS, refPremium: 63.2 }), 22440, DEFAULT_CONFIG);
    expect(refreshed).toMatchObject({ kind: "ENTER", decisionId: "d3", premium: 63.2, spot: 22440 });
    // A different strike 10 s later: written at once.
    const other = { ...contract, strike: 22550, tradingSymbol: "NIFTY26O1922550CE" };
    expect((await recordAdvice(repo, decision({ id: "d4", t: T + ADVICE_REFRESH_MS + 10_000, contract: other }), 22440, DEFAULT_CONFIG))?.decisionId).toBe("d4");
    // The signal fades: WAIT written once, then not again.
    const wait = decision({ id: "d5", t: T + 2 * ADVICE_REFRESH_MS, gates: [gate("conviction", false)] });
    expect((await recordAdvice(repo, wait, 22440, DEFAULT_CONFIG))?.kind).toBe("WAIT");
    expect(await recordAdvice(repo, { ...wait, id: "d6", t: wait.t + 30_000 }, 22440, DEFAULT_CONFIG)).toBeNull();
    expect(await recordAdvice(repo, { ...wait, id: "d7", t: wait.t + 10 * ADVICE_REFRESH_MS }, 22440, DEFAULT_CONFIG)).toBeNull();
    expect((await repo.state.get<SignalAdvice>(key))?.decisionId).toBe("d5");
  });
});
