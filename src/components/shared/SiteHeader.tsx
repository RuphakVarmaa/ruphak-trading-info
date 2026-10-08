"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { EngineMode } from "@/engine/api-types";
import { alpha, C } from "./colors";

/** PAPER (blue outline) or LIVE (solid red, pulsing). The word always carries the meaning. */
export function ModeBadge({ mode, title }: { mode: EngineMode; title?: string }) {
  const live = mode === "LIVE";
  return (
    <span
      className={live ? "live-pulse" : undefined}
      title={title ?? (live ? "LIVE mode: real orders when armed and LIVE_TRADING is on" : "PAPER mode: every order is simulated")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.1em",
        fontFamily: "monospace",
        color: live ? "#fff" : C.blue,
        background: live ? C.red : alpha(C.blue, 0.12),
        border: `1px solid ${live ? C.red : alpha(C.blue, 0.6)}`,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{live ? "●" : "◌"}</span>
      {live ? "LIVE" : "PAPER"}
    </span>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: active ? C.textStrong : C.muted,
        textDecoration: "none",
        padding: "6px 10px",
        borderRadius: 4,
        background: active ? C.navActive : "transparent",
        borderBottom: `2px solid ${active ? C.gold : "transparent"}`,
      }}
    >
      {label}
    </Link>
  );
}

export default function SiteHeader({
  active,
  mode,
  extra,
}: {
  active: "desk" | "live" | "copy" | "backtest" | null;
  mode?: EngineMode | null;
  /** Page-specific status text shown before the mode badge (e.g. metals price source). */
  extra?: ReactNode;
}) {
  return (
    <header
      style={{
        minHeight: 56,
        borderBottom: `1px solid ${C.borderSoft}`,
        background: C.panelAlt,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "8px 16px",
        padding: "8px 24px",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "inherit" }}>
          <div style={{ display: "flex", gap: 3 }} aria-hidden>
            <div style={{ width: 4, height: 24, background: C.gold, borderRadius: 2 }} />
            <div style={{ width: 4, height: 24, background: C.gold, borderRadius: 2, opacity: 0.5 }} />
            <div style={{ width: 4, height: 24, background: C.gold, borderRadius: 2 }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "0.03em", lineHeight: 1.1 }}>
              <span style={{ color: C.textStrong }}>RUPHAK</span> <span style={{ color: C.gold }}>TRADING INFO</span>
            </h1>
            <p style={{ margin: 0, fontSize: 8, color: C.muted3, textTransform: "uppercase", letterSpacing: "0.15em" }}>
              India Index Desk · Geopolitical Intelligence
            </p>
          </div>
        </Link>
        <nav aria-label="Primary" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <NavLink href="/" label="DESK" active={active === "desk"} />
          <NavLink href="/live" label="LIVE P&L" active={active === "live"} />
          <NavLink href="/copy" label="COPY TRADE" active={active === "copy"} />
          <NavLink href="/backtest" label="BACKTEST" active={active === "backtest"} />
        </nav>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        {extra}
        {mode && <ModeBadge mode={mode} />}
        <a
          href="https://www.ruphak.me"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            background: C.gold,
            color: "#000",
            border: "none",
            padding: "8px 20px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.03em",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Visit ruphak.me →
        </a>
      </div>
    </header>
  );
}
