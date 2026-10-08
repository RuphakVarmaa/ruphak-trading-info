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
 * "Connecting…" (grey), with an optional source after it.
 */
export default function FreshnessBadge({ freshness, ageMs, source }: { freshness: Freshness; ageMs: number | null; source?: string }) {
  const state: Freshness = ageMs == null ? "loading" : freshness;
  const color = TONE[state];
  const title = `${SENTENCE[state](ageMs != null ? fmtFeedAge(ageMs) : "")}${source ? ` · ${source}` : ""}`;
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", fontSize: 12.5, lineHeight: 1.4, minWidth: 0 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", color, fontWeight: 600 }}>
        <Dot color={color} size={7} />
        <span className="tnum">{freshnessLabel(state, ageMs)}</span>
      </span>
      {source && <span style={{ color: C.muted2, fontWeight: 500 }}>{source}</span>}
    </span>
  );
}
