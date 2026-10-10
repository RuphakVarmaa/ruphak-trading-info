"use client";

import { useId } from "react";
import { C, dirColor, dirGlyph } from "@/components/shared/colors";
import { fmtIstTime } from "@/components/shared/format";
import { fallbackPhase } from "@/components/shared/market";
import { SERIF } from "@/components/shared/theme";
import { Dot, EmptyState, Panel, Skeleton } from "@/components/shared/ui";
import { useClientNow } from "@/hooks/useEngineState";
import { useLiveIndices } from "@/hooks/useLiveIndices";
import { LIVE_POLL_MS, pollIntervalFor, type LiveIndexId } from "@/lib/market/liveIndices";
import { istDay } from "./chartGeometry";
import FreshnessBadge from "./FreshnessBadge";
import LiveIndexCard from "./LiveIndexCard";
import LiveIndexChart from "./LiveIndexChart";
import { closedLabel, entryFreshness, panelStatus, phaseSentence, vixText } from "./marketText";

const INDICES: { id: LiveIndexId; label: string }[] = [
  { id: "NIFTY", label: "NIFTY 50" },
  { id: "SENSEX", label: "SENSEX" },
];
const TONE = { wait: C.muted3, stale: C.orange, down: C.red } as const;

function CardHeading({ label }: { label: string }) {
  return <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 500, lineHeight: 1.2, color: C.textStrong }}>{label}</h3>;
}

function LoadingCard({ label }: { label: string }) {
  return (
    <Panel>
      <div style={{ padding: "14px 16px", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <CardHeading label={label} />
          <FreshnessBadge freshness="loading" ageMs={null} />
        </div>
        <Skeleton width={180} height={30} />
        <Skeleton height={64} />
        <Skeleton height={220} />
      </div>
    </Panel>
  );
}

function MissingCard({ label }: { label: string }) {
  return (
    <Panel>
      <div style={{ padding: "14px 16px" }}>
        <CardHeading label={label} />
        <EmptyState>{label} did not load from Yahoo Finance in the last 2 minutes. It will show when a refresh brings it.</EmptyState>
      </div>
    </Panel>
  );
}

/**
 * NIFTY 50 and SENSEX side by side (stacked on phones), each with its card and 1-minute chart, plus India
 * VIX, from the page's one shared poll of /api/market/live. Loading, stale and failed states are sentences.
 */
export default function LiveIndicesPanel() {
  const live = useLiveIndices();
  const { data, freshness, ageMs } = live;
  const now = useClientNow();
  const headingId = useId();
  const phase = data?.marketPhase ?? (now != null ? fallbackPhase(now) : null);
  const status = panelStatus(live, phase ? pollIntervalFor(phase) : LIVE_POLL_MS);
  const feed = entryFreshness(data, null, freshness, ageMs);
  const lastTrade = data?.indices.reduce<string | null>((m, i) => (m == null || Date.parse(i.asOf) > Date.parse(m) ? i.asOf : m), null) ?? null;
  // Shut, or open but no index has printed today yet: the last trades are the previous session's.
  const noPrintToday = data != null && now != null && data.indices.length > 0 && data.indices.every((i) => i.session !== istDay(now));
  const closed = phase != null && (phase !== "OPEN" || noPrintToday) && lastTrade != null ? closedLabel(lastTrade, now) : null;
  const vix = data?.vix ?? null;
  const vt = vix ? vixText(vix) : null;

  return (
    <section aria-labelledby={headingId} style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "6px 16px" }}>
        <div style={{ minWidth: 0, maxWidth: 760 }}>
          <h2 id={headingId} style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(22px, 2.4vw, 27px)", fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.012em", color: C.textStrong }}>
            NIFTY 50 and SENSEX
          </h2>
          <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.55, color: C.muted }}>
            {data ? phaseSentence(data) : `1-minute index bars from Yahoo Finance, refreshed every ${LIVE_POLL_MS / 1000} s while the market is open.`}
          </p>
        </div>
        <FreshnessBadge freshness={feed.freshness} ageMs={feed.ageMs} source={data ? "Yahoo Finance" : undefined} closed={closed} />
      </div>

      {status && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13.5, lineHeight: 1.5, color: status.tone === "wait" ? C.muted : TONE[status.tone] }}>
          <Dot color={TONE[status.tone]} size={7} />
          <span>{status.text}</span>
        </div>
      )}

      {data && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px", padding: "10px 14px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "var(--shadow-card)" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: C.textStrong }}>India VIX</span>
          {vix && vt ? (
            <>
              <span className="tnum" style={{ fontFamily: "var(--font-num)", fontSize: 16, fontWeight: 650, color: C.textStrong }}>
                {vt.value}
              </span>
              <span className="tnum" style={{ fontFamily: "var(--font-num)", fontSize: 13.5, fontWeight: 600, color: vt.dir ? dirColor(vt.dir) : C.muted }}>
                {vt.dir !== 0 && <span aria-hidden>{dirGlyph(vt.dir)} </span>}
                {vt.change}
              </span>
              <span className="tnum" style={{ fontSize: 12, color: C.muted2 }}>
                previous close {vt.prevClose ?? "not available yet"}
                {vix.prevCloseSource === "intraday" ? " (last 5-minute bar)" : ""} · last value {fmtIstTime(vix.asOf)} IST
              </span>
              {vix.stale && <span style={{ fontSize: 12, color: C.orange }}>Not refreshed in the latest fetch.</span>}
            </>
          ) : (
            <span style={{ fontSize: 12.5, color: C.muted }}>did not load from Yahoo Finance in the last 2 minutes.</span>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 16, alignItems: "start", minWidth: 0 }}>
        {INDICES.map(({ id, label }) => {
          const index = data?.indices.find((i) => i.index === id);
          if (!data) return <LoadingCard key={id} label={label} />;
          if (!index) return <MissingCard key={id} label={label} />;
          const f = entryFreshness(data, index, freshness, ageMs);
          // Feed-wide trouble is in the status line; a card only explains its own (one symbol stale or lagging).
          const own = !data.stale && freshness === "live" && f.freshness !== "live";
          return (
            <LiveIndexCard key={id} index={index} freshness={f.freshness} ageMs={f.ageMs} source={data.source} note={own ? f.note : null} marketOpen={data.marketPhase === "OPEN"}>
              <LiveIndexChart index={index} />
            </LiveIndexCard>
          );
        })}
      </div>
    </section>
  );
}
