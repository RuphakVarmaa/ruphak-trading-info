/**
 * Zero-cost text classifiers. They power the metals intel feed, pre-filter articles before
 * LLM scoring, and drive the fallback scorer when the LLM is unavailable.
 */

export type IntelCategory = "MINING" | "ENERGY" | "MILITARY" | "MARITIME";
export type IntelSeverity = "FLASH" | "ALERT" | "UPDATE";

export function classifyCategory(text: string): IntelCategory {
  const lower = text.toLowerCase();
  if (/mine|mining|ore|mineral|lithium|cobalt|copper|gold|silver|platinum/.test(lower)) return "MINING";
  if (/oil|gas|energy|petroleum|opec|refiner|lng|crude|fuel/.test(lower)) return "ENERGY";
  if (/military|navy|army|missile|weapon|war|conflict|defense|troops|drone|strike/.test(lower)) return "MILITARY";
  if (/ship|maritime|port|vessel|tanker|cargo|strait|canal|chokepoint|pirate|blockade/.test(lower)) return "MARITIME";
  return "ENERGY";
}

export function classifySeverity(text: string): IntelSeverity {
  const lower = text.toLowerCase();
  if (/breaking|urgent|critical|attack|explosion|war|strike|block/.test(lower)) return "FLASH";
  if (/warning|risk|threat|disruption|sanction|escalat/.test(lower)) return "ALERT";
  return "UPDATE";
}

export function extractTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  if (/gold/.test(lower)) tags.push("Gold");
  if (/silver/.test(lower)) tags.push("Silver");
  if (/copper/.test(lower)) tags.push("Copper");
  if (/oil|crude|petroleum/.test(lower)) tags.push("Oil");
  if (/uranium/.test(lower)) tags.push("Uranium");
  if (/lithium/.test(lower)) tags.push("Lithium");
  if (/treasur/.test(lower)) tags.push("Treasuries");
  if (/usd|dollar/.test(lower)) tags.push("USD");
  if (/platinum/.test(lower)) tags.push("Platinum");
  if (/palladium/.test(lower)) tags.push("Palladium");
  return tags.length > 0 ? tags : ["Geopolitics"];
}

/** Terms that make a story directly relevant to Indian equity indices. */
export const INDIA_TERMS =
  /\b(india|indian|nifty|sensex|bse|nse|rbi|reserve bank of india|sebi|rupee|inr|dalal street|fii|fpi|dii|modi|sitharaman|finance ministry|gst council|monsoon|mumbai|delhi|reliance|hdfc|icici|infosys|tcs|sbi|adani|tata|bharti|airtel|l&t|larsen|kotak|axis bank|itc|hindustan unilever|maruti|mahindra|bajaj)\b/i;

/** Terms for global macro drivers that transmit to Indian indices. */
export const GLOBAL_MACRO_TERMS =
  /\b(federal reserve|fed|fomc|powell|treasury|yields?|dollar index|dxy|crude|brent|opec|oil price|inflation|cpi|payrolls|recession|tariffs?|sanctions?|china|pboc|yuan|ecb|boj|nasdaq|s&p 500|wall street|war|missile|ceasefire|strait of hormuz|red sea|houthi|iran|israel|ukraine|russia|taiwan)\b/i;

/** True when the text is plausibly relevant to NIFTY/SENSEX (used to pre-filter before LLM scoring). */
export function isMarketRelevant(text: string): boolean {
  return INDIA_TERMS.test(text) || GLOBAL_MACRO_TERMS.test(text);
}

export const BULLISH_TERMS =
  /\b(rate cut|cuts? rates?|eases?|easing|stimulus|ceasefire|truce|peace (deal|talks)|deal (signed|reached)|record (high|inflows?)|inflows?|upgrade[sd]?|beats? (estimates|expectations)|surges?|rall(y|ies)|soars?|jumps?|cools?|slows? (inflation)?|dovish|reform|tax cut|boost)\b/i;

export const BEARISH_TERMS =
  /\b(war|attack(s|ed)?|missile|strikes? on|invasion|sanctions?|blockade|rate hike|hikes? rates?|hawkish|outflows?|sell-?off|downgrade[sd]?|misses? (estimates|expectations)|crash(es)?|plunges?|slumps?|tumbles?|recession|default|crisis|surges? in (oil|crude)|oil (spikes?|surges?)|tariffs? (hike|raised|imposed)|escalat(es|ion)|terror)\b/i;

/** -1, 0 or +1 from polarity keywords; ties resolve to 0. */
export function lexiconPolarity(text: string): -1 | 0 | 1 {
  const bull = (text.match(new RegExp(BULLISH_TERMS.source, "gi")) ?? []).length;
  const bear = (text.match(new RegExp(BEARISH_TERMS.source, "gi")) ?? []).length;
  if (bull > bear) return 1;
  if (bear > bull) return -1;
  return 0;
}
