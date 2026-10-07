"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EVENT_TABS, type EventClusterView, type EventTab } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { alpha, C, getSeverityColor, taxonomyColor } from "@/components/shared/colors";
import { enumLabel, fmtIstHm, timeAgo } from "@/components/shared/format";
import { Dot, EmptyState, PanelHeader, Pill, Skeleton, TabBar } from "@/components/shared/ui";
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
    <article style={{ borderLeft: `2px solid ${sev}`, paddingLeft: 12, opacity: e.pricedIn ? 0.5 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <span style={{ color: sev, fontWeight: 700, letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 4 }}>
            {e.severity === "FLASH" && <Dot color={C.red} pulse />}
            {e.severity}
          </span>
          <span style={{ color: taxonomyColor(e.taxonomy), fontWeight: 600, fontSize: 9 }}>⚡ {enumLabel(e.taxonomy)}</span>
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
      <Link
        href={`/events/${encodeURIComponent(e.clusterId)}`}
        style={{ color: C.textSoft, fontSize: 12, lineHeight: 1.5, textDecoration: "none", display: "block" }}
      >
        {">"} {e.title}
      </Link>
      {(e.impacts.length > 0 || e.pricedIn) && (
        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
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
      <div style={{ display: "flex", gap: 8, marginTop: 5, fontSize: 9, color: C.muted3, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          {e.articleCount} article{e.articleCount === 1 ? "" : "s"} · {sourcesLine(e.sources)}
        </span>
        {e.scorer !== "pending" && (
          <span title="Share of the original impact still active after time decay">· {Math.round(e.decayRemaining * 100)}% active</span>
        )}
        {e.topUrl && (
          <a href={e.topUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.muted, textDecoration: "none", marginLeft: "auto" }}>
            source ↗
          </a>
        )}
      </div>
    </article>
  );
}

export default function EventImpactFeed() {
  const { events, status } = useEngineState();
  const now = useNow();
  const [tab, setTab] = useState<EventTab>("ALL");

  const counts = useMemo(() => {
    const c: Partial<Record<EventTab, number>> = {};
    for (const e of events ?? []) c[e.tab] = (c[e.tab] ?? 0) + 1;
    return c;
  }, [events]);
  const rows = (events ?? []).filter((e) => tab === "ALL" || e.tab === tab);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.panel }}>
      <PanelHeader
        icon="◉"
        title="Event impact feed"
        live={status === "live"}
        right={events ? <span style={{ fontSize: 9, color: C.muted3, letterSpacing: "0.04em" }}>{events.length} clusters</span> : undefined}
      />
      <TabBar label="Event categories" tabs={EVENT_TABS} active={tab} onChange={setTab} counts={counts} />
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        {events == null ? (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${alpha(C.muted, 0.4)}`, paddingLeft: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <Skeleton width="40%" height={9} />
              <Skeleton height={12} />
              <Skeleton width="70%" height={12} />
            </div>
          ))
        ) : rows.length === 0 ? (
          <EmptyState>No scored events in this category.</EmptyState>
        ) : (
          rows.map((e) => <FeedRow key={e.clusterId} e={e} now={now} />)
        )}
      </div>
    </div>
  );
}
