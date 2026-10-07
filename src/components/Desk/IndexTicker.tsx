"use client";

import type { IndexQuote, SessionPhase } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { ageColor, C, dirColor, dirGlyph, phaseColor } from "@/components/shared/colors";
import { fmtAge, fmtDuration, fmtIstTime, fmtNum, fmtPct } from "@/components/shared/format";
import { fallbackNextOpen, fallbackPhase, PHASE_LABEL } from "@/components/shared/market";
import { Dot, Skeleton } from "@/components/shared/ui";

const PHASE_GLYPH: Record<SessionPhase, string> = { OPEN: "●", PRE_OPEN: "◐", CLOSED: "○", HOLIDAY: "◆" };

function PhaseClock() {
  const { state } = useEngineState();
  const now = useNow();
  const phase: SessionPhase | null = state?.market.phase ?? (now != null ? fallbackPhase(now) : null);
  const nextOpen = state?.market.nextOpenAt ? Date.parse(state.market.nextOpenAt) : now != null ? fallbackNextOpen(now) : null;
  const color = phase ? phaseColor(phase) : C.muted3;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
      <span
        title={state?.market.holidayName ?? undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          color,
          fontWeight: 800,
          fontSize: 10,
          letterSpacing: "0.08em",
          padding: "2px 7px",
          border: `1px solid ${color}55`,
          borderRadius: 3,
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden>{phase ? PHASE_GLYPH[phase] : "○"}</span>
        {phase ? PHASE_LABEL[phase] : "—"}
        {phase === "HOLIDAY" && state?.market.holidayName ? ` · ${state.market.holidayName}` : ""}
      </span>
      <span className="tnum" style={{ color: C.textDim, fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap" }}>
        {now != null ? fmtIstTime(now) : "--:--:--"} <span style={{ color: C.muted3 }}>IST</span>
      </span>
      {phase && phase !== "OPEN" && nextOpen != null && now != null && nextOpen > now && (
        <span style={{ color: C.muted3, fontSize: 9, whiteSpace: "nowrap" }}>opens in {fmtDuration(nextOpen - now)}</span>
      )}
    </div>
  );
}

function QuoteCell({ q }: { q: IndexQuote }) {
  const now = useNow();
  const ageMs = now != null ? Math.max(0, now - Date.parse(q.asOf)) : null;
  const decimals = q.key === "USDINR" ? 3 : 2;
  const color = dirColor(q.change);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      <Dot color={ageColor(ageMs, q.stale)} size={5} title={ageMs != null ? `${q.label}: updated ${fmtAge(ageMs)} ago${q.stale ? " (stale)" : ""}` : q.label} />
      <span style={{ color: C.muted3, fontSize: 9, letterSpacing: "0.04em" }}>{q.label}</span>
      <span className="tnum" style={{ color: q.stale ? C.muted : C.textStrong, fontWeight: 600, fontSize: 11 }}>
        {fmtNum(q.price, decimals)}
      </span>
      <span className="tnum" style={{ color, fontSize: 9, fontWeight: 600 }}>
        {dirGlyph(q.change)}
        {fmtPct(Math.abs(q.changePct), 2, false)}
      </span>
      {q.stale && <span style={{ color: C.red, fontSize: 8, fontWeight: 800 }}>STALE</span>}
    </div>
  );
}

export default function IndexTicker() {
  const { state } = useEngineState();
  return (
    <div
      className="ticker-row"
      style={{
        minHeight: 38,
        borderBottom: `1px solid ${C.border}`,
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "6px 14px",
        fontSize: 11,
        fontFamily: "monospace",
        background: C.panelDeep,
        overflowX: "auto",
      }}
    >
      <PhaseClock />
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginLeft: "auto" }}>
        {state
          ? state.quotes.map((q) => <QuoteCell key={q.key} q={q} />)
          : Array.from({ length: 7 }, (_, i) => <Skeleton key={i} width={110} height={12} />)}
      </div>
    </div>
  );
}
