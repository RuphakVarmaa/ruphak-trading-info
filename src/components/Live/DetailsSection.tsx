"use client";

import type { ReactNode } from "react";
import { C } from "@/components/shared/colors";
import { SERIF } from "@/components/shared/theme";

/**
 * A page section that starts collapsed: its serif heading is the toggle (with the site-wide ▸ cue from
 * globals.css). Secondary material on the Live P&L page (donuts, the NIFTY feed and option chain) lives
 * in these, so the page opens on P&L and positions.
 */
export default function DetailsSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <details style={{ minWidth: 0, borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 12px" }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(20px, 2.2vw, 24px)", fontWeight: 500, lineHeight: 1.25, letterSpacing: "-0.01em", color: C.textStrong }}>{title}</h2>
        {note && <span style={{ fontSize: 13, color: C.muted2 }}>{note}</span>}
      </summary>
      <div style={{ marginTop: 16, minWidth: 0 }}>{children}</div>
    </details>
  );
}
