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
import type { CopyTicketView, IndexId } from "@/engine/api-types";
import { EXIT_WINDOW_MS, EXIT_WORDS, hm, KIND_LABEL, type ActionKind, type IndexAction } from "@/lib/copy/action";
import { decideAlert } from "@/lib/copy/alertRules";
import { readSeen, readSession, writeSeen, writeSession } from "./clientStores";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];

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
      const enteredKey = `copy:entered:${account}`;
      const entered = new Set<string>(JSON.parse(readSession(enteredKey) ?? "[]") as string[]);
      const d = decideAlert(a, { last: readSession(key), entered });
      const remember = () => {
        writeSession(key, d.record);
        if (d.enteredId && !entered.has(d.enteredId)) writeSession(enteredKey, JSON.stringify([...entered, d.enteredId].slice(-50)));
      };
      if (!d.fire) {
        if (readSession(key) !== d.record || d.enteredId) remember();
        continue;
      }
      const fire = () => {
        remember();
        if (readOn()) announce(a);
      };
      if (d.delayMs > 0) timers.push(setTimeout(fire, d.delayMs));
      else fire();
    }
    return () => timers.forEach(clearTimeout);
  }, [keys, account, ready]);
}

/**
 * A trade that opened and closed between two polls and was first seen after its EXIT NOW window
 * (a sleeping laptop, a throttled background tab) never shows a status of its own: announce it once.
 * The first look in a tab only records what is there.
 */
export function useMissedTradeAlerts(tickets: CopyTicketView[] | null, account: string, date: string | null, nowMs: number | null, ready: boolean): void {
  useEffect(() => {
    if (!ready || !tickets || !date || nowMs == null) return;
    const prev = readSeen(account, date);
    const firstLook = prev?.ids == null;
    const known = new Set(prev?.ids ?? []);
    const fresh = tickets.filter((t) => !known.has(t.id));
    if (!firstLook && fresh.length === 0) return;
    if (!firstLook) {
      for (const t of fresh) {
        const x = t.exit;
        if (t.status !== "CLOSED" || !x || nowMs - Date.parse(x.at) <= EXIT_WINDOW_MS) continue;
        const name = `${t.index} ${t.contract.strike} ${t.contract.optionType}`;
        const body = `${name} opened at ${hm(t.entry.at)} and closed at ${hm(x.at)} IST (${EXIT_WORDS[x.reason]}) between two updates. Nothing to do unless you bought it; if you did, sell it now.`;
        if (readOn()) {
          chime("EXIT_NOW");
          vibrate("EXIT_NOW");
          desktopNotice(`MISSED TRADE · ${t.index}`, body, `copy-missed-${t.id}`, true);
        }
      }
    }
    writeSeen(account, date, { openQty: prev?.openQty ?? {}, ids: [...known, ...fresh.map((t) => t.id)] });
  }, [tickets, account, date, nowMs, ready]);
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
