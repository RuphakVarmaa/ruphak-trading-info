"use client";

import { C } from "@/components/shared/colors";
import { Dot } from "@/components/shared/ui";
import type { FeedLevel, FeedStatus } from "./feedStatus";

const LEVEL_COLOR: Record<FeedLevel, string> = { ok: C.green, wait: C.muted, stale: C.orange, down: C.red };

export interface FeedRow {
  label: string;
  status: FeedStatus | null;
}

/**
 * Every data feed behind the page in one line (a dot and a word each); the full sentence for each,
 * with its source and as-of time, sits behind "Details".
 */
export default function FreshnessLine({ rows }: { rows: FeedRow[] }) {
  return (
    <details style={{ minWidth: 0, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px 14px" }}>
      <summary
        style={{ cursor: "pointer", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 18px", fontSize: 13, color: C.muted }}
      >
        {rows.map((r) => {
          const color = r.status ? LEVEL_COLOR[r.status.level] : C.muted3;
          const flagged = r.status?.level === "stale" || r.status?.level === "down";
          return (
            <span key={r.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
              <Dot color={color} />
              {r.label}
              <span style={{ color: flagged ? color : C.textSoft }}>{r.status?.headline ?? "Checking…"}</span>
            </span>
          );
        })}
        <span style={{ marginLeft: "auto", color: C.gold, fontWeight: 600 }}>Details</span>
      </summary>
      <dl style={{ margin: "12px 0 2px", display: "grid", gap: 8, fontSize: 12.5, lineHeight: 1.5 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)", gap: 12 }}>
            <dt style={{ color: C.muted, fontWeight: 600 }}>{r.label}</dt>
            <dd style={{ margin: 0, color: C.textSoft, overflowWrap: "anywhere" }}>{r.status ? `${r.status.headline}. ${r.status.detail}` : "Waiting for the first update."}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
