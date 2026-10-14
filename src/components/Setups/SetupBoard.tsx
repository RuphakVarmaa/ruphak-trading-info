"use client";

/**
 * Trade setups: for NIFTY and SENSEX, the level-based plan the engine reads off the 5-minute chart
 * (strategy/setups.ts), written like a trader's note: the trade, when to enter, stop and targets as
 * index levels and premiums, why, and what kills it. Decision support only; nothing is ordered.
 */
import { chainPollMs } from "@/components/Options/chainView";
import { REFRESH_OTHER_MS } from "@/lib/refresh";
import { useEffect, useState } from "react";
import type { IndexId, SignalView, TradeSetupStatus, TradeSetupView } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { fmtIstHm, fmtNum } from "@/components/shared/format";
import { EmptyState, Panel, Skeleton } from "@/components/shared/ui";
import { usePolled } from "@/hooks/usePolled";
import type { IntradayFeed } from "@/lib/market/intraday";
import { announceSetup, useAlertsOn } from "@/components/Copy/alerts";
import CandleChart, { type ChartLine } from "@/components/Copy/CandleChart";
import { readSession, writeSession } from "@/components/Copy/clientStores";
import { CopyAction } from "@/components/Copy/CopyButton";
import { useSharedPoll } from "@/components/Copy/sharedPoll";
import { alertKey, setupCopyText, tradeLine, triggerProximity } from "./setupText";

const INDICES: IndexId[] = ["NIFTY", "SENSEX"];

const STATUS_COLOR: Record<TradeSetupStatus, string> = {
  WATCHING: C.blue,
  READY: C.orange,
  TRIGGERED: C.green,
  MISSED: C.muted2,
  INVALID: C.red,
};

const n0 = (x: number) => fmtNum(x, 0);
const rupees = (x: number) => `₹${Math.round(x).toLocaleString("en-IN")}`;

function StatusChip({ status }: { status: TradeSetupStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: c, background: alpha(c, 0.12), border: `1px solid ${alpha(c, 0.4)}`, borderRadius: 999, padding: "2px 8px" }}>
      {status}
    </span>
  );
}

function ProximityBar({ s }: { s: TradeSetupView }) {
  const p = triggerProximity(s);
  const past = s.distance <= 0;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ height: 6, borderRadius: 3, background: C.track, overflow: "hidden" }}>
        <div style={{ width: `${Math.round(p * 100)}%`, height: "100%", background: STATUS_COLOR[s.status] }} />
      </div>
      <span className="tnum" style={{ fontSize: 11.5, color: C.muted }}>
        {past ? `Past the trigger by ${n0(-s.distance)} pts · entry valid to ${n0(s.chaseLimit)}` : `${n0(s.distance)} pts to the trigger ${n0(s.trigger)}`}
      </span>
    </div>
  );
}

function LevelsTable({ s }: { s: TradeSetupView }) {
  const o = s.option;
  const lot = o?.contract.lotSize ?? 0;
  const rows: { k: string; idx: number; prem: string; per: string; rr: string; color: string }[] = [
    { k: "Entry", idx: s.trigger, prem: o ? o.entry.toFixed(2) : "—", per: o ? rupees(o.entry * lot) : "—", rr: "", color: C.gold },
    { k: "Stop", idx: s.stop, prem: o ? `${o.stop.toFixed(2)} (${o.stopPct}%${o.stopCapped ? ", capped" : ""})` : "—", per: o ? `−${rupees(o.riskPerLot)}` : "—", rr: "1R", color: C.red },
    { k: `T1 · ${s.t1Label}`, idx: s.t1, prem: o ? o.t1.toFixed(2) : "—", per: o ? `+${rupees(o.rewardT1PerLot)}` : "—", rr: `${s.rr1.toFixed(1)}R`, color: C.green },
    { k: `T2 · ${s.t2Label}`, idx: s.t2, prem: o ? o.t2.toFixed(2) : "—", per: o ? `+${rupees(o.rewardT2PerLot)}` : "—", rr: `${s.rr2.toFixed(1)}R`, color: C.green },
  ];
  const cell = { padding: "6px 8px", borderTop: `1px solid ${C.borderSoft}`, textAlign: "right" as const, whiteSpace: "nowrap" as const };
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tnum" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 320 }}>
        <thead>
          <tr style={{ color: C.muted, fontSize: 11 }}>
            <th style={{ ...cell, textAlign: "left", borderTop: "none", fontWeight: 600 }}>Level</th>
            <th style={{ ...cell, borderTop: "none", fontWeight: 600 }}>Index</th>
            <th style={{ ...cell, borderTop: "none", fontWeight: 600 }}>Premium</th>
            <th style={{ ...cell, borderTop: "none", fontWeight: 600 }}>Per lot</th>
            <th style={{ ...cell, borderTop: "none", fontWeight: 600 }}>R:R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td style={{ ...cell, textAlign: "left", color: r.color, fontWeight: 700, whiteSpace: "nowrap" }}>{r.k}</td>
              <td style={{ ...cell, color: C.textStrong }}>{n0(r.idx)}</td>
              <td style={{ ...cell, color: C.textSoft }}>{r.prem}</td>
              <td style={{ ...cell, color: C.textSoft }}>{r.per}</td>
              <td style={{ ...cell, color: C.muted }}>{r.rr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SetupCard({ s }: { s: TradeSetupView }) {
  const ended = s.status === "MISSED" || s.status === "INVALID";
  const o = s.option;
  return (
    <div style={{ display: "grid", gap: 10, padding: 14, border: `1px solid ${s.status === "TRIGGERED" ? alpha(C.green, 0.5) : C.border}`, borderRadius: 12, background: C.panel, opacity: ended ? 0.7 : 1, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <StatusChip status={s.status} />
        <b style={{ color: C.textStrong, fontSize: 14 }}>{s.name}</b>
        <span style={{ fontSize: 12, fontWeight: 700, color: s.side === "BULL" ? C.green : C.red }}>{s.side === "BULL" ? "CALL (up)" : "PUT (down)"}</span>
        <span className="tnum" style={{ marginLeft: "auto", fontSize: 12, color: C.muted }}>
          score {s.score} · since {fmtIstHm(s.statusSince)}
        </span>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <div className="tnum" style={{ fontSize: 13.5, color: C.textStrong, lineHeight: 1.45, overflowWrap: "anywhere" }}>
          <b>Trade:</b> {tradeLine(s)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <CopyAction text={setupCopyText(s)} label="Copy trade" />
          {o && (
            <span className="tnum" style={{ fontSize: 11.5, color: C.muted2 }}>
              {o.priceSource === "broker" ? "ask" : "model price"} now {o.premiumNow.toFixed(2)} · Δ {o.delta.toFixed(2)} · decay {o.decayPerMin.toFixed(2)}/min{o.iv != null ? ` · IV ${o.iv}%` : ""}
            </span>
          )}
        </div>
      </div>
      {!ended && <ProximityBar s={s} />}
      <LevelsTable s={s} />
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.textSoft }}>Why · built on {s.level.label} {n0(s.level.price)}</span>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2, fontSize: 12.5 }}>
          {s.evidence.map((e) => (
            <li key={e.text} className="tnum" style={{ color: e.supports ? C.textSoft : C.muted2 }}>
              <span style={{ color: e.supports ? C.green : C.red, fontWeight: 700 }}>{e.supports ? "+ " : "− "}</span>
              {e.text}
            </li>
          ))}
        </ul>
      </div>
      {s.cautions.map((c) => (
        <div key={c} style={{ fontSize: 12.5, color: C.orange }}>
          Caution: {c}
        </div>
      ))}
      <div style={{ fontSize: 12.5, color: C.textSoft }}>
        <b>Invalid if</b> {s.invalidation}.
      </div>
    </div>
  );
}

function SetupChart({ index, setups, levels }: { index: IndexId; setups: TradeSetupView[]; levels: SignalView["levels"] }) {
  const feed = usePolled<IntradayFeed>(`/api/market/intraday?index=${index}`, 20_000);
  const top = setups.find((s) => s.status !== "MISSED" && s.status !== "INVALID") ?? setups[0];
  const lines: ChartLine[] = [];
  if (top) {
    lines.push({ price: top.trigger, label: "entry", color: C.gold });
    lines.push({ price: top.stop, label: "stop", color: C.red, dashed: true });
    lines.push({ price: top.t1, label: "T1", color: C.green, dashed: true });
  }
  for (const l of levels ?? []) if (!lines.some((x) => Math.abs(x.price - l.price) < l.price * 0.0004)) lines.push({ price: l.price, label: l.label, color: C.muted3, dashed: true });
  if (feed.data) return <CandleChart feed={feed.data} marks={{}} lines={lines.slice(0, 8)} height={220} />;
  if (feed.error) return <EmptyState style={{ padding: "16px" }}>The {index} chart is unavailable right now.</EmptyState>;
  return <Skeleton height={220} />;
}

function IndexSetups({ signal, index }: { signal: SignalView | null; index: IndexId }) {
  const setups = signal?.setups ?? [];
  return (
    <Panel style={{ padding: 14, display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15, color: C.textStrong }}>{index}</b>
        {signal?.spot != null && (
          <span className="tnum" style={{ fontSize: 13, color: C.muted }}>
            {fmtNum(signal.spot, 2)}
          </span>
        )}
        <span style={{ fontSize: 12, color: C.muted2 }}>{setups.length === 0 ? "" : `${setups.length} setup${setups.length > 1 ? "s" : ""}`}</span>
      </div>
      {setups.length === 0 ? (
        <EmptyState style={{ padding: "14px 12px" }}>{signal?.setupNote ?? `No ${index} setup near a key level right now. Setups show when price comes within about half an ATR of a level worth trading.`}</EmptyState>
      ) : (
        setups.map((s) => <SetupCard key={s.id} s={s} />)
      )}
      <SetupChart index={index} setups={setups} levels={signal?.levels} />
    </Panel>
  );
}

/** Chime and notify once per setup and status (READY, TRIGGERED), when alerts are on. */
function useSetupAlerts(signals: SignalView[] | null) {
  const on = useAlertsOn();
  const keys = (signals ?? []).flatMap((s) => (s.setups ?? []).map((x) => alertKey(x)).filter((k): k is string => k !== null)).join(",");
  useEffect(() => {
    if (!signals) return;
    for (const sig of signals) {
      for (const s of sig.setups ?? []) {
        const k = alertKey(s);
        if (!k) continue;
        const seenKey = `setup:alert:${k}`;
        if (readSession(seenKey)) continue;
        writeSession(seenKey, "1");
        if (on) announceSetup(`${s.status} · ${s.index} ${s.name}`, tradeLine(s), `setup-${s.id}`, s.status === "TRIGGERED");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, on]);
}

/** The poll interval for the market's state now (2 s open, 10 min closed), re-checked every minute. */
function usePollMs(): number {
  const [ms, setMs] = useState(REFRESH_OTHER_MS);
  useEffect(() => {
    const update = () => setMs(chainPollMs(Date.now()));
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);
  return ms;
}

export default function SetupBoard() {
  const poll = useSharedPoll<SignalView[]>("/api/engine/signals", usePollMs());
  useSetupAlerts(poll.data);
  return (
    <section aria-label="Trade setups" style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, color: C.textStrong }}>Trade setups</h2>
        <span style={{ fontSize: 12.5, color: C.muted }}>Levels worth a trade on the 5-minute chart, with the option to buy, the stop and the targets.</span>
      </div>
      {!poll.data && !poll.error ? (
        <Skeleton height={160} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))", gap: 14, alignItems: "start" }}>
          {INDICES.map((i) => (
            <IndexSetups key={i} index={i} signal={poll.data?.find((s) => s.index === i) ?? null} />
          ))}
        </div>
      )}
      <p style={{ margin: 0, fontSize: 11.5, color: C.muted3 }}>
        Setups are chart rules, not a measured edge: our backtests found no buying edge. Paper engine paused. Not investment advice.
      </p>
    </section>
  );
}
