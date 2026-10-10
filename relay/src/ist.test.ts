import { describe, expect, it } from "vitest";
import { describeIst, istDate, istDayStartMs, istParts, nextIstTime, parseHhMm, parseIstTimestamp, parseWindow } from "./ist.js";

describe("IST helpers", () => {
  it("converts UTC to IST wall-clock parts", () => {
    const p = istParts(Date.parse("2026-10-06T05:10:00Z"));
    expect(p).toMatchObject({ date: "2026-10-06", hour: 10, minute: 40, weekday: 2 });
    // 20:00 UTC is already the next IST day.
    expect(istDate(Date.parse("2026-10-06T20:00:00Z"))).toBe("2026-10-07");
    expect(describeIst(Date.parse("2026-10-06T05:10:00Z"))).toBe("Tue 2026-10-06 10:40:00 IST");
  });

  it("finds the IST day start and the next 06:00 IST", () => {
    const t = Date.parse("2026-10-06T05:10:00Z"); // 10:40 IST
    expect(new Date(istDayStartMs(t)).toISOString()).toBe("2026-10-05T18:30:00.000Z");
    expect(new Date(nextIstTime(t, 360)).toISOString()).toBe("2026-10-07T00:30:00.000Z");
    const early = Date.parse("2026-10-06T00:00:00Z"); // 05:30 IST
    expect(new Date(nextIstTime(early, 360)).toISOString()).toBe("2026-10-06T00:30:00.000Z");
  });

  it("parses windows and times", () => {
    expect(parseHhMm("09:16")).toBe(556);
    expect(parseWindow("09:16-15:12")).toEqual({ startMin: 556, endMin: 912 });
    expect(() => parseWindow("15:12-09:16")).toThrow();
    expect(() => parseHhMm("24:00")).toThrow();
  });

  it("reads Groww-style timestamps (no offset = IST)", () => {
    expect(parseIstTimestamp("2026-10-07T06:00:00")).toBe(Date.parse("2026-10-07T00:30:00Z"));
    expect(parseIstTimestamp("2026-10-07 06:00:00")).toBe(Date.parse("2026-10-07T00:30:00Z"));
    expect(parseIstTimestamp("2026-10-07T00:30:00Z")).toBe(Date.parse("2026-10-07T00:30:00Z"));
    expect(parseIstTimestamp(1791340200)).toBe(1791340200000);
    expect(parseIstTimestamp(1791340200000)).toBe(1791340200000);
    expect(parseIstTimestamp("garbage")).toBeNull();
    expect(parseIstTimestamp(undefined)).toBeNull();
  });
});
