"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EVENT_TABS, type EventClusterView, type EventTab } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, getSeverityColor, taxonomyColor } from "@/components/shared/colors";
import { enumLabel, fmtIstHm, timeAgo } from "@/components/shared/format";
import { Btn, Dot, EmptyState, Panel, PanelHeader, Pill, Skeleton, TabBar } from "@/components/shared/ui";
import ImpactChip from "./ImpactChip";

export function ScorerBadge({ scorer }: { scorer: EventClusterView["scorer"] }) {
  if (scorer === "llm") return <Pill color={C.gold} title="Scored by the LLM rubric">LLM</Pill>;
  if (scorer === "fallback") return <Pill color={C.muted} title="Lexicon fallback score (low confidence)">LEXICON</Pill>;
  return (
    <Pill color={C.blue} title="Waiting for the LLM scorer">
      <Dot color={C.blue} size={5} pulse /> PENDING
    </Pill>
  );
}

export function sourcesLine(sources: string[], max = 2): string {
  if (sources.length <= max) return sources.join(", ");
  return `${sources.slice(0, max).join(", ")} +${sources.length - max}`;
}

function FeedRow({ e, now }: { e: EventClusterView; now: number | null }) {
  const sev = getSeverityColor(e.severity);
  return (
    <article style={{ padding: "14px 16px", borderTop: `1px solid ${C.borderSoft}`, opacity: e.pricedIn ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <span style={{ color: sev, fontWeight: 800, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 5 }}>
            {e.severity === "FLASH" && <Dot color={C.red} pulse />}
            {e.severity}
          </span>
          <span style={{ color: taxonomyColor(e.taxonomy), fontWeight: 600 }}>{enumLabel(e.taxonomy)}</span>
          <ScorerBadge scorer={e.scorer} />
        </div>
        <span
          className="tnum"
          title={`First seen ${fmtIstHm(e.firstSeenAt)} IST · last article ${fmtIstHm(e.lastSeenAt)} IST`}
          style={{ color: C.muted3, whiteSpace: "nowrap" }}
        >
          {now == null ? fmtIstHm(e.firstSeenAt) : timeAgo(e.firstSeenAt, now)}
        </span>
      </div>
      <Link href={`/events/${encodeURIComponent(e.clusterId)}`} style={{ color: C.textStrong, fontSize: 14, fontWeight: 600, lineHeight: 1.45, textDecoration: "none", display: "block" }}>
        {e.title}
      </Link>
      {(e.impacts.length > 0 || e.pricedIn) && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          {e.impacts.map((i) => (
            <ImpactChip key={i.index} impact={i} />
          ))}
          {e.pricedIn && (
            <Pill color={C.muted} title="Market had already priced this in; impact heavily discounted">
              ◌ priced in
            </Pill>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, fontSize: 11, color: C.muted3, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          {e.articleCount} article{e.articleCount === 1 ? "" : "s"} · {sourcesLine(e.sources)}
        </span>
        {e.scorer !== "pending" && <span title="Share of the original impact still active after time decay">· {Math.round(e.decayRemaining * 100)}% still active</span>}
        {e.topUrl && (
          <a href={e.topUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", marginLeft: "auto", fontWeight: 600 }}>
            Source ↗
          </a>
        )}
      </div>
    </article>
  );
}

const PAGE = 8;

/** Scored news stories, newest first, by category; the first few are shown and the rest on request. */
export default function EventImpactFeed() {
  const { events, status } = useEngineState();
  const now = useNow();
  const [tab, setTab] = useState<EventTab>("ALL");
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(() => {
    const c: Partial<Record<EventTab, number>> = {};
    for (const e of events ?? []) c[e.tab] = (c[e.tab] ?? 0) + 1;
    return c;
  }, [events]);
  const rows = (events ?? []).filter((e) => tab === "ALL" || e.tab === tab);

  return (
    <Panel>
      <PanelHeader
        title="Scored stories"
        live={status === "live"}
        right={events ? <span style={{ fontSize: 11, color: C.muted3, letterSpacing: "0.02em", textTransform: "none" }}>{events.length} in the last 48 h</span> : undefined}
      />
      <TabBar
        label="Event categories"
        tabs={EVENT_TABS}
        active={tab}
        onChange={(t) => {
          setTab(t);
          setShown(PAGE);
        }}
        counts={counts}
      />
      {events == null ? (
        <div style={{ padding: 16, display: "grid", gap: 16 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} style={{ display: "grid", gap: 6 }}>
              <Skeleton width="40%" height={10} />
              <Skeleton height={14} />
              <Skeleton width="70%" height={12} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>No scored stories in this category.</EmptyState>
      ) : (
        <>
          {rows.slice(0, shown).map((e) => (
            <FeedRow key={e.clusterId} e={e} now={now} />
          ))}
          {rows.length > shown && (
            <div style={{ padding: 12, borderTop: `1px solid ${C.borderSoft}`, textAlign: "center" }}>
              <Btn variant="outline" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
              </Btn>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
