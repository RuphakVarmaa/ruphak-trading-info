"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import ImpactChip from "@/components/Desk/ImpactChip";
import { alpha, C, dirColor, regimeColor, regimeGlyph, taxonomyColor } from "@/components/shared/colors";
import { enumLabel, fmtDuration, fmtIstHm } from "@/components/shared/format";
import { microLabel, Panel, Pill } from "@/components/shared/ui";
import { placeReason } from "@/lib/geo/places";
import type { EngineLinkView, EngineVerdict, GeoAnswer } from "./geoView";

const TONE: Record<GeoAnswer["tone"], string> = { action: C.green, hold: C.blue, idle: C.muted, stale: C.orange };

const signed2 = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}`;

function VerdictLine({ v }: { v: EngineVerdict }) {
  switch (v.kind) {
    case "HOLDING":
      return (
        <span>
          <b style={{ color: C.blue }}>HOLDING</b> {v.contractLabel}
          {v.eventLed ? " (entered on the news signal)" : ""}
        </span>
      );
    case "ENTERING":
      return (
        <span>
          <b style={{ color: C.green }}>ENTER</b> {v.contractLabel}: every check passed
        </span>
      );
    case "ENTER_ADVICE":
      return (
        <span>
          <b style={{ color: C.green }}>ENTER</b> {v.contractLabel} (advice: the paper book itself is paused{v.pausedBy.length > 0 ? ` by ${v.pausedBy.join("; ")}` : ""})
        </span>
      );
    case "WAIT":
      return (
        <span>
          <b style={{ color: C.textStrong }}>WAIT</b>: {v.reason}
          {v.trigger && <span style={{ display: "block", color: C.muted, marginTop: 3 }}>Would enter when: {v.trigger}</span>}
        </span>
      );
    case "STALE":
      return (
        <span>
          <b style={{ color: C.orange }}>STALE</b>: the last reading is {fmtDuration(v.ageMs)} old
        </span>
      );
    case "NO_SIGNAL":
      return <span style={{ color: C.muted }}>No reading from the engine yet.</span>;
  }
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...microLabel, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: C.textSoft, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

/** One index: does the news make a trade possible now, and why. Every figure is the engine's own. */
export default function EngineLinkCard({ link }: { link: EngineLinkView }) {
  const { vote, answer } = link;
  const tone = TONE[answer.tone];
  return (
    <Panel style={{ padding: "18px 20px", display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.textStrong, letterSpacing: "0.02em" }}>{link.index}</span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {link.regime && (
            <Pill color={regimeColor(link.regime)} title="The engine's market regime at its last decision">
              {regimeGlyph(link.regime)} {enumLabel(link.regime)}
            </Pill>
          )}
          {link.regime === "EVENT" && (
            <Pill color={C.purple} solid title="News regime: only EVENT, GAP and TREND vote">
              news regime
            </Pill>
          )}
          {link.computedAt && <span style={{ fontSize: 11.5, color: C.muted3 }}>as of {fmtIstHm(link.computedAt)} IST</span>}
        </span>
      </div>

      <div style={{ borderLeft: `3px solid ${tone}`, background: alpha(tone, 0.06), padding: "10px 12px", borderRadius: "0 10px 10px 0" }}>
        <div style={{ fontSize: 12, color: C.muted2, fontWeight: 600 }}>Does the news make a trade possible now?</div>
        <div style={{ fontSize: 15, color: C.textStrong, lineHeight: 1.5, marginTop: 4 }}>
          <b style={{ color: tone }}>{answer.word}.</b> {answer.text}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 14 }}>
        <Block label="Event pressure now (EVENT signal)">
          {vote.kind === "voting" ? (
            <>
              <span className="tnum" style={{ fontFamily: "var(--font-num)", fontWeight: 700, color: dirColor(vote.epi) }}>
                {vote.epi > 0 ? "▲" : "▼"} EPI {signed2(vote.epi)}
              </span>{" "}
              {link.pressure && link.pressure.side !== "none" ? `${link.pressure.side}, ${link.pressure.band}` : ""}
            </>
          ) : vote.kind === "abstain" ? (
            <>
              <b style={{ color: C.muted }}>Abstaining</b>: {vote.notes}
            </>
          ) : vote.kind === "disabled" ? (
            <span style={{ color: C.muted }}>Switched off{vote.notes ? `: ${vote.notes}` : ""}</span>
          ) : (
            <span style={{ color: C.muted }}>no data (this decision has no EVENT signal)</span>
          )}
        </Block>
        <Block label="Its share of the conviction">
          {vote.kind === "voting" ? (
            <span title="Weight × value over the sum for the signals that voted (VOL_REGIME and abstainers excluded)">
              <b className="tnum" style={{ fontFamily: "var(--font-num)", color: C.textStrong }}>
                {Math.round(vote.sharePct)}%
              </b>{" "}
              of the signal pull (weight {vote.weight.toFixed(2)}, adds {signed2(vote.pull)} to the weighted mean)
              {link.conviction != null && (
                <span style={{ display: "block", color: C.muted, fontSize: 12.5 }}>
                  Conviction {signed2(link.conviction)}
                  {link.entryThreshold != null ? `, needs ±${link.entryThreshold.toFixed(2)}` : ""}
                  {vote.sameSide === false ? "; news pulls the other way" : ""}
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: C.muted }}>0%: not voting{link.conviction != null ? ` (conviction ${signed2(link.conviction)} comes from other signals)` : ""}</span>
          )}
        </Block>
      </div>

      <Block label="Engine verdict">
        <VerdictLine v={link.verdict} />
        {link.eventFresh && (
          <span style={{ display: "block", fontSize: 12.5, color: link.eventFresh.passed ? C.muted : C.orange, marginTop: 4 }}>
            News freshness check: {link.eventFresh.passed ? "passed" : "failed"}
            {link.eventFresh.detail ? ` (${link.eventFresh.detail})` : ""}
          </span>
        )}
        {link.reco && (
          <span style={{ display: "block", fontSize: 12.5, color: C.muted, marginTop: 4 }}>
            ₹10k card: <b style={{ color: link.reco.status === "ENTER" ? C.green : C.textDim }}>{link.reco.status.replace("_", " ")}</b> · {link.reco.headline}{" "}
            <span style={{ color: C.muted3 }}>(setup + option flow, not news)</span>
          </span>
        )}
      </Block>

      <div style={{ minWidth: 0 }}>
        <div style={{ ...microLabel, marginBottom: 8 }}>Top stories driving it</div>
        {link.topStories.length === 0 ? (
          <div style={{ fontSize: 13, color: C.muted3 }}>No live story is adding event pressure for {link.index}.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {link.topStories.map((s) => (
              <div key={s.clusterId} style={{ borderLeft: `2px solid ${taxonomyColor(s.taxonomy)}`, paddingLeft: 10, minWidth: 0, opacity: s.pricedIn ? 0.6 : 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                  <span className="tnum" title="Signed share of this index's event pressure among the top 5 stories" style={{ fontSize: 12, fontFamily: "var(--font-num)", fontWeight: 700, color: dirColor(s.share), whiteSpace: "nowrap" }}>
                    {s.share > 0 ? "▲" : s.share < 0 ? "▼" : "▬"}
                    {Math.round(Math.abs(s.share) * 100)}%
                  </span>
                  <Link href={`/events/${encodeURIComponent(s.clusterId)}`} title={s.title} style={{ color: C.textStrong, fontSize: 13.5, textDecoration: "none", lineHeight: 1.4, minWidth: 0, overflowWrap: "anywhere" }}>
                    {s.title}
                  </Link>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                  <ImpactChip impact={s.impact} />
                  <span style={{ fontSize: 11.5, color: C.muted3 }}>
                    {s.impact.direction > 0 ? "bullish" : s.impact.direction < 0 ? "bearish" : "neutral"} · ≈{s.impact.magnitudePct}% move · {enumLabel(s.taxonomy)} · {fmtDuration(s.ageMin * 60_000)} ago
                    {s.place ? ` · ${s.place.place.name} (${placeReason(s.place)})` : " · no clear place"}
                  </span>
                  {s.pricedIn && <Pill color={C.muted}>priced in</Pill>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
