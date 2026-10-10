'use client';

import { useState } from 'react';
import type { IntelItem } from '@/utils/api';
import { timeAgo } from '@/components/shared/format';
import { useClientNow } from '@/hooks/useEngineState';
import { C, getCategoryColor, getSeverityColor } from '@/components/shared/colors';
import { Dot, EmptyState, PanelHeader, Skeleton, TabBar } from '@/components/shared/ui';

const TABS = ['ALL', 'MINING', 'ENERGY', 'MILITARY', 'MARITIME'] as const;
type Tab = (typeof TABS)[number];

interface IntelFeedProps {
  items: IntelItem[];
  /** First load still in flight. */
  loading: boolean;
  /** Set when there is nothing to show because the feed failed. */
  error: string | null;
  /** The server is showing its last good list after a failed refresh. */
  stale: boolean;
}

/** Metals and macro headlines by category, newest first (Bing News, refreshed every few minutes). */
export default function IntelFeed({ items, loading, error, stale }: IntelFeedProps) {
  const [activeTab, setActiveTab] = useState<Tab>('ALL');
  // Relative times need the browser clock: render them after hydration only.
  const now = useClientNow();
  const filteredItems = activeTab === 'ALL' ? items : items.filter((item) => item.category === activeTab);
  const counts: Partial<Record<Tab, number>> = {};
  for (const i of items) if ((TABS as readonly string[]).includes(i.category)) counts[i.category as Tab] = (counts[i.category as Tab] ?? 0) + 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.panel, minHeight: 0 }}>
      <PanelHeader
        title="Headlines"
        live={!loading && !error && !stale && items.length > 0}
        right={<span style={{ color: stale ? C.orange : C.muted2 }}>{stale ? 'last good list' : loading ? 'loading…' : `${items.length} stories`}</span>}
      />
      <TabBar label="Headline categories" tabs={TABS} active={activeTab} onChange={setActiveTab} counts={counts} />
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading &&
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ padding: '14px 18px', borderTop: `1px solid ${C.borderSoft}` }}>
              <Skeleton width="35%" height={11} />
              <Skeleton width="90%" height={14} style={{ marginTop: 9 }} />
              <Skeleton width="60%" height={14} style={{ marginTop: 6 }} />
            </div>
          ))}
        {error && <EmptyState>Headlines are unavailable right now. {error} Retrying every five minutes.</EmptyState>}
        {!loading && !error && filteredItems.length === 0 && <EmptyState>No headlines in this category.</EmptyState>}
        {filteredItems.map((item) => (
          <article key={item.id} style={{ padding: '14px 18px', borderTop: `1px solid ${C.borderSoft}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 12, gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ color: getSeverityColor(item.severity), fontWeight: 700, letterSpacing: '0.04em', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
                  {item.severity === 'FLASH' && <Dot color={C.red} pulse />}
                  {item.severity}
                </span>
                <span style={{ color: getCategoryColor(item.category), fontWeight: 600 }}>{item.category.charAt(0) + item.category.slice(1).toLowerCase()}</span>
              </div>
              <span style={{ color: C.muted3, whiteSpace: 'nowrap' }}>{now == null ? '' : timeAgo(item.publishedAt, now)}</span>
            </div>
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="link-quiet" style={{ color: C.textStrong, fontSize: 14, fontWeight: 600, lineHeight: 1.45, textDecoration: 'none', display: 'block' }}>
              {item.title}
            </a>
            <div style={{ fontSize: 12, color: C.muted2, marginTop: 5 }}>{item.source}</div>
            {item.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {item.tags.map((tag) => (
                  <span key={tag} style={{ fontSize: 11, color: C.muted, padding: '2px 9px', border: `1px solid ${C.border}`, borderRadius: 999, background: C.panelAlt }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
