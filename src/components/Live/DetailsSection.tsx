"use client";

import { useState, type ReactNode } from "react";
import { C } from "@/components/shared/colors";
import { SERIF } from "@/components/shared/theme";

/**
 * A page section that starts collapsed: its serif heading is the toggle. Secondary material on the
 * Live P&L page (donuts, the NIFTY feed and option chain) lives in these, so the page opens on P&L and positions.
 */
export default function DetailsSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)} style={{ minWidth: 0, borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
      {/* display:flex drops the default marker; the chevron below shows the state instead. */}
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 12px", listStyle: "none" }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(20px, 2.2vw, 24px)", fontWeight: 500, lineHeight: 1.25, letterSpacing: "-0.01em", color: C.textStrong }}>
          <span
            aria-hidden
            style={{ display: "inline-block", width: 18, color: C.muted2, transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms", transformOrigin: "35% 55%" }}
          >
            ›
          </span>
          {title}
        </h2>
        {note && <span style={{ fontSize: 13, color: C.muted2 }}>{note}</span>}
      </summary>
      <div style={{ marginTop: 16, minWidth: 0 }}>{children}</div>
    </details>
  );
}
