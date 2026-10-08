"use client";

/**
 * Parts of a copy ticket shown on /copy: the copier's own fill and the levels that follow from it, the
 * index readings the trade was taken on, and why the engine took it. Direction is shown with words and
 * arrows, not colour: on this page green and red mean profit and loss, or a check passing and failing.
 */
import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { SIGNAL_SOURCE_LABELS, type CopyTicketView, type GateResult } from "@/engine/api-types";
import { C, pnlColor } from "@/components/shared/colors";
import { fmtInr, fmtNum, fmtPct } from "@/components/shared/format";
import { Pill } from "@/components/shared/ui";
import { ceilTick, floorTick, rupees } from "@/lib/copy/prices";

const label: CSSProperties = { fontSize: 12, color: C.muted, fontWeight: 500 };
const mono: CSSProperties = { fontFamily: "var(--font-num)", fontVariantNumeric: "tabular-nums" };

const REGIME_TEXT: Record<string, string> = { TREND_UP: "trending up", TREND_DOWN: "trending down", RANGE: "range-bound", HIGH_VOL: "high volatility", EVENT: "news-driven" };
const OR_TEXT: Record<string, string> = { INSIDE: "inside", BROKE_UP: "broken upward", BROKE_DOWN: "broken downward", FORMING: "forming" };
const arrow = (x: number) => (x > 0 ? "▲" : x < 0 ? "▼" : "▬");

function Fig({ k, v, sub, color }: { k: string; v: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={label}>{k}</div>
      <div style={{ ...mono, fontSize: 17, fontWeight: 700, color: color ?? C.textStrong, marginTop: 3, overflowWrap: "anywhere" }}>{v}</div>
      {sub != null && <div style={{ fontSize: 11.5, color: C.muted2, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// The copier's fill lives in localStorage, read through useSyncExternalStore (no effect needed); the
// typed value is also kept in state so the field still works when storage is unavailable.
const fillKey = (id: string) => `copy:fill:${id}`;
const fillListeners = new Set<() => void>();

function readFill(id: string): string {
  try {
    return window.localStorage.getItem(fillKey(id)) ?? "";
  } catch {
    return "";
  }
}

function subscribeFill(cb: () => void) {
  fillListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith("copy:fill:")) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    fillListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function writeFill(id: string, value: string) {
  try {
    if (value) window.localStorage.setItem(fillKey(id), value);
    else window.localStorage.removeItem(fillKey(id));
  } catch {
    // Not saved; the typed value still drives the levels.
  }
  fillListeners.forEach((l) => l());
}

/** The copier's own fill and the levels that follow from it (kept in this browser only), on the 0.05 tick. */
export function YourFill({ t }: { t: CopyTicketView }) {
  const stored = useSyncExternalStore(subscribeFill, () => readFill(t.id), () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const raw = typed ?? stored;
  const fill = Number(raw);
  const ok = raw !== "" && Number.isFinite(fill) && fill > 0;
  const lv = t.levels;
  const stop = floorTick(fill * (1 + lv.stopPct / 100));
  const target = ceilTick(fill * (1 + lv.targetPct / 100));
  const trailAt = ceilTick(fill * (1 + lv.trailActivatePct / 100));
  const mark = t.live?.mark ?? null;
  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <label htmlFor={`fill-${t.id}`} style={{ ...label, fontSize: 13, fontWeight: 600, color: C.textSoft }}>
          Your fill price
        </label>
        <input
          id={`fill-${t.id}`}
          inputMode="decimal"
          placeholder={t.entry.premium.toFixed(2)}
          value={raw}
          onChange={(e) => {
            const v = e.target.value.replace(/[^\d.]/g, "");
            setTyped(v);
            writeFill(t.id, v);
          }}
          style={{ ...mono, width: 120, minHeight: 44, padding: "6px 10px", fontSize: 16, borderRadius: 8, border: `1px solid ${C.borderStrong}`, background: C.panel, color: C.textStrong }}
        />
        <span style={{ fontSize: 11.5, color: C.muted2, flex: "1 1 200px" }}>Levels from your own price, on the ₹0.05 tick (saved in this browser only).</span>
      </div>
      {ok && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 12, marginTop: 12 }}>
          <Fig k={`Your stop (${lv.stopPct}%)`} v={rupees(stop)} color={C.red} sub={`−${fmtInr((fill - stop) * t.qty, { decimals: 0 })} before charges`} />
          <Fig k={`Your target (+${lv.targetPct}%)`} v={rupees(target)} color={C.green} sub={`+${fmtInr((target - fill) * t.qty, { decimals: 0 })} before charges`} />
          <Fig k={`Trail starts (+${lv.trailActivatePct}%)`} v={rupees(trailAt)} sub={`then sell after giving back ${lv.trailGivebackPct}% of the gain`} />
          {mark != null && <Fig k="You now (engine mark)" v={fmtInr((mark - fill) * t.qty, { decimals: 0, sign: true })} color={pnlColor(mark - fill)} sub={fmtPct((mark / fill - 1) * 100, 1)} />}
        </div>
      )}
    </div>
  );
}

function ConvictionBar({ score, threshold }: { score: number; threshold: number }) {
  const v = Math.min(1, Math.abs(score));
  return (
    <div title={`conviction ${score.toFixed(2)}, threshold ${threshold.toFixed(2)}`}>
      <div style={{ position: "relative", height: 8, background: C.track, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${v * 100}%`, height: "100%", background: C.textDim, borderRadius: 4 }} />
        <div style={{ position: "absolute", left: `${Math.min(1, threshold) * 100}%`, top: -2, bottom: -2, width: 2, background: C.gold }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 4 }}>
        <span>0</span>
        <span>needs {threshold.toFixed(2)}</span>
        <span>1</span>
      </div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span style={{ ...mono, fontSize: 11.5, padding: "3px 8px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, color: C.textSoft, whiteSpace: "nowrap" }}>{children}</span>;
}

/** Index readings: the ones a trade was taken on (a ticket's `market`), or the engine's latest. */
export function MarketChips({ index, market: m }: { index: string; market: CopyTicketView["market"] }) {
  const ind = m.indicators;
  const z = ind?.vwapZ ?? 0;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      <Chip>
        {index} {fmtNum(m.spot, 0)}
        {m.changePct != null && ` ${arrow(m.changePct)} ${fmtPct(m.changePct, 2)}`}
      </Chip>
      {ind && ind.vwap > 0 && (
        <Chip>
          VWAP {fmtNum(ind.vwap, 0)} ({z >= 0 ? "+" : "−"}
          {Math.abs(z).toFixed(1)}σ)
        </Chip>
      )}
      {ind?.openingRange && ind.openingRange.high > 0 && ind.openingRange.state !== "FORMING" && (
        <Chip>
          opening range {fmtNum(ind.openingRange.low, 0)}–{fmtNum(ind.openingRange.high, 0)} {OR_TEXT[ind.openingRange.state] ?? ""}
        </Chip>
      )}
      {ind && <Chip>RSI {ind.rsi14.toFixed(0)}</Chip>}
      {ind && (
        <Chip>
          ADX {ind.adx14.toFixed(0)} (+DI {ind.plusDi14.toFixed(0)} / −DI {ind.minusDi14.toFixed(0)})
        </Chip>
      )}
      {ind && ind.ema21 > 0 && <Chip>EMA9 {ind.ema9 >= ind.ema21 ? "above" : "below"} EMA21</Chip>}
      {ind && ind.supertrendDir !== 0 && <Chip>Supertrend {ind.supertrendDir > 0 ? "▲ up" : "▼ down"}</Chip>}
      {ind && <Chip>Bollinger %B {ind.bbPctB.toFixed(2)}</Chip>}
      {m.vix != null && <Chip>VIX {m.vix.toFixed(1)}</Chip>}
    </div>
  );
}

/** Every check with ✓ (green, passed), ✗ (red, failed) or – (not applicable). */
export function GateList({ gates }: { gates: GateResult[] }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
      {gates.map((g) => (
        <li key={g.gate} style={{ fontSize: 12.5, color: C.textSoft, display: "flex", gap: 8, lineHeight: 1.45 }}>
          <span aria-label={g.passed === false ? "failed" : g.passed ? "passed" : "not applicable"} style={{ color: g.passed === false ? C.red : g.passed ? C.green : C.muted2, fontWeight: 700, width: 12, flexShrink: 0 }}>
            {g.passed === false ? "✗" : g.passed ? "✓" : "–"}
          </span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <b>{g.label}</b>
            {g.detail ? `: ${g.detail}` : ""} <span style={{ color: C.muted3 }}>({g.gate})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Why the engine took the trade: conviction, regime, the signals that voted, edge and the checks before it. */
export function SetupPanel({ t }: { t: CopyTicketView }) {
  const s = t.setup;
  if (!s) return <div style={{ fontSize: 12.5, color: C.muted }}>The plan record for this trade is missing, so its setup cannot be shown.</div>;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pill color={C.textSoft}>
          {arrow(s.conviction)} {s.stance.toLowerCase()}
        </Pill>
        <span style={{ ...mono, fontSize: 13, color: C.textStrong, fontWeight: 700 }}>
          conviction {s.conviction >= 0 ? "+" : "−"}
          {Math.abs(s.conviction).toFixed(2)}
        </span>
        <span style={{ fontSize: 12.5, color: C.muted }}>
          on a {REGIME_TEXT[s.regime] ?? s.regime} day ({s.regime}) · led by {SIGNAL_SOURCE_LABELS[s.dominantSource]}
        </span>
      </div>
      <ConvictionBar score={s.conviction} threshold={s.threshold} />
      <ul style={{ listStyle: "disc", margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 12.5, color: C.textSoft, lineHeight: 1.45 }}>
        {s.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div style={{ fontSize: 12.5, color: C.textSoft, lineHeight: 1.5 }}>
        Edge: the engine expected a <b>{s.expectedMovePct.toFixed(2)}%</b> move over {s.horizonMin} min against <b>{s.impliedMovePct.toFixed(2)}%</b> priced into the option (×
        {s.edgeRatio.toFixed(2)}); it needs {s.breakevenMovePct.toFixed(2)}% just to cover time decay and charges.
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.muted }}>Checks before the trade ({s.gates.length})</div>
        <GateList gates={s.gates} />
      </div>
    </div>
  );
}
