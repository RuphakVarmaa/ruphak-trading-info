"use client";

import { useClientNow } from "@/hooks/useEngineState";
import { REFRESH_CLOSED_MS } from "@/lib/refresh";
import { marketPollMs } from "./flowView";

/**
 * The poll interval for the market's state now: `openMs` from 09:15 to 15:30 IST on weekdays, the closed
 * interval otherwise, on the engine's clock (the browser's plus `offsetMs`; the mock runs a simulated
 * session). It reads the page's one-second clock store, so render never calls Date.now. `nowMs` is the
 * browser clock (null during server render and hydration).
 */
export function useMarketPollMs(openMs: number, offsetMs = 0): { pollMs: number; nowMs: number | null } {
  const now = useClientNow();
  if (now == null) return { pollMs: REFRESH_CLOSED_MS, nowMs: null };
  return { pollMs: marketPollMs(now + offsetMs, openMs), nowMs: now };
}
