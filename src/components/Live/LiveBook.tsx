"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { PositionView } from "@/engine/api-types";
import PositionLive from "@/components/Desk/PositionLive";
import { istIso } from "@/engine/clock";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { SERIF } from "@/components/shared/theme";
import { fmtAge, fmtInr, fmtIstDay, fmtIstHm, fmtPct } from "@/components/shared/format";
import { Dot, EmptyState, Panel, PanelHeader, Skeleton, StatTile } from "@/components/shared/ui";
import AccountSwitcher from "./AccountSwitcher";
import { useClientNow, useEngineState, useNow } from "@/hooks/useEngineState";
import CapitalPnlPies from "./CapitalPnlPies";
import NiftyLiveFeed from "./NiftyLiveFeed";
import { dashboardLinkStatus, engineLoopStatus, LIVE_FEED_MAX_AGE_MS, marketFeedStatus, optionPriceStatus, type FeedLevel, type FeedStatus } from "./feedStatus";
import { markLive, rawUnrealized, type LiveInputs } from "./liveMarks";
import { useNiftyFeed } from "./useNiftyFeed";

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
  const [expiry, setExpiry] = useState<string | null>(null);
  const { data: liveData, error: liveError } = useNiftyFeed(expiry);

  // While the market is open and the 2-second NIFTY feed is fresh, the open puts are re-priced from it.
  const liveFeed = liveData?.feed ?? null;
  const liveOn =
    liveData != null &&
    liveFeed != null &&
    liveFeed.vix != null &&
    clientNow != null &&
    clientNow - liveData.at < 10_000 &&
    clientNow - Date.parse(liveFeed.asOf) < LIVE_FEED_MAX_AGE_MS &&
    state?.market.phase === "OPEN";
  const liveInputs: LiveInputs | null = liveOn && liveFeed && liveData ? { index: "NIFTY", spot: liveFeed.spot, vix: liveFeed.vix, asOf: istIso(liveData.at), atMs: liveData.at } : null;
  const open: PositionView[] = (positions ?? []).map((p) => markLive(p, liveInputs));

  const feeds =
    state && now != null
      ? {
          market: marketFeedStatus(state, now, "NIFTY", liveOn && liveFeed ? { price: liveFeed.spot, asOf: liveFeed.asOf } : undefined),
          options: optionPriceStatus(state, open, signals, now),
          engine: engineLoopStatus(state, now),
        }
      : null;
  const link = dashboardLinkStatus(status, tiers.fast.lastOkAt, fastIntervalMs, clientNow);

  const today = pnl?.today ?? null;
  // Price move on the open positions, before charges (as the engine's own P&L summary counts it).
  const unrealized = positions && positions.length > 0 ? open.reduce((s, p) => s + rawUnrealized(p), 0) : (today?.unrealized ?? 0);
  const realized = today?.realized ?? 0;
  const charges = today?.charges ?? 0;
  const net = realized + unrealized - charges;
  const equity = pnl ? pnl.startingEquity + net : null;
  const updated =
    liveOn && liveData && clientNow != null
      ? `live · refreshed ${fmtAge(Math.max(0, clientNow - liveData.at))} ago`
      : tiers.fast.lastOkAt != null && clientNow != null
        ? `updated ${fmtAge(Math.max(0, clientNow - tiers.fast.lastOkAt))} ago`
        : "connecting…";

  return (
    <main style={{ width: "100%", maxWidth: 1080, margin: "0 auto", padding: "20px 16px 48px", display: "grid", gap: 24, boxSizing: "border-box" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, color: C.textStrong, fontFamily: SERIF, letterSpacing: "-0.01em" }}>Live P&amp;L</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.muted }}>
            {state?.account && state.account.id !== "main" ? `${state.account.label} (${fmtInr(state.account.capitalRupees, { decimals: 0 })}, one cheaper lot) · ` : ""}
            {signals?.some((x) => x.index === "SENSEX") ? "NIFTY 50 and SENSEX options" : "NIFTY 50 options"} · paper trading with simulated fills{state ? ` · ${fmtIstDay(state.market.nowIst)}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <AccountSwitcher />
          <span className="tnum" style={{ fontSize: 11, color: C.muted2, fontFamily: "monospace" }}>{updated}</span>
        </div>
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
              <StatTile label="Unrealized" value={fmtInr(unrealized, { decimals: 0, sign: true })} color={pnlColor(unrealized)} sub={`${open.length} open · ${liveOn ? "live" : "engine mark"}`} />
              <StatTile label="Charges" value={fmtInr(charges, { decimals: 0 })} color={C.textSoft} sub="brokerage, STT, fees, GST" />
            </div>
            {state && <LossCapBar used={Math.max(0, -net)} cap={state.caps.dailyLossCap} />}
            <div style={{ marginTop: 10, fontSize: 10, color: C.muted2, lineHeight: 1.5 }}>
              {liveOn
                ? "Live estimate: refreshed every 2 s from the NIFTY price, with model option prices. The engine checks stops and targets on its own 30-second cycle."
                : "Engine marks, refreshed about every 30 s."}
            </div>
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
        <NiftyLiveFeed positions={open} data={liveData} error={liveError} onExpiry={setExpiry} />
      </Section>
    </main>
  );
}
