/**
 * PLACEHOLDER. The research synthesis overwrites this file with statistics measured on real option prices.
 * Until then there are no rules, no entry-time statistics and no baselines: the live monitor falls back to
 * the session's own running medians and the recommendation can never grade a trade "A".
 */
import type { FlowStatsFile } from "./flowStatsTypes";

export const FLOW_STATS: FlowStatsFile = {
  generatedAt: "",
  source: "placeholder",
  method: "Not computed yet.",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Historical statistics are being computed."],
};
