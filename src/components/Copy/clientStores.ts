"use client";

/**
 * Tiny browser stores for the copy page, read with useSyncExternalStore:
 * - the skip latch: ticket ids whose index was seen past the skip level (kept for this tab, so a
 *   refresh does not turn a too-late trade back into ENTER NOW);
 * - session values with an in-memory fallback (private windows can refuse sessionStorage);
 * - whether the tab is hidden.
 */
import { useSyncExternalStore } from "react";

const memory = new Map<string, string>();

export function readSession(key: string): string | null {
  try {
    const v = window.sessionStorage.getItem(key);
    if (v != null) return v;
  } catch {
    // Storage refused: the in-memory copy below still works for this page.
  }
  return memory.get(key) ?? null;
}

export function writeSession(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Kept in memory only.
  }
}

// ---------------------------------------------------------------------------
// Skip latch
// ---------------------------------------------------------------------------

const LATCH_KEY = "copy:skip-latched";
const latchListeners = new Set<() => void>();
const NO_IDS: ReadonlySet<string> = new Set();
let latched: ReadonlySet<string> | null = null;

function loadLatched(): ReadonlySet<string> {
  if (latched) return latched;
  try {
    const raw = readSession(LATCH_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    latched = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    latched = new Set();
  }
  return latched;
}

export function latchSkip(id: string): void {
  const now = loadLatched();
  if (now.has(id)) return;
  latched = new Set([...now, id]);
  writeSession(LATCH_KEY, JSON.stringify([...latched].slice(-50)));
  latchListeners.forEach((l) => l());
}

function subscribeLatch(cb: () => void) {
  latchListeners.add(cb);
  return () => {
    latchListeners.delete(cb);
  };
}

export function useSkipLatch(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeLatch, loadLatched, () => NO_IDS);
}

// ---------------------------------------------------------------------------
// Tab visibility
// ---------------------------------------------------------------------------

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.hidden,
    () => false,
  );
}
