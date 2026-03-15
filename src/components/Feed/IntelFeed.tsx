'use client';

import { useState } from 'react';
import type { IntelItem } from '@/utils/api';

function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'NOW';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function getSeverityColor(severity: IntelItem['severity']): string {
  if (severity === 'FLASH') return '#f44336';
  if (severity === 'ALERT') return '#ff9800';
  return '#2196f3';
}

function getCategoryColor(category: IntelItem['category']): string {
  if (category === 'MINING') return '#ffb300';
  if (category === 'ENERGY') return '#e87940';
  if (category === 'MILITARY') return '#f44336';
  if (category === 'MARITIME') return '#2196f3';
  return '#888';
}

const TABS = ['ALL', 'MINING', 'ENERGY', 'MILITARY', 'MARITIME'] as const;

interface IntelFeedProps {
  items: IntelItem[];
}

export default function IntelFeed({ items }: IntelFeedProps) {
  const [activeTab, setActiveTab] = useState<string>('ALL');

  const filteredItems =
    activeTab === 'ALL'
      ? items
      : items.filter((item) => item.category === activeTab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#111' }}>
      {/* Header */}
      <div
        style={{
          height: 40,
          borderBottom: '1px solid #222',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          fontSize: 11,
          letterSpacing: '0.08em',
          fontWeight: 700,
          gap: 8,
        }}
      >
        <span style={{ color: '#ffb300' }}>📋</span>
        <span>INTEL FEED</span>
        <span
          style={{
            color: '#4caf50',
            fontSize: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#4caf50',
              display: 'inline-block',
              animation: 'pulse-ring 2s infinite ease-out',
            }}
          />
          LIVE
        </span>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 8px',
          borderBottom: '1px solid #222',
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              background: activeTab === tab ? '#2a2a2a' : 'transparent',
              color: activeTab === tab ? '#fff' : '#555',
              border: 'none',
              padding: '5px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              transition: 'all 0.15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Feed Items */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {filteredItems.length === 0 && (
          <div style={{ textAlign: 'center', color: '#555', fontSize: 12, paddingTop: 40 }}>
            No intelligence items for this category.
          </div>
        )}
        {filteredItems.map((item) => (
          <div
            key={item.id}
            style={{
              borderLeft: `2px solid ${getSeverityColor(item.severity)}`,
              paddingLeft: 12,
              transition: 'all 0.2s',
            }}
          >
            {/* Severity + Category + Time */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
                fontSize: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    color: getSeverityColor(item.severity),
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {item.severity === 'FLASH' && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: '#f44336',
                        display: 'inline-block',
                        animation: 'pulse-ring 2s infinite ease-out',
                      }}
                    />
                  )}
                  {item.severity}
                </span>
                <span style={{ color: getCategoryColor(item.category), fontWeight: 600, fontSize: 9 }}>
                  ⚡ {item.category}
                </span>
              </div>
              <span style={{ color: '#555' }}>{timeAgo(item.publishedAt)}</span>
            </div>

            {/* Title / Description */}
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#ccc',
                fontSize: 12,
                lineHeight: 1.5,
                textDecoration: 'none',
                display: 'block',
              }}
            >
              {'>'} {item.title}
            </a>

            {/* Tags */}
            {item.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: 9,
                      color: '#888',
                      padding: '2px 8px',
                      border: '1px solid #333',
                      borderRadius: 3,
                      letterSpacing: '0.03em',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
