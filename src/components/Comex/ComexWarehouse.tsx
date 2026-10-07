'use client';

import type { ComexWarehouseData } from '@/utils/api';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

interface ComexWarehouseProps {
  data: ComexWarehouseData[];
}

export default function ComexWarehouse({ data }: ComexWarehouseProps) {
  return (
    <div style={{ padding: '24px 30px', background: '#0a0a0a' }}>
      {/* Section Header */}
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#ffb300', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          WAREHOUSE DATA
        </span>
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 400, color: '#e0e0e0', fontFamily: 'Georgia, serif' }}>
        Registered vs. Eligible. The Coverage Ratios.
      </h3>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#666' }}>
        COMEX warehouse inventory data — tracking Registered (deliverable) vs Eligible (stored) stocks
      </p>

      {/* Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {data.map((item) => (
          <div
            key={item.metal}
            style={{
              background: '#111',
              border: '1px solid #222',
              borderRadius: 10,
              padding: '20px',
              transition: 'border-color 0.2s',
            }}
          >
            {/* Metal Name */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#ffb300', letterSpacing: '0.04em' }}>{item.metal}</span>
              <span style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>Updated: {item.lastUpdated}</span>
            </div>

            {/* Bar Chart */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', height: 28, borderRadius: 5, overflow: 'hidden', background: '#1a1a1a' }}>
                <div
                  style={{
                    width: `${(item.registered / item.total) * 100}%`,
                    background: 'linear-gradient(90deg, #ffb300, #ff8f00)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#000',
                    transition: 'width 0.5s ease',
                  }}
                >
                  {((item.registered / item.total) * 100).toFixed(1)}%
                </div>
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 600,
                    color: '#888',
                  }}
                >
                  {((item.eligible / item.total) * 100).toFixed(1)}%
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: '#555' }}>
                <span>■ Registered</span>
                <span>□ Eligible</span>
              </div>
            </div>

            {/* Numbers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Registered</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#eee', fontFamily: 'monospace' }}>{formatNumber(item.registered)} oz</div>
                <div style={{ fontSize: 10, color: item.registeredChange >= 0 ? '#4caf50' : '#f44336', fontFamily: 'monospace' }}>
                  {item.registeredChange >= 0 ? '+' : ''}{formatNumber(item.registeredChange)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Eligible</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#eee', fontFamily: 'monospace' }}>{formatNumber(item.eligible)} oz</div>
                <div style={{ fontSize: 10, color: item.eligibleChange >= 0 ? '#4caf50' : '#f44336', fontFamily: 'monospace' }}>
                  {item.eligibleChange >= 0 ? '+' : ''}{formatNumber(item.eligibleChange)}
                </div>
              </div>
            </div>

            {/* Coverage Ratio */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #222' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: '#666' }}>Coverage Ratio</span>
                <span style={{
                  fontSize: 13,
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  color: item.coverageRatio < 0.25 ? '#f44336' : item.coverageRatio < 0.5 ? '#ff9800' : '#4caf50',
                }}>
                  {(item.coverageRatio * 100).toFixed(1)}%
                </span>
              </div>
              {/* Mini bar */}
              <div style={{ height: 4, borderRadius: 2, background: '#1a1a1a', marginTop: 4 }}>
                <div style={{
                  height: '100%',
                  borderRadius: 2,
                  width: `${Math.min(item.coverageRatio * 100, 100)}%`,
                  background: item.coverageRatio < 0.25 ? '#f44336' : item.coverageRatio < 0.5 ? '#ff9800' : '#4caf50',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
