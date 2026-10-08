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
// Tickets seen in this tab: the quantity shown while each was open (a closed record can list double,
// engine issue COPY-1), and which ids have been seen at all (to catch a trade that opened and closed
// between two polls). Per account and date.
// ---------------------------------------------------------------------------

export interface SeenTickets {
  /** Quantity shown while open, by ticket id. */
  openQty: Record<string, number>;
  /** Every ticket id seen (absent until the first look in this tab is recorded). */
  ids?: string[];
}

const seenListeners = new Set<() => void>();
const seenCache = new Map<string, SeenTickets | null>();
const seenKey = (account: string, date: string) => `copy:seen:${account}:${date}`;

export function readSeen(account: string, date: string): SeenTickets | null {
  const key = seenKey(account, date);
  if (!seenCache.has(key)) {
    let v: SeenTickets | null = null;
    try {
      const raw = readSession(key);
      v = raw ? (JSON.parse(raw) as SeenTickets) : null;
    } catch {
      v = null;
    }
    seenCache.set(key, v);
  }
  return seenCache.get(key) ?? null;
}

export function writeSeen(account: string, date: string, v: SeenTickets): void {
  const key = seenKey(account, date);
  seenCache.set(key, v);
  writeSession(key, JSON.stringify(v));
  seenListeners.forEach((l) => l());
}

function subscribeSeen(cb: () => void) {
  seenListeners.add(cb);
  return () => {
    seenListeners.delete(cb);
  };
}

export function useSeenTickets(account: string, date: string | null): SeenTickets | null {
  return useSyncExternalStore(
    subscribeSeen,
    () => (date ? readSeen(account, date) : null),
    () => null,
  );
}

// ---------------------------------------------------------------------------
// Exits acknowledged with "I've sold" (per account and date, for this tab)
// ---------------------------------------------------------------------------

const ackListeners = new Set<() => void>();
const ackCache = new Map<string, ReadonlySet<string>>();
const NO_ACKS: ReadonlySet<string> = new Set();
const ackKey = (account: string, date: string) => `copy:acked:${account}:${date}`;

function readAcked(account: string, date: string): ReadonlySet<string> {
  const key = ackKey(account, date);
  let v = ackCache.get(key);
  if (!v) {
    try {
      const raw = readSession(key);
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      v = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
    } catch {
      v = new Set();
    }
    ackCache.set(key, v);
  }
  return v;
}

export function ackExit(account: string, date: string, id: string): void {
  const next = new Set([...readAcked(account, date), id]);
  ackCache.set(ackKey(account, date), next);
  writeSession(ackKey(account, date), JSON.stringify([...next]));
  ackListeners.forEach((l) => l());
}

function subscribeAcks(cb: () => void) {
  ackListeners.add(cb);
  return () => {
    ackListeners.delete(cb);
  };
}

export function useAckedExits(account: string, date: string | null): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeAcks,
    () => (date ? readAcked(account, date) : NO_ACKS),
    () => NO_ACKS,
  );
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
