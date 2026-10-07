import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { EventClusterDetail } from "@/engine/api-types";
import EventDetailView, { BackToDesk } from "@/components/Events/EventDetailView";
import SiteHeader from "@/components/shared/SiteHeader";
import { getEngineModeQuick } from "@/lib/engine/snapshot";
import { getEngineApi } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

type Loaded =
  | { kind: "ok"; detail: EventClusterDetail; source: "engine" | "mock" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Deduplicated per request (generateMetadata and the page both need it). */
const loadEvent = cache(async (clusterId: string): Promise<Loaded> => {
  if (!ID_PATTERN.test(clusterId)) return { kind: "missing" };
  try {
    const { api, source } = await getEngineApi();
    const detail = await api.getEventDetail(clusterId);
    return detail ? { kind: "ok", detail, source } : { kind: "missing" };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
});

type Props = { params: Promise<{ clusterId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clusterId } = await params;
  const loaded = await loadEvent(clusterId);
  return {
    title: loaded.kind === "ok" ? `${loaded.detail.title} — India Index Desk` : "Event — India Index Desk",
    description: loaded.kind === "ok" ? loaded.detail.summary : "Event cluster detail",
  };
}

export default async function EventPage({ params }: Props) {
  const { clusterId } = await params;
  const [loaded, mode] = await Promise.all([loadEvent(clusterId), getEngineModeQuick()]);
  if (loaded.kind === "missing") notFound();

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0a0a0a", color: "#ededed", fontFamily: "var(--font-inter), 'Inter', sans-serif" }}>
      <SiteHeader active={null} mode={mode} />
      {loaded.kind === "ok" ? (
        <EventDetailView detail={loaded.detail} source={loaded.source} />
      ) : (
        <main style={{ flex: 1, padding: "40px 30px" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <BackToDesk />
            <div role="alert" style={{ border: "1px solid rgba(244,67,54,0.4)", background: "rgba(244,67,54,0.08)", borderRadius: 8, padding: "16px 18px" }}>
              <div style={{ color: "#f44336", fontWeight: 800, fontSize: 11, letterSpacing: "0.08em", marginBottom: 6 }}>✗ ENGINE UNREACHABLE</div>
              <div style={{ fontSize: 13, color: "#ccc" }}>
                Could not load event <code>{clusterId}</code> right now. Try again in a moment.
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
