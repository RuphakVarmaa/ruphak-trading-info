"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { alpha, C } from "@/components/shared/colors";
import { fmtIstHm, fmtNum } from "@/components/shared/format";
import type { IntradayFeed } from "@/lib/market/intraday";

const OPEN_MIN = 9 * 60 + 15;
const SESSION_MIN = 375;
const H = 280;
const PAD = { l: 8, r: 64, t: 14, b: 22 };

function istMinute(t: number): number {
  const d = new Date(t + 5.5 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

export interface ChartMarks {
  /** The engine's entry: time, index level and direction. */
  entry?: { at: string; spot: number; side: "BULL" | "BEAR" } | null;
  exit?: { at: string } | null;
  /** Index level past which copying is too late (open trades only). */
  skipBeyond?: number | null;
}

/** One session of 5-minute candles with VWAP, the opening range and the trade's entry and exit. */
export default function CandleChart({ feed, marks }: { feed: IntradayFeed; marks: ChartMarks }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { candles, vwap, openingRange: or } = feed;
  const entryMs = marks.entry ? Date.parse(marks.entry.at) : null;
  const exitMs = marks.exit ? Date.parse(marks.exit.at) : null;
  const levels = [...candles.flatMap((c) => [c.h, c.l]), ...vwap];
  if (or) levels.push(or.high, or.low);
  if (marks.entry) levels.push(marks.entry.spot);
  if (marks.skipBeyond) levels.push(marks.skipBeyond);
  let lo = Math.min(...levels);
  let hi = Math.max(...levels);
  if (feed.prevClose != null && feed.prevClose > lo - (hi - lo) * 0.5 && feed.prevClose < hi + (hi - lo) * 0.5) {
    lo = Math.min(lo, feed.prevClose);
    hi = Math.max(hi, feed.prevClose);
  }
  const span = hi - lo || 1;
  const yMin = lo - span * 0.06;
  const yMax = hi + span * 0.06;
  const innerW = Math.max(1, width - PAD.l - PAD.r);
  const x = (t: number) => PAD.l + (Math.min(SESSION_MIN, Math.max(0, istMinute(t) - OPEN_MIN)) / SESSION_MIN) * innerW;
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const slot = innerW / (SESSION_MIN / 5);
  const bodyW = Math.max(1.5, slot * 0.66);
  const last = candles[candles.length - 1];
  const vwapPath = candles.map((c, i) => `${i ? "L" : "M"}${(x(c.t) + slot / 2).toFixed(1)},${y(vwap[i]).toFixed(1)}`).join("");
  const grid = [0.2, 0.4, 0.6, 0.8].map((f) => yMin + (yMax - yMin) * f);
  const ticks = ["09:15", "10:30", "12:00", "13:30", "15:30"];

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + PAD.l;
    let best = 0;
    for (let i = 1; i < candles.length; i++) if (Math.abs(x(candles[i].t) + slot / 2 - px) < Math.abs(x(candles[best].t) + slot / 2 - px)) best = i;
    setHover(best);
  };
  const h = hover != null ? candles[hover] : null;
  // The buy is an action (terracotta), whatever its side: green and red mean profit and loss here.
  const entryColor = C.gold;

  return (
    <div ref={wrap} style={{ position: "relative", width: "100%", height: H }}>
      {width > 0 && candles.length > 0 && (
        <svg width={width} height={H} role="img" aria-label={`${feed.index} 5-minute candles on ${feed.session}, last ${fmtNum(feed.last)}`} style={{ display: "block" }}>
          {grid.map((g) => (
            <g key={g}>
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(g)} y2={y(g)} stroke={C.borderSoft} strokeWidth={1} />
              <text x={PAD.l + innerW + 6} y={y(g) + 3} fill={C.muted3} fontSize={9} style={{ fontFamily: "var(--font-num)" }}>
                {fmtNum(g, 0)}
              </text>
            </g>
          ))}
          {ticks.map((tk) => {
            const [hh, mm] = tk.split(":").map(Number);
            const tx = PAD.l + ((hh * 60 + mm - OPEN_MIN) / SESSION_MIN) * innerW;
            return (
              <text key={tk} x={tx} y={H - 6} fill={C.muted3} fontSize={9} style={{ fontFamily: "var(--font-num)" }} textAnchor={tk === "09:15" ? "start" : tk === "15:30" ? "end" : "middle"}>
                {tk}
              </text>
            );
          })}
          {or && (
            <g>
              <rect x={PAD.l} y={y(or.high)} width={innerW} height={Math.max(1, y(or.low) - y(or.high))} fill={alpha(C.gold, 0.07)} />
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(or.high)} y2={y(or.high)} stroke={alpha(C.gold, 0.6)} strokeDasharray="3 3" />
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(or.low)} y2={y(or.low)} stroke={alpha(C.gold, 0.6)} strokeDasharray="3 3" />
              <text x={PAD.l + 4} y={y(or.high) - 4} fill={C.muted} fontSize={9}>
                opening range {fmtNum(or.low, 0)}–{fmtNum(or.high, 0)}
                {or.complete ? "" : " (forming)"}
              </text>
            </g>
          )}
          {feed.prevClose != null && feed.prevClose >= yMin && feed.prevClose <= yMax && (
            <g>
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(feed.prevClose)} y2={y(feed.prevClose)} stroke={C.borderStrong} strokeWidth={1} />
              <text x={PAD.l + innerW - 4} y={y(feed.prevClose) - 4} fill={C.muted2} fontSize={9} textAnchor="end">
                prev close {fmtNum(feed.prevClose, 0)}
              </text>
            </g>
          )}
          {marks.skipBeyond != null && (
            <g>
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(marks.skipBeyond)} y2={y(marks.skipBeyond)} stroke={C.textDim} strokeWidth={1} strokeDasharray="2 3" />
              <text x={PAD.l + innerW - 4} y={y(marks.skipBeyond) + (marks.entry?.side === "BULL" ? -4 : 11)} fill={C.textDim} fontSize={9} textAnchor="end">
                skip level {fmtNum(marks.skipBeyond, 0)}: too late to copy past it
              </text>
            </g>
          )}
          {candles.map((c) => {
            const up = c.c >= c.o;
            const color = up ? C.green : C.red;
            const cx = x(c.t) + slot / 2;
            const top = y(Math.max(c.o, c.c));
            const bottom = y(Math.min(c.o, c.c));
            return (
              <g key={c.t}>
                <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} />
                <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bottom - top)} fill={up ? alpha(C.green, 0.85) : alpha(C.red, 0.85)} />
              </g>
            );
          })}
          {candles.length > 1 && <path d={vwapPath} fill="none" stroke={C.blue} strokeWidth={1.5} strokeLinejoin="round" />}
          {candles.length > 0 && (
            <text x={x(candles[0].t) + slot / 2 + 4} y={y(vwap[0]) + (vwap[0] > candles[0].c ? -6 : 12)} fill={C.blue} fontSize={9}>
              VWAP
            </text>
          )}
          {entryMs != null && marks.entry && (
            <g>
              <line x1={x(entryMs)} x2={x(entryMs)} y1={PAD.t} y2={H - PAD.b} stroke={entryColor} strokeWidth={1} strokeDasharray="4 3" />
              <path
                d={
                  marks.entry.side === "BULL"
                    ? `M${x(entryMs)},${y(marks.entry.spot) + 2} l-6,10 l12,0 z`
                    : `M${x(entryMs)},${y(marks.entry.spot) - 2} l-6,-10 l12,0 z`
                }
                fill={entryColor}
              />
              <text x={x(entryMs) + 5} y={PAD.t + 9} fill={entryColor} fontSize={10} fontWeight={700}>
                BUY {fmtIstHm(entryMs)}
              </text>
            </g>
          )}
          {exitMs != null && (
            <g>
              <line x1={x(exitMs)} x2={x(exitMs)} y1={PAD.t} y2={H - PAD.b} stroke={C.textDim} strokeWidth={1} strokeDasharray="4 3" />
              <text x={x(exitMs) + 5} y={PAD.t + 21} fill={C.textDim} fontSize={10} fontWeight={700}>
                SELL {fmtIstHm(exitMs)}
              </text>
            </g>
          )}
          {last && (
            <g>
              <line x1={PAD.l + innerW} x2={PAD.l + innerW + 4} y1={y(feed.last)} y2={y(feed.last)} stroke={C.textStrong} />
              <rect x={PAD.l + innerW + 4} y={y(feed.last) - 8} width={PAD.r - 6} height={16} rx={3} fill={C.textStrong} />
              <text x={PAD.l + innerW + 8} y={y(feed.last) + 4} fill={C.panel} fontSize={10} style={{ fontFamily: "var(--font-num)" }} fontWeight={700}>
                {fmtNum(feed.last, 0)}
              </text>
            </g>
          )}
          {h && (
            <line x1={x(h.t) + slot / 2} x2={x(h.t) + slot / 2} y1={PAD.t} y2={H - PAD.b} stroke={C.muted2} strokeWidth={1} pointerEvents="none" />
          )}
          <rect x={PAD.l} y={0} width={innerW} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {h && hover != null && width > 0 && (
        <div
          className="tnum"
          style={{
            position: "absolute",
            top: 0,
            left: Math.min(Math.max(0, x(h.t) - 70), width - 150),
            width: 140,
            pointerEvents: "none",
            background: C.panelDeep,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 10,
            fontFamily: "var(--font-num)",
            color: C.textSoft,
          }}
        >
          <div style={{ color: C.muted }}>{fmtIstHm(h.t)} IST</div>
          <div>
            O {fmtNum(h.o, 0)} H {fmtNum(h.h, 0)}
          </div>
          <div>
            L {fmtNum(h.l, 0)} C <b style={{ color: C.textStrong }}>{fmtNum(h.c, 0)}</b>
          </div>
          <div style={{ color: C.blue }}>VWAP {fmtNum(vwap[hover], 0)}</div>
        </div>
      )}
      {candles.length === 0 && <div style={{ color: C.muted3, fontSize: 11, paddingTop: 100, textAlign: "center" }}>The chart fills in from 09:15 IST.</div>}
    </div>
  );
}
