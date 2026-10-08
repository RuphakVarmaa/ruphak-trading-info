"use client";

/**
 * One shared poll of /api/market/live per page, however many components read it: the first
 * subscriber starts the poll and the last one stops it. Every 1.5 s while the market is open or
 * in pre-open (by the payload's phase, else the IST clock), every 30 s otherwise; paused while
 * the tab is hidden.
 */
import { useSyncExternalStore } from "react";
import { errorText, fetchEnvelope } from "@/hooks/engineFetch";
import { useClientNow } from "@/hooks/useEngineState";
import { fallbackPhase } from "@/components/shared/market";
import { freshnessOf, IDLE_POLL_MS, LIVE_POLL_MS, type Freshness, type LiveIndicesFeed } from "@/lib/market/liveIndices";

export const LIVE_FEED_URL = "/api/market/live";

interface Snapshot {
  data: LiveIndicesFeed | null;
  error: string | null;
  /** Browser time of the last good response. */
  at: number | null;
}

const EMPTY: Snapshot = { data: null, error: null, at: null };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

function intervalNow(): number {
  const phase = snapshot.data?.marketPhase ?? fallbackPhase(Date.now());
  return phase === "OPEN" || phase === "PRE_OPEN" ? LIVE_POLL_MS : IDLE_POLL_MS;
}

async function tick() {
  if (!running) return;
  const started = Date.now();
  if (!document.hidden) {
    try {
      const { data } = await fetchEnvelope<LiveIndicesFeed>(LIVE_FEED_URL, {}, 8000);
      if (running) emit({ data, error: null, at: Date.now() });
    } catch (err) {
      if (running) emit({ ...snapshot, error: errorText(err) });
    }
  }
  if (running) timer = setTimeout(() => void tick(), Math.max(500, intervalNow() - (Date.now() - started)));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!running) {
    running = true;
    timer = setTimeout(() => void tick(), 0);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      running = false;
      clearTimeout(timer);
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export interface LiveIndicesState extends Snapshot {
  /** Milliseconds since the last good response (browser clock); null before the first. */
  ageMs: number | null;
  freshness: Freshness;
}

export function useLiveIndices(): LiveIndicesState {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const now = useClientNow();
  return { ...s, ageMs: s.at != null && now != null ? Math.max(0, now - s.at) : null, freshness: freshnessOf(s.at, now) };
}
