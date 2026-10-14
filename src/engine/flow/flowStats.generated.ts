/**
 * PLACEHOLDER. The research synthesis step overwrites this file with statistics measured on real
 * option data (see flowStatsTypes.ts). Until then it holds no rules and no numbers.
 */
import type { FlowStatsFile } from "./flowStatsTypes";

export const FLOW_STATS: FlowStatsFile = {
  generatedAt: "",
  source: "placeholder",
  method: "placeholder",
  rules: [],
  entryTimes: { NIFTY: [], SENSEX: [] },
  baselines: { volumeMedian: {}, oiChangeP90Pct: {} },
  honestSummary: ["Historical statistics are being computed."],
};
