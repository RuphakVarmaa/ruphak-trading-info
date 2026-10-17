/**
 * The research → live bridge contract. The research build writes `flowStats.generated.ts` (FLOW_STATS) with
 * statistics measured on real option prices; the live flow monitor (flowMonitor.ts) and the recommendation
 * (recommend.ts) read it through flowStats.ts. Nothing in it is typed by hand.
 */
export interface RuleStats {
  /** Stable id, e.g. "OI_SHORT_COVERING_CE", "VOL_SPIKE_ATM", "ORB_BULL_OI_CONFIRM". */
  id: string;
  title: string; // plain words for the card
  description: string; // the exact rule, plain words
  index: "NIFTY" | "SENSEX" | "BOTH";
  side: "CE" | "PE" | "EITHER";
  /** Measured on real data, never typed by hand. */
  sample: number; // trades in the out-of-sample (test) part
  inSample: number;
  hitRate: number; // share of test trades that made money after charges (0..1)
  avgPnlPerLot: number; // ₹ after charges, test part, one lot
  medianPnlPerLot: number;
  avgHoldMin: number;
  ci95: [number, number]; // ₹ per lot, day-block bootstrap on the test part
  bestEntryWindow: string; // e.g. "09:45–11:15 IST"
  targetPct: number; // the premium target used (e.g. 40)
  stopPct: number; // e.g. -25
  timeExit: string; // e.g. "13:30 IST"
  dataRange: string; // e.g. "2026-08-14..2026-10-14 (Upstox, monthly + listed weeklies) + 2021-05..2026-08 (TradeMarkk weeklies)"
  verdict: "positive" | "not_proven" | "negative"; // positive ONLY if ci95[0] > 0 on the test part
  notes: string[];
  /** Thresholds the live detector must use (names are rule-specific, documented in description). */
  params: Record<string, number>;
}
export interface EntryTimeStats {
  window: string;
  avgPremiumDecayPctPerHour: number;
  avgAbsIndexMovePct: number;
  costPerPointMove: number;
  sample: number;
}
export interface FlowStatsFile {
  generatedAt: string;
  source: string;
  method: string;
  rules: RuleStats[];
  entryTimes: { NIFTY: EntryTimeStats[]; SENSEX: EntryTimeStats[] };
  baselines: {
    /** median 1-minute volume by index, minute-of-day bucket (15-min) and moneyness bucket (ATM, ±1, ±2, ±3+), used for spike detection */
    volumeMedian: Record<string, number>;
    /** typical 15-min |ΔOI| % at ATM±2 */
    oiChangeP90Pct: Record<string, number>;
  };
  honestSummary: string[]; // 3-6 plain sentences the dashboard prints verbatim
}
