import type { Metadata } from "next";
import GeoIntelSection from "@/components/Geo/GeoIntelSection";
import { C } from "@/components/shared/colors";
import SiteFooter from "@/components/shared/SiteFooter";
import SiteHeader from "@/components/shared/SiteHeader";
import { EngineProvider } from "@/hooks/useEngineState";
import { getEngineModeQuick, getInitialEngineSnapshot } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Geo intel — Ruphak India Index Desk",
  description: "World events and market-moving news on a map, and whether the engine's news signal makes a NIFTY or SENSEX trade possible right now.",
};

export default async function GeoPage() {
  const [initial, mode] = await Promise.all([getInitialEngineSnapshot(), getEngineModeQuick()]);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <EngineProvider initial={initial}>
        <SiteHeader active="geo" mode={initial?.state?.mode ?? mode} />
        <main style={{ width: "100%", maxWidth: 1240, margin: "0 auto", padding: "32px 16px 64px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 40, boxSizing: "border-box", flex: 1 }}>
          <GeoIntelSection />
        </main>
        <SiteFooter />
      </EngineProvider>
    </div>
  );
}
