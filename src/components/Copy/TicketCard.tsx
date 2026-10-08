"use client";

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { SIGNAL_SOURCE_LABELS, type CopyTicketView } from "@/engine/api-types";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { fmtInr, fmtIstHm, fmtNum, fmtPct } from "@/components/shared/format";
import { Pill } from "@/components/shared/ui";

const label: CSSProperties = { fontSize: 12, color: C.muted, fontWeight: 500 };
const mono: CSSProperties = { fontFamily: "var(--font-num)", fontVariantNumeric: "tabular-nums" };
const prem = (x: number) => `₹${x.toFixed(2)}`;

const REGIME_TEXT: Record<string, string> = { TREND_UP: "trending up", TREND_DOWN: "trending down", RANGE: "range-bound", HIGH_VOL: "high volatility", EVENT: "news-driven" };
const OR_TEXT: Record<string, string> = { INSIDE: "inside", BROKE_UP: "broken upward", BROKE_DOWN: "broken downward", FORMING: "forming" };

function Fig({ k, v, sub, color }: { k: string; v: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={label}>{k}</div>
      <div style={{ ...mono, fontSize: 17, fontWeight: 700, color: color ?? C.textStrong, marginTop: 3, whiteSpace: "nowrap" }}>{v}</div>
      {sub != null && <div style={{ fontSize: 10, color: C.muted2, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CopyButton({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => {});
      }}
      style={{
        ...mono,
        fontSize: 11,
        padding: "4px 8px",
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.panelAlt,
        color: C.textSoft,
        cursor: "pointer",
      }}
    >
      {done ? "copied ✓" : text}
    </button>
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

/** The copier's own fill and the levels that follow from it (kept in this browser only). */
function YourFill({ t }: { t: CopyTicketView }) {
  const stored = useSyncExternalStore(subscribeFill, () => readFill(t.id), () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const raw = typed ?? stored;
  const fill = Number(raw);
  const ok = raw !== "" && Number.isFinite(fill) && fill > 0;
  const lv = t.levels;
  const stop = fill * (1 + lv.stopPct / 100);
  const target = fill * (1 + lv.targetPct / 100);
  const trailAt = fill * (1 + lv.trailActivatePct / 100);
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
          style={{ ...mono, width: 110, padding: "6px 8px", fontSize: 14, borderRadius: 6, border: `1px solid ${C.borderStrong}`, background: C.panel, color: C.textStrong }}
        />
        <span style={{ fontSize: 10, color: C.muted2 }}>levels from your own price (saved in this browser only)</span>
      </div>
      {ok && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginTop: 12 }}>
          <Fig k={`Your stop (${lv.stopPct}%)`} v={prem(stop)} color={C.red} sub={`−${fmtInr((fill - stop) * t.qty, { decimals: 0 })} before charges`} />
          <Fig k={`Your target (+${lv.targetPct}%)`} v={prem(target)} color={C.green} sub={`+${fmtInr((target - fill) * t.qty, { decimals: 0 })} before charges`} />
          <Fig k={`Trail starts (+${lv.trailActivatePct}%)`} v={prem(trailAt)} sub={`then sell after giving back ${lv.trailGivebackPct}% of the gain`} />
          {mark != null && <Fig k="You now (model mark)" v={fmtInr((mark - fill) * t.qty, { decimals: 0, sign: true })} color={pnlColor(mark - fill)} sub={fmtPct((mark / fill - 1) * 100, 1)} />}
        </div>
      )}
    </div>
  );
}

function ConvictionBar({ score, threshold }: { score: number; threshold: number }) {
  const v = Math.min(1, Math.abs(score));
  const color = score >= 0 ? C.green : C.red;
  return (
    <div title={`conviction ${score.toFixed(2)}, threshold ${threshold.toFixed(2)}`}>
      <div style={{ position: "relative", height: 8, background: C.track, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${v * 100}%`, height: "100%", background: color, borderRadius: 4 }} />
        <div style={{ position: "absolute", left: `${threshold * 100}%`, top: -2, bottom: -2, width: 2, background: C.textStrong }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginTop: 4 }}>
        <span>0</span>
        <span>needs {threshold.toFixed(2)}</span>
        <span>1</span>
      </div>
    </div>
  );
}

function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return <span style={{ ...mono, fontSize: 11, padding: "3px 8px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, color: color ?? C.textSoft, whiteSpace: "nowrap" }}>{children}</span>;
}

/** The index readings the trade was taken on. */
export function MarketChips({ t }: { t: CopyTicketView }) {
  const m = t.market;
  const ind = m.indicators;
  const z = ind?.vwapZ ?? 0;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      <Chip>
        {t.index} {fmtNum(m.spot, 0)}
        {m.changePct != null && <span style={{ color: pnlColor(m.changePct) }}> {fmtPct(m.changePct, 2)}</span>}
      </Chip>
      {ind && ind.vwap > 0 && (
        <Chip color={z >= 0 ? C.green : C.red}>
          VWAP {fmtNum(ind.vwap, 0)} ({z >= 0 ? "+" : "−"}
          {Math.abs(z).toFixed(1)}σ)
        </Chip>
      )}
      {ind?.openingRange && ind.openingRange.high > 0 && ind.openingRange.state !== "FORMING" && (
        <Chip>
          opening range {fmtNum(ind.openingRange.low, 0)}–{fmtNum(ind.openingRange.high, 0)} {OR_TEXT[ind.openingRange.state] ?? ""}
        </Chip>
      )}
      {ind && <Chip color={ind.rsi14 >= 70 || ind.rsi14 <= 30 ? C.orange : undefined}>RSI {ind.rsi14.toFixed(0)}</Chip>}
      {ind && (
        <Chip>
          ADX {ind.adx14.toFixed(0)} (+DI {ind.plusDi14.toFixed(0)} / −DI {ind.minusDi14.toFixed(0)})
        </Chip>
      )}
      {ind && ind.ema21 > 0 && <Chip color={ind.ema9 >= ind.ema21 ? C.green : C.red}>EMA9 {ind.ema9 >= ind.ema21 ? ">" : "<"} EMA21</Chip>}
      {ind && ind.supertrendDir !== 0 && <Chip color={ind.supertrendDir > 0 ? C.green : C.red}>Supertrend {ind.supertrendDir > 0 ? "up" : "down"}</Chip>}
      {ind && <Chip>Bollinger %B {ind.bbPctB.toFixed(2)}</Chip>}
      {m.vix != null && <Chip>VIX {m.vix.toFixed(1)}</Chip>}
    </div>
  );
}

/** Why the engine took the trade: conviction, regime, the signals that voted, edge and gates. */
export function SetupPanel({ t }: { t: CopyTicketView }) {
  const s = t.setup;
  if (!s) return <div style={{ fontSize: 12, color: C.muted }}>The plan record for this trade is missing, so its setup cannot be shown.</div>;
  const stanceColor = s.stance === "BULLISH" ? C.green : s.stance === "BEARISH" ? C.red : C.muted;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pill color={stanceColor}>{s.stance.toLowerCase()}</Pill>
        <span style={{ ...mono, fontSize: 13, color: C.textStrong, fontWeight: 700 }}>
          conviction {s.conviction >= 0 ? "+" : "−"}
          {Math.abs(s.conviction).toFixed(2)}
        </span>
        <span style={{ fontSize: 12, color: C.muted }}>
          on a {REGIME_TEXT[s.regime] ?? s.regime} day · led by {SIGNAL_SOURCE_LABELS[s.dominantSource]}
        </span>
      </div>
      <ConvictionBar score={s.conviction} threshold={s.threshold} />
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 12, color: C.textSoft, lineHeight: 1.45 }}>
        {s.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div style={{ fontSize: 12, color: C.textSoft }}>
        Edge: the engine expected a <b>{s.expectedMovePct.toFixed(2)}%</b> move over {s.horizonMin} min against <b>{s.impliedMovePct.toFixed(2)}%</b> priced into the option (×
        {s.edgeRatio.toFixed(2)}); it needs {s.breakevenMovePct.toFixed(2)}% just to cover time decay and charges.
      </div>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 11, color: C.muted, fontWeight: 700 }}>Checks before the trade ({s.gates.length})</summary>
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
          {s.gates.map((g) => (
            <li key={g.gate} style={{ fontSize: 11, color: C.textSoft, display: "flex", gap: 8 }}>
              <span style={{ color: g.passed === false ? C.red : g.passed ? C.green : C.muted2, fontWeight: 700, width: 12 }}>{g.passed === false ? "✗" : g.passed ? "✓" : "–"}</span>
              <span>
                <b>{g.label}</b>: {g.detail}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** What to buy, at which levels, and what happened to it. */
export default function TicketCard({ t }: { t: CopyTicketView }) {
  const open = t.status === "OPEN";
  const lv = t.levels;
  const sideColor = t.contract.optionType === "CE" ? C.green : C.red;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pill color={open ? C.green : C.muted} solid={open}>
          {open ? "open" : "closed"}
        </Pill>
        <Pill color={C.blue}>{t.account.shortLabel}</Pill>
        {t.entry.priceSource === "model" && (
          <Pill color={C.orange} title="Without a broker feed the engine prices options with Black-Scholes on India VIX; the real price in your app will differ.">
            model price
          </Pill>
        )}
        <span style={{ fontSize: 11, color: C.muted }}>bought {fmtIstHm(t.entry.at)} IST</span>
      </div>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, color: sideColor, letterSpacing: "-0.01em" }}>{t.headline}</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: C.muted }}>
          <span>search</span>
          <CopyButton text={t.searchText} title="Copy the search text" />
          <span>expiry {t.expiryLabel} · symbol</span>
          <CopyButton text={t.contract.tradingSymbol} title="Copy the exchange symbol" />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14 }}>
        <Fig k="Quantity" v={`${t.lots} lot · ${t.qty}`} sub={`lot size ${t.contract.lotSize}`} />
        <Fig k="Engine fill" v={prem(t.entry.premium)} sub={`cost ${fmtInr(t.entry.costRupees, { decimals: 0 })}`} />
        <Fig k={`Stop (${lv.stopPct}%)`} v={prem(lv.stop)} color={C.red} sub={`risk ${fmtInr(t.riskAtStop.rupees, { decimals: 0 })} with charges`} />
        <Fig k={`Target (+${lv.targetPct}%)`} v={prem(lv.target)} color={C.green} />
        <Fig k="Trailing stop" v={lv.trail != null ? prem(lv.trail) : `from ${prem(lv.trailActivateAt)}`} sub={lv.trail != null ? "on: sells if it falls here" : `gives back ${lv.trailGivebackPct}% of the gain`} />
        <Fig k="Time stop" v={fmtIstHm(lv.timeStopAt)} sub={`unless up ${lv.timeStopMinPnlPct}% · out by ${fmtIstHm(lv.squareOffAt)}`} />
      </div>

      {t.live && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14, padding: 12, borderRadius: 8, background: alpha(pnlColor(t.live.pnl), 0.06), border: `1px solid ${alpha(pnlColor(t.live.pnl), 0.3)}` }}>
          <Fig k="Engine mark" v={prem(t.live.mark)} sub={t.live.markAt ? `at ${fmtIstHm(t.live.markAt)}` : undefined} />
          <Fig k="Premium move" v={fmtPct(t.live.movePct, 1)} color={pnlColor(t.live.movePct)} sub={`best ${fmtPct(t.live.mfePct, 0)} · worst ${fmtPct(t.live.maePct, 0)}`} />
          <Fig k="Paper P&L" v={fmtInr(t.live.pnl, { decimals: 0, sign: true })} color={pnlColor(t.live.pnl)} sub="after entry charges" />
        </div>
      )}
      {t.exit && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14, padding: 12, borderRadius: 8, background: alpha(pnlColor(t.exit.pnl), 0.06), border: `1px solid ${alpha(pnlColor(t.exit.pnl), 0.3)}` }}>
          <Fig k="Sold" v={prem(t.exit.premium)} sub={`${fmtIstHm(t.exit.at)} · held ${t.exit.holdMin} min`} />
          <Fig k="Why it sold" v={<span style={{ fontSize: 13 }}>{t.exit.reasonText}</span>} />
          <Fig k="Paper P&L" v={fmtInr(t.exit.pnl, { decimals: 0, sign: true })} color={pnlColor(t.exit.pnl)} sub={`${fmtPct(t.exit.movePct, 1)} on the premium, after charges`} />
        </div>
      )}

      {open && <YourFill t={t} />}

      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, fontSize: 13, color: C.textSoft, lineHeight: 1.5 }}>
        {t.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
