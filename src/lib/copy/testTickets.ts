/**
 * Test fixtures for src/lib/copy: copy tickets and signals shaped like the engine's own output
 * (src/engine/copy/copyTicket.ts, src/engine/api/readModel.ts) for Fri 9 Oct 2026. Not used by the app.
 */
import type { CopyTicketView, GateResult, SignalView } from "@/engine/api-types";

export const DAY = "2026-10-09";
/** IST ISO time on the test day (or another date). */
export const at = (hms: string, date = DAY) => `${date}T${hms.length === 5 ? `${hms}:00` : hms}+05:30`;
export const ms = (hms: string, date = DAY) => Date.parse(at(hms, date));

type Over = Partial<Omit<CopyTicketView, "entry" | "levels" | "contract" | "account">> & {
  entry?: Partial<CopyTicketView["entry"]>;
  levels?: Partial<CopyTicketView["levels"]>;
  contract?: Partial<CopyTicketView["contract"]>;
  account?: Partial<CopyTicketView["account"]>;
};

function merge(t: CopyTicketView, o: Over): CopyTicketView {
  return {
    ...t,
    ...o,
    entry: { ...t.entry, ...o.entry },
    levels: { ...t.levels, ...o.levels },
    contract: { ...t.contract, ...o.contract },
    account: { ...t.account, ...o.account },
  };
}

/** Main account (ATM, ₹5L): BUY NIFTY 22600 CE (13 Oct) at 10:05, ₹142.50, 1 lot of 65. */
export function niftyTicket(o: Over = {}): CopyTicketView {
  const t: CopyTicketView = {
    id: "pos-nifty-1005",
    planId: "pln-nifty-1005",
    account: { id: "main", label: "Main account", shortLabel: "Main", capitalRupees: 500_000 },
    mode: "PAPER",
    status: "OPEN",
    index: "NIFTY",
    side: "BULL",
    headline: "BUY NIFTY 22600 CE (13 Oct)",
    contract: {
      index: "NIFTY",
      expiry: "2026-10-13",
      strike: 22600,
      optionType: "CE",
      tradingSymbol: "NIFTY26O1322600CE",
      growwSymbol: "NSE-NIFTY-13Oct26-22600-CE",
      lotSize: 65,
      lots: 1,
      premium: 142.5,
      premiumAtRisk: 2834,
      label: "NIFTY 13-OCT-2026 22600 CE",
    },
    searchText: "NIFTY 22600 CE",
    expiryLabel: "Tue 13 Oct",
    qty: 65,
    lots: 1,
    entry: { at: at("10:05:02"), premium: 142.5, limitPrice: null, costRupees: 9262.5, charges: 22.6, priceSource: "model", spot: 22588, skipBeyondSpot: 22631.4 },
    levels: {
      stopPct: -30,
      stop: 99.75,
      targetPct: 50,
      target: 213.75,
      trailActivatePct: 30,
      trailActivateAt: 185.25,
      trailGivebackPct: 50,
      trail: null,
      timeStopAt: at("12:05:02"),
      timeStopMinPnlPct: 10,
      squareOffAt: at("15:05"),
    },
    riskAtStop: { rupees: 2834, pctOfCapital: 0.57 },
    live: { mark: 151.2, markAt: at("10:07:30"), pnl: 543, movePct: 6.11, peak: 152, mfePct: 6.67, maePct: -1.2 },
    exit: null,
    setup: null,
    market: { spot: 22588, changePct: 0.31, vix: 13.9, indicators: null },
    steps: [],
  };
  return merge(t, o);
}

/** ₹10k account (premium band): BUY SENSEX 81500 PE (15 Oct) at 10:20, ₹168.35, 1 lot of 20. */
export function sensexTicket(o: Over = {}): CopyTicketView {
  const t: CopyTicketView = {
    id: "pos-sensex-1020",
    planId: "pln-sensex-1020",
    account: { id: "small10k", label: "₹10k account", shortLabel: "₹10k", capitalRupees: 10_000 },
    mode: "PAPER",
    status: "OPEN",
    index: "SENSEX",
    side: "BEAR",
    headline: "BUY SENSEX 81500 PE (15 Oct)",
    contract: {
      index: "SENSEX",
      expiry: "2026-10-15",
      strike: 81500,
      optionType: "PE",
      tradingSymbol: "SENSEX26O1581500PE",
      growwSymbol: "BSE-SENSEX-15Oct26-81500-PE",
      lotSize: 20,
      lots: 1,
      premium: 168.35,
      premiumAtRisk: 1241,
      label: "SENSEX 15-OCT-2026 81500 PE",
    },
    searchText: "SENSEX 81500 PE",
    expiryLabel: "Thu 15 Oct",
    qty: 20,
    lots: 1,
    entry: { at: at("10:20:00"), premium: 168.35, limitPrice: null, costRupees: 3367, charges: 21.8, priceSource: "broker", spot: 81320, skipBeyondSpot: 81233.6 },
    levels: {
      stopPct: -35,
      stop: 109.43,
      targetPct: 60,
      target: 269.36,
      trailActivatePct: 30,
      trailActivateAt: 218.86,
      trailGivebackPct: 50,
      trail: null,
      timeStopAt: at("11:50:00"),
      timeStopMinPnlPct: 10,
      squareOffAt: at("15:05"),
    },
    riskAtStop: { rupees: 1241, pctOfCapital: 12.41 },
    live: { mark: 170.1, markAt: at("10:21:00"), pnl: 13, movePct: 1.04, peak: 171, mfePct: 1.57, maePct: -0.5 },
    exit: null,
    setup: null,
    market: { spot: 81320, changePct: -0.42, vix: 14.2, indicators: null },
    steps: [],
  };
  return merge(t, o);
}

const gate = (g: string, passed: boolean | null, detail = "", label = g): GateResult => ({ gate: g, label, passed, detail });

/** The engine's gates for a RANGE-regime reading with conviction inside the band. */
export function rangeGates(conviction: number): GateResult[] {
  return [
    gate("conviction", false, `score ${conviction >= 0 ? "+" : ""}${conviction.toFixed(2)}`, "Conviction beyond ±0.55 (RANGE)"),
    gate("market_open", true, "session open", "Market open"),
    gate("entry_window", true, "inside window", "Entry window 09:25–14:30 IST"),
    gate("expiry_day", null, "not an expiry day", "Expiry-day cutoff"),
    gate("data_fresh", true, "95 s old (max 300 s)", "Market data fresh"),
    gate("event_blackout", true, "no scheduled event nearby", "Scheduled-event blackout"),
    gate("event_fresh", null, "not an event-driven entry", "Event freshness"),
    gate("halt", true, "trading allowed", "Kill switch and daily loss cap"),
    gate("weekly_loss", true, "week ₹0 vs cap -₹30000", "Weekly loss cap"),
    gate("loss_streak", true, "0 of 2", "Consecutive losses today"),
    gate("cooldown", true, "no recent stop-out", "Cooldown after a stop-out"),
    gate("per_index", true, "0 of 1", "Open positions on this index"),
    gate("max_positions", true, "0 of 2", "Open positions overall"),
    gate("trades_today", true, "0 of 4", "Trades today"),
    gate("orders_today", true, "0 of 10", "Orders today"),
    gate("no_opposite", true, "ok", "No opposite position on the other index"),
  ];
}

export function signal(o: Partial<SignalView> = {}): SignalView {
  const conviction = o.conviction ?? 0.07;
  return {
    index: "NIFTY",
    stance: "NEUTRAL",
    conviction,
    entryThreshold: 0.55,
    regime: "RANGE",
    computedAt: at("11:41:00"),
    spot: 22610,
    expectedMovePct: null,
    impliedMovePct: null,
    edgeRatio: null,
    minEdgeRatio: 0.1,
    gates: rangeGates(conviction),
    allGatesPassed: false,
    contract: null,
    noPlanReason: "conviction below threshold",
    components: [],
    contributors: [],
    rationale: "",
    position: null,
    indicators: null,
    ...o,
  };
}

/** Replaces one gate's result in a gate list. */
export function withGate(gates: GateResult[], id: string, passed: boolean | null, detail: string, label?: string): GateResult[] {
  const found = gates.some((g) => g.gate === id);
  const next = gates.map((g) => (g.gate === id ? { ...g, passed, detail, label: label ?? g.label } : g));
  return found ? next : [...next, gate(id, passed, detail, label ?? id)];
}
