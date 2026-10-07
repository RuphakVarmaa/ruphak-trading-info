"use client";

import type { FillView, OrderStatus, OrderView, PositionView, SignalPerformanceRow } from "@/engine/api-types";
import { useNow } from "@/hooks/useEngineState";
import { alpha, C, modeColor, pnlColor, sourceStatusColor, sourceStatusGlyph } from "@/components/shared/colors";
import { enumLabel, fmtCountdown, fmtInr, fmtIstDate, fmtIstHm, fmtIstTime, fmtNum, fmtPct, fmtSigned } from "@/components/shared/format";
import { EmptyState, Pill, Skeleton, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from "@/components/shared/ui";

function ModeCell({ mode }: { mode: string }) {
  return <Pill color={modeColor(mode === "LIVE" ? "LIVE" : mode === "PAPER" ? "PAPER" : "BACKTEST")}>{mode}</Pill>;
}

function SquareOff({ at }: { at: string }) {
  const now = useNow();
  const ms = Date.parse(at);
  return (
    <span className="tnum">
      {fmtIstHm(ms)}
      <span style={{ color: C.muted3 }}> {now == null ? "" : ms > now ? `· ${fmtCountdown(ms - now)}` : "· due"}</span>
    </span>
  );
}

export function PositionsTable({ positions }: { positions: PositionView[] | null }) {
  if (positions == null) return <Skeleton height={80} />;
  if (positions.length === 0) return <EmptyState style={tableWrap}>No open positions. The engine is flat.</EmptyState>;
  return (
    <div style={tableWrap}>
      <table style={tableStyle}>
        <thead>
          <tr style={theadRow}>
            <th style={th}>Mode</th>
            <th style={th}>Contract</th>
            <th style={thNum}>Qty</th>
            <th style={thNum}>Avg</th>
            <th style={thNum}>LTP</th>
            <th style={thNum}>P&L</th>
            <th style={thNum}>Stop</th>
            <th style={thNum}>Trail</th>
            <th style={thNum}>Target</th>
            <th style={th}>Opened</th>
            <th style={th}>Square-off</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id}>
              <td style={td}>
                <ModeCell mode={p.mode} />
              </td>
              <td style={{ ...td, color: C.gold, fontWeight: 600, fontFamily: "monospace" }}>{p.contract.label}</td>
              <td style={tdNum}>{p.qty}</td>
              <td style={tdNum}>{fmtNum(p.avgPrice)}</td>
              <td style={tdNum}>{p.ltp != null ? fmtNum(p.ltp) : "—"}</td>
              <td style={{ ...tdNum, color: pnlColor(p.pnl) }}>
                {p.pnl > 0 ? "▲ " : p.pnl < 0 ? "▼ " : ""}
                {fmtInr(p.pnl, { sign: true })} <span style={{ color: C.muted }}>({fmtPct(p.pnlPct, 1)})</span>
              </td>
              <td style={{ ...tdNum, color: C.textDim }}>{fmtNum(p.stopPrice)}</td>
              <td style={{ ...tdNum, color: p.trailPrice != null ? C.orange : C.muted3 }}>{p.trailPrice != null ? fmtNum(p.trailPrice) : "—"}</td>
              <td style={{ ...tdNum, color: C.textDim }}>{fmtNum(p.targetPrice)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{fmtIstHm(p.openedAt)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>
                <SquareOff at={p.squareOffAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_STYLE: Record<OrderStatus, { glyph: string; color: string }> = {
  FILLED: { glyph: "✓", color: C.green },
  PARTIAL: { glyph: "◐", color: C.orange },
  OPEN: { glyph: "◌", color: C.blue },
  NEW: { glyph: "◌", color: C.blue },
  CANCELLED: { glyph: "⊘", color: C.muted },
  REJECTED: { glyph: "✗", color: C.red },
  UNKNOWN: { glyph: "?", color: C.orange },
};

export function OrdersTable({ data }: { data: { orders: OrderView[]; fills: FillView[] } | null }) {
  if (data == null) return <Skeleton height={120} />;
  const { orders, fills } = data;
  if (orders.length === 0) return <EmptyState style={tableWrap}>No orders today.</EmptyState>;
  const charges = fills.reduce((s, f) => s + f.charges, 0);
  return (
    <div>
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={th}>Time</th>
              <th style={th}>Mode</th>
              <th style={th}>Contract</th>
              <th style={th}>Side</th>
              <th style={thNum}>Qty</th>
              <th style={th}>Type</th>
              <th style={thNum}>Limit</th>
              <th style={th}>Status</th>
              <th style={th}>Reason</th>
              <th style={thNum}>Filled</th>
              <th style={thNum}>Avg fill</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const st = STATUS_STYLE[o.status] ?? STATUS_STYLE.UNKNOWN;
              return (
                <tr key={o.id} title={o.error ?? undefined}>
                  <td style={{ ...td, fontFamily: "monospace" }}>{fmtIstTime(o.placedAt)}</td>
                  <td style={td}>
                    <ModeCell mode={o.mode} />
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textStrong }}>{o.contractLabel}</td>
                  <td style={{ ...td, fontWeight: 700, color: o.side === "BUY" ? C.blue : C.orange }}>
                    {o.side === "BUY" ? "▲ BUY" : "▼ SELL"}
                  </td>
                  <td style={tdNum}>{o.qty}</td>
                  <td style={{ ...td, color: C.textDim }}>{o.orderType}</td>
                  <td style={tdNum}>{o.limitPrice != null ? fmtNum(o.limitPrice) : "—"}</td>
                  <td style={{ ...td, color: st.color, fontWeight: 700 }}>
                    {st.glyph} {o.status}
                    {o.error && <div style={{ fontSize: 9, color: C.muted, fontWeight: 400, whiteSpace: "normal", maxWidth: 220 }}>{o.error}</div>}
                  </td>
                  <td style={td}>
                    <Pill color={o.reason === "ENTRY" ? C.gold : o.reason === "STOP" || o.reason === "KILL_SWITCH" || o.reason === "DAILY_LOSS_CAP" ? C.red : C.muted}>
                      {enumLabel(o.reason)}
                    </Pill>
                  </td>
                  <td style={tdNum}>
                    {o.filledQty}/{o.qty}
                  </td>
                  <td style={tdNum}>{o.avgFillPrice != null ? fmtNum(o.avgFillPrice) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: C.muted3, marginTop: 6 }}>
        {fills.length} fill{fills.length === 1 ? "" : "s"} · charges {fmtInr(charges, { decimals: 2 })}
      </div>
    </div>
  );
}

export function SignalPerformanceTable({ rows }: { rows: SignalPerformanceRow[] | null }) {
  if (rows == null) return <Skeleton height={160} />;
  if (rows.length === 0) return <EmptyState style={tableWrap}>No signal statistics yet.</EmptyState>;
  return (
    <div style={tableWrap}>
      <table style={tableStyle}>
        <thead>
          <tr style={theadRow}>
            <th style={th}>Signal source</th>
            <th style={th}>Status</th>
            <th style={thNum}>Trades</th>
            <th style={thNum}>Hit rate</th>
            <th style={thNum}>Expectancy</th>
            <th style={thNum}>Avg win / loss</th>
            <th style={thNum}>Profit factor</th>
            <th style={thNum}>t-stat</th>
            <th style={thNum}>Weight</th>
            <th style={th}>Last trade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const modifierOnly = r.trades === 0 && r.source === "VOL_REGIME";
            const color = sourceStatusColor(r.status);
            return (
              <tr key={`${r.source}-${r.index}`} style={{ background: r.status === "DISABLED" ? alpha(C.red, 0.04) : undefined }}>
                <td style={{ ...td, whiteSpace: "normal", minWidth: 180 }}>
                  <div style={{ color: C.textStrong, fontWeight: 600 }}>{r.label}</div>
                  {r.disabledReason && <div style={{ fontSize: 9, color: C.muted, marginTop: 2, maxWidth: 340 }}>{r.disabledReason}</div>}
                  {modifierOnly && <div style={{ fontSize: 9, color: C.muted3, marginTop: 2 }}>Modifier only: adjusts thresholds and size, never votes on direction.</div>}
                </td>
                <td style={td}>
                  <Pill color={color}>
                    {sourceStatusGlyph(r.status)} {r.status}
                  </Pill>
                </td>
                <td style={tdNum}>{modifierOnly ? "—" : r.trades}</td>
                <td style={tdNum}>{modifierOnly ? "—" : fmtPct(r.hitRate * 100, 1, false)}</td>
                <td style={{ ...tdNum, color: modifierOnly ? C.muted3 : pnlColor(r.expectancyPct) }}>
                  {modifierOnly ? "—" : `${fmtPct(r.expectancyPct, 1)} · ${fmtInr(r.expectancyRupees, { sign: true })}`}
                </td>
                <td style={tdNum}>{modifierOnly ? "—" : `${fmtPct(r.avgWinPct, 1)} / ${fmtPct(r.avgLossPct, 1)}`}</td>
                <td style={{ ...tdNum, color: modifierOnly ? C.muted3 : r.profitFactor >= 1 ? C.textStrong : C.red }}>
                  {modifierOnly ? "—" : r.profitFactor.toFixed(2)}
                </td>
                <td style={tdNum}>{modifierOnly ? "—" : fmtSigned(r.tStat)}</td>
                <td style={tdNum}>{r.weight.toFixed(2)}</td>
                <td style={{ ...td, fontFamily: "monospace", color: C.muted }}>{r.lastTradeAt ? `${fmtIstDate(r.lastTradeAt)} ${fmtIstHm(r.lastTradeAt)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
