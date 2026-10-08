"use client";

/**
 * One poll per URL per page, however many components read it (the action strip and the copy page both
 * read today's trades). The fastest subscriber's interval wins. Unlike the dashboard's other polls, a
 * `background` subscriber keeps polling while the tab is hidden (every 15 s at most), so a status change
 * can still chime and notify; it polls at once when the tab comes back.
 */
import { useCallback, useSyncExternalStore } from "react";
import { errorText, fetchEnvelope } from "@/hooks/engineFetch";

export interface PollState<T> {
  data: T | null;
  /** "CODE: message" of the last failed request (cleared by the next good one). */
  error: string | null;
  /** Browser time of the last good response. */
  at: number | null;
}

interface Sub {
  intervalMs: number;
  background: boolean;
}

interface Entry {
  url: string;
  state: PollState<unknown>;
  listeners: Set<() => void>;
  subs: Map<number, Sub>;
  timer: ReturnType<typeof setTimeout> | undefined;
  inflight: boolean;
  lastAttempt: number;
}

/** A hidden tab polls no faster than this. */
const HIDDEN_MS = 15_000;
const EMPTY: PollState<never> = { data: null, error: null, at: null };
const entries = new Map<string, Entry>();
let subSeq = 0;
let visibilityHooked = false;

function plan(e: Entry): Sub {
  let intervalMs = Infinity;
  let background = false;
  for (const s of e.subs.values()) {
    intervalMs = Math.min(intervalMs, s.intervalMs);
    background ||= s.background;
  }
  return { intervalMs: Number.isFinite(intervalMs) ? intervalMs : 60_000, background };
}

function schedule(e: Entry, delay: number) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => void tick(e), Math.max(0, delay));
}

async function tick(e: Entry): Promise<void> {
  e.timer = undefined;
  if (e.subs.size === 0 || e.inflight) return;
  const { intervalMs, background } = plan(e);
  const hidden = document.hidden;
  const started = Date.now();
  if (!hidden || background) {
    e.inflight = true;
    e.lastAttempt = started;
    try {
      const { data } = await fetchEnvelope<unknown>(e.url);
      e.state = { data, error: null, at: Date.now() };
    } catch (err) {
      e.state = { ...e.state, error: errorText(err) };
    }
    e.inflight = false;
    e.listeners.forEach((l) => l());
  }
  if (e.subs.size === 0) return;
  const wait = document.hidden ? Math.max(intervalMs, HIDDEN_MS) : intervalMs;
  schedule(e, Math.max(500, wait - (Date.now() - started)));
}

function hookVisibility() {
  if (visibilityHooked) return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const now = Date.now();
    for (const e of entries.values()) {
      if (e.subs.size === 0 || e.inflight) continue;
      if (now - e.lastAttempt >= plan(e).intervalMs) schedule(e, 0);
    }
  });
}

function subscribe(url: string, sub: Sub, cb: () => void): () => void {
  hookVisibility();
  let e = entries.get(url);
  if (!e) {
    e = { url, state: EMPTY, listeners: new Set(), subs: new Map(), timer: undefined, inflight: false, lastAttempt: 0 };
    entries.set(url, e);
  }
  const entry = e;
  const id = ++subSeq;
  entry.subs.set(id, sub);
  entry.listeners.add(cb);
  // First subscriber, or one that wants it sooner than the running schedule: poll now.
  if (!entry.inflight && (entry.timer === undefined || Date.now() - entry.lastAttempt >= sub.intervalMs)) schedule(entry, 0);
  return () => {
    entry.subs.delete(id);
    entry.listeners.delete(cb);
    if (entry.subs.size === 0) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  };
}

const serverSnapshot = () => EMPTY;

/** Polls an /api envelope route shared across the page; a null `url` reads nothing. */
export function useSharedPoll<T>(url: string | null, intervalMs: number, background = false): PollState<T> {
  const sub = useCallback((cb: () => void) => (url ? subscribe(url, { intervalMs, background }, cb) : () => {}), [url, intervalMs, background]);
  const get = useCallback(() => (url ? (entries.get(url)?.state ?? EMPTY) : EMPTY), [url]);
  return useSyncExternalStore(sub, get, serverSnapshot) as PollState<T>;
}

/** "CODE: message" from the dashboard's fetch helpers, as a plain sentence (never the code). */
export function plainError(raw: string | null, what = "the trading engine"): string | null {
  if (!raw) return null;
  const code = /^([A-Z_]+):/.exec(raw)?.[1] ?? "";
  if (code === "ENGINE_UNREACHABLE") return `Can't reach ${what} right now.`;
  if (code === "NOT_FOUND") return "Nothing has been published for this yet.";
  if (code === "UNAUTHORIZED" || code === "ADMIN_DISABLED") return "This page is not allowed to read that.";
  if (code === "BAD_REQUEST") return "The request was not accepted.";
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} returned an error.`;
}
