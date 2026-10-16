import type { Metadata } from 'next';
import { getInitialEngineSnapshot } from '@/lib/engine/snapshot';
import DashboardClient from '@/components/DashboardClient';
import { accountFromQuery } from '@/components/Engine/engineView';

// Engine state changes every few seconds: render per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Paper trading engine — Ruphak Trading Info',
  description: "The paper engine's safety state, what to do now on NIFTY and SENSEX options, the ₹10k trade card, open positions, P&L and today's trades.",
};

/** `?account=small10k` shows that paper account; no parameter (or "main") shows the main account. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const account = accountFromQuery(await searchParams);
  const engineInitial = await getInitialEngineSnapshot(account);
  return <DashboardClient engineInitial={engineInitial} account={account} />;
}
