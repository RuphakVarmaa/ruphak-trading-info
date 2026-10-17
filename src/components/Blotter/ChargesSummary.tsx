"use client";

import type { PnlResponse } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { fmtInr, fmtPct } from "@/components/shared/format";
import { microLabel, Skeleton } from "@/components/shared/ui";

const ROWS: { key: "brokerage" | "stt" | "exchange" | "gst" | "sebi" | "stamp"; label: string }[] = [
  { key: "brokerage", label: "Brokerage" },
  { key: "stt", label: "STT (sell side)" },
  { key: "gst", label: "GST" },
  { key: "exchange", label: "Exchange txn" },
  { key: "stamp", label: "Stamp duty" },
  { key: "sebi", label: "SEBI fee" },
];

/** Friction over the P&L window: what the edge has to pay before it is profit. */
export default function ChargesSummary({ pnl }: { pnl: PnlResponse | null }) {
  if (!pnl) return <Skeleton height={200} />;
  const c = pnl.charges;
  const days = [...pnl.history, pnl.today];
  const gross = days.reduce((s, d) => s + d.realized + d.unrealized, 0);
  const trades = days.reduce((s, d) => s + d.trades, 0);
  const share = gross > 0 ? (c.total / gross) * 100 : null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 15.5, fontWeight: 600, color: C.textStrong }}>Charges</span>
        <span style={{ fontSize: 12.5, color: C.muted2 }}>last {pnl.history.length} sessions + today</span>
      </div>
      <div className="tnum" style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-num)", color: C.textStrong }}>
        {fmtInr(c.total, { decimals: 2 })}
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 12 }}>
        {trades} trades · {trades ? fmtInr(c.total / trades, { decimals: 2 }) : "—"} per trade
        {share != null && <> · {fmtPct(share, 1, false)} of gross P&L</>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {ROWS.map((r) => {
          const v = c[r.key];
          const frac = c.total > 0 ? v / c.total : 0;
          return (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "110px 1fr 84px", gap: 10, alignItems: "center", fontSize: 12 }}>
              <span style={{ color: C.textDim }}>{r.label}</span>
              <div style={{ height: 6, background: C.track, borderRadius: 3 }}>
                <div style={{ width: `${frac * 100}%`, height: "100%", background: C.gold, borderRadius: 3 }} />
              </div>
              <span className="tnum" style={{ textAlign: "right", fontFamily: "var(--font-num)", color: C.textSoft }}>
                {fmtInr(v, { decimals: 2 })}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ ...microLabel, marginTop: 12, fontWeight: 600, textTransform: "none", letterSpacing: "0.02em", color: C.muted3 }}>
        Groww F&O schedule from 1 Apr 2026: ₹20/order, STT 0.15% of sell premium, NSE 0.03553% / BSE 0.0325%, GST 18%.
      </div>
    </div>
  );
}
