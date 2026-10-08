"use client";

import type { CSSProperties } from "react";
import { useClientNow, useEngineState } from "@/hooks/useEngineState";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtInr } from "@/components/shared/format";
import { Skeleton, StatTile } from "@/components/shared/ui";

/** At most four tiles across (see .tile-row in globals.css). */
const FOUR_ACROSS = { "--tile-max": 4 } as CSSProperties;

const glyph = (n: number) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");

/**
 * Today's P&L on the engine's marks, computed the way the Live P&L page does when its live feed is off:
 * realized P&L and charges from the engine's P&L summary, unrealized from the engine's latest mark of
 * each open position (refreshed about every 30 s), so both pages agree.
 */
export default function PnlTiles() {
  const { pnl, positions, tiers } = useEngineState();
  const now = useClientNow();
  if (!pnl) {
    return (
      <div className="tile-row" style={FOUR_ACROSS}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={96} style={{ borderRadius: 14 }} />
        ))}
      </div>
    );
  }
  const t = pnl.today;
  const open = positions ?? [];
  const unrealized = open.length > 0 ? open.reduce((s, p) => s + (p.ltp == null ? 0 : (p.ltp - p.avgPrice) * p.qty), 0) : t.unrealized;
  const net = t.realized + unrealized - t.charges;
  const equity = t.equityEnd - t.net + net;
  const updated = tiers.fast.lastOkAt != null && now != null ? `updated ${fmtAge(Math.max(0, now - tiers.fast.lastOkAt))} ago` : null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="tile-row" style={FOUR_ACROSS}>
        <StatTile hero label="Net P&L today" value={`${glyph(net)}${fmtInr(net, { sign: true })}`} color={pnlColor(net)} sub={`after charges · equity ${fmtInr(equity)}`} />
        <StatTile
          label="Realized"
          value={`${glyph(t.realized)}${fmtInr(t.realized, { sign: true })}`}
          color={pnlColor(t.realized)}
          sub={`${t.trades} trade${t.trades === 1 ? "" : "s"} closed, before charges`}
        />
        <StatTile label="Unrealized" value={`${glyph(unrealized)}${fmtInr(unrealized, { sign: true })}`} color={pnlColor(unrealized)} sub={`${open.length} open, at the engine's mark`} />
        <StatTile label="Charges" value={fmtInr(t.charges, { decimals: 2 })} color={C.textSoft} sub="brokerage, STT, fees, GST" />
      </div>
      <div className="tnum" style={{ fontSize: 12.5, color: C.muted2 }}>
        Engine marks, refreshed about every 30 s{updated ? ` · ${updated}` : ""} · {pnl.mode === "LIVE" ? "live account" : "paper account"}. The Live P&amp;L page adds a 2-second live estimate while the market is open.
      </div>
    </div>
  );
}
