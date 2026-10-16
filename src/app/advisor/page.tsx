import type { Metadata } from "next";
import type { AdvisorView } from "@/engine/api-types";
import AdvisorDesk from "@/components/Advisor/AdvisorDesk";
import { C } from "@/components/shared/colors";
import SiteFooter from "@/components/shared/SiteFooter";
import SiteHeader from "@/components/shared/SiteHeader";
import { getEngineApi, type EngineSource } from "@/lib/engine/server";
import { getEngineModeQuick } from "@/lib/engine/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Advisor — Ruphak India Index Desk",
  description:
    "Everything the site knows, in plain English: where NIFTY and SENSEX may go, which option (if any) is worth buying, and why. Written by Claude Opus 5.5 when you press Analyze. Not investment advice.",
};

const INITIAL_TIMEOUT_MS = 2000;

/** The advisor view for the first paint, or null when the engine does not answer within 2 s (the client then fetches it). */
async function initialAdvisor(): Promise<{ view: AdvisorView; source: EngineSource } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), INITIAL_TIMEOUT_MS);
  });
  try {
    const read = (async () => {
      const { api, source } = await getEngineApi();
      // Engine RPC calls return thenables: adopt them as real Promises.
      const view = await Promise.resolve(api.getAdvisor());
      return { view, source };
    })().catch(() => null);
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function AdvisorPage() {
  const [initial, mode] = await Promise.all([initialAdvisor(), getEngineModeQuick()]);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active="advisor" mode={mode} />
      <AdvisorDesk initial={initial?.view ?? null} initialSource={initial?.source ?? null} />
      <SiteFooter />
    </div>
  );
}
