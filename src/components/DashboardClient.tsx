'use client';

import type { EngineSnapshot } from '@/lib/engine/types';
import { EngineProvider, useEngineState } from '@/hooks/useEngineState';
import IndiaDesk from '@/components/Desk/IndiaDesk';
import SiteHeader from '@/components/shared/SiteHeader';
import SiteFooter from '@/components/shared/SiteFooter';
import { C } from '@/components/shared/colors';
import { Panel } from '@/components/shared/ui';

interface DashboardClientProps {
  engineInitial: EngineSnapshot | null;
}

/** The site header with the engine's PAPER/LIVE badge: the only place the Desk shows the mode. */
function DeskSiteHeader() {
  const { state } = useEngineState();
  return <SiteHeader active="desk" mode={state?.mode ?? null} />;
}

/** The Desk page: the India index overview. Metals and macro have their own page (/metals). */
export default function DashboardClient({ engineInitial }: DashboardClientProps) {
  return (
    <EngineProvider initial={engineInitial}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text }}>
        <DeskSiteHeader />

        <main style={{ width: '100%', maxWidth: 1240, margin: '0 auto', padding: '32px 16px 64px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 48, boxSizing: 'border-box' }}>
          <IndiaDesk />

          <Panel style={{ padding: '18px 20px', background: C.panelAlt }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong, marginBottom: 8 }}>Disclaimer</div>
            <div style={{ display: 'grid', gap: 8, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>
                Nothing here is investment advice, and the author is not a SEBI-registered investment adviser or research analyst. Data comes from sources believed to be reliable but is not guaranteed.
              </p>
              <p style={{ margin: 0 }}>
                Paper trading: the India Index Desk simulates orders against live quotes with modelled slippage and Groww&apos;s charges. Simulated P&amp;L, backtests and signal statistics are hypothetical
                and do not predict future results.
              </p>
              <p style={{ margin: 0 }}>
                Live trading risk: live mode places real NIFTY and SENSEX option orders. Options can lose the whole premium within minutes, and gaps, slippage or outages can make losses larger than
                modelled.
              </p>
            </div>
          </Panel>
        </main>

        <SiteFooter />
      </div>
    </EngineProvider>
  );
}
