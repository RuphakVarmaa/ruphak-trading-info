"use client";

import Link from "next/link";
import { C } from "@/components/shared/colors";
import { useEngineState } from "@/hooks/useEngineState";

const fmtCapital = (rupees: number) => (rupees >= 100_000 ? `₹${(rupees / 100_000).toFixed(rupees % 100_000 === 0 ? 0 : 1)}L` : `₹${Math.round(rupees / 1000)}k`);

/** Switches the Live page between paper accounts. Hidden when the engine runs only main (or in mock mode). */
export default function AccountSwitcher() {
  const { state } = useEngineState();
  const accounts = state?.accounts ?? [];
  if (accounts.length < 2) return null;
  const current = state?.account?.id ?? "main";
  return (
    <nav aria-label="Paper account" style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      {accounts.map((a) => {
        const active = a.id === current;
        return (
          <Link
            key={a.id}
            href={a.id === "main" ? "/live" : `/live?account=${encodeURIComponent(a.id)}`}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              textDecoration: "none",
              color: active ? C.textStrong : C.muted,
              background: active ? C.panelAlt : "transparent",
              borderLeft: a.id === accounts[0].id ? "none" : `1px solid ${C.border}`,
            }}
          >
            {a.shortLabel} · {fmtCapital(a.capitalRupees)}
          </Link>
        );
      })}
    </nav>
  );
}
