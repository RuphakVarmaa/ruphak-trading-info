"use client";

/** Copy controls for the copy page: every target is a real button at least 44 px tall. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { alpha, C } from "@/components/shared/colors";

/** Copies text; falls back to a hidden text area where the async clipboard is missing (older phones, plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the text-area copy.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" });
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type Flash = "idle" | "copied" | "failed";

/** "copied" (or "failed") for 1.6 s after a copy attempt. */
function useCopyFlash(): [Flash, (text: string) => void] {
  const [flash, setFlash] = useState<Flash>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = (text: string) => {
    void copyText(text).then((ok) => {
      setFlash(ok ? "copied" : "failed");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash("idle"), 1600);
    });
  };
  return [flash, run];
}

/** A large copy button ("Copy order"). `tone` "action" is the terracotta call to act. */
export function CopyAction({ text, label, tone = "action", style }: { text: string; label: string; tone?: "action" | "quiet"; style?: CSSProperties }) {
  const [flash, run] = useCopyFlash();
  const action = tone === "action";
  return (
    <button
      type="button"
      onClick={() => run(text)}
      aria-label={`${label}: ${text}`}
      style={{
        minHeight: 48,
        padding: "10px 18px",
        borderRadius: 10,
        border: `1px solid ${action ? C.gold : C.borderStrong}`,
        background: action ? C.gold : C.panel,
        color: action ? "#fff" : C.textStrong,
        fontSize: 16,
        fontWeight: 700,
        cursor: "pointer",
        lineHeight: 1.2,
        ...style,
      }}
    >
      {flash === "copied" ? "Copied ✓" : flash === "failed" ? "Copy failed: press and hold the text" : label}
    </button>
  );
}

/**
 * One value of the trade as a tap-to-copy tile: a small label, the value in large type and a hint.
 * `copy` is what lands on the clipboard (default: `value` when it is plain text).
 */
export function CopyTile({
  label,
  value,
  copy,
  sub,
  valueColor,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  copy: string;
  sub?: ReactNode;
  valueColor?: string;
  /** Terracotta frame: the value the order needs first. */
  emphasis?: boolean;
}) {
  const [flash, run] = useCopyFlash();
  return (
    <button
      type="button"
      onClick={() => run(copy)}
      aria-label={`Copy ${label}: ${copy}`}
      style={{
        display: "grid",
        alignContent: "start",
        gap: 3,
        minHeight: 72,
        minWidth: 0,
        width: "100%",
        padding: "10px 12px",
        textAlign: "left",
        borderRadius: 10,
        border: `1px solid ${emphasis ? alpha(C.gold, 0.55) : C.border}`,
        background: emphasis ? alpha(C.gold, 0.05) : C.panelAlt,
        color: C.textStrong,
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 12, color: C.muted, fontWeight: 600 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span aria-hidden style={{ color: flash === "copied" ? C.green : flash === "failed" ? C.red : C.muted3, fontWeight: 600, whiteSpace: "nowrap" }}>
          {flash === "copied" ? "copied ✓" : flash === "failed" ? "copy failed" : "copy"}
        </span>
      </span>
      <span className="tnum" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: valueColor ?? C.textStrong, overflowWrap: "anywhere" }}>
        {value}
      </span>
      {sub != null && <span style={{ fontSize: 12, color: C.muted2, lineHeight: 1.35 }}>{sub}</span>}
    </button>
  );
}
