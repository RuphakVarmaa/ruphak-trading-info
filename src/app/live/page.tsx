import type { Metadata } from "next";
import LiveBook from "@/components/Live/LiveBook";
import LiveHeader from "@/components/Live/LiveHeader";
import { C } from "@/components/shared/colors";
import { CLAUDE_THEME } from "@/components/shared/theme";
import { EngineProvider } from "@/hooks/useEngineState";
import { getEngineModeQuick, getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live P&L — Ruphak India Index Desk",
  description: "Today's paper-trading P&L, open NIFTY option positions, and whether the market and option-price feeds are coming through.",
};

export default async function LivePage() {
  const [initial, mode] = await Promise.all([getInitialEngineSnapshot(), getEngineModeQuick()]);
  return (
    <div style={{ ...CLAUDE_THEME, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "var(--font-inter), 'Inter', sans-serif" }}>
      <EngineProvider initial={initial}>
        <LiveHeader serverMode={initial?.state?.mode ?? mode} />
        <LiveBook />
      </EngineProvider>
    </div>
  );
}
