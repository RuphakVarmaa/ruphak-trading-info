"use client";

import { useEffect, useId, useRef, useState } from "react";
import { C } from "@/components/shared/colors";
import { fmtInr, fmtIstDate } from "@/components/shared/format";
import { Btn, EmptyState, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from "@/components/shared/ui";

export interface CurvePoint {
  t: string;
  equity: number;
}

/** Round-number gridlines: the smallest 1/2/2.5/5 x 10^n step that yields at most `max` ticks in [lo, hi]. */
function niceTicks(lo: number, hi: number, max = 5): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const mag = 10 ** Math.floor(Math.log10(span / max));
  const count = (step: number) => Math.floor(hi / step) - Math.ceil(lo / step) + 1;
  const step = [1, 2, 2.5, 5, 10, 20].map((m) => m * mag).find((st) => count(st) <= max) ?? span;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/**
 * Dependency-free equity line: gold 2px line, baseline at the starting equity, hover
 * crosshair + tooltip, ←/→/Home/End keyboard stepping, and a table view of every point.
 */
export default function EquityCurve({
  points,
  baseline,
  height = 220,
  label = "Equity curve",
}: {
  points: CurvePoint[];
  baseline: number;
  height?: number;
  label?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const gradId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) return <EmptyState>No equity history yet.</EmptyState>;

  const n = points.length;
  const pad = { l: 70, r: 14, t: 12, b: 24 };
  const plotW = Math.max(10, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const values = points.map((p) => p.equity).concat(baseline);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const margin = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.08;
  lo -= margin;
  hi += margin;
  const x = (i: number) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * plotH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const area = `${line}L${x(n - 1).toFixed(1)},${(pad.t + plotH).toFixed(1)}L${x(0).toFixed(1)},${(pad.t + plotH).toFixed(1)}Z`;
  const ticks = niceTicks(lo, hi, 5);
  const xLabels = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
  const last = points[n - 1];
  const change = last.equity - baseline;

  const nearest = (clientX: number, rect: DOMRect) => {
    const rel = clientX - rect.left - pad.l;
    return Math.max(0, Math.min(n - 1, Math.round((rel / plotW) * (n - 1))));
  };

  const a = active != null ? points[active] : null;
  const prev = active != null && active > 0 ? points[active - 1] : null;
  const tooltipLeft = active != null ? Math.min(Math.max(x(active) + 10, pad.l), Math.max(pad.l, width - 170)) : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
        <span className="tnum" style={{ fontSize: 10, fontFamily: "monospace", color: change >= 0 ? C.green : C.red }}>
          {change >= 0 ? "▲" : "▼"} {fmtInr(change, { sign: true })} vs start
        </span>
        <Btn variant="ghost" style={{ marginLeft: "auto" }} aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
          {showTable ? "▦ show chart" : "▤ show table"}
        </Btn>
      </div>
      {showTable && (
        <div style={{ ...tableWrap, maxHeight: height, overflowY: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={th}>Date</th>
                <th style={thNum}>Equity</th>
                <th style={thNum}>Change</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const d = i > 0 ? p.equity - points[i - 1].equity : p.equity - baseline;
                return (
                  <tr key={`${p.t}-${i}`}>
                    <td style={td}>{fmtIstDate(p.t)}</td>
                    <td style={tdNum}>{fmtInr(p.equity)}</td>
                    <td style={{ ...tdNum, color: d > 0 ? C.green : d < 0 ? C.red : C.textDim }}>
                      {d > 0 ? "▲ " : d < 0 ? "▼ " : ""}
                      {fmtInr(d, { sign: true })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${label}: ${n} points from ${fmtInr(points[0].equity)} to ${fmtInr(last.equity)}; starting equity ${fmtInr(baseline)}. Use left and right arrow keys to read values.`}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
            e.preventDefault();
            setActive((cur) => {
              const c = cur ?? n - 1;
              if (e.key === "Home") return 0;
              if (e.key === "End") return n - 1;
              return Math.max(0, Math.min(n - 1, c + (e.key === "ArrowLeft" ? -1 : 1)));
            });
          } else if (e.key === "Escape") setActive(null);
        }}
        onFocus={() => setActive((cur) => cur ?? n - 1)}
        onBlur={() => setActive(null)}
        style={{ position: "relative", height, display: showTable ? "none" : "block", borderRadius: 4 }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={height}
            style={{ display: "block", touchAction: "pan-y" }}
            onPointerMove={(e) => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onPointerLeave={() => setActive(null)}
          >
            <defs>
              <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={C.gold} stopOpacity={0.18} />
                <stop offset="100%" stopColor={C.gold} stopOpacity={0} />
              </linearGradient>
            </defs>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + plotW} y1={y(v)} y2={y(v)} stroke="#1c1c1c" strokeWidth={1} />
                <text x={pad.l - 8} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#777" fontFamily="monospace">
                  {fmtInr(v, { compact: true })}
                </text>
              </g>
            ))}
            <line x1={pad.l} x2={pad.l + plotW} y1={y(baseline)} y2={y(baseline)} stroke="#4a4a4a" strokeWidth={1} />
            <text
              x={pad.l + plotW - 4}
              y={last.equity >= baseline ? y(baseline) + 12 : y(baseline) - 5}
              textAnchor="end"
              fontSize={8}
              fill={C.muted}
              fontFamily="monospace"
            >
              start {fmtInr(baseline)}
            </text>
            <path d={area} fill={`url(#${gradId})`} />
            <path d={line} fill="none" stroke={C.gold} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {xLabels.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={9}
                fill={C.muted3}
                fontFamily="monospace"
              >
                {fmtIstDate(points[i].t)}
              </text>
            ))}
            {active != null && a && (
              <g>
                <line x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + plotH} stroke="#666" strokeWidth={1} />
                <circle cx={x(active)} cy={y(a.equity)} r={4.5} fill={C.gold} stroke={C.panel} strokeWidth={2} />
              </g>
            )}
          </svg>
        )}
        {a && (
          <div
            role="status"
            style={{
              position: "absolute",
              top: 6,
              left: tooltipLeft,
              pointerEvents: "none",
              background: "rgba(17,17,17,0.95)",
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 6,
              padding: "6px 9px",
              minWidth: 140,
            }}
          >
            <div className="tnum" style={{ fontSize: 13, fontWeight: 700, color: C.textStrong, fontFamily: "monospace" }}>
              {fmtInr(a.equity)}
            </div>
            <div style={{ fontSize: 9, color: C.muted }}>{fmtIstDate(a.t)}</div>
            {prev && (
              <div className="tnum" style={{ fontSize: 9, fontFamily: "monospace", color: a.equity >= prev.equity ? C.green : C.red }}>
                {a.equity >= prev.equity ? "▲" : "▼"} {fmtInr(a.equity - prev.equity, { sign: true })} day
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
