"use client";

import { useClientNow, useClockOffset, useEngineState } from "@/hooks/useEngineState";
import { alpha, C } from "@/components/shared/colors";
import { fmtAge, fmtIstTime } from "@/components/shared/format";
import { Btn } from "@/components/shared/ui";

/**
 * Shown only while the engine data is out of date or the engine is not answering; the Desk keeps
 * showing the last data it received. Plain sentences only: the error codes stay in the poller.
 */
export default function ConnectionBanner() {
  const { status, tiers, actions } = useEngineState();
  const now = useClientNow();
  // Poll times are on the browser clock; show them on the engine clock like the rest of the desk.
  const offset = useClockOffset();
  if (status !== "stale" && status !== "offline") return null;

  const fast = tiers.fast;
  const offline = status === "offline";
  const color = offline ? C.red : C.orange;
  const age = now != null && fast.lastOkAt != null ? fmtAge(Math.max(0, now - fast.lastOkAt)) : null;
  const retry = now != null && fast.nextAt != null ? fmtAge(Math.max(0, fast.nextAt - now)) : null;

  const title = offline ? "The engine is not answering." : "The data on this page is out of date.";
  const lastData =
    fast.lastOkAt == null
      ? "No engine data has arrived yet."
      : `Showing the last data received, from ${fmtIstTime(fast.lastOkAt + offset)} IST${age ? ` (${age} ago)` : ""}.`;
  const why = fast.failures > 0 && fast.lastError ? ` ${fast.lastError}` : "";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px 14px",
        flexWrap: "wrap",
        padding: "12px 16px",
        fontSize: 13.5,
        lineHeight: 1.5,
        border: `1px solid ${alpha(color, 0.45)}`,
        borderRadius: 12,
        background: alpha(color, 0.07),
        color: C.textSoft,
      }}
    >
      <span style={{ minWidth: 0, flex: "1 1 260px" }}>
        <strong style={{ color, fontWeight: 600 }}>{title}</strong> {lastData}
        {why}
        {retry ? ` Trying again in ${retry}.` : ""}
        {offline ? " Engine controls are off until it answers." : ""}
      </span>
      <Btn variant="outline" onClick={() => actions.refresh()}>
        Try again now
      </Btn>
    </div>
  );
}
