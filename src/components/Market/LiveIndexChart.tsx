"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { alpha, C } from "@/components/shared/colors";
import { fmtIstDay, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import type { LiveIndex } from "@/lib/market/liveIndices";
import {
  gutterWidth,
  linePath,
  marksOnSession,
  nearestPoint,
  niceTicks,
  pricePoints,
  SESSION_MINUTES,
  sessionMinute,
  spreadLabels,
  timeTicks,
  yDomain,
  type ChartMarks,
} from "./chartGeometry";

export type { ChartMarks } from "./chartGeometry";

/** Left inset, top inset and the time-axis band; the right gutter is sized to its price tags. */
const PAD = { l: 6, t: 14, b: 24 };
const NUM = { fontFamily: "var(--font-num)" } as const;
const EMPTY_TEXT = "No 1-minute bars yet: the session opens at 09:15 IST";
const TOOLTIP_W = 164;

/** A short stroke that keys a line in the legend and tooltip. */
function LineKey({ color, dash, width = 2 }: { color: string; dash?: string; width?: number }) {
  return (
    <svg width={16} height={8} aria-hidden style={{ flexShrink: 0 }}>
      <line x1={1} x2={15} y1={4} y2={4} stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}

function LegendItem({ children, keyEl }: { children: ReactNode; keyEl: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      {keyEl}
      {children}
    </span>
  );
}

/** A level drawn across the plot with its value tagged on the price axis. */
interface Level {
  key: string;
  v: number;
  color: string;
  dash: string;
  name: string;
}

/**
 * Today's 1-minute path of an index on a fixed 09:15–15:30 IST axis: the price line (first bar's open, then
 * each close), the running VWAP, the opening-range band, a dashed previous-close line, the last price and
 * optional trade marks; level values are tagged on the price axis and named in the legend. Hover, or focus
 * and use the arrow keys, to read a bar. Fills its container's width.
 */
export default function LiveIndexChart({ index, height = 220, marks }: { index: LiveIndex; height?: number; marks?: ChartMarks }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [byKey, setByKey] = useState(false);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const asOfMs = Date.parse(index.asOf);
  const points = pricePoints(index.bars, Number.isFinite(asOfMs) ? asOfMs : null);
  const m = marksOnSession(marks, index.session);
  const dom = yDomain(index, points, m);
  const empty = points.length === 0;

  const levels: Level[] = [];
  if (index.prevClose != null && dom.prevClose === "in") levels.push({ key: "prev", v: index.prevClose, color: C.muted2, dash: "4 3", name: "Prev close" });
  if (m.target != null) levels.push({ key: "target", v: m.target, color: C.green, dash: "5 3", name: "Target" });
  if (m.stop != null) levels.push({ key: "stop", v: m.stop, color: C.red, dash: "5 3", name: "Stop" });
  if (m.skipBeyond != null) levels.push({ key: "skip", v: m.skipBeyond, color: C.orange, dash: "1 3", name: "Too late past" });
  const offPrev = index.prevClose != null && (dom.prevClose === "above" || dom.prevClose === "below") ? `${dom.prevClose === "above" ? "↑" : "↓"} ${fmtNum(index.prevClose)}` : null;

  const gutter = gutterWidth([fmtNum(index.price), ...levels.map((l) => fmtNum(l.v)), offPrev ?? ""]);
  const H = Math.max(120, height);
  const innerW = Math.max(1, width - PAD.l - gutter);
  const plotH = H - PAD.t - PAD.b;
  const plotRight = PAD.l + innerW;
  const plotBottom = PAD.t + plotH;
  const x = (t: number) => PAD.l + (sessionMinute(t) / SESSION_MINUTES) * innerW;
  const xMin = (minute: number) => PAD.l + (minute / SESSION_MINUTES) * innerW;
  const y = (v: number) => PAD.t + (1 - (v - dom.min) / (dom.max - dom.min)) * plotH;
  const clampY = (v: number) => Math.min(plotBottom - 1, Math.max(PAD.t + 1, y(v)));

  // Price-axis tags: the last price, each level, and a previous close off the chart; moved apart with leader lines.
  const tags = empty
    ? []
    : [
        { key: "last", atY: clampY(index.price), text: fmtNum(index.price), border: C.text, fill: C.text, ink: C.panel, weight: 700 },
        ...levels.map((l) => ({ key: l.key, atY: clampY(l.v), text: fmtNum(l.v), border: l.color, fill: C.panel, ink: C.textSoft, weight: 600 })),
        ...(offPrev ? [{ key: "offprev", atY: dom.prevClose === "above" ? PAD.t + 1 : plotBottom - 1, text: offPrev, border: C.muted3, fill: C.panel, ink: C.muted, weight: 600 }] : []),
      ];
  const tagY = spreadLabels(
    tags.map((t) => t.atY),
    17,
    PAD.t + 8,
    plotBottom - 8,
  );
  const ticks = empty ? [] : niceTicks(dom.min, dom.max, plotH < 160 ? 3 : 4).filter((v) => tagY.every((ty) => Math.abs(y(v) - ty) > 18));
  const times = timeTicks(innerW);

  const hoverIdx = hoverT != null ? nearestPoint(points, hoverT) : -1;
  const hp = hoverIdx >= 0 ? points[hoverIdx] : null;
  const hb = hp && hp.bar >= 0 ? index.bars[hp.bar] : null;
  const last = points[points.length - 1];

  const moveTo = (i: number) => {
    if (points.length === 0) return;
    setHoverT(points[Math.max(0, Math.min(points.length - 1, i))].t);
  };
  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    if (empty) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = ((e.clientX - rect.left) / Math.max(1, rect.width)) * SESSION_MINUTES;
    // The axis time under the pointer, on the session's day.
    setHoverT(Date.parse(`${index.session}T09:15:00+05:30`) + minute * 60_000);
    setByKey(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (empty) return;
    const cur = hoverIdx >= 0 ? hoverIdx : points.length - 1;
    const step = e.shiftKey ? 15 : 1;
    if (e.key === "ArrowLeft") moveTo(cur - step);
    else if (e.key === "ArrowRight") moveTo(cur + step);
    else if (e.key === "Home") moveTo(0);
    else if (e.key === "End") moveTo(points.length - 1);
    else if (e.key === "Escape") setHoverT(null);
    else return;
    setByKey(true);
    e.preventDefault();
  };

  const day = fmtIstDay(`${index.session}T12:00:00+05:30`);
  const levelWords = levels.filter((l) => l.key !== "prev").map((l) => `${l.name.toLowerCase()} ${fmtNum(l.v)}`);
  const summary = empty
    ? `${index.label}: ${EMPTY_TEXT}.`
    : `${index.label} 1-minute chart, ${day}: open ${fmtNum(index.bars[0].o)}, last ${fmtNum(index.price)} at ${fmtIstHm(index.asOf)} IST` +
      `${index.vwap != null ? `, VWAP ${fmtNum(index.vwap)}` : ""}${index.low != null && index.high != null ? `, day range ${fmtNum(index.low)} to ${fmtNum(index.high)}` : ""}` +
      `${index.prevClose != null ? `, previous close ${fmtNum(index.prevClose)}` : ""}${levelWords.length ? `, ${levelWords.join(", ")}` : ""}.`;
  const hoverText = hp ? `${hb ? `${fmtIstHm(hb.t)} IST` : `${fmtIstHm(hp.t)} IST open`}: ${fmtNum(hp.price)}${hp.vwap != null ? `, VWAP ${fmtNum(hp.vwap)}` : ""}` : "";
  // The reading sits above the plot unless the point is up there; then it drops to the bottom.
  const tooltipBelow = hp != null && y(hp.price) < PAD.t + 84;

  const markLabel = (t: number, row: number, text: string) => {
    const right = x(t) > plotRight - 80;
    return (
      <text
        className="tnum"
        x={x(t) + (right ? -5 : 5)}
        y={PAD.t + 9 + row * 12}
        textAnchor={right ? "end" : "start"}
        fill={C.textSoft}
        fontSize={10}
        fontWeight={600}
        style={NUM}
        stroke={C.panel}
        strokeWidth={3}
        paintOrder="stroke"
      >
        {text}
      </text>
    );
  };

  return (
    <div style={{ minWidth: 0 }}>
      <div
        ref={wrap}
        tabIndex={empty ? undefined : 0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${summary}${empty ? "" : " Focus and use the left and right arrow keys to read the bars."}`}
        onKeyDown={onKey}
        onFocus={() => {
          if (!empty && hoverT == null) {
            moveTo(points.length - 1);
            setByKey(true);
          }
        }}
        onBlur={() => setHoverT(null)}
        style={{ position: "relative", width: "100%", height: H, outlineOffset: 2, borderRadius: 6 }}
      >
        <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
          {byKey ? hoverText : ""}
        </div>
        {width > 0 && (
          <svg width={width} height={H} aria-hidden style={{ display: "block", overflow: "hidden" }}>
            {/* Price grid: solid hairlines, values in the gutter. */}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.l} x2={plotRight} y1={y(v)} y2={y(v)} stroke={C.borderSoft} strokeWidth={1} />
                <text className="tnum" x={plotRight + 7} y={y(v) + 3.5} fill={C.muted3} fontSize={10} style={NUM}>
                  {fmtNum(v, v % 1 === 0 ? 0 : 2)}
                </text>
              </g>
            ))}
            {/* Time axis. */}
            <line x1={PAD.l} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke={C.border} strokeWidth={1} />
            {times.map((tk) => {
              const tx = xMin(tk.minute);
              return (
                <g key={tk.label}>
                  <line x1={tx} x2={tx} y1={plotBottom} y2={plotBottom + 3} stroke={C.border} strokeWidth={1} />
                  <text className="tnum" x={tx} y={H - 7} fill={C.muted3} fontSize={10} style={NUM} textAnchor={tk.minute === 0 ? "start" : tk.minute === SESSION_MINUTES ? "end" : "middle"}>
                    {tk.label}
                  </text>
                </g>
              );
            })}
            {empty ? (
              <text x={PAD.l + innerW / 2} y={PAD.t + plotH / 2} fill={C.muted2} fontSize={12.5} textAnchor="middle">
                {innerW < 300 ? (
                  <>
                    <tspan x={PAD.l + innerW / 2} dy={-8}>
                      No 1-minute bars yet:
                    </tspan>
                    <tspan x={PAD.l + innerW / 2} dy={17}>
                      the session opens at 09:15 IST
                    </tspan>
                  </>
                ) : (
                  EMPTY_TEXT
                )}
              </text>
            ) : (
              <>
                {/* Opening range: a light band with hairline edges. */}
                {index.openingRange && (
                  <g>
                    <rect x={PAD.l} y={y(index.openingRange.high)} width={innerW} height={Math.max(1, y(index.openingRange.low) - y(index.openingRange.high))} fill={alpha(C.muted, 0.08)} />
                    <line x1={PAD.l} x2={plotRight} y1={y(index.openingRange.high)} y2={y(index.openingRange.high)} stroke={alpha(C.muted, 0.35)} strokeWidth={1} />
                    <line x1={PAD.l} x2={plotRight} y1={y(index.openingRange.low)} y2={y(index.openingRange.low)} stroke={alpha(C.muted, 0.35)} strokeWidth={1} />
                  </g>
                )}
                {/* Reference levels: previous close and trade levels. */}
                {levels.map((l) => (
                  <line key={l.key} x1={PAD.l} x2={plotRight} y1={y(l.v)} y2={y(l.v)} stroke={l.color} strokeWidth={1.25} strokeDasharray={l.dash} />
                ))}
                {/* VWAP, then the price on top. */}
                {points.length > 2 && (
                  <path
                    d={linePath(points.filter((p) => p.vwap != null).map((p) => [x(p.t), y(p.vwap!)] as const))}
                    fill="none"
                    stroke={C.blue}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                <path d={linePath(points.map((p) => [x(p.t), y(p.price)] as const))} fill="none" stroke={C.text} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {/* Trade marks. */}
                {m.entry && (
                  <g>
                    <line x1={x(m.entry.t)} x2={x(m.entry.t)} y1={PAD.t} y2={plotBottom} stroke={alpha(C.gold, 0.55)} strokeWidth={1} />
                    <path
                      d={
                        m.entry.side === "BUY"
                          ? `M${x(m.entry.t)},${y(m.entry.price) - 6} l6,10 l-12,0 z`
                          : `M${x(m.entry.t)},${y(m.entry.price) + 6} l6,-10 l-12,0 z`
                      }
                      fill={C.gold}
                      stroke={C.panel}
                      strokeWidth={2}
                      paintOrder="stroke"
                    />
                    {markLabel(m.entry.t, 0, `${m.entry.side === "BUY" ? "Buy" : "Sell"} ${fmtIstHm(m.entry.t)}`)}
                  </g>
                )}
                {m.exit && (
                  <g>
                    <line x1={x(m.exit.t)} x2={x(m.exit.t)} y1={PAD.t} y2={plotBottom} stroke={alpha(C.gold, 0.55)} strokeWidth={1} />
                    <circle cx={x(m.exit.t)} cy={y(m.exit.price)} r={4.5} fill={C.panel} stroke={C.gold} strokeWidth={2} />
                    {markLabel(m.exit.t, m.entry && Math.abs(x(m.entry.t) - x(m.exit.t)) < 90 ? 1 : 0, `Exit ${fmtIstHm(m.exit.t)}`)}
                  </g>
                )}
                {last && <circle cx={x(last.t)} cy={y(last.price)} r={4} fill={C.text} stroke={C.panel} strokeWidth={2} />}
                {/* Price-axis tags with leader lines from their levels. */}
                {tags.map((t, i) => (
                  <g key={t.key}>
                    <line x1={plotRight} x2={plotRight + 4} y1={t.atY} y2={tagY[i]} stroke={t.border} strokeWidth={1} />
                    <rect x={plotRight + 4} y={tagY[i] - 8} width={gutter - 5} height={16} rx={4} fill={t.fill} stroke={t.border} strokeWidth={1} />
                    <text className="tnum" x={plotRight + 4 + (gutter - 5) / 2} y={tagY[i] + 3.5} fill={t.ink} fontSize={10} fontWeight={t.weight} textAnchor="middle" style={NUM}>
                      {t.text}
                    </text>
                  </g>
                ))}
                {/* Crosshair. */}
                {hp && (
                  <g pointerEvents="none">
                    <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={plotBottom} stroke={C.muted2} strokeWidth={1} />
                    {hp.vwap != null && <circle cx={x(hp.t)} cy={y(hp.vwap)} r={3.5} fill={C.blue} stroke={C.panel} strokeWidth={2} />}
                    <circle cx={x(hp.t)} cy={y(hp.price)} r={4} fill={C.text} stroke={C.panel} strokeWidth={2} />
                  </g>
                )}
                <rect
                  x={PAD.l}
                  y={0}
                  width={innerW}
                  height={H}
                  fill="transparent"
                  onPointerMove={onPointer}
                  onPointerDown={onPointer}
                  // A finger lifting ends the pointer: keep the reading until the next touch or blur.
                  onPointerLeave={(e) => e.pointerType === "mouse" && setHoverT(null)}
                />
              </>
            )}
          </svg>
        )}
        {hp && width > 0 && (
          <div
            style={{
              position: "absolute",
              ...(tooltipBelow ? { bottom: PAD.b + 4 } : { top: 2 }),
              left: Math.min(Math.max(0, x(hp.t) - TOOLTIP_W / 2), Math.max(0, width - TOOLTIP_W)),
              width: TOOLTIP_W,
              pointerEvents: "none",
              background: C.panel,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 8,
              boxShadow: "var(--shadow-pop)",
              padding: "6px 9px",
              fontSize: 11,
              lineHeight: 1.45,
              color: C.textSoft,
            }}
          >
            <div className="tnum" style={{ color: C.muted }}>
              {hb ? `${fmtIstHm(hb.t)}–${fmtIstHm(hb.t + 60_000)} IST` : `${fmtIstHm(hp.t)} IST · open`}
            </div>
            <div className="tnum" style={{ color: C.textStrong, fontWeight: 700, fontSize: 13 }}>
              {fmtNum(hp.price)}
              {index.prevClose != null && <span style={{ color: C.muted, fontWeight: 500, fontSize: 11 }}> {fmtPct(((hp.price - index.prevClose) / index.prevClose) * 100)}</span>}
            </div>
            {hb && (
              <div className="tnum" style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: 10, color: C.muted, fontSize: 10.5 }}>
                <span>O {fmtNum(hb.o)}</span>
                <span>H {fmtNum(hb.h)}</span>
                <span>L {fmtNum(hb.l)}</span>
                <span>C {fmtNum(hb.c)}</span>
              </div>
            )}
            {hp.vwap != null && (
              <div className="tnum" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <LineKey color={C.blue} width={1.5} />
                VWAP {fmtNum(hp.vwap)}
              </div>
            )}
          </div>
        )}
      </div>
      {!empty && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 6, fontSize: 11.5, color: C.muted }}>
          <LegendItem keyEl={<LineKey color={C.text} />}>Price</LegendItem>
          <LegendItem keyEl={<LineKey color={C.blue} width={1.5} />}>VWAP</LegendItem>
          {index.openingRange && (
            <LegendItem keyEl={<span aria-hidden style={{ width: 14, height: 9, background: alpha(C.muted, 0.14), border: `1px solid ${alpha(C.muted, 0.35)}`, borderRadius: 2 }} />}>Opening range</LegendItem>
          )}
          {index.prevClose != null && <LegendItem keyEl={<LineKey color={C.muted2} dash="4 3" width={1.5} />}>Prev close</LegendItem>}
          {m.entry && <LegendItem keyEl={<span aria-hidden style={{ color: C.gold, fontSize: 10 }}>{m.entry.side === "BUY" ? "▲" : "▼"}</span>}>{m.entry.side === "BUY" ? "Buy" : "Sell"}</LegendItem>}
          {m.exit && <LegendItem keyEl={<span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", border: `2px solid ${C.gold}` }} />}>Exit</LegendItem>}
          {levels
            .filter((l) => l.key !== "prev")
            .map((l) => (
              <LegendItem key={l.key} keyEl={<LineKey color={l.color} dash={l.dash} width={1.5} />}>
                {l.name}
              </LegendItem>
            ))}
          <span style={{ color: C.muted3 }}>Times IST</span>
        </div>
      )}
    </div>
  );
}
