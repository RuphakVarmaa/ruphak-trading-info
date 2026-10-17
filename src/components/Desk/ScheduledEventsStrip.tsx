"use client";

import type { ScheduledEventKind, ScheduledEventView } from "@/engine/api-types";
import { SCHEDULED_HOURS, useEngineState, useNow } from "@/hooks/useEngineState";
import { alpha, C, impactColor } from "@/components/shared/colors";
import { fmtDuration, fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { EmptyState, Panel, PanelHeader, Skeleton } from "@/components/shared/ui";

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

function EventRow({ e, now }: { e: ScheduledEventView; now: number | null }) {
  const at = Date.parse(e.at);
  const color = impactColor(e.impact);
  const delta = now != null ? at - now : null;
  const blackout = now != null && inBlackout(e, now);
  return (
    <div
      title={`${e.title} · ${fmtIstDay(e.at)} ${fmtIstHm(e.at)} IST${e.approx ? " (approximate)" : ""} · ${e.indices.join(" & ")}`}
      style={{
        display: "grid",
        gridTemplateColumns: "64px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        padding: "12px 16px",
        borderTop: `1px solid ${C.borderSoft}`,
        background: blackout ? alpha(C.red, 0.06) : undefined,
      }}
    >
      <div className="tnum" style={{ textAlign: "center", borderRadius: 8, background: C.panelAlt, border: `1px solid ${C.border}`, padding: "5px 0" }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>{fmtIstDay(e.at).slice(0, 3)}</div>
        <div style={{ fontSize: 13, color: C.textStrong, fontWeight: 700, fontFamily: "var(--font-num)" }}>{fmtIstHm(e.at)}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <span style={{ fontWeight: 800, color: C.textStrong }}>{KIND_LABEL[e.kind]}</span>
          <span style={{ color: e.impact === "LOW" ? C.muted : color, fontWeight: 700 }}>{e.impact === "HIGH" ? "high impact" : e.impact === "MED" ? "medium impact" : "low impact"}</span>
        </div>
        <div style={{ fontSize: 13, color: C.textSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{e.title}</div>
        {e.blackoutStart && e.blackoutEnd && (
          <div style={{ fontSize: 11, color: blackout ? C.red : C.muted3, marginTop: 2 }}>
            no new entries {fmtIstHm(e.blackoutStart)}–{fmtIstHm(e.blackoutEnd)}
          </div>
        )}
      </div>
      <span className="tnum" style={{ fontSize: 12, fontFamily: "var(--font-num)", whiteSpace: "nowrap", color: delta != null && delta < 3_600_000 && delta > 0 ? C.orange : C.muted }}>
        {delta == null ? "" : delta > 0 ? `in ${fmtDuration(delta)}` : `${fmtDuration(-delta)} ago`}
        {e.approx ? " ≈" : ""}
      </span>
    </div>
  );
}

/** Scheduled releases and expiries for the next days, with the entry blackout around each. */
export default function ScheduledEventsStrip() {
  const { scheduled } = useEngineState();
  const now = useNow();
  const active = now != null && scheduled ? scheduled.find((e) => inBlackout(e, now)) : undefined;
  return (
    <Panel>
      <PanelHeader title={`Next ${Math.round(SCHEDULED_HOURS / 24)} days`} right={scheduled ? <span style={{ fontSize: 11, color: C.muted3, textTransform: "none", letterSpacing: "0.02em" }}>{scheduled.length} scheduled</span> : undefined} />
      {active && (
        <div role="status" style={{ padding: "10px 16px", background: C.red, color: "#fff", fontSize: 12, fontWeight: 700 }}>
          ⚠ Entry blackout now: {KIND_LABEL[active.kind]} until {active.blackoutEnd ? fmtIstHm(active.blackoutEnd) : "—"} IST
        </div>
      )}
      {scheduled == null ? (
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={44} />
          ))}
        </div>
      ) : scheduled.length === 0 ? (
        <EmptyState>No scheduled releases in the window.</EmptyState>
      ) : (
        scheduled.slice(0, 8).map((e) => <EventRow key={e.id} e={e} now={now} />)
      )}
    </Panel>
  );
}
