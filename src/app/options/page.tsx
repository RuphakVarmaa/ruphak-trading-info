import type { Metadata } from "next";
import OptionsDesk from "@/components/Options/OptionsDesk";
import { C } from "@/components/shared/colors";
import SiteHeader from "@/components/shared/SiteHeader";
import { CLAUDE_THEME } from "@/components/shared/theme";
import { getEngineModeQuick } from "@/lib/engine/snapshot";
import { isIsoDate } from "@/lib/ist";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Option chain — Ruphak India Index Desk",
  description: "Live NIFTY and SENSEX option chain: OI, LTP, IV and greeks per strike, PCR and max pain, with the engine's live reading highlighted.",
};

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?index=SENSEX` picks the index (default NIFTY); `?expiry=YYYY-MM-DD` an expiry (default the nearest). */
export default async function OptionsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const rawIndex = first(query.index)?.toUpperCase();
  const index = rawIndex === "SENSEX" ? "SENSEX" : "NIFTY";
  const rawExpiry = first(query.expiry);
  const expiry = rawExpiry && isIsoDate(rawExpiry) ? rawExpiry : null;
  const mode = await getEngineModeQuick();
  return (
    <div style={{ ...CLAUDE_THEME, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active="options" mode={mode} />
      <OptionsDesk initialIndex={index} initialExpiry={expiry} />
    </div>
  );
}
