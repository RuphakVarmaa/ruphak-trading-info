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
  /\b(rate cuts?|cuts? (the )?(repo |key |policy |interest )?rates?|easing|stimulus|ceasefire|truce|peace (deal|talks)|deal (signed|reached)|trade (deal|pact|agreement)|record (high|inflows?|collections?)|biggest inflow|inflows?|pour(s|ed)? [^.;]{0,30}into|upgrade[sd]?|upgrades? [^.;]{0,30}rating|beats? (estimates|expectations|forecasts?)|surges?|rall(y|ies)|soars?|jumps?|dovish|reform|tax cut|boosts?|wins? [^.;]{0,30}(deal|order|contract)|raises? [^.;]{0,20}(outlook|guidance)|above[- ]normal|cheers?|rate-cut hopes|revives?|improves?|net buy(ers|ing)?)\b/i;

export const BEARISH_TERMS =
  /\b(war|attack(s|ed)?|missile|strikes? on|cross-border strikes?|invasion|sanctions?|blockade|rate hikes?|hawkish|higher for longer|pushes? back on rate-cut|rate-cut bets fade|outflows?|pull(s|ed)? out|dump(s|ed)?|sell-?off|risk-off|hikes? (the )?(repo |key |policy |interest )?rates?|raises? (the )?(repo |key |policy |interest )?rates?|(raises?|hikes?|higher) [^.;]{0,30}\btax(es)?|downgrade[sd]?|negative outlook|outlook to negative|slippage|misses? (estimates|expectations|forecasts?)|earnings miss|guidance cut|cuts? [^.;]{0,25}guidance|profit warning|crash(es)?|plunges?|slumps?|tumbles?|recession|default|crisis|tariffs? (hike|raised|imposed)|tariffs? on|escalat(es|ion|e)|terror|deficit widens?|deficient|below[- ]normal|weak(ness)?|earthquake|quake|cyclone|floods?|jolts?|spooks?|cautious|lags?|net sell(ers|ing)?)\b/i;

const UP = "(jumps?|surges?|soars?|spikes?|rises?|climbs?|rall(?:y|ies)|hits? (?:a )?(?:\\d+-\\w+ |record )?high|hotter|accelerates?|strengthens?|firms?)";
const DOWN = "(falls?|drops?|slumps?|plunges?|tumbles?|slides?|eases?|cools?|softens?|weakens?|declines?|hits? (?:a )?(?:\\d+-\\w+ |record )?low)";
const phrase = (subject: string, verbs: string) => new RegExp(`\\b(${subject})\\b[^.;]{0,40}?\\b${verbs}\\b`, "gi");

/**
 * Subject + verb phrases whose direction depends on the subject, applied before the generic
 * terms (and removed from the text so their verbs are not counted twice). India imports most of
 * its oil, so rising crude is bearish; rising inflation, yields, the dollar or volatility are
 * bearish; a weakening rupee is bearish.
 */
const PHRASES: [RegExp, -1 | 1][] = [
  [phrase("oil|crude|brent|wti", UP), -1],
  [phrase("oil|crude|brent|wti", DOWN), 1],
  [phrase("inflation|cpi|wpi", UP), -1],
  [phrase("inflation|cpi|wpi", DOWN), 1],
  [phrase("yields?|treasur(?:y|ies)", UP), -1],
  [phrase("yields?|treasur(?:y|ies)", DOWN), 1],
  [phrase("dollar|dxy|greenback", UP), -1],
  [phrase("dollar|dxy|greenback", DOWN), 1],
  [phrase("rupee|inr", DOWN), -1],
  [phrase("rupee|inr", UP), 1],
  [phrase("vix|volatility", UP), -1],
];

/** -1, 0 or +1 from polarity keywords; ties resolve to 0. */
export function lexiconPolarity(text: string): -1 | 0 | 1 {
  let rest = text;
  let bull = 0;
  let bear = 0;
  for (const [re, sign] of PHRASES) {
    const n = (rest.match(re) ?? []).length;
    if (n === 0) continue;
    if (sign > 0) bull += 2 * n;
    else bear += 2 * n;
    rest = rest.replace(re, " ");
  }
  bull += (rest.match(new RegExp(BULLISH_TERMS.source, "gi")) ?? []).length;
  bear += (rest.match(new RegExp(BEARISH_TERMS.source, "gi")) ?? []).length;
  if (bull > bear) return 1;
  if (bear > bull) return -1;
  return 0;
}
