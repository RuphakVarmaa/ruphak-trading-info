'use client';

import type { EngineSnapshot } from '@/lib/engine/types';
import type { CommodityBoard, CommodityQuote } from '@/lib/market/commodities';
import type { HeadlineFeed } from '@/lib/market/headlines';
import type { PricePoint } from '@/utils/api';
import { EngineProvider, useClientNow, useOptionalEngineState } from '@/hooks/useEngineState';
import { usePolled } from '@/hooks/usePolled';
import StackTracker from '@/components/Stack/StackTracker';
import MetalsTerminal from '@/components/Metals/MetalsTerminal';
import IndiaDesk from '@/components/Desk/IndiaDesk';
import SiteHeader, { ModeBadge } from '@/components/shared/SiteHeader';
import { C, pnlColor } from '@/components/shared/colors';
import { fmtAge, fmtIstHm } from '@/components/shared/format';
import { EmptyState, Panel, Section, Skeleton } from '@/components/shared/ui';

interface DashboardClientProps {
  engineInitial: EngineSnapshot | null;
}

/** Copper is quoted in US dollars per pound; holdings are valued per troy ounce. */
const TROY_OZ_PER_LB = 453.59237 / 31.1034768;
const STACK_METALS = new Set(['GOLD', 'SILVER', 'PLATINUM', 'COPPER']);

function EngineModeBadge() {
  const engine = useOptionalEngineState();
  return engine?.state ? <ModeBadge mode={engine.state.mode} /> : null;
}

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
  const color = values[values.length - 1] >= values[0] ? C.green : C.red;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={`One-month trend: ${values[values.length - 1] >= values[0] ? 'up' : 'down'}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function PriceCard({ q }: { q: CommodityQuote }) {
  const color = q.change == null ? C.muted : pnlColor(q.change);
  return (
    <div className="lift" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 18px', boxShadow: 'var(--shadow-card)', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: C.textStrong }}>{q.name}</span>
        <span style={{ fontSize: 12, color: C.muted3 }}>{q.unit}</span>
      </div>
      <div className="tnum" style={{ fontSize: 26, fontWeight: 600, color: C.textStrong, letterSpacing: '-0.02em', marginTop: 6 }}>
        {money(q.price, q.decimals)}
      </div>
      <div className="tnum" style={{ fontSize: 13, color, fontWeight: 600, marginTop: 2 }}>
        {q.change == null || q.changePct == null ? (
          <span style={{ color: C.muted2, fontWeight: 500 }}>no previous close</span>
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
            <div style={{ color: C.muted3, fontSize: 11.5 }}>{k}</div>
            <div style={{ color: C.textSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v != null ? money(v, q.decimals) : '—'}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: C.muted3 }}>
        {q.symbol} · last trade {fmtIstHm(q.asOf)} IST
      </div>
    </div>
  );
}

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
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
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
        {board.quotes.map((q) => (
          <PriceCard key={q.key} q={q} />
        ))}
      </div>
      {board.missing.length > 0 && <div style={{ fontSize: 12.5, color: C.orange }}>No price from Yahoo for {board.missing.map((m) => m.toLowerCase()).join(', ')} on the last refresh.</div>}
    </div>
  );
}

function PricesNote({ board, at }: { board: CommodityBoard | null; at: number | null }) {
  const now = useClientNow();
  if (!board) return null;
  return (
    <span style={{ fontSize: 12.5, color: board.stale ? C.orange : C.muted2 }}>
      {board.stale ? 'showing the last good prices · ' : ''}
      {at != null && now != null ? `refreshed ${fmtAge(Math.max(0, now - at))} ago` : 'refreshing'}
    </span>
  );
}

export default function DashboardClient({ engineInitial }: DashboardClientProps) {
  const prices = usePolled<CommodityBoard>('/api/prices', 60_000);
  const headlines = usePolled<HeadlineFeed>('/api/metals/headlines', 5 * 60_000);
  const stackPrices: PricePoint[] = (prices.data?.quotes ?? [])
    .filter((q) => STACK_METALS.has(q.key))
    .map((q) => ({ name: q.key, price: q.key === 'COPPER' ? q.price / TROY_OZ_PER_LB : q.price }));

  return (
    <EngineProvider initial={engineInitial}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text }}>
        <SiteHeader active="desk" extra={<EngineModeBadge />} />

        <main style={{ width: '100%', maxWidth: 1240, margin: '0 auto', padding: '32px 16px 64px', display: 'grid', gap: 48, boxSizing: 'border-box' }}>
          <IndiaDesk />

          <div style={{ height: 1, background: C.border }} aria-hidden />

          <Section
            id="metals"
            title="Metals and macro"
            sub="Supply, shipping and conflict news that moves metals and energy, placed on the map, with how much each shipping chokepoint is in the headlines."
          >
            <MetalsTerminal feed={headlines.data} error={headlines.error} />
          </Section>

          <Section
            id="spot"
            title="Metal and energy prices"
            sub="Front-month COMEX and NYMEX futures from Yahoo Finance, refreshed every minute (exchange data can be delayed up to 15 minutes)."
            right={<PricesNote board={prices.data} at={prices.at} />}
          >
            <PriceBoard board={prices.data} error={prices.error} />
          </Section>

          <Section id="stack" title="Your metals stack" sub="Track physical holdings at today's futures prices. Saved only in this browser.">
            <StackTracker prices={stackPrices} />
          </Section>

          <Panel style={{ padding: '18px 20px', background: C.panelAlt }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong, marginBottom: 8 }}>Disclaimer</div>
            <div style={{ display: 'grid', gap: 8, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>
                Nothing here is investment advice, and the author is not a SEBI-registered investment adviser or research analyst. Data comes from sources believed to be reliable but is not guaranteed.
              </p>
              <p style={{ margin: 0 }}>
                <b style={{ color: C.blue }}>Paper trading.</b> The India Index Desk simulates orders against live quotes with modelled slippage and Groww&apos;s charges. Simulated P&amp;L, backtests and signal
                statistics are hypothetical and do not predict future results.
              </p>
              <p style={{ margin: 0 }}>
                <b style={{ color: C.red }}>Live trading risk.</b> Live mode places real NIFTY and SENSEX option orders. Options can lose the whole premium within minutes, and gaps, slippage or outages can make
                losses larger than modelled.
              </p>
            </div>
          </Panel>
        </main>

        <footer style={{ padding: '28px 16px', borderTop: `1px solid ${C.border}`, background: C.panelAlt, textAlign: 'center', fontSize: 13, color: C.muted }}>
          Maintained by <b style={{ color: C.textStrong }}>Ruphak</b> ·{' '}
          <a href="https://www.ruphak.me" target="_blank" rel="noopener noreferrer" className="link-quiet" style={{ color: C.gold, textDecoration: 'none', fontWeight: 600 }}>
            www.ruphak.me
          </a>
          <div style={{ fontSize: 12, color: C.muted3, marginTop: 4 }}>© {new Date().getFullYear()} Ruphak Trading Info. Not financial advice.</div>
        </footer>
      </div>
    </EngineProvider>
  );
}
