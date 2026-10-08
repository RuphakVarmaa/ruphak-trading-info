"use client";

import { SIGNAL_SOURCE_LABELS, type PositionView } from "@/engine/api-types";
import { useNow } from "@/hooks/useEngineState";
import { alpha, C, modeColor, pnlColor } from "@/components/shared/colors";
import { fmtAge, fmtCountdown, fmtInr, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { microLabel, Pill } from "@/components/shared/ui";

function Countdowns({ p }: { p: PositionView }) {
  const now = useNow();
  const sq = Date.parse(p.squareOffAt);
  const ts = Date.parse(p.timeStopAt);
  const ltpAge = now != null && p.ltpAsOf ? fmtAge(Math.max(0, now - Date.parse(p.ltpAsOf))) : null;
  return (
    <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 9, color: C.muted, fontFamily: "monospace" }}>
      <span title="Hard intraday square-off">
        ⏱ square-off {fmtIstHm(sq)} IST ·{" "}
        <span style={{ color: now != null && sq - now < 15 * 60_000 ? C.orange : C.textSoft }}>
          {now == null ? "—" : sq > now ? `in ${fmtCountdown(sq - now)}` : "due"}
        </span>
      </span>
      <span title="Time stop: exits if the horizon has elapsed and P&L is under +10%">
        time stop {fmtIstHm(ts)} {now != null && ts <= now ? "(active)" : ""}
      </span>
      {ltpAge && <span>LTP {ltpAge} old</span>}
    </div>
  );
}

/** Live P&L and the stop ─ entry ─ trail ─ ● ─ target ladder for one open position. */
export default function PositionLive({ p }: { p: PositionView }) {
  const color = pnlColor(p.pnl);
  const ltp = p.ltp ?? p.avgPrice;
  const lo = p.stopPrice;
  const hi = p.targetPrice;
  const span = hi - lo || 1;
  const at = (v: number) => Math.max(0, Math.min(1, (v - lo) / span)) * 100;
  const entryAt = at(p.avgPrice);
  const ltpAt = at(ltp);
  const trailAt = p.trailPrice != null ? at(p.trailPrice) : null;
  const crowded = trailAt != null && Math.abs(trailAt - entryAt) < 40;
  return (
    <div style={{ border: `1px solid ${alpha(color === C.textDim ? C.muted : color, 0.45)}`, borderRadius: 6, padding: "10px 12px", background: alpha(color === C.textDim ? C.muted : color, 0.05) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill color={C.green}>● open</Pill>
        <Pill color={modeColor(p.mode === "LIVE" ? "LIVE" : "PAPER")}>{p.mode}</Pill>
        <span style={{ fontSize: 10, color: C.textSoft, fontFamily: "monospace" }}>{p.contract.label}</span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: C.muted3 }}>opened {fmtIstHm(p.openedAt)} IST</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <span className="tnum" style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color }}>
          {fmtInr(p.pnl, { sign: true })}
        </span>
        <span className="tnum" style={{ fontSize: 12, fontFamily: "monospace", color }}>
          {p.pnl > 0 ? "▲" : p.pnl < 0 ? "▼" : "▬"} {fmtPct(p.pnlPct, 1)}
        </span>
        <span className="tnum" style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "monospace" }}>
          LTP <span style={{ color: C.textStrong }}>{p.ltp != null ? fmtNum(p.ltp) : "—"}</span> · {p.qty} @ {fmtNum(p.avgPrice)}
        </span>
      </div>

      <div style={{ position: "relative", height: 14, marginTop: 10, fontSize: 8, fontFamily: "monospace", color: C.muted }}>
        {/* When the two ticks are close, anchor ENTRY to the left of its tick and TRAIL to the right of its tick. */}
        <span
          style={{
            position: "absolute",
            left: `${entryAt}%`,
            transform: crowded ? "translateX(calc(-100% - 3px))" : "translateX(-50%)",
            whiteSpace: "nowrap",
          }}
        >
          ENTRY {fmtNum(p.avgPrice)}
        </span>
        {trailAt != null && p.trailPrice != null && (
          <span
            style={{
              position: "absolute",
              left: `${trailAt}%`,
              transform: crowded ? "translateX(3px)" : "translateX(-50%)",
              whiteSpace: "nowrap",
              color: C.orange,
            }}
          >
            TRAIL {fmtNum(p.trailPrice)}
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={`Premium ${fmtNum(ltp)} between stop ${fmtNum(lo)} and target ${fmtNum(hi)}${p.trailPrice != null ? `, trailing stop ${fmtNum(p.trailPrice)}` : ""}`}
        style={{ position: "relative", height: 16 }}
      >
        <div style={{ position: "absolute", left: 0, right: 0, top: 6, height: 4, background: C.track, borderRadius: 2 }} />
        <div
          style={{
            position: "absolute",
            top: 6,
            height: 4,
            left: `${Math.min(entryAt, ltpAt)}%`,
            width: `${Math.abs(ltpAt - entryAt)}%`,
            background: ltp >= p.avgPrice ? C.green : C.red,
          }}
        />
        <div style={{ position: "absolute", left: 0, top: 1, width: 3, height: 14, background: C.red, borderRadius: 1 }} title={`Stop ${fmtNum(lo)}`} />
        <div style={{ position: "absolute", right: 0, top: 1, width: 3, height: 14, background: C.green, borderRadius: 1 }} title={`Target ${fmtNum(hi)}`} />
        <div style={{ position: "absolute", left: `${entryAt}%`, top: 2, width: 2, height: 12, marginLeft: -1, background: C.textDim }} />
        {trailAt != null && (
          <div style={{ position: "absolute", left: `${trailAt}%`, top: 0, width: 2, height: 16, marginLeft: -1, background: C.orange }} />
        )}
        <div
          title={`LTP ${fmtNum(ltp)}`}
          style={{
            position: "absolute",
            left: `${ltpAt}%`,
            top: 2,
            width: 12,
            height: 12,
            marginLeft: -6,
            borderRadius: "50%",
            background: C.textStrong,
            border: `3px solid ${color === C.textDim ? C.muted : color}`,
            boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "monospace", marginTop: 3, marginBottom: 8 }}>
        <span style={{ color: C.red }}>✗ STOP {fmtNum(lo)}</span>
        <span style={{ color: C.green }}>TARGET {fmtNum(hi)} ✓</span>
      </div>
      <Countdowns p={p} />
      <div style={{ ...microLabel, fontWeight: 600, marginTop: 6, letterSpacing: "0.04em", textTransform: "none", fontSize: 9, color: C.muted3 }}>
        dominant signal: {SIGNAL_SOURCE_LABELS[p.dominantSource]}
      </div>
    </div>
  );
}
