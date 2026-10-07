"use client";

import type { PnlResponse } from "@/engine/api-types";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtInr, fmtPct } from "@/components/shared/format";
import { Skeleton, StatTile } from "@/components/shared/ui";

const glyph = (n: number) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");

export default function PnlTiles({ pnl }: { pnl: PnlResponse | null }) {
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 } as const;
  if (!pnl) {
    return (
      <div style={grid}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={74} style={{ borderRadius: 8 }} />
        ))}
      </div>
    );
  }
  const t = pnl.today;
  const windowChange = t.equityEnd - pnl.startingEquity;
  const windowPct = pnl.startingEquity ? (windowChange / pnl.startingEquity) * 100 : 0;
  return (
    <div style={grid}>
      <StatTile
        hero
        label="Net P&L today"
        value={`${glyph(t.net)}${fmtInr(t.net, { sign: true })}`}
        color={pnlColor(t.net)}
        sub={`realized + unrealized − charges · ${pnl.mode}`}
      />
      <StatTile label="Realized" value={`${glyph(t.realized)}${fmtInr(t.realized, { sign: true })}`} color={pnlColor(t.realized)} sub="closed trades, gross" />
      <StatTile label="Unrealized" value={`${glyph(t.unrealized)}${fmtInr(t.unrealized, { sign: true })}`} color={pnlColor(t.unrealized)} sub="open positions at mark" />
      <StatTile label="Charges today" value={fmtInr(t.charges, { decimals: 2 })} color={C.textSoft} sub="brokerage, STT, exchange, GST" />
      <StatTile label="Trades today" value={String(t.trades)} color={C.textSoft} sub="closed round trips" />
      <StatTile
        label="Equity"
        value={fmtInr(t.equityEnd)}
        color={C.gold}
        sub={
          <span style={{ color: pnlColor(windowChange) }}>
            {glyph(windowChange)}
            {fmtInr(windowChange, { sign: true })} ({fmtPct(windowPct, 1)}) over {pnl.history.length}d
          </span>
        }
      />
    </div>
  );
}
