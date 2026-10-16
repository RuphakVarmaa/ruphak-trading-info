/**
 * Fixed text the advisor always carries: the project's measured findings (one line each, from
 * docs/research/options-trading-plan.md §0, §13 and §15), the standing honesty line, and the reputable
 * finance-news domains the web research may read. Changing a finding here means the research changed.
 */

/** The project's main measured findings, one line each, with the section they come from. */
export const RESEARCH_FINDINGS: readonly string[] = [
  "3,303 rule variants were tested on real NIFTY and SENSEX option prices (2019–2026); none gives an option buyer a proven edge after costs (§0, §15).",
  "SEBI: 87.7% of individual F&O traders lost money in FY26; 97% of individuals are mostly option buyers (§1, §13).",
  "Buying in the first 15 minutes is the most expensive time: an hour's hold bought at 09:15 cost ₹2,176 a NIFTY lot vs ₹818 bought at 09:30 (§0).",
  "Expiry day 14:00–15:00 is the worst hour to hold a bought option: about 15% of the premium is lost (§0).",
  "Holding an at-the-money weekly to expiry roughly doubled the loss (₹547 sold the same day vs ₹1,153 held); half expired worthless (§0, §7).",
  "If buying at all: at the money or 1 strike in the money, at least 4 days to expiry, out the same day (§0).",
  "FII cash figures come out after the close; they match that day's move but say nothing about the next day (correlation 0.00 over 1,877 days). Context, never a signal (§0, WP14).",
  "ADX, moving averages and 'selling pressure' called the next day's direction 41–52% of the time; India VIX predicts the size of the move, not its direction (§0, §8).",
  "The opening gap can be estimated before 09:15 (GIFT Nifty; 71% right on direction), but the gap does not tell the day: gap-up days closed above their open 48% of the time (§0).",
  "Holding options overnight lost ₹241–567 a NIFTY lot a night on real prices; hold nothing overnight (rule N5, WP15).",
  "Far out-of-the-money 'cheap' strikes, the session before a scheduled event, and the days after a VIX jump are on the no-trade list (§0, §4).",
  "Selling premium did not pass either: unprotected short straddles lost up to ₹41,362 a lot in one day; with protective wings the gain disappears (WP10, WP13).",
  "A weekly bull put spread needs at least ₹13,355 of margin a lot, more than a ₹10,000 account (WP16).",
  "What the data does support is holding the index for years: NIFTY returned 8.8% a year 2007–2026, with falls of −60% (2008) and −38% (2020) on the way (§13).",
];

/** The standing caution printed under every brief. */
export const HONESTY_LINE =
  "This project's research tested 3,303 rule variants on real NIFTY and SENSEX option prices and found no proven edge for buying options; about 9 in 10 retail F&O traders lost money in FY26. Treat every idea here as decision support, not a promise: size small, use the stop, and never trade money you cannot afford to lose.";

/** Reputable finance-news domains the web research may read (exchanges' own sites are left out on purpose). */
export const RESEARCH_DOMAINS: readonly string[] = [
  "moneycontrol.com",
  "economictimes.indiatimes.com",
  "livemint.com",
  "business-standard.com",
  "thehindubusinessline.com",
  "reuters.com",
  "cnbctv18.com",
  "financialexpress.com",
  "ndtvprofit.com",
  "bloomberg.com",
];

/** Topics the brief's "things you may not know" may draw on (the model adds its own). */
export const ALSO_KNOW_TOPICS: readonly string[] = [
  "what India VIX measures",
  "IV skew (puts usually priced richer than calls)",
  "max pain pull near expiry",
  "rollover at the monthly expiry",
  "results season",
  "theta (time decay) speeding up in the last days",
  "overnight gap risk",
  "lot sizes and margin",
  "taxes and charges on F&O (STT, exchange fees, GST, stamp duty; F&O profit is business income)",
  "SEBI's F&O rules (bigger contract sizes, fewer weekly expiries, upfront premium)",
  "thin liquidity and wide spreads at far strikes",
];
