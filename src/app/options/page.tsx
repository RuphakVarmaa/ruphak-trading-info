import type { Metadata } from "next";
import OptionsDesk from "@/components/Options/OptionsDesk";
import { C } from "@/components/shared/colors";
import SiteHeader from "@/components/shared/SiteHeader";
import { getEngineModeQuick } from "@/lib/engine/snapshot";
import { isIsoDate } from "@/lib/ist";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Options: build-up now and the month ahead — Ruphak India Index Desk",
  description:
    "NIFTY and SENSEX options: live OI and volume build-up, what option prices imply for each expiry in the next 30 days, and the live option chain. Read-only market data, not advice.",
};

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?index=SENSEX` picks the index (default NIFTY); `?expiry=YYYY-MM-DD` an expiry for the chain (default the nearest; opens the chain). */
export default async function OptionsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const rawIndex = first(query.index)?.toUpperCase();
  const index = rawIndex === "SENSEX" ? "SENSEX" : "NIFTY";
  const rawExpiry = first(query.expiry);
  const expiry = rawExpiry && isIsoDate(rawExpiry) ? rawExpiry : null;
  const mode = await getEngineModeQuick();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active="options" mode={mode} />
      <OptionsDesk initialIndex={index} initialExpiry={expiry} />
    </div>
  );
}
