"use client";

import type { IndexQuote } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { ageColor, C, dirColor, dirGlyph } from "@/components/shared/colors";
import { fmtAge, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { Dot, Skeleton } from "@/components/shared/ui";

function QuoteCard({ q, open }: { q: IndexQuote; open: boolean }) {
  const now = useNow();
  const ageMs = now != null ? Math.max(0, now - Date.parse(q.asOf)) : null;
  const color = dirColor(q.change);
  const decimals = q.key === "USDINR" ? 3 : 2;
  return (
    <div
      title={`${q.label} · as of ${fmtIstHm(q.asOf)} IST${ageMs != null ? ` (${fmtAge(ageMs)} ago)` : ""}${q.stale ? " · stale" : ""}`}
      style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", minWidth: 0, boxShadow: "var(--shadow-card)" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: "0.04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.label}</span>
        <Dot color={open ? ageColor(ageMs, q.stale) : q.stale ? C.red : C.muted3} size={6} />
      </div>
      <div className="tnum" style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-num)", color: q.stale ? C.muted : C.textStrong, marginTop: 6, whiteSpace: "nowrap" }}>
        {fmtNum(q.price, decimals)}
      </div>
      <div className="tnum" style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-num)", color, marginTop: 2, whiteSpace: "nowrap" }}>
        {dirGlyph(q.change)} {fmtNum(Math.abs(q.change), decimals)} ({fmtPct(Math.abs(q.changePct), 2, false)})
      </div>
    </div>
  );
}

/** Index and cross-asset prices the engine reads, one card each. */
export default function MarketStrip() {
  const { state } = useEngineState();
  const open = state?.market.phase === "OPEN";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
      {state
        ? state.quotes.map((q) => <QuoteCard key={q.key} q={q} open={open} />)
        : Array.from({ length: 7 }, (_, i) => <Skeleton key={i} height={84} style={{ borderRadius: 12 }} />)}
    </div>
  );
}
