"use client";

import { useState } from "react";
import type { PositionView } from "@/engine/api-types";
import PositionLive from "@/components/Desk/PositionLive";
import { istIso } from "@/engine/clock";
import { DEFAULT_CONFIG } from "@/engine/config";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtInr, fmtIstDay, fmtIstHm, fmtIstTime, fmtNum, fmtPct } from "@/components/shared/format";
import { EmptyState, PageHeader, Panel, Section, Skeleton, StatTile } from "@/components/shared/ui";
import AccountSwitcher from "./AccountSwitcher";
import { useClientNow, useEngineState, useNow } from "@/hooks/useEngineState";
import CapitalPnlPies from "./CapitalPnlPies";
import DetailsSection from "./DetailsSection";
import FreshnessLine from "./FreshnessLine";
import NiftyLiveFeed from "./NiftyLiveFeed";
import { dashboardLinkStatus, engineLoopStatus, LIVE_FEED_MAX_AGE_MS, marketFeedStatus, optionPriceStatus } from "./feedStatus";
import { markLive, rawUnrealized, type LiveInputs } from "./liveMarks";
import { useNiftyFeed } from "./useNiftyFeed";

/** Loss used against the daily cap. The fill is red because it is loss; it is empty while the day is in profit. */
function LossCapBar({ used, cap }: { used: number; cap: number }) {
  const frac = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "2px 12px", fontSize: 12.5, color: C.muted, marginBottom: 6 }}>
        <span>Daily loss cap: new entries stop for the day when the loss reaches it</span>
        <span className="tnum" style={{ fontFamily: "var(--font-num)", color: C.textSoft }}>
          {fmtInr(used, { decimals: 0 })} used of {fmtInr(cap, { decimals: 0 })}
        </span>
      </div>
      <div role="img" aria-label={`Daily loss used: ${fmtInr(used, { decimals: 0 })} of ${fmtInr(cap, { decimals: 0 })}`} style={{ height: 6, background: C.borderSoft, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${frac * 100}%`, height: "100%", background: C.red, borderRadius: 3 }} />
      </div>
    </div>
  );
}

const { noEntryBeforeIst, noEntryAfterIst } = DEFAULT_CONFIG.gates;
const { squareOffIst } = DEFAULT_CONFIG.exits;

function emptyPositionsText(nowIst: string | null, phase: string | undefined): string {
  if (phase !== "OPEN" && phase !== "PRE_OPEN") return "No open positions. The market is closed.";
  const hm = nowIst ? fmtIstHm(nowIst) : null;
  if (hm && hm < noEntryBeforeIst) return `No open positions yet. The first entry can come at ${noEntryBeforeIst} IST.`;
  if (hm && hm > noEntryAfterIst) return `No open positions. No new entries after ${noEntryAfterIst} IST; anything open is closed by ${squareOffIst}.`;
  return "No open positions right now. The engine enters only when news or at least two signals agree.";
}

/** Today's P&L and open positions first; feed health in one line; the donuts and the NIFTY feed and option chain folded below. */
export default function LiveBook() {
  const { state, positions, signals, pnl, status, tiers, fastIntervalMs } = useEngineState();
  const now = useNow();
  const clientNow = useClientNow();
  const [expiry, setExpiry] = useState<string | null>(null);
  const { data: liveData, error: liveError } = useNiftyFeed(expiry);

  // While the market is open and the 2-second NIFTY feed is fresh, the open NIFTY options are re-priced from it.
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
  const liveMarked = liveInputs != null && open.some((p) => p.index === liveInputs.index);

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
  // Price move on the open positions before charges (as the engine's own P&L summary counts it).
  const unrealized = positions && positions.length > 0 ? open.reduce((s, p) => s + rawUnrealized(p), 0) : (today?.unrealized ?? 0);
  const engineUnrealized = positions && positions.length > 0 ? positions.reduce((s, p) => s + rawUnrealized(p), 0) : (today?.unrealized ?? 0);
  const realized = today?.realized ?? 0;
  const charges = today?.charges ?? 0;
  const net = realized + unrealized - charges;
  const engineNet = realized + engineUnrealized - charges;
  const equity = pnl ? pnl.startingEquity + net : null;
  const marks = liveMarked ? "live marks" : "engine marks";
  const updated =
    liveOn && liveData && clientNow != null
      ? `live · refreshed ${fmtAge(Math.max(0, clientNow - liveData.at))} ago`
      : tiers.fast.lastOkAt != null && clientNow != null
        ? `updated ${fmtAge(Math.max(0, clientNow - tiers.fast.lastOkAt))} ago`
        : "connecting…";
  const account = state?.account && state.account.id !== "main" ? state.account : null;

  return (
    <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "32px 16px 56px", display: "grid", gap: 32, boxSizing: "border-box" }}>
      <PageHeader
        eyebrow={state ? fmtIstDay(state.market.nowIst) : "Paper trading"}
        title="Live P&amp;L"
        sub={
          <>
            {account ? `${account.label} · ${fmtInr(account.capitalRupees, { decimals: 0 })} capital · ` : ""}
            {signals?.some((x) => x.index === "SENSEX") ? "NIFTY 50 and SENSEX options" : "NIFTY 50 options"}, paper trading with simulated fills.
          </>
        }
        right={
          <>
            <AccountSwitcher />
            <span className="tnum" style={{ fontSize: 12, color: C.muted2 }}>{updated}</span>
          </>
        }
      >
        <FreshnessLine
          rows={[
            { label: "Market", status: feeds?.market ?? null },
            { label: "Option prices", status: feeds?.options ?? null },
            { label: "Engine", status: feeds?.engine ?? null },
            { label: "This page", status: link },
          ]}
        />
      </PageHeader>

      <Section title="P&L today" right={today ? <span style={{ fontSize: 13, color: C.muted2 }}>{today.trades} trade{today.trades === 1 ? "" : "s"} closed</span> : null}>
        {pnl ? (
          <Panel style={{ padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 12 }}>
              <StatTile
                label="Net P&L after charges"
                value={fmtInr(net, { decimals: 0, sign: true })}
                color={pnlColor(net)}
                hero
                sub={`${marks}${equity != null ? ` · equity ${fmtInr(equity, { decimals: 0 })} (${fmtPct((net / pnl.startingEquity) * 100)})` : ""}`}
              />
              <StatTile label="Realized" value={fmtInr(realized, { decimals: 0, sign: true })} color={pnlColor(realized)} sub="closed trades, before charges" />
              <StatTile label="Unrealized" value={fmtInr(unrealized, { decimals: 0, sign: true })} color={pnlColor(unrealized)} sub={`${open.length} open · ${marks}, before charges`} />
              <StatTile label="Charges" value={fmtInr(charges, { decimals: 0 })} color={C.textSoft} sub="brokerage, STT, exchange fees, stamp duty, GST" />
            </div>
            {state && <LossCapBar used={Math.max(0, -net)} cap={state.caps.dailyLossCap} />}
            <p style={{ margin: "14px 0 0", fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
              Net = realized + unrealized − charges.{" "}
              {liveMarked && liveInputs ? (
                <>
                  Unrealized uses <strong style={{ color: C.textSoft, fontWeight: 600 }}>live marks</strong>: open NIFTY options re-priced every 2 s from NIFTY{" "}
                  <span className="tnum">{fmtNum(liveInputs.spot)}</span> and India VIX <span className="tnum">{liveInputs.vix != null ? fmtNum(liveInputs.vix) : "—"}</span> (Yahoo, last trade{" "}
                  {liveFeed ? fmtIstTime(liveFeed.asOf) : "—"} IST) with the engine&apos;s option model, at the bid. The Desk shows{" "}
                  <strong style={{ color: C.textSoft, fontWeight: 600 }}>engine marks</strong> (the engine&apos;s own prices, about every 30 s): at engine marks the net is{" "}
                  <span className="tnum" style={{ color: C.textSoft }}>{fmtInr(engineNet, { decimals: 0, sign: true })}</span>. Stops and targets run on engine marks.
                </>
              ) : (
                <>
                  Unrealized uses <strong style={{ color: C.textSoft, fontWeight: 600 }}>engine marks</strong> (the engine&apos;s own option prices, refreshed about every 30 s), the same
                  definition as the Desk. Live 2-second marks take over while the market is open and the NIFTY feed is fresh.
                </>
              )}
            </p>
          </Panel>
        ) : (
          <Skeleton height={160} />
        )}
      </Section>

      <Section
        title={`Open positions${positions ? ` (${open.length})` : ""}`}
        right={positions && open.length > 0 ? <span style={{ fontSize: 13, color: C.muted2 }}>P&L after entry charges · {marks}</span> : null}
      >
        {positions == null ? (
          <Skeleton height={80} />
        ) : open.length === 0 ? (
          <Panel>
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

      <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
        <DetailsSection title="Capital and P&L split" note="Premium in use and where today's P&L comes from">
          {pnl && positions ? <CapitalPnlPies capital={pnl.startingEquity} positions={open} realized={realized} charges={charges} /> : <Skeleton height={200} />}
        </DetailsSection>
        <DetailsSection title="NIFTY 50 feed and option chain" note="Today's NIFTY path and model option prices">
          <NiftyLiveFeed positions={open} data={liveData} error={liveError} onExpiry={setExpiry} />
        </DetailsSection>
      </div>
    </main>
  );
}
