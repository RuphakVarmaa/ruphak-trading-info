"use client";

import type { ScheduledEventKind, ScheduledEventView } from "@/engine/api-types";
import { SCHEDULED_HOURS, useEngineState, useNow } from "@/hooks/useEngineState";
import { alpha, C, impactColor } from "@/components/shared/colors";
import { fmtDuration, fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { Skeleton } from "@/components/shared/ui";

const KIND_LABEL: Record<ScheduledEventKind, string> = {
  RBI: "RBI",
  FOMC: "FOMC",
  US_CPI: "US CPI",
  US_NFP: "US NFP",
  IN_CPI: "IN CPI",
  IN_GDP: "IN GDP",
  BUDGET: "BUDGET",
  EXPIRY: "EXPIRY",
  OTHER: "EVENT",
};

function inBlackout(e: ScheduledEventView, now: number): boolean {
  if (!e.blackoutStart || !e.blackoutEnd) return false;
  return now >= Date.parse(e.blackoutStart) && now <= Date.parse(e.blackoutEnd);
}

function EventChip({ e, now }: { e: ScheduledEventView; now: number | null }) {
  const at = Date.parse(e.at);
  const color = impactColor(e.impact);
  const delta = now != null ? at - now : null;
  const blackout = now != null && inBlackout(e, now);
  return (
    <div
      title={`${e.title} · ${fmtIstDay(e.at)} ${fmtIstHm(e.at)} IST${e.approx ? " (approximate)" : ""} · ${e.indices.join(" & ")}`}
      style={{
        flexShrink: 0,
        width: 196,
        border: `1px solid ${blackout ? C.red : "#2a2a2a"}`,
        borderLeft: `3px solid ${color === "#3a3a3a" ? "#555" : color}`,
        borderRadius: 5,
        padding: "5px 9px",
        background: blackout ? alpha(C.red, 0.1) : "#141414",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 9, fontWeight: 800, letterSpacing: "0.06em" }}>
        <span style={{ color: C.gold }}>{KIND_LABEL[e.kind]}</span>
        <span style={{ color: e.impact === "LOW" ? C.muted : color }}>
          {e.impact === "HIGH" ? "▲▲ HIGH" : e.impact === "MED" ? "▲ MED" : "LOW"}
        </span>
      </div>
      <div style={{ fontSize: 10, color: C.textSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
      <div className="tnum" style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 9, fontFamily: "monospace", color: C.muted }}>
        <span>
          {fmtIstDay(e.at).slice(0, 10)} {fmtIstHm(e.at)}
          {e.approx ? " ≈" : ""}
        </span>
        <span style={{ color: delta != null && delta < 3_600_000 && delta > 0 ? C.orange : C.textDim }}>
          {delta == null ? "" : delta > 0 ? `in ${fmtDuration(delta)}` : `${fmtDuration(-delta)} ago`}
        </span>
      </div>
      {e.blackoutStart && e.blackoutEnd && (
        <div style={{ fontSize: 8, color: blackout ? C.red : C.muted3, fontFamily: "monospace" }}>
          ⛔ blackout {fmtIstHm(e.blackoutStart)}–{fmtIstHm(e.blackoutEnd)}
        </div>
      )}
    </div>
  );
}

export default function ScheduledEventsStrip() {
  const { scheduled } = useEngineState();
  const now = useNow();
  const active = now != null && scheduled ? scheduled.find((e) => inBlackout(e, now)) : undefined;
  return (
    <div
      style={{
        borderTop: `1px solid ${C.border}`,
        background: C.panelAlt,
        display: "flex",
        alignItems: "stretch",
        gap: 10,
        padding: "8px 14px",
        overflowX: "auto",
      }}
    >
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, minWidth: 74 }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: C.gold }}>CATALYSTS</span>
        <span style={{ fontSize: 8, color: C.muted3, letterSpacing: "0.06em" }}>NEXT {Math.round(SCHEDULED_HOURS / 24)} DAYS</span>
      </div>
      {active && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            padding: "8px 10px",
            borderRadius: 5,
            background: C.red,
            color: "#fff",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.06em",
          }}
        >
          ⚠ BLACKOUT NOW · {KIND_LABEL[active.kind]} until {active.blackoutEnd ? fmtIstHm(active.blackoutEnd) : "—"}
        </div>
      )}
      {scheduled == null ? (
        Array.from({ length: 5 }, (_, i) => <Skeleton key={i} width={196} height={54} style={{ flexShrink: 0 }} />)
      ) : scheduled.length === 0 ? (
        <span style={{ fontSize: 10, color: C.muted3 }}>No scheduled catalysts in the window.</span>
      ) : (
        scheduled.map((e) => <EventChip key={e.id} e={e} now={now} />)
      )}
    </div>
  );
}
