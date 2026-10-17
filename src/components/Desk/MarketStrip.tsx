"use client";

import type { IndexQuote } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, dirColor, dirGlyph } from "@/components/shared/colors";
import { fmtAge, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { EmptyState, Panel, Skeleton } from "@/components/shared/ui";

/** The engine may send no change when it has no previous close: treat it as unknown, never as zero. */
type TapeQuote = Omit<IndexQuote, "change" | "changePct"> & { change: number | null; changePct: number | null };

function TapeItem({ q }: { q: TapeQuote }) {
  const now = useNow();
  const ageMs = now != null ? Math.max(0, now - Date.parse(q.asOf)) : null;
  const decimals = q.key === "USDINR" ? 3 : 2;
  const known = q.change != null && q.changePct != null && Number.isFinite(q.change) && Number.isFinite(q.changePct);
  const asOf = `${fmtIstHm(q.asOf)} IST${ageMs != null ? `, ${fmtAge(ageMs)} ago` : ""}`;
  return (
    <span
      title={`${q.label}: ${fmtNum(q.price, decimals)} · ${known ? "change vs the previous close" : "no previous close, so no change"} · as of ${asOf}${q.stale ? " · stale" : ""}`}
      style={{ display: "inline-flex", alignItems: "baseline", gap: 7, whiteSpace: "nowrap", minWidth: 0 }}
    >
      <span style={{ fontSize: 12.5, color: C.muted2 }}>{q.label}</span>
      <span className="tnum" style={{ fontSize: 14, fontWeight: 600, color: q.stale ? C.muted : C.textStrong }}>
        {fmtNum(q.price, decimals)}
      </span>
      {known ? (
        <span className="tnum" style={{ fontSize: 13, color: dirColor(q.change!) }}>
          {dirGlyph(q.change!)} {fmtPct(Math.abs(q.changePct!), 2, false)}
        </span>
      ) : (
        <span className="tnum" style={{ fontSize: 13, color: C.muted2 }} aria-label="change unknown">
          —
        </span>
      )}
      {q.stale && (
        <span className="tnum" style={{ fontSize: 12.5, color: C.orange }}>
          stale · {fmtIstHm(q.asOf)}
        </span>
      )}
    </span>
  );
}

/** Index and cross-asset prices the engine reads, as one line: price and change versus the previous close. */
export default function MarketStrip() {
  const { state } = useEngineState();
  const quotes = (state?.quotes ?? []) as TapeQuote[];
  const newest = quotes.reduce<string | null>((m, q) => (m == null || Date.parse(q.asOf) > Date.parse(m) ? q.asOf : m), null);
  return (
    <Panel>
      {state == null ? (
        <div className="quote-tape" aria-busy>
          <Skeleton height={18} />
        </div>
      ) : quotes.length === 0 ? (
        <EmptyState style={{ padding: "14px 18px" }}>No prices from the engine yet.</EmptyState>
      ) : (
        <div className="quote-tape" aria-label="Market prices">
          {quotes.map((q) => (
            <TapeItem key={q.key} q={q} />
          ))}
          {newest && (
            <span className="tnum" style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted2, whiteSpace: "nowrap" }} title="Prices come from the engine (Groww and Yahoo Finance); hover a price for its own time">
              as of {fmtIstHm(newest)} IST
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}
