"use client";

import { useClientNow, useClockOffset, useEngineState } from "@/hooks/useEngineState";
import { alpha, C } from "@/components/shared/colors";
import { fmtAge, fmtIstTime } from "@/components/shared/format";
import { Btn } from "@/components/shared/ui";

/** Shown only when the FAST tier is stale or offline; the desk keeps rendering last good data. */
export default function ConnectionBanner() {
  const { status, tiers, actions } = useEngineState();
  const now = useClientNow();
  // Poll times are on the browser clock; show them on the engine clock like the rest of the desk.
  const offset = useClockOffset();
  if (status !== "stale" && status !== "offline") return null;

  const fast = tiers.fast;
  const offline = status === "offline";
  const color = offline ? C.red : C.orange;
  const age = now != null && fast.lastOkAt != null ? fmtAge(now - fast.lastOkAt) : null;
  const retry = now != null && fast.nextAt != null ? fmtAge(Math.max(0, fast.nextAt - now)) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "8px 14px",
        fontSize: 11,
        borderBottom: `1px solid ${alpha(color, 0.4)}`,
        background: alpha(color, 0.1),
        color: C.textSoft,
      }}
    >
      <strong style={{ color, letterSpacing: "0.08em", fontSize: 10, whiteSpace: "nowrap" }}>
        {offline ? "✗ ENGINE OFFLINE" : "⚠ STALE DATA"}
      </strong>
      <span style={{ minWidth: 0 }}>
        {fast.lastOkAt == null
          ? "No engine data received yet."
          : offline
            ? `Showing last good data from ${fmtIstTime(fast.lastOkAt + offset)} IST${age ? ` (${age} ago)` : ""}.`
            : `Last update ${age ?? "—"} ago; showing last good data.`}
        {fast.failures > 0 && ` ${fast.failures} failed poll${fast.failures > 1 ? "s" : ""}${fast.lastError ? ` (${fast.lastError})` : ""}.`}
        {retry && ` Next retry in ${retry}.`}
        {offline && " Admin controls are disabled."}
      </span>
      <Btn variant="outline" style={{ marginLeft: "auto" }} onClick={() => actions.refresh()}>
        ↻ RETRY NOW
      </Btn>
    </div>
  );
}
