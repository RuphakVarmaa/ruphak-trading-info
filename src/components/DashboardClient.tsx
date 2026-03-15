'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import type { IntelItem, CommodityPrice, ChokepointStatus, MapMarker, ComexWarehouseData } from '@/utils/api';
import IntelFeed from '@/components/Feed/IntelFeed';
import ChokepointMonitor from '@/components/Chokepoint/ChokepointMonitor';
import ComexWarehouse from '@/components/Comex/ComexWarehouse';
import StackTracker from '@/components/Stack/StackTracker';

const IntelMap = dynamic(() => import('@/components/Map/IntelMap'), {
  ssr: false,
  loading: () => (
    <div style={{ height: '100%', width: '100%', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffb300', fontSize: 12 }}>
      Initializing Map Engine...
    </div>
  ),
});

interface DashboardClientProps {
  intelItems: IntelItem[];
  commodityPrices: CommodityPrice[];
  chokepoints: ChokepointStatus[];
  mapMarkers: MapMarker[];
  comexData: ComexWarehouseData[];
}

function getPriceColor(dir: 'up' | 'down'): string {
  return dir === 'up' ? '#4caf50' : '#f44336';
}

function getArrow(dir: 'up' | 'down'): string {
  return dir === 'up' ? '▲' : '▼';
}

function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => setTime(new Date().toUTCString().slice(17, 25));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);
  return <span style={{ color: '#555', fontSize: 10, fontFamily: 'monospace' }}>⏱ {time} UTC</span>;
}

export default function DashboardClient({
  intelItems,
  commodityPrices: initialPrices,
  chokepoints,
  mapMarkers,
  comexData,
}: DashboardClientProps) {
  const [selectedChokepoint, setSelectedChokepoint] = useState<string>('HORMUZ');
  const [prices, setPrices] = useState<CommodityPrice[]>(initialPrices);
  const [priceSource, setPriceSource] = useState<string>('loading...');
  const [lastUpdate, setLastUpdate] = useState<string>('');

  // Auto-refresh prices every 60 seconds from /api/prices
  const refreshPrices = useCallback(async () => {
    try {
      const res = await fetch('/api/prices');
      if (res.ok) {
        const data = await res.json();
        const mapped: CommodityPrice[] = data.map((p: any) => ({
          name: p.name,
          symbol: p.symbol,
          price: p.price,
          change: p.change,
          changePercent: p.changePercent,
          direction: p.direction,
          prevClose: p.prevClose,
          high24h: p.high24h,
          low24h: p.low24h,
        }));
        setPrices(mapped);
        setPriceSource(data[0]?.source || 'api');
        setLastUpdate(new Date().toLocaleTimeString());
      }
    } catch (err) {
      console.error('Price refresh error:', err);
    }
  }, []);

  useEffect(() => {
    refreshPrices(); // Initial fetch
    const interval = setInterval(refreshPrices, 60000); // Every 60s
    return () => clearInterval(interval);
  }, [refreshPrices]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', color: '#ededed', fontFamily: "'Inter', sans-serif" }}>
      {/* ===== HEADER ===== */}
      <header style={{ height: 56, borderBottom: '1px solid #1a1a1a', background: '#0f0f0f', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 3 }}>
            <div style={{ width: 4, height: 24, background: '#ffb300', borderRadius: 2 }} />
            <div style={{ width: 4, height: 24, background: '#ffb300', borderRadius: 2, opacity: 0.5 }} />
            <div style={{ width: 4, height: 24, background: '#ffb300', borderRadius: 2 }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: '0.03em', lineHeight: 1.1 }}>
              <span style={{ color: '#fff' }}>RUPHAK</span>{' '}
              <span style={{ color: '#ffb300' }}>TRADING INFO</span>
            </h1>
            <p style={{ margin: 0, fontSize: 8, color: '#555', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
              Geopolitical Intelligence Terminal
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastUpdate && (
            <span style={{ fontSize: 9, color: '#555' }}>
              Prices updated: {lastUpdate} • Source: {priceSource}
            </span>
          )}
          <a href="https://www.ruphak.me" target="_blank" rel="noopener noreferrer" style={{
            background: '#ffb300', color: '#000', border: 'none', padding: '8px 20px', borderRadius: 6,
            fontSize: 12, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.03em', textDecoration: 'none',
          }}>
            Visit ruphak.me →
          </a>
        </div>
      </header>

      {/* ===== SCROLLABLE CONTENT ===== */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* HERO SECTION */}
        <section style={{ padding: '28px 30px 20px', background: '#0a0a0a' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ color: '#ffb300', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 4 }}>⚡ NEW</span>
            <span style={{ background: '#ffb300', color: '#000', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 3 }}>BETA</span>
          </div>
          <h2 style={{ margin: 0, fontSize: 32, fontWeight: 400, color: '#e0e0e0', fontFamily: "'Playfair Display', Georgia, serif" }}>
            Geopolitical Intelligence Terminal
          </h2>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#777' }}>
            150+ sources. Real-time. Metals-focused.
          </p>
        </section>

        {/* MAIN TERMINAL BOX */}
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
            <div style={{ display: 'flex', height: 500, overflow: 'hidden' }}>
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

        {/* FEATURE BULLETS */}
        <section style={{ padding: '24px 40px', background: '#0a0a0a', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ maxWidth: 800, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 60px' }}>
            {['Mining disruptions', 'Shipping chokepoints', 'Military activity', 'Supply chain alerts'].map(f => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#ccc' }}>
                <span style={{ color: '#ffb300', fontSize: 16 }}>✓</span> {f}
              </div>
            ))}
          </div>
        </section>

        {/* COMEX WAREHOUSE DATA */}
        <section style={{ borderTop: '1px solid #1a1a1a' }}>
          <ComexWarehouse data={comexData} />
        </section>

        {/* SPOT PRICES DETAIL CARDS */}
        <section style={{ padding: '24px 30px', background: '#0a0a0a', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#ffb300', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>SPOT PRICES</span>
          </div>
          <h3 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 400, color: '#e0e0e0', fontFamily: "'Playfair Display', Georgia, serif" }}>
            Live Commodity Prices — 60-Second Updates
          </h3>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: '#666' }}>
            Tracking XAUUSD, XAGUSD, XPTUSD, XCUUSD, WTIUSD, BRENTUSD forex-style commodity pairs
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
            {prices.map(p => (
              <div key={p.name} style={{ background: '#111', border: '1px solid #222', borderRadius: 10, padding: 18, transition: 'border-color 0.2s' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#ffb300' }}>{p.name}</span>
                  <span style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>{p.symbol}USD</span>
                </div>
                <div style={{ fontSize: 26, fontWeight: 700, color: '#eee', fontFamily: 'monospace', marginBottom: 6 }}>
                  ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: getPriceColor(p.direction), fontWeight: 600 }}>
                    {getArrow(p.direction)} {p.change >= 0 ? '+' : ''}{p.change.toFixed(2)} ({Math.abs(p.changePercent).toFixed(2)}%)
                  </span>
                </div>
                {(p.high24h || p.low24h || p.prevClose) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 10, color: '#888', borderTop: '1px solid #1a1a1a', paddingTop: 8 }}>
                    {p.high24h && <div><div style={{ color: '#555', fontSize: 8, textTransform: 'uppercase' }}>24h High</div><div style={{ color: '#aaa', fontFamily: 'monospace' }}>${p.high24h.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>}
                    {p.low24h && <div><div style={{ color: '#555', fontSize: 8, textTransform: 'uppercase' }}>24h Low</div><div style={{ color: '#aaa', fontFamily: 'monospace' }}>${p.low24h.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>}
                    {p.prevClose && <div><div style={{ color: '#555', fontSize: 8, textTransform: 'uppercase' }}>Prev Close</div><div style={{ color: '#aaa', fontFamily: 'monospace' }}>${p.prevClose.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* STACK TRACKER */}
        <section style={{ borderTop: '1px solid #1a1a1a' }}>
          <StackTracker prices={prices} />
        </section>

        {/* DISCLAIMER */}
        <section style={{ padding: '20px 30px', background: '#080808', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', padding: '16px 20px', background: '#0f0f0f', border: '1px solid #1a1a1a', borderRadius: 8, fontSize: 10, color: '#555', lineHeight: 1.7 }}>
            <div style={{ color: '#f44336', fontWeight: 700, fontSize: 9, letterSpacing: '0.08em', marginBottom: 6 }}>⚠ DISCLAIMER</div>
            No content published on this platform constitutes investment advice. You are solely responsible for your investment decisions.
            Performance data is from sources believed to be reliable but is not guaranteed. Investments carry risk, including potential loss of principal.
            This platform aggregates publicly available data for informational purposes only and is not a substitute for professional financial advice.
          </div>
        </section>

        {/* FOOTER */}
        <footer style={{ padding: '24px 30px', background: '#070707', borderTop: '1px solid #1a1a1a', textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>
            Maintained by <span style={{ color: '#ffb300', fontWeight: 600 }}>Ruphak</span> •{' '}
            <a href="https://www.ruphak.me" target="_blank" rel="noopener noreferrer" style={{ color: '#ffb300', textDecoration: 'none' }}>
              www.ruphak.me
            </a>
          </div>
          <div style={{ fontSize: 9, color: '#444' }}>
            © {new Date().getFullYear()} Ruphak Trading Info. All rights reserved. Data from RSS/GNews aggregation. Not financial advice.
          </div>
        </footer>
      </div>
    </div>
  );
}
