"use client";

/**
 * The Geo intel world map (Leaflet; loaded with next/dynamic ssr:false by GeoIntelSection).
 * Marker colours are hex: Leaflet writes them as SVG attributes, where CSS variables do not work.
 */
import Link from "next/link";
import { useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { C } from "@/components/shared/colors";
import type { GeoLayer, GeoMarker } from "./geoView";

const LAYER_ORDER: Record<GeoLayer, number> = { chokepoint: 0, headline: 1, engine: 2 };

const LAYER_WORD: Record<GeoLayer, string> = {
  engine: "Engine-scored stories (drive the EVENT signal)",
  headline: "Geo headlines (context, not scored)",
  chokepoint: "Shipping chokepoint (news level, not vessel data)",
};

export default function GeoMap({ markers, visible }: { markers: GeoMarker[]; visible: ReadonlySet<GeoLayer> }) {
  // Client-only (never server-rendered): on a phone, start zoomed out far enough to show the whole world.
  const [zoom] = useState(() => (window.innerWidth < 640 ? 1 : 2));
  // Engine stories last, so they sit on top.
  const shown = markers.filter((m) => visible.has(m.layer)).sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
  return (
    <MapContainer center={[22, zoom < 2 ? 10 : 50]} zoom={zoom} minZoom={1} maxZoom={7} zoomSnap={0.5} worldCopyJump style={{ width: "100%", height: "100%", background: "var(--map-bg)" }} attributionControl>
      {/* Esri's light grey basemap: no API key, credited in the corner as Esri asks. */}
      <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri" maxZoom={16} />
      {shown.map((m) => (
        <CircleMarker
          key={m.id}
          center={[m.lat, m.lng]}
          radius={m.radius}
          pathOptions={{
            color: m.ring ? "#1f1e1d" : m.color,
            fillColor: m.color,
            fillOpacity: m.hollow ? 0.08 : m.layer === "engine" ? 0.75 : 0.5,
            weight: m.ring ? 2.5 : m.hollow ? 2 : 1,
            dashArray: m.hollow ? "4 3" : undefined,
          }}
        >
          <Popup maxWidth={300}>
            <div style={{ padding: 10, minWidth: 190, maxWidth: 280, fontSize: 12, color: C.textSoft }}>
              <div style={{ fontWeight: 700, color: C.textStrong, fontSize: 13 }}>{m.name}</div>
              <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{LAYER_WORD[m.layer]}</div>
              <div style={{ color: C.textDim, fontSize: 12, marginTop: 6 }}>{m.summary}</div>
              {m.items.map((it, i) => (
                <div key={i} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.borderSoft}` }}>
                  {it.href == null ? (
                    <div style={{ color: C.textStrong, lineHeight: 1.4 }}>{it.title}</div>
                  ) : it.external ? (
                    <a href={it.href} target="_blank" rel="noopener noreferrer" style={{ color: C.gold, lineHeight: 1.4, textDecoration: "none" }}>
                      {it.title} ↗
                    </a>
                  ) : (
                    <Link href={it.href} style={{ color: C.gold, lineHeight: 1.4, textDecoration: "none" }}>
                      {it.title} →
                    </Link>
                  )}
                  {it.meta && <div style={{ color: C.muted, fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>{it.meta}</div>}
                </div>
              ))}
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
