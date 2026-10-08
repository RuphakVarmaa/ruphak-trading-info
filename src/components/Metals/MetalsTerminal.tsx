'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { HeadlineFeed } from '@/lib/market/headlines';
import { chokepointNews, deriveMapMarkers } from '@/utils/api';
import { useClientNow } from '@/hooks/useEngineState';
import IntelFeed from '@/components/Feed/IntelFeed';
import ChokepointMonitor from '@/components/Chokepoint/ChokepointMonitor';
import { C } from '@/components/shared/colors';
import { Panel } from '@/components/shared/ui';

const IntelMap = dynamic(() => import('@/components/Map/IntelMap'), {
  ssr: false,
  loading: () => (
    <div style={{ height: '100%', width: '100%', background: 'var(--map-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontSize: 13 }}>
      Loading the map…
    </div>
  ),
});

interface MetalsTerminalProps {
  /** Live headlines from /api/metals/headlines; null until the first load. */
  feed: HeadlineFeed | null;
  error: string | null;
}

/** Metals and macro headlines on a world map, the shipping chokepoints' news levels, and the headline list. */
export default function MetalsTerminal({ feed, error }: MetalsTerminalProps) {
  const [selected, setSelected] = useState<string>('HORMUZ');
  const now = useClientNow();
  const items = feed?.items ?? [];
  // Counting "the last 72 hours" needs the browser clock: until hydration every level reads quiet.
  const chokepoints = chokepointNews(now == null ? [] : items, now ?? 0);
  const markers = deriveMapMarkers(items, chokepoints);
  return (
    <Panel>
      <div className="legacy-core" style={{ display: 'flex', height: 600 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <IntelMap markers={markers} />
          </div>
          <div style={{ borderTop: `1px solid ${C.border}` }}>
            <ChokepointMonitor chokepoints={chokepoints} selected={selected} onSelect={setSelected} ready={feed != null && now != null} />
          </div>
        </div>
        <div style={{ width: 400, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <IntelFeed items={items} loading={feed == null && error == null} error={feed == null ? error : null} stale={feed?.stale ?? false} />
        </div>
      </div>
    </Panel>
  );
}
