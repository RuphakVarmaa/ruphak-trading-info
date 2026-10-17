"use client";

import Link from "next/link";
import PositionLive from "@/components/Desk/PositionLive";
import { C } from "@/components/shared/colors";
import { EmptyState, Panel, Section, Skeleton } from "@/components/shared/ui";
import { useEngineState } from "@/hooks/useEngineState";
import { accountHref } from "./engineView";

export const linkStyle = { fontSize: 13, fontWeight: 600, color: C.gold, textDecoration: "none" } as const;

/** The account's open paper positions, on the same card as Live P&L: mark, P&L, stop, target, trail and time stop. */
export default function OpenNow({ account }: { account?: string }) {
  const { positions, state } = useEngineState();
  const closed = state != null && state.market.phase !== "OPEN" && state.market.phase !== "PRE_OPEN";
  return (
    <Section
      id="open"
      title={`Open now${positions && positions.length > 0 ? ` (${positions.length})` : ""}`}
      sub="Engine marks, refreshed about every 30 s. Live P&L re-prices open NIFTY options every 2 s."
      right={
        <Link href={accountHref("/live", account)} className="link-quiet" style={linkStyle}>
          Live P&amp;L →
        </Link>
      }
    >
      {positions == null ? (
        <Skeleton height={120} style={{ borderRadius: 14 }} />
      ) : positions.length === 0 ? (
        <Panel>
          <EmptyState style={{ padding: "22px 16px" }}>
            <span style={{ fontSize: 15, color: C.textSoft, fontWeight: 600 }}>No open position.</span>
            {closed ? " The market is closed." : ""}
          </EmptyState>
        </Panel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 480px), 1fr))", gap: 12 }}>
          {positions.map((p) => (
            <Panel key={p.id} style={{ padding: 12 }}>
              <PositionLive p={p} />
            </Panel>
          ))}
        </div>
      )}
    </Section>
  );
}
