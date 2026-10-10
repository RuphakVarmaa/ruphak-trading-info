import { getInitialEngineSnapshot } from '@/lib/engine/snapshot';
import DashboardClient from '@/components/DashboardClient';

// Engine state changes every few seconds: render per request. Metals and macro have their own page (/metals).
export const dynamic = 'force-dynamic';

export default async function Home() {
  const engineInitial = await getInitialEngineSnapshot();
  return <DashboardClient engineInitial={engineInitial} />;
}
