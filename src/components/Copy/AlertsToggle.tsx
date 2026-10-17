"use client";

/**
 * "Turn on sound and desktop alerts": remembered in this browser. The explanation shows once, next to
 * the button, until alerts are on; afterwards only what still needs the user (a blocked permission,
 * or one tap after a reload so the browser allows sound).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { C } from "@/components/shared/colors";
import { Btn } from "@/components/shared/ui";
import { askNoticePermission, chime, noticePermission, setAlertsOn, unlockAudio, useAlertsOn, type NoticePermission } from "./alerts";

// Notification permission, re-read whenever this page asks for it.
const permListeners = new Set<() => void>();
let permCache: NoticePermission | null = null;
function readPerm(): NoticePermission {
  permCache ??= noticePermission();
  return permCache;
}
function refreshPerm(p: NoticePermission) {
  permCache = p;
  permListeners.forEach((l) => l());
}
function subscribePerm(cb: () => void) {
  permListeners.add(cb);
  return () => {
    permListeners.delete(cb);
  };
}

export const ALERTS_EXPLAINED =
  "It chimes, vibrates on phones and shows a desktop notification whenever NIFTY or SENSEX changes to ENTER NOW, PAUSED, MANAGE or EXIT NOW, once per change. Keep this tab open: browsers slow down background tabs, so an alert there can come up to a minute late. Telegram alerts arrive even with the tab closed, once the engine's bot is set up.";

export default function AlertsToggle({ compact = false }: { compact?: boolean }) {
  const on = useAlertsOn();
  const perm = useSyncExternalStore(subscribePerm, readPerm, () => "default" as NoticePermission);
  const [soundOk, setSoundOk] = useState(false);

  // After a reload the browser allows sound only after one tap or key press on the page.
  useEffect(() => {
    if (!on) return;
    const unlock = () => {
      unlockAudio();
      setSoundOk(true);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [on]);

  const turnOn = async () => {
    unlockAudio();
    setSoundOk(true);
    setAlertsOn(true);
    chime("ENTER_NOW");
    refreshPerm(await askNoticePermission());
  };

  if (!on) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", minWidth: 0 }}>
        <Btn variant="gold" onClick={() => void turnOn()} title={ALERTS_EXPLAINED} style={{ minHeight: 44 }}>
          🔔 {compact ? "Turn on alerts" : "Turn on sound and desktop alerts"}
        </Btn>
      </div>
    );
  }

  const notes: string[] = [];
  if (perm === "denied") notes.push("Desktop notifications are blocked for this site in the browser settings; the chime still plays.");
  if (perm === "unsupported") notes.push("This browser cannot show desktop notifications here; the chime still plays.");
  if (!soundOk) notes.push("Tap the page once to allow the chime (browsers need one tap after a reload).");
  notes.push("Keep this tab open: background tabs can delay alerts by up to a minute.");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: C.textStrong }}>🔔 Alerts on</span>
      <Btn variant="ghost" onClick={() => setAlertsOn(false)} style={{ minHeight: 44, textDecoration: "underline" }}>
        Turn off
      </Btn>
      {notes.map((n) => (
        <span key={n} style={{ flex: "1 1 240px", fontSize: 12, color: C.muted, lineHeight: 1.45 }}>
          {n}
        </span>
      ))}
    </div>
  );
}
