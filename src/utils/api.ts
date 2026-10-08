// ============================================
// Metals and macro: shared types and pure helpers (no imports, safe in the browser).
// Headline classification lives in the engine (src/engine/events/lexicon.ts, geo.ts).
// Live data comes from the route handlers: /api/prices (Yahoo Finance futures)
// and /api/metals/headlines (Bing News). Nothing here invents prices or levels.
// ============================================

// ------ Types ------

export interface IntelItem {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  publishedAt: string;
  category: 'MINING' | 'ENERGY' | 'MILITARY' | 'MARITIME';
  severity: 'FLASH' | 'ALERT' | 'UPDATE';
  tags: string[];
  location?: { lat: number; lng: number; name: string };
}

/** A metal's price in US dollars per troy ounce, for valuing holdings. */
export interface PricePoint {
  name: string;
  price: number;
}

export interface StackHolding {
  id: string;
  metal: string;
  type: string; // 'coin', 'bar', 'round', 'ETF'
  weight: number; // in troy ounces
  weightUnit: 'oz' | 'g' | 'kg';
  purchasePrice: number;
  purchaseDate: string;
  notes: string;
}

export interface StackSummary {
  totalValueUsd: number;
  totalCostBasis: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  holdings: {
    metal: string;
    totalOz: number;
    totalValue: number;
    totalCost: number;
    gainLoss: number;
    gainLossPercent: number;
  }[];
}

// ------ Shipping chokepoints: how much they are in the news ------

export interface ChokepointSpec {
  id: string;
  name: string;
  match: RegExp;
  lat: number;
  lng: number;
  /** A standing fact about the route (not a live reading). */
  fact?: string;
}

export const CHOKEPOINTS: ChokepointSpec[] = [
  { id: 'HORMUZ', name: 'Strait of Hormuz', match: /\bhormuz\b/i, lat: 26.5, lng: 56.3, fact: 'About a fifth of the oil the world uses passes through it.' },
  { id: 'RED_SEA', name: 'Red Sea and Bab el-Mandeb', match: /\bred sea\b|bab[\s-]el[\s-]mandeb|\bhouthis?\b/i, lat: 12.6, lng: 43.3, fact: 'The route between the Suez Canal and the Indian Ocean.' },
  { id: 'SUEZ', name: 'Suez Canal', match: /\bsuez\b/i, lat: 30.5, lng: 32.3, fact: 'The shortest sea route between Asia and Europe.' },
  { id: 'MALACCA', name: 'Strait of Malacca', match: /\bmalacca\b/i, lat: 2.5, lng: 101.5, fact: "The main route for oil from the Gulf to China, Japan and Korea." },
  { id: 'TAIWAN', name: 'Taiwan Strait', match: /\btaiwan strait\b/i, lat: 24.0, lng: 120.0, fact: 'A main lane for container ships and chips leaving East Asia.' },
  { id: 'PANAMA', name: 'Panama Canal', match: /\bpanama canal\b/i, lat: 9.0, lng: -79.5, fact: "Its water levels limit traffic in dry years." },
  { id: 'BLACK_SEA', name: 'Black Sea', match: /\bblack sea\b/i, lat: 43.5, lng: 34.0, fact: 'Grain, oil and metals from Russia and Ukraine.' },
  { id: 'BALTIC', name: 'Baltic Sea', match: /\bbaltic\b/i, lat: 58.0, lng: 20.0, fact: 'Russian oil exports and undersea cables.' },
];

export type NewsLevel = 'quiet' | 'in_news' | 'heavy';

export interface ChokepointNews {
  spec: ChokepointSpec;
  /** Headlines in the window that mention it. */
  count: number;
  latest: IntelItem | null;
  level: NewsLevel;
}

/** Hours of headlines that count towards a chokepoint's news level. */
export const CHOKEPOINT_WINDOW_HOURS = 72;

/**
 * How much each chokepoint is in the headlines: the number of stories in the last
 * `windowHours` that name it. Heavy: 4 or more, or any FLASH story. A news-flow gauge, not vessel data.
 */
export function chokepointNews(items: IntelItem[], nowMs: number, windowHours = CHOKEPOINT_WINDOW_HOURS): ChokepointNews[] {
  const since = nowMs - windowHours * 3_600_000;
  return CHOKEPOINTS.map((spec) => {
    const hits = items
      .filter((i) => Date.parse(i.publishedAt) >= since && spec.match.test(`${i.title} ${i.description}`))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const level: NewsLevel = hits.length === 0 ? 'quiet' : hits.length >= 4 || hits.some((h) => h.severity === 'FLASH') ? 'heavy' : 'in_news';
    return { spec, count: hits.length, latest: hits[0] ?? null, level };
  });
}

// ------ Map Markers ------

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  name: string;
  type: 'mining' | 'shipping' | 'conflict' | 'chokepoint' | 'energy';
  severity: 'critical' | 'warning' | 'info';
  label?: string;
}

/** Major mines and mining regions, shown for reference (no live status). */
const MINING_SITES: MapMarker[] = [
  { id: 'mine-sa-gold', lat: -26.2, lng: 28.0, name: 'Witwatersrand gold', type: 'mining', severity: 'info' },
  { id: 'mine-chile-cu', lat: -24.3, lng: -69.1, name: 'Escondida copper', type: 'mining', severity: 'info' },
  { id: 'mine-peru-ag', lat: -15.5, lng: -75.1, name: 'Peru silver and copper belt', type: 'mining', severity: 'info' },
  { id: 'mine-congo-co', lat: -10.7, lng: 25.5, name: 'Katanga copper and cobalt', type: 'mining', severity: 'info' },
  { id: 'mine-aus-li', lat: -33.9, lng: 116.1, name: 'Greenbushes lithium', type: 'mining', severity: 'info' },
  { id: 'mine-russia-ni', lat: 69.3, lng: 88.2, name: 'Norilsk nickel and palladium', type: 'mining', severity: 'info' },
  { id: 'mine-indo-ni', lat: -2.0, lng: 121.5, name: 'Sulawesi nickel', type: 'mining', severity: 'info' },
  { id: 'mine-mexico-ag', lat: 23.6, lng: -105.4, name: 'Mexico silver', type: 'mining', severity: 'info' },
  { id: 'mine-brazil-fe', lat: -20.0, lng: -44.0, name: 'Minas Gerais iron ore', type: 'mining', severity: 'info' },
];

const LEVEL_SEVERITY: Record<NewsLevel, MapMarker['severity']> = { quiet: 'info', in_news: 'warning', heavy: 'critical' };

/** Places named in the headlines, the chokepoints coloured by their news level, and reference mines. */
export function deriveMapMarkers(intelItems: IntelItem[], chokepoints: ChokepointNews[]): MapMarker[] {
  const markers: MapMarker[] = [];
  const seen = new Set<string>();

  for (const item of intelItems) {
    if (item.location && !seen.has(item.location.name)) {
      seen.add(item.location.name);
      markers.push({
        id: item.id,
        lat: item.location.lat,
        lng: item.location.lng,
        name: item.location.name,
        type: item.category === 'MINING' ? 'mining' : item.category === 'MARITIME' ? 'shipping' : item.category === 'MILITARY' ? 'conflict' : 'energy',
        severity: item.severity === 'FLASH' ? 'critical' : item.severity === 'ALERT' ? 'warning' : 'info',
        label: item.title.slice(0, 90),
      });
    }
  }

  for (const cp of chokepoints) {
    if (seen.has(cp.spec.name)) continue;
    markers.push({
      id: `cp-${cp.spec.id}`,
      lat: cp.spec.lat,
      lng: cp.spec.lng,
      name: cp.spec.name,
      type: 'chokepoint',
      severity: LEVEL_SEVERITY[cp.level],
      label: cp.count > 0 ? `${cp.count} headline${cp.count === 1 ? '' : 's'} in ${CHOKEPOINT_WINDOW_HOURS} h${cp.latest ? `: ${cp.latest.title.slice(0, 80)}` : ''}` : `No headlines in ${CHOKEPOINT_WINDOW_HOURS} h`,
    });
  }
  for (const ms of MINING_SITES) {
    if (!seen.has(ms.name)) markers.push({ ...ms, label: 'Reference site' });
  }

  return markers;
}

// ------ Stack Tracker Helpers (client-side localStorage) ------

export function calculateStackSummary(holdings: StackHolding[], prices: PricePoint[]): StackSummary {
  const priceMap: Record<string, number> = {};
  for (const p of prices) {
    priceMap[p.name.toLowerCase()] = p.price;
  }

  const metalSummaries: Record<string, { totalOz: number; totalValue: number; totalCost: number }> = {};

  for (const h of holdings) {
    const metal = h.metal.toLowerCase();
    let ozAmount = h.weight;
    if (h.weightUnit === 'g') ozAmount = h.weight / 31.1035;
    else if (h.weightUnit === 'kg') ozAmount = (h.weight * 1000) / 31.1035;

    const currentPrice = priceMap[metal] || 0;
    const currentValue = ozAmount * currentPrice;

    if (!metalSummaries[metal]) {
      metalSummaries[metal] = { totalOz: 0, totalValue: 0, totalCost: 0 };
    }
    metalSummaries[metal].totalOz += ozAmount;
    metalSummaries[metal].totalValue += currentValue;
    metalSummaries[metal].totalCost += h.purchasePrice;
  }

  let totalValueUsd = 0;
  let totalCostBasis = 0;
  const holdingsSummary = Object.entries(metalSummaries).map(([metal, data]) => {
    totalValueUsd += data.totalValue;
    totalCostBasis += data.totalCost;
    const gl = data.totalValue - data.totalCost;
    return {
      metal: metal.charAt(0).toUpperCase() + metal.slice(1),
      totalOz: data.totalOz,
      totalValue: data.totalValue,
      totalCost: data.totalCost,
      gainLoss: gl,
      gainLossPercent: data.totalCost > 0 ? (gl / data.totalCost) * 100 : 0,
    };
  });

  const totalGainLoss = totalValueUsd - totalCostBasis;
  return {
    totalValueUsd,
    totalCostBasis,
    totalGainLoss,
    totalGainLossPercent: totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0,
    holdings: holdingsSummary,
  };
}
