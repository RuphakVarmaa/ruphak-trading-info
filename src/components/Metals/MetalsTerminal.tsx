'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { IntelItem, CommodityPrice, ChokepointStatus, MapMarker } from '@/utils/api';
import IntelFeed from '@/components/Feed/IntelFeed';
import ChokepointMonitor from '@/components/Chokepoint/ChokepointMonitor';
import { getArrow, getPriceColor } from '@/components/shared/format';
import { useUtcTime } from '@/components/shared/UtcClock';

const IntelMap = dynamic(() => import('@/components/Map/IntelMap'), {
  ssr: false,
  loading: () => (
    <div style={{ height: '100%', width: '100%', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffb300', fontSize: 12 }}>
      Initializing Map Engine...
    </div>
  ),
});

function LiveClock() {
  const time = useUtcTime();
  return <span style={{ color: '#555', fontSize: 10, fontFamily: 'monospace' }}>⏱ {time} UTC</span>;
}

interface MetalsTerminalProps {
  intelItems: IntelItem[];
  prices: CommodityPrice[];
  chokepoints: ChokepointStatus[];
  mapMarkers: MapMarker[];
}

/** The original metals & macro terminal box (ticker bar, map + intel feed, status bar). */
export default function MetalsTerminal({ intelItems, prices, chokepoints, mapMarkers }: MetalsTerminalProps) {
  const [selectedChokepoint, setSelectedChokepoint] = useState<string>('HORMUZ');

  return (
    <div style={{ padding: '0 30px 30px' }}>
      <div style={{ width: '100%', maxWidth: 1400, margin: '0 auto', border: '1px solid #2a2a2a', borderRadius: 10, background: '#111', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 40px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
        {/* TICKER BAR */}
        <div style={{ height: 38, borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', fontSize: 11, fontFamily: 'monospace', background: '#0f0f0f', gap: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#4caf50', fontWeight: 700, fontSize: 10 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4caf50', display: 'inline-block' }} /> LIVE
            </span>
            <span style={{ color: '#666', fontSize: 10 }}>156 sources</span>
            <span style={{ color: '#f44336', fontSize: 10 }}>⚠ 6 high-risk mines</span>
          </div>
          <span style={{ color: '#ffb300', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', flexShrink: 0 }}>
            METALS & MACRO INTEL <span style={{ background: '#ffb300', color: '#000', fontSize: 8, padding: '1px 5px', borderRadius: 3, marginLeft: 4, fontWeight: 800 }}>BETA</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
            {prices.slice(0, 5).map(p => (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: '#555', fontSize: 9 }}>{p.name}</span>
                <span style={{ color: '#eee', fontWeight: 600, fontSize: 11 }}>
                  ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span style={{ color: getPriceColor(p.direction), fontSize: 9, fontWeight: 600 }}>
                  {getArrow(p.direction)}{Math.abs(p.changePercent).toFixed(2)}%
                </span>
              </div>
            ))}
            <LiveClock />
          </div>
        </div>

        {/* CORE GRID: Map + Intel Feed */}
        <div className="legacy-core" style={{ display: 'flex', height: 500, overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #222' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <IntelMap markers={mapMarkers} />
            </div>
            <div style={{ height: 105, borderTop: '1px solid #222' }}>
              <ChokepointMonitor chokepoints={chokepoints} selectedChokepoint={selectedChokepoint} onSelect={setSelectedChokepoint} />
            </div>
          </div>
          <div style={{ width: 380, flexShrink: 0, overflow: 'hidden' }}>
            <IntelFeed items={intelItems} />
          </div>
        </div>

        {/* STATUS BAR */}
        <div style={{ height: 28, borderTop: '1px solid #222', background: '#0d0d0d', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', fontSize: 9, color: '#555', fontFamily: 'monospace' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4caf50', display: 'inline-block' }} /> Intel Feed Active
            </span>
            <span>• {intelItems.length} reports • {mapMarkers.length} points</span>
            <span>• Focus: XAUUSD • XAGUSD • XCUUSD • WTIUSD • BRENTUSD</span>
          </div>
          <div>Risk Score: <span style={{ color: '#f44336', fontWeight: 700 }}>85/100</span></div>
        </div>
      </div>
    </div>
  );
}
