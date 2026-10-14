"use client";

/**
 * The chain grid, Groww style: CALLS on the left, the strike in the middle (sticky when the grid scrolls
 * sideways), PUTS on the right. In-the-money halves are tinted, a line marks where the spot sits between
 * two strikes, and LTPs that moved since the last poll flash green or red.
 */
import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { OptionChainRowView, OptionSideView } from "@/engine/api-types";
import { alpha, C } from "@/components/shared/colors";
import { flashKey, fmtLakh, isItm, spotLineIndex, type Flash, type Side } from "./chainView";

export interface Highlight {
  strike: number;
  type: Side;
}

type Col = { key: string; label: string; render: (s: OptionSideView, type: Side) => ReactNode };

const num2 = (n: number | null | undefined, d = 2) => (n == null ? "–" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));

const cell: CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap", textAlign: "right", borderTop: `1px solid ${C.borderSoft}`, fontSize: 13, color: C.textStrong };

export default function ChainTable({
  rows,
  spot,
  atmStrike,
  more,
  flashes,
  highlight,
  selected,
  onPick,
  scrollKey,
}: {
  rows: OptionChainRowView[];
  spot: number;
  atmStrike: number;
  more: boolean;
  flashes: Map<string, Flash>;
  highlight: Highlight | null;
  selected: Highlight | null;
  onPick: (h: Highlight) => void;
  /** Changes when the chain changes (index, expiry, show all): scroll to the ATM row again. */
  scrollKey: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const atmRow = useRef<HTMLTableRowElement>(null);
  const strikeHead = useRef<HTMLTableCellElement>(null);
  const hasRows = rows.length > 0;

  useEffect(() => {
    const w = wrap.current;
    const r = atmRow.current;
    const h = strikeHead.current;
    if (!w || !r || !h) return;
    const id = requestAnimationFrame(() => {
      const box = w.getBoundingClientRect();
      const row = r.getBoundingClientRect();
      const head = h.getBoundingClientRect();
      w.scrollTop += row.top - box.top - (w.clientHeight - row.height) / 2;
      w.scrollLeft += head.left - box.left - (w.clientWidth - head.width) / 2;
    });
    return () => cancelAnimationFrame(id);
  }, [scrollKey, hasRows]);

  let maxOi = 1;
  for (const r of rows) maxOi = Math.max(maxOi, r.ce?.oi ?? 0, r.pe?.oi ?? 0);

  const oiCol: Col = {
    key: "oi",
    label: "OI",
    render: (s, type) => {
      const w = Math.min(100, ((s.oi ?? 0) / maxOi) * 100);
      const ch = s.oiChange;
      return (
        <div style={{ position: "relative", minWidth: 64 }}>
          <div
            aria-hidden
            style={{ position: "absolute", top: 1, bottom: 1, [type === "CE" ? "right" : "left"]: 0, width: `${w}%`, background: alpha(C.goldBright, 0.2), borderRadius: 3 }}
          />
          <div style={{ position: "relative", textAlign: type === "CE" ? "right" : "left", padding: "0 2px" }}>
            <div className="tnum">{s.oi == null ? "–" : fmtLakh(s.oi)}</div>
            <div className="tnum" style={{ fontSize: 11, color: ch == null || ch === 0 ? C.muted2 : ch > 0 ? C.green : C.red }}>
              {ch == null ? "" : `${ch > 0 ? "+" : ""}${fmtLakh(ch)}`}
            </div>
          </div>
        </div>
      );
    },
  };
  const ltpCol: Col = {
    key: "ltp",
    label: "LTP",
    render: (s) => (
      <div>
        <div className="tnum" style={{ fontWeight: 600 }}>{num2(s.ltp)}</div>
        <div className="tnum" style={{ fontSize: 11, color: s.changePct == null || s.changePct === 0 ? C.muted2 : s.changePct > 0 ? C.green : C.red }}>
          {s.changePct == null ? "" : `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(2)}%`}
        </div>
      </div>
    ),
  };
  const ivCol: Col = { key: "iv", label: "IV", render: (s) => <span className="tnum" style={{ color: C.textSoft }}>{num2(s.iv, 1)}</span> };
  const extra: Col[] = more
    ? [
        { key: "vol", label: "Volume", render: (s) => <span className="tnum">{s.volume == null ? "–" : fmtLakh(s.volume)}</span> },
        {
          key: "ba",
          label: "Bid / Ask",
          render: (s) => (
            <div className="tnum" style={{ fontSize: 12 }}>
              <div>
                {num2(s.bid)} <span style={{ color: C.muted2 }}>/</span> {num2(s.ask)}
              </div>
              <div style={{ fontSize: 11, color: C.muted2 }}>
                {s.bidQty ?? "–"} / {s.askQty ?? "–"}
              </div>
            </div>
          ),
        },
        { key: "delta", label: "Delta", render: (s) => <span className="tnum">{num2(s.delta)}</span> },
        { key: "theta", label: "Theta", render: (s) => <span className="tnum">{num2(s.theta)}</span> },
      ]
    : [];
  // Mirrored: the LTP sits next to the strike on both sides.
  const ceCols: Col[] = [...extra, oiCol, ivCol, ltpCol];
  const peCols: Col[] = [ltpCol, ivCol, oiCol, ...[...extra].reverse()];
  const span = ceCols.length;
  const lineAt = spotLineIndex(
    rows.map((r) => r.strike),
    spot,
  );

  const headCell: CSSProperties = { ...cell, borderTop: "none", position: "sticky", top: 0, zIndex: 2, background: C.panelAlt, color: C.muted, fontSize: 12, fontWeight: 600 };
  const strikeCol: CSSProperties = { position: "sticky", left: 0, right: 0, zIndex: 1, textAlign: "center", background: C.panelDeep, borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}` };

  const sideCells = (r: OptionChainRowView, type: Side, cols: Col[]) => {
    const s = type === "CE" ? r.ce : r.pe;
    const itm = isItm(r.strike, spot, type);
    const hl = highlight?.strike === r.strike && highlight.type === type;
    const sel = selected?.strike === r.strike && selected.type === type;
    const flash = flashes.get(flashKey(r.strike, type));
    const bg = hl ? alpha(C.green, 0.13) : sel ? alpha(C.blue, 0.1) : itm ? alpha(C.orange, 0.07) : undefined;
    return cols.map((c, i) => (
      <td
        key={`${type}-${c.key}`}
        onClick={s ? () => onPick({ strike: r.strike, type }) : undefined}
        className={c.key === "ltp" && flash ? `chain-flash-${flash}` : undefined}
        style={{
          ...cell,
          textAlign: type === "CE" ? "right" : "left",
          background: bg,
          cursor: s ? "pointer" : undefined,
          boxShadow: hl && ((type === "CE" && i === 0) || (type === "PE" && i === cols.length - 1)) ? `inset ${type === "CE" ? 3 : -3}px 0 0 ${C.green}` : undefined,
        }}
      >
        {s ? c.render(s, type) : <span style={{ color: C.muted3 }}>–</span>}
        {hl && c.key === "ltp" && (
          <div style={{ marginTop: 3, fontSize: 10, fontWeight: 700, color: C.green, letterSpacing: "0.02em" }}>Engine: ENTER</div>
        )}
      </td>
    ));
  };

  return (
    <div ref={wrap} style={{ maxHeight: "min(70vh, 760px)", overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, boxShadow: "var(--shadow-card)", overscrollBehaviorX: "contain" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
        <thead>
          <tr>
            <th colSpan={span} style={{ ...headCell, textAlign: "center", color: C.textStrong, fontSize: 12.5, letterSpacing: "0.06em", borderBottom: `1px solid ${C.borderSoft}` }}>
              CALLS
            </th>
            <th style={{ ...headCell, ...strikeCol, zIndex: 3, borderBottom: `1px solid ${C.borderSoft}` }} />
            <th colSpan={span} style={{ ...headCell, textAlign: "center", color: C.textStrong, fontSize: 12.5, letterSpacing: "0.06em", borderBottom: `1px solid ${C.borderSoft}` }}>
              PUTS
            </th>
          </tr>
          <tr>
            {ceCols.map((c) => (
              <th key={`hce-${c.key}`} style={{ ...headCell, top: 33 }}>
                {c.label}
              </th>
            ))}
            <th ref={strikeHead} style={{ ...headCell, ...strikeCol, top: 33, zIndex: 3, background: C.panelDeep, color: C.textStrong }}>
              Strike
            </th>
            {peCols.map((c) => (
              <th key={`hpe-${c.key}`} style={{ ...headCell, top: 33, textAlign: "left" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={r.strike}>
              {i === lineAt && <SpotLine spot={spot} span={span} strikeCol={strikeCol} />}
              <tr ref={r.strike === atmStrike ? atmRow : undefined}>
                {sideCells(r, "CE", ceCols)}
                <td className="tnum" style={{ ...cell, ...strikeCol, fontWeight: r.strike === atmStrike ? 700 : 600, color: C.textStrong, padding: "7px 14px" }}>
                  {r.strike.toLocaleString("en-IN")}
                </td>
                {sideCells(r, "PE", peCols)}
              </tr>
            </Fragment>
          ))}
          {lineAt === rows.length && rows.length > 0 && <SpotLine spot={spot} span={span} strikeCol={strikeCol} />}
        </tbody>
      </table>
    </div>
  );
}

function SpotLine({ spot, span, strikeCol }: { spot: number; span: number; strikeCol: CSSProperties }) {
  const line: CSSProperties = { padding: 0, height: 0, borderTop: `2px solid ${C.gold}` };
  return (
    <tr aria-label={`Spot ${spot}`}>
      <td colSpan={span} style={line} />
      <td style={{ ...strikeCol, zIndex: 2, padding: 0, height: 0, borderTop: `2px solid ${C.gold}`, position: "sticky", overflow: "visible" }}>
        <span
          className="tnum"
          style={{
            position: "absolute",
            left: "50%",
            top: -11,
            transform: "translateX(-50%)",
            background: C.gold,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            zIndex: 2,
          }}
        >
          {spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </td>
      <td colSpan={span} style={line} />
    </tr>
  );
}
