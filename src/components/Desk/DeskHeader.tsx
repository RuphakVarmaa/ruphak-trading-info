"use client";

import type { SessionPhase } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, phaseColor } from "@/components/shared/colors";
import { fmtAge, fmtDuration, fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { fallbackNextOpen, fallbackPhase } from "@/components/shared/market";
import { Dot, PageHeader } from "@/components/shared/ui";

function marketText(phase: SessionPhase, now: number | null, nextOpen: number | null, nextClose: number | null, holiday: string | null): string {
  if (phase === "OPEN") return `Market open${nextClose && now != null ? ` · closes in ${fmtDuration(nextClose - now)}` : ""}`;
  if (phase === "PRE_OPEN") return "Pre-open session";
  if (phase === "HOLIDAY") return `Market holiday${holiday ? ` · ${holiday}` : ""}`;
  return `Market closed${nextOpen && now != null && nextOpen > now ? ` · opens ${fmtIstDay(nextOpen)} ${fmtIstHm(nextOpen)} IST` : ""}`;
}

/**
 * One status line for the page: the market session, plus the engine only when something is wrong
 * (not answering, errors, kill switch, a late tick). Full engine and data health is under Operations.
 */
function StatusChip() {
  const { state, status } = useEngineState();
  const now = useNow();
  const phase: SessionPhase | null = state?.market.phase ?? (now != null ? fallbackPhase(now) : null);
  const nextOpen = state?.market.nextOpenAt ? Date.parse(state.market.nextOpenAt) : now != null ? fallbackNextOpen(now) : null;
  const nextClose = state?.market.nextCloseAt ? Date.parse(state.market.nextCloseAt) : null;
  const hb = state?.heartbeat;

  let engine: { text: string; color: string } | null = null;
  if (status === "offline") engine = { text: "engine not answering", color: C.red };
  else if (status === "stale") engine = { text: "data out of date", color: C.orange };
  else if (hb?.phase === "KILLED" || state?.killSwitch) engine = { text: "kill switch on", color: C.red };
  else if (hb && hb.consecutiveErrors > 0) engine = { text: `engine errors (${hb.consecutiveErrors} in a row)`, color: C.red };
  else if (hb?.phase === "DEGRADED") engine = { text: "engine degraded", color: C.orange };
  else if (hb?.lastTickAt && now != null && (phase === "OPEN" || phase === "PRE_OPEN")) {
    const age = now - Date.parse(hb.lastTickAt);
    if (age > 3 * hb.loopIntervalSec * 1000) engine = { text: `engine last ran ${fmtAge(age)} ago`, color: C.orange };
  }

  const text = phase ? marketText(phase, now, nextOpen, nextClose, state?.market.holidayName ?? null) : "Market status loading…";
  const dot = engine?.color ?? (phase ? phaseColor(phase) : C.muted3);
  return (
    <span
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "4px 8px",
        padding: "7px 13px",
        borderRadius: 999,
        background: C.panel,
        border: `1px solid ${C.border}`,
        fontSize: 13,
        color: C.textSoft,
        boxShadow: "var(--shadow-card)",
        maxWidth: "100%",
      }}
    >
      <Dot color={dot} size={8} />
      <span>{text}</span>
      {engine && <span style={{ color: engine.color }}>· {engine.text}</span>}
    </span>
  );
}

const NAV: { href: string; label: string }[] = [
  { href: "#today", label: "Today" },
  { href: "#signals", label: "Signals" },
  { href: "#news", label: "News" },
  { href: "#catalysts", label: "Upcoming" },
  { href: "#book", label: "Orders" },
  { href: "#operations", label: "Operations" },
];

/** Title, the market's status, and links to the sections below. */
export default function DeskHeader() {
  const { state } = useEngineState();
  return (
    <PageHeader
      eyebrow={state ? fmtIstDay(state.market.nowIst) : "India Index Desk"}
      title="India Index Desk"
      sub="NIFTY 50 and SENSEX weekly options, traded on paper from the news and market signals, with every check explained."
      right={<StatusChip />}
    >
      <nav aria-label="Sections" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className="lift"
            style={{
              fontSize: 13,
              color: C.textSoft,
              textDecoration: "none",
              padding: "6px 13px",
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: C.panel,
              whiteSpace: "nowrap",
            }}
          >
            {n.label}
          </a>
        ))}
      </nav>
    </PageHeader>
  );
}
