"use client";

import type { CSSProperties } from "react";
import type { AgentView } from "@/engine/api-types";
import AgentAccountNotice from "@/components/Agent/AgentAccountNotice";
import { useSharedPoll } from "@/components/Copy/sharedPoll";
import AccountSwitcher from "@/components/Live/AccountSwitcher";
import { alpha, C, phaseColor } from "@/components/shared/colors";
import { fallbackNextOpen, fallbackPhase } from "@/components/shared/market";
import { Dot } from "@/components/shared/ui";
import { useEngineState, useNow } from "@/hooks/useEngineState";
import { REFRESH_CLOSED_MS } from "@/lib/refresh";
import { isPractice, marketStatusText, safetyChips, type ChipTone, type SafetyChip } from "./engineView";
import { useTodayTickets } from "./useTodayTickets";

/** The agent's own view, read only while the page shows its account (its buying chip follows the agent's state). */
const AGENT_VIEW_URL = "/api/engine/agent";
/** The agent judges one candle every 5 minutes, so its state is read once a minute in the session. */
const AGENT_CHIP_POLL_MS = 60_000;

const TONE: Record<ChipTone, string> = { ok: C.green, info: C.blue, warn: C.orange, bad: C.red, mock: C.purple, muted: C.muted3 };

/** Demo data and anything that needs action now are solid, so they cannot be missed. */
const SOLID: ReadonlySet<ChipTone> = new Set<ChipTone>(["mock", "bad"]);

function Chip({ c }: { c: SafetyChip }) {
  const color = TONE[c.tone];
  const solid = SOLID.has(c.tone);
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "2px 7px",
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    lineHeight: 1.35,
    maxWidth: "100%",
    textDecoration: "none",
    color: solid ? "#fff" : C.textSoft,
    background: solid ? color : alpha(color, 0.07),
    border: `1px solid ${solid ? color : alpha(color, 0.35)}`,
  };
  const body = (
    <>
      {!solid && <Dot color={color} size={7} />}
      <strong style={{ fontWeight: 600, color: solid ? "#fff" : C.textStrong }}>{c.label}</strong>
      {c.detail && <span style={{ color: solid ? "rgba(255,255,255,0.9)" : C.muted }}>{c.detail}</span>}
      {c.href && (
        <span aria-hidden style={{ color: solid ? "#fff" : C.muted2 }}>
          ›
        </span>
      )}
    </>
  );
  const title = c.title ?? undefined;
  return c.href ? (
    <a href={c.href} title={title} className={solid ? undefined : "lift"} style={style}>
      {body}
    </a>
  ) : (
    <span title={title} style={style}>
      {body}
    </span>
  );
}

/** The market session in one pill (the engine's own clock and calendar; weekends only without it). */
export function MarketStatus() {
  const { state } = useEngineState();
  const now = useNow();
  const phase = state?.market.phase ?? (now != null ? fallbackPhase(now) : null);
  const nextOpen = state?.market.nextOpenAt ? Date.parse(state.market.nextOpenAt) : now != null ? fallbackNextOpen(now) : null;
  const nextClose = state?.market.nextCloseAt ? Date.parse(state.market.nextCloseAt) : null;
  const text = phase ? marketStatusText(phase, now, nextOpen, nextClose, state?.market.holidayName ?? null) : "Market status loading…";
  return (
    <span
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
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
      <Dot color={phase ? phaseColor(phase) : C.muted3} size={8} />
      {text}
    </span>
  );
}

/**
 * "Is it running and safe?" in one row: demo data, PAPER or LIVE, the kill switch, the engine's
 * heartbeat, whether new buys are paused, and the account switcher. Read-only: the controls are in
 * "Book, controls and health", which the chips that need action link to.
 */
export default function SafetyStrip({ account }: { account?: string }) {
  const { state, source, status, plan } = useEngineState();
  const now = useNow();
  const { poll, agent } = useTodayTickets(account);
  const practiceToday = (poll.data ?? []).filter(isPractice).length;
  const marketActive = state?.market.phase === "OPEN" || state?.market.phase === "PRE_OPEN";
  const agentView = useSharedPoll<AgentView>(agent ? AGENT_VIEW_URL : null, marketActive ? AGENT_CHIP_POLL_MS : REFRESH_CLOSED_MS);
  const chips = safetyChips({ state, source, status, plan, practiceToday, nowMs: now, agent: agent ? { view: agentView.data } : null });
  return (
    <div
      role="group"
      aria-label="Engine safety"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderRadius: 14,
        background: C.panel,
        border: `1px solid ${C.border}`,
        boxShadow: "var(--shadow-card)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, flex: "1 1 520px", minWidth: 0 }}>
        {chips.map((c) => (
          <Chip key={c.key} c={c} />
        ))}
      </div>
      <span style={{ marginLeft: "auto", display: "inline-flex", maxWidth: "100%", overflowX: "auto" }}>
        <AccountSwitcher basePath="/" />
      </span>
      {state?.account?.kind === "agent" && (
        <div style={{ flex: "1 1 100%", minWidth: 0 }}>
          <AgentAccountNotice label={state.account.label} />
        </div>
      )}
    </div>
  );
}
