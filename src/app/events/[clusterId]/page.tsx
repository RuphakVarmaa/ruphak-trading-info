import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { EventClusterDetail } from "@/engine/api-types";
import EventDetailView, { BackToDesk } from "@/components/Events/EventDetailView";
import SiteHeader from "@/components/shared/SiteHeader";
import { alpha, C } from "@/components/shared/colors";
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
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text }}>
      <SiteHeader active={null} mode={mode} />
      {loaded.kind === "ok" ? (
        <EventDetailView detail={loaded.detail} source={loaded.source} />
      ) : (
        <main style={{ flex: 1, padding: "40px 30px" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <BackToDesk />
            <div role="alert" style={{ border: `1px solid ${alpha(C.red, 0.35)}`, background: alpha(C.red, 0.06), borderRadius: 14, padding: "16px 18px" }}>
              <div style={{ color: C.red, fontWeight: 600, fontSize: 15, marginBottom: 6 }}>✗ This event could not be loaded</div>
              <div style={{ fontSize: 14, color: C.textSoft }}>The engine did not answer. Reload the page in a moment.</div>
              <details style={{ marginTop: 8, fontSize: 12.5, color: C.muted }}>
                <summary style={{ cursor: "pointer" }}>Details</summary>
                <div style={{ marginTop: 6, overflowWrap: "anywhere" }}>Event ID {clusterId}</div>
              </details>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
