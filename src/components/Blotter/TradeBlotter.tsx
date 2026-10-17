"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { C } from "@/components/shared/colors";
import { Panel, Skeleton } from "@/components/shared/ui";
import ChargesSummary from "./ChargesSummary";
import EquityCurve from "./EquityCurve";
import { OrdersTable, PositionsTable, SignalPerformanceTable } from "./Tables";

const linkStyle = { fontSize: 13, fontWeight: 600, color: C.gold, textDecoration: "none" } as const;

/** A titled block inside the "Orders and performance" area (an H3 under its H2). */
function Block({ title, sub, right, children }: { title: string; sub?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "4px 14px" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, color: C.textStrong }}>{title}</h3>
          {sub && <p style={{ margin: "3px 0 0", fontSize: 13, color: C.muted2, lineHeight: 1.5 }}>{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Open positions, today's orders, the equity curve with charges, and per-signal performance. */
export default function TradeBlotter() {
  const { pnl, positions, orders, performance } = useEngineState();
  return (
    <>
      <Block
        title="Open positions"
        sub="Every order is simulated against live quotes with Groww's charges until LIVE is armed; each row shows its mode."
        right={
          <span style={{ display: "inline-flex", gap: 14 }}>
            <Link href="/live" className="link-quiet" style={linkStyle}>
              Live P&amp;L →
            </Link>
            <Link href="/copy" className="link-quiet" style={linkStyle}>
              Copy trades →
            </Link>
          </span>
        }
      >
        <PositionsTable positions={positions} />
      </Block>
      <Block title="Orders today">
        <OrdersTable data={orders} />
      </Block>
      <Block title="Equity and charges" sub="The paper account's equity over the last sessions, and what charges have cost.">
        <div className="desk-split">
          <Panel style={{ padding: 16 }}>
            {pnl ? <EquityCurve points={pnl.equityCurve} baseline={pnl.startingEquity} label={`Equity · ${pnl.history.length} sessions`} /> : <Skeleton height={250} />}
          </Panel>
          <Panel style={{ padding: 16 }}>
            <ChargesSummary pnl={pnl} />
          </Panel>
        </div>
      </Block>
      <Block title="Signal performance" sub="Each signal's record over its last 30 trades; a signal that keeps losing is switched off automatically.">
        <SignalPerformanceTable rows={performance} />
      </Block>
    </>
  );
}
