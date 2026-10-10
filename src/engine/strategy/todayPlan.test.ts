import { describe, expect, it } from "vitest";
import { defaultCalendar } from "../calendar/calendar";
import { istAt } from "../clock";
import { DEFAULT_CONFIG, type EngineConfig } from "../config";
import type { IndexId, N2Daily, ScheduledEvent } from "../types";
import { BIG_GAP_PCT, buildTodayPlan, eventCheck, expiryChecks, gapCheck, planSession, planWindows, volatilityCheck, type PlanCalendar } from "./todayPlan";

const paused: EngineConfig = { ...DEFAULT_CONFIG, gates: { ...DEFAULT_CONFIG.gates, expectedMoveModel: "calibrated" } };

/** The bundled calendar with its scheduled events replaced (expiry and trading-day logic stay real). */
function withEvents(events: ScheduledEvent[]): PlanCalendar {
  return {
    isTradingDay: (d) => defaultCalendar.isTradingDay(d),
    nextTradingDay: (d) => defaultCalendar.nextTradingDay(d),
    tradingDaysBetween: (a, b) => defaultCalendar.tradingDaysBetween(a, b),
    openMs: (d) => defaultCalendar.openMs(d),
    closeMs: (d) => defaultCalendar.closeMs(d),
    expiryOnOrAfter: (i, d) => defaultCalendar.expiryOnOrAfter(i, d),
    followingExpiry: (i, e) => defaultCalendar.followingExpiry(i, e),
    isExpiryDay: (i, d) => defaultCalendar.isExpiryDay(i, d),
    scheduledEvents: (from, to) => events.filter((e) => e.at >= from && e.at <= to),
  };
}

const ev = (title: string, at: number, impact: ScheduledEvent["impact"], indices: IndexId[] = ["NIFTY", "SENSEX"]): ScheduledEvent => ({ id: title, kind: "OTHER", title, at, impact, indices });

const calm: N2Daily = { lastSession: "2026-10-09", vix5dChangePct: 2.1, vixPctile: 0.4, vixPctileN: 251, run5dPct: 0.8 };

describe("today's plan: the session and its windows", () => {
  it("plans today before the close, and the next trading day after it or on a non-trading day", () => {
    expect(planSession(istAt("2026-10-12", "08:30"), defaultCalendar)).toEqual({ date: "2026-10-12", when: "today" });
    expect(planSession(istAt("2026-10-12", "15:31"), defaultCalendar)).toEqual({ date: "2026-10-13", when: "next" });
    expect(planSession(istAt("2026-10-10", "12:00"), defaultCalendar)).toEqual({ date: "2026-10-12", when: "next" }); // Saturday
    expect(planSession(istAt("2026-10-20", "10:00"), defaultCalendar)).toEqual({ date: "2026-10-21", when: "next" }); // Dussehra
  });

  it("lays out the plan's windows: avoid the opening minutes, buy only 09:30–11:15, out by 15:05", () => {
    const w = planWindows(DEFAULT_CONFIG);
    expect(w.map((x) => [x.from, x.to, x.kind])).toEqual([
      ["09:15", "09:30", "avoid"],
      ["09:30", "11:15", "trade"],
      ["11:15", "14:15", "avoid"],
      ["14:15", "15:05", "avoid"],
      ["15:05", "15:30", "close"],
    ]);
    expect(w[0].why).toContain("₹2,176");
  });
});

describe("today's plan: the rules", () => {
  it("N1 blocks the session before a high-impact event and cautions one inside the session or a medium one after it", () => {
    const usCpi = ev("US CPI (September)", istAt("2026-10-14", "18:00"), "HIGH");
    expect(eventCheck("NIFTY", "2026-10-14", withEvents([usCpi]), DEFAULT_CONFIG)).toMatchObject({ rule: "N1", status: "block" });
    // An event in the next session's hours also blocks the session before it.
    const rbi = ev("RBI policy", istAt("2026-10-16", "10:00"), "HIGH");
    expect(eventCheck("SENSEX", "2026-10-15", withEvents([rbi]), DEFAULT_CONFIG).status).toBe("block");
    const inside = eventCheck("NIFTY", "2026-10-16", withEvents([rbi]), DEFAULT_CONFIG);
    expect(inside.status).toBe("caution");
    expect(inside.detail).toContain("09:30 to 10:30");
    const cpi = ev("India CPI inflation", istAt("2026-10-12", "16:00"), "MED");
    expect(eventCheck("NIFTY", "2026-10-12", withEvents([cpi]), DEFAULT_CONFIG).status).toBe("caution");
    expect(eventCheck("NIFTY", "2026-10-12", withEvents([ev("Other index", istAt("2026-10-12", "18:00"), "HIGH", ["SENSEX"])]), DEFAULT_CONFIG).status).toBe("clear");
  });

  it("N2 blocks a VIX jump, a high VIX or a big run, counts today's VIX only once open, and says when data is missing", () => {
    expect(volatilityCheck(calm, null, DEFAULT_CONFIG).status).toBe("clear");
    expect(volatilityCheck({ ...calm, vix5dChangePct: 12 }, null, DEFAULT_CONFIG)).toMatchObject({ status: "block" });
    expect(volatilityCheck({ ...calm, vixPctile: 0.8 }, null, DEFAULT_CONFIG).detail).toContain("80th percentile");
    expect(volatilityCheck({ ...calm, vixPctile: 0.62 }, null, DEFAULT_CONFIG).detail).toContain("62nd percentile of its year");
    expect(volatilityCheck({ ...calm, run5dPct: -2.5 }, null, DEFAULT_CONFIG).detail).toContain("−2.50% over 5 sessions");
    expect(volatilityCheck(calm, 9, DEFAULT_CONFIG).status).toBe("block");
    expect(volatilityCheck({ ...calm, vixPctile: null }, null, DEFAULT_CONFIG).status).toBe("unknown");
    expect(volatilityCheck(null, null, DEFAULT_CONFIG).status).toBe("unknown");
  });

  it("N4 moves a one-session contract to the following week; N7 marks the index's own expiry day", () => {
    // Monday 12 Oct 2026: NIFTY's contract expires Tuesday (1 session left), so the 19 Oct one (Dussehra-shifted).
    const mon = expiryChecks("NIFTY", "2026-10-12", defaultCalendar);
    expect(mon.checks.map((c) => [c.rule, c.status])).toEqual([
      ["N4", "caution"],
      ["N7", "clear"],
    ]);
    expect(mon).toMatchObject({ expiry: "2026-10-19", sessionsLeft: 5 });
    // Tuesday 13 Oct: NIFTY's expiry day; never today's contract, so the 19 Oct one (4 sessions).
    const tue = expiryChecks("NIFTY", "2026-10-13", defaultCalendar);
    expect(tue.checks.map((c) => [c.rule, c.status])).toEqual([
      ["N4", "clear"],
      ["N7", "caution"],
    ]);
    expect(tue).toMatchObject({ expiry: "2026-10-19", sessionsLeft: 4 });
    expect(expiryChecks("SENSEX", "2026-10-12", defaultCalendar)).toMatchObject({ expiry: "2026-10-15", sessionsLeft: 3 });
  });

  it("N9 cautions a big gap, before the open from the estimate and after it from the actual open", () => {
    expect(gapCheck(BIG_GAP_PCT + 0.15, null, false).status).toBe("caution");
    expect(gapCheck(0.1, null, false).status).toBe("clear");
    expect(gapCheck(null, null, false).status).toBe("unknown");
    expect(gapCheck(0.1, -0.6, true)).toMatchObject({ status: "caution" });
    expect(gapCheck(0.1, -0.6, true).detail).toContain("Opened −0.60%");
  });
});

describe("buildTodayPlan", () => {
  const mondayMorning = istAt("2026-10-12", "08:40");
  const snapshot = {
    t: istAt("2026-10-12", "08:30"),
    features: { NIFTY: { vixChangePct: 1.2, expectedGapPct: 0.12, gapPct: 0 }, SENSEX: { vixChangePct: 1.2, expectedGapPct: 0.1, gapPct: 0 } },
    daily: { NIFTY: calm, SENSEX: { ...calm, vix5dChangePct: 14 } },
  };

  it("puts the checks together per index, with buying paused as in production", () => {
    const plan = buildTodayPlan({ nowMs: mondayMorning, calendar: withEvents([]), cfg: paused, snapshot });
    expect(plan).toMatchObject({ date: "2026-10-12", when: "today", buyingPaused: true, asOf: "2026-10-12T08:30:00+05:30" });
    expect(plan.pausedReason).toContain("EDGE_GATE=calibrated");
    const [nifty, sensex] = plan.indices;
    expect(nifty).toMatchObject({ index: "NIFTY", verdict: "caution", expectedGapPct: 0.12, gapPct: null, expiry: "2026-10-19" });
    expect(nifty.checks.map((c) => c.rule)).toEqual(["N1", "N2", "N4", "N7", "N9"]);
    // Before the open, today's VIX change is not counted (the 1.2% in the snapshot is the last session's).
    expect(nifty.checks.find((c) => c.rule === "N2")!.detail).not.toContain("today");
    expect(sensex.verdict).toBe("no_trade");
    expect(sensex.headline).toContain("volatility jump or a big run");
  });

  it("reports buying as not paused with the legacy gate, and marks market checks unknown without a fresh snapshot", () => {
    const stale = { ...snapshot, t: mondayMorning - 3 * 24 * 3_600_000 };
    const plan = buildTodayPlan({ nowMs: mondayMorning, calendar: withEvents([]), cfg: DEFAULT_CONFIG, snapshot: stale });
    expect(plan.buyingPaused).toBe(false);
    expect(plan.pausedReason).toBeNull();
    for (const p of plan.indices) {
      expect(p.checks.find((c) => c.rule === "N2")!.status).toBe("unknown");
      expect(p.checks.find((c) => c.rule === "N9")!.status).toBe("unknown");
      expect(p.expectedGapPct).toBeNull();
    }
    const none = buildTodayPlan({ nowMs: mondayMorning, calendar: withEvents([]), cfg: paused, snapshot: null });
    expect(none.asOf).toBeNull();
    expect(none.indices).toHaveLength(2);
    // Missing inputs never read as clear.
    const sensex = none.indices[1];
    expect(sensex.checks.filter((c) => c.status === "unknown").map((c) => c.rule)).toEqual(["N2", "N9"]);
    expect(sensex.verdict).toBe("caution");
    expect(sensex.headline).toContain("no data yet for: volatility jump or a big run; the opening gap");
  });

  it("uses the actual gap and today's VIX change once the session has opened", () => {
    const open = istAt("2026-10-12", "10:00");
    const plan = buildTodayPlan({
      nowMs: open,
      calendar: withEvents([]),
      cfg: paused,
      snapshot: { ...snapshot, t: istAt("2026-10-12", "09:59"), features: { NIFTY: { vixChangePct: 9.5, expectedGapPct: 0.1, gapPct: 0.42 }, SENSEX: { vixChangePct: 0.5, expectedGapPct: 0.1, gapPct: 0.05 } } },
    });
    const nifty = plan.indices[0];
    expect(nifty.gapPct).toBe(0.42);
    expect(nifty.checks.find((c) => c.rule === "N2")!.status).toBe("block"); // VIX +9.5% today
    expect(nifty.checks.find((c) => c.rule === "N9")!.status).toBe("caution");
  });
});
