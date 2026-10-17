/**
 * Seed data for the dashboard's mock engine: one realistic paper-trading session.
 * Everything is anchored to an IST trading date `A` (7 Oct 2026 when run today), so the
 * story stays coherent on any date: RBI decision at 10:00, a stopped-out morning PE,
 * a NIFTY 22600 CE bought at 11:05 and still open, SENSEX neutral with no plan.
 */
import {
  contractLabel,
  SIGNAL_SOURCE_LABELS,
  taxonomyTab,
  type ChargesView,
  type DailyPnlView,
  type EventClusterDetail,
  type EventTaxonomy,
  type FillView,
  type ImpactLevel,
  type ImpactView,
  type IndexId,
  type IndicatorView,
  type OptionType,
  type OrderView,
  type Regime,
  type ScheduledEventKind,
  type ScheduledEventView,
  type Severity,
  type Side,
  type SignalComponentView,
  type SignalPerformanceRow,
  type SignalSource,
  type Stance,
  type SuggestedContract,
} from "@/engine/api-types";
import {
  addDays,
  HOUR_MS,
  istAt,
  isTradingDay,
  MINUTE_MS,
  nextWeeklyExpiry,
  prevTradingDay,
  toIstIso,
} from "@/lib/ist";
import { gauss, hashString, mulberry32, round2 } from "./random";

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** NSE/BSE weekday trading holidays (2026 per NSE circular; enough for the mock and backtests). */
export const MOCK_HOLIDAYS: Readonly<Record<string, string>> = {
  "2026-01-15": "Maharashtra municipal elections",
  "2026-01-26": "Republic Day",
  "2026-03-03": "Holi",
  "2026-03-26": "Shri Ram Navami",
  "2026-03-31": "Shri Mahavir Jayanti",
  "2026-04-03": "Good Friday",
  "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
  "2026-05-01": "Maharashtra Day",
  "2026-05-28": "Bakri Id",
  "2026-06-26": "Muharram",
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-10-20": "Dussehra",
  "2026-11-10": "Diwali Balipratipada",
  "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
  "2026-12-25": "Christmas",
};

export const isMockHoliday = (date: string): boolean => date in MOCK_HOLIDAYS;
export const isMockTradingDay = (date: string): boolean => isTradingDay(date, isMockHoliday);

// ---------------------------------------------------------------------------
// Contracts and charges
// ---------------------------------------------------------------------------

export const LOT_SIZE: Record<IndexId, number> = { NIFTY: 65, SENSEX: 20 };
export const STRIKE_STEP: Record<IndexId, number> = { NIFTY: 50, SENSEX: 100 };
const MONTH_CODE = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];

/** Exchange-style weekly symbol, e.g. NIFTY26O1322600CE (the real engine resolves these from instrument.csv). */
export function mockTradingSymbol(index: IndexId, expiry: string, strike: number, type: OptionType): string {
  const [y, m, d] = expiry.split("-");
  return `${index}${y.slice(2)}${MONTH_CODE[Number(m) - 1]}${d}${strike}${type}`;
}

export function makeContract(
  index: IndexId,
  expiry: string,
  strike: number,
  optionType: OptionType,
  lots: number,
  premium: number | null,
): SuggestedContract {
  const lotSize = LOT_SIZE[index];
  return {
    index,
    expiry,
    strike,
    optionType,
    tradingSymbol: mockTradingSymbol(index, expiry, strike, optionType),
    lotSize,
    lots,
    premium,
    premiumAtRisk: premium == null ? null : round2(premium * lotSize * lots),
    label: contractLabel({ index, expiry, strike, optionType }),
  };
}

/** Groww F&O charges for one executed option order (schedule effective 2026-04-01). */
export function optionCharges(side: Side, price: number, qty: number, index: IndexId): ChargesView {
  const turnover = price * qty;
  const brokerage = 20;
  const stt = side === "SELL" ? round2(turnover * 0.0015) : 0;
  const exchange = round2(turnover * (index === "NIFTY" ? 0.0003553 : 0.000325));
  const sebi = round2(turnover * 0.000001);
  const stamp = side === "BUY" ? round2(turnover * 0.00003) : 0;
  const gst = round2((brokerage + exchange + sebi) * 0.18);
  return { brokerage, stt, exchange, gst, sebi, stamp, total: round2(brokerage + stt + exchange + sebi + stamp + gst) };
}

export function emptyCharges(): ChargesView {
  return { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stamp: 0, total: 0 };
}

export function addCharges(a: ChargesView, b: ChargesView): ChargesView {
  return {
    brokerage: round2(a.brokerage + b.brokerage),
    stt: round2(a.stt + b.stt),
    exchange: round2(a.exchange + b.exchange),
    gst: round2(a.gst + b.gst),
    sebi: round2(a.sebi + b.sebi),
    stamp: round2(a.stamp + b.stamp),
    total: round2(a.total + b.total),
  };
}

// ---------------------------------------------------------------------------
// Seed shapes
// ---------------------------------------------------------------------------

export interface QuoteSeed {
  key: string;
  label: string;
  base: number;
  prevClose: number;
  decimals: number;
  /** Groww LTP (seconds old) or Yahoo (about a minute or two). */
  lagSec: [number, number];
}

export interface SignalSeed {
  index: IndexId;
  stance: Stance;
  baseConviction: number;
  threshold: number;
  regime: Regime;
  impliedMovePct: number;
  components: SignalComponentView[];
  contributors: { clusterId: string; weight: number }[];
  rationale: string;
  /** Static gates; the mock re-derives DATA_AGE, KILL_SWITCH and CONVICTION each call. */
  gates: { gate: string; label: string; passed: boolean | null; detail: string }[];
  indicators: IndicatorView;
}

export interface PositionSeed {
  id: string;
  planId: string;
  index: IndexId;
  contract: SuggestedContract;
  qty: number;
  avgPrice: number;
  /** Spot at entry, delta and theta drive the mock's option mark. */
  entrySpot: number;
  delta: number;
  thetaPerMin: number;
  openedAt: number;
  peak: number;
  stopPct: number;
  targetPct: number;
  trailActivatePct: number;
  trailGivebackPct: number;
  timeStopAt: number;
  squareOffAt: number;
  dominantSource: SignalSource;
  entryCharges: number;
}

export interface MockSeed {
  anchorDate: string;
  startingEquity: number;
  quotes: QuoteSeed[];
  signals: SignalSeed[];
  positions: PositionSeed[];
  orders: OrderView[];
  fills: FillView[];
  /** Gross realized P&L of trades closed today (charges tracked separately). */
  realizedToday: number;
  chargesToday: ChargesView;
  tradesToday: number;
  events: EventClusterDetail[];
  scheduled: ScheduledEventView[];
  /** Closed trading days before the anchor date, oldest first. */
  history: DailyPnlView[];
  performance: SignalPerformanceRow[];
  stats: { clustersScoredToday: number; llmInputTokensToday: number; llmOutputTokensToday: number };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function imp(
  index: IndexId,
  direction: -1 | 0 | 1,
  score: number,
  magnitudePct: number,
  confidence: number,
  halfLifeHours: number,
): ImpactView {
  return { index, direction, score, magnitudePct, confidence, halfLifeHours };
}

interface EventInput {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  taxonomy: EventTaxonomy;
  isScheduledData?: boolean;
  severity: Severity;
  scorer: "llm" | "fallback" | "pending";
  firstSeen: number;
  lastSeen: number;
  articleCount: number;
  sources: string[];
  impacts: ImpactView[];
  sectors: EventClusterDetail["sectors"];
  pricedIn?: boolean;
  topUrl: string | null;
  novelty: EventClusterDetail["novelty"];
  surprise: EventClusterDetail["surprise"];
  horizon: EventClusterDetail["horizon"];
  scoredAt: number | null;
  headlines: string[];
}

function makeEvent(e: EventInput): EventClusterDetail {
  const isScheduledData = e.isScheduledData ?? false;
  return {
    clusterId: e.id,
    title: e.title,
    summary: e.summary,
    taxonomy: e.taxonomy,
    tab: taxonomyTab(e.taxonomy, isScheduledData),
    severity: e.severity,
    scorer: e.scorer,
    firstSeenAt: toIstIso(e.firstSeen),
    lastSeenAt: toIstIso(e.lastSeen),
    articleCount: e.articleCount,
    sources: e.sources,
    impacts: e.impacts,
    sectors: e.sectors,
    pricedIn: e.pricedIn ?? false,
    decayRemaining: 1,
    topUrl: e.topUrl,
    isScheduledData,
    rationale: e.rationale,
    novelty: e.novelty,
    surprise: e.surprise,
    horizon: e.horizon,
    model: e.scorer === "llm" ? "claude-opus-5-5" : null,
    scoredAt: e.scoredAt == null ? null : toIstIso(e.scoredAt),
    headlines: e.headlines.map((title, i) => ({ title, url: i === 0 ? e.topUrl : null })),
  };
}

function buildEvents(A: string, P: string, t0: number): EventClusterDetail[] {
  const at = (date: string, hhmm: string) => istAt(date, hhmm);
  return [
    makeEvent({
      id: "evc-rbi-mpc-oct",
      title: "RBI holds repo rate at 5.25%, flags upside risks to food inflation",
      summary: "Hawkish hold: unanimous pause, neutral stance kept; Governor cites vegetable prices and festive demand. Banks lag as rate-cut hopes slip to 2027.",
      rationale:
        "Unchanged repo with a hawkish tilt versus a consensus dovish hold. Financials (33% of NIFTY, 38% of SENSEX) carry most of the impact; improved liquidity guidance offsets part of it.",
      taxonomy: "MACRO_POLICY",
      isScheduledData: true,
      severity: "FLASH",
      scorer: "llm",
      firstSeen: at(A, "10:01:30"),
      lastSeen: t0 - 3 * MINUTE_MS,
      articleCount: 22,
      sources: ["Reuters", "Mint", "Economic Times", "Business Standard", "Moneycontrol", "CNBC-TV18"],
      impacts: [imp("NIFTY", -1, -0.46, 0.5, 0.72, 6), imp("SENSEX", -1, -0.52, 0.5, 0.75, 6)],
      sectors: [
        { sector: "FINANCIALS", direction: -1, weight: "HIGH" },
        { sector: "AUTO", direction: -1, weight: "MEDIUM" },
        { sector: "INFRA_OTHER", direction: -1, weight: "LOW" },
      ],
      topUrl: "https://www.rbi.org.in/",
      novelty: "NEW",
      surprise: "NEGATIVE",
      horizon: "DAYS_1_2",
      scoredAt: at(A, "10:04:10"),
      headlines: [
        "RBI holds repo rate at 5.25%, flags upside risks to food inflation",
        "MPC keeps stance neutral in unanimous vote; CPI forecast raised to 3.4%",
        "Bank Nifty slips as RBI dashes hopes of a festive-season cut",
        "Governor: liquidity to stay in surplus, durable injections if needed",
        "Economists push first FY27 cut to February after hawkish RBI",
      ],
    }),
    makeEvent({
      id: "evc-brent-red-sea",
      title: "Brent jumps 2.8% to $70.6 as fresh Red Sea attacks reroute tankers",
      summary: "Two tankers diverted after drone strikes near Bab el-Mandeb; war-risk premia double. Oil marketing companies fall, rupee softens early.",
      rationale:
        "India imports ~85% of its crude: a sustained $2/bbl rise widens the current-account deficit and squeezes OMC margins. Insurance premia suggest the move outlasts a day.",
      taxonomy: "COMMODITY_SHOCK",
      severity: "ALERT",
      scorer: "llm",
      firstSeen: at(A, "08:12"),
      lastSeen: t0 - 9 * MINUTE_MS,
      articleCount: 31,
      sources: ["Reuters", "Bloomberg", "Lloyd's List", "Al Jazeera", "Mint"],
      impacts: [imp("NIFTY", -1, -0.31, 0.5, 0.64, 12), imp("SENSEX", -1, -0.29, 0.5, 0.62, 12)],
      sectors: [
        { sector: "OIL_GAS", direction: -1, weight: "MEDIUM" },
        { sector: "AUTO", direction: -1, weight: "LOW" },
        { sector: "FMCG", direction: -1, weight: "LOW" },
      ],
      topUrl: "https://www.reuters.com/business/energy/",
      novelty: "DEVELOPMENT",
      surprise: "NA",
      horizon: "DAYS_1_2",
      scoredAt: at(A, "08:15"),
      headlines: [
        "Brent jumps 2.8% to $70.6 as fresh Red Sea attacks reroute tankers",
        "Shipping insurers double war-risk premia for Red Sea transits",
        "OMC shares slide as crude spikes; HPCL, BPCL down 2%",
        "Rupee opens weaker at 88.74 on oil surge",
      ],
    }),
    makeEvent({
      id: "evc-fpi-outflow",
      title: "FPIs sell ₹3,870 crore in cash market; DIIs buy ₹4,950 crore",
      summary: "Provisional exchange data: foreign investors net sellers for a fourth session, domestic institutions absorb the supply.",
      rationale: "Lexicon fallback: 'sell' / 'outflow' polarity with negative tone. Low confidence until LLM rescoring completes.",
      taxonomy: "FII_FLOWS",
      severity: "UPDATE",
      scorer: "fallback",
      firstSeen: at(P, "18:40"),
      lastSeen: at(A, "09:20"),
      articleCount: 9,
      sources: ["NSE provisional data", "Moneycontrol", "Business Standard"],
      impacts: [imp("NIFTY", -1, -0.12, 0.125, 0.35, 24), imp("SENSEX", -1, -0.13, 0.125, 0.35, 24)],
      sectors: [{ sector: "FINANCIALS", direction: -1, weight: "LOW" }],
      topUrl: "https://www.nseindia.com/",
      novelty: "REPEAT",
      surprise: "NA",
      horizon: "DAYS_1_2",
      scoredAt: at(P, "18:42"),
      headlines: [
        "FPIs sell ₹3,870 crore in cash market; DIIs buy ₹4,950 crore",
        "Foreign outflows extend to fourth day as dollar strength persists",
      ],
    }),
    makeEvent({
      id: "evc-us-yields",
      title: "US 10-year yield slides to 3.92% after soft ISM services; dollar at 2-week low",
      summary: "ISM services prints 50.4 vs 51.6 expected; Treasuries rally and the dollar index drops 0.4%. Futures price a December Fed cut at 74%.",
      rationale:
        "Lower US yields and a softer dollar tend to precede FPI inflows into Indian equities within 1–3 sessions; rate-sensitive financials benefit most.",
      taxonomy: "US_MARKET_FED",
      severity: "ALERT",
      scorer: "llm",
      firstSeen: at(P, "19:48"),
      lastSeen: at(A, "07:15"),
      articleCount: 18,
      sources: ["Reuters", "Bloomberg", "WSJ", "CNBC", "Mint"],
      impacts: [imp("NIFTY", 1, 0.48, 0.5, 0.7, 18), imp("SENSEX", 1, 0.45, 0.5, 0.7, 18)],
      sectors: [
        { sector: "FINANCIALS", direction: 1, weight: "MEDIUM" },
        { sector: "IT", direction: -1, weight: "LOW" },
        { sector: "INFRA_OTHER", direction: 1, weight: "LOW" },
      ],
      topUrl: "https://www.reuters.com/markets/us/",
      novelty: "NEW",
      surprise: "POSITIVE",
      horizon: "DAYS_1_2",
      scoredAt: at(P, "19:51"),
      headlines: [
        "US 10-year yield slides to 3.92% after soft ISM services",
        "Dollar index at two-week low as Fed cut bets firm",
        "Asian equities set for higher open on US rate relief",
      ],
    }),
    makeEvent({
      id: "evc-china-stimulus",
      title: "China unveils ¥1.2tn special bond package for infrastructure and housing",
      summary: "Finance ministry front-loads 2027 quota; steel and copper rally in Asia. Metals stocks lead early gains in Mumbai.",
      rationale:
        "Metals (4% of NIFTY) gain on steel and copper demand; the wider effect is sentiment via Asian risk appetite. Some FPI money may rotate to China, capping upside.",
      taxonomy: "CHINA",
      severity: "UPDATE",
      scorer: "llm",
      firstSeen: at(A, "07:32"),
      lastSeen: at(A, "11:10"),
      articleCount: 26,
      sources: ["Reuters", "Bloomberg", "SCMP", "Caixin", "Economic Times"],
      impacts: [imp("NIFTY", 1, 0.22, 0.125, 0.6, 24), imp("SENSEX", 1, 0.18, 0.125, 0.58, 24)],
      sectors: [{ sector: "METALS", direction: 1, weight: "HIGH" }],
      topUrl: "https://www.scmp.com/economy",
      novelty: "NEW",
      surprise: "POSITIVE",
      horizon: "WEEK",
      scoredAt: at(A, "07:36"),
      headlines: [
        "China unveils ¥1.2tn special bond package for infrastructure and housing",
        "Copper hits three-month high on China stimulus",
        "Tata Steel, Hindalco lead Nifty Metal higher",
      ],
    }),
    makeEvent({
      id: "evc-infosys-q2",
      title: "Infosys Q2 beats estimates, raises FY27 revenue guidance to 3–4%",
      summary: "Constant-currency growth 2.1% q/q vs 1.4% expected; large-deal TCV $2.4bn. ADRs up 5% overnight.",
      rationale:
        "Guidance upgrade with strong deal wins points to a demand recovery; IT is 12% of NIFTY and 14% of SENSEX, and peers usually re-rate on Infosys guidance.",
      taxonomy: "CORPORATE_EARNINGS",
      severity: "ALERT",
      scorer: "llm",
      firstSeen: at(P, "16:42"),
      lastSeen: at(A, "10:30"),
      articleCount: 24,
      sources: ["Reuters", "Mint", "Economic Times", "CNBC-TV18", "Moneycontrol"],
      impacts: [imp("NIFTY", 1, 0.38, 0.5, 0.76, 12), imp("SENSEX", 1, 0.41, 0.5, 0.78, 12)],
      sectors: [{ sector: "IT", direction: 1, weight: "HIGH" }],
      topUrl: "https://www.infosys.com/investors.html",
      novelty: "NEW",
      surprise: "POSITIVE",
      horizon: "DAYS_1_2",
      scoredAt: at(P, "16:47"),
      headlines: [
        "Infosys Q2 beats estimates, raises FY27 revenue guidance to 3–4%",
        "Infosys ADRs jump 5% in New York after results",
        "Brokerages lift Infosys targets; TCS, Wipro rise in sympathy",
      ],
    }),
    makeEvent({
      id: "evc-monsoon",
      title: "IMD: monsoon withdrawal complete; season ends 8% above normal",
      summary: "Cumulative rainfall 108% of the long-period average; reservoir levels at a five-year high ahead of the rabi season.",
      rationale:
        "Above-normal rains support rural demand (two-wheelers, tractors, FMCG) and soften food inflation into Q4. Slow-moving, low-magnitude driver.",
      taxonomy: "WEATHER_DISASTER",
      severity: "UPDATE",
      scorer: "llm",
      firstSeen: at(A, "08:55"),
      lastSeen: at(A, "11:20"),
      articleCount: 11,
      sources: ["IMD", "Mint", "Hindu BusinessLine", "Reuters"],
      impacts: [imp("NIFTY", 1, 0.14, 0.125, 0.58, 72), imp("SENSEX", 1, 0.12, 0.125, 0.56, 72)],
      sectors: [
        { sector: "FMCG", direction: 1, weight: "MEDIUM" },
        { sector: "AUTO", direction: 1, weight: "MEDIUM" },
      ],
      topUrl: "https://mausam.imd.gov.in/",
      novelty: "DEVELOPMENT",
      surprise: "POSITIVE",
      horizon: "MONTH_PLUS",
      scoredAt: at(A, "08:58"),
      headlines: [
        "IMD: monsoon withdrawal complete; season ends 8% above normal",
        "Reservoir storage at five-year high, boosting rabi outlook",
      ],
    }),
    makeEvent({
      id: "evc-opec-hike",
      title: "OPEC+ confirms 137k bpd November output hike, in line with expectations",
      summary: "Eight-member group sticks to its gradual unwinding plan; the decision was trailed by delegates a week earlier.",
      rationale: "The hike matched consensus and was leaked a week ahead; futures moved on the leak, not the decision. Priced in.",
      taxonomy: "COMMODITY_SHOCK",
      severity: "UPDATE",
      scorer: "llm",
      firstSeen: at(addDays(A, -2), "19:10"),
      lastSeen: at(P, "12:05"),
      articleCount: 17,
      sources: ["Reuters", "Bloomberg", "Argus"],
      impacts: [imp("NIFTY", 1, 0.05, 0.125, 0.6, 12), imp("SENSEX", 1, 0.05, 0.125, 0.6, 12)],
      sectors: [{ sector: "OIL_GAS", direction: 1, weight: "LOW" }],
      pricedIn: true,
      topUrl: "https://www.opec.org/",
      novelty: "REPEAT",
      surprise: "INLINE",
      horizon: "DAYS_1_2",
      scoredAt: at(addDays(A, -2), "19:14"),
      headlines: [
        "OPEC+ confirms 137k bpd November output hike",
        "Oil little changed as OPEC+ sticks to plan",
      ],
    }),
    makeEvent({
      id: "evc-sebi-fno",
      title: "SEBI consultation paper proposes tighter intraday limits on index options",
      summary: "Draft caps intraday net positions per entity and adds delta-based monitoring; comments open for 21 days.",
      rationale: "",
      taxonomy: "DOMESTIC_POLITICS_REGULATION",
      severity: "ALERT",
      scorer: "pending",
      firstSeen: t0 - 6 * MINUTE_MS,
      lastSeen: t0 - 2 * MINUTE_MS,
      articleCount: 4,
      sources: ["SEBI", "Moneycontrol", "Economic Times"],
      impacts: [],
      sectors: [],
      topUrl: "https://www.sebi.gov.in/",
      novelty: "NEW",
      surprise: "NA",
      horizon: "WEEK",
      scoredAt: null,
      headlines: [
        "SEBI consultation paper proposes tighter intraday limits on index options",
        "Broker stocks dip on SEBI derivatives proposal",
      ],
    }),
    makeEvent({
      id: "evc-primorsk-drones",
      title: "Drone strikes hit Russia's Primorsk oil port; loadings suspended",
      summary: "Baltic export terminal halts loadings after overnight strikes; about 1 mb/d of seaborne crude affected for at least two days.",
      rationale:
        "Adds to the crude risk premium alongside the Red Sea disruption; part of India's discounted Russian supply is exposed. Small, fast-decaying impact.",
      taxonomy: "GEOPOLITICAL",
      severity: "ALERT",
      scorer: "llm",
      firstSeen: at(A, "05:40"),
      lastSeen: at(A, "09:15"),
      articleCount: 14,
      sources: ["Reuters", "Bloomberg", "Kyiv Independent", "TASS"],
      impacts: [imp("NIFTY", -1, -0.11, 0.125, 0.52, 8), imp("SENSEX", -1, -0.1, 0.125, 0.5, 8)],
      sectors: [{ sector: "OIL_GAS", direction: -1, weight: "LOW" }],
      topUrl: "https://www.reuters.com/world/europe/",
      novelty: "DEVELOPMENT",
      surprise: "NA",
      horizon: "INTRADAY",
      scoredAt: at(A, "05:44"),
      headlines: [
        "Drone strikes hit Russia's Primorsk oil port; loadings suspended",
        "Baltic crude exports disrupted for second time this quarter",
      ],
    }),
  ];
}

function sched(
  id: string,
  title: string,
  kind: ScheduledEventKind,
  at: number,
  impact: ImpactLevel,
  indices: IndexId[],
  opts: { approx?: boolean; blackout?: boolean } = {},
): ScheduledEventView {
  return {
    id,
    title,
    kind,
    at: toIstIso(at),
    impact,
    approx: opts.approx ?? false,
    blackoutStart: opts.blackout ? toIstIso(at - 15 * MINUTE_MS) : null,
    blackoutEnd: opts.blackout ? toIstIso(at + 5 * MINUTE_MS) : null,
    indices,
  };
}

function buildScheduled(A: string, t0: number): ScheduledEventView[] {
  const both: IndexId[] = ["NIFTY", "SENSEX"];
  const sensexExpiry = nextWeeklyExpiry("SENSEX", t0, isMockHoliday);
  const niftyExpiry = nextWeeklyExpiry("NIFTY", t0, isMockHoliday);
  return [
    sched("sch-rbi-presser", "RBI Governor's post-policy press conference", "RBI", istAt(A, "12:00"), "LOW", both),
    sched("sch-sensex-expiry", "SENSEX weekly expiry", "EXPIRY", istAt(sensexExpiry, "15:30"), "MED", ["SENSEX"]),
    sched("sch-tcs-q2", "TCS Q2 FY27 results", "OTHER", istAt(addDays(A, 2), "16:00"), "MED", both, { approx: true }),
    sched("sch-in-cpi", "India CPI inflation (Sep)", "IN_CPI", istAt(addDays(A, 5), "16:00"), "MED", both, { approx: true }),
    sched("sch-nifty-expiry", "NIFTY weekly expiry", "EXPIRY", istAt(niftyExpiry, "15:30"), "MED", ["NIFTY"]),
    sched("sch-in-wpi", "India WPI inflation (Sep)", "OTHER", istAt(addDays(A, 7), "12:00"), "MED", both, { approx: true, blackout: true }),
    sched("sch-us-cpi", "US CPI (Sep)", "US_CPI", istAt(addDays(A, 7), "18:00"), "HIGH", both),
    sched("sch-fomc", "FOMC rate decision", "FOMC", istAt(addDays(A, 21), "23:30"), "HIGH", both),
  ];
}

/** Charges for one NIFTY round trip at typical ATM premiums (buy ₹140, sell ₹150, one lot). */
export const ROUND_TRIP_CHARGES: ChargesView = addCharges(
  optionCharges("BUY", 140, 65, "NIFTY"),
  optionCharges("SELL", 150, 65, "NIFTY"),
);

function buildHistory(A: string, startingEquity: number): DailyPnlView[] {
  const rand = mulberry32(hashString(`history:${A}`));
  const dates: string[] = [];
  let d = A;
  while (dates.length < 60) {
    d = prevTradingDay(d, isMockHoliday);
    dates.unshift(d);
  }
  let equity = startingEquity;
  return dates.map((date) => {
    const trades = [0, 1, 1, 2, 2, 3][Math.floor(rand() * 6)];
    let gross = 0;
    for (let i = 0; i < trades; i++) gross += Math.max(-4800, Math.min(6900, 420 + 2300 * gauss(rand)));
    const dayCharges = round2(ROUND_TRIP_CHARGES.total * trades);
    const net = round2(gross - dayCharges);
    equity = round2(equity + net);
    return { date, realized: round2(gross), unrealized: 0, charges: dayCharges, net, trades, equityEnd: equity };
  });
}

function perfRow(
  source: SignalSource,
  r: Omit<SignalPerformanceRow, "source" | "label" | "index">,
): SignalPerformanceRow {
  return { source, label: SIGNAL_SOURCE_LABELS[source], index: "ALL", ...r };
}

function buildPerformance(A: string, P: string): SignalPerformanceRow[] {
  const iso = (date: string, hhmm: string) => toIstIso(istAt(date, hhmm));
  return [
    perfRow("EVENT", {
      trades: 38, wins: 21, hitRate: 0.553, expectancyPct: 6.8, expectancyRupees: 612, avgWinPct: 31.2, avgLossPct: -23.4,
      profitFactor: 1.62, tStat: 1.84, status: "ACTIVE", weight: 0.35, disabledReason: null, lastTradeAt: iso(A, "11:05:02"),
    }),
    perfRow("MOMENTUM", {
      trades: 41, wins: 21, hitRate: 0.512, expectancyPct: 4.1, expectancyRupees: 371, avgWinPct: 28.6, avgLossPct: -22.1,
      profitFactor: 1.38, tStat: 1.21, status: "ACTIVE", weight: 0.27, disabledReason: null, lastTradeAt: iso(A, "11:05:02"),
    }),
    perfRow("GAP", {
      trades: 24, wins: 11, hitRate: 0.458, expectancyPct: 0.6, expectancyRupees: 52, avgWinPct: 26.9, avgLossPct: -21.8,
      profitFactor: 1.04, tStat: 0.12, status: "PROBATION", weight: 0.15,
      disabledReason: "Probation: expectancy +0.6% over 24 trades (t 0.12); weight halved until 30 trades",
      lastTradeAt: iso(A, "09:31:12"),
    }),
    perfRow("RELATIVE_VALUE", {
      trades: 22, wins: 8, hitRate: 0.364, expectancyPct: -5.2, expectancyRupees: -468, avgWinPct: 24.1, avgLossPct: -22.0,
      profitFactor: 0.71, tStat: -1.31, status: "DISABLED", weight: 0,
      disabledReason: "Auto-disabled: expectancy −5.2% over 22 trades (t −1.31 < −1). Shadow: 4/10 positive trades toward re-enable",
      lastTradeAt: iso(addDays(A, -15), "13:20"),
    }),
    perfRow("GLOBAL_BETA", {
      trades: 29, wins: 15, hitRate: 0.517, expectancyPct: 3.2, expectancyRupees: 288, avgWinPct: 27.4, avgLossPct: -23.0,
      profitFactor: 1.27, tStat: 0.88, status: "ACTIVE", weight: 0.16, disabledReason: null, lastTradeAt: iso(P, "10:41"),
    }),
    perfRow("VOL_REGIME", {
      trades: 0, wins: 0, hitRate: 0, expectancyPct: 0, expectancyRupees: 0, avgWinPct: 0, avgLossPct: 0,
      profitFactor: 0, tStat: 0, status: "ACTIVE", weight: 0, disabledReason: null, lastTradeAt: null,
    }),
  ];
}

const component = (
  source: SignalSource,
  value: number,
  weight: number,
  notes: string,
  enabled = true,
): SignalComponentView => ({ source, value, weight, enabled, notes });

/** A source with no view right now: shown, but left out of the conviction. */
const silent = (source: SignalSource, weight: number, notes: string): SignalComponentView => ({ source, value: 0, weight, enabled: true, notes, abstain: true });

/** Builds the whole mock session for IST trading date `A`; `t0` is the simulated "now" at seed time. */
export function buildSeed(A: string, t0: number): MockSeed {
  const P = prevTradingDay(A, isMockHoliday);
  const niftyExpiry = nextWeeklyExpiry("NIFTY", t0, isMockHoliday);
  const startingEquity = 500_000;

  const peContract = makeContract("NIFTY", niftyExpiry, 22550, "PE", 1, 128.4);
  const ceContract = makeContract("NIFTY", niftyExpiry, 22600, "CE", 1, 142.5);

  const fillPeBuy = optionCharges("BUY", 128.4, 65, "NIFTY");
  const fillPeSell = optionCharges("SELL", 89.7, 65, "NIFTY");
  const fillCeBuy = optionCharges("BUY", 142.5, 65, "NIFTY");

  const iso = (hhmmss: string) => toIstIso(istAt(A, hhmmss));
  const orders: OrderView[] = [
    {
      id: "ord-0931-entry", placedAt: iso("09:31:12"), mode: "PAPER", contractLabel: peContract.label,
      tradingSymbol: peContract.tradingSymbol, side: "BUY", qty: 65, orderType: "LIMIT", limitPrice: 128.45,
      status: "FILLED", reason: "ENTRY", filledQty: 65, avgFillPrice: 128.4, planId: "pln-nifty-0931", error: null,
    },
    {
      id: "ord-1012-stop", placedAt: iso("10:12:40"), mode: "PAPER", contractLabel: peContract.label,
      tradingSymbol: peContract.tradingSymbol, side: "SELL", qty: 65, orderType: "MARKET", limitPrice: null,
      status: "FILLED", reason: "STOP", filledQty: 65, avgFillPrice: 89.7, planId: "pln-nifty-0931", error: null,
    },
    {
      id: "ord-1104-entry", placedAt: iso("11:04:31"), mode: "PAPER", contractLabel: ceContract.label,
      tradingSymbol: ceContract.tradingSymbol, side: "BUY", qty: 65, orderType: "LIMIT", limitPrice: 141.9,
      status: "CANCELLED", reason: "ENTRY", filledQty: 0, avgFillPrice: null, planId: "pln-nifty-1105",
      error: "Unfilled after 30 s; re-sent as MARKET",
    },
    {
      id: "ord-1105-entry", placedAt: iso("11:05:02"), mode: "PAPER", contractLabel: ceContract.label,
      tradingSymbol: ceContract.tradingSymbol, side: "BUY", qty: 65, orderType: "MARKET", limitPrice: null,
      status: "FILLED", reason: "ENTRY", filledQty: 65, avgFillPrice: 142.5, planId: "pln-nifty-1105", error: null,
    },
  ];
  const fills: FillView[] = [
    { id: "fil-0931", orderId: "ord-0931-entry", at: iso("09:31:13"), price: 128.4, qty: 65, charges: fillPeBuy.total },
    { id: "fil-1012", orderId: "ord-1012-stop", at: iso("10:12:41"), price: 89.7, qty: 65, charges: fillPeSell.total },
    { id: "fil-1105", orderId: "ord-1105-entry", at: iso("11:05:03"), price: 142.5, qty: 65, charges: fillCeBuy.total },
  ];

  const openedAt = istAt(A, "11:05:02");
  const position: PositionSeed = {
    id: "pos-nifty-1105",
    planId: "pln-nifty-1105",
    index: "NIFTY",
    contract: ceContract,
    qty: 65,
    avgPrice: 142.5,
    entrySpot: 22588,
    delta: 0.55,
    thetaPerMin: 0.02,
    openedAt,
    peak: 186.0,
    stopPct: -30,
    targetPct: 50,
    trailActivatePct: 30,
    trailGivebackPct: 50,
    timeStopAt: openedAt + 120 * MINUTE_MS,
    squareOffAt: istAt(A, "15:05"),
    dominantSource: "EVENT",
    entryCharges: fillCeBuy.total,
  };

  const signals: SignalSeed[] = [
    {
      index: "NIFTY",
      stance: "BULLISH",
      baseConviction: 0.62,
      threshold: 0.35,
      regime: "TREND_UP",
      impliedMovePct: 0.61,
      components: [
        component("EVENT", 0.62, 0.3, "EPI +0.41 · 9 active clusters"),
        component("TREND", 0.73, 0.2, "ADX 26 (+DI 29 / −DI 14), EMA9 > EMA21, Supertrend up"),
        component("ORB", 0.55, 0.15, "above 22510–22585 by 0.5 ATR, 6 bars outside"),
        component("MOMENTUM", 0.66, 0.16, "z15 0.41, z60 1.12, VWAP bars 9"),
        silent("GAP", 0.1, "no material gap"),
        component("GLOBAL_BETA", 0.25, 0.05, "globals imply +0.31%, India +0.12%"),
        silent("MEAN_REVERSION", 0.1, "0.8σ from VWAP: not stretched"),
        component("RELATIVE_VALUE", -0.2, 0, "Disabled: decayed edge (shadow only)", false),
        component("VOL_REGIME", 0, 0, "VIX 13.9 · RV/IV 0.82 → size ×1.0"),
      ],
      contributors: [
        { clusterId: "evc-us-yields", weight: 0.34 },
        { clusterId: "evc-infosys-q2", weight: 0.27 },
        { clusterId: "evc-rbi-mpc-oct", weight: -0.16 },
      ],
      rationale:
        "Bullish: softer US yields (10Y at 3.92%) and Infosys' guidance upgrade outweigh RBI's hawkish hold. NIFTY has held above VWAP for 9 bars with 60-minute efficiency 0.71, so the regime is TREND_UP and the entry threshold drops to 0.35. The theta gate passes: expected move 0.38% against an implied 0.61% gives an edge ratio of 0.21 after costs. Bought the 22600 CE at 11:05; the trail is active after a +30% peak.",
      gates: [
        { gate: "SESSION", label: "Entry window", passed: true, detail: "09:25–14:30 IST" },
        { gate: "HOLIDAY", label: "Trading day", passed: true, detail: "NSE open" },
        { gate: "EXPIRY_CUTOFF", label: "Expiry-day cutoff", passed: null, detail: "Not an expiry day" },
        { gate: "DATA_AGE", label: "Data freshness", passed: true, detail: "" },
        { gate: "KILL_SWITCH", label: "Kill switch", passed: true, detail: "" },
        { gate: "EVENT_BLACKOUT", label: "Event blackout", passed: true, detail: "No HIGH/MED event within 15 min" },
        { gate: "CONVICTION", label: "Conviction", passed: true, detail: "" },
        { gate: "THETA", label: "Theta gate", passed: true, detail: "Edge 0.21 ≥ 0.10 · EM 0.38% vs IM 0.61%" },
        { gate: "LIQUIDITY", label: "Liquidity", passed: true, detail: "Spread 0.42% · OI 41.8 L" },
        { gate: "EXPOSURE", label: "Exposure", passed: true, detail: "1/1 position (this plan) · 2/4 trades today" },
      ],
      indicators: {
        spot: 22646.35,
        atrPct5m: 0.09,
        vwapDistPct: 0.21,
        openingRange: { high: 22585, low: 22510, state: "BROKE_UP", strengthAtr: 0.52, barsOutside: 6, lastBreak: "UP", barsSinceReentry: 0 },
        rsi14: 63.4,
        adx14: 26.1,
        plusDi14: 29.2,
        minusDi14: 14.3,
        ema9: 22628.4,
        ema21: 22597.9,
        ema9SlopePct: 0.05,
        supertrendDir: 1,
        supertrendLine: 22561.2,
        bbPctB: 0.84,
        bbWidthPct: 0.62,
        vwap: 22598.7,
        vwapZ: 1.12,
        dailyBias: 1,
        dailyEmaGapPct: 0.41,
        prevDayHigh: 22601.5,
        prevDayLow: 22402.8,
        prevDayClose: 22518.1,
      },
    },
    {
      index: "SENSEX",
      stance: "NEUTRAL",
      baseConviction: 0.08,
      threshold: 0.55,
      regime: "RANGE",
      impliedMovePct: 0.58,
      components: [
        silent("EVENT", 0.3, "6 live stories, no net direction (EPI −0.02)"),
        silent("TREND", 0.2, "ADX 13: no trend"),
        silent("ORB", 0.15, "inside the opening range 72480–72710"),
        component("MOMENTUM", 0.05, 0.16, "z15 0.08, z60 0.19, VWAP bars 1"),
        silent("GAP", 0.1, "no material gap"),
        component("GLOBAL_BETA", 0.15, 0.05, "globals imply +0.30%, India +0.18%"),
        component("MEAN_REVERSION", -0.4, 0.1, "1.6σ above VWAP, RSI 71, %B 1.04: fade toward VWAP"),
        component("RELATIVE_VALUE", 0.3, 0, "Disabled: decayed edge (shadow +0.30 catch-up vs NIFTY)", false),
        component("VOL_REGIME", 0, 0, "VIX 13.9 · RV/IV 0.79 → size ×1.0"),
      ],
      contributors: [
        { clusterId: "evc-rbi-mpc-oct", weight: -0.31 },
        { clusterId: "evc-us-yields", weight: 0.27 },
        { clusterId: "evc-infosys-q2", weight: 0.24 },
      ],
      rationale:
        "Neutral: financials-heavy SENSEX (38%) absorbs more of RBI's hawkish hold, cancelling the global tailwind from lower US yields and Infosys. Conviction +0.08 is far below the RANGE threshold of 0.55, so no plan is built and the theta and liquidity gates are not evaluated. The relative-value catch-up signal would lean long, but it is disabled after its edge decayed.",
      gates: [
        { gate: "SESSION", label: "Entry window", passed: true, detail: "09:25–14:30 IST" },
        { gate: "HOLIDAY", label: "Trading day", passed: true, detail: "BSE open" },
        { gate: "EXPIRY_CUTOFF", label: "Expiry-day cutoff", passed: null, detail: "Expiry tomorrow; cutoff 14:00 on expiry day" },
        { gate: "DATA_AGE", label: "Data freshness", passed: true, detail: "" },
        { gate: "KILL_SWITCH", label: "Kill switch", passed: true, detail: "" },
        { gate: "EVENT_BLACKOUT", label: "Event blackout", passed: true, detail: "No HIGH/MED event within 15 min" },
        { gate: "CONVICTION", label: "Conviction", passed: false, detail: "" },
        { gate: "THETA", label: "Theta gate", passed: null, detail: "Not evaluated (below threshold)" },
        { gate: "LIQUIDITY", label: "Liquidity", passed: null, detail: "Not evaluated (below threshold)" },
        { gate: "EXPOSURE", label: "Exposure", passed: false, detail: "1/1 position slots used (NIFTY)" },
      ],
      indicators: {
        spot: 72640.8,
        atrPct5m: 0.08,
        vwapDistPct: 0.14,
        openingRange: { high: 72710, low: 72480, state: "INSIDE", strengthAtr: 0, barsOutside: 0, lastBreak: null, barsSinceReentry: 0 },
        rsi14: 71.2,
        adx14: 13.4,
        plusDi14: 21.8,
        minusDi14: 18.9,
        ema9: 72611.7,
        ema21: 72589.2,
        ema9SlopePct: 0.02,
        supertrendDir: 1,
        supertrendLine: 72398.5,
        bbPctB: 1.04,
        bbWidthPct: 0.48,
        vwap: 72539.3,
        vwapZ: 1.61,
        dailyBias: 1,
        dailyEmaGapPct: 0.36,
        prevDayHigh: 72455.2,
        prevDayLow: 72011.6,
        prevDayClose: 72301.45,
      },
    },
  ];

  const quotes: QuoteSeed[] = [
    { key: "NIFTY", label: "NIFTY 50", base: 22646.35, prevClose: 22518.1, decimals: 2, lagSec: [2, 6] },
    { key: "SENSEX", label: "SENSEX", base: 72640.8, prevClose: 72301.45, decimals: 2, lagSec: [2, 6] },
    { key: "INDIAVIX", label: "INDIA VIX", base: 13.92, prevClose: 14.38, decimals: 2, lagSec: [35, 70] },
    { key: "BANKNIFTY", label: "BANK NIFTY", base: 49812.6, prevClose: 49690.25, decimals: 2, lagSec: [2, 6] },
    { key: "USDINR", label: "USDINR", base: 88.62, prevClose: 88.71, decimals: 3, lagSec: [110, 150] },
    { key: "BRENT", label: "BRENT", base: 70.62, prevClose: 68.7, decimals: 2, lagSec: [60, 95] },
    { key: "SPFUT", label: "S&P FUT", base: 6752.25, prevClose: 6731.5, decimals: 2, lagSec: [60, 95] },
  ];


  return {
    anchorDate: A,
    startingEquity,
    quotes,
    signals,
    positions: [position],
    orders,
    fills,
    realizedToday: round2((89.7 - 128.4) * 65),
    chargesToday: addCharges(addCharges(fillPeBuy, fillPeSell), fillCeBuy),
    tradesToday: 1,
    events: buildEvents(A, P, t0),
    scheduled: buildScheduled(A, t0),
    history: buildHistory(A, startingEquity),
    performance: buildPerformance(A, P),
    stats: { clustersScoredToday: 37, llmInputTokensToday: 184_220, llmOutputTokensToday: 21_880 },
  };
}

/** Hours between two instants, for decay maths. */
export const hoursBetween = (a: number, b: number) => (b - a) / HOUR_MS;
