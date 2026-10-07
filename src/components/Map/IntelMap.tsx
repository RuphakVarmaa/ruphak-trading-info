'use client';

import { useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { MapMarker } from '@/utils/api';
import 'leaflet/dist/leaflet.css';

// ---- Map Layer Controls ----

interface MapLayerToggle {
  id: string;
  label: string;
  icon: string;
  count?: number;
  enabled: boolean;
}

function MapLayerPanel({
  layers,
  onToggle,
}: {
  layers: MapLayerToggle[];
  onToggle: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        zIndex: 1000,
        background: 'rgba(17,17,17,0.92)',
        backdropFilter: 'blur(12px)',
        border: '1px solid #333',
        borderRadius: 8,
        padding: expanded ? '12px 14px' : '8px 12px',
        minWidth: expanded ? 180 : 40,
        transition: 'all 0.2s ease',
        color: '#fff',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          marginBottom: expanded ? 10 : 0,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Map Layers
        </span>
        <span style={{ fontSize: 9, color: '#f44336', fontWeight: 700, letterSpacing: '0.05em', background: 'rgba(244,67,54,0.15)', padding: '2px 6px', borderRadius: 3 }}>
          ALERT
        </span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {layers.map((layer) => (
            <div
              key={layer.id}
              onClick={() => onToggle(layer.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: 4,
                background: layer.enabled ? 'rgba(255,179,0,0.08)' : 'transparent',
                transition: 'background 0.15s',
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  border: layer.enabled ? '2px solid #ffb300' : '2px solid #555',
                  background: layer.enabled ? '#ffb300' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  transition: 'all 0.15s',
                }}
              >
                {layer.enabled && '✓'}
              </div>
              <span style={{ fontSize: 11, color: layer.enabled ? '#ddd' : '#777' }}>
                {layer.icon} {layer.label}
              </span>
              {layer.count !== undefined && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 9,
                    background: 'rgba(244,67,54,0.2)',
                    color: '#f44336',
                    padding: '1px 5px',
                    borderRadius: 10,
                    fontWeight: 700,
                  }}
                >
                  {layer.count}
                </span>
              )}
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 9, color: '#555', borderTop: '1px solid #222', paddingTop: 6 }}>
            Click layers to toggle
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Legend ----
function MapLegend() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 1000,
        display: 'flex',
        gap: 14,
        fontSize: 10,
        color: '#888',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffb300', display: 'inline-block' }} /> Gold
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#c0c0c0', display: 'inline-block' }} /> Silver
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e87940', display: 'inline-block' }} /> Copper
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4caf50', display: 'inline-block' }} /> Chokepoint
      </span>
    </div>
  );
}

// ---- Marker Color Logic ----
function getMarkerColor(marker: MapMarker): string {
  if (marker.type === 'chokepoint') {
    if (marker.severity === 'critical') return '#f44336';
    if (marker.severity === 'warning') return '#ff9800';
    return '#4caf50';
  }
  if (marker.type === 'mining') return '#ffb300';
  if (marker.type === 'conflict') return '#f44336';
  if (marker.type === 'energy') return '#e87940';
  if (marker.type === 'shipping') return '#2196f3';
  return '#888';
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
    { id: 'mining', label: 'Mining Operations', icon: '⛏️', count: 24, enabled: true },
    { id: 'shipping', label: 'Shipping Lanes', icon: '🚢', enabled: true },
    { id: 'conflict', label: 'Seismic Activity', icon: '📊', count: 14, enabled: true },
    { id: 'chokepoint', label: 'Military Flights', icon: '✈️', enabled: true },
    { id: 'energy', label: 'Energy Infrastructure', icon: '⚡', enabled: true },
  ]);

  const toggleLayer = (id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l))
    );
  };

  const enabledTypes = new Set(layers.filter((l) => l.enabled).map((l) => l.id));
  const visibleMarkers = markers.filter((m) => enabledTypes.has(m.type));

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Map Header */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 32,
          zIndex: 999,
          background: 'rgba(17,17,17,0.85)',
          borderBottom: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 14px',
          fontSize: 10,
          color: '#888',
          letterSpacing: '0.04em',
        }}
      >
        <span>
          <span style={{ color: '#4caf50', fontWeight: 700 }}>●</span> GLOBAL INTEL MAP •{' '}
          <span style={{ color: '#aaa' }}>{markers.length} points tracked</span>
        </span>
      </div>

      {/* Leaflet Map */}
      <MapContainer
        center={[20, 30]}
        zoom={2.5}
        minZoom={2}
        maxZoom={6}
        style={{ width: '100%', height: '100%', background: '#0d0d0d' }}
        zoomControl={false}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        {visibleMarkers.map((marker) => (
          <CircleMarker
            key={marker.id}
            center={[marker.lat, marker.lng]}
            radius={getMarkerRadius(marker)}
            pathOptions={{
              color: getMarkerColor(marker),
              fillColor: getMarkerColor(marker),
              fillOpacity: 0.6,
              weight: marker.severity === 'critical' ? 2 : 1,
            }}
          >
            <Popup>
              <div style={{ background: '#111', color: '#ddd', padding: 8, borderRadius: 6, minWidth: 160, fontSize: 11 }}>
                <div style={{ fontWeight: 700, marginBottom: 4, color: getMarkerColor(marker) }}>{marker.name}</div>
                <div style={{ color: '#888', fontSize: 10 }}>{marker.type.toUpperCase()} • {marker.severity.toUpperCase()}</div>
                {marker.label && <div style={{ marginTop: 6, color: '#aaa', fontSize: 10 }}>{marker.label}</div>}
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>

      {/* Floating Panels */}
      <MapLayerPanel layers={layers} onToggle={toggleLayer} />
      <MapLegend />
    </div>
  );
}
