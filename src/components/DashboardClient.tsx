'use client';

import { useState, useEffect } from 'react';
import type { IntelItem, CommodityPrice, ChokepointStatus, MapMarker, ComexWarehouseData } from '@/utils/api';
import type { EngineSnapshot } from '@/lib/engine/types';
import { EngineProvider, useOptionalEngineState } from '@/hooks/useEngineState';
import ComexWarehouse from '@/components/Comex/ComexWarehouse';
import StackTracker from '@/components/Stack/StackTracker';
import MetalsTerminal from '@/components/Metals/MetalsTerminal';
import IndiaDesk from '@/components/Desk/IndiaDesk';
import TradeBlotter from '@/components/Blotter/TradeBlotter';
import SiteHeader, { ModeBadge } from '@/components/shared/SiteHeader';
import { getArrow, getPriceColor } from '@/components/shared/format';
import { SectionHeader } from '@/components/shared/ui';

interface DashboardClientProps {
  intelItems: IntelItem[];
  commodityPrices: CommodityPrice[];
  chokepoints: ChokepointStatus[];
  mapMarkers: MapMarker[];
  comexData: ComexWarehouseData[];
  engineInitial: EngineSnapshot | null;
}

/** Shape returned by /api/prices. */
interface PriceApiRow {
  name: string;
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  direction: 'up' | 'down';
  prevClose?: number;
  high24h?: number;
  low24h?: number;
  source?: string;
}

const PLAYFAIR = "var(--font-playfair), 'Playfair Display', Georgia, serif";

function EngineModeBadge() {
  const engine = useOptionalEngineState();
  return engine?.state ? <ModeBadge mode={engine.state.mode} /> : null;
}

export default function DashboardClient({
  intelItems,
  commodityPrices: initialPrices,
  chokepoints,
  mapMarkers,
  comexData,
  engineInitial,
}: DashboardClientProps) {
  const [prices, setPrices] = useState<CommodityPrice[]>(initialPrices);
  const [priceSource, setPriceSource] = useState<string>('loading...');
  const [lastUpdate, setLastUpdate] = useState<string>('');

  // Refresh prices from /api/prices now and every 60 seconds; state is only set from the
  // fetch callbacks, never synchronously inside the effect.
  useEffect(() => {
    let cancelled = false;
    const refreshPrices = () => {
      fetch('/api/prices')
        .then((res) => (res.ok ? (res.json() as Promise<PriceApiRow[]>) : null))
        .then((data) => {
          if (cancelled || !data) return;
          const mapped: CommodityPrice[] = data.map((p) => ({
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
        })
        .catch((err) => console.error('Price refresh error:', err));
    };
    refreshPrices();
    const interval = setInterval(refreshPrices, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <EngineProvider initial={engineInitial}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', color: '#ededed', fontFamily: "var(--font-inter), 'Inter', sans-serif" }}>
        <SiteHeader
          active="desk"
          extra={
            <>
              {lastUpdate && (
                <span style={{ fontSize: 9, color: '#555' }}>
                  Prices updated: {lastUpdate} • Source: {priceSource}
                </span>
              )}
              <EngineModeBadge />
            </>
          }
        />

        {/* ===== SCROLLABLE CONTENT ===== */}
        <div style={{ flex: 1, overflowY: 'auto' }}>

          {/* HERO SECTION */}
          <section style={{ padding: '28px 30px 20px', background: '#0a0a0a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ color: '#ffb300', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 4 }}>⚡ NEW</span>
              <span style={{ background: '#ffb300', color: '#000', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 3 }}>BETA</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 32, fontWeight: 400, color: '#e0e0e0', fontFamily: PLAYFAIR }}>
              Event-Driven India Index Desk
            </h2>
            <p style={{ margin: '8px 0 0', fontSize: 14, color: '#777', maxWidth: 860, lineHeight: 1.5 }}>
              Global events scored into NIFTY and SENSEX conviction, turned into ATM weekly option plans with every gate explained.{' '}
              <span style={{ color: '#ffb300', fontWeight: 600 }}>Paper simulation. Not advice.</span>
            </p>
          </section>

          {/* INDIA INDEX DESK */}
          <IndiaDesk />

          {/* TRADE BLOTTER */}
          <TradeBlotter />

          {/* METALS & MACRO INTEL */}
          <section style={{ padding: '28px 30px 0', background: '#0a0a0a', borderTop: '1px solid #1a1a1a' }}>
            <SectionHeader
              label="Metals & macro intel"
              title="Geopolitical Intelligence Terminal"
              sub="150+ sources. Real-time. Metals-focused."
            />
          </section>
          <MetalsTerminal intelItems={intelItems} prices={prices} chokepoints={chokepoints} mapMarkers={mapMarkers} />

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
            <h3 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 400, color: '#e0e0e0', fontFamily: PLAYFAIR }}>
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
              <p style={{ margin: '10px 0 0' }}>
                <span style={{ color: '#2196f3', fontWeight: 700 }}>PAPER SIMULATION.</span> The India Index Desk trades on paper by default: orders are
                simulated against live quotes with modelled slippage and the broker&apos;s charge schedule. Simulated P&amp;L, backtests and signal statistics
                are hypothetical and do not predict future results.
              </p>
              <p style={{ margin: '10px 0 0' }}>
                <span style={{ color: '#f44336', fontWeight: 700 }}>LIVE MODE RISK.</span> Live mode places real NIFTY and SENSEX option orders through a broker
                API. Options can lose the entire premium, often within minutes, and gaps, slippage or outages can make losses larger than modelled. Nothing
                here is a recommendation to buy or sell any security; the author is not a SEBI-registered investment adviser or research analyst.
              </p>
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
    </EngineProvider>
  );
}
