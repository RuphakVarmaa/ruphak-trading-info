'use client';

import type { CommodityPrice } from '@/utils/api';
import { getArrow, getPriceColor } from '@/components/shared/format';
import { useUtcTime } from '@/components/shared/UtcClock';

interface CommodityTickerProps {
  prices: CommodityPrice[];
  sourceCount: number;
  highRiskMines: number;
  seismicEvents: number;
}

export default function CommodityTicker({
  prices,
  sourceCount,
  highRiskMines,
  seismicEvents,
}: CommodityTickerProps) {
  const utcTime = useUtcTime();
  return (
    <div
      style={{
        height: 36,
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 14px',
        fontSize: 11,
        fontFamily: 'monospace',
        background: '#0f0f0f',
        gap: 14,
      }}
    >
      {/* Left: Live status info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#4caf50', fontWeight: 700, fontSize: 10 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4caf50', display: 'inline-block', animation: 'pulse-ring 2s infinite ease-out' }} />
          LIVE
        </span>
        <span style={{ color: '#666', fontSize: 10 }}>{sourceCount}/156 sources</span>
        <span style={{ color: '#f44336', fontSize: 10 }}>⚠ {highRiskMines} high-risk mines</span>
        <span style={{ color: '#ff9800', fontSize: 10 }}>🔶 {seismicEvents} seismic events</span>
      </div>

      {/* Center: Title */}
      <div style={{ color: '#ffb300', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textAlign: 'center' }}>
        METALS & MACRO INTEL <span style={{ background: '#ffb300', color: '#000', fontSize: 8, padding: '1px 5px', borderRadius: 3, marginLeft: 5, fontWeight: 800 }}>BETA</span>
      </div>

      {/* Right: Commodity prices */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {prices.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#777', fontSize: 10 }}>{p.name}</span>
            <span style={{ color: '#eee', fontWeight: 600 }}>
              ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span style={{ color: getPriceColor(p.direction), fontSize: 10, fontWeight: 600 }}>
              {getArrow(p.direction)}{Math.abs(p.changePercent).toFixed(2)}%
            </span>
          </div>
        ))}
        {/* Clock */}
        <span style={{ color: '#555', fontSize: 10 }}>
          ⏱ {utcTime} UTC
        </span>
      </div>
    </div>
  );
}
