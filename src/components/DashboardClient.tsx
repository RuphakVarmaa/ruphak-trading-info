'use client';

import type { EngineSnapshot } from '@/lib/engine/types';
import { EngineProvider, useEngineState } from '@/hooks/useEngineState';
import EngineDesk from '@/components/Desk/IndiaDesk';
import SiteHeader from '@/components/shared/SiteHeader';
import SiteFooter from '@/components/shared/SiteFooter';
import { C } from '@/components/shared/colors';
import { Panel } from '@/components/shared/ui';

interface DashboardClientProps {
  engineInitial: EngineSnapshot | null;
  /** Paper account from `?account=` (undefined: main). */
  account?: string;
}

/** The site header with the engine's PAPER/LIVE badge. */
function EngineSiteHeader() {
  const { state } = useEngineState();
  return <SiteHeader active="engine" mode={state?.mode ?? null} />;
}

/** The Paper Engine page. Keyed by account, so switching accounts starts a fresh provider (as /live and /copy do). */
export default function DashboardClient({ engineInitial, account }: DashboardClientProps) {
  return (
    <EngineProvider key={account ?? 'main'} initial={engineInitial} account={account}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text }}>
        <EngineSiteHeader />

        <main style={{ width: '100%', maxWidth: 1240, margin: '0 auto', padding: '32px 16px 64px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 48, boxSizing: 'border-box' }}>
          <EngineDesk account={account} />

          <Panel style={{ padding: '18px 20px', background: C.panelAlt }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.textStrong, marginBottom: 8 }}>Disclaimer</div>
            <div style={{ display: 'grid', gap: 8, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>
                Nothing here is investment advice, and the author is not a SEBI-registered investment adviser or research analyst. Data comes from sources believed to be reliable but is not guaranteed.
              </p>
              <p style={{ margin: 0 }}>
                Paper trading: the engine simulates orders against live quotes with modelled slippage and Groww&apos;s charges. Simulated P&amp;L, backtests and signal statistics are hypothetical
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
