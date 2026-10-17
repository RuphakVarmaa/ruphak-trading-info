import { describe, expect, it } from "vitest";
import type { OutlookEvent } from "@/lib/options/outlook";
import { REFRESH_CLOSED_MS } from "@/lib/refresh";
import { basisWords, daysLine, fmtOiChange, moveTooltip, newEventsPerRow, oiChangeLine, OUTLOOK_FILL_MS, OUTLOOK_OPEN_MS, outlookPollMs, rangeScale, scalePct } from "./outlookText";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const ev = (id: string): OutlookEvent => ({ id, title: id, kind: "OTHER", at: "2026-10-20T10:00:00+05:30", impact: "MED", approx: false });

describe("outlook text", () => {
  it("polls fast while expiries are pending, then by the session", () => {
    expect(outlookPollMs(2, ist("2026-10-15T11:00:00"))).toBe(OUTLOOK_FILL_MS);
    expect(outlookPollMs(0, ist("2026-10-15T11:00:00"))).toBe(OUTLOOK_OPEN_MS);
    expect(outlookPollMs(0, ist("2026-10-15T18:00:00"))).toBe(REFRESH_CLOSED_MS);
    expect(outlookPollMs(null, null)).toBe(OUTLOOK_OPEN_MS);
  });

  it("shows each event once, on the first expiry it comes before", () => {
    const rows = [{ events: [ev("a")] }, { events: [ev("a"), ev("b"), ev("c")] }, { events: [ev("a"), ev("b"), ev("c")] }, { events: [ev("a"), ev("b"), ev("c"), ev("d")] }];
    expect(newEventsPerRow(rows).map((r) => r.map((e) => e.id))).toEqual([["a"], ["b", "c"], [], ["d"]]);
  });

  it("puts every range and the spot on one padded scale", () => {
    const s = rangeScale([{ range: { low: 100, high: 120 } }, { range: null }, { range: { low: 90, high: 130 } }], 110)!;
    expect(s.min).toBeCloseTo(90 - 1.6, 6);
    expect(s.max).toBeCloseTo(130 + 1.6, 6);
    expect(scalePct(110, s)).toBeCloseTo(50, 6);
    expect(scalePct(0, s)).toBe(0);
    expect(scalePct(1000, s)).toBe(100);
    expect(rangeScale([{ range: null }], 110)).toBeNull();
    // A spot outside every range widens the scale.
    expect(rangeScale([{ range: { low: 100, high: 120 } }], 140)!.max).toBeGreaterThan(140);
  });

  it("formats OI changes the Indian way, with a sign", () => {
    expect(fmtOiChange(2_134_210)).toBe("+21.3L");
    expect(fmtOiChange(-4_100)).toBe("−4.1k");
    expect(fmtOiChange(12_500_000)).toBe("+1.25Cr");
    expect(fmtOiChange(0)).toBe("0");
    expect(oiChangeLine({ ce: 2_134_210, pe: -8_523_970 })).toBe("Calls +21.3L · Puts −85.2L");
    expect(oiChangeLine({ ce: 500, pe: null })).toBe("Calls +500 · Puts no data");
    expect(oiChangeLine({ ce: null, pe: null })).toBeNull();
  });

  it("explains the straddle, with the model 1σ marked as a model's", () => {
    const t = moveTooltip({ straddle: { ce: 145.55, pe: 133.38, total: 278.93, basis: "mid" }, atmStrike: 22600, movePct: 1.23, oneSigmaPct: 1.54 })!;
    expect(t).toContain("22600 call ₹145.55 + put ₹133.38 = ₹278.93");
    expect(t).toContain("1σ ≈ ±1.54%");
    expect(t).toContain("Model figure");
    expect(moveTooltip({ straddle: null, atmStrike: 22600, movePct: null, oneSigmaPct: null })).toBeUndefined();
    expect(basisWords("ltp")).toMatch(/last traded/);
  });

  it("says how long is left", () => {
    expect(daysLine(11, 7)).toBe("11 days · 7 sessions left");
    expect(daysLine(0, 1)).toBe("today · 1 session left");
    expect(daysLine(1, 2)).toBe("1 day · 2 sessions left");
  });
});
