import { fetchIntelFeed, fetchCommodityPrices, getChokepointStatuses, deriveMapMarkers, getComexWarehouseData } from '@/utils/api';
import { getInitialEngineSnapshot } from '@/lib/engine/snapshot';
import DashboardClient from '@/components/DashboardClient';

// Engine state changes every few seconds; render per request (the news and metals
// fetches keep their own revalidate windows in the data cache).
export const dynamic = 'force-dynamic';

export default async function Home() {
  const [intelItems, commodityPrices, engineInitial] = await Promise.all([
    fetchIntelFeed(),
    fetchCommodityPrices(),
    getInitialEngineSnapshot(),
  ]);

  const chokepoints = getChokepointStatuses();
  const mapMarkers = deriveMapMarkers(intelItems);
  const comexData = getComexWarehouseData();

  return (
    <DashboardClient
      intelItems={intelItems}
      commodityPrices={commodityPrices}
      chokepoints={chokepoints}
      mapMarkers={mapMarkers}
      comexData={comexData}
      engineInitial={engineInitial}
    />
  );
}
