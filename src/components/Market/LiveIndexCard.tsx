"use client";

import type { ReactNode } from "react";
import { C, dirColor, dirGlyph } from "@/components/shared/colors";
import { fmtIstDay, fmtIstTime, fmtNum } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { Dot, Panel } from "@/components/shared/ui";
import { useClientNow } from "@/hooks/useEngineState";
import { istTimeOn, type Freshness, type LiveIndex } from "@/lib/market/liveIndices";
import { istDay } from "./chartGeometry";
import FreshnessBadge from "./FreshnessBadge";
import { changeText, closedLabel, rangeText } from "./marketText";

const NUM = { fontFamily: "var(--font-num)" } as const;

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div title={title} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: `1px solid ${C.borderSoft}`, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, color: C.muted, whiteSpace: "nowrap" }}>{label}</span>
      <span className="tnum" style={{ ...NUM, fontSize: 13, color: C.textStrong, fontWeight: 600, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

/**
 * One index at a glance: price, change against the previous close ("—" when that is unknown, never a
 * guess), day range, VWAP, opening range, open, and the last trade time with its source. `children` (for
 * example a LiveIndexChart) sit above the source line; `note` explains a stale value in a sentence.
 */
export default function LiveIndexCard({
  index,
  freshness,
  ageMs,
  source,
  note,
  marketOpen,
  children,
}: {
  index: LiveIndex;
  freshness: Freshness;
  ageMs: number | null;
  source: string;
  note?: string | null;
  /** The feed's market phase is OPEN; false shows "Closed · last trade …" in place of "Live". */
  marketOpen?: boolean;
  children?: ReactNode;
}) {
  const now = useClientNow();
  const change = changeText(index);
  const otherDay = now != null && index.session !== istDay(now);
  const closed = otherDay || marketOpen === false ? closedLabel(index.asOf, now) : null;
  const sessionDay = fmtIstDay(`${index.session}T12:00:00+05:30`);
  const noteColor = freshness === "offline" ? C.red : C.orange;
  const or = index.openingRange;
  const lastBar = index.bars[index.bars.length - 1];
  const orForming = !or && lastBar != null && lastBar.t < istTimeOn(index.session, "09:30");

  return (
    <Panel style={{ minWidth: 0 }}>
      <div style={{ padding: "14px 16px 12px", display: "grid", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "4px 12px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", minWidth: 0 }}>
            <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 500, lineHeight: 1.2, color: C.textStrong, letterSpacing: "-0.01em" }}>{index.label}</h3>
            {otherDay && <span style={{ fontSize: 12, color: C.muted }}>Last session, {sessionDay}</span>}
          </div>
          <FreshnessBadge freshness={freshness} ageMs={ageMs} closed={closed} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 12px" }}>
          <span className="tnum" style={{ ...NUM, fontSize: 30, fontWeight: 650, lineHeight: 1.1, letterSpacing: "-0.02em", color: C.textStrong }}>
            {fmtNum(index.price)}
          </span>
          <span className="tnum" style={{ ...NUM, fontSize: 14.5, fontWeight: 600, color: change.dir ? dirColor(change.dir) : C.muted }}>
            {change.dir !== 0 && <span aria-hidden>{dirGlyph(change.dir)} </span>}
            {change.text}
          </span>
        </div>
        <div className="tnum" style={{ fontSize: 12.5, color: C.muted, marginTop: -6 }}>
          {index.prevClose != null ? (
            <>
              vs previous close {fmtNum(index.prevClose)} (
              {index.prevCloseSource === "intraday" ? "last 5-minute bar of the previous session; Yahoo's daily close is not out yet" : "Yahoo daily chart"})
            </>
          ) : (
            <>Previous close not available yet from Yahoo, so no change is shown.</>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", columnGap: 20 }}>
          <Stat label="Day range" value={rangeText(index.low, index.high)} title="Low and high of the session as Yahoo reports them" />
          <Stat label="VWAP" value={index.vwap != null ? fmtNum(index.vwap) : "—"} title="Mean typical price of the 1-minute bars (index volume is 0, so bars weigh the same)" />
          <Stat label="Opening range" value={or ? rangeText(or.low, or.high) : orForming ? "Forms by 09:30 IST" : "—"} title="Low and high of 09:15–09:29 IST" />
          <Stat label="Open" value={index.open != null ? fmtNum(index.open) : "—"} />
        </div>

        {note && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, fontSize: 12.5, lineHeight: 1.5, color: noteColor }}>
            <Dot color={noteColor} size={7} />
            <span>{note}</span>
          </div>
        )}

        {children != null && <div style={{ minWidth: 0 }}>{children}</div>}

        <div className="tnum" style={{ fontSize: 12, color: C.muted2, lineHeight: 1.5 }}>
          Last trade {fmtIstTime(index.asOf)} IST, {fmtIstDay(index.asOf)} · {source}
        </div>
      </div>
    </Panel>
  );
}
