/** Keyword geolocation for headlines, used by the intel map and as an LLM location hint. */

export interface GeoPoint {
  lat: number;
  lng: number;
  name: string;
}

export const GEOLOCATION_KEYWORDS: Record<string, GeoPoint> = {
  hormuz: { lat: 26.5, lng: 56.3, name: "Strait of Hormuz" },
  "red sea": { lat: 20.0, lng: 38.0, name: "Red Sea" },
  suez: { lat: 30.0, lng: 32.5, name: "Suez Canal" },
  panama: { lat: 9.0, lng: -79.5, name: "Panama Canal" },
  malacca: { lat: 2.5, lng: 101.5, name: "Strait of Malacca" },
  taiwan: { lat: 23.5, lng: 121.0, name: "Taiwan Strait" },
  "black sea": { lat: 43.0, lng: 34.0, name: "Black Sea" },
  baltic: { lat: 58.0, lng: 20.0, name: "Baltic Sea" },
  congo: { lat: -4.3, lng: 15.3, name: "Congo" },
  ukraine: { lat: 48.4, lng: 31.2, name: "Ukraine" },
  russia: { lat: 55.8, lng: 37.6, name: "Russia" },
  iran: { lat: 32.4, lng: 53.7, name: "Iran" },
  israel: { lat: 31.0, lng: 34.9, name: "Israel" },
  china: { lat: 35.9, lng: 104.2, name: "China" },
  saudi: { lat: 23.9, lng: 45.1, name: "Saudi Arabia" },
  qatar: { lat: 25.3, lng: 51.2, name: "Qatar" },
  pakistan: { lat: 30.4, lng: 69.3, name: "Pakistan" },
  india: { lat: 20.6, lng: 79.0, name: "India" },
  "south africa": { lat: -30.6, lng: 22.9, name: "South Africa" },
  australia: { lat: -25.3, lng: 133.8, name: "Australia" },
  chile: { lat: -35.7, lng: -71.5, name: "Chile" },
  peru: { lat: -9.2, lng: -75.0, name: "Peru" },
  brazil: { lat: -14.2, lng: -51.9, name: "Brazil" },
  indonesia: { lat: -0.8, lng: 113.9, name: "Indonesia" },
  philippines: { lat: 12.9, lng: 121.8, name: "Philippines" },
  yemen: { lat: 15.6, lng: 48.5, name: "Yemen" },
  houthi: { lat: 15.4, lng: 44.2, name: "Yemen (Houthi)" },
  libya: { lat: 26.3, lng: 17.2, name: "Libya" },
  nigeria: { lat: 9.1, lng: 8.7, name: "Nigeria" },
  iraq: { lat: 33.2, lng: 43.7, name: "Iraq" },
  "united states": { lat: 38.9, lng: -77.0, name: "United States" },
  "federal reserve": { lat: 38.9, lng: -77.0, name: "United States" },
  gold: { lat: -30.6, lng: 22.9, name: "South Africa" },
  copper: { lat: -35.7, lng: -71.5, name: "Chile" },
  silver: { lat: 23.6, lng: -102.6, name: "Mexico" },
  lithium: { lat: -22.3, lng: -65.0, name: "Bolivia" },
};

/** First matching location in insertion order, or undefined. */
export function extractLocation(text: string): GeoPoint | undefined {
  const lower = text.toLowerCase();
  for (const [keyword, loc] of Object.entries(GEOLOCATION_KEYWORDS)) {
    if (lower.includes(keyword)) return loc;
  }
  return undefined;
}
