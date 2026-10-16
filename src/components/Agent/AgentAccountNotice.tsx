"use client";

import Link from "next/link";
import { alpha, C } from "@/components/shared/colors";

/** One line on the account pages (Paper Engine, Live P&L) while they show the agent's paper account. */
export default function AgentAccountNotice({ label }: { label: string }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "2px 10px",
        background: alpha(C.purple, 0.07),
        border: `1px solid ${alpha(C.purple, 0.35)}`,
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 14,
        lineHeight: 1.5,
        color: C.textStrong,
        minWidth: 0,
      }}
    >
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <span aria-hidden>⚠ </span>
        <b>{label} is a paper experiment run by a model; nothing here is advice.</b>
      </span>
      <Link href="/agent" className="link-quiet" style={{ color: C.gold, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
        See its decisions →
      </Link>
    </div>
  );
}
