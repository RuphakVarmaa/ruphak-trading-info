import { describe, expect, it } from "vitest";
import { addDays, formatIst, istAt, istDate, istMinutes, istParts, parseHHMM, weekdayOf } from "../clock";
import { TradingCalendar } from "./calendar";

const cal = new TradingCalendar();

describe("IST clock helpers", () => {
  it("converts epoch ms to IST parts", () => {
    // 2026-10-07 04:30:00Z is 10:00 IST on a Wednesday.
    const p = istParts(Date.UTC(2026, 9, 7, 4, 30));
    expect(p.date).toBe("2026-10-07");
    expect(p.hour).toBe(10);
    expect(p.minute).toBe(0);
    expect(p.weekday).toBe(3);
  });

  it("rolls the IST date over at 18:30 UTC", () => {
    expect(istDate(Date.UTC(2026, 9, 7, 18, 29))).toBe("2026-10-07");
    expect(istDate(Date.UTC(2026, 9, 7, 18, 30))).toBe("2026-10-08");
  });

  it("builds instants from IST wall-clock times", () => {
    const t = istAt("2026-10-07", "09:15");
    expect(new Date(t).toISOString()).toBe("2026-10-07T03:45:00.000Z");
    expect(istMinutes(t)).toBe(9 * 60 + 15);
    expect(formatIst(t)).toBe("2026-10-07 09:15:00 IST");
  });

  it("parses HH:MM strictly", () => {
    expect(parseHHMM("15:05")).toBe(905);
    expect(() => parseHHMM("25:00")).toThrow();
    expect(() => parseHHMM("9.15")).toThrow();
  });

  it("does date arithmetic across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-10-13")).toBe(2);
  });
});

describe("TradingCalendar", () => {
  it("knows weekends and the official 2026 holidays", () => {
    expect(cal.isTradingDay("2026-10-07")).toBe(true);
    expect(cal.isTradingDay("2026-10-10")).toBe(false); // Saturday
    expect(cal.isTradingDay("2026-10-20")).toBe(false); // Dussehra
    expect(cal.holidayName("2026-10-20")).toBe("Dussehra");
    expect(cal.isTradingDay("2026-11-10")).toBe(false); // Diwali Balipratipada
  });

  it("applies overrides", () => {
    const c = cal.withOverrides([
      { date: "2026-10-08", open: false, note: "Unscheduled closure" },
      { date: "2026-11-08", open: true, note: "Muhurat session" },
    ]);
    expect(c.isTradingDay("2026-10-08")).toBe(false);
    expect(c.holidayName("2026-10-08")).toBe("Unscheduled closure");
    expect(c.isTradingDay("2026-11-08")).toBe(true);
  });

  it("classifies session phases", () => {
    expect(cal.sessionPhase(istAt("2026-10-07", "08:59"))).toBe("CLOSED");
    expect(cal.sessionPhase(istAt("2026-10-07", "09:05"))).toBe("PRE_OPEN");
    expect(cal.sessionPhase(istAt("2026-10-07", "09:15"))).toBe("OPEN");
    expect(cal.sessionPhase(istAt("2026-10-07", "15:29"))).toBe("OPEN");
    expect(cal.sessionPhase(istAt("2026-10-07", "15:30"))).toBe("CLOSED");
    expect(cal.sessionPhase(istAt("2026-10-20", "11:00"))).toBe("HOLIDAY");
  });

  it("finds next and previous trading days around holidays", () => {
    expect(cal.nextTradingDay("2026-10-19")).toBe("2026-10-21");
    expect(cal.prevTradingDay("2026-10-21")).toBe("2026-10-19");
    expect(cal.nextTradingDay("2026-10-09")).toBe("2026-10-12");
    expect(cal.tradingDaysBetween("2026-10-16", "2026-10-21")).toBe(2); // Mon 19, Wed 21
    expect(cal.tradingDaysBetween("2026-10-21", "2026-10-21")).toBe(0);
  });

  it("computes next session open and previous close", () => {
    expect(cal.nextOpenMs(istAt("2026-10-09", "16:00"))).toBe(istAt("2026-10-12", "09:15"));
    expect(cal.nextOpenMs(istAt("2026-10-07", "08:00"))).toBe(istAt("2026-10-07", "09:15"));
    expect(cal.prevCloseMs(istAt("2026-10-12", "09:20"))).toBe(istAt("2026-10-09", "15:30"));
    expect(cal.prevCloseMs(istAt("2026-10-07", "16:00"))).toBe(istAt("2026-10-07", "15:30"));
  });

  it("picks NIFTY Tuesday and SENSEX Thursday weekly expiries", () => {
    expect(cal.nextExpiry("NIFTY", istAt("2026-10-07", "10:00"))).toBe("2026-10-13");
    expect(cal.nextExpiry("SENSEX", istAt("2026-10-07", "10:00"))).toBe("2026-10-08");
    expect(cal.nextExpiry("NIFTY", istAt("2026-10-13", "11:00"))).toBe("2026-10-13");
    // After the 13 Oct close the next contract is the holiday-shifted Monday 19 Oct expiry.
    expect(cal.nextExpiry("NIFTY", istAt("2026-10-13", "15:31"))).toBe("2026-10-19");
  });

  it("moves an expiry that falls on a holiday to the previous trading day", () => {
    // Tuesday 2026-10-20 is Dussehra, so that week's NIFTY contract expires Monday 2026-10-19.
    expect(cal.expiryOnOrAfter("NIFTY", "2026-10-14")).toBe("2026-10-19");
    expect(cal.nextExpiry("NIFTY", istAt("2026-10-19", "15:31"))).toBe("2026-10-27");
    // Tuesday 2026-11-10 (Balipratipada) and 2026-11-24 (Guru Nanak Jayanti).
    expect(cal.expiryOnOrAfter("NIFTY", "2026-11-04")).toBe("2026-11-09");
    expect(cal.expiryOnOrAfter("NIFTY", "2026-11-18")).toBe("2026-11-23");
    expect(cal.isExpiryDay("NIFTY", "2026-11-09")).toBe(true);
    expect(cal.isExpiryDay("NIFTY", "2026-11-10")).toBe(false);
  });

  it("returns the following weekly contract", () => {
    expect(cal.followingExpiry("NIFTY", "2026-10-13")).toBe("2026-10-19");
    expect(cal.followingExpiry("NIFTY", "2026-10-19")).toBe("2026-10-27");
    expect(cal.followingExpiry("SENSEX", "2026-10-08")).toBe("2026-10-15");
  });

  it("lists scheduled events with generated expiries", () => {
    const evs = cal.scheduledEvents(istAt("2026-10-12", "00:00"), istAt("2026-10-16", "00:00"));
    const ids = evs.map((e) => e.id);
    expect(ids).toContain("expiry-nifty-2026-10-13");
    expect(ids).toContain("expiry-sensex-2026-10-15");
    expect(ids).toContain("uscpi-2026-10");
    expect(ids).toContain("incpi-2026-10");
    for (let i = 1; i < evs.length; i++) expect(evs[i].at).toBeGreaterThanOrEqual(evs[i - 1].at);
  });

  it("finds the next and recent macro events", () => {
    const next = cal.nextScheduledEvent(istAt("2026-10-07", "09:30"), ["HIGH"]);
    expect(next?.id).toBe("rbi-2026-10");
    const recent = cal.recentScheduledEvent(istAt("2026-10-07", "10:20"), 30, ["HIGH"]);
    expect(recent?.id).toBe("rbi-2026-10");
    expect(cal.recentScheduledEvent(istAt("2026-10-07", "10:45"), 30, ["HIGH"])).toBeNull();
    const overnight = cal.eventsSinceLastClose(istAt("2026-10-29", "09:20")).map((e) => e.id);
    expect(overnight).toContain("fomc-2026-10");
  });
});
