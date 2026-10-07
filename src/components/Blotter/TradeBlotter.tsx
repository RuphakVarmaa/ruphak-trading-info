"use client";

import type { ReactNode } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { C } from "@/components/shared/colors";
import { ModeBadge } from "@/components/shared/SiteHeader";
import { Panel, SectionHeader, Skeleton } from "@/components/shared/ui";
import ChargesSummary from "./ChargesSummary";
import EquityCurve from "./EquityCurve";
import PnlTiles from "./PnlTiles";
import { OrdersTable, PositionsTable, SignalPerformanceTable } from "./Tables";

function Block({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.text }}>{title}</span>
        {sub != null && <span style={{ fontSize: 10, color: C.muted3 }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export default function TradeBlotter() {
  const { pnl, positions, orders, performance, state } = useEngineState();
  const mode = state?.mode ?? null;
  return (
    <section id="blotter" style={{ padding: "24px 30px 30px", background: C.bg, borderTop: `1px solid ${C.borderSoft}` }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <SectionHeader
          label="Trade blotter"
          title="The book: positions, orders and P&L"
          sub="Every order is simulated against live quotes with Groww's charge schedule until LIVE is armed. Each row carries its mode."
          right={mode ? <ModeBadge mode={mode} /> : undefined}
        />
        <PnlTiles pnl={pnl} />
        <div className="blotter-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.75fr) minmax(0, 1fr)", gap: 16, marginTop: 16 }}>
          <Panel style={{ padding: 16 }}>
            {pnl ? (
              <EquityCurve points={pnl.equityCurve} baseline={pnl.startingEquity} label={`Equity curve · ${pnl.history.length} sessions`} />
            ) : (
              <Skeleton height={250} />
            )}
          </Panel>
          <Panel style={{ padding: 16 }}>
            <ChargesSummary pnl={pnl} />
          </Panel>
        </div>
        <Block title="Open positions" sub="marked at bid · stops, trail and 15:05 IST square-off managed by the engine">
          <PositionsTable positions={positions} />
        </Block>
        <Block title="Orders today" sub="IST · newest first">
          <OrdersTable data={orders} />
        </Block>
        <Block title="Signal performance" sub="rolling 30-trade window per source · decayed sources switch off automatically">
          <SignalPerformanceTable rows={performance} />
        </Block>
      </div>
    </section>
  );
}
