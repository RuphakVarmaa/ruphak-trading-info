"use client";

/**
 * One shared poll of /api/market/live per page, however many components read it: the first
 * subscriber starts the poll and the last one stops it. Every 1.5 s while the market is open or
 * in pre-open (by the payload's phase, else the IST clock), every 30 s otherwise; paused while
 * the tab is hidden. Most polls ask only for the recent bars (`?since=`) and join them to the bars
 * already here, so `data` always holds the whole session; every 20th poll fetches everything.
 */
import { useSyncExternalStore } from "react";
import { EnvelopeError, fetchEnvelope } from "@/hooks/engineFetch";
import { useClientNow } from "@/hooks/useEngineState";
import { fallbackPhase } from "@/components/shared/market";
import { freshnessOf, mergeBars, pollIntervalFor, sinceFor, type Freshness, type LiveIndicesFeed } from "@/lib/market/liveIndices";

export const LIVE_FEED_URL = "/api/market/live";

/** Every this many polls the whole session is fetched again; the others ask for the bars since the last ones. */
const FULL_EVERY = 20;

interface Snapshot {
  data: LiveIndicesFeed | null;
  /** Why the latest poll failed, as a plain sentence; null once a poll succeeds. */
  error: string | null;
  /** Browser time of the last good response. */
  at: number | null;
}

const EMPTY: Snapshot = { data: null, error: null, at: null };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
/** Good polls since the last full fetch. */
let polls = 0;

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

/** A failed poll as a plain sentence: the route's own sentence when it sent one, never an error code. */
function plainPollError(err: unknown): string {
  if (err instanceof EnvelopeError) {
    if (err.status === 0) return err.message === "Request timed out" ? "The server did not answer within 8 seconds." : "The server could not be reached.";
    if (err.message.startsWith("Unexpected response")) return "The server sent a response the page could not read.";
    return err.message;
  }
  return "The server could not be reached.";
}

function intervalNow(): number {
  return pollIntervalFor(snapshot.data?.marketPhase ?? fallbackPhase(Date.now()));
}

async function tick() {
  if (!running) return;
  const started = Date.now();
  let refetchNow = false;
  if (!document.hidden) {
    const since = polls % FULL_EVERY === 0 ? null : sinceFor(snapshot.data);
    try {
      const { data } = await fetchEnvelope<LiveIndicesFeed>(since != null ? `${LIVE_FEED_URL}?since=${since}` : LIVE_FEED_URL, {}, 8000);
      const merged = mergeBars(snapshot.data, data);
      if (merged) {
        polls += 1;
        if (running) emit({ data: merged, error: null, at: Date.now() });
      } else {
        // The update could not be joined to the bars here: fetch the whole feed at once.
        polls = 0;
        refetchNow = true;
      }
    } catch (err) {
      if (running) emit({ ...snapshot, error: plainPollError(err) });
    }
  }
  if (running) timer = setTimeout(() => void tick(), refetchNow ? 0 : Math.max(500, intervalNow() - (Date.now() - started)));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!running) {
    running = true;
    polls = 0;
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
  // Judged against the interval the poll is on, so the 30 s idle poll is not "stale" between polls.
  const pollMs = pollIntervalFor(s.data?.marketPhase ?? (now != null ? fallbackPhase(now) : "OPEN"));
  return { ...s, ageMs: s.at != null && now != null ? Math.max(0, now - s.at) : null, freshness: freshnessOf(s.at, now, pollMs) };
}
