"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** Every page with a header. The three sections are the primary tabs; the rest sit in "More". */
export type Page = "engine" | "options" | "geo" | "live" | "copy" | "backtest" | "metals" | "learn";

const NAV: { href: string; label: string; pages: readonly Page[] }[] = [
  { href: "/", label: "Paper Engine", pages: ["engine", "live", "copy"] },
  { href: "/options", label: "Options", pages: ["options"] },
  { href: "/geo", label: "Geo Intel", pages: ["geo"] },
];

const MORE: { href: string; label: string; note: string; page: Page }[] = [
  { href: "/live", label: "Live P&L", note: "Full paper book per account", page: "live" },
  { href: "/copy", label: "Copy trades", note: "Each paper trade, ready to repeat by hand", page: "copy" },
  { href: "/backtest", label: "Backtest", note: "Run the strategy over past sessions", page: "backtest" },
  { href: "/metals", label: "Metals", note: "Metals, oil and shipping terminal", page: "metals" },
  { href: "/learn", label: "Learn", note: "Options buying, in plain words", page: "learn" },
];

const MORE_PAGES: readonly Page[] = ["backtest", "metals", "learn"];

/** The "More" menu: outside .site-nav (which scrolls sideways on phones and would clip it). */
function MoreMenu({ active }: { active: Page | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const on = active !== null && MORE_PAGES.includes(active);
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={on ? undefined : "nav-tab"}
        style={{
          all: "unset",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: on ? 600 : 500,
          color: on ? C.textStrong : C.muted,
          padding: "7px 12px",
          borderRadius: 10,
          background: on ? C.panelDeep : "transparent",
          whiteSpace: "nowrap",
        }}
      >
        More {open ? "▴" : "▾"}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 2000,
            width: 260,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            boxShadow: "var(--shadow-card)",
            padding: 6,
          }}
        >
          {MORE.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              aria-current={active === m.page ? "page" : undefined}
              className="nav-tab"
              style={{ display: "block", padding: "8px 10px", borderRadius: 8, textDecoration: "none", background: active === m.page ? C.panelDeep : "transparent" }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong }}>{m.label}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>{m.note}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SiteHeader({
  active,
  mode,
  extra,
}: {
  active: Page | null;
  mode?: EngineMode | null;
  /** Page-specific status shown before the mode badge. The PAPER/LIVE badge belongs here only, once per page. */
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
            const on = active !== null && n.pages.includes(active);
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
        <MoreMenu active={active} />

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
