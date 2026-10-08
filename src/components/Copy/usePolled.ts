"use client";

import { useEffect, useState } from "react";
import { errorText, fetchEnvelope } from "@/hooks/engineFetch";

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** Browser time of the last good response. */
  at: number | null;
}

/**
 * Polls an envelope route (`{ ok, data }`) every `intervalMs`, one request at a time, skipping polls
 * while the tab is hidden. A null `url` stops polling. Data from a previous URL is never returned.
 */
export function usePolled<T>(url: string | null, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T> & { url: string | null }>({ url: null, data: null, error: null, at: null });

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const started = Date.now();
      if (!document.hidden) {
        try {
          const { data } = await fetchEnvelope<T>(url);
          if (!stopped) setState({ url, data, error: null, at: Date.now() });
        } catch (err) {
          if (!stopped) setState((s) => (s.url === url ? { ...s, error: errorText(err) } : { url, data: null, error: errorText(err), at: null }));
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), Math.max(500, intervalMs - (Date.now() - started)));
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [url, intervalMs]);

  return state.url === url ? { data: state.data, error: state.error, at: state.at } : { data: null, error: null, at: null };
}
