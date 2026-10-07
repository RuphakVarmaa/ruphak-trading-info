"use client";

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  timer ??= setInterval(() => listeners.forEach((l) => l()), 1000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const utcTime = () => new Date().toUTCString().slice(17, 25);
const serverTime = () => "";

/** HH:MM:SS in UTC, ticking every second. Empty during SSR and hydration (no mismatch). */
export function useUtcTime(): string {
  return useSyncExternalStore(subscribe, utcTime, serverTime);
}
