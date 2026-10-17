"use client";

import { C } from "@/components/shared/colors";
import { Dot } from "@/components/shared/ui";
import type { Freshness } from "@/lib/market/liveIndices";
import { fmtFeedAge, freshnessLabel } from "./marketText";

const TONE: Record<Freshness, string> = { live: C.green, stale: C.orange, offline: C.red, loading: C.muted3 };

const SENTENCE: Record<Freshness, (age: string) => string> = {
  live: (age) => `Live: last update ${age} ago`,
  stale: (age) => `Stale: the data is ${age} old`,
  offline: (age) => `Offline: no update for ${age}`,
  loading: () => "Connecting to the feed",
};

/**
 * Feed freshness at a glance: "Live · 1 s" (green), "Stale · 14 s" (orange), "Offline · 2 min" (red),
 * "Connecting…" (grey), with an optional source after it. `closed` (closedLabel()) replaces "Live" in grey
 * while the market is shut, since the poll being seconds old says nothing about the price's age.
 */
export default function FreshnessBadge({ freshness, ageMs, source, closed }: { freshness: Freshness; ageMs: number | null; source?: string; closed?: string | null }) {
  const state: Freshness = ageMs == null ? "loading" : freshness;
  const shut = closed != null && state === "live";
  const color = shut ? C.muted2 : TONE[state];
  const title = `${shut ? `Market closed: last traded prices. ${SENTENCE.live(fmtFeedAge(ageMs ?? 0))}` : SENTENCE[state](ageMs != null ? fmtFeedAge(ageMs) : "")}${source ? ` · ${source}` : ""}`;
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", fontSize: 12.5, lineHeight: 1.4, minWidth: 0 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", color, fontWeight: 600 }}>
        <Dot color={color} size={7} />
        <span className="tnum">{shut ? closed : freshnessLabel(state, ageMs)}</span>
      </span>
      {source && <span style={{ color: C.muted2, fontWeight: 500 }}>{source}</span>}
    </span>
  );
}
