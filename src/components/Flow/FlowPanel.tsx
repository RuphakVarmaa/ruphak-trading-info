"use client";

/**
 * Option flow, live: for NIFTY or SENSEX, the open interest added and removed at the strikes near the money
 * (ranked, or laid out by strike like the chain), the build-up behind each change, volume against normal,
 * the writers' totals and lean, PCR and its 15-minute change, the resistance and support strikes (most OI),
 * a feed of events in plain words, how fast the at-the-money premium is decaying, and whether now is a good
 * time to enter. Read-only. `variant="compact"` is the Desk's short version: the top five moves and the last
 * five events, with a link to the full panel on /options.
 */
import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { IndexId, OptionFlowView } from "@/engine/api-types";
import { FLOW_STATS } from "@/engine/flow/flowStats.generated";
import { alpha, C } from "@/components/shared/colors";
import { fmtAge, fmtIstTime, fmtNum } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { EmptyState, microLabel, Panel, Pill, Segmented, Skeleton } from "@/components/shared/ui";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import { useClockOffset } from "@/hooks/useEngineState";
import { istParts } from "@/lib/ist";
import { REFRESH_IMPORTANT_MS } from "@/lib/refresh";
import {
  baselineVolumePerMin,
  cheapestEntryTime,
  dataStale,
  decayMeter,
  entryTimeAt,
  fmtOi,
  fmtPctChg,
  fmtTimes,
  freshness,
  KIND_META,
  latestEvents,
  leanColor,
  maxAbsOiChg,
  nearAtm,
  oiP90Pct,
  pcrText,
  rankSides,
  SOURCE_WORDS,
  unusualOi,
  VERDICT_COLOR,
  volVsNormal,
  WINDOW_WORDS,
  writerLean,
  writerLine,
  writerTotals,
  type FlowKind,
  type FlowRow,
  type FlowWindow,
  type RankedSide,
} from "./flowView";
import { useMarketPollMs } from "./useMarketPoll";

type Flow = OptionFlowView;
type Side = NonNullable<FlowRow["ce"]>;

const INDEX_OPTIONS = [
  { value: "NIFTY", label: "NIFTY" },
  { value: "SENSEX", label: "SENSEX" },
] as const;
const WINDOW_OPTIONS = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
] as const;
const VIEW_OPTIONS = [
  { value: "ranked", label: "Biggest moves" },
  { value: "strike", label: "By strike" },
] as const;
const FRESH_COLOR = { live: C.green, slow: C.orange, stale: C.red } as const;
const RANKED_SHOWN = 10;

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

function KindChip({ kind, short = false }: { kind: FlowKind; short?: boolean }) {
  const m = KIND_META[kind];
  return (
    <span
      title={`${m.label}: ${m.meaning}`}
      style={{
        display: "inline-block",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.2,
        color: kind === "NEUTRAL" ? C.muted2 : m.color,
        background: alpha(m.color, 0.1),
        border: `1px solid ${alpha(m.color, 0.35)}`,
        borderRadius: 999,
        padding: "1px 7px",
        whiteSpace: "nowrap",
        lineHeight: 1.5,
      }}
    >
      {short ? m.short : m.label}
    </span>
  );
}

/** A bar for an OI change: green when added, red when removed, its length against the largest change shown. */
function OiBar({ chg, max, align = "left" }: { chg: number | null; max: number; align?: "left" | "right" }) {
  const w = chg == null ? 0 : Math.max(2, Math.round((Math.abs(chg) / max) * 100));
  return (
    <div style={{ height: 8, borderRadius: 4, background: C.track, overflow: "hidden", display: "flex", justifyContent: align === "right" ? "flex-end" : "flex-start", minWidth: 40 }}>
      {chg != null && chg !== 0 && <div style={{ width: `${w}%`, height: "100%", background: chg > 0 ? C.green : C.red, opacity: 0.85 }} />}
    </div>
  );
}

function Stat({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div title={title} style={{ display: "grid", gap: 3, minWidth: 0, alignContent: "start" }}>
      <span style={microLabel}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

const big: CSSProperties = { fontSize: 18, fontWeight: 600, color: C.textStrong };

// ---------------------------------------------------------------------------
// Premium meter and the best time to enter
// ---------------------------------------------------------------------------

function PremiumMeter({ flow, minuteOfDay, compact }: { flow: Flow; minuteOfDay: number | null; compact?: boolean }) {
  const hist = minuteOfDay == null ? null : entryTimeAt(FLOW_STATS.entryTimes[flow.index], minuteOfDay);
  const m = decayMeter(flow.summary.decayPctPerHourAtm, hist?.avgPremiumDecayPctPerHour ?? null);
  const color = m.ratio == null ? C.goldBright : m.ratio >= 1.25 ? C.red : m.ratio <= 0.8 ? C.green : C.orange;
  return (
    <div style={{ display: "grid", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="tnum" style={big}>
          {flow.summary.decayPctPerHourAtm == null ? "—" : `${flow.summary.decayPctPerHourAtm.toFixed(1)}%/h`}
        </span>
        {flow.summary.premiumDryUp && (
          <Pill color={C.orange} title={KIND_META.DRY_UP.meaning}>
            Premium drying up
          </Pill>
        )}
      </div>
      <div aria-hidden style={{ height: 6, borderRadius: 3, background: C.track, overflow: "hidden" }}>
        <div style={{ width: `${Math.round(m.fill * 100)}%`, height: "100%", background: color }} />
      </div>
      {!compact && <span style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{m.text}</span>}
    </div>
  );
}

function BestEntry({ flow, compact }: { flow: Flow; compact?: boolean }) {
  const b = flow.bestEntryWindow;
  if (!b) return <span style={{ fontSize: 13, color: C.muted }}>No entry window now (market closed).</span>;
  const c = VERDICT_COLOR[b.verdict];
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill color={c} solid={b.verdict === "good"}>
          {b.verdict === "good" ? "Good time" : b.verdict === "expensive" ? "Expensive now" : "Neutral"}
        </Pill>
        <span className="tnum" style={{ fontSize: 13, fontWeight: 600, color: C.textStrong }}>
          {b.window}
        </span>
      </div>
      {!compact && <span style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{b.reason}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OI added / removed: ranked list and by-strike table
// ---------------------------------------------------------------------------

interface Ctx {
  flow: Flow;
  window: FlowWindow;
  minuteOfDay: number | null;
  p90: number | null;
  /** Each side's volume in the 15-minute window, for the pace fallback. */
  vol15: Map<string, number | null>;
}

function volX(ctx: Ctx, s: RankedSide) {
  const perMin = ctx.minuteOfDay == null ? null : baselineVolumePerMin(FLOW_STATS.baselines, ctx.flow.index, ctx.minuteOfDay, s.offset);
  return volVsNormal({ vol: s.flow.vol, window: ctx.window, baselinePerMin: perMin, vol15m: ctx.vol15.get(`${s.strike}${s.side}`) ?? null });
}

function RankedRow({ s, ctx, max }: { s: RankedSide; ctx: Ctx; max: number }) {
  const f = s.flow;
  const vx = volX(ctx, s);
  const unusual = unusualOi(f.oiChgPct, ctx.window, ctx.p90);
  const chgColor = f.oiChg == null || f.oiChg === 0 ? C.muted : f.oiChg > 0 ? C.green : C.red;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "86px minmax(0, 1fr)", gap: "4px 12px", padding: "9px 12px", borderTop: `1px solid ${C.borderSoft}`, alignItems: "start" }}>
      <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
        <span className="tnum" style={{ fontSize: 14, fontWeight: 700, color: C.textStrong, whiteSpace: "nowrap" }}>
          {s.strike} <span style={{ color: s.side === "CE" ? C.green : C.red }}>{s.side}</span>
        </span>
        <KindChip kind={f.buildup} short />
      </div>
      <div style={{ display: "grid", gap: 5, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ flex: "1 1 auto", minWidth: 40 }}>
            <OiBar chg={f.oiChg} max={max} />
          </div>
          <span className="tnum" title={unusual ? "Beyond what 90% of 15-minute changes reach (history)" : undefined} style={{ fontSize: 14, fontWeight: 700, color: chgColor, whiteSpace: "nowrap" }}>
            {fmtOi(f.oiChg, true)}
            {unusual && <span style={{ color: C.orange }}> !</span>}
          </span>
          <span className="tnum" style={{ fontSize: 12, color: C.muted2, whiteSpace: "nowrap", minWidth: 46, textAlign: "right" }}>
            {fmtPctChg(f.oiChgPct)}
          </span>
        </div>
        <div className="tnum" style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 12, color: C.muted }}>
          <span>
            LTP {f.ltp == null ? "—" : f.ltp.toFixed(2)} <span style={{ color: f.ltpChgPct == null ? C.muted : f.ltpChgPct >= 0 ? C.green : C.red }}>({fmtPctChg(f.ltpChgPct)})</span>
          </span>
          <span title={vx ? (vx.basis === "history" ? "Against the measured median for this time of day and strike distance" : "Against this side's own pace over the last 15 minutes") : "No normal to compare with yet"}>
            Vol {fmtOi(f.vol)}
            {vx && (
              <>
                {" "}
                <b style={{ color: vx.x >= 3 ? C.purple : C.textSoft }}>{fmtTimes(vx.x)}</b>
                {vx.basis === "pace" && <span style={{ color: C.muted3 }}> pace</span>}
              </>
            )}
          </span>
          <span>OI {fmtOi(f.oi)}</span>
          {f.ivChg != null && <span>IV {f.ivChg >= 0 ? "+" : "−"}{Math.abs(f.ivChg).toFixed(1)}</span>}
        </div>
      </div>
    </div>
  );
}

function RankedList({ ctx, rows, limit }: { ctx: Ctx; rows: FlowRow[]; limit: number }) {
  const [all, setAll] = useState(false);
  const ranked = rankSides(rows, ctx.flow.atm, 5);
  const shown = all ? ranked : ranked.slice(0, limit);
  const max = maxAbsOiChg(ranked);
  if (ranked.length === 0) return <EmptyState style={{ padding: "16px 12px" }}>No strikes near the money in this reading.</EmptyState>;
  return (
    <div style={{ minWidth: 0 }}>
      {shown.map((s) => (
        <RankedRow key={`${s.strike}${s.side}`} s={s} ctx={ctx} max={max} />
      ))}
      {ranked.length > limit && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          style={{ width: "100%", minHeight: 40, border: "none", borderTop: `1px solid ${C.borderSoft}`, background: "transparent", color: C.gold, fontWeight: 600, fontSize: 13, cursor: "pointer" }}
        >
          {all ? `Show the top ${limit}` : `Show all ${ranked.length} near the money`}
        </button>
      )}
    </div>
  );
}

/** The chain layout: calls on the left, puts on the right, each with its OI change, bar and build-up. */
function StrikeTable({ ctx, rows }: { ctx: Ctx; rows: FlowRow[] }) {
  const near = nearAtm(rows, ctx.flow.atm, 5);
  const max = maxAbsOiChg(near.flatMap((r) => [{ flow: r.ce }, { flow: r.pe }]));
  const cell: CSSProperties = { padding: "7px 10px", borderTop: `1px solid ${C.borderSoft}` };
  const side = (f: Side | null, align: "left" | "right") => {
    const color = f?.oiChg == null || f.oiChg === 0 ? C.muted : f.oiChg > 0 ? C.green : C.red;
    return (
      <div style={{ display: "grid", gap: 4, justifyItems: align === "right" ? "end" : "start", minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: align === "right" ? "flex-end" : "flex-start", gap: "2px 6px", flexDirection: align === "right" ? "row-reverse" : "row" }}>
          <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color, whiteSpace: "nowrap" }}>
            {fmtOi(f?.oiChg ?? null, true)}
          </span>
          {f && f.buildup !== "NEUTRAL" && <KindChip kind={f.buildup} short />}
        </div>
        <div style={{ width: "100%" }}>
          <OiBar chg={f?.oiChg ?? null} max={max} align={align} />
        </div>
      </div>
    );
  };
  return (
    <table className="tnum" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, tableLayout: "fixed" }}>
      <thead>
        <tr style={{ color: C.muted, fontSize: 11 }}>
          <th style={{ ...cell, borderTop: "none", textAlign: "right", fontWeight: 600 }}>Calls: OI change</th>
          <th style={{ ...cell, borderTop: "none", textAlign: "center", fontWeight: 600, width: 84 }}>Strike</th>
          <th style={{ ...cell, borderTop: "none", textAlign: "left", fontWeight: 600 }}>Puts: OI change</th>
        </tr>
      </thead>
      <tbody>
        {near.map((r) => {
          const atm = r.strike === ctx.flow.atm;
          return (
            <tr key={r.strike} style={{ background: atm ? alpha(C.gold, 0.07) : undefined }}>
              <td style={cell}>{side(r.ce, "right")}</td>
              <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: atm ? C.gold : C.textStrong }}>
                {r.strike}
                {r.strike === ctx.flow.summary.resistance && <div style={{ fontSize: 10, color: C.red, fontWeight: 600 }}>resistance</div>}
                {r.strike === ctx.flow.summary.support && <div style={{ fontSize: 10, color: C.green, fontWeight: 600 }}>support</div>}
                {atm && <div style={{ fontSize: 10, color: C.gold, fontWeight: 600 }}>ATM</div>}
              </td>
              <td style={cell}>{side(r.pe, "left")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Events feed
// ---------------------------------------------------------------------------

function EventsFeed({ flow, limit, maxHeight }: { flow: Flow; limit: number; maxHeight?: number }) {
  const events = latestEvents(flow.events, limit);
  if (events.length === 0) return <EmptyState style={{ padding: "16px 12px" }}>No flow events yet in this session.</EmptyState>;
  return (
    <ol aria-label={`${flow.index} flow events, newest first`} style={{ listStyle: "none", margin: 0, padding: 0, maxHeight, overflowY: maxHeight ? "auto" : undefined }}>
      {events.map((e, i) => {
        const m = KIND_META[e.kind];
        return (
          <li key={`${e.at}|${e.strike}|${e.side}|${e.kind}|${i}`} style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "3px 10px", padding: "8px 12px", borderTop: i === 0 ? "none" : `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${m.color}` }}>
            <span className="tnum" style={{ fontSize: 12, color: C.muted, paddingTop: 1 }}>
              {fmtIstTime(e.at)}
            </span>
            <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <div>
                <KindChip kind={e.kind} />
              </div>
              <span className="tnum" style={{ fontSize: 13, color: C.textSoft, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                {e.text}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// History of entry times (research)
// ---------------------------------------------------------------------------

function EntryTimesHistory({ index, minuteOfDay }: { index: IndexId; minuteOfDay: number | null }) {
  const rows = FLOW_STATS.entryTimes[index];
  const now = minuteOfDay == null ? null : entryTimeAt(rows, minuteOfDay);
  const cheapest = cheapestEntryTime(rows);
  return (
    <details style={{ borderTop: `1px solid ${C.border}`, padding: "10px 14px" }}>
      <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 700, color: C.textStrong, minHeight: 32, display: "flex", alignItems: "center" }}>When is premium cheapest? {index} by time of day (history)</summary>
      {rows.length === 0 ? (
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: C.muted }}>The research has not published entry-time statistics yet.</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="tnum" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 330 }}>
            <thead>
              <tr style={{ color: C.muted, fontSize: 11, textAlign: "right" }}>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Window</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Average premium decay, % per hour">Decay %/h</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Average absolute index move in the window">|Move|</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Premium lost to decay per point of typical index move">₹/point</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Days</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.window} style={{ textAlign: "right", background: r === now ? alpha(C.gold, 0.08) : undefined, color: C.textSoft }}>
                  <td style={{ textAlign: "left", padding: "5px 8px", borderTop: `1px solid ${C.borderSoft}`, fontWeight: r === cheapest ? 700 : 500, color: r === cheapest ? C.green : C.textStrong }}>
                    {r.window}
                    {r === now ? " · now" : ""}
                    {r === cheapest ? " · cheapest" : ""}
                  </td>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${C.borderSoft}` }}>{r.avgPremiumDecayPctPerHour.toFixed(1)}</td>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${C.borderSoft}` }}>{r.avgAbsIndexMovePct.toFixed(2)}%</td>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${C.borderSoft}` }}>{r.costPerPointMove.toFixed(2)}</td>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${C.borderSoft}` }}>{r.sample}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: "6px 0 0", fontSize: 11.5, color: C.muted2 }}>
            From {FLOW_STATS.source}
            {FLOW_STATS.generatedAt ? `, computed ${FLOW_STATS.generatedAt.slice(0, 10)}` : ""}. ₹ per point: the premium a buyer loses to decay for each point the index typically moves in that window.
          </p>
        </div>
      )}
    </details>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface FlowPanelProps {
  variant?: "full" | "compact";
  /** Controlled index (the /options page passes its own); uncontrolled when omitted. */
  index?: IndexId;
  onIndexChange?: (index: IndexId) => void;
  /** The engine-clock offset (ms) when the page knows a better one than the engine provider's. */
  clockOffsetMs?: number;
  id?: string;
}

export default function FlowPanel({ variant = "full", index: controlled, onIndexChange, clockOffsetMs, id }: FlowPanelProps) {
  const compact = variant === "compact";
  const [own, setOwn] = useState<IndexId>("NIFTY");
  const index = controlled ?? own;
  const setIndex = (i: IndexId) => {
    setOwn(i);
    onIndexChange?.(i);
  };
  const [win, setWin] = useState<FlowWindow>("15m");
  const [view, setView] = useState<"ranked" | "strike">("ranked");

  const providerOffset = useClockOffset();
  const offset = clockOffsetMs ?? providerOffset;
  const { pollMs, nowMs } = useMarketPollMs(REFRESH_IMPORTANT_MS, offset);
  const poll = useSharedPoll<Flow>(`/api/engine/flow?index=${index}`, pollMs);
  const flow = poll.data && poll.data.index === index ? poll.data : null;

  const engineNowMs = nowMs == null ? null : nowMs + offset;
  const asOfMs = flow ? Date.parse(flow.asOf) : NaN;
  const minuteOfDay = Number.isFinite(asOfMs) ? istParts(asOfMs).minutesOfDay : null;
  const ageMs = nowMs != null && poll.at != null ? nowMs - poll.at : null;
  const fresh = freshness(ageMs, pollMs);
  const marketOpen = pollMs === REFRESH_IMPORTANT_MS;
  const old = flow != null && engineNowMs != null && dataStale(asOfMs, engineNowMs, marketOpen);
  const fetchError = plainError(poll.error, "the option flow");

  const rows = flow?.windows[win]?.rows ?? [];
  const vol15 = new Map<string, number | null>();
  for (const r of flow?.windows["15m"]?.rows ?? []) {
    vol15.set(`${r.strike}CE`, r.ce?.vol ?? null);
    vol15.set(`${r.strike}PE`, r.pe?.vol ?? null);
  }
  const ctx: Ctx | null = flow ? { flow, window: win, minuteOfDay, p90: oiP90Pct(FLOW_STATS.baselines, flow.index), vol15 } : null;
  const totals = writerTotals(rows);
  const lean = writerLean(totals.ce, totals.pe);

  const header = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: compact ? "12px 14px" : "14px 16px", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 220px" }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: compact ? 20 : 24, fontWeight: 500, color: C.textStrong, letterSpacing: "-0.01em" }}>Option flow{compact ? "" : ` · ${index}`}</h2>
        <span className="tnum" style={{ fontSize: 12, color: fresh === "live" && !old ? C.muted : FRESH_COLOR[old ? "stale" : fresh] }}>
          {flow ? `as of ${fmtIstTime(flow.asOf)} IST` : poll.error ? "not answering" : "connecting…"}
          {ageMs != null && ` · updated ${fmtAge(ageMs)} ago`}
          {old && " · data is old"}
        </span>
      </div>
      {flow && <Pill color={flow.source === "mock" ? C.purple : flow.source === "feed" ? C.green : C.blue}>{SOURCE_WORDS[flow.source]}</Pill>}
      <Segmented size="sm" label="Index" value={index} options={INDEX_OPTIONS} onChange={setIndex} />
      <Segmented size="sm" label="Window" value={win} options={WINDOW_OPTIONS} onChange={setWin} />
    </div>
  );

  let body: ReactNode;
  if (!flow && fetchError) body = <EmptyState style={{ padding: "22px 16px" }}>Option flow unavailable: {fetchError}</EmptyState>;
  else if (!flow || !ctx) body = <div style={{ padding: 16, display: "grid", gap: 10 }}>{Array.from({ length: compact ? 4 : 8 }, (_, i) => <Skeleton key={i} height={22} />)}</div>;
  else {
    const stats = (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: "12px 18px", padding: compact ? "12px 14px" : "14px 16px" }}>
        <Stat label={`${index} · ATM`}>
          <span className="tnum" style={big}>
            {fmtNum(flow.spot, 2)}
          </span>
          <span className="tnum" style={{ fontSize: 12.5, color: C.muted }}> · {flow.atm}</span>
        </Stat>
        <Stat label="PCR (OI)" title="Put OI ÷ call OI across the strikes watched, and its change over the last 15 minutes">
          <span className="tnum" style={{ ...big, fontSize: 16 }}>
            {pcrText(flow.summary.pcr, flow.summary.pcrChg15m)}
          </span>
        </Stat>
        <Stat label="Resistance · support" title="Strikes with the most call OI (resistance) and put OI (support)">
          <span className="tnum" style={{ ...big, fontSize: 16 }}>
            <span style={{ color: C.red }}>{flow.summary.resistance ?? "—"}</span> · <span style={{ color: C.green }}>{flow.summary.support ?? "—"}</span>
          </span>
        </Stat>
        <Stat label="Premium decay at ATM">
          <PremiumMeter flow={flow} minuteOfDay={minuteOfDay} compact={compact} />
        </Stat>
        <Stat label="Best time to enter">
          <BestEntry flow={flow} compact={compact} />
        </Stat>
      </div>
    );
    const writers = (
      <div className="tnum" style={{ margin: compact ? "0 14px 12px" : "0 16px 14px", padding: "9px 12px", borderRadius: 10, background: alpha(leanColor(lean.lean), 0.07), border: `1px solid ${alpha(leanColor(lean.lean), 0.3)}`, fontSize: 13.5, color: C.textStrong, lineHeight: 1.45 }}>
        {totals.strikes === 0 ? `No OI change reported in the last ${WINDOW_WORDS[win]}.` : writerLine(totals.ce, totals.pe, win)}
        <span style={{ color: C.muted }}> · across {totals.strikes} strikes</span>
      </div>
    );
    const moves = (
      <div style={{ minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.panel }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 12px", background: C.panelAlt }}>
          <b style={{ fontSize: 13.5, color: C.textStrong }}>OI added / removed · ATM±5 · {WINDOW_WORDS[win]}</b>
          {!compact && (
            <span style={{ marginLeft: "auto" }}>
              <Segmented size="sm" label="Layout" value={view} options={VIEW_OPTIONS} onChange={setView} />
            </span>
          )}
        </div>
        {compact || view === "ranked" ? <RankedList ctx={ctx} rows={rows} limit={compact ? 5 : RANKED_SHOWN} /> : <StrikeTable ctx={ctx} rows={rows} />}
      </div>
    );
    const events = (
      <div style={{ minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.panel, alignSelf: "start" }}>
        <div style={{ padding: "10px 12px", background: C.panelAlt, display: "flex", alignItems: "baseline", gap: 8 }}>
          <b style={{ fontSize: 13.5, color: C.textStrong }}>Live events</b>
          <span style={{ fontSize: 12, color: C.muted2 }}>newest first · last {compact ? 5 : 30}</span>
        </div>
        <EventsFeed flow={flow} limit={compact ? 5 : 30} maxHeight={compact ? undefined : 520} />
      </div>
    );
    body = (
      <>
        {flow.error && <div style={{ margin: "12px 16px 0", fontSize: 12.5, color: C.orange }}>The engine reported a problem with this reading: {flow.error}</div>}
        {fetchError && <div style={{ margin: "12px 16px 0", fontSize: 12.5, color: C.red }}>Last refresh failed: {fetchError} Showing the previous reading.</div>}
        {stats}
        {writers}
        <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" : "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 12, padding: compact ? "0 14px 14px" : "0 16px 16px", alignItems: "start" }}>
          {moves}
          {events}
        </div>
        {!compact && <EntryTimesHistory index={index} minuteOfDay={minuteOfDay} />}
      </>
    );
  }

  return (
    <section id={id} aria-label={`${index} option flow`} style={{ scrollMarginTop: 84, minWidth: 0 }}>
      <Panel style={{ padding: 0 }}>
        {header}
        {body}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 14px", padding: compact ? "10px 14px" : "10px 16px", borderTop: `1px solid ${C.border}`, background: C.panelAlt }}>
          <span style={{ flex: "1 1 320px", fontSize: 11.5, color: C.muted2, lineHeight: 1.5 }}>
            OI added on a strike is mostly new writing. Flow shows positioning, not a forecast: check the measured history on the trade card before acting. Vol × compares with the measured median for this time and strike
            distance, or (marked “pace”) with the strike&apos;s own last 15 minutes.
          </span>
          {compact && (
            <Link href={`/options?index=${index}#flow`} className="link-quiet" style={{ fontSize: 13, fontWeight: 600, color: C.gold, textDecoration: "none", whiteSpace: "nowrap" }}>
              Full flow and chain →
            </Link>
          )}
        </div>
      </Panel>
    </section>
  );
}
