"use client";

/**
 * Status-change alerts for the copy page: a chime (Web Audio, no file to load), a vibration on phones
 * and a desktop notification, each time an index's status changes to ENTER NOW, PAUSED, MANAGE or
 * EXIT NOW. Exactly once per change: the last status seen per account and index is kept in
 * sessionStorage, so a refresh does not repeat an alert, and the first look after opening a tab only
 * records the status. A PAUSED status must last 3 s before it alerts (a tab coming back to the front
 * pauses for a moment while the live feed catches up).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { IndexId } from "@/engine/api-types";
import { KIND_LABEL, type ActionKind, type IndexAction } from "@/lib/copy/action";
import { readSession, writeSession } from "./clientStores";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
export const PAUSE_ALERT_DELAY_MS = 3_000;

// ---------------------------------------------------------------------------
// Sound, vibration, notifications
// ---------------------------------------------------------------------------

let audio: AudioContext | null = null;

/** Creates (or resumes) the shared audio context; browsers allow it only after a click or tap. */
export function unlockAudio(): void {
  try {
    if (!audio) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      audio = new Ctx();
    }
    if (audio.state === "suspended") void audio.resume();
  } catch {
    // No audio on this browser: the notification and the page still show the change.
  }
}

const TONES: Record<ActionKind, number[]> = {
  ENTER_NOW: [660, 880, 1100],
  EXIT_NOW: [1100, 880, 660],
  MANAGE: [700, 700],
  PAUSED: [440, 350],
  WAIT: [],
  DONE: [],
  LOADING: [],
};

export function chime(kind: ActionKind): void {
  const notes = TONES[kind];
  if (notes.length === 0) return;
  unlockAudio();
  const ctx = audio;
  if (!ctx) return;
  try {
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t0 = ctx.currentTime + i * 0.17;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.36);
    });
  } catch {
    // Audio refused (no user gesture yet): the notification still shows.
  }
}

function vibrate(kind: ActionKind): void {
  try {
    navigator.vibrate?.(kind === "ENTER_NOW" || kind === "EXIT_NOW" ? [220, 120, 220] : [140]);
  } catch {
    // Not supported (desktop, iOS).
  }
}

export type NoticePermission = "granted" | "denied" | "default" | "unsupported";

export function noticePermission(): NoticePermission {
  try {
    return "Notification" in window ? Notification.permission : "unsupported";
  } catch {
    return "unsupported";
  }
}

export async function askNoticePermission(): Promise<NoticePermission> {
  try {
    if (!("Notification" in window)) return "unsupported";
    if (Notification.permission === "default") return await Notification.requestPermission();
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

function desktopNotice(title: string, body: string, tag: string, urgent: boolean): void {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag, requireInteraction: urgent });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker: sound and vibration remain.
  }
}

/** Chime, vibrate and notify for one status. */
export function announce(a: IndexAction): void {
  chime(a.kind);
  vibrate(a.kind);
  if (a.notice) desktopNotice(a.notice.title, a.notice.body, `copy-${a.index}`, a.kind === "ENTER_NOW" || a.kind === "EXIT_NOW");
}

// ---------------------------------------------------------------------------
// "Alerts on" (this browser), read with useSyncExternalStore
// ---------------------------------------------------------------------------

const ON_KEY = "copy:alerts";
const onListeners = new Set<() => void>();
let memoryOn = false;

function readOn(): boolean {
  try {
    return window.localStorage.getItem(ON_KEY) === "on";
  } catch {
    return memoryOn;
  }
}

export function setAlertsOn(on: boolean): void {
  memoryOn = on;
  try {
    if (on) window.localStorage.setItem(ON_KEY, "on");
    else window.localStorage.removeItem(ON_KEY);
  } catch {
    // Remembered for this page only.
  }
  onListeners.forEach((l) => l());
}

function subscribeOn(cb: () => void) {
  onListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ON_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    onListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAlertsOn(): boolean {
  return useSyncExternalStore(subscribeOn, readOn, () => false);
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

const statusKey = (account: string, index: IndexId) => `copy:status:${account}:${index}`;

/**
 * Announces each status change once. `ready`: the trade list and the live feed have both answered,
 * so the statuses are real (not "loading").
 */
export function useActionAlerts(actions: Record<IndexId, IndexAction> | null, account: string, ready: boolean): void {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  const keys = actions ? INDICES.map((i) => `${actions[i].statusKey}|${actions[i].alert ? 1 : 0}`).join(",") : "";

  useEffect(() => {
    const acts = latest.current;
    if (!ready || !acts) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const index of INDICES) {
      const a = acts[index];
      const key = statusKey(account, index);
      const prev = readSession(key);
      if (prev === a.statusKey) continue;
      if (prev == null || !a.alert) {
        // The first look in this tab, or a status that never alerts: remember it quietly.
        writeSession(key, a.statusKey);
        continue;
      }
      const fire = () => {
        writeSession(key, a.statusKey);
        if (readOn()) announce(a);
      };
      if (a.kind === "PAUSED") timers.push(setTimeout(fire, PAUSE_ALERT_DELAY_MS));
      else fire();
    }
    return () => timers.forEach(clearTimeout);
  }, [keys, account, ready]);
}

/** "● ENTER NOW NIFTY" for the tab title, from the most urgent status (null when nothing is live). */
export function titleBadge(actions: Record<IndexId, IndexAction> | null): string | null {
  if (!actions) return null;
  const order: ActionKind[] = ["EXIT_NOW", "ENTER_NOW", "PAUSED", "MANAGE"];
  for (const kind of order) {
    const a = INDICES.map((i) => actions[i]).find((x) => x.kind === kind);
    if (a) return `● ${KIND_LABEL[kind]} ${a.index}`;
  }
  return null;
}
