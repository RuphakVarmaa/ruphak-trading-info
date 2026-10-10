'use client';

import type { CommodityBoard, CommodityQuote } from '@/lib/market/commodities';
import type { HeadlineFeed } from '@/lib/market/headlines';
import type { PricePoint } from '@/utils/api';
import { useClientNow } from '@/hooks/useEngineState';
import { usePolled } from '@/hooks/usePolled';
import StackTracker from '@/components/Stack/StackTracker';
import SiteHeader from '@/components/shared/SiteHeader';
import SiteFooter from '@/components/shared/SiteFooter';
import { C, pnlColor } from '@/components/shared/colors';
import { fmtAge, fmtIstHm } from '@/components/shared/format';
import { EmptyState, PageHeader, Panel, Section, Skeleton } from '@/components/shared/ui';
import MetalsTerminal from './MetalsTerminal';

/** Copper is quoted in US dollars per pound; holdings are valued per troy ounce. */
const TROY_OZ_PER_LB = 453.59237 / 31.1034768;
const STACK_METALS = new Set(['GOLD', 'SILVER', 'PLATINUM', 'COPPER']);

const money = (n: number, d: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** A month of daily closes as a small line, coloured by the month's direction. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div style={{ height: 36 }} />;
  const w = 160;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={`One-month trend: ${up ? 'up' : 'down'}`}>
      <polyline points={pts} fill="none" stroke={up ? C.green : C.red} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function PriceCard({ q }: { q: CommodityQuote }) {
  const color = q.change == null ? C.muted : pnlColor(q.change);
  return (
    <Panel style={{ padding: '16px 18px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: C.textStrong }}>{q.name}</span>
        <span style={{ fontSize: 12, color: C.muted2 }}>{q.unit}</span>
      </div>
      <div className="tnum" style={{ fontSize: 26, fontWeight: 600, color: C.textStrong, letterSpacing: '-0.02em', marginTop: 6 }}>
        {money(q.price, q.decimals)}
      </div>
      <div className="tnum" style={{ fontSize: 13, color, marginTop: 2 }}>
        {q.change == null || q.changePct == null ? (
          <span style={{ color: C.muted2 }}>— no previous close</span>
        ) : (
          <>
            {q.change >= 0 ? '▲ +' : '▼ '}
            {q.change.toFixed(q.decimals)} ({q.changePct >= 0 ? '+' : ''}
            {q.changePct.toFixed(2)}%)
          </>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <Sparkline values={q.closes} />
      </div>
      <div className="tnum" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, fontSize: 12, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.borderSoft}` }}>
        {(
          [
            ['Day high', q.dayHigh],
            ['Day low', q.dayLow],
            ['Prev close', q.prevClose],
          ] as const
        ).map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={{ color: C.muted2 }}>{k}</div>
            <div style={{ color: C.textSoft, overflowWrap: 'anywhere' }}>{v != null ? money(v, q.decimals) : '—'}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: C.muted2 }}>
        {q.symbol} · last trade {fmtIstHm(q.asOf)} IST
      </div>
    </Panel>
  );
}

const priceGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 12 } as const;

function PriceBoard({ board, error }: { board: CommodityBoard | null; error: string | null }) {
  if (!board) {
    if (error) {
      return (
        <Panel>
          <EmptyState>Prices are unavailable right now: Yahoo Finance did not answer. Nothing is shown rather than old numbers; this retries every minute.</EmptyState>
        </Panel>
      );
    }
    return (
      <div style={priceGrid}>
        {Array.from({ length: 6 }, (_, i) => (
          <Panel key={i} style={{ padding: 18 }}>
            <Skeleton width="40%" height={14} />
            <Skeleton width="70%" height={26} style={{ marginTop: 12 }} />
            <Skeleton height={36} style={{ marginTop: 14 }} />
          </Panel>
        ))}
      </div>
    );
  }
  if (board.quotes.length === 0) return <Panel><EmptyState>Yahoo Finance returned no prices on the last refresh. This retries every minute.</EmptyState></Panel>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={priceGrid}>
        {board.quotes.map((q) => (
          <PriceCard key={q.key} q={q} />
        ))}
      </div>
      {board.missing.length > 0 && <div style={{ fontSize: 13, color: C.orange }}>No price from Yahoo for {board.missing.map((m) => m.toLowerCase()).join(', ')} on the last refresh.</div>}
    </div>
  );
}

/** "refreshed 2m ago", orange with the reason when the data is old or the last refresh failed. */
function RefreshNote({ at, stale, error, staleText }: { at: number | null; stale: boolean; error: string | null; staleText: string }) {
  const now = useClientNow();
  if (at == null) return <span style={{ fontSize: 13, color: error ? C.orange : C.muted2 }}>{error ? 'not loaded yet · retrying' : 'loading…'}</span>;
  const age = now != null ? `refreshed ${fmtAge(Math.max(0, now - at))} ago` : 'refreshed';
  const late = stale || error != null;
  return (
    <span className="tnum" style={{ fontSize: 13, color: late ? C.orange : C.muted2 }}>
      {stale ? `${staleText} · ` : ''}
      {error ? 'last refresh failed · ' : ''}
      {age}
    </span>
  );
}

/** Metals and macro: futures prices, the news on a map with the shipping chokepoints, and a holdings tracker. */
export default function MetalsPage() {
  const prices = usePolled<CommodityBoard>('/api/prices', 60_000);
  const headlines = usePolled<HeadlineFeed>('/api/metals/headlines', 5 * 60_000);
  const stackPrices: PricePoint[] = (prices.data?.quotes ?? [])
    .filter((q) => STACK_METALS.has(q.key))
    .map((q) => ({ name: q.key, price: q.key === 'COPPER' ? q.price / TROY_OZ_PER_LB : q.price }));

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text }}>
      <SiteHeader active="metals" />
      <main style={{ width: '100%', maxWidth: 1240, margin: '0 auto', padding: '32px 16px 64px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 44, boxSizing: 'border-box' }}>
        <PageHeader
          title="Metals and macro"
          sub="Gold, silver, copper and energy futures, the supply, shipping and conflict news that moves them, and your own holdings."
        />

        <Section
          id="prices"
          title="Prices"
          sub="Front-month COMEX and NYMEX futures from Yahoo Finance, refreshed every minute (exchange data can be delayed up to 15 minutes)."
          right={<RefreshNote at={prices.at} stale={prices.data?.stale ?? false} error={prices.error} staleText="showing the last good prices" />}
        >
          <PriceBoard board={prices.data} error={prices.error} />
        </Section>

        <Section
          id="news"
          title="News on the map"
          sub="Supply, shipping and conflict headlines placed on the map, with how much each shipping chokepoint is in the news. Headlines from Bing News, refreshed every five minutes."
          right={<RefreshNote at={headlines.at} stale={headlines.data?.stale ?? false} error={headlines.error} staleText={headlines.data ? `last good list from ${fmtIstHm(headlines.data.generatedAt)} IST` : 'last good list'} />}
        >
          <MetalsTerminal feed={headlines.data} error={headlines.error} />
        </Section>

        <Section id="stack" title="Your metals stack" sub="Track physical holdings at today's futures prices. Saved only in this browser.">
          <StackTracker prices={stackPrices} />
        </Section>
      </main>
      <SiteFooter />
    </div>
  );
}
