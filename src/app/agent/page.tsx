import type { Metadata } from "next";
import type { AgentView } from "@/engine/api-types";
import AgentDesk from "@/components/Agent/AgentDesk";
import { C } from "@/components/shared/colors";
import SiteFooter from "@/components/shared/SiteFooter";
import SiteHeader from "@/components/shared/SiteHeader";
import { getEngineApi, type EngineSource } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent — Ruphak India Index Desk",
  description:
    "A paper experiment: a fast model judges each 5-minute NIFTY and SENSEX candle and code decides every trade, on a separate ₹5L paper account. Its decisions, the code's checks, the risk limits, calibration and the nightly review. Not investment advice.",
};

const INITIAL_TIMEOUT_MS = 2000;

/** The agent view for the first paint, or null when the engine does not answer within 2 s (the client then fetches it). */
async function initialAgent(): Promise<{ view: AgentView; source: EngineSource } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), INITIAL_TIMEOUT_MS);
  });
  try {
    const read = (async () => {
      const { api, source } = await getEngineApi();
      // Engine RPC calls return thenables: adopt them as real Promises.
      const view = await Promise.resolve(api.getAgent());
      return { view, source };
    })().catch(() => null);
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function AgentPage() {
  const initial = await initialAgent();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      {/* The agent's account is paper only, whatever mode main runs in. */}
      <SiteHeader active="agent" mode="PAPER" />
      <AgentDesk initial={initial?.view ?? null} initialSource={initial?.source ?? null} />
      <SiteFooter />
    </div>
  );
}
