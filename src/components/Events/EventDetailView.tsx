"use client";

import Link from "next/link";
import type { EventClusterDetail, IndexId } from "@/engine/api-types";
import ImpactChip from "@/components/Desk/ImpactChip";
import { ScorerBadge } from "@/components/Desk/EventImpactFeed";
import { alpha, C, dirColor, dirGlyph, getSeverityColor, taxonomyColor } from "@/components/shared/colors";
import { enumLabel, fmtIstDateTime } from "@/components/shared/format";
import { microLabel, Panel, Pill, tableStyle, tableWrap, td, th, theadRow } from "@/components/shared/ui";

const DIR_WORD = (d: number) => (d > 0 ? "Bullish" : d < 0 ? "Bearish" : "Neutral");
const HORIZON_LABEL: Record<EventClusterDetail["horizon"], string> = {
  INTRADAY: "Intraday",
  DAYS_1_2: "1–2 days",
  WEEK: "About a week",
  MONTH_PLUS: "A month or more",
};
const INDEX_LABEL: Record<IndexId, string> = { NIFTY: "NIFTY 50", SENSEX: "SENSEX" };

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...microLabel, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, color: C.textSoft }}>{children}</div>
    </div>
  );
}

export function BackToDesk() {
  return (
    <Link href="/#desk" style={{ fontSize: 11, color: C.gold, textDecoration: "none", fontWeight: 700, letterSpacing: "0.04em" }}>
      ← Back to desk
    </Link>
  );
}

export default function EventDetailView({ detail, source }: { detail: EventClusterDetail; source: "engine" | "mock" }) {
  const sev = getSeverityColor(detail.severity);
  return (
    <main style={{ flex: 1, padding: "24px 30px 48px" }}>
      <article style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <BackToDesk />
          {source === "mock" && <Pill color={C.purple}>◇ mock data</Pill>}
        </div>

        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <Pill color={sev}>{detail.severity}</Pill>
            <Pill color={taxonomyColor(detail.taxonomy)}>⚡ {enumLabel(detail.taxonomy)}</Pill>
            <Pill color={C.muted}>tab: {detail.tab}</Pill>
            <ScorerBadge scorer={detail.scorer} />
            {detail.isScheduledData && <Pill color={C.blue}>scheduled data</Pill>}
            {detail.pricedIn && <Pill color={C.muted}>◌ priced in</Pill>}
          </div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 400, lineHeight: 1.25, color: "#e8e8e8", fontFamily: "var(--font-playfair), 'Playfair Display', Georgia, serif" }}>
            {detail.title}
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 14, color: C.muted, lineHeight: 1.6 }}>{detail.summary}</p>
        </div>

        <Panel style={{ padding: "14px 18px", borderLeft: `3px solid ${C.gold}` }}>
          <div style={{ ...microLabel, marginBottom: 6 }}>Scorer rationale</div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.65, color: C.textSoft }}>
            {detail.rationale || (detail.scorer === "pending" ? "Waiting for the LLM scorer. Impact is not counted until it is scored." : "No rationale recorded.")}
          </p>
        </Panel>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          {detail.impacts.length === 0 ? (
            <Panel style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: C.muted }}>No index impact yet (unscored).</div>
            </Panel>
          ) : (
            detail.impacts.map((imp) => {
              const color = dirColor(imp.direction);
              return (
                <Panel key={imp.index} style={{ padding: 16, borderTop: `2px solid ${color}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.04em" }}>{INDEX_LABEL[imp.index]}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color }}>
                      {dirGlyph(imp.direction)} {DIR_WORD(imp.direction)}
                    </span>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <ImpactChip impact={imp} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                    <Meta label="Score">
                      <span className="tnum" style={{ fontFamily: "monospace", color }}>
                        {imp.score >= 0 ? "+" : "−"}
                        {Math.abs(imp.score).toFixed(2)}
                      </span>
                    </Meta>
                    <Meta label="Expected move">≈ {imp.magnitudePct}%</Meta>
                    <Meta label="Confidence">{Math.round(imp.confidence * 100)}%</Meta>
                    <Meta label="Half-life">{imp.halfLifeHours} h</Meta>
                  </div>
                </Panel>
              );
            })
          )}
        </div>

        <Panel style={{ padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
            <Meta label="First seen">{fmtIstDateTime(detail.firstSeenAt)}</Meta>
            <Meta label="Last article">{fmtIstDateTime(detail.lastSeenAt)}</Meta>
            <Meta label="Coverage">
              {detail.articleCount} articles · {detail.sources.length} sources
            </Meta>
            <Meta label="Still active">
              <span title="Share of the original impact remaining after time decay">{Math.round(detail.decayRemaining * 100)}% of original impact</span>
              <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2, marginTop: 5 }}>
                <div style={{ width: `${Math.round(detail.decayRemaining * 100)}%`, height: "100%", background: C.gold, borderRadius: 2 }} />
              </div>
            </Meta>
            <Meta label="Novelty">{enumLabel(detail.novelty)}</Meta>
            <Meta label="Surprise">{enumLabel(detail.surprise)}</Meta>
            <Meta label="Horizon">{HORIZON_LABEL[detail.horizon] ?? enumLabel(detail.horizon)}</Meta>
            <Meta label="Scored">
              {detail.scoredAt ? fmtIstDateTime(detail.scoredAt) : "not yet"}
              {detail.model && <div style={{ fontSize: 10, color: C.muted3, fontFamily: "monospace" }}>{detail.model}</div>}
            </Meta>
          </div>
          <div style={{ marginTop: 14, fontSize: 11, color: C.muted }}>
            <span style={{ ...microLabel, marginRight: 8 }}>Sources</span>
            {detail.sources.join(" · ")}
          </div>
        </Panel>

        {detail.sectors.length > 0 && (
          <div>
            <div style={{ ...microLabel, marginBottom: 8, color: C.text, fontSize: 11 }}>Sector impact</div>
            <div style={tableWrap}>
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRow}>
                    <th style={th}>Sector</th>
                    <th style={th}>Direction</th>
                    <th style={th}>Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sectors.map((s) => (
                    <tr key={s.sector}>
                      <td style={{ ...td, color: C.textStrong }}>{enumLabel(s.sector)}</td>
                      <td style={{ ...td, color: dirColor(s.direction), fontWeight: 700 }}>
                        {dirGlyph(s.direction)} {DIR_WORD(s.direction)}
                      </td>
                      <td style={td}>
                        <Pill color={s.weight === "HIGH" ? C.gold : s.weight === "MEDIUM" ? C.orange : C.muted}>{s.weight}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div>
          <div style={{ ...microLabel, marginBottom: 8, color: C.text, fontSize: 11 }}>Headlines in this cluster</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {detail.headlines.map((h, i) => (
              <li key={`${h.title}-${i}`} style={{ borderLeft: `2px solid ${alpha(sev, 0.6)}`, paddingLeft: 12, fontSize: 13, lineHeight: 1.5 }}>
                {h.url ? (
                  <a href={h.url} target="_blank" rel="noopener noreferrer" style={{ color: C.textSoft, textDecoration: "none" }}>
                    {">"} {h.title} <span style={{ color: C.muted3, fontSize: 10 }}>↗</span>
                  </a>
                ) : (
                  <span style={{ color: C.textSoft }}>
                    {">"} {h.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </article>
    </main>
  );
}
