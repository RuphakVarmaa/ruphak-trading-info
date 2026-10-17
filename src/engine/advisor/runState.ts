/**
 * The advisor's run state and rate limit (pure, unit-tested; the AdvisorDO stores it). A run may start when
 * none is queued or running, at least ADVISOR_MIN_GAP_MIN minutes after the last start, and at most
 * ADVISOR_MAX_RUNS_PER_DAY times per IST day. A run stuck for 10 minutes is cleared as failed. One automatic
 * run a trading day (ADVISOR_AUTO_RUN, "09:25" IST by default; "off" disables it).
 */
import type { AdvisorReport, AdvisorReportSummary, AdvisorView } from "../api-types";
import { addDays, istAt, istDate, istIso, istMinutes, parseHHMM } from "../clock";

export const RUN_TIMEOUT_MS = 10 * 60_000;
export const HISTORY_MAX = 20;
/** Minutes after the auto-run time during which the minute cron may still start it. */
export const AUTO_RUN_WINDOW_MIN = 10;

export interface AdvisorSettings {
  model: string;
  maxRunsPerDay: number;
  minGapMin: number;
  /** IST minutes of the day for the daily automatic run; null when switched off. */
  autoRunAtMin: number | null;
}

export interface AdvisorVars {
  ADVISOR_MODEL?: string;
  ADVISOR_MAX_RUNS_PER_DAY?: string;
  ADVISOR_MIN_GAP_MIN?: string;
  ADVISOR_AUTO_RUN?: string;
}

const intIn = (raw: string | undefined, lo: number, hi: number, fallback: number) => {
  const n = Number(raw);
  return raw != null && raw.trim() !== "" && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

export function parseAdvisorSettings(v: AdvisorVars): AdvisorSettings {
  const model = (v.ADVISOR_MODEL ?? "").trim() || "claude-opus-5-5";
  const auto = (v.ADVISOR_AUTO_RUN ?? "09:25").trim().toLowerCase();
  let autoRunAtMin: number | null = null;
  if (auto !== "off" && auto !== "false" && auto !== "") {
    try {
      const m = parseHHMM(auto);
      autoRunAtMin = m >= 9 * 60 + 15 && m < 15 * 60 + 30 ? m : 9 * 60 + 25;
    } catch {
      autoRunAtMin = 9 * 60 + 25;
    }
  }
  return { model, maxRunsPerDay: intIn(v.ADVISOR_MAX_RUNS_PER_DAY, 1, 200, 24), minGapMin: intIn(v.ADVISOR_MIN_GAP_MIN, 1, 240, 4), autoRunAtMin };
}

export interface AdvisorMeta {
  status: AdvisorView["status"];
  lastError: string | null;
  runningSince: number | null;
  queuedAt: number | null;
  lastStartMs: number | null;
  /** The IST date `runsToday` counts. */
  day: string | null;
  runsToday: number;
  lastReason: string | null;
  lastAutoRunDate: string | null;
  /** The last run's dropped ideas and fixes (plain words; for the log, not the dashboard). */
  lastNotes: string[];
}

export const INITIAL_META: AdvisorMeta = {
  status: "idle",
  lastError: null,
  runningSince: null,
  queuedAt: null,
  lastStartMs: null,
  day: null,
  runsToday: 0,
  lastReason: null,
  lastAutoRunDate: null,
  lastNotes: [],
};

/** Rolls the day counter at IST midnight and clears a run stuck for 10 minutes. */
export function normalizeMeta(meta: AdvisorMeta | undefined | null, nowMs: number): AdvisorMeta {
  const m: AdvisorMeta = { ...INITIAL_META, ...(meta ?? {}) };
  const today = istDate(nowMs);
  if (m.day !== today) {
    m.day = today;
    m.runsToday = 0;
  }
  const since = m.status === "running" ? m.runningSince : m.status === "queued" ? m.queuedAt : null;
  if (since != null && nowMs - since > RUN_TIMEOUT_MS) {
    m.lastError =
      m.status === "running" ? "The last analysis took longer than 10 minutes and was stopped. Press Analyze to try again." : "The last analysis never started (it waited more than 10 minutes). Press Analyze to try again.";
    m.status = "error";
    m.runningSince = null;
    m.queuedAt = null;
  }
  return m;
}

/** When the next run may start (epoch ms), or null when one may start now. Expects a normalized meta. */
export function nextAllowedAt(m: AdvisorMeta, nowMs: number, s: AdvisorSettings): number | null {
  if (m.runsToday >= s.maxRunsPerDay) return istAt(addDays(istDate(nowMs), 1), 0);
  if (m.lastStartMs != null && nowMs < m.lastStartMs + s.minGapMin * 60_000) return m.lastStartMs + s.minGapMin * 60_000;
  return null;
}

export type RunRequest = { meta: AdvisorMeta; start: boolean; why: "started" | "busy" | "rate_limited" };

export function requestRun(meta: AdvisorMeta | undefined | null, nowMs: number, s: AdvisorSettings, reason: string): RunRequest {
  const m = normalizeMeta(meta, nowMs);
  if (m.status === "queued" || m.status === "running") return { meta: m, start: false, why: "busy" };
  if (nextAllowedAt(m, nowMs, s) != null) return { meta: m, start: false, why: "rate_limited" };
  return {
    meta: { ...m, status: "queued", queuedAt: nowMs, lastStartMs: nowMs, runsToday: m.runsToday + 1, lastReason: cleanReason(reason), lastError: null },
    start: true,
    why: "started",
  };
}

/** Trimmed to 100 characters, control characters removed. */
export function cleanReason(reason: unknown): string {
  return (typeof reason === "string" ? reason : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "manual";
}

/** The daily automatic run is due: a trading day, inside its 10-minute window, not run yet today. */
export function autoRunDue(m: AdvisorMeta, nowMs: number, s: AdvisorSettings, isTradingDay: (date: string) => boolean): boolean {
  if (s.autoRunAtMin == null) return false;
  const today = istDate(nowMs);
  if (m.lastAutoRunDate === today || !isTradingDay(today)) return false;
  const min = istMinutes(nowMs);
  return min >= s.autoRunAtMin && min < s.autoRunAtMin + AUTO_RUN_WINDOW_MIN;
}

export function markRunning(m: AdvisorMeta, nowMs: number): AdvisorMeta {
  return { ...m, status: "running", runningSince: nowMs, queuedAt: null };
}

export function markFinished(m: AdvisorMeta, error: string | null, notes: string[] = []): AdvisorMeta {
  return { ...m, status: error ? "error" : "idle", lastError: error, runningSince: null, queuedAt: null, lastNotes: notes.slice(0, 30) };
}

export function pushHistory(history: readonly AdvisorReportSummary[] | undefined | null, s: AdvisorReportSummary, max = HISTORY_MAX): AdvisorReportSummary[] {
  return [s, ...(history ?? []).filter((h) => h.id !== s.id)].slice(0, max);
}

export function toView(meta: AdvisorMeta, latest: AdvisorReport | null, history: readonly AdvisorReportSummary[] | null, nowMs: number, s: AdvisorSettings, disabledReason: string | null = null): AdvisorView {
  const next = meta.status === "queued" || meta.status === "running" ? null : nextAllowedAt(meta, nowMs, s);
  return {
    status: meta.status,
    lastError: disabledReason ?? meta.lastError,
    runningSince: meta.runningSince != null ? istIso(meta.runningSince) : meta.queuedAt != null ? istIso(meta.queuedAt) : null,
    nextAllowedAt: next != null ? istIso(next) : null,
    runsToday: meta.runsToday,
    maxRunsPerDay: s.maxRunsPerDay,
    latest,
    history: [...(history ?? [])],
  };
}
