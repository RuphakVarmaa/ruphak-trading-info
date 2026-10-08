"use client";

import type { ReactNode } from "react";
import type { SessionPhase } from "@/engine/api-types";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { C, enginePhaseColor, phaseColor } from "@/components/shared/colors";
import { fmtAge, fmtDuration, fmtIstDay, fmtIstHm } from "@/components/shared/format";
import { fallbackNextOpen, fallbackPhase } from "@/components/shared/market";
import { ModeBadge } from "@/components/shared/SiteHeader";
import { Dot, PageHeader } from "@/components/shared/ui";

function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 12px",
        borderRadius: 999,
        background: C.panel,
        border: `1px solid ${C.border}`,
        fontSize: 12.5,
        color: C.textSoft,
        whiteSpace: "nowrap",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <Dot color={color} size={7} />
      {children}
    </span>
  );
}

/** Market open or closed, with the time to the next open or close. */
function MarketChip() {
  const { state } = useEngineState();
  const now = useNow();
  const phase: SessionPhase | null = state?.market.phase ?? (now != null ? fallbackPhase(now) : null);
  if (!phase) return <Chip color={C.muted3}>Market —</Chip>;
  const nextOpen = state?.market.nextOpenAt ? Date.parse(state.market.nextOpenAt) : now != null ? fallbackNextOpen(now) : null;
  const nextClose = state?.market.nextCloseAt ? Date.parse(state.market.nextCloseAt) : null;
  let text: string;
  if (phase === "OPEN") text = `Market open${nextClose && now != null ? ` · closes in ${fmtDuration(nextClose - now)}` : ""}`;
  else if (phase === "PRE_OPEN") text = "Pre-open";
  else if (phase === "HOLIDAY") text = `Holiday${state?.market.holidayName ? ` · ${state.market.holidayName}` : ""}`;
  else text = `Market closed${nextOpen && now != null && nextOpen > now ? ` · opens ${fmtIstDay(nextOpen)} ${fmtIstHm(nextOpen)} (in ${fmtDuration(nextOpen - now)})` : ""}`;
  return <Chip color={phaseColor(phase)}>{text}</Chip>;
}

/** The trading engine's loop: its phase, last tick and errors. */
function EngineChip() {
  const { state, status } = useEngineState();
  const now = useNow();
  const hb = state?.heartbeat;
  if (!hb) return <Chip color={status === "offline" ? C.red : C.muted3}>{status === "offline" ? "Engine unreachable" : "Engine connecting…"}</Chip>;
  const tick = hb.lastTickAt && now != null ? `tick ${fmtAge(Math.max(0, now - Date.parse(hb.lastTickAt)))} ago` : "no tick yet";
  const errors = hb.consecutiveErrors > 0 ? ` · ${hb.consecutiveErrors} errors` : "";
  return (
    <Chip color={hb.consecutiveErrors > 0 ? C.red : enginePhaseColor(hb.phase)} title={hb.lastError ?? (hb.version ? `Engine v${hb.version}` : undefined)}>
      Engine {hb.phase.toLowerCase()} · {tick}
      {errors}
    </Chip>
  );
}

const NAV: { href: string; label: string }[] = [
  { href: "#today", label: "Today" },
  { href: "#signals", label: "Signals" },
  { href: "#news", label: "News" },
  { href: "#controls", label: "Controls" },
  { href: "#book", label: "Orders" },
  { href: "#performance", label: "Performance" },
  { href: "#metals", label: "Metals & macro" },
];

/** Title, market and engine status, and links to the sections below. */
export default function DeskHeader() {
  const { state } = useEngineState();
  return (
    <PageHeader
      eyebrow={state ? fmtIstDay(state.market.nowIst) : "India Index Desk"}
      title="India Index Desk"
      sub="NIFTY 50 and SENSEX weekly options, traded on paper from the news and market signals, with every check explained."
      right={
        <>
          <MarketChip />
          <EngineChip />
          {state && <ModeBadge mode={state.mode} />}
        </>
      }
    >
      <nav aria-label="Sections" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className="lift"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: C.textSoft,
              textDecoration: "none",
              padding: "7px 14px",
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
