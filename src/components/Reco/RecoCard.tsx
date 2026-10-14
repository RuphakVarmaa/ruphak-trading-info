"use client";

/**
 * "₹10k trade now": per index, the engine's recommendation for a ₹10,000 account in large type — ENTER with
 * the exact order (contract, lots, limit price, how long it is valid) and a copy button, or WAIT / NO TRADE
 * and why — with the stop, targets and time exit as premiums and index levels, the rupees at cost, risk and
 * reward, the reasons, the grade, and the measured history of the rule behind it (sample, hit rate, average
 * rupees per lot after charges, 95% range, verdict, data range). The engine's honest line stays visible
 * whenever the grade is not A. Chimes and notifies once when an index turns ENTER (alerts on).
 * Decision support only: nothing is ordered.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { IndexId, SignalView } from "@/engine/api-types";
import { FLOW_STATS } from "@/engine/flow/flowStats.generated";
import { alpha, C } from "@/components/shared/colors";
import { fmtAge, fmtIstTime } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { EmptyState, microLabel, Panel, Pill, Skeleton } from "@/components/shared/ui";
import { OrderText } from "@/components/Copy/ActionStrip";
import AlertsToggle from "@/components/Copy/AlertsToggle";
import { announceSetup, useAlertsOn } from "@/components/Copy/alerts";
import { readSession, writeSession } from "@/components/Copy/clientStores";
import { CopyAction } from "@/components/Copy/CopyButton";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import { useMarketPollMs } from "@/components/Flow/useMarketPoll";
import { useClockOffset } from "@/hooks/useEngineState";
import { REFRESH_IMPORTANT_MS } from "@/lib/refresh";
import {
  capitalLabel,
  clockText,
  GRADE_COLOR,
  GRADE_TITLE,
  historyRows,
  indexLevel,
  orderLine,
  premium,
  recoAlertKey,
  recoCopyText,
  recoNotice,
  recosFrom,
  recoState,
  rrText,
  rupees,
  showHonestLine,
  STATUS_COLOR,
  STATUS_WORDS,
  VERDICT_META,
  type Reco,
} from "./recoText";

const INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];

// ---------------------------------------------------------------------------
// Alerts: once per index, contract and status, only for a fresh ENTER
// ---------------------------------------------------------------------------

function useRecoAlerts(fresh: Reco[]) {
  const on = useAlertsOn();
  const latest = useRef(fresh);
  useEffect(() => {
    latest.current = fresh;
  });
  const keys = fresh
    .map(recoAlertKey)
    .filter((k): k is string => k !== null)
    .join(",");
  useEffect(() => {
    for (const r of latest.current) {
      const k = recoAlertKey(r);
      if (!k) continue;
      const seen = `reco:alert:${k}`;
      if (readSession(seen)) continue;
      writeSession(seen, "1");
      if (on) {
        const n = recoNotice(r);
        announceSetup(n.title, n.body, `reco-${r.index}`, true);
      }
    }
  }, [keys, on]);
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Level({ label, value, sub, color }: { label: string; value: string; sub?: string | null; color: string }) {
  return (
    <div style={{ display: "grid", gap: 2, padding: "8px 10px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.panelAlt, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color }}>{label}</span>
      <span className="tnum" style={{ fontSize: 17, fontWeight: 700, color: C.textStrong, overflowWrap: "anywhere" }}>
        {value}
      </span>
      {sub && (
        <span className="tnum" style={{ fontSize: 11.5, color: C.muted }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function Money({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 12, color: C.muted }}>{label}</span>
      <b className="tnum" style={{ fontSize: 14.5, color: color ?? C.textStrong }}>
        {value}
      </b>
    </span>
  );
}

function HistoryBox({ r }: { r: Reco }) {
  const h = r.historical;
  const box: CSSProperties = { display: "grid", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel };
  if (!h) {
    return (
      <div style={box}>
        <span style={{ ...microLabel, color: C.textSoft }}>Measured history</span>
        <span style={{ fontSize: 13, color: C.muted, lineHeight: 1.45 }}>No measured history backs this. Treat it as untested.</span>
      </div>
    );
  }
  const v = VERDICT_META[h.verdict];
  return (
    <div style={box}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ ...microLabel, color: C.textSoft }}>Measured history</span>
        <Pill color={v.color} title={v.meaning}>
          {v.label}
        </Pill>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))", gap: "6px 12px", margin: 0 }}>
        {historyRows(h).map((row) => (
          <div key={row.label} style={{ display: "grid", gap: 1, minWidth: 0 }}>
            <dt style={{ fontSize: 11.5, color: C.muted }}>{row.label}</dt>
            <dd className="tnum" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: row.color ?? C.textStrong, overflowWrap: "anywhere" }}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <span style={{ fontSize: 11.5, color: C.muted2, lineHeight: 1.45, overflowWrap: "anywhere" }}>
        {v.meaning} Rule{h.ruleIds.length > 1 ? "s" : ""} {h.ruleIds.join(", ") || "—"} · data {h.dataRange}
      </span>
    </div>
  );
}

function IndexReco({ index, r, engineNowMs, loading }: { index: IndexId; r: Reco | null | undefined; engineNowMs: number | null; loading: boolean }) {
  const shell = (border: string, children: ReactNode) => (
    <div style={{ display: "grid", gap: 12, padding: "14px clamp(12px, 1.6vw, 14px)", borderRadius: 12, border: `1px solid ${border}`, background: C.panel, minWidth: 0, alignContent: "start" }}>{children}</div>
  );
  if (loading) return shell(C.border, <><Skeleton width={120} height={30} /><Skeleton height={18} /><Skeleton height={60} /></>);
  if (!r) {
    return shell(
      C.border,
      <>
        <b style={{ fontSize: 15, color: C.textStrong }}>{index}</b>
        <EmptyState style={{ padding: "12px 4px", textAlign: "left" }}>
          {r === null ? "No recommendation from the engine right now." : "The engine does not publish ₹10k recommendations yet."}
        </EmptyState>
      </>,
    );
  }
  const st = recoState(r, engineNowMs);
  const enter = r.status === "ENTER";
  const line = orderLine(r);
  const actionable = enter && line != null && !st.stale && !st.expired;
  const color = STATUS_COLOR[r.status];
  const lot = r.contract?.lotSize ?? 0;
  return shell(
    actionable ? alpha(C.green, 0.55) : C.border,
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px" }}>
        <b style={{ fontSize: 15, color: C.textStrong }}>{index}</b>
        <span style={{ fontSize: "clamp(26px, 3vw, 32px)", fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.01em", color: st.stale ? C.muted : color }}>{STATUS_WORDS[r.status]}</span>
        <Pill color={GRADE_COLOR[r.grade]} title={GRADE_TITLE}>
          Grade {r.grade}
        </Pill>
        <span className="tnum" style={{ marginLeft: "auto", fontSize: 12, color: st.stale ? C.orange : C.muted }}>
          reading {fmtIstTime(r.asOf)}
          {st.ageMs != null && ` · ${fmtAge(st.ageMs)} old`}
        </span>
      </div>

      {st.stale && <div style={{ fontSize: 13, fontWeight: 600, color: C.orange }}>This reading is out of date: don&apos;t act on it until it refreshes.</div>}

      {line && (
        <div style={{ display: "grid", gap: 10, padding: "12px 12px", borderRadius: 10, background: actionable ? alpha(C.green, 0.06) : C.panelAlt, border: `1px solid ${actionable ? alpha(C.green, 0.3) : C.border}` }}>
          <OrderText text={line} style={{ fontSize: "clamp(16px, 1.7vw, 19px)", fontWeight: 700, color: enter ? C.textStrong : C.muted, lineHeight: 1.45 }} />
          {enter ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <CopyAction text={recoCopyText(r)} label="Copy order" tone={actionable ? "action" : "quiet"} />
              {st.expired && <span style={{ fontSize: 13, fontWeight: 600, color: C.red }}>Its validity has passed: wait for the next reading.</span>}
            </div>
          ) : (
            <span style={{ fontSize: 12.5, color: C.muted }}>Planned, not yet an entry.</span>
          )}
        </div>
      )}
      {r.entry?.trigger && (
        <div style={{ fontSize: 13.5, color: C.textSoft, lineHeight: 1.45 }}>
          <b>Entry:</b> {r.entry.trigger}
        </div>
      )}

      {(r.stop || r.target || r.timeExit) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 112px), 1fr))", gap: 8 }}>
          {r.entry && <Level label="Limit" value={premium(r.entry.limit)} sub={lot ? `${rupees(r.entry.limit * lot)} a lot` : null} color={C.gold} />}
          {r.stop && <Level label="Stop" value={premium(r.stop.premium)} sub={r.stop.index != null ? `${index} ${indexLevel(r.stop.index)}` : null} color={C.red} />}
          {r.target && <Level label="Target 1" value={premium(r.target.t1)} sub={r.target.indexT1 != null ? `${index} ${indexLevel(r.target.indexT1)}` : null} color={C.green} />}
          {r.target?.t2 != null && <Level label="Target 2" value={premium(r.target.t2)} color={C.green} />}
          {r.timeExit && <Level label="Exit by" value={clockText(r.timeExit) ?? "—"} sub="time exit, IST" color={C.blue} />}
        </div>
      )}

      {enter && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          <Money label="Cost" value={rupees(r.costRupees)} />
          <Money label="Risk" value={rupees(r.riskRupees)} color={C.red} />
          <Money label="Reward (T1)" value={rupees(r.rewardRupees)} color={C.green} />
          <Money label="R:R" value={rrText(r.rr)} />
          <Money label="Lots" value={r.lots} />
        </div>
      )}

      {r.reasons.length > 0 && (
        <ul style={{ listStyle: "disc", margin: 0, paddingLeft: 18, display: "grid", gap: 3, fontSize: 13, color: C.textSoft, lineHeight: 1.45 }}>
          {r.reasons.map((x) => (
            <li key={x} className="tnum">
              {x}
            </li>
          ))}
        </ul>
      )}

      <HistoryBox r={r} />

      {showHonestLine(r) && (
        <div role="note" style={{ padding: "10px 12px", borderRadius: 10, borderLeft: `3px solid ${C.orange}`, background: alpha(C.orange, 0.08), fontSize: 13.5, fontWeight: 600, color: C.textStrong, lineHeight: 1.5 }}>
          {r.honestLine}
        </div>
      )}
    </>,
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface RecoCardProps {
  /** The engine-clock offset (ms) when the page knows a better one than the engine provider's. */
  clockOffsetMs?: number;
  /** Show the alerts switch (pages without the action strip, which has its own). */
  showAlertsToggle?: boolean;
  id?: string;
}

export default function RecoCard({ clockOffsetMs, showAlertsToggle = false, id = "trade-now" }: RecoCardProps) {
  const providerOffset = useClockOffset();
  const offset = clockOffsetMs ?? providerOffset;
  const alertsOn = useAlertsOn();
  const { pollMs, nowMs } = useMarketPollMs(REFRESH_IMPORTANT_MS, offset);
  // Background polling while alerts are on, so an ENTER can still chime in a hidden tab.
  const poll = useSharedPoll<SignalView[]>("/api/engine/signals", pollMs, alertsOn);
  const recos = recosFrom(poll.data, INDICES);
  const engineNowMs = nowMs == null ? null : nowMs + offset;
  const fresh = INDICES.map((i) => recos[i]).filter((r): r is Reco => {
    if (!r) return false;
    const s = recoState(r, engineNowMs);
    return !s.stale && !s.expired;
  });
  useRecoAlerts(fresh);

  const capital = INDICES.map((i) => recos[i]?.capital).find((c): c is number => c != null && c > 0) ?? 10_000;
  const loading = poll.data == null && poll.error == null;
  const error = plainError(poll.error);
  const ageMs = nowMs != null && poll.at != null ? nowMs - poll.at : null;

  return (
    <section id={id} aria-label={`${capitalLabel(capital)} trade now`} style={{ scrollMarginTop: 84, minWidth: 0 }}>
      <Panel style={{ padding: "16px clamp(12px, 2vw, 16px)", display: "grid", gap: 14, border: `1px solid ${alpha(C.gold, 0.35)}` }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "8px 16px" }}>
          <div style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 320px" }}>
            <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(24px, 2.6vw, 30px)", fontWeight: 500, letterSpacing: "-0.015em", color: C.textStrong }}>{capitalLabel(capital)} trade now</h2>
            <span style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              One exact order per index for a {rupees(capital)} account, with the measured history of the rule behind it. Decision support only: nothing is ordered for you.
            </span>
          </div>
          <div style={{ display: "grid", gap: 6, justifyItems: "start", minWidth: 0 }}>
            {showAlertsToggle && <AlertsToggle compact />}
            <span className="tnum" style={{ fontSize: 12, color: error ? C.red : C.muted2 }}>
              {error ? `${error} Retrying.` : ageMs == null ? "connecting…" : `updated ${fmtAge(ageMs)} ago`}
            </span>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))", gap: 12, alignItems: "start" }}>
          {INDICES.map((i) => (
            <IndexReco key={i} index={i} r={recos[i]} engineNowMs={engineNowMs} loading={loading} />
          ))}
        </div>
        <div style={{ display: "grid", gap: 4, padding: "10px 12px", borderRadius: 10, background: C.panelAlt, border: `1px solid ${C.border}` }}>
          <span style={{ ...microLabel, color: C.textSoft }}>What the history says</span>
          <ul style={{ listStyle: "disc", margin: 0, paddingLeft: 18, display: "grid", gap: 3, fontSize: 12.5, color: C.textSoft, lineHeight: 1.5 }}>
            {FLOW_STATS.honestSummary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </Panel>
    </section>
  );
}
