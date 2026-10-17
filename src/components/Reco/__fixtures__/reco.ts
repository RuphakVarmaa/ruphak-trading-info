/** Hand-built RecommendationViews for the card helpers' tests (made-up values; never shown on a page). */
import type { UiReco as RecommendationView } from "@/components/Flow/uiTypes";

export const ENTER: RecommendationView = {
  status: "ENTER",
  index: "NIFTY",
  grade: "C",
  capital: 10_000,
  contract: { strike: 22500, optionType: "CE", expiry: "2026-10-20", tradingSymbol: "NIFTY26O2022500CE", lotSize: 65, label: "NIFTY 20-OCT-2026 22500 CE" },
  entry: { limit: 142.5, validUntil: "2026-10-14T10:48:00+05:30", trigger: "Now, while NIFTY holds above 22,480" },
  stop: { premium: 99.75, index: 22431 },
  target: { t1: 213.75, t2: 256.5, indexT1: 22655 },
  timeExit: "13:30 IST",
  lots: 1,
  costRupees: 9262.5,
  riskRupees: 2843.75,
  rewardRupees: 4568.13,
  rr: 1.61,
  reasons: ["Put writers added 6.8L in 15 min at 22400", "Premium fits one lot in ₹10,000"],
  historical: { ruleIds: ["OI_SHORT_COVERING_CE"], sample: 142, hitRate: 0.41, avgPnlPerLot: -212.4, ci95: [-480.2, 51.3], verdict: "not_proven", dataRange: "2026-08-14..2026-10-14" },
  honestLine: "Not proven: over 142 test trades this rule averaged −₹212 a lot after charges.",
  asOf: "2026-10-14T10:45:00+05:30",
};

export const WAIT: RecommendationView = {
  ...ENTER,
  status: "WAIT",
  index: "SENSEX",
  contract: null,
  entry: null,
  stop: null,
  target: null,
  timeExit: null,
  lots: 0,
  costRupees: 0,
  riskRupees: 0,
  rewardRupees: 0,
  rr: null,
  reasons: ["No flow rule has fired on SENSEX in the last 15 minutes"],
  historical: null,
  honestLine: "No measured edge: nothing to buy.",
};
