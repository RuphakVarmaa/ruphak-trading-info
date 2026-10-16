import { describe, expect, it } from "vitest";
import type { AdvisorReportSummary } from "../api-types";
import { INITIAL_META, RUN_TIMEOUT_MS, autoRunDue, cleanReason, markFinished, markRunning, nextAllowedAt, normalizeMeta, parseAdvisorSettings, pushHistory, requestRun, toView } from "./runState";

const ist = (s: string) => Date.parse(`${s}+05:30`);
const S = parseAdvisorSettings({});
const T0 = ist("2026-10-16T10:00:00");

describe("settings", () => {
  it("defaults to Opus 5.5, 24 runs a day, 4 minutes apart and a 09:25 automatic brief", () => {
    expect(S).toEqual({ model: "claude-opus-5-5", maxRunsPerDay: 24, minGapMin: 4, autoRunAtMin: 9 * 60 + 25 });
    expect(parseAdvisorSettings({ ADVISOR_MODEL: "claude-sonnet-5-5", ADVISOR_MAX_RUNS_PER_DAY: "3", ADVISOR_MIN_GAP_MIN: "10", ADVISOR_AUTO_RUN: "off" })).toEqual({ model: "claude-sonnet-5-5", maxRunsPerDay: 3, minGapMin: 10, autoRunAtMin: null });
    expect(parseAdvisorSettings({ ADVISOR_MAX_RUNS_PER_DAY: "lots", ADVISOR_MIN_GAP_MIN: "-1", ADVISOR_AUTO_RUN: "10:05" })).toMatchObject({ maxRunsPerDay: 24, minGapMin: 4, autoRunAtMin: 605 });
  });
});

describe("the rate limit", () => {
  it("starts a run, then refuses while it is queued or running", () => {
    const first = requestRun(INITIAL_META, T0, S, "  owner pressed Analyze  ");
    expect(first.start).toBe(true);
    expect(first.meta).toMatchObject({ status: "queued", queuedAt: T0, lastStartMs: T0, runsToday: 1, lastReason: "owner pressed Analyze", day: "2026-10-16" });
    expect(requestRun(first.meta, T0 + 1000, S, "again")).toMatchObject({ start: false, why: "busy" });
    expect(requestRun(markRunning(first.meta, T0 + 500), T0 + 60_000, S, "again")).toMatchObject({ start: false, why: "busy" });
  });

  it("waits at least 4 minutes between starts and says when the next is allowed", () => {
    const done = markFinished(requestRun(INITIAL_META, T0, S, "x").meta, null);
    const early = requestRun(done, T0 + 3 * 60_000, S, "y");
    expect(early).toMatchObject({ start: false, why: "rate_limited" });
    expect(nextAllowedAt(early.meta, T0 + 3 * 60_000, S)).toBe(T0 + 4 * 60_000);
    expect(toView(early.meta, null, [], T0 + 3 * 60_000, S).nextAllowedAt).toBe("2026-10-16T10:04:00+05:30");
    expect(requestRun(done, T0 + 4 * 60_000, S, "y").start).toBe(true);
  });

  it("allows at most 24 runs an IST day, and counts again from midnight", () => {
    const full = { ...INITIAL_META, day: "2026-10-16", runsToday: 24, lastStartMs: T0 - 3_600_000 };
    expect(requestRun(full, T0, S, "x")).toMatchObject({ start: false, why: "rate_limited" });
    expect(nextAllowedAt(normalizeMeta(full, T0), T0, S)).toBe(ist("2026-10-17T00:00:00"));
    const nextDay = requestRun(full, ist("2026-10-17T09:30:00"), S, "x");
    expect(nextDay.start).toBe(true);
    expect(nextDay.meta.runsToday).toBe(1);
  });

  it("clears a run stuck for 10 minutes as an error in plain words", () => {
    const running = markRunning(requestRun(INITIAL_META, T0, S, "x").meta, T0);
    const later = normalizeMeta(running, T0 + RUN_TIMEOUT_MS + 1);
    expect(later.status).toBe("error");
    expect(later.lastError).toMatch(/longer than 10 minutes/);
    expect(requestRun(later, T0 + RUN_TIMEOUT_MS + 1, S, "retry").start).toBe(true);
    expect(normalizeMeta(running, T0 + 60_000).status).toBe("running");
  });

  it("trims the reason to 100 characters", () => {
    expect(cleanReason("x".repeat(300))).toHaveLength(100);
    expect(cleanReason("a\nb\u0000c")).toBe("a b c");
    expect(cleanReason(undefined)).toBe("manual");
  });
});

describe("finishing, the view and history", () => {
  it("keeps the previous brief on failure and shows the error", () => {
    const failed = markFinished(markRunning(requestRun(INITIAL_META, T0, S, "x").meta, T0), "The brief could not be written: HTTP 529.");
    const v = toView(failed, null, [], T0 + 5 * 60_000, S);
    expect(v).toMatchObject({ status: "error", lastError: "The brief could not be written: HTTP 529.", runningSince: null, nextAllowedAt: null, runsToday: 1, maxRunsPerDay: 24 });
    const ok = markFinished(markRunning(requestRun(INITIAL_META, T0, S, "x").meta, T0), null, ["dropped: x"]);
    expect(ok).toMatchObject({ status: "idle", lastError: null, lastNotes: ["dropped: x"] });
    expect(toView(requestRun(INITIAL_META, T0, S, "x").meta, null, [], T0, S, "switched off").lastError).toBe("switched off");
  });

  it("keeps the last 20 summaries, newest first", () => {
    const s = (i: number): AdvisorReportSummary => ({ id: `r${i}`, createdAt: "", headline: "", todayAction: "WAIT", ideas: [] });
    let h: AdvisorReportSummary[] = [];
    for (let i = 0; i < 25; i++) h = pushHistory(h, s(i));
    expect(h).toHaveLength(20);
    expect(h[0].id).toBe("r24");
    expect(h[19].id).toBe("r5");
  });

  it("runs the automatic brief once a trading day, inside its window", () => {
    const trading = () => true;
    expect(autoRunDue(INITIAL_META, ist("2026-10-16T09:25:30"), S, trading)).toBe(true);
    expect(autoRunDue(INITIAL_META, ist("2026-10-16T09:24:00"), S, trading)).toBe(false);
    expect(autoRunDue(INITIAL_META, ist("2026-10-16T09:40:00"), S, trading)).toBe(false);
    expect(autoRunDue({ ...INITIAL_META, lastAutoRunDate: "2026-10-16" }, ist("2026-10-16T09:26:00"), S, trading)).toBe(false);
    expect(autoRunDue(INITIAL_META, ist("2026-10-17T09:26:00"), S, () => false)).toBe(false);
    expect(autoRunDue(INITIAL_META, ist("2026-10-16T09:26:00"), { ...S, autoRunAtMin: null }, trading)).toBe(false);
  });
});
