'use client';

import { CHOKEPOINT_WINDOW_HOURS, type ChokepointNews, type NewsLevel } from '@/utils/api';
import { timeAgo } from '@/components/shared/format';
import { useClientNow } from '@/hooks/useEngineState';
import { alpha, C } from '@/components/shared/colors';

const LEVEL: Record<NewsLevel, { color: string; word: string }> = {
  heavy: { color: C.red, word: 'Heavy coverage' },
  in_news: { color: C.orange, word: 'In the news' },
  quiet: { color: C.green, word: 'Quiet' },
};

interface ChokepointMonitorProps {
  chokepoints: ChokepointNews[];
  selected: string;
  onSelect: (id: string) => void;
  /** False until the headlines and the browser clock are in: counts would read zero. */
  ready: boolean;
}

/** Shipping chokepoints by how often they are in the headlines: a news-flow gauge, not vessel tracking. */
export default function ChokepointMonitor({ chokepoints, selected, onSelect, ready }: ChokepointMonitorProps) {
  const now = useClientNow();
  const current = chokepoints.find((c) => c.spec.id === selected) ?? chokepoints[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: C.panelAlt, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: C.textStrong }}>Shipping chokepoints</span>
        <span style={{ fontSize: 12, color: C.muted2 }}>headlines naming each one, last {CHOKEPOINT_WINDOW_HOURS} h · not vessel tracking</span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chokepoints.map((cp) => {
          const on = current?.spec.id === cp.spec.id;
          const color = ready ? LEVEL[cp.level].color : C.muted3;
          return (
            <button
              key={cp.spec.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(cp.spec.id)}
              title={ready ? `${LEVEL[cp.level].word}: ${cp.count} headline${cp.count === 1 ? '' : 's'}` : undefined}
              style={{
                padding: '5px 11px',
                borderRadius: 999,
                border: `1px solid ${on ? alpha(color, 0.55) : C.border}`,
                background: on ? alpha(color, 0.1) : C.panel,
                color: on ? C.textStrong : C.textSoft,
                fontSize: 12.5,
                fontWeight: on ? 600 : 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {cp.spec.name.replace(/^Strait of /, '').replace(/ and Bab el-Mandeb$/, '')}
              {ready && cp.count > 0 && (
                <span className="tnum" style={{ color: C.muted2, fontWeight: 600 }}>
                  {cp.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {current && (
        <div style={{ display: 'grid', gap: 4, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px' }}>
            <span style={{ color: C.textStrong, fontWeight: 600 }}>{current.spec.name}</span>
            {ready && (
              <span style={{ color: LEVEL[current.level].color, fontWeight: 600 }}>
                {LEVEL[current.level].word} · {current.count} headline{current.count === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {current.spec.fact && <span>{current.spec.fact}</span>}
          {ready && current.latest && (
            <a href={current.latest.url} target="_blank" rel="noopener noreferrer" className="link-quiet" style={{ color: C.textSoft, textDecoration: 'none' }}>
              Latest: {current.latest.title}{' '}
              <span style={{ color: C.muted3 }}>
                · {current.latest.source}
                {now != null ? ` · ${timeAgo(current.latest.publishedAt, now)}` : ''} ↗
              </span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
