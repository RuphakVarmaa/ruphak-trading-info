"use client";

import type { CSSProperties, ReactNode } from "react";
import type { PositionView } from "@/engine/api-types";
import PositionLive from "@/components/Desk/PositionLive";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtInr, fmtIstDay, fmtIstHm, fmtPct } from "@/components/shared/format";
import { Dot, EmptyState, Panel, PanelHeader, Skeleton, StatTile } from "@/components/shared/ui";
import { useClientNow, useEngineState, useNow } from "@/hooks/useEngineState";
import CapitalPnlPies from "./CapitalPnlPies";
import NiftyLiveFeed from "./NiftyLiveFeed";
import { dashboardLinkStatus, engineLoopStatus, marketFeedStatus, optionPriceStatus, type FeedLevel, type FeedStatus } from "./feedStatus";

const LEVEL_COLOR: Record<FeedLevel, string> = { ok: C.green, wait: C.muted, stale: C.orange, down: C.red };

const sectionLabel: CSSProperties = { fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, margin: "0 0 10px" };

function FeedTile({ label, status }: { label: string; status: FeedStatus | null }) {
  const color = status ? LEVEL_COLOR[status.level] : C.muted3;
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${status?.level === "down" ? alpha(C.red, 0.5) : C.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9, color: C.muted2, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
        <Dot color={color} />
        {label}
      </div>
      {status ? (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color, marginTop: 6 }}>{status.headline}</div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 4, lineHeight: 1.45, overflowWrap: "anywhere" }}>{status.detail}</div>
        </>
      ) : (
        <Skeleton height={34} style={{ marginTop: 8 }} />
      )}
    </div>
  );
}

function LossCapBar({ used, cap }: { used: number; cap: number }) {
  const frac = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
  const color = frac >= 0.8 ? C.red : frac >= 0.5 ? C.orange : C.green;
  return (
    <div style={{ marginTop: 12 }} title="Trading stops for the day when the loss reaches the cap">
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginBottom: 6 }}>
        <span>Daily loss used</span>
        <span className="tnum" style={{ fontFamily: "monospace", color: C.textSoft }}>
          {fmtInr(used, { decimals: 0 })} of {fmtInr(cap, { decimals: 0 })}
        </span>
      </div>
      <div style={{ height: 6, background: C.borderSoft, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${frac * 100}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function emptyPositionsText(nowIst: string | null, phase: string | undefined): string {
  if (phase !== "OPEN" && phase !== "PRE_OPEN") return "No open positions. The market is closed.";
  const hm = nowIst ? fmtIstHm(nowIst) : null;
  if (hm && hm < "09:25") return "No open positions yet. The first entry can come at 09:25 IST.";
  if (hm && hm > "14:30") return "No open positions. No new entries after 14:30 IST; anything open is closed by 15:05.";
  return "No open positions right now. The engine enters only when news or at least two signals agree.";
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h2 style={sectionLabel}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Today's P&L, open positions and whether the market and option-price feeds are coming through. */
export default function LiveBook() {
  const { state, positions, signals, pnl, status, tiers, fastIntervalMs } = useEngineState();
  const now = useNow();
  const clientNow = useClientNow();

  const feeds =
    state && now != null
      ? {
          market: marketFeedStatus(state, now),
          options: optionPriceStatus(state, positions, signals, now),
          engine: engineLoopStatus(state, now),
        }
      : null;
  const link = dashboardLinkStatus(status, tiers.fast.lastOkAt, fastIntervalMs, clientNow);

  const open: PositionView[] = positions ?? [];
  const today = pnl?.today ?? null;
  // Positions refresh every 5 s, the P&L summary every 60 s: take unrealized from the live marks.
  const unrealized = positions && positions.length > 0 ? positions.reduce((s, p) => s + p.pnl, 0) : (today?.unrealized ?? 0);
  const realized = today?.realized ?? 0;
  const charges = today?.charges ?? 0;
  const net = realized + unrealized - charges;
  const equity = pnl ? pnl.startingEquity + net : null;
  const updated = tiers.fast.lastOkAt != null && clientNow != null ? `updated ${fmtAge(Math.max(0, clientNow - tiers.fast.lastOkAt))} ago` : "connecting…";

  return (
    <main style={{ width: "100%", maxWidth: 1080, margin: "0 auto", padding: "20px 16px 48px", display: "grid", gap: 24, boxSizing: "border-box" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.textStrong }}>Live P&amp;L</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.muted }}>
            NIFTY 50 options · paper trading with simulated fills{state ? ` · ${fmtIstDay(state.market.nowIst)}` : ""}
          </p>
        </div>
        <span className="tnum" style={{ fontSize: 11, color: C.muted2, fontFamily: "monospace" }}>{updated}</span>
      </div>

      <Section title="Data feeds">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
          <FeedTile label="Market feed · NIFTY" status={feeds?.market ?? null} />
          <FeedTile label="Option prices" status={feeds?.options ?? null} />
          <FeedTile label="Engine loop" status={feeds?.engine ?? null} />
          <FeedTile label="This page" status={link} />
        </div>
      </Section>

      <Section title="P&L today" right={today ? <span style={{ fontSize: 11, color: C.muted2 }}>{today.trades} trade{today.trades === 1 ? "" : "s"} closed</span> : null}>
        {pnl ? (
          <Panel style={{ padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              <StatTile label="Net after charges" value={fmtInr(net, { decimals: 0, sign: true })} color={pnlColor(net)} hero sub={equity != null ? `equity ${fmtInr(equity, { decimals: 0 })} (${fmtPct((net / pnl.startingEquity) * 100)})` : undefined} />
              <StatTile label="Realized" value={fmtInr(realized, { decimals: 0, sign: true })} color={pnlColor(realized)} sub="closed trades" />
              <StatTile label="Unrealized" value={fmtInr(unrealized, { decimals: 0, sign: true })} color={pnlColor(unrealized)} sub={`${open.length} open`} />
              <StatTile label="Charges" value={fmtInr(charges, { decimals: 0 })} color={C.textSoft} sub="brokerage, STT, fees, GST" />
            </div>
            {state && <LossCapBar used={state.caps.dailyLossUsed} cap={state.caps.dailyLossCap} />}
          </Panel>
        ) : (
          <Skeleton height={120} />
        )}
      </Section>

      <Section title="Capital and P&L split">
        {pnl && positions ? <CapitalPnlPies capital={pnl.startingEquity} positions={open} realized={realized} charges={charges} /> : <Skeleton height={200} />}
      </Section>

      <Section title={`Open positions${positions ? ` (${open.length})` : ""}`}>
        {positions == null ? (
          <Skeleton height={80} />
        ) : open.length === 0 ? (
          <Panel>
            <PanelHeader title="No open positions" />
            <EmptyState style={{ padding: 16 }}>{emptyPositionsText(state?.market.nowIst ?? null, state?.market.phase)}</EmptyState>
          </Panel>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {open.map((p) => (
              <Panel key={p.id} style={{ padding: 12 }}>
                <PositionLive p={p} />
              </Panel>
            ))}
          </div>
        )}
      </Section>

      <Section title="NIFTY 50 live feed and option chain">
        <NiftyLiveFeed positions={open} />
      </Section>
    </main>
  );
}
