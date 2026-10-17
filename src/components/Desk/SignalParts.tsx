"use client";

import Link from "next/link";
import { useState } from "react";
import type { EventContribution, GateResult, IndicatorView, SignalComponentView, SignalSource, SignalView, Stance } from "@/engine/api-types";
import { SIGNAL_SOURCE_LABELS } from "@/engine/api-types";
import { alpha, C, dirColor, stanceColor, taxonomyColor } from "@/components/shared/colors";
import { enumLabel, fmtDuration, fmtInr, fmtSigned } from "@/components/shared/format";
import { microLabel, Pill } from "@/components/shared/ui";
import ImpactChip from "./ImpactChip";

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const pos = (v: number) => `${((clamp1(v) + 1) / 2) * 100}%`;

const linkButton = {
  background: "none",
  border: "none",
  padding: 0,
  color: C.gold,
  fontSize: 11,
  cursor: "pointer",
  fontWeight: 700,
  letterSpacing: "0.02em",
} as const;

export function ConvictionGauge({
  index,
  conviction,
  threshold,
  stance,
}: {
  index: string;
  conviction: number;
  threshold: number;
  stance: Stance;
}) {
  const color = conviction === 0 ? C.muted : dirColor(conviction);
  const passes = Math.abs(conviction) >= threshold;
  const t = Math.abs(threshold);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={microLabel}>Conviction</span>
        <span className="tnum" style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-num)", color: stanceColor(stance) === C.muted ? C.textDim : color }}>
          {fmtSigned(conviction)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${index} conviction`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={conviction}
        aria-valuetext={`${fmtSigned(conviction)}; entry threshold ±${t.toFixed(2)}; ${passes ? "clears" : "below"} threshold`}
        style={{ position: "relative", height: 24, marginTop: 4 }}
      >
        <div style={{ position: "absolute", left: 0, right: 0, top: 8, height: 8, background: C.track, borderRadius: 4 }} />
        <div
          title={`No-trade band ±${t.toFixed(2)}`}
          style={{
            position: "absolute",
            left: pos(-t),
            width: `${t * 100}%`,
            top: 8,
            height: 8,
            background: `repeating-linear-gradient(45deg, ${C.borderStrong} 0 3px, ${C.track} 3px 6px)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 8,
            height: 8,
            left: conviction >= 0 ? "50%" : pos(conviction),
            width: `${Math.abs(clamp1(conviction)) * 50}%`,
            background: color,
            opacity: passes ? 1 : 0.55,
          }}
        />
        <div style={{ position: "absolute", left: "50%", top: 3, width: 1, height: 18, background: C.muted3 }} />
        {[-t, t].map((v) => (
          <div key={v} style={{ position: "absolute", left: pos(v), top: 2, width: 2, height: 20, marginLeft: -1, background: C.muted }} />
        ))}
        <div
          style={{
            position: "absolute",
            left: pos(conviction),
            top: 1,
            width: 4,
            height: 22,
            marginLeft: -2,
            background: C.textStrong,
            borderRadius: 1,
            boxShadow: `0 0 0 2px ${C.panel}`,
          }}
        />
      </div>
      <div style={{ position: "relative", height: 13, fontSize: 9, color: C.muted3, fontFamily: "var(--font-num)" }}>
        <span style={{ position: "absolute", left: 0 }}>−1 ▼</span>
        <span style={{ position: "absolute", left: pos(-t), transform: "translateX(-50%)" }}>−{t.toFixed(2)}</span>
        <span style={{ position: "absolute", left: "50%", transform: "translateX(-50%)" }}>0</span>
        <span style={{ position: "absolute", left: pos(t), transform: "translateX(-50%)" }}>+{t.toFixed(2)}</span>
        <span style={{ position: "absolute", right: 0 }}>▲ +1</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: passes ? C.textSoft : C.muted }}>
        {passes ? (
          <>
            <span style={{ color: C.green }}>✓</span> clears the ±{t.toFixed(2)} entry threshold
          </>
        ) : (
          <>
            <span style={{ color: C.muted }}>–</span> inside the ±{t.toFixed(2)} no-trade band
          </>
        )}
      </div>
    </div>
  );
}

/**
 * `priceNote`: where the premium comes from, e.g. "model price" (Black-Scholes on India VIX, so a
 * broker's price will differ) or "Groww quote".
 */
export function ContractBlock({ signal, priceNote = "model price" }: { signal: SignalView; priceNote?: string }) {
  const c = signal.contract;
  const note = <span title={priceNote === "model price" ? "Black-Scholes on India VIX; a broker's price will differ" : undefined}>({priceNote})</span>;
  const box = { border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 13px", background: C.panelAlt } as const;
  if (!c) {
    return (
      <div style={{ ...box, display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ ...microLabel, color: C.muted, whiteSpace: "nowrap" }}>– No trade plan</span>
        <span style={{ fontSize: 12, color: C.muted }}>{signal.noPlanReason ?? "Nothing to do this tick."}</span>
      </div>
    );
  }
  if (signal.position && signal.position.contract.tradingSymbol === c.tradingSymbol) {
    return (
      <div className="tnum" style={{ ...box, padding: "7px 11px", fontSize: 10, color: C.muted, fontFamily: "var(--font-num)", display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
        <span style={{ ...microLabel, fontFamily: "inherit" }}>Plan</span>
        <span>
          entry {c.premium != null ? <>{fmtInr(c.premium, { decimals: 2 })} {note}</> : "—"} · at risk {c.premiumAtRisk != null ? fmtInr(c.premiumAtRisk) : "—"}
        </span>
        {signal.expectedMovePct != null && signal.impliedMovePct != null && (
          <span>
            EM {signal.expectedMovePct.toFixed(2)}% vs IM {signal.impliedMovePct.toFixed(2)}%
          </span>
        )}
        {signal.edgeRatio != null && (
          <span style={{ color: signal.edgeRatio >= signal.minEdgeRatio ? C.green : C.orange }}>
            edge {signal.edgeRatio.toFixed(2)} {signal.edgeRatio >= signal.minEdgeRatio ? "✓" : "✗"}
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <span style={microLabel}>Trade plan</span>
        {signal.edgeRatio != null && (
          <span
            title="Theta-gate edge ratio: (delta × expected move − theta − costs) / premium"
            style={{ fontSize: 9, fontFamily: "var(--font-num)", color: signal.edgeRatio >= signal.minEdgeRatio ? C.green : C.orange }}
          >
            EDGE {signal.edgeRatio.toFixed(2)} {signal.edgeRatio >= signal.minEdgeRatio ? "✓" : "✗"}
          </span>
        )}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.textStrong, fontFamily: "var(--font-num)", letterSpacing: "0.01em" }}>{c.label}</div>
      <div className="tnum" style={{ fontSize: 11, color: C.muted, fontFamily: "var(--font-num)", marginTop: 3 }}>
        lot {c.lotSize} × {c.lots} · premium {c.premium != null ? <>{fmtInr(c.premium, { decimals: 2 })} {note}</> : "—"} · at risk{" "}
        {c.premiumAtRisk != null ? fmtInr(c.premiumAtRisk) : "—"}
      </div>
      {signal.expectedMovePct != null && signal.impliedMovePct != null && (
        <div style={{ fontSize: 11, color: C.muted2, marginTop: 4 }}>
          expected move {signal.expectedMovePct.toFixed(2)}% vs implied {signal.impliedMovePct.toFixed(2)}% · {c.tradingSymbol}
        </div>
      )}
      {signal.noPlanReason && <div style={{ fontSize: 12, color: C.orange, marginTop: 6 }}>– {signal.noPlanReason}</div>}
    </div>
  );
}

const gateGlyph = (g: GateResult) => (g.passed === true ? "✓" : g.passed === false ? "✗" : "–");
const gateColor = (g: GateResult) => (g.passed === true ? C.green : g.passed === false ? C.red : C.muted3);

/** One line for the card: whether every check passes, and the first one that blocks a trade. */
export function ChecksSummary({ gates, allPassed }: { gates: GateResult[]; allPassed: boolean }) {
  const applicable = gates.filter((g) => g.passed !== null);
  const passed = applicable.filter((g) => g.passed === true).length;
  const failed = gates.find((g) => g.passed === false);
  return (
    <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 8px", fontSize: 13, color: C.textSoft, lineHeight: 1.5 }}>
      {allPassed ? <Pill color={C.green}>✓ all clear</Pill> : <Pill color={C.red}>✗ blocked</Pill>}
      <span className="tnum" style={{ color: C.muted2 }}>
        {passed}/{applicable.length} checks pass
      </span>
      {failed && (
        <span style={{ minWidth: 0 }}>
          · {failed.label}: <span style={{ color: C.muted }}>{failed.detail || "failed"}</span>
        </span>
      )}
    </div>
  );
}

export function GateList({ gates, allPassed, expanded = false }: { gates: GateResult[]; allPassed: boolean; expanded?: boolean }) {
  const [openState, setOpen] = useState(false);
  const open = expanded || openState;
  const failed = gates.filter((g) => g.passed === false);
  const applicable = gates.filter((g) => g.passed !== null);
  const passed = applicable.filter((g) => g.passed === true).length;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={microLabel}>Checks before a trade</span>
        <span className="tnum" style={{ fontSize: 11, fontFamily: "var(--font-num)", color: C.muted }}>
          {passed}/{applicable.length} passed
        </span>
        {allPassed ? <Pill color={C.green}>✓ all clear</Pill> : <Pill color={C.red}>✗ blocked</Pill>}
        {!expanded && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ ...linkButton, marginLeft: "auto" }}>
            {open ? "▾ hide details" : "▸ details"}
          </button>
        )}
      </div>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {gates.map((g) => (
            <div key={g.gate} style={{ display: "grid", gridTemplateColumns: "14px minmax(110px, 0.9fr) minmax(0, 1.1fr)", gap: 8, fontSize: 12, alignItems: "baseline" }}>
              <span style={{ color: gateColor(g), fontWeight: 800 }}>{gateGlyph(g)}</span>
              <span style={{ color: C.textSoft }}>{g.label}</span>
              <span style={{ color: C.muted, fontFamily: "var(--font-num)", fontSize: 11, overflowWrap: "anywhere" }}>{g.detail || "—"}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {gates.map((g) => (
              <span
                key={g.gate}
                title={`${g.label}: ${g.passed === null ? "not applicable" : g.passed ? "passed" : "failed"}${g.detail ? ` · ${g.detail}` : ""}`}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 12,
                  border: `1px solid ${g.passed === false ? alpha(C.red, 0.5) : C.border}`,
                  background: g.passed === false ? alpha(C.red, 0.06) : C.panel,
                  color: g.passed === null ? C.muted3 : C.textDim,
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ color: gateColor(g), fontWeight: 800 }}>{gateGlyph(g)}</span> {g.label}
              </span>
            ))}
          </div>
          {failed.map((g) => (
            <div key={g.gate} style={{ marginTop: 6, fontSize: 12, color: C.textSoft, lineHeight: 1.45 }}>
              <span style={{ color: C.red, fontWeight: 800 }}>✗</span> {g.label}: <span style={{ color: C.muted, fontFamily: "var(--font-num)" }}>{g.detail}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const SOURCE_SHORT: Record<SignalSource, string> = {
  EVENT: "EVENT",
  TREND: "TREND",
  ORB: "ORB",
  MEAN_REVERSION: "MEAN REV",
  MOMENTUM: "MOMENTUM",
  GAP: "GAP",
  RELATIVE_VALUE: "REL VALUE",
  GLOBAL_BETA: "GLOBAL β",
  VOL_REGIME: "VOL REGIME",
};

export function ComponentBars({ components }: { components: SignalComponentView[] }) {
  return (
    <div>
      <div style={{ ...microLabel, marginBottom: 8 }}>What each signal says</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {components.map((c) => {
          const modifier = c.source === "VOL_REGIME";
          const silent = !modifier && c.abstain === true;
          const color = c.enabled && !silent ? dirColor(c.value) : C.muted3;
          return (
            <div
              key={c.source}
              title={`${SIGNAL_SOURCE_LABELS[c.source]}: ${silent ? "no view (left out of the conviction)" : `${fmtSigned(c.value)} × weight ${c.weight.toFixed(2)}`}${c.enabled ? "" : " (disabled)"}${c.notes ? ` · ${c.notes}` : ""}`}
              style={{
                display: "grid",
                gridTemplateColumns: "84px minmax(0, 1fr) 44px 48px",
                gap: 8,
                alignItems: "center",
                fontSize: 11,
                opacity: c.enabled && !silent ? 1 : 0.5,
              }}
            >
              <span style={{ color: C.textDim, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{SOURCE_SHORT[c.source]}</span>
              {modifier || silent ? (
                <span style={{ color: C.muted3, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {modifier ? `modifier · ${c.notes ?? "threshold/size only"}` : `no view · ${c.notes ?? "abstains"}`}
                </span>
              ) : (
                <div style={{ position: "relative", height: 6, background: C.track, borderRadius: 3 }}>
                  <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 10, background: C.muted3 }} />
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      height: 6,
                      left: c.value >= 0 ? "50%" : pos(c.value),
                      width: `${Math.abs(clamp1(c.value)) * 50}%`,
                      background: color,
                      borderRadius: 2,
                    }}
                  />
                </div>
              )}
              <span className="tnum" style={{ fontFamily: "var(--font-num)", textAlign: "right", color: modifier ? C.muted3 : color === C.muted3 ? C.muted : color }}>
                {modifier || silent ? "—" : fmtSigned(c.value)}
              </span>
              <span className="tnum" style={{ fontFamily: "var(--font-num)", textAlign: "right", color: C.muted3 }}>
                {c.enabled ? `w ${c.weight.toFixed(2)}` : "OFF"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const arrow = (d: number) => (d > 0 ? "▲" : d < 0 ? "▼" : "•");

function Reading({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div title={title} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, minWidth: 0, padding: "4px 0", borderBottom: `1px dashed ${C.borderSoft}` }}>
      <span style={{ color: C.muted3, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{label}</span>
      <span className="tnum" style={{ fontFamily: "var(--font-num)", color: color ?? C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </span>
    </div>
  );
}

/** The indicator readings behind the current decision (5-minute bars). */
export function IndicatorBlock({ ind }: { ind: IndicatorView | null }) {
  if (!ind) return null;
  const or = ind.openingRange;
  const orText =
    or.state === "FORMING"
      ? "forming"
      : `${or.low.toFixed(0)}–${or.high.toFixed(0)} ${or.state === "BROKE_UP" ? `▲ ${or.strengthAtr.toFixed(2)} ATR` : or.state === "BROKE_DOWN" ? `▼ ${or.strengthAtr.toFixed(2)} ATR` : or.lastBreak ? `inside (failed ${or.lastBreak.toLowerCase()})` : "inside"}`;
  const orColor = or.state === "BROKE_UP" ? C.green : or.state === "BROKE_DOWN" ? C.red : C.textDim;
  const rsiColor = ind.rsi14 >= 70 ? C.orange : ind.rsi14 <= 30 ? C.orange : C.textDim;
  const trendDir = Math.sign(ind.ema9 - ind.ema21);
  return (
    <div>
      <div style={{ ...microLabel, marginBottom: 6 }}>Indicators (5-minute bars)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", columnGap: 18, rowGap: 0 }}>
        <Reading label="VWAP" value={`${ind.vwapZ >= 0 ? "+" : ""}${ind.vwapZ.toFixed(2)}σ`} color={dirColor(ind.vwapZ)} title={`VWAP ${ind.vwap.toFixed(1)}; spot ${ind.vwapDistPct.toFixed(2)}% away`} />
        <Reading label="RSI 14" value={ind.rsi14.toFixed(0)} color={rsiColor} />
        <Reading label="ADX 14" value={`${ind.adx14.toFixed(0)} · +${ind.plusDi14.toFixed(0)}/−${ind.minusDi14.toFixed(0)}`} color={ind.adx14 >= 25 ? C.gold : C.textDim} title="ADX with +DI / −DI" />
        <Reading label="EMA 9/21" value={`${arrow(trendDir)} ${ind.ema9SlopePct >= 0 ? "+" : ""}${ind.ema9SlopePct.toFixed(2)}%`} color={dirColor(trendDir)} title={`EMA9 ${ind.ema9.toFixed(1)} vs EMA21 ${ind.ema21.toFixed(1)}; EMA9 slope over 15 min`} />
        <Reading label="SUPERTREND" value={`${arrow(ind.supertrendDir)} ${ind.supertrendLine > 0 ? ind.supertrendLine.toFixed(0) : "—"}`} color={dirColor(ind.supertrendDir)} />
        <Reading label="BOLL %B" value={ind.bbPctB.toFixed(2)} color={ind.bbPctB >= 1 || ind.bbPctB <= 0 ? C.orange : C.textDim} title={`Band width ${ind.bbWidthPct.toFixed(2)}%`} />
        <Reading label="OPEN RANGE" value={orText} color={orColor} />
        <Reading label="DAILY" value={`${arrow(ind.dailyBias)} ${ind.dailyEmaGapPct >= 0 ? "+" : ""}${ind.dailyEmaGapPct.toFixed(2)}%`} color={dirColor(ind.dailyBias)} title="Daily EMA20 vs EMA50" />
        <Reading label="PREV DAY" value={ind.prevDayClose > 0 ? `${ind.prevDayLow.toFixed(0)}–${ind.prevDayHigh.toFixed(0)} · ${ind.prevDayClose.toFixed(0)}` : "—"} title="Previous session low–high · close" />
        <Reading label="ATR 5m" value={`${ind.atrPct5m.toFixed(2)}%`} />
      </div>
    </div>
  );
}

export function ContributorList({ contributors }: { contributors: EventContribution[] }) {
  const top = [...contributors].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3);
  return (
    <div>
      <div style={{ ...microLabel, marginBottom: 8 }}>News driving it</div>
      {top.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted3 }}>No active event pressure.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {top.map((c) => (
            <div key={c.clusterId} style={{ borderLeft: `2px solid ${taxonomyColor(c.taxonomy)}`, paddingLeft: 8, opacity: c.pricedIn ? 0.55 : 1 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                <span
                  className="tnum"
                  title="Share of this index's event pressure"
                  style={{ fontSize: 11, fontFamily: "var(--font-num)", color: dirColor(c.weight), fontWeight: 700, whiteSpace: "nowrap" }}
                >
                  {c.weight > 0 ? "▲" : c.weight < 0 ? "▼" : "▬"}
                  {Math.round(Math.abs(c.weight) * 100)}%
                </span>
                <Link
                  href={`/events/${encodeURIComponent(c.clusterId)}`}
                  style={{ color: C.textSoft, fontSize: 12, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                  title={c.title}
                >
                  {c.title}
                </Link>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
                <ImpactChip impact={c} />
                <span style={{ fontSize: 11, color: C.muted3 }}>
                  {enumLabel(c.taxonomy)} · {fmtDuration(c.ageMin * 60_000)} ago
                </span>
                {c.pricedIn && <Pill color={C.muted}>priced in</Pill>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Rationale({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 170;
  return (
    <div>
      <div style={{ ...microLabel, marginBottom: 6 }}>In plain words</div>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.6,
          color: C.textSoft,
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: open || !long ? "unset" : 3,
          overflow: "hidden",
        }}
      >
        {text || "No rationale yet."}
      </p>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ ...linkButton, marginTop: 4 }}>
          {open ? "▾ less" : "▸ more"}
        </button>
      )}
    </div>
  );
}
