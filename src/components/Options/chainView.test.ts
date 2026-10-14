import { describe, expect, it } from "vitest";
import type { OptionChainRowView, OptionSideView, SignalAdviceView, SignalView } from "@/engine/api-types";
import { istAt } from "@/lib/ist";
import { adviceLine, atmIndex, breakeven, chainPollMs, diffFlashes, engineTieIn, fmtLakh, isItm, isMarketHours, shortExpiry, spotLineIndex, visibleRows } from "./chainView";

const side = (ltp: number | null): OptionSideView =>
  ({ instrumentKey: "x", ltp, close: null, change: null, changePct: null, bid: null, ask: null, bidQty: null, askQty: null, volume: null, oi: null, prevOi: null, oiChange: null, iv: null, delta: null, gamma: null, theta: null, vega: null, pop: null });
const row = (strike: number, ce: number | null, pe: number | null): OptionChainRowView => ({ strike, ce: side(ce), pe: side(pe) });

describe("isItm", () => {
  it("calls below the spot, puts above it", () => {
    expect(isItm(22500, 22646, "CE")).toBe(true);
    expect(isItm(22700, 22646, "CE")).toBe(false);
    expect(isItm(22700, 22646, "PE")).toBe(true);
    expect(isItm(22500, 22646, "PE")).toBe(false);
    expect(isItm(22650, 22650, "CE")).toBe(false);
    expect(isItm(22650, 22650, "PE")).toBe(false);
  });
});

describe("spot line", () => {
  const strikes = [22550, 22600, 22650, 22700];
  it("sits before the first strike above the spot", () => {
    expect(spotLineIndex(strikes, 22646.35)).toBe(2);
    expect(spotLineIndex(strikes, 22650)).toBe(3);
    expect(spotLineIndex(strikes, 22000)).toBe(0);
    expect(spotLineIndex(strikes, 23000)).toBe(4);
  });
  it("finds the ATM row", () => {
    expect(atmIndex(strikes, 22646.35)).toBe(2);
    expect(atmIndex(strikes, 22646.35, 22600)).toBe(1);
  });
});

describe("visibleRows", () => {
  const rows = Array.from({ length: 51 }, (_, i) => row(22000 + i * 50, 1, 1));
  it("shows ±10 strikes around the ATM, or all", () => {
    const v = visibleRows(rows, 22646, 22650, false);
    expect(v).toHaveLength(21);
    expect(v[10].strike).toBe(22650);
    expect(visibleRows(rows, 22646, 22650, true)).toHaveLength(51);
    expect(visibleRows(rows, 22010, 22000, false)[0].strike).toBe(22000);
  });
});

describe("diffFlashes", () => {
  it("flags LTPs that moved, by direction", () => {
    const prev = [row(100, 10, 5), row(110, 6, null)];
    const next = [row(100, 10.5, 4.95), row(110, 6, 8), row(120, 3, 3)];
    const f = diffFlashes(prev, next);
    expect(f.get("100:CE")).toBe("up");
    expect(f.get("100:PE")).toBe("down");
    expect(f.has("110:CE")).toBe(false);
    expect(f.has("110:PE")).toBe(false);
    expect(f.has("120:CE")).toBe(false);
    expect(diffFlashes(null, next).size).toBe(0);
  });
});

describe("market hours and polling", () => {
  it("polls fast only in the session", () => {
    expect(isMarketHours(istAt("2026-10-14", "11:42"))).toBe(true);
    expect(isMarketHours(istAt("2026-10-14", "09:14"))).toBe(false);
    expect(isMarketHours(istAt("2026-10-14", "15:30"))).toBe(false);
    expect(isMarketHours(istAt("2026-10-17", "11:00"))).toBe(false); // Saturday
    expect(chainPollMs(istAt("2026-10-14", "11:42"))).toBe(2_000);
    expect(chainPollMs(istAt("2026-10-14", "20:00"))).toBe(600_000);
  });
});

describe("formatting", () => {
  it("formats expiries, lakhs and breakevens", () => {
    expect(shortExpiry("2026-10-19")).toBe("19-Oct");
    expect(fmtLakh(12_441_325)).toBe("1.24Cr");
    expect(fmtLakh(934_375)).toBe("9.3L");
    expect(fmtLakh(-164_385)).toBe("−1.6L");
    expect(fmtLakh(6_370)).toBe("6.4k");
    expect(breakeven(22500, 63, "CE")).toBe(22563);
    expect(breakeven(22500, 63, "PE")).toBe(22437);
  });
});

describe("engineTieIn", () => {
  const advice = {
    kind: "ENTER",
    at: "",
    side: "BULL",
    contract: { index: "NIFTY", expiry: "2026-10-19", strike: 22500, optionType: "CE", tradingSymbol: "", lotSize: 65, label: "" },
    premium: 63,
    priceSource: "model",
    spot: 22646,
    skipBeyondSpot: null,
    levels: {} as SignalAdviceView["levels"],
    pausedBy: [],
  } as SignalAdviceView;
  const sig = (over: Partial<SignalView>) => ({ index: "NIFTY", advice: null, noPlanReason: null, gates: [], ...over }) as SignalView;

  it("reads ENTER advice for the index and expiry", () => {
    const t = engineTieIn([sig({ advice })], "NIFTY", "2026-10-19");
    expect(t.advice).toBe(advice);
    expect(t.onThisExpiry).toBe(true);
    expect(engineTieIn([sig({ advice })], "NIFTY", "2026-10-27").onThisExpiry).toBe(false);
    expect(engineTieIn([sig({ advice })], "SENSEX", "2026-10-19").advice).toBeNull();
    expect(adviceLine(advice)).toBe("Engine's live reading says buy NIFTY 22500 CE 19-Oct, limit ≤ ₹63.00 — paper engine paused, no measured edge");
  });

  it("falls back to the no-plan reason, then the first failing gate", () => {
    expect(engineTieIn([sig({ noPlanReason: "Conviction below threshold" })], "NIFTY", "x").reason).toBe("Conviction below threshold");
    const gates = [
      { gate: "a", label: "A", passed: null, detail: "" },
      { gate: "b", label: "Theta edge", passed: false, detail: "" },
    ];
    expect(engineTieIn([sig({ gates })], "NIFTY", "x").reason).toBe("Theta edge");
    expect(engineTieIn(null, "NIFTY", "x")).toEqual({ advice: null, onThisExpiry: false, reason: null });
  });
});
