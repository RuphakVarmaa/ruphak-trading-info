import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt, MINUTE_MS } from "../clock";
import { archiveClosesMap, closesMap, labelDecision, OUTCOME_HORIZON_MS, outcomeCensored } from "./outcomes";

const T = istAt("2026-10-19", "10:35");
const T30 = T + 30 * MINUTE_MS;
const LATER = istAt("2026-10-19", "16:20");
const cal = defaultCalendar;

/** Stored closes at T and T + 30 min. */
const at = (c0: number, c1: number) => closesMap([{ barCloseMs: T, close: c0 }, { barCloseMs: T30, close: c1 }]);
const label = (direction: "LONG" | "SHORT" | "NEUTRAL", c1: number, c0 = 10_000) => labelDecision({ barCloseMs: T, direction }, at(c0, c1), cal, LATER);

describe("labelDecision", () => {
  it("grades over six bars (30 minutes)", () => {
    expect(OUTCOME_HORIZON_MS).toBe(30 * MINUTE_MS);
    expect(label("LONG", 10_020)).toEqual({ status: "HIT", y: 1, ret30Pct: expect.closeTo(0.2, 12), paid: true, source: "STORED", gradedMs: LATER });
  });

  it("calls a HIT from a 0.03% move in the called direction; less is a MISS, and a flat move is a MISS", () => {
    expect(label("LONG", 10_003)).toMatchObject({ status: "HIT", y: 1, paid: false });
    expect(label("LONG", 10_002.9)).toMatchObject({ status: "MISS", y: 0, paid: false });
    expect(label("LONG", 10_000)).toMatchObject({ status: "MISS", y: 0 });
    expect(label("LONG", 9_990)).toMatchObject({ status: "MISS", y: 0, ret30Pct: expect.closeTo(-0.1, 12) });
  });

  it("flips the sign for SHORT", () => {
    expect(label("SHORT", 9_997)).toMatchObject({ status: "HIT", y: 1 });
    expect(label("SHORT", 9_997.1)).toMatchObject({ status: "MISS", y: 0 });
    expect(label("SHORT", 10_003)).toMatchObject({ status: "MISS", y: 0 });
    expect(label("SHORT", 9_985)).toMatchObject({ status: "HIT", paid: true });
  });

  it("marks a call paid from a 0.15% move in its direction", () => {
    expect(label("LONG", 10_015)).toMatchObject({ status: "HIT", paid: true });
    expect(label("LONG", 10_014.9)).toMatchObject({ status: "HIT", paid: false });
    expect(label("SHORT", 10_015)).toMatchObject({ status: "MISS", paid: false });
  });

  it("scores NEUTRAL on its own: right when the index stayed within 0.15% either way", () => {
    expect(label("NEUTRAL", 10_014.9)).toEqual({ status: "NEUTRAL", y: 1, ret30Pct: expect.closeTo(0.149, 12), paid: null, source: "STORED", gradedMs: LATER });
    expect(label("NEUTRAL", 9_985.1)).toMatchObject({ status: "NEUTRAL", y: 1 });
    expect(label("NEUTRAL", 10_015)).toMatchObject({ status: "NEUTRAL", y: 0 });
    expect(label("NEUTRAL", 9_985)).toMatchObject({ status: "NEUTRAL", y: 0 });
  });

  it("censors decisions whose window ends after the close (after 15:00)", () => {
    const at15 = istAt("2026-10-19", "15:00");
    const closes = closesMap([{ barCloseMs: at15, close: 10_000 }, { barCloseMs: istAt("2026-10-19", "15:30"), close: 10_010 }]);
    expect(labelDecision({ barCloseMs: at15, direction: "LONG" }, closes, cal, LATER)).toMatchObject({ status: "HIT", y: 1 });
    expect(outcomeCensored(at15, cal)).toBe(false);
    const late = istAt("2026-10-19", "15:05");
    expect(outcomeCensored(late, cal)).toBe(true);
    expect(labelDecision({ barCloseMs: late, direction: "LONG" }, closes, cal, LATER)).toEqual({ status: "CENSORED", y: null, ret30Pct: null, paid: null, source: null, gradedMs: LATER });
  });

  it("is MISSING without both closes, or before the window has ended", () => {
    const one = closesMap([{ barCloseMs: T, close: 10_000 }]);
    expect(labelDecision({ barCloseMs: T, direction: "LONG" }, one, cal, LATER)).toEqual({ status: "MISSING", y: null, ret30Pct: null, paid: null, source: null, gradedMs: LATER });
    expect(labelDecision({ barCloseMs: T, direction: "LONG" }, at(10_000, 10_020), cal, T30 - 1).status).toBe("MISSING");
    expect(labelDecision({ barCloseMs: T, direction: "LONG" }, at(10_000, 10_020), cal, T30).status).toBe("HIT");
  });

  it("takes both closes from the archive when it has both bars, else both from the stored closes", () => {
    const stored = at(10_000, 10_002);
    const archive = closesMap([{ barCloseMs: T, close: 10_000 }, { barCloseMs: T30, close: 10_004 }]);
    // The stored closes say MISS (0.02%); the settled archive says HIT (0.04%) and wins.
    expect(labelDecision({ barCloseMs: T, direction: "LONG" }, stored, cal, LATER, archive)).toMatchObject({ status: "HIT", source: "BARS_5M" });
    // The archive lacks the first bar: never mix sources, use the stored closes for both ends.
    const half = closesMap([{ barCloseMs: T30, close: 10_004 }]);
    expect(labelDecision({ barCloseMs: T, direction: "LONG" }, stored, cal, LATER, half)).toMatchObject({ status: "MISS", source: "STORED", ret30Pct: expect.closeTo(0.02, 12) });
    // The 15:30 close only exists in the archive: the archive grades a 15:00 decision alone.
    const at15 = istAt("2026-10-19", "15:00");
    const storedLate = closesMap([{ barCloseMs: at15, close: 10_000 }]);
    const archiveLate = archiveClosesMap([{ t: at15 - 5 * MINUTE_MS, c: 10_000 }, { t: istAt("2026-10-19", "15:25"), c: 9_990 }]);
    expect(labelDecision({ barCloseMs: at15, direction: "SHORT" }, storedLate, cal, LATER, archiveLate)).toMatchObject({ status: "HIT", source: "BARS_5M" });
    expect(labelDecision({ barCloseMs: at15, direction: "SHORT" }, storedLate, cal, LATER, half).status).toBe("MISSING");
  });
});

describe("closes maps", () => {
  it("keys stored closes by bar close and skips closes that are not positive numbers", () => {
    const m = closesMap([
      { barCloseMs: 1, close: 10 },
      { barCloseMs: 2, close: Number.NaN },
      { barCloseMs: 3, close: 0 },
      { barCloseMs: 1, close: 11 },
    ]);
    expect([...m.entries()]).toEqual([[1, 11]]);
  });

  it("keys archive rows (bar open) by their bar close", () => {
    expect([...archiveClosesMap([{ t: T - 5 * MINUTE_MS, c: 25_000 }]).entries()]).toEqual([[T, 25_000]]);
  });
});
