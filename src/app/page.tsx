import { fetchIntelFeed, fetchCommodityPrices, getChokepointStatuses, deriveMapMarkers, getComexWarehouseData } from '@/utils/api';
import DashboardClient from '@/components/DashboardClient';

export default async function Home() {
  const [intelItems, commodityPrices] = await Promise.all([
    fetchIntelFeed(),
    fetchCommodityPrices(),
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
    />
  );
}
