"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { PositionView } from "@/engine/api-types";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtDateKey, fmtIstHm, fmtIstTime, fmtNum, fmtPct, fmtSigned } from "@/components/shared/format";
import { Panel, PanelHeader, Skeleton, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from "@/components/shared/ui";
import { useClientNow } from "@/hooks/useEngineState";
import type { NiftyFeed } from "@/lib/market/niftyFeed";
import type { LoadedFeed } from "./useNiftyFeed";

const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_MIN = 375;

/** Minutes since midnight IST for an epoch-ms time. */
function istMinute(t: number): number {
  const d = new Date(t + 5.5 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Today's NIFTY path across the 09:15–15:30 session, with the previous close as a reference line. */
function PriceLine({ bars, prevClose }: { bars: NiftyFeed["bars"]; prevClose: number | null }) {
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

  const H = 170;
  const pad = { l: 8, r: 72, t: 12, b: 22 };
  const closes = bars.map((b) => b.c);
  const vals = prevClose != null ? [...closes, prevClose] : closes;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const yMin = lo - span * 0.08;
  const yMax = hi + span * 0.08;
  const innerW = Math.max(1, width - pad.l - pad.r);
  const x = (t: number) => pad.l + (Math.min(SESSION_MIN, Math.max(0, istMinute(t) - SESSION_OPEN_MIN)) / SESSION_MIN) * innerW;
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const d = bars.map((b, i) => `${i ? "L" : "M"}${x(b.t).toFixed(1)},${y(b.c).toFixed(1)}`).join("");
  const last = bars[bars.length - 1];

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + pad.l;
    let best = 0;
    for (let i = 1; i < bars.length; i++) if (Math.abs(x(bars[i].t) - px) < Math.abs(x(bars[best].t) - px)) best = i;
    setHover(best);
  };
  const h = hover != null ? bars[hover] : null;
  const ticks = ["09:15", "11:00", "13:00", "15:30"];

  return (
    <div ref={wrap} style={{ position: "relative", width: "100%", height: H }}>
      {width > 0 && bars.length > 1 && (
        <svg width={width} height={H} role="img" aria-label={`NIFTY 50 today, last ${fmtNum(last.c)}`} style={{ display: "block" }}>
          {prevClose != null && (
            <g>
              <line x1={pad.l} x2={pad.l + innerW} y1={y(prevClose)} y2={y(prevClose)} stroke={C.borderStrong} strokeWidth={1} />
              <text x={pad.l + innerW + 6} y={y(prevClose) + 3} fill={C.muted2} fontSize={9} style={{ fontFamily: "var(--font-num)" }}>
                prev {fmtNum(prevClose, 0)}
              </text>
            </g>
          )}
          {ticks.map((tk) => {
            const [hh, mm] = tk.split(":").map(Number);
            const tx = pad.l + ((hh * 60 + mm - SESSION_OPEN_MIN) / SESSION_MIN) * innerW;
            return (
              <text key={tk} x={tx} y={H - 6} fill={C.muted3} fontSize={9} style={{ fontFamily: "var(--font-num)" }} textAnchor={tk === "09:15" ? "start" : tk === "15:30" ? "end" : "middle"}>
                {tk}
              </text>
            );
          })}
          <path d={d} fill="none" stroke={C.gold} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last.t)} cy={y(last.c)} r={4} fill={C.gold} stroke={C.panel} strokeWidth={2} />
          <text x={x(last.t) + 8} y={y(last.c) + 3} fill={C.textStrong} fontSize={10} style={{ fontFamily: "var(--font-num)" }} fontWeight={700}>
            {fmtNum(last.c, 0)}
          </text>
          {h && (
            <g pointerEvents="none">
              <line x1={x(h.t)} x2={x(h.t)} y1={pad.t} y2={H - pad.b} stroke={C.muted2} strokeWidth={1} />
              <circle cx={x(h.t)} cy={y(h.c)} r={4} fill={C.gold} stroke={C.panel} strokeWidth={2} />
            </g>
          )}
          <rect x={pad.l} y={0} width={innerW} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {h && width > 0 && (
        <div
          className="tnum"
          style={{
            position: "absolute",
            top: 0,
            left: Math.min(Math.max(0, x(h.t) - 60), width - 130),
            width: 120,
            pointerEvents: "none",
            background: C.panelDeep,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 10,
          }}
        >
          <div style={{ color: C.textStrong, fontWeight: 700, fontFamily: "var(--font-num)" }}>{fmtNum(h.c)}</div>
          <div style={{ color: C.muted }}>{fmtIstHm(h.t)} IST{prevClose != null ? ` · ${fmtPct(((h.c - prevClose) / prevClose) * 100)}` : ""}</div>
        </div>
      )}
      {bars.length <= 1 && <div style={{ color: C.muted3, fontSize: 11, paddingTop: 60, textAlign: "center" }}>The chart fills in from 09:15 IST.</div>}
    </div>
  );
}

function Price({ side, itm }: { side: { ltp: number; bid: number; ask: number }; itm: boolean }) {
  return (
    <td style={{ ...tdNum, background: itm ? alpha(C.gold, 0.05) : undefined }}>
      <div style={{ color: C.textStrong, fontWeight: 700 }}>{fmtNum(side.ltp)}</div>
      <div style={{ color: C.muted2, fontSize: 9 }}>
        {fmtNum(side.bid)} / {fmtNum(side.ask)}
      </div>
    </td>
  );
}

/** NIFTY 50 live price, today's chart and the option chain (model prices) for the Live P&L page. */
export default function NiftyLiveFeed({
  positions,
  data,
  error,
  onExpiry,
}: {
  positions: PositionView[];
  data: LoadedFeed | null;
  error: string | null;
  onExpiry: (expiry: string) => void;
}) {
  const clientNow = useClientNow();
  const feed = data?.feed ?? null;
  const chain = feed?.chain ?? null;
  const held = new Map(positions.filter((p) => !chain || p.contract.expiry === chain.expiry).map((p) => [`${p.contract.strike}${p.contract.optionType}`, p]));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel>
        <PanelHeader
          title="NIFTY 50"
          right={
            <span className="tnum" style={{ fontSize: 10, color: error ? C.orange : C.muted2, fontFamily: "var(--font-num)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {error ? `feed error: ${error}` : feed ? `last trade ${fmtIstTime(feed.asOf)} IST · updated ${clientNow && data ? fmtAge(Math.max(0, clientNow - data.at)) : "—"} ago` : "loading…"}
            </span>
          }
        />
        <div style={{ padding: "12px 14px 8px" }}>
          {feed ? (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
                <span className="tnum" style={{ fontSize: 28, fontWeight: 800, color: C.textStrong, fontFamily: "var(--font-num)" }}>{fmtNum(feed.spot)}</span>
                {feed.change != null && feed.changePct != null && (
                  <span className="tnum" style={{ fontSize: 14, fontWeight: 700, color: pnlColor(feed.change), fontFamily: "var(--font-num)" }}>
                    {fmtSigned(feed.change)} ({fmtPct(feed.changePct)})
                  </span>
                )}
                {feed.vix != null && <span style={{ fontSize: 11, color: C.muted }}>India VIX {fmtNum(feed.vix)}</span>}
              </div>
              <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 10, color: C.muted, fontFamily: "var(--font-num)", margin: "4px 0 8px" }}>
                {feed.open != null && <span>open {fmtNum(feed.open)}</span>}
                {feed.high != null && <span>high {fmtNum(feed.high)}</span>}
                {feed.low != null && <span>low {fmtNum(feed.low)}</span>}
                {feed.prevClose != null && <span>prev close {fmtNum(feed.prevClose)}</span>}
              </div>
              <PriceLine bars={feed.bars} prevClose={feed.prevClose} />
              <div style={{ fontSize: 10, color: C.muted3, marginTop: 4 }}>
                Yahoo 1-minute bars ({feed.session}), as fresh as Yahoo has them. Refreshes every 2 s.
              </div>
            </>
          ) : (
            <Skeleton height={220} />
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="NIFTY option chain"
          right={
            chain ? (
              <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="Expiry">
                {chain.expiries.map((e) => (
                  <button
                    key={e}
                    role="tab"
                    aria-selected={e === chain.expiry}
                    onClick={() => onExpiry(e)}
                    style={{
                      background: e === chain.expiry ? alpha(C.gold, 0.15) : "transparent",
                      color: e === chain.expiry ? C.gold : C.muted,
                      border: `1px solid ${e === chain.expiry ? alpha(C.gold, 0.5) : C.border}`,
                      borderRadius: 4,
                      padding: "3px 8px",
                      fontSize: 10,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {fmtDateKey(e)}
                  </button>
                ))}
              </div>
            ) : null
          }
        />
        <div style={{ padding: "10px 14px 0", fontSize: 11, color: C.textDim, lineHeight: 1.5 }}>
          <strong style={{ color: C.orange }}>Model prices, not exchange quotes.</strong> Black-Scholes on India VIX
          {chain ? ` (${fmtNum(chain.ivPct, 1)}% vol)` : ""} with a modelled bid/ask: the same prices the paper trades fill at. Real
          quotes need a broker feed (Groww API keys).
        </div>
        <div style={{ padding: 14 }}>
          {chain ? (
            <div style={tableWrap}>
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRow}>
                    <th style={thNum}>Call (CE) ₹</th>
                    <th style={{ ...th, textAlign: "center" }}>Strike</th>
                    <th style={thNum}>Put (PE) ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.rows.map((r) => {
                    const atm = r.strike === chain.atm;
                    const tags = [held.get(`${r.strike}CE`) ? "CE held" : null, held.get(`${r.strike}PE`) ? "PE held" : null].filter(Boolean);
                    return (
                      <tr key={r.strike} style={{ background: atm ? alpha(C.gold, 0.1) : undefined }}>
                        <Price side={r.ce} itm={feed != null && r.strike < feed.spot} />
                        <td style={{ ...td, textAlign: "center", fontFamily: "var(--font-num)", fontWeight: 700, color: atm ? C.gold : C.textSoft }}>
                          {r.strike}
                          {atm && <div style={{ fontSize: 8, color: C.gold, fontWeight: 700 }}>ATM</div>}
                          {tags.length > 0 && <div style={{ fontSize: 8, color: C.green, fontWeight: 700 }}>● {tags.join(" · ")}</div>}
                        </td>
                        <Price side={r.pe} itm={feed != null && r.strike > feed.spot} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : feed ? (
            <div style={{ color: C.muted3, fontSize: 11 }}>India VIX is missing, so the chain cannot be priced.</div>
          ) : (
            <Skeleton height={200} />
          )}
          {chain && (
            <div style={{ fontSize: 10, color: C.muted3, marginTop: 8 }}>
              Shaded cells are in the money. Lot size 65. The engine never buys the contract expiring today.
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
