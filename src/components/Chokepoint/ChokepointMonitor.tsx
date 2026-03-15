'use client';

import type { ChokepointStatus } from '@/utils/api';

function getStatusColor(status: ChokepointStatus['status']): string {
  if (status === 'CRITICAL') return '#f44336';
  if (status === 'ELEVATED') return '#ff9800';
  return '#4caf50';
}

function getStatusBg(status: ChokepointStatus['status']): string {
  if (status === 'CRITICAL') return 'rgba(244,67,54,0.12)';
  if (status === 'ELEVATED') return 'rgba(255,152,0,0.10)';
  return 'transparent';
}

interface ChokepointMonitorProps {
  chokepoints: ChokepointStatus[];
  selectedChokepoint: string | null;
  onSelect: (name: string) => void;
}

export default function ChokepointMonitor({
  chokepoints,
  selectedChokepoint,
  onSelect,
}: ChokepointMonitorProps) {
  const selected = chokepoints.find((c) => c.name === selectedChokepoint) || chokepoints[0];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d0d0d', padding: '10px 14px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          <span style={{ color: '#ffb300' }}>🚢</span>
          MARITIME CHOKEPOINT MONITOR
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: '#4caf50' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4caf50', display: 'inline-block' }} />
            LIVE AIS
          </span>
        </div>
        <span style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>
          {new Date().toUTCString().slice(17, 25)} UTC
        </span>
      </div>

      {/* Chokepoint Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {chokepoints.map((cp) => (
          <button
            key={cp.name}
            onClick={() => onSelect(cp.name)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: `1px solid ${selectedChokepoint === cp.name ? getStatusColor(cp.status) + '60' : '#333'}`,
              background: selectedChokepoint === cp.name ? getStatusBg(cp.status) : 'transparent',
              color: selectedChokepoint === cp.name ? getStatusColor(cp.status) : '#666',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              transition: 'all 0.15s',
              fontFamily: 'monospace',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: getStatusColor(cp.status),
                display: 'inline-block',
              }}
            />
            {cp.name}
          </button>
        ))}
      </div>

      {/* Selected Detail */}
      {selected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 10, color: '#888' }}>
          <div>
            <span style={{ color: '#eee', fontWeight: 600 }}>{selected.details}</span>
          </div>
          {selected.oilTransit && (
            <>
              <div>
                <span style={{ color: '#555' }}>OIL TRANSIT: </span>
                <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{selected.oilTransit}</span>
              </div>
              <div>
                <span style={{ color: '#555' }}>GLOBAL SHARE: </span>
                <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{selected.globalShare}</span>
              </div>
            </>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 3,
                background: getStatusBg(selected.status),
                color: getStatusColor(selected.status),
                fontWeight: 700,
                fontSize: 9,
                letterSpacing: '0.04em',
                border: `1px solid ${getStatusColor(selected.status)}40`,
              }}
            >
              ⚠ {selected.status}
            </span>
          </div>
          <div>
            <span style={{ color: '#555' }}>Risk Score: </span>
            <span style={{ color: selected.riskScore > 70 ? '#f44336' : selected.riskScore > 40 ? '#ff9800' : '#4caf50', fontWeight: 700, fontFamily: 'monospace' }}>
              {selected.riskScore}/100
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
