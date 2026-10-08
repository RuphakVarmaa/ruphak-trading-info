import type { Metadata } from "next";
import LiveBook from "@/components/Live/LiveBook";
import SiteHeader from "@/components/shared/SiteHeader";
import { EngineProvider } from "@/hooks/useEngineState";
import { getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live P&L — Ruphak India Index Desk",
  description: "Today's paper-trading P&L, open NIFTY option positions, and whether the market and option-price feeds are coming through.",
};

export default async function LivePage() {
  const initial = await getInitialEngineSnapshot();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0a0a0a", color: "#ededed", fontFamily: "var(--font-inter), 'Inter', sans-serif" }}>
      <SiteHeader active="live" mode={initial?.state?.mode ?? null} />
      <EngineProvider initial={initial}>
        <LiveBook />
      </EngineProvider>
    </div>
  );
}
