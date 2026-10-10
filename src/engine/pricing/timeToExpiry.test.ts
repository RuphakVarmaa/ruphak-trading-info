import { describe, expect, it } from "vitest";
import { TradingCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG } from "../config";
import { expiryCloseMs, tradingMinutesBetween, yearsToExpiry } from "./timeToExpiry";

const cal = new TradingCalendar();
const MINUTES_PER_YEAR = 375 * 252;

describe("tradingMinutesBetween", () => {
  it("counts only session minutes on the same day", () => {
    expect(tradingMinutesBetween(istAt("2026-10-07", "10:00"), istAt("2026-10-07", "11:30"), cal)).toBe(90);
    expect(tradingMinutesBetween(istAt("2026-10-07", "08:00"), istAt("2026-10-07", "18:00"), cal)).toBe(375);
    expect(tradingMinutesBetween(istAt("2026-10-07", "16:00"), istAt("2026-10-07", "17:00"), cal)).toBe(0);
    expect(tradingMinutesBetween(istAt("2026-10-07", "11:00") + 30_000, istAt("2026-10-07", "11:01"), cal)).toBe(0.5);
  });

  it("skips weekends", () => {
    // Friday 15:00 -> Monday 09:45: 30 + 30 minutes.
    expect(tradingMinutesBetween(istAt("2026-10-09", "15:00"), istAt("2026-10-12", "09:45"), cal)).toBe(60);
  });

  it("skips exchange holidays (Dussehra, Tuesday 2026-10-20)", () => {
    expect(cal.isTradingDay("2026-10-20")).toBe(false);
    expect(tradingMinutesBetween(istAt("2026-10-19", "15:00"), istAt("2026-10-21", "09:45"), cal)).toBe(60);
    // Gandhi Jayanti (Friday 2026-10-02) plus the weekend: Thursday close -> Monday open is zero.
    expect(tradingMinutesBetween(istAt("2026-10-01", "15:30"), istAt("2026-10-05", "09:15"), cal)).toBe(0);
  });

  it("is zero or positive only", () => {
    expect(tradingMinutesBetween(istAt("2026-10-08", "10:00"), istAt("2026-10-07", "10:00"), cal)).toBe(0);
    expect(tradingMinutesBetween(Number.NaN, istAt("2026-10-07", "10:00"), cal)).toBe(0);
  });
});

describe("yearsToExpiry", () => {
  it("measures trading time to 15:30 IST on the expiry date", () => {
    expect(expiryCloseMs("2026-10-13")).toBe(istAt("2026-10-13", "15:30"));
    // Wed 2026-10-07 11:00 -> Tue 2026-10-13 15:30: 270 today + Thu, Fri, Mon, Tue full sessions.
    const y = yearsToExpiry(istAt("2026-10-07", "11:00"), "2026-10-13", cal, DEFAULT_CONFIG);
    expect(y * MINUTES_PER_YEAR).toBeCloseTo(270 + 4 * 375, 9);
  });

  it("handles expiry day and floors at one minute", () => {
    expect(yearsToExpiry(istAt("2026-10-13", "14:30"), "2026-10-13", cal, DEFAULT_CONFIG) * MINUTES_PER_YEAR).toBeCloseTo(60, 9);
    expect(yearsToExpiry(istAt("2026-10-13", "15:29") + 30_000, "2026-10-13", cal, DEFAULT_CONFIG) * MINUTES_PER_YEAR).toBeCloseTo(1, 9);
    expect(yearsToExpiry(istAt("2026-10-13", "16:00"), "2026-10-13", cal, DEFAULT_CONFIG)).toBeCloseTo(1 / MINUTES_PER_YEAR, 15);
    expect(yearsToExpiry(istAt("2026-10-14", "10:00"), "2026-10-13", cal, DEFAULT_CONFIG)).toBeCloseTo(1 / MINUTES_PER_YEAR, 15);
  });

  it("carries no decay over a holiday-shifted weekly expiry weekend", () => {
    // Friday 15:30 -> Monday 2026-10-19 (expiry moved from the Tuesday holiday): exactly one session.
    const y = yearsToExpiry(istAt("2026-10-16", "15:30"), "2026-10-19", cal, DEFAULT_CONFIG);
    expect(y * MINUTES_PER_YEAR).toBeCloseTo(375, 9);
  });
});
