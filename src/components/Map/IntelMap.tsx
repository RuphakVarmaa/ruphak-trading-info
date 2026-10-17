'use client';

import { useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { MapMarker } from '@/utils/api';
import { alpha, C } from '@/components/shared/colors';
import 'leaflet/dist/leaflet.css';

// ---- Map Layer Controls ----

type LayerId = MapMarker['type'];

interface MapLayerToggle {
  id: LayerId;
  label: string;
  enabled: boolean;
}

const MARKER_COLORS: Record<string, string> = {
  mining: '#b8860b',
  conflict: '#c2412d',
  energy: '#d9622b',
  shipping: '#2f6db5',
  critical: '#c2412d',
  warning: '#b5650d',
  ok: '#2f7d4f',
};

function MapLayerPanel({ layers, counts, onToggle }: { layers: MapLayerToggle[]; counts: Partial<Record<LayerId, number>>; onToggle: (id: LayerId) => void }) {
  // Rendered in the browser only (no SSR): on phones the panel starts folded so it doesn't hide the map.
  const [expanded, setExpanded] = useState(() => window.innerWidth > 700);
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        zIndex: 1000,
        background: 'rgba(255,255,255,0.94)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: expanded ? '10px 12px' : '8px 12px',
        minWidth: expanded ? 170 : 40,
        boxShadow: 'var(--shadow-card)',
        color: C.textStrong,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%', fontSize: 13, fontWeight: 600, marginBottom: expanded ? 8 : 0 }}
      >
        Layers {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {layers.map((layer) => (
            <label key={layer.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '3px 2px', fontSize: 12, color: layer.enabled ? C.textSoft : C.muted3 }}>
              <input type="checkbox" checked={layer.enabled} onChange={() => onToggle(layer.id)} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MARKER_COLORS[layer.id] ?? C.muted, display: 'inline-block' }} />
              {layer.label}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: C.muted3, fontFamily: 'var(--font-num)' }}>{counts[layer.id] ?? 0}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<LayerId, string> = {
  mining: 'Mining',
  shipping: 'Shipping',
  conflict: 'Conflict',
  chokepoint: 'Shipping chokepoint · colour = how much it is in the news',
  energy: 'Energy',
};

// ---- Marker Color Logic ----
function getMarkerColor(marker: MapMarker): string {
  if (marker.type === 'chokepoint') return MARKER_COLORS[marker.severity === 'critical' ? 'critical' : marker.severity === 'warning' ? 'warning' : 'ok'];
  return MARKER_COLORS[marker.type] ?? '#8a8981';
}

function getMarkerRadius(marker: MapMarker): number {
  if (marker.severity === 'critical') return 8;
  if (marker.severity === 'warning') return 6;
  return 5;
}

// ---- Main Map Component ----

interface IntelMapProps {
  markers: MapMarker[];
}

export default function IntelMap({ markers }: IntelMapProps) {
  const [layers, setLayers] = useState<MapLayerToggle[]>([
    { id: 'mining', label: 'Mining', enabled: true },
    { id: 'shipping', label: 'Shipping', enabled: true },
    { id: 'conflict', label: 'Conflict', enabled: true },
    { id: 'chokepoint', label: 'Chokepoints', enabled: true },
    { id: 'energy', label: 'Energy', enabled: true },
  ]);
  const counts: Partial<Record<LayerId, number>> = {};
  for (const m of markers) counts[m.type] = (counts[m.type] ?? 0) + 1;

  const toggleLayer = (id: LayerId) => setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)));
  const enabledTypes = new Set(layers.filter((l) => l.enabled).map((l) => l.id));
  const visibleMarkers = markers.filter((m) => enabledTypes.has(m.type));

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <MapContainer center={[20, 30]} zoom={2.5} minZoom={2} maxZoom={7} style={{ width: '100%', height: '100%', background: 'var(--map-bg)' }} zoomControl={false} attributionControl>
        {/* Esri's light grey basemap: no API key, credited in the corner as Esri asks. */}
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          attribution="Tiles &copy; Esri"
          maxZoom={16}
        />
        {visibleMarkers.map((marker) => (
          <CircleMarker
            key={marker.id}
            center={[marker.lat, marker.lng]}
            radius={getMarkerRadius(marker)}
            pathOptions={{
              color: getMarkerColor(marker),
              fillColor: getMarkerColor(marker),
              fillOpacity: 0.55,
              weight: marker.severity === 'critical' ? 2 : 1,
            }}
          >
            <Popup>
              <div style={{ padding: 10, minWidth: 170, fontSize: 12, color: C.textSoft }}>
                <div style={{ fontWeight: 700, marginBottom: 4, color: getMarkerColor(marker) }}>{marker.name}</div>
                <div style={{ color: C.muted, fontSize: 11 }}>{TYPE_LABEL[marker.type]}</div>
                {marker.label && <div style={{ marginTop: 6, color: C.textDim, fontSize: 12, lineHeight: 1.45 }}>{marker.label}</div>}
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      <MapLayerPanel layers={layers} counts={counts} onToggle={toggleLayer} />
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 1000,
          fontSize: 11,
          color: C.muted,
          background: alpha('#ffffff', 0.9),
          border: `1px solid ${C.border}`,
          borderRadius: 999,
          padding: '4px 10px',
        }}
      >
        {visibleMarkers.length} of {markers.length} points
      </div>
    </div>
  );
}
