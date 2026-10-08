"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { EngineMode } from "@/engine/api-types";
import { alpha, C } from "./colors";
import { SERIF } from "./theme";

/** Paper (blue) or Live (solid red, pulsing). The word always carries the meaning. */
export function ModeBadge({ mode, title }: { mode: EngineMode; title?: string }) {
  const live = mode === "LIVE";
  return (
    <span
      className={live ? "live-pulse" : undefined}
      title={title ?? (live ? "LIVE mode: real orders when armed and LIVE_TRADING is on" : "PAPER mode: every order is simulated")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 11px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: live ? "#fff" : C.blue,
        background: live ? C.red : alpha(C.blue, 0.08),
        border: `1px solid ${live ? C.red : alpha(C.blue, 0.3)}`,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: live ? "#fff" : C.blue }} />
      {live ? "Live" : "Paper"}
    </span>
  );
}

type Page = "desk" | "live" | "copy" | "backtest";

const NAV: { href: string; label: string; page: Page }[] = [
  { href: "/", label: "Desk", page: "desk" },
  { href: "/live", label: "Live P&L", page: "live" },
  { href: "/copy", label: "Copy trade", page: "copy" },
  { href: "/backtest", label: "Backtest", page: "backtest" },
];

export default function SiteHeader({
  active,
  mode,
  extra,
}: {
  active: Page | null;
  mode?: EngineMode | null;
  /** Page-specific status shown before the mode badge. */
  extra?: ReactNode;
}) {
  return (
    <header
      className="site-header"
      style={{
        borderBottom: `1px solid ${C.border}`,
        background: "rgba(250, 249, 245, 0.88)",
        backdropFilter: "saturate(1.4) blur(10px)",
        WebkitBackdropFilter: "saturate(1.4) blur(10px)",
        flexShrink: 0,
      }}
    >
      <div className="site-header-inner">
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "inherit", minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: C.gold,
              color: "#fff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: SERIF,
              fontSize: 19,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            R
          </span>
          <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em", color: C.textStrong, whiteSpace: "nowrap" }}>
            Ruphak <span style={{ color: C.muted }}>Trading Info</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="site-nav">
          {NAV.map((n) => {
            const on = active === n.page;
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={on ? undefined : "nav-tab"}
                style={{
                  fontSize: 14,
                  fontWeight: on ? 600 : 500,
                  color: on ? C.textStrong : C.muted,
                  textDecoration: "none",
                  padding: "7px 14px",
                  borderRadius: 10,
                  background: on ? C.panelDeep : "transparent",
                  whiteSpace: "nowrap",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
          {extra}
          {mode && <ModeBadge mode={mode} />}
          <a
            href="https://www.ruphak.me"
            target="_blank"
            rel="noopener noreferrer"
            className="lift hide-sm"
            style={{
              background: C.panel,
              color: C.textStrong,
              border: `1px solid ${C.borderStrong}`,
              padding: "6px 13px",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ruphak.me ↗
          </a>
        </div>
      </div>
    </header>
  );
}
