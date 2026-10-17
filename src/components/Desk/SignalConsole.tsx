"use client";

import type { IndexId, SignalView } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, regimeColor, regimeGlyph, stanceColor, stanceGlyph, dirColor, dirGlyph } from "@/components/shared/colors";
import { enumLabel, fmtAge, fmtIstDay, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { Panel, Pill, Skeleton } from "@/components/shared/ui";
import PositionLive from "./PositionLive";
import { ChecksSummary, ComponentBars, ContractBlock, ContributorList, ConvictionGauge, GateList, IndicatorBlock, Rationale } from "./SignalParts";

const INDEX_LABEL: Record<IndexId, string> = { NIFTY: "NIFTY 50", SENSEX: "SENSEX" };

function Updated({ at }: { at: string }) {
  const now = useNow();
  return <span className="tnum">{now == null ? "—" : `${fmtAge(Math.max(0, now - Date.parse(at)))} ago`}</span>;
}

function CardShell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <Panel style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <section aria-label={label} style={{ display: "contents" }}>
        {children}
      </section>
    </Panel>
  );
}

const indexTitle = { fontSize: 18, fontWeight: 600, color: C.textStrong } as const;

function CardSkeleton({ index }: { index: IndexId }) {
  return (
    <CardShell label={`${INDEX_LABEL[index]} signal`}>
      <div style={indexTitle}>{INDEX_LABEL[index]}</div>
      <Skeleton height={22} width="60%" />
      <Skeleton height={40} />
      <Skeleton height={64} />
    </CardShell>
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
      : `Market ${phase === "HOLIDAY" ? "holiday" : "closed"}. The engine evaluates every 30 seconds from ${nextOpen ? `${fmtIstDay(nextOpen)} ${fmtIstHm(nextOpen)} IST` : "the next open"}.`;
  return (
    <CardShell label={`${INDEX_LABEL[index]} signal`}>
      <div style={indexTitle}>{INDEX_LABEL[index]}</div>
      <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>No signal yet. {when}</div>
    </CardShell>
  );
}

function SignalCard({ index, signal, loaded }: { index: IndexId; signal: SignalView | null; loaded: boolean }) {
  const { state } = useEngineState();
  if (!signal) return loaded ? <NoSignal index={index} /> : <CardSkeleton index={index} />;
  const quote = state?.quotes.find((q) => q.key === index);
  // The engine may send no change when it has no previous close: show nothing rather than zero.
  const pct = quote && quote.change != null && quote.changePct != null ? { change: quote.change, changePct: quote.changePct } : null;
  // The engine's "quote" check names the premium's source; anything but a Groww quote is the Black-Scholes model.
  const priceNote = /^groww/i.test(signal.gates.find((g) => g.gate === "quote")?.detail ?? "") ? "Groww quote" : "model price";
  const sColor = stanceColor(signal.stance);
  return (
    <CardShell label={`${INDEX_LABEL[index]} signal`}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={indexTitle}>{INDEX_LABEL[index]}</span>
            {signal.spot != null && (
              <span className="tnum" style={{ fontSize: 17, color: C.textStrong }}>
                {fmtNum(signal.spot)}
              </span>
            )}
            {pct ? (
              <span className="tnum" style={{ fontSize: 13, color: dirColor(pct.change) }} title="Change versus the previous close">
                {dirGlyph(pct.change)} {fmtPct(Math.abs(pct.changePct), 2, false)}
              </span>
            ) : quote ? (
              <span className="tnum" style={{ fontSize: 13, color: C.muted2 }} title="No previous close, so no change">
                —
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            <Pill color={regimeColor(signal.regime)} title="Rule-based market regime">
              {regimeGlyph(signal.regime)} {enumLabel(signal.regime)}
            </Pill>
            <span style={{ fontSize: 12.5, color: C.muted2 }}>
              updated <Updated at={signal.computedAt} />
            </span>
          </div>
        </div>
        <Pill color={sColor} solid={signal.stance !== "NEUTRAL"} style={{ fontSize: 11, padding: "5px 11px" }}>
          {stanceGlyph(signal.stance)} {signal.stance}
        </Pill>
      </div>

      <ConvictionGauge index={index} conviction={signal.conviction} threshold={signal.entryThreshold} stance={signal.stance} />
      {signal.position && <PositionLive p={signal.position} />}
      <ContractBlock signal={signal} priceNote={priceNote} />
      <ChecksSummary gates={signal.gates} allPassed={signal.allGatesPassed} />
      <Rationale text={signal.rationale} />

      <details className="inline-disclosure">
        <summary>Details: every check, the signals, the news and the indicators</summary>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 18, marginTop: 12 }}>
          <GateList gates={signal.gates} allPassed={signal.allGatesPassed} expanded />
          <ComponentBars components={signal.components} />
          <ContributorList contributors={signal.contributors} />
          <IndicatorBlock ind={signal.indicators} />
        </div>
      </details>
    </CardShell>
  );
}

/** One card per traded index: conviction, the trade plan and whether it may trade; the evidence is under Details. */
export default function SignalConsole() {
  const { signals } = useEngineState();
  const indices: IndexId[] = ["NIFTY", "SENSEX"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 16, alignItems: "start" }}>
      {indices.map((index) => (
        <SignalCard key={index} index={index} signal={signals?.find((s) => s.index === index) ?? null} loaded={Array.isArray(signals)} />
      ))}
    </div>
  );
}
