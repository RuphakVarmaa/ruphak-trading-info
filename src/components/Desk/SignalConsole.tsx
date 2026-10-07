"use client";

import type { IndexId, SignalView } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, regimeColor, regimeGlyph, stanceColor, stanceGlyph, dirColor, dirGlyph } from "@/components/shared/colors";
import { enumLabel, fmtAge, fmtNum, fmtPct } from "@/components/shared/format";
import { PanelHeader, Pill, Skeleton } from "@/components/shared/ui";
import PositionLive from "./PositionLive";
import { ComponentBars, ContractBlock, ContributorList, ConvictionGauge, GateList, Rationale } from "./SignalParts";

const INDEX_LABEL: Record<IndexId, string> = { NIFTY: "NIFTY 50", SENSEX: "SENSEX" };

function Updated({ at }: { at: string }) {
  const now = useNow();
  return <span className="tnum">{now == null ? "—" : `${fmtAge(Math.max(0, now - Date.parse(at)))} ago`}</span>;
}

function CardSkeleton({ index }: { index: IndexId }) {
  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.textSoft }}>{INDEX_LABEL[index]}</div>
      <Skeleton height={22} width="60%" />
      <Skeleton height={36} />
      <Skeleton height={64} />
      <Skeleton height={48} />
      <Skeleton height={90} />
    </div>
  );
}

/** Signals loaded, but the engine has not evaluated this index yet (e.g. before the first tick of the day). */
function NoSignal({ index }: { index: IndexId }) {
  const { state } = useEngineState();
  const phase = state?.market.phase;
  const nextOpen = state?.market.nextOpenAt;
  const when =
    phase === "OPEN" || phase === "PRE_OPEN"
      ? "The engine evaluates every 30 seconds; the first decision appears after its next tick."
      : `Market ${phase === "HOLIDAY" ? "holiday" : "closed"}. The engine evaluates every 30 seconds from ${nextOpen ? new Date(nextOpen).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "the next open"} IST.`;
  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.textSoft }}>{INDEX_LABEL[index]}</div>
      <div style={{ fontSize: 11, color: C.muted3, lineHeight: 1.6 }}>
        – No signal yet. {when}
      </div>
    </div>
  );
}

function SignalCard({ index, signal, loaded }: { index: IndexId; signal: SignalView | null; loaded: boolean }) {
  const { state } = useEngineState();
  if (!signal) return loaded ? <NoSignal index={index} /> : <CardSkeleton index={index} />;
  const quote = state?.quotes.find((q) => q.key === index);
  const sColor = stanceColor(signal.stance);
  return (
    <section
      aria-label={`${INDEX_LABEL[index]} signal`}
      style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", minHeight: 0 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: C.textStrong, letterSpacing: "0.04em" }}>{INDEX_LABEL[index]}</span>
            {signal.spot != null && (
              <span className="tnum" style={{ fontSize: 13, fontFamily: "monospace", color: C.textSoft }}>
                {fmtNum(signal.spot)}
              </span>
            )}
            {quote && (
              <span className="tnum" style={{ fontSize: 10, fontFamily: "monospace", color: dirColor(quote.change) }}>
                {dirGlyph(quote.change)}
                {fmtPct(Math.abs(quote.changePct), 2, false)}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
            <Pill color={regimeColor(signal.regime)} title="Rule-based market regime">
              {regimeGlyph(signal.regime)} {enumLabel(signal.regime)}
            </Pill>
            <span style={{ fontSize: 9, color: C.muted3 }}>
              threshold ±{signal.entryThreshold.toFixed(2)} · updated <Updated at={signal.computedAt} />
            </span>
          </div>
        </div>
        <Pill color={sColor} solid={signal.stance !== "NEUTRAL"} style={{ fontSize: 11, padding: "4px 10px" }}>
          {stanceGlyph(signal.stance)} {signal.stance}
        </Pill>
      </div>

      <ConvictionGauge index={index} conviction={signal.conviction} threshold={signal.entryThreshold} stance={signal.stance} />
      {signal.position && <PositionLive p={signal.position} />}
      <ContractBlock signal={signal} />
      <GateList gates={signal.gates} allPassed={signal.allGatesPassed} />
      <ContributorList contributors={signal.contributors} />
      <ComponentBars components={signal.components} />
      <Rationale text={signal.rationale} />
    </section>
  );
}

export default function SignalConsole() {
  const { signals } = useEngineState();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.panel, minHeight: 0 }}>
      <PanelHeader icon="◎" title="Signal console" right={<span style={{ fontSize: 9, color: C.muted3, letterSpacing: "0.04em" }}>ATM weekly options · long only</span>} />
      <div
        className="signal-grid"
        style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)" }}
      >
        {(["NIFTY", "SENSEX"] as IndexId[]).map((index, i) => (
          <div key={index} style={{ minHeight: 0, display: "flex", flexDirection: "column", borderLeft: i > 0 ? `1px solid ${C.border}` : undefined }}>
            <SignalCard index={index} signal={signals?.find((s) => s.index === index) ?? null} loaded={Array.isArray(signals)} />
          </div>
        ))}
      </div>
    </div>
  );
}
