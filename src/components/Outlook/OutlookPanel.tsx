"use client";

/**
 * "Next 30 days": what today's option prices imply for each listed expiry up to 30 days ahead (from
 * GET /api/engine/outlook). One headline sentence, then one card per expiry with the ATM straddle (the
 * priced move), its break-even range on a shared scale, ATM IV, PCR, max pain, the OI walls, the OI change
 * since yesterday and the scheduled events before the expiry. Market prices, not a forecast.
 */
import { useState, type ReactNode } from "react";
import type { IndexId } from "@/engine/api-types";
import { dayMonth, outlookHeadline, weekdayShort, type OptionOutlookView, type OutlookEvent, type OutlookExpiry } from "@/lib/options/outlook";
import { plainError, useSharedPoll } from "@/components/Copy/sharedPoll";
import { alpha, C, impactColor } from "@/components/shared/colors";
import { fmtAge, fmtIstDateTime, fmtIstHm, fmtNum } from "@/components/shared/format";
import { SERIF } from "@/components/shared/theme";
import { Dot, EmptyState, Panel, Pill, Skeleton, microLabel } from "@/components/shared/ui";
import { useClientNow } from "@/hooks/useEngineState";
import { daysLine, moveTooltip, newEventsPerRow, oiChangeLine, OUTLOOK_FILL_MS, outlookPollMs, rangeScale, scalePct } from "./outlookText";

export interface OutlookPanelProps {
  index: IndexId;
  /** Engine clock minus browser clock (the mock runs its own clock); decides market hours for polling. */
  clockOffsetMs?: number;
  /** Shows this expiry in the option chain below. */
  onOpenChain?: (expiry: string) => void;
}

const NO_DATA = "no data";
const grouped = (n: number) => Math.round(n).toLocaleString("en-IN");

export default function OutlookPanel({ index, clockOffsetMs = 0, onOpenChain }: OutlookPanelProps) {
  const now = useClientNow();
  const [pollMs, setPollMs] = useState(OUTLOOK_FILL_MS);
  const poll = useSharedPoll<OptionOutlookView>(`/api/engine/outlook?index=${index}`, pollMs);
  const view = poll.data && poll.data.index === index ? poll.data : null;
  // Derived state, adjusted during render: poll fast while expiries are still being read.
  const want = outlookPollMs(view ? view.pending : null, now == null ? null : now + clockOffsetMs);
  if (want !== pollMs) setPollMs(want);

  const fetchError = plainError(poll.error, "the outlook");
  const ageMs = now != null && poll.at != null ? now - poll.at : null;
  const headline = view ? outlookHeadline(index, view.expiries) : null;
  const scale = view ? rangeScale(view.expiries, view.spot) : null;
  const fresh = view ? newEventsPerRow(view.expiries) : [];

  return (
    <Panel style={{ padding: 0 }}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${C.border}`, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "8px 16px" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            {view ? (
              <p style={{ margin: 0, fontFamily: SERIF, fontSize: "clamp(18px, 2vw, 21px)", lineHeight: 1.4, color: C.textStrong }}>
                {headline ??
                  (view.pending > 0 && view.expiries.length > 0 ? `Reading the ${index} option chains for the next 30 days…` : `No ${index} expiry has usable option prices right now, so there is no priced move to show.`)}
              </p>
            ) : fetchError ? (
              <p style={{ margin: 0, fontSize: 14, color: C.muted }}>The outlook is unavailable: {fetchError}</p>
            ) : (
              <Skeleton height={24} width="80%" />
            )}
          </div>
          <div style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12, color: C.muted }}>
            {view?.source && <Pill color={view.source === "mock" ? C.purple : C.blue}>{view.source === "mock" ? "Mock data" : "Upstox"}</Pill>}
            <span className="tnum">
              {view ? `prices as of ${fmtIstHm(view.asOf)} IST` : poll.error ? "not answering" : "connecting…"}
              {ageMs != null && ` · checked ${fmtAge(ageMs)} ago`}
            </span>
          </div>
        </div>
        {view?.error && <div style={{ fontSize: 13, color: C.orange }}>{view.error}</div>}
        {view && fetchError && <div style={{ fontSize: 12.5, color: C.red }}>Last refresh failed: {fetchError} Showing the previous outlook.</div>}
        {view && scale && view.spot != null && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 12.5, color: C.muted }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{ width: 22, height: 10, borderRadius: 4, background: alpha(C.goldBright, 0.25), border: `1px solid ${C.goldBright}` }} />
              Break-even range for a straddle buyer
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{ width: 2, height: 14, background: C.textStrong }} />
              <span className="tnum">
                {index} spot {fmtNum(view.spot, 2)}
              </span>
            </span>
            <span>All expiries on one scale.</span>
          </div>
        )}
      </div>

      {!view && !fetchError && (
        <div style={{ padding: 18, display: "grid", gap: 14 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} height={92} />
          ))}
        </div>
      )}
      {!view && fetchError && <EmptyState>Nothing to show until the engine answers.</EmptyState>}
      {view && view.expiries.length === 0 && !view.error && <EmptyState>No {index} expiry is listed in the next 30 days.</EmptyState>}

      {view?.expiries.map((row, i) => (
        <ExpiryCard key={row.expiry} row={row} first={i === 0} fresh={fresh[i] ?? []} eventsKnown={view.events != null} spot={view.spot} scale={scale} onOpenChain={onOpenChain} />
      ))}

      <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, background: C.panelAlt, display: "grid", gap: 6, fontSize: 12, color: C.muted2, lineHeight: 1.55 }}>
        <span style={{ fontSize: 13, color: C.textSoft, fontWeight: 600 }}>What the option market prices today; it changes every day and is not a forecast or advice.</span>
        <span>
          Priced move: the ATM call plus the ATM put (bid/ask mid when the spread is tight, otherwise the last trade), as a share of the spot. A straddle bought now breaks even at expiry only if the
          index ends outside ATM strike ± that premium. Support and resistance: the strikes with the most put and call open interest. OI change: net change in open interest since yesterday&apos;s close,
          all strikes. IV is Upstox&apos;s estimate. Each expiry&apos;s chain is re-read every 5 minutes in market hours (30 minutes otherwise).
        </span>
      </div>
    </Panel>
  );
}

function ExpiryCard({
  row,
  first,
  fresh,
  eventsKnown,
  spot,
  scale,
  onOpenChain,
}: {
  row: OutlookExpiry;
  first: boolean;
  fresh: OutlookEvent[];
  eventsKnown: boolean;
  spot: number | null;
  scale: { min: number; max: number } | null;
  onOpenChain?: (expiry: string) => void;
}) {
  const pending = row.fetchedAt == null && row.error == null;
  const missing = row.fetchedAt == null && row.error != null;
  return (
    <article style={{ borderTop: first ? "none" : `1px solid ${C.border}`, padding: "14px 18px 16px", display: "grid", gap: 12, minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px" }}>
        <h3 style={{ margin: 0, fontSize: 16.5, fontWeight: 650, color: C.textStrong, whiteSpace: "nowrap" }}>
          {weekdayShort(row.expiry)} {dayMonth(row.expiry)}
        </h3>
        {row.monthly && <Pill color={C.gold}>Monthly</Pill>}
        {row.beyondHorizon && (
          <Pill color={C.muted} title="No monthly expiry falls within 30 days, so the next one is shown too.">
            Past 30 days
          </Pill>
        )}
        <span className="tnum" style={{ fontSize: 13, color: C.muted }}>
          {daysLine(row.days, row.sessions)}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
          {row.fetchedAt && (
            <span className="tnum" style={{ fontSize: 12, color: row.stale ? C.orange : C.muted2 }}>
              read {fmtIstHm(row.fetchedAt)} IST
            </span>
          )}
          {onOpenChain && (
            <button
              type="button"
              onClick={() => onOpenChain(row.expiry)}
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: C.gold, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
            >
              Open in chain →
            </button>
          )}
        </span>
      </header>

      {pending ? (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ fontSize: 13, color: C.muted }}>Reading this expiry&apos;s option chain…</span>
          <Skeleton height={40} />
        </div>
      ) : missing ? (
        <div style={{ fontSize: 13, color: C.muted }}>No data for this expiry: {row.error}</div>
      ) : (
        <>
          {row.stale && <div style={{ fontSize: 12.5, color: C.orange }}>The latest refresh failed ({row.error}). These figures are from {fmtIstHm(row.fetchedAt!)} IST.</div>}
          {!row.stale && row.error && <div style={{ fontSize: 12.5, color: C.orange }}>{row.error}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 132px), 1fr))", gap: "12px 18px" }}>
            <Fact label="Priced move" title={moveTooltip(row)}>
              {row.movePct != null && row.straddle ? (
                <>
                  <Big>±{row.movePct.toFixed(2)}%</Big>
                  <Sub>₹{fmtNum(row.straddle.total, 2)} ATM straddle</Sub>
                </>
              ) : (
                <NoData />
              )}
            </Fact>
            <Fact label="Break-even range" title="ATM strike ± the straddle: where a straddle bought now breaks even at expiry. Not a forecast of where the index will be.">
              {row.range ? (
                <>
                  <Big>
                    {grouped(row.range.low)} – {grouped(row.range.high)}
                  </Big>
                  <Sub>ATM {row.atmStrike != null ? grouped(row.atmStrike) : NO_DATA}</Sub>
                </>
              ) : (
                <NoData />
              )}
            </Fact>
            <Fact label="ATM IV" title="Mean of the ATM call and put implied volatility (Upstox's estimate). Read down the cards for the term structure.">
              {row.atmIv != null ? <Big>{row.atmIv.toFixed(1)}%</Big> : <NoData />}
            </Fact>
            <Fact label="PCR" title="Put open interest ÷ call open interest, all strikes of this expiry.">
              {row.pcr != null ? <Big>{row.pcr.toFixed(2)}</Big> : <NoData />}
            </Fact>
            <Fact label="Max pain" title="The strike where option buyers together would be paid least at expiry. An arithmetic fact about open interest, not a target.">
              {row.maxPain != null ? <Big>{grouped(row.maxPain)}</Big> : <NoData />}
            </Fact>
          </div>

          {scale && <RangeBar row={row} spot={spot} scale={scale} />}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 250px), 1fr))", gap: "8px 18px", fontSize: 13, color: C.textSoft }}>
            <Line label="Support · most put OI">{row.support.length ? row.support.map((w) => grouped(w.strike)).join(" · ") : NO_DATA}</Line>
            <Line label="Resistance · most call OI">{row.resistance.length ? row.resistance.map((w) => grouped(w.strike)).join(" · ") : NO_DATA}</Line>
            <Line label="OI change since yesterday">{oiChangeLine(row.oiChange) ?? NO_DATA}</Line>
          </div>
        </>
      )}

      <Events row={row} first={first} fresh={fresh} eventsKnown={eventsKnown} />
    </article>
  );
}

function RangeBar({ row, spot, scale }: { row: OutlookExpiry; spot: number | null; scale: { min: number; max: number } }) {
  if (!row.range) return null;
  const lo = scalePct(row.range.low, scale);
  const hi = scalePct(row.range.high, scale);
  const label = `Break-even range ${grouped(row.range.low)} to ${grouped(row.range.high)}${spot != null ? `; spot ${fmtNum(spot, 2)}` : ""}`;
  return (
    <div role="img" aria-label={label} title={label} style={{ position: "relative", height: 22, minWidth: 0 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 10, height: 2, borderRadius: 1, background: C.borderSoft }} />
      <div
        style={{
          position: "absolute",
          left: `${lo}%`,
          width: `${Math.max(hi - lo, 0.5)}%`,
          top: 4,
          height: 14,
          borderRadius: 4,
          background: alpha(C.goldBright, 0.25),
          border: `1px solid ${C.goldBright}`,
          boxSizing: "border-box",
        }}
      />
      {spot != null && <div style={{ position: "absolute", left: `calc(${scalePct(spot, scale)}% - 1px)`, top: 0, bottom: 0, width: 2, borderRadius: 1, background: C.textStrong }} />}
    </div>
  );
}

function Events({ row, first, fresh, eventsKnown }: { row: OutlookExpiry; first: boolean; fresh: OutlookEvent[]; eventsKnown: boolean }) {
  const label = first ? "Scheduled before expiry" : "Also before this expiry";
  let body: ReactNode;
  if (!eventsKnown) body = <span style={{ color: C.muted }}>{NO_DATA} (the engine&apos;s event calendar did not answer)</span>;
  else if (fresh.length > 0)
    body = (
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
        {fresh.map((e) => (
          <EventChip key={e.id} e={e} />
        ))}
      </span>
    );
  else body = <span style={{ color: C.muted }}>{row.events.length > 0 ? "nothing beyond the events above" : "no scheduled events"}</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 10px", fontSize: 13 }}>
      <span style={microLabel}>{label}</span>
      {body}
      {eventsKnown && !row.eventsComplete && <span style={{ fontSize: 12, color: C.muted2 }}>(the event calendar covers the next 30 days only)</span>}
    </div>
  );
}

function EventChip({ e }: { e: OutlookEvent }) {
  const impact = e.impact === "HIGH" ? "high impact" : e.impact === "MED" ? "medium impact" : "low impact";
  return (
    <span
      title={`${e.title} · ${impact}${e.approx ? " · date approximate" : ""}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 999, border: `1px solid ${C.border}`, background: C.panelAlt, fontSize: 12.5, color: C.textStrong, maxWidth: "100%" }}
    >
      <Dot color={impactColor(e.impact)} size={7} />
      <span style={{ overflowWrap: "anywhere" }}>{e.title}</span>
      <span className="tnum" style={{ color: C.muted, whiteSpace: "nowrap" }}>
        {fmtIstDateTime(e.at).replace(" IST", "")}
        {e.approx ? " (approx.)" : ""}
      </span>
    </span>
  );
}

function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div title={title} style={{ display: "grid", gap: 3, minWidth: 0, alignContent: "start" }}>
      <span style={microLabel}>{label}</span>
      {children}
    </div>
  );
}

function Big({ children }: { children: ReactNode }) {
  return (
    <span className="tnum" style={{ fontSize: 18, fontWeight: 650, color: C.textStrong, lineHeight: 1.2, overflowWrap: "anywhere" }}>
      {children}
    </span>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return (
    <span className="tnum" style={{ fontSize: 12, color: C.muted }}>
      {children}
    </span>
  );
}

function NoData() {
  return <span style={{ fontSize: 14, color: C.muted2 }}>{NO_DATA}</span>;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={microLabel}>{label}</span>
      <span className="tnum" style={{ color: C.textStrong, fontWeight: 550 }}>
        {children}
      </span>
    </div>
  );
}
