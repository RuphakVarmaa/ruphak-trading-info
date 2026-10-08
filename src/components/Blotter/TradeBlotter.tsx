"use client";

import Link from "next/link";
import { useEngineState } from "@/hooks/useEngineState";
import { C } from "@/components/shared/colors";
import { Panel, Section, Skeleton } from "@/components/shared/ui";
import ChargesSummary from "./ChargesSummary";
import EquityCurve from "./EquityCurve";
import { OrdersTable, PositionsTable, SignalPerformanceTable } from "./Tables";

const linkStyle = { fontSize: 12, fontWeight: 600, color: C.blue, textDecoration: "none" } as const;

/** Open positions, today's orders, the equity curve with charges, and per-signal performance. */
export default function TradeBlotter() {
  const { pnl, positions, orders, performance } = useEngineState();
  return (
    <>
      <Section
        id="book"
        title="Positions and orders"
        sub="Every order is simulated against live quotes with Groww's charges until LIVE is armed; each row shows its mode."
        right={
          <span style={{ display: "inline-flex", gap: 14 }}>
            <Link href="/live" style={linkStyle}>
              Live P&amp;L →
            </Link>
            <Link href="/copy" style={linkStyle}>
              Copy trades →
            </Link>
          </span>
        }
      >
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSoft, margin: "0 0 8px" }}>Open positions</div>
            <PositionsTable positions={positions} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textSoft, margin: "0 0 8px" }}>Orders today</div>
            <OrdersTable data={orders} />
          </div>
        </div>
      </Section>

      <Section id="history" title="Equity and charges" sub="The paper account's equity over the last sessions, and what charges have cost.">
        <div className="desk-split">
          <Panel style={{ padding: 16 }}>
            {pnl ? <EquityCurve points={pnl.equityCurve} baseline={pnl.startingEquity} label={`Equity · ${pnl.history.length} sessions`} /> : <Skeleton height={250} />}
          </Panel>
          <Panel style={{ padding: 16 }}>
            <ChargesSummary pnl={pnl} />
          </Panel>
        </div>
      </Section>

      <Section id="performance" title="Signal performance" sub="Each signal's record over its last 30 trades; a signal that keeps losing is switched off automatically.">
        <SignalPerformanceTable rows={performance} />
      </Section>
    </>
  );
}
