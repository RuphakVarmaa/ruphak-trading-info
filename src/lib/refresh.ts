/**
 * How often the dashboard refreshes, set by the owner (14 Oct 2026): every second for what you act on
 * (index prices, the "What to do now" strip, open-trade marks), every two seconds for everything else
 * while the market is open or in pre-open, and every 10 minutes once it has closed. Change these three
 * numbers to change the whole site. Upstox is never polled at this rate: the engine serves these reads
 * from its own short caches and the broker's streaming feed.
 */
export const REFRESH_IMPORTANT_MS = 1_000;
export const REFRESH_OTHER_MS = 2_000;
export const REFRESH_CLOSED_MS = 10 * 60_000;
