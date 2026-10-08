"use client";

import { useEffect, useState } from "react";
import type { NiftyFeed } from "@/lib/market/niftyFeed";

/** How often the Live P&L page asks for a fresh NIFTY price. */
export const FEED_POLL_MS = 2000;

export type LoadedFeed = { feed: NiftyFeed; at: number };

/**
 * Polls /api/market/nifty about every 2 seconds. One request at a time: the next poll starts
 * FEED_POLL_MS after the last one started (or right after it ends when it ran long). Pauses while the tab is hidden.
 */
export function useNiftyFeed(expiry: string | null) {
  const [data, setData] = useState<LoadedFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const url = `/api/market/nifty${expiry ? `?expiry=${expiry}` : ""}`;

    const tick = async () => {
      const started = Date.now();
      if (!document.hidden) {
        try {
          const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
          const body = (await res.json()) as { ok: boolean; data?: NiftyFeed; error?: string };
          if (!stopped) {
            if (body.ok && body.data) {
              setData({ feed: body.data, at: Date.now() });
              setError(null);
            } else setError(body.error ?? `HTTP ${res.status}`);
          }
        } catch (e) {
          if (!stopped) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), Math.max(250, FEED_POLL_MS - (Date.now() - started)));
    };

    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [expiry]);

  return { data, error };
}
