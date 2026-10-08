"use client";

import { useState, type ReactNode } from "react";
import type { PositionView } from "@/engine/api-types";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtInr, fmtPct } from "@/components/shared/format";
import { Panel, PanelHeader } from "@/components/shared/ui";
import { capitalSlices, pnlSlices, type PieSlice } from "./pieData";

const SIZE = 168;
const THICK = 26;
const R = (SIZE - THICK) / 2;
const CIRC = 2 * Math.PI * R;
/** The 2px of surface between slices. */
const GAP = 2;

/** A donut with a centre readout that follows the hovered or focused slice. */
function Donut({
  slices,
  label,
  centre,
  empty,
}: {
  slices: PieSlice[];
  label: string;
  centre: (hovered: PieSlice | null, total: number) => ReactNode;
  empty: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const hovered = slices.find((s) => s.key === hover) ?? null;
  const arcs = slices.map((s, i) => {
    const before = slices.slice(0, i).reduce((sum, x) => sum + x.value, 0);
    return { s, len: total > 0 ? (s.value / total) * CIRC : 0, start: total > 0 ? (before / total) * CIRC : 0 };
  });
  const only = slices.length === 1;

  return (
    <div style={{ position: "relative", width: SIZE, height: SIZE, flexShrink: 0 }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label} style={{ display: "block", transform: "rotate(-90deg)" }}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={C.borderSoft} strokeWidth={THICK} />
        {arcs.map(({ s, len, start: at }) => (
          <circle
            key={s.key}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth={hover === s.key ? THICK + 4 : THICK}
            strokeDasharray={only ? undefined : `${Math.max(1, len - GAP)} ${CIRC - Math.max(1, len - GAP)}`}
            strokeDashoffset={only ? undefined : -at}
            opacity={hover && hover !== s.key ? 0.45 : 1}
            tabIndex={0}
            aria-label={`${s.label}: ${fmtInr(s.value, { decimals: 0 })}, ${fmtPct(total > 0 ? (s.value / total) * 100 : 0, 1, false)}`}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(s.key)}
            onBlur={() => setHover(null)}
            style={{ cursor: "default", outline: "none", transition: "stroke-width 120ms, opacity 120ms" }}
          />
        ))}
      </svg>
      <div
        className="tnum"
        style={{ position: "absolute", inset: THICK + 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", pointerEvents: "none" }}
      >
        {slices.length === 0 ? <span style={{ fontSize: 11, color: C.muted2 }}>{empty}</span> : centre(hovered, total)}
      </div>
    </div>
  );
}

function Legend({ slices, total }: { slices: PieSlice[]; total: number }) {
  return (
    <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: 0, flex: "1 1 190px" }}>
      <tbody>
        {slices.map((s) => (
          <tr key={s.key}>
            <td style={{ padding: "5px 8px 5px 0", whiteSpace: "nowrap", color: C.textSoft }}>
              <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: s.color, marginRight: 8, verticalAlign: "-1px" }} />
              {s.label}
            </td>
            <td className="tnum" style={{ padding: "5px 8px", textAlign: "right", fontFamily: "monospace", color: C.textStrong }}>
              {fmtInr(s.value, { decimals: 0 })}
            </td>
            <td className="tnum" style={{ padding: "5px 0 5px 4px", textAlign: "right", fontFamily: "monospace", color: C.muted }}>
              {fmtPct(total > 0 ? (s.value / total) * 100 : 0, 1, false)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const bigNumber = { fontSize: 20, fontWeight: 800, fontFamily: "monospace", color: C.textStrong, lineHeight: 1.1 } as const;
const subLabel = { fontSize: 9, color: C.muted, marginTop: 3, lineHeight: 1.3 } as const;

/** Two donuts for the Live P&L page: capital in use, and where today's P&L comes from. */
export default function CapitalPnlPies({
  capital,
  positions,
  realized,
  charges,
}: {
  capital: number;
  positions: PositionView[];
  realized: number;
  charges: number;
}) {
  const cap = capitalSlices(capital, positions);
  const pnl = pnlSlices({ realized, positions, charges });
  const pnlTotal = pnl.slices.reduce((s, x) => s + x.value, 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))", gap: 12 }}>
      <Panel>
        <PanelHeader title="Capital in use" right={<span style={{ fontSize: 10, color: C.muted2, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>premium paid, of {fmtInr(capital, { decimals: 0 })}</span>} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 20px", padding: 16 }}>
          <Donut
            slices={cap.slices}
            label={`Capital in use: ${fmtPct(cap.usedPct, 1, false)} of ${fmtInr(capital, { decimals: 0 })}`}
            empty="No capital"
            centre={(h, total) =>
              h ? (
                <>
                  <span style={bigNumber}>{fmtPct(total > 0 ? (h.value / total) * 100 : 0, 1, false)}</span>
                  <span style={subLabel}>{h.label}<br />{fmtInr(h.value, { decimals: 0 })}</span>
                </>
              ) : (
                <>
                  <span style={bigNumber}>{fmtPct(cap.usedPct, 1, false)}</span>
                  <span style={subLabel}>in use<br />{fmtInr(cap.used, { decimals: 0 })}</span>
                </>
              )
            }
          />
          <Legend slices={cap.slices} total={capital} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="P&L split" right={<span style={{ fontSize: 10, color: C.muted2, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>today, open and closed</span>} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 20px", padding: 16 }}>
          <Donut
            slices={pnl.slices}
            label={`P&L split today: net ${fmtInr(pnl.net, { decimals: 0, sign: true })} after charges`}
            empty="No P&L yet"
            centre={(h, total) =>
              h ? (
                <>
                  <span style={bigNumber}>{fmtPct(total > 0 ? (h.value / total) * 100 : 0, 1, false)}</span>
                  <span style={subLabel}>{h.label}<br />{fmtInr(h.value, { decimals: 0 })}</span>
                </>
              ) : (
                <>
                  <span style={{ ...bigNumber, color: pnlColor(pnl.net) }}>{fmtInr(pnl.net, { decimals: 0, sign: true })}</span>
                  <span style={subLabel}>net after charges</span>
                </>
              )
            }
          />
          {pnl.slices.length > 0 ? (
            <Legend slices={pnl.slices} total={pnlTotal} />
          ) : (
            <div style={{ fontSize: 11, color: C.muted2, flex: "1 1 190px" }}>Fills in once a position has a profit or loss.</div>
          )}
        </div>
      </Panel>
    </div>
  );
}
