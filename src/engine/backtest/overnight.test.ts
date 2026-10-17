import { describe, expect, it } from "vitest";
import { pairedGap } from "./intraday1m";
import { calendarDays, fairCoinDays, gapThroughStop, halves, needsChange, nightKind, nightsBetween, passesFilter, tailRisk } from "./overnight";

describe("nightKind and calendarDays", () => {
  it("tells weekday, weekend and holiday nights apart by the days between the sessions", () => {
    // Thu 8 Oct 2026 → Fri 9 Oct: the next calendar day.
    expect(nightKind("2026-10-08", "2026-10-09")).toBe("weekday");
    // Fri 9 Oct → Mon 12 Oct: only Saturday and Sunday between.
    expect(nightKind("2026-10-09", "2026-10-12")).toBe("weekend");
    expect(calendarDays("2026-10-09", "2026-10-12")).toBe(3);
    // Tue 1 Oct 2024 → Thu 3 Oct (Gandhi Jayanti on Wed 2 Oct): a weekday without a session between makes it a holiday night.
    expect(nightKind("2024-10-01", "2024-10-03")).toBe("holiday");
    // Thu → Mon over a Friday holiday (Good Friday 2024: Thu 28 Mar → Mon 1 Apr).
    expect(nightKind("2024-03-28", "2024-04-01")).toBe("holiday");
    expect(calendarDays("2024-12-31", "2025-01-01")).toBe(1);
    expect(nightKind("2024-12-31", "2025-01-01")).toBe("weekday");
  });

  it("refuses a night that does not move forward", () => {
    expect(() => nightKind("2026-10-09", "2026-10-09")).toThrow();
    expect(() => nightKind("2026-10-09", "2026-10-08")).toThrow();
  });
});

describe("nightsBetween", () => {
  const special = new Set(["2024-11-01", "2025-02-01"]); // a Friday Muhurat day, a Saturday Budget session

  it("pairs consecutive regular sessions and lists the special sessions between them", () => {
    const sessions = ["2024-10-30", "2024-10-31", "2024-11-01", "2024-11-04", "2025-01-31", "2025-02-01", "2025-02-03", "2025-02-04"];
    const n = nightsBetween([...sessions].reverse(), (d) => special.has(d));
    expect(n.map((x) => `${x.d}→${x.e}`)).toEqual(["2024-10-30→2024-10-31", "2024-10-31→2024-11-04", "2024-11-04→2025-01-31", "2025-01-31→2025-02-03", "2025-02-03→2025-02-04"]);
    expect(n[0]).toMatchObject({ kind: "weekday", calendarDays: 1, spans: [] });
    // Thu 31 Oct → Mon 4 Nov 2024 spans the Muhurat session of Fri 1 Nov (a weekday without a regular session).
    expect(n[1]).toMatchObject({ kind: "holiday", calendarDays: 4, spans: ["2024-11-01"] });
    // Fri 31 Jan → Mon 3 Feb 2025 spans the Saturday Budget session.
    expect(n[3]).toMatchObject({ kind: "weekend", spans: ["2025-02-01"] });
    expect(n[4].spans).toEqual([]);
  });

  it("drops duplicate sessions and never starts or ends a night on a special session", () => {
    const n = nightsBetween(["2025-02-01", "2025-01-31", "2025-01-31", "2025-02-03"], (d) => special.has(d));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ d: "2025-01-31", e: "2025-02-03", spans: ["2025-02-01"] });
    // A special session before the first regular one starts nothing and is listed nowhere.
    expect(nightsBetween(["2025-02-01", "2025-02-03", "2025-02-04"], (d) => special.has(d))).toEqual([{ d: "2025-02-03", e: "2025-02-04", kind: "weekday", calendarDays: 1, spans: [] }]);
  });
});

describe("passesFilter", () => {
  const wk = { kind: "weekday" as const, change: -0.004 };
  const fri = { kind: "weekend" as const, change: 0.002 };
  const hol = { kind: "holiday" as const, change: -0.012 };
  const unknown = { kind: "weekday" as const, change: null };

  it("selects nights by calendar kind and by the change from the previous close", () => {
    expect([wk, fri, hol, unknown].map((n) => passesFilter("all", n))).toEqual([true, true, true, true]);
    expect([wk, fri, hol].map((n) => passesFilter("weekday", n))).toEqual([true, false, false]);
    expect([wk, fri, hol].map((n) => passesFilter("weekend", n))).toEqual([false, true, true]);
    expect([wk, fri, hol].map((n) => passesFilter("down", n))).toEqual([true, false, true]);
    expect([wk, fri, hol].map((n) => passesFilter("up", n))).toEqual([false, true, false]);
    expect([wk, fri, hol].map((n) => passesFilter("selloff", n))).toEqual([false, false, true]);
  });

  it("uses the sell-off threshold inclusively and never selects a night whose change is unknown", () => {
    expect(passesFilter("selloff", { kind: "weekday", change: -0.01 })).toBe(true);
    expect(passesFilter("selloff", { kind: "weekday", change: -0.0099 })).toBe(false);
    expect(passesFilter("selloff", { kind: "weekday", change: -0.009 }, -0.008)).toBe(true);
    expect(passesFilter("selloff", { kind: "weekday", change: -0.011 }, -0.012)).toBe(false);
    expect(passesFilter("down", { kind: "weekday", change: 0 })).toBe(false);
    expect(passesFilter("up", { kind: "weekday", change: 0 })).toBe(false);
    for (const f of ["down", "up", "selloff"] as const) expect(passesFilter(f, unknown)).toBe(false);
    expect(["all", "weekday", "weekend", "down", "up", "selloff"].map((f) => needsChange(f as never))).toEqual([false, false, false, true, true, true]);
  });
});

describe("fairCoinDays", () => {
  it("compares the side taken with a fair coin between it and the opposite side", () => {
    const days = fairCoinDays([
      { s: 300, o: -100 },
      { s: -200, o: 400 },
      { s: 100, o: 100 },
    ]);
    expect(days).toEqual([
      { n: 1, s: 300, p: 100 },
      { n: 1, s: -200, p: 100 },
      { n: 1, s: 100, p: 100 },
    ]);
    // The gap is the mean of (s − o) / 2: (200 − 300 + 0) / 3.
    expect(pairedGap(days).gap).toBeCloseTo(-100 / 3, 10);
  });
});

describe("tailRisk", () => {
  it("returns the count-th worst value and the mean of the worst share", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i - 50); // −50 … 49
    expect(tailRisk(xs, 0.05)).toEqual({ count: 5, var: -46, es: -48 });
    expect(tailRisk(xs, 0.01)).toEqual({ count: 1, var: -50, es: -50 });
  });

  it("keeps at least one value and handles an empty series", () => {
    expect(tailRisk([3, -7, 1], 0.05)).toEqual({ count: 1, var: -7, es: -7 });
    const e = tailRisk([], 0.05);
    expect(e.count).toBe(0);
    expect(Number.isNaN(e.var) && Number.isNaN(e.es)).toBe(true);
  });
});

describe("gapThroughStop", () => {
  it("fills a stop the next session gapped through at the first price, not at the stop", () => {
    // A ₹100 call with a 30% stop at ₹70 that opens at ₹40: the stop fills at ₹40, ₹30 beyond the stop.
    expect(gapThroughStop(100, 40, 0.3)).toEqual({ stopPx: 70, gapped: true, fill: 40, beyondStop: 30 });
    // Opening exactly at the stop counts as reached (it fills there).
    expect(gapThroughStop(100, 70, 0.3)).toMatchObject({ gapped: true, fill: 70, beyondStop: 0 });
    // Opening above the stop: nothing is triggered by the gap.
    expect(gapThroughStop(100, 85, 0.3)).toEqual({ stopPx: 70, gapped: false, fill: null, beyondStop: 0 });
  });
});

describe("halves", () => {
  it("splits a dated list by count after sorting, the first half taking the odd one", () => {
    const xs = ["2024-01-05", "2024-01-01", "2024-01-03", "2024-01-02", "2024-01-04"].map((day) => ({ day }));
    const [a, b] = halves(xs);
    expect(a.map((x) => x.day)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(b.map((x) => x.day)).toEqual(["2024-01-04", "2024-01-05"]);
    expect(halves([])).toEqual([[], []]);
  });
});
