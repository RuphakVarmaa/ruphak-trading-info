/**
 * A strict place finder for news text (pure, browser-safe).
 *
 * It only names a place the text itself names: word-bounded patterns, the earliest match in the
 * text wins, and the title decides before the summary. There are no commodity proxies ("gold" is
 * not South Africa). Central banks may stand for their country ("RBI" → India), and such a match
 * says so (`via: "institution"`). A text that names no place gets no place, and neither does a name
 * that only appears inside a proper noun about something else ("Panama Papers", "Washington Post").
 *
 * The shipping chokepoints reuse CHOKEPOINTS from @/utils/api (same ids, names and coordinates).
 */
import { CHOKEPOINTS } from "@/utils/api";

export type PlaceKind = "chokepoint" | "sea" | "country" | "region" | "city";

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Word-bounded pattern (no `g` flag). */
  terms: RegExp;
}

const place = (id: string, name: string, lat: number, lng: number, kind: PlaceKind, terms: RegExp): Place => ({ id, name, lat, lng, kind, terms });

/** Chokepoints first: the same entries as CHOKEPOINTS, so the map has one source of truth. */
const CHOKEPOINT_PLACES: Place[] = CHOKEPOINTS.map((c) => place(c.id, c.name, c.lat, c.lng, "chokepoint", new RegExp(c.match.source, c.match.flags.replace("g", ""))));

const OTHER_PLACES: Place[] = [
  // Seas and regions
  place("SOUTH_CHINA_SEA", "South China Sea", 12.0, 114.0, "sea", /\bsouth china sea\b/i),
  place("PERSIAN_GULF", "Persian Gulf", 27.0, 51.5, "sea", /\b(?:persian|arabian) gulf\b/i),
  place("INDIAN_OCEAN", "Indian Ocean", -10.0, 75.0, "sea", /\bindian ocean\b/i),
  place("MIDDLE_EAST", "Middle East", 29.0, 45.0, "region", /\bmiddle east(?:ern)?\b|\bmideast\b/i),
  place("EU", "Euro area", 50.1, 8.7, "region", /\beuro ?(?:zone|area)\b|\beuropean union\b/i),
  // Countries (country name and its adjective)
  place("IN", "India", 20.6, 79.0, "country", /\bindian?s?\b/i),
  place("US", "United States", 38.9, -77.0, "country", /\bUnited States\b|\bU\.S\.(?:A\.)?(?![A-Za-z])|\bUSA?(?![A-Za-z0-9])/),
  place("CN", "China", 35.9, 104.2, "country", /\bchina\b|\bchinese\b/i),
  place("TW", "Taiwan", 23.7, 121.0, "country", /\btaiwan(?:ese)?\b/i),
  place("JP", "Japan", 36.2, 138.3, "country", /\bjapan(?:ese)?\b/i),
  place("KR", "South Korea", 36.5, 127.9, "country", /\bsouth korea(?:n)?\b/i),
  place("PK", "Pakistan", 30.4, 69.3, "country", /\bpakistan(?:i)?\b/i),
  place("BD", "Bangladesh", 23.7, 90.4, "country", /\bbangladesh(?:i)?\b/i),
  place("LK", "Sri Lanka", 7.9, 80.8, "country", /\bsri lanka(?:n)?\b/i),
  place("RU", "Russia", 55.8, 37.6, "country", /\brussia(?:n|ns)?\b/i),
  place("UA", "Ukraine", 48.4, 31.2, "country", /\bukrain(?:e|ian|ians)\b/i),
  place("IR", "Iran", 32.4, 53.7, "country", /\biran(?:ian|ians)?\b/i),
  place("IL", "Israel", 31.0, 34.9, "country", /\bisrael(?:i|is)?\b/i),
  place("SA", "Saudi Arabia", 23.9, 45.1, "country", /\bsaudi(?:s| arabia(?:n)?)?\b/i),
  place("QA", "Qatar", 25.3, 51.2, "country", /\bqatar(?:i)?\b/i),
  place("AE", "United Arab Emirates", 24.4, 54.4, "country", /\bUAE\b|\bunited arab emirates\b|\bemirat(?:i|es)\b/i),
  place("IQ", "Iraq", 33.2, 43.7, "country", /\biraq(?:i|is)?\b/i),
  place("YE", "Yemen", 15.6, 48.5, "country", /\byemen(?:i)?\b/i),
  place("LY", "Libya", 26.3, 17.2, "country", /\blibya(?:n)?\b/i),
  place("EG", "Egypt", 26.8, 30.8, "country", /\begypt(?:ian)?\b/i),
  place("TR", "Turkey", 39.0, 35.2, "country", /\bturkey\b|\bt[uü]rkiye\b|\bturkish\b/i),
  place("NG", "Nigeria", 9.1, 8.7, "country", /\bnigeria(?:n)?\b/i),
  place("ZA", "South Africa", -30.6, 22.9, "country", /\bsouth africa(?:n)?\b/i),
  place("CD", "DR Congo", -4.3, 15.3, "country", /\bcongo(?:lese)?\b/i),
  place("GB", "United Kingdom", 51.5, -0.1, "country", /\bUK\b|\bU\.K\.(?![A-Za-z])|\bunited kingdom\b|\bbritain\b|\bbritish\b/),
  place("DE", "Germany", 51.2, 10.4, "country", /\bgerman(?:y)?\b/i),
  place("FR", "France", 46.2, 2.2, "country", /\bfrance\b|\bfrench\b/i),
  place("AU", "Australia", -25.3, 133.8, "country", /\baustralia(?:n)?\b/i),
  place("ID", "Indonesia", -0.8, 113.9, "country", /\bindonesia(?:n)?\b/i),
  place("PH", "Philippines", 12.9, 121.8, "country", /\bphilippines?\b|\bfilipino\b/i),
  place("BR", "Brazil", -14.2, -51.9, "country", /\bbrazil(?:ian)?\b/i),
  place("CL", "Chile", -35.7, -71.5, "country", /\bchile(?:an)?\b/i),
  place("PE", "Peru", -9.2, -75.0, "country", /\bperu(?:vian)?\b/i),
  place("MX", "Mexico", 23.6, -102.6, "country", /\bmexic(?:o|an)\b/i),
  place("PA", "Panama", 8.5, -80.8, "country", /\bpanama(?:nian)?\b(?!\s+papers)/i),
  place("VE", "Venezuela", 6.4, -66.6, "country", /\bvenezuela(?:n)?\b/i),
  place("CA", "Canada", 56.1, -106.3, "country", /\bcanad(?:a|ian)\b/i),
  // Cities
  place("MUMBAI", "Mumbai", 19.08, 72.88, "city", /\bmumbai\b/i),
  place("DELHI", "New Delhi", 28.61, 77.21, "city", /\b(?:new )?delhi\b/i),
  place("BEIJING", "Beijing", 39.9, 116.4, "city", /\bbeijing\b/i),
  place("MOSCOW", "Moscow", 55.76, 37.62, "city", /\bmoscow\b/i),
  place("KYIV", "Kyiv", 50.45, 30.52, "city", /\bkyiv\b|\bkiev\b/i),
  place("TEHRAN", "Tehran", 35.69, 51.39, "city", /\btehran\b/i),
  place("WASHINGTON", "Washington", 38.9, -77.04, "city", /\bwashington\b(?!\s+post)/i),
];

/** Every place the finder knows: chokepoints, then seas and regions, countries and cities. */
export const PLACES: readonly Place[] = [...CHOKEPOINT_PLACES, ...OTHER_PLACES];

const PLACE_BY_ID = new Map(PLACES.map((p) => [p.id, p]));

export function placeById(id: string): Place | null {
  return PLACE_BY_ID.get(id) ?? null;
}

/**
 * Central banks only, each standing for its country or currency area. Regulators and market words
 * (SEBI, Nifty, Sensex, FII, FPI, Dalal Street) are not places.
 */
export const INSTITUTION_ALIASES: readonly { term: RegExp; placeId: string }[] = [
  { term: /\bRBI\b|\bReserve Bank of India\b/, placeId: "IN" },
  { term: /\bFederal Reserve\b|\bFed\b|\bFOMC\b/, placeId: "US" },
  { term: /\bPBOC\b|\bPBoC\b|\bPeople's Bank of China\b/, placeId: "CN" },
  { term: /\bECB\b|\bEuropean Central Bank\b/, placeId: "EU" },
  { term: /\bBoJ\b|\bBOJ\b|\bBank of Japan\b/, placeId: "JP" },
];

export type PlaceField = "title" | "summary";

export interface PlaceMatch {
  place: Place;
  /** The words in the text that named it ("Red Sea", "RBI"). */
  term: string;
  field: PlaceField;
  /** Character offset of the match in its field. */
  at: number;
  via: "name" | "institution";
}

export interface PlaceOptions {
  /** Let central banks stand for their country (default true). */
  institutions?: boolean;
}

interface RawMatch {
  place: Place;
  term: string;
  at: number;
  end: number;
  via: "name" | "institution";
}

/** Every place the text names, in text order, one per place. When two matches overlap, the longer wins. */
export function findPlaces(text: string, field: PlaceField, opts: PlaceOptions = {}): PlaceMatch[] {
  if (!text) return [];
  const raw: RawMatch[] = [];
  for (const p of PLACES) {
    const m = p.terms.exec(text);
    if (m && m[0].length > 0) raw.push({ place: p, term: m[0], at: m.index, end: m.index + m[0].length, via: "name" });
  }
  if (opts.institutions !== false) {
    for (const alias of INSTITUTION_ALIASES) {
      const p = PLACE_BY_ID.get(alias.placeId);
      const m = alias.term.exec(text);
      if (p && m) raw.push({ place: p, term: m[0], at: m.index, end: m.index + m[0].length, via: "institution" });
    }
  }
  // Longer matches first, so an overlapping shorter one ("Taiwan" inside "Taiwan Strait") is dropped.
  raw.sort((a, b) => b.end - b.at - (a.end - a.at) || a.at - b.at);
  const kept: RawMatch[] = [];
  for (const r of raw) {
    if (kept.some((k) => r.at < k.end && k.at < r.end)) continue;
    kept.push(r);
  }
  kept.sort((a, b) => a.at - b.at || (a.via === "name" ? -1 : 1));
  const seen = new Set<string>();
  const out: PlaceMatch[] = [];
  for (const k of kept) {
    if (seen.has(k.place.id)) continue;
    seen.add(k.place.id);
    out.push({ place: k.place, term: k.term, field, at: k.at, via: k.via });
  }
  return out;
}

export interface PlacedText {
  primary: PlaceMatch | null;
  also: PlaceMatch[];
}

/** The title decides first; the summary is read only when the title names no place. */
export function placeText(title: string, summary?: string | null, opts: PlaceOptions = {}): PlacedText {
  const fromTitle = findPlaces(title, "title", opts);
  const matches = fromTitle.length > 0 ? fromTitle : findPlaces(summary ?? "", "summary", opts);
  return { primary: matches[0] ?? null, also: matches.slice(1) };
}

/** "placed by 'RBI'" for an institution match, else "named: Red Sea". Shown next to the place. */
export function placeReason(m: PlaceMatch): string {
  return m.via === "institution" ? `placed by '${m.term}'` : `named in the ${m.field}: '${m.term}'`;
}
