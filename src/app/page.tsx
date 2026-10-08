import { getInitialEngineSnapshot } from '@/lib/engine/snapshot';
import DashboardClient from '@/components/DashboardClient';

// Engine state changes every few seconds: render per request. Metal prices and headlines load in
// the browser from /api/prices and /api/metals/headlines, so they never hold up the desk.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const engineInitial = await getInitialEngineSnapshot();
  return <DashboardClient engineInitial={engineInitial} />;
}
