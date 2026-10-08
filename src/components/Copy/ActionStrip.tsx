"use client";

/**
 * What to do now, per index, in large type: ENTER NOW with the exact order and a copy button, PAUSED
 * while the live price is stale, MANAGE, EXIT NOW, WAIT (the reason, and what would trigger an entry)
 * or DONE. One row per index on phones, side by side on wide screens.
 *
 * It needs only the EngineProvider and the live index feed: it fetches the account's copy tickets
 * itself (/api/engine/copy?date=…&account=…), so it can sit on the Desk as well as on /copy. It also
 * raises the status-change alerts (chime, vibration, desktop notification).
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { IndexId } from "@/engine/api-types";
import { alpha, C, pnlColor } from "@/components/shared/colors";
import { Skeleton } from "@/components/shared/ui";
import { hms, KIND_LABEL, shortAge, type IndexAction } from "@/lib/copy/action";
import { indexPrice, wholeRupees } from "@/lib/copy/prices";
import { fmtDateKey } from "@/components/shared/format";
import AlertsToggle from "./AlertsToggle";
import { useActionAlerts, useMissedTradeAlerts } from "./alerts";
import { ackExit } from "./clientStores";
import { CopyAction } from "./CopyButton";
import { plainError } from "./sharedPoll";
import { TONE_COLOR } from "./tone";
import { INDICES, useIndexActions, type CopyData } from "./useIndexActions";

const TICKETS_STALE_MS = 30_000;

/**
 * The order in groups that never break inside ("1 lot = 65 qty", "limit ≤ ₹145.35"): it wraps between
 * its " · " parts, and between the contract and its expiry. Selecting it copies the plain text.
 */
export function OrderText({ text, style }: { text: string; style?: CSSProperties }) {
  const parts = text.split(" · ");
  const groups: string[] = [];
  parts.forEach((part, i) => {
    const sep = i < parts.length - 1 ? " ·" : "";
    const m = i === 0 ? /^(.+) (\d{1,2}-[A-Z][a-z]{2})$/.exec(part) : null;
    if (m) groups.push(m[1], `${m[2]}${sep}`);
    else groups.push(`${part}${sep}`);
  });
  return (
    <div style={{ overflowWrap: "anywhere", userSelect: "all", ...style }}>
      {groups.map((g, i) => (
        <Fragment key={i}>
          <span style={{ display: "inline-block" }}>{g}</span>
          {i < groups.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </div>
  );
}

/** The live price line; orange when stale, red when offline (the feed contract's two levels). */
function livePriceLine(d: CopyData, index: IndexId): { text: string; color: string } {
  const q = d.live.data?.indices.find((i) => i.index === index) ?? null;
  const offline = d.live.freshness === "offline" || (d.live.freshness === "loading" && d.live.error != null);
  const fresh = d.live.freshness === "live" && d.live.data?.stale !== true;
  const color = offline ? C.red : fresh ? C.muted2 : C.orange;
  if (!q) {
    if (d.live.freshness === "loading" && d.live.error == null) return { text: `${index} live price loading…`, color: C.muted2 };
    return { text: `${index} live price unavailable`, color: offline ? C.red : C.orange };
  }
  const age = d.live.ageMs != null ? ` · ${shortAge(d.live.ageMs)} ago` : "";
  return { text: `${index} ${indexPrice(q.price)}${age}${fresh ? "" : d.hidden ? " (paused in the background)" : offline ? " (offline)" : " (stale)"}`, color };
}

function IndexRow({ index, a, d, compact }: { index: IndexId; a: IndexAction | null; d: CopyData; compact: boolean }) {
  if (!a) {
    return (
      <div style={{ display: "grid", gap: 10, padding: 16, borderRadius: 12, border: `1px solid ${C.border}` }}>
        <Skeleton width={90} height={14} />
        <Skeleton width="60%" height={compact ? 22 : 30} />
        <Skeleton height={14} />
      </div>
    );
  }
  const color = TONE_COLOR[a.tone];
  const label = KIND_LABEL[a.kind];
  const sub = a.kind === "LOADING" ? a.headline : a.headline.startsWith(label) ? a.headline.slice(label.length).replace(/^\s*—\s*/, "").trim() : null;
  const live = livePriceLine(d, index);
  const framed = a.tone === "action" || a.tone === "stale";
  const details = compact ? a.details.slice(0, 1) : a.details;
  const t = a.ticket;
  return (
    <article
      aria-label={`${index}: ${a.headline}`}
      style={{
        display: "grid",
        gap: compact ? 8 : 10,
        alignContent: "start",
        minWidth: 0,
        padding: compact ? "12px 14px" : "14px 16px 16px",
        borderRadius: 12,
        border: `1px solid ${framed ? alpha(color, 0.5) : C.border}`,
        borderLeft: `5px solid ${color}`,
        background: framed ? alpha(color, 0.05) : C.panel,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "2px 12px" }}>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", color: C.textSoft }}>{index}</span>
        <span className="tnum" style={{ fontSize: 12, color: live.color }}>
          {live.text}
        </span>
      </div>

      <div role="status" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", minWidth: 0 }}>
        {a.kind !== "LOADING" && <span style={{ fontSize: compact ? 22 : 30, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.01em", color }}>{label}</span>}
        {sub && <span style={{ fontSize: compact ? 15 : 18, fontWeight: 600, lineHeight: 1.3, color: a.kind === "LOADING" ? C.muted : color }}>{a.kind === "LOADING" ? sub : `— ${sub}`}</span>}
      </div>

      {a.order && a.kind === "PAUSED" && (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>Not yet: wait for a fresh price</span>
          <OrderText text={a.order} style={{ fontSize: compact ? 14 : 16, fontWeight: 600, color: C.muted }} />
        </div>
      )}
      {a.order && a.kind !== "PAUSED" && (
        <OrderText text={a.order} style={{ fontSize: a.kind === "MANAGE" ? (compact ? 14 : 16) : compact ? 16 : 20, fontWeight: a.kind === "MANAGE" ? 600 : 700, lineHeight: 1.35, color: C.textStrong }} />
      )}
      {a.order && (a.kind === "ENTER_NOW" || a.kind === "EXIT_NOW" || a.kind === "MANAGE") && (
        <CopyAction
          text={a.order}
          label={a.kind === "ENTER_NOW" ? "Copy order" : a.kind === "EXIT_NOW" ? "Copy sell order" : "Copy levels"}
          tone={a.kind === "MANAGE" ? "quiet" : "action"}
          style={{ width: "100%", maxWidth: compact ? 260 : 360, justifySelf: "start" }}
        />
      )}
      {a.kind === "EXIT_NOW" && t && d.date && (
        <button
          type="button"
          onClick={() => ackExit(d.account.id, d.date!, t.id)}
          style={{ minHeight: 44, maxWidth: compact ? 260 : 360, padding: "8px 16px", borderRadius: 10, border: `1px solid ${C.borderStrong}`, background: C.panel, color: C.textStrong, fontSize: 14, fontWeight: 600, cursor: "pointer", justifySelf: "start" }}
        >
          I&apos;ve sold it (or never bought it): clear
        </button>
      )}

      {details.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          {details.map((line, i) => (
            <p key={i} style={{ margin: 0, fontSize: i === 0 && !a.order ? (compact ? 15 : 17) : 13.5, fontWeight: i === 0 && !a.order ? 600 : 400, lineHeight: 1.45, color: i === 0 ? C.textSoft : C.muted }}>
              {line}
            </p>
          ))}
        </div>
      )}
      {a.pnl != null && (
        <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: pnlColor(a.pnl) }}>
          {a.kind === "EXIT_NOW" ? "This trade" : `Today on ${index}`}: {wholeRupees(a.pnl, true)} after charges
        </span>
      )}
      {a.trigger && !compact && (
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, color: C.textSoft }}>
          <b style={{ color: C.muted, fontWeight: 700 }}>What would trigger an entry: </b>
          {a.trigger}
        </p>
      )}
      {t && (
        <span style={{ fontSize: 12, color: C.muted2 }}>
          Engine paper trade {hms(t.entry.at)} IST · {t.entry.priceSource === "model" ? "model price" : "broker price"}
          {t.live?.markAt ? ` · mark at ${hms(t.live.markAt)}` : ""}
        </span>
      )}
    </article>
  );
}

/**
 * Both indices' statuses in large type, with the order to copy. `account`: default the EngineProvider's,
 * else main. `headerExtra`: optional controls for the header's right side (the copy page puts its
 * account switcher there).
 */
export default function IndexActionStrip({ account, compact = false, headerExtra }: { account?: string; compact?: boolean; headerExtra?: ReactNode }) {
  const d = useIndexActions(account);
  useActionAlerts(d.actions, d.account.id, d.settled);
  useMissedTradeAlerts(d.tickets.data, d.account.id, d.date, d.nowMs, d.settled);

  const ticketsStale = d.ticketsAgeMs != null && d.ticketsAgeMs > TICKETS_STALE_MS;
  const engineDown = plainError(d.tickets.error) ?? (d.engineStatus === "offline" ? "Can't reach the trading engine right now." : null);
  const lastTickets = d.tickets.at != null ? hms(d.tickets.at) : null;
  const liveSource = d.live.data?.source ?? "Yahoo Finance";
  const liveBad = d.live.data == null ? d.live.error != null : d.live.freshness !== "live" || d.live.data.stale === true;
  const liveText =
    d.live.data == null
      ? d.live.error != null
        ? "Live index: not coming through (retrying)"
        : "Live index: connecting…"
      : `Live index: ${liveSource}, updated ${d.live.ageMs != null ? `${shortAge(d.live.ageMs)} ago` : "—"}`;

  return (
    <section
      aria-label="What to do now"
      style={{ display: "grid", gap: compact ? 10 : 14, minWidth: 0, padding: compact ? 12 : 16, borderRadius: 14, background: C.panel, border: `1px solid ${C.border}`, boxShadow: "var(--shadow-card)" }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "6px 12px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.textStrong }}>What to do now</h2>
          <span style={{ fontSize: 13, color: C.muted }}>
            {d.date ? `${fmtDateKey(d.date)} · ` : ""}
            {d.account.label}
            {d.account.capitalRupees != null && !d.account.label.includes("₹") ? ` · ${wholeRupees(d.account.capitalRupees)}` : ""}
          </span>
        </div>
        {headerExtra}
      </div>

      {engineDown && (
        <p role="alert" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, color: C.orange, fontWeight: 600 }}>
          {engineDown} {lastTickets ? `These trades are from ${lastTickets} IST; it retries every few seconds.` : "It retries every few seconds."}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 400px), 1fr))", gap: 12 }}>
        {INDICES.map((index) => (
          <IndexRow key={index} index={index} a={d.actions?.[index] ?? null} d={d} compact={compact} />
        ))}
      </div>

      <div className="tnum" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 12, color: C.muted2, lineHeight: 1.5 }}>
        <AlertsToggle compact={compact} />
        <span style={{ color: ticketsStale ? C.orange : undefined }}>
          Trades: paper engine{d.ticketsAgeMs != null ? `, updated ${shortAge(d.ticketsAgeMs)} ago` : d.tickets.error ? ", not loaded" : ", loading…"}
        </span>
        <span style={{ color: liveBad ? (d.live.freshness === "offline" || d.live.data == null ? C.red : C.orange) : undefined }}>{liveText}</span>
      </div>
    </section>
  );
}
