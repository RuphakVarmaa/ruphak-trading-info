/**
 * The recommendation: at most one trade per index for a capital (₹10,000 by default), combining
 *
 *   (a) the live chart setups (strategy/setups.ts: trigger, stop and targets on the index),
 *   (b) the live option flow (flowMonitor.ts: who is adding or removing OI, PCR, dry-up, decay), and
 *   (c) the research's measured rules (FLOW_STATS): only a rule whose verdict is "positive" (ci95[0] > 0 on
 *       the out-of-sample part) can raise the grade to A; any other matching rule is shown as context.
 *
 * Grades: A = a positive measured edge matches (and the option flow does not oppose it); B = the setup and
 * the option flow agree, but no edge is proven; C = watch only. A grade other than A always carries an honest
 * line saying so. Status: ENTER only for a triggered setup graded A or B with a live quote, no premium
 * dry-up, inside the chase limit and inside the session rules; WAIT while a setup forms or a check is open;
 * NO_TRADE when a rule forbids a new trade (before 09:25 is WAIT, after 14:30 and after 13:00 on the index's
 * expiry day are NO_TRADE, as is a plan no-trade rule or no lot that fits the capital).
 *
 * The contract: on the expiry the caller passes (at least MIN_DAYS_LEFT calendar days left, never the one
 * expiring today: plan §7), the highest-delta strike with delta between MIN_DELTA and MAX_DELTA whose one lot
 * plus round-trip charges fits the capital (plan §7: skip the day when no lot with delta ≥ 0.30 fits). Lots:
 * as many as the capital buys, but beyond the first only while the stop loses at most MAX_RISK_PCT of it.
 *
 * Exits never loosen the engine's: the premium stop is never further than cfg.exits.stopPct (−30%), targets
 * are capped at cfg.exits.targetPct (+50%) unless a positive rule's measured exits apply (its stop only when
 * tighter), and everything is out by the square-off.
 *
 * Live detectors for research rules, by id (params are the rule's own thresholds, defaults in brackets):
 *   ORB_BULL, PDH_PDL_BEAR, VWAP_PULLBACK_BULL, RANGE_REVERSAL_BEAR ... : the chosen setup has that kind and
 *     side; with a suffix containing "OI" or "FLOW" (e.g. ORB_BULL_OI_CONFIRM) the option flow must agree
 *     (score ≥ params.minFlowScore [0.2]);
 *   OI_<LONG_BUILDUP|SHORT_BUILDUP|SHORT_COVERING|LONG_UNWINDING>_<CE|PE>: that build-up on that side at a
 *     strike within ATM ± params.strikes [2] over params.windowMin [15] minutes, |ΔOI %| ≥ params.minOiChgPct [0];
 *   VOL_SPIKE_*: a volume spike on the option to buy within the last params.windowMin [5] minutes, at most
 *     params.strikes [1] strikes from ATM, ≥ params.k [5]× normal, its price up more than params.minLtpChgPct [0]%;
 *   *DRY_UP* / *DRYUP*: the premium dry-up flag; PCR_RISE / PCR_FALL: |ΔPCR 15 min| ≥ params.minChg [0.05];
 *   PUT_WRITERS* / CALL_WRITERS*: that side adding OI faster at ATM±3 over 15 minutes.
 * Every rule must also match the index, the option side and its bestEntryWindow ("HH:MM–HH:MM"); a flow rule
 * open to either side ("EITHER") only buys the option its direction implies (put writers adding, call short
 * covering or a rising PCR → calls; the mirror images → puts). Unknown ids never match.
 *
 * Pure: the engine tick (pipeline/recoCycle.ts) gathers the inputs and stores the result in kv.
 */
import type { FlowBuildup, FlowWindowKey, IndexId, IndexPlanView, OptionFlowView, OptionType, RecommendationView, TradeSetupView } from "../api-types";
import { contractLabel } from "../api-types";
import { computeCharges } from "../broker/charges";
import { MINUTE_MS, formatHHMM, istDate, istIso, istMinutes, parseHHMM } from "../clock";
import { HOLD_MIN, optionPlan, premiumAt } from "../strategy/setups";
import type { Exchange, OptionContract } from "../types";
import { roundToTick } from "../util/math";
import { firstHHMM, isPositiveRule, parseWindow, type FlowStatsFile, type RuleStats } from "./flowStats";

export const RECO_CAPITAL = 10_000;
/** The capitals the card's footnote sizes the same trade for. */
export const FOOTNOTE_CAPITALS: readonly number[] = [5_000, 10_000, 500_000];
export const RECO_FROM = "09:25";
export const RECO_UNTIL = "14:30";
export const EXPIRY_DAY_UNTIL = "13:00";
/** Plan §7: at or one strike in the money (delta 0.5–0.7), never below delta 0.30 for the small accounts. */
export const MIN_DELTA = 0.3;
export const MAX_DELTA = 0.7;
/** Plan §7: at least 4 calendar days to expiry (the caller picks the expiry). */
export const MIN_DAYS_LEFT = 4;
/** Lots beyond the first only while the stop loses at most this share of the capital, percent. */
export const MAX_RISK_PCT = 2;
/** The entry limit is at most the live ask plus this, percent. */
export const ENTRY_LIMIT_PCT = 2;
/** An ENTER is valid this long (then re-read the price). */
export const ENTER_VALID_MS = 5 * MINUTE_MS;
/** Flow score (−1..1, in the trade's direction) from which the flow "agrees" or "opposes". */
export const FLOW_AGREE = 0.2;
/** A stored recommendation older than this is not shown (pipeline/recoCycle.ts, read model). */
export const RECO_MAX_AGE_MS = 3 * MINUTE_MS;
/** A flow reading older than this is not used. */
export const FLOW_MAX_AGE_MS = 3 * MINUTE_MS;

export const recoKey = (index: IndexId) => `reco:latest:${index}`;

export interface RecoCandidate {
  contract: { index: IndexId; expiry: string; strike: number; optionType: OptionType; tradingSymbol: string; lotSize: number; tickSize: number; exchange: Exchange };
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  /** The price used: the ask when quoted, otherwise a model price (priceSource "model"). */
  premium: number;
  delta: number;
  gamma: number;
  /** Premium change per minute from time decay (negative for a long option). */
  thetaPerMin: number;
  iv: number | null;
  priceSource: "feed" | "broker" | "model" | "mock";
}

export interface RecommendInput {
  index: IndexId;
  now: number;
  /** Rupees; RECO_CAPITAL by default. */
  capital?: number;
  spot: number | null;
  /** The live setups for the index (an empty list when none). */
  setups: TradeSetupView[];
  flow: OptionFlowView | null;
  stats: FlowStatsFile;
  /** Quoted strikes of the chosen expiry, for the side of the chosen setup (other sides are ignored). */
  candidates: RecoCandidate[];
  /** The session is open (09:15–15:30 on a trading day). */
  phaseOpen: boolean;
  isExpiryDay: boolean;
  /** The plan's no-trade rules for the index today, when available. */
  plan?: Pick<IndexPlanView, "verdict" | "headline" | "checks"> | null;
  /** Why a scheduled event's blackout forbids a new entry right now (plan rule N1), or null. */
  eventBlackout?: string | null;
  exits: { stopPct: number; targetPct: number; squareOffIst: string };
  /** Round-trip charges for `qty` units at `premium` (default: computeCharges buy + sell at that premium). */
  chargesFor?: (premium: number, qty: number, exchange: Exchange, date: string) => number;
  footnoteCapitals?: readonly number[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (x: number) => `₹${Math.round(x).toLocaleString("en-IN")}`;
const inr2 = (x: number) => `₹${x.toFixed(2)}`;
const lvl = (x: number) => Math.round(x).toLocaleString("en-IN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? d.slice(5, 7)}`;

export function roundTripCharges(premium: number, qty: number, exchange: Exchange, date: string): number {
  return r2(computeCharges("BUY", premium, qty, exchange, date).total + computeCharges("SELL", premium, qty, exchange, date).total);
}

// ---------------------------------------------------------------------------
// Pieces (exported for tests)
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<TradeSetupView["status"], number> = { TRIGGERED: 0, READY: 1, WATCHING: 2, MISSED: 9, INVALID: 9 };

/** The setup to act on: a triggered one first, then one at its trigger, then the nearest watched; best score first. */
export function pickSetup(setups: readonly TradeSetupView[]): TradeSetupView | null {
  const live = setups.filter((s) => STATUS_ORDER[s.status] < 9);
  live.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.score - a.score);
  return live[0] ?? null;
}

export interface Fit {
  pick: RecoCandidate;
  lots: number;
  units: number;
  premiumRupees: number;
  chargesRupees: number;
  totalRupees: number;
}

/** One lot's cost with round-trip charges. */
function lotCost(c: RecoCandidate, price: number, lots: number, date: string, charges: NonNullable<RecommendInput["chargesFor"]>) {
  const units = lots * c.contract.lotSize;
  const premiumRupees = r2(price * units);
  const chargesRupees = charges(price, units, c.contract.exchange, date);
  return { units, premiumRupees, chargesRupees, totalRupees: r2(premiumRupees + chargesRupees) };
}

/**
 * The highest-delta strike (MIN_DELTA ≤ |delta| ≤ MAX_DELTA) whose one lot with charges fits `capital`, or
 * null with the cheapest eligible lot (for the reason).
 */
export function chooseStrike(
  cands: readonly RecoCandidate[],
  capital: number,
  date: string,
  charges: NonNullable<RecommendInput["chargesFor"]> = roundTripCharges,
): { fit: Fit | null; cheapest: { c: RecoCandidate; total: number } | null } {
  const eligible = cands.filter((c) => c.premium > 0 && Math.abs(c.delta) >= MIN_DELTA && Math.abs(c.delta) <= MAX_DELTA).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  let cheapest: { c: RecoCandidate; total: number } | null = null;
  for (const c of eligible) {
    const cost = lotCost(c, c.premium, 1, date, charges);
    if (cost.totalRupees <= capital) return { fit: { pick: c, lots: 1, ...cost }, cheapest: null };
    if (!cheapest || cost.totalRupees < cheapest.total) cheapest = { c, total: cost.totalRupees };
  }
  return { fit: null, cheapest };
}

/**
 * The entry premium for a candidate (the quoted price now when the setup has triggered, else the premium at
 * the trigger from delta and gamma) and the limit to place: +ENTRY_LIMIT_PCT, rounded down to the tick.
 */
export function entryPrice(c: RecoCandidate, triggered: boolean, spot: number, trigger: number): { entry: number; limit: number } {
  const tick = c.contract.tickSize || 0.05;
  const entry = triggered ? Math.max(tick, roundToTick(c.premium, tick)) : premiumAt(c.premium, { delta: c.delta, gamma: c.gamma, thetaPerMin: c.thetaPerMin }, trigger - spot, 0, tick);
  return { entry, limit: Math.max(entry, roundToTick(entry * (1 + ENTRY_LIMIT_PCT / 100), tick, "down")) };
}

/** Lots for a capital: as many as it buys, but beyond the first only while the stop loses ≤ MAX_RISK_PCT of it. */
export function sizeLots(capital: number, perLotTotal: number, riskPerLot: number): number {
  if (!(perLotTotal > 0) || perLotTotal > capital) return 0;
  const byCash = Math.floor(capital / perLotTotal);
  const byRisk = riskPerLot > 0 ? Math.floor(((MAX_RISK_PCT / 100) * capital) / riskPerLot) : byCash;
  return Math.max(1, Math.min(byCash, byRisk));
}

export interface FlowRead {
  /** −1..1 in the trade's direction (positive = the flow agrees). */
  score: number;
  available: boolean;
  dryUp: boolean;
  lines: string[];
  cautions: string[];
}

const BULLISH: ReadonlySet<string> = new Set(["CE:LONG_BUILDUP", "CE:SHORT_COVERING", "PE:SHORT_BUILDUP", "PE:LONG_UNWINDING"]);
const BEARISH: ReadonlySet<string> = new Set(["CE:SHORT_BUILDUP", "CE:LONG_UNWINDING", "PE:LONG_BUILDUP", "PE:SHORT_COVERING"]);
const BUILDUP_WORDS: Record<FlowBuildup, string> = {
  LONG_BUILDUP: "long build-up",
  SHORT_BUILDUP: "short build-up",
  SHORT_COVERING: "short covering",
  LONG_UNWINDING: "long unwinding",
  NEUTRAL: "neutral",
};

/** What the option flow says for a trade in `side`, with the numbers. */
export function readFlow(flow: OptionFlowView | null, side: "BULL" | "BEAR", nowMs: number): FlowRead {
  if (!flow || flow.minutes === 0 || !flow.asOf || flow.source === "rest") {
    return { score: 0, available: false, dryUp: false, lines: ["No live option-flow reading (it needs the market feed's minute samples)."], cautions: [] };
  }
  const age = nowMs - Date.parse(flow.asOf);
  if (!(age <= FLOW_MAX_AGE_MS)) {
    return { score: 0, available: false, dryUp: false, lines: [`The option-flow reading is ${Math.round(age / MINUTE_MS)} min old: not used.`], cautions: [] };
  }
  const lines: string[] = [];
  const cautions: string[] = [];
  let bull = 0;
  const s = flow.summary;
  const lean = s.callWritersVsPutWriters;
  if (lean.lean === "PUT_WRITERS") bull += 0.4;
  else if (lean.lean === "CALL_WRITERS") bull -= 0.4;
  if (lean.lean !== "UNKNOWN") lines.push(lean.text);

  const step = flow.step ?? 0;
  const atm = flow.atm ?? 0;
  const ups: string[] = [];
  const downs: string[] = [];
  for (const r of flow.windows["15m"].rows) {
    if (!(step > 0) || Math.abs(r.strike - atm) > 3 * step + 1e-9) continue;
    for (const [k, q] of [
      ["CE", r.ce],
      ["PE", r.pe],
    ] as const) {
      if (!q || q.buildup === "NEUTRAL") continue;
      const tag = `${k}:${q.buildup}`;
      const words = `${r.strike} ${k} ${BUILDUP_WORDS[q.buildup]} (OI ${q.oiChgPct !== null ? `${q.oiChgPct >= 0 ? "+" : ""}${q.oiChgPct.toFixed(1)}%` : "?"}, price ${q.ltpChgPct !== null ? `${q.ltpChgPct >= 0 ? "+" : ""}${q.ltpChgPct.toFixed(1)}%` : "?"})`;
      if (BULLISH.has(tag)) ups.push(words);
      else if (BEARISH.has(tag)) downs.push(words);
    }
  }
  if (ups.length + downs.length > 0) {
    bull += (0.4 * (ups.length - downs.length)) / (ups.length + downs.length);
    lines.push(
      `ATM±3 over 15 min: ${ups.length} bullish build-up${ups.length === 1 ? "" : "s"}${ups.length ? ` (${ups.slice(0, 3).join("; ")})` : ""} vs ${downs.length} bearish${downs.length ? ` (${downs.slice(0, 3).join("; ")})` : ""}.`,
    );
  }
  if (s.pcr !== null && s.pcrChg15m !== null) {
    if (s.pcrChg15m >= 0.05) bull += 0.2;
    else if (s.pcrChg15m <= -0.05) bull -= 0.2;
    lines.push(`PCR ${s.pcr.toFixed(2)} (${s.pcrChg15m >= 0.005 ? "+" : s.pcrChg15m <= -0.005 ? "−" : "±"}${Math.abs(s.pcrChg15m).toFixed(2)} in 15 min).`);
  }
  if (s.resistance || s.support) {
    lines.push(
      [s.resistance ? `resistance ${lvl(s.resistance.strike)} (most call OI)` : null, s.support ? `support ${lvl(s.support.strike)} (most put OI)` : null]
        .filter(Boolean)
        .join(", ")
        .replace(/^./, (c) => c.toUpperCase()) + ".",
    );
  }
  if (s.decayPctPerHourAtm !== null) lines.push(`ATM premium ${s.decayPctPerHourAtm >= 0 ? "losing" : "gaining"} ${Math.abs(s.decayPctPerHourAtm).toFixed(1)}% an hour beyond what the index move explains.`);
  if (s.premiumDryUp) cautions.push(s.dryUpDetail);
  if (flow.bestEntryWindow.verdict === "expensive") cautions.push(flow.bestEntryWindow.text);
  else if (flow.bestEntryWindow.verdict === "good" || flow.bestEntryWindow.verdict === "average") lines.push(flow.bestEntryWindow.text);
  const score = Math.max(-1, Math.min(1, bull)) * (side === "BULL" ? 1 : -1);
  return { score: r2(score), available: true, dryUp: s.premiumDryUp, lines, cautions };
}

const windowKeyFor = (min: number | undefined): FlowWindowKey => (min !== undefined && min <= 2 ? "1m" : min !== undefined && min <= 9 ? "5m" : "15m");

export interface RuleContext {
  index: IndexId;
  optionType: OptionType;
  setup: TradeSetupView | null;
  flow: OptionFlowView | null;
  flowScore: number;
  /** IST minutes of the day. */
  minutes: number;
  now: number;
}

/** Whether a research rule's live condition holds now (see the header for the detectors). */
export function ruleMatches(rule: RuleStats, x: RuleContext): boolean {
  if (rule.index !== "BOTH" && rule.index !== x.index) return false;
  if (rule.side !== "EITHER" && rule.side !== x.optionType) return false;
  const w = parseWindow(rule.bestEntryWindow);
  if (w && (x.minutes < w.from || x.minutes >= w.to)) return false;
  const p = rule.params ?? {};
  const id = rule.id.toUpperCase();
  const flow = x.flow && x.flow.minutes > 0 && x.flow.source !== "rest" ? x.flow : null;
  const setupRe = /^(ORB|PDH_PDL|VWAP_PULLBACK|RANGE_REVERSAL)_(BULL|BEAR)(?:_(.+))?$/.exec(id);
  if (setupRe) {
    if (!x.setup || x.setup.kind !== setupRe[1] || x.setup.side !== setupRe[2]) return false;
    if (setupRe[3] && /OI|FLOW/.test(setupRe[3])) return flow !== null && x.flowScore >= (p.minFlowScore ?? FLOW_AGREE);
    return true;
  }
  if (!flow) return false;
  const step = flow.step ?? 0;
  const atm = flow.atm ?? 0;
  const near = (strike: number, n: number) => step > 0 && Math.abs(strike - atm) <= n * step + 1e-9;
  // A flow rule open to either side buys the option its direction implies (put writers adding → calls).
  const implied = (bullish: boolean) => rule.side !== "EITHER" || x.optionType === (bullish ? "CE" : "PE");
  const oiRe = /^OI_(LONG_BUILDUP|SHORT_BUILDUP|SHORT_COVERING|LONG_UNWINDING)_(CE|PE)$/.exec(id);
  if (oiRe) {
    if (!implied(BULLISH.has(`${oiRe[2]}:${oiRe[1]}`))) return false;
    const rows = flow.windows[windowKeyFor(p.windowMin)].rows;
    const key = oiRe[2] === "CE" ? "ce" : "pe";
    return rows.some((r) => {
      const q = r[key];
      return near(r.strike, p.strikes ?? 2) && q !== null && q.buildup === oiRe[1] && Math.abs(q.oiChgPct ?? 0) >= (p.minOiChgPct ?? 0);
    });
  }
  if (id.startsWith("VOL_SPIKE")) {
    // Only the up-spike rules have a live detector. DOWN_FADE (a down-tick spike on the other side) and DTE
    // (a baseline matched on days to expiry) are conditions the monitor does not track, so they never match.
    if (!/^VOL_SPIKE_(UP|ATM)(_ENGINE)?(_NIFTY|_SENSEX)?$/.test(id)) return false;
    const since = x.now - (p.windowMin ?? 5) * MINUTE_MS;
    return flow.events.some(
      (e) =>
        e.kind === "VOLUME_SPIKE" &&
        Date.parse(e.at) >= since &&
        e.side === x.optionType &&
        e.strike !== null &&
        near(e.strike, p.strikes ?? 1) &&
        (e.volMultiple ?? 0) >= (p.k ?? 5) &&
        (e.ltpChgPct ?? 0) > (p.minLtpChgPct ?? 0),
    );
  }
  if (/DRY_?UP/.test(id)) return flow.summary.premiumDryUp;
  const pcr = /^PCR_(RISE|UP|FALL|DOWN)/.exec(id);
  if (pcr) {
    const chg = flow.summary.pcrChg15m;
    if (chg === null) return false;
    const min = p.minChg ?? 0.05;
    const rising = pcr[1] === "RISE" || pcr[1] === "UP";
    if (!implied(rising)) return false;
    return rising ? chg >= min : chg <= -min;
  }
  const writers = /^(PUT|CALL)_WRITERS/.exec(id);
  if (writers) return implied(writers[1] === "PUT") && flow.summary.callWritersVsPutWriters.lean === (writers[1] === "PUT" ? "PUT_WRITERS" : "CALL_WRITERS");
  return false;
}

/** The matching rules, positive ones first, then by test sample. */
export function matchRules(rules: readonly RuleStats[], x: RuleContext): RuleStats[] {
  return rules.filter((r) => ruleMatches(r, x)).sort((a, b) => Number(isPositiveRule(b)) - Number(isPositiveRule(a)) || b.sample - a.sample);
}

function historicalOf(primary: RuleStats | null, matched: RuleStats[], stats: FlowStatsFile): RecommendationView["historical"] {
  if (!primary) {
    return {
      ruleIds: [],
      title: null,
      sample: 0,
      inSample: 0,
      hitRate: null,
      avgPnlPerLot: null,
      medianPnlPerLot: null,
      ci95: null,
      verdict: "none",
      dataRange: null,
      text: stats.rules.length === 0 ? "No measured statistics are loaded yet." : "No measured rule matches this trade right now.",
    };
  }
  const verdict = isPositiveRule(primary) ? "positive" : primary.verdict === "positive" ? "not_proven" : primary.verdict;
  return {
    ruleIds: matched.map((r) => r.id),
    title: primary.title,
    sample: primary.sample,
    inSample: primary.inSample,
    hitRate: primary.hitRate,
    avgPnlPerLot: primary.avgPnlPerLot,
    medianPnlPerLot: primary.medianPnlPerLot,
    ci95: [primary.ci95[0], primary.ci95[1]],
    verdict,
    dataRange: primary.dataRange,
    text: `${primary.title}: ${Math.round(primary.hitRate * 100)}% of ${primary.sample} out-of-sample trades made money after charges; average ${inr(primary.avgPnlPerLot)} a lot (median ${inr(primary.medianPnlPerLot)}), 95% interval ${inr(primary.ci95[0])} to ${inr(primary.ci95[1])}; ${primary.dataRange}. Verdict: ${verdict === "positive" ? "a positive measured edge" : verdict === "negative" ? "it lost money" : "not proven"}.`,
  };
}

function honestLine(grade: RecommendationView["grade"], primary: RuleStats | null, stats: FlowStatsFile, noTrade = false): string | null {
  if (grade === "A") return null;
  const stat =
    stats.rules.length === 0
      ? "No measured statistics are loaded yet, so nothing can be graded A."
      : primary
        ? `The matching rule ${primary.id} is ${isPositiveRule(primary) ? "positive" : primary.verdict === "negative" ? "negative" : "not proven"}: ${primary.sample} test trades, average ${inr(primary.avgPnlPerLot)} a lot after charges, 95% interval ${inr(primary.ci95[0])} to ${inr(primary.ci95[1])}.`
        : "No measured rule with a positive result matches this trade.";
  const lead = noTrade
    ? "No trade to grade right now."
    : grade === "B"
      ? "Edge not proven: the chart setup and the live option flow agree, but that is a reading, not a measured edge."
      : "Watch only: the setup and the option flow do not line up into a trade, and no measured edge applies.";
  const research = stats.honestSummary[0] && stats.honestSummary[0] !== "Historical statistics are being computed." ? ` ${stats.honestSummary[0]}` : "";
  return `${lead} ${stat}${research}`;
}

// ---------------------------------------------------------------------------
// The recommendation
// ---------------------------------------------------------------------------

function blank(x: RecommendInput, capital: number, status: RecommendationView["status"], headline: string, reasons: string[], cautions: string[] = []): RecommendationView {
  const historical = historicalOf(null, [], x.stats);
  return {
    index: x.index,
    status,
    grade: "C",
    headline,
    at: istIso(x.now),
    capital,
    side: null,
    setup: null,
    contract: null,
    entry: null,
    stop: null,
    target: null,
    timeExit: null,
    qty: null,
    risk: null,
    reasons,
    cautions,
    historical,
    honest: honestLine("C", null, x.stats, true),
    sizing: [],
    flowAsOf: x.flow?.asOf ?? null,
  };
}

const asContract = (c: RecoCandidate["contract"]): OptionContract => ({
  index: c.index,
  exchange: c.exchange,
  tradingSymbol: c.tradingSymbol,
  growwSymbol: "",
  exchangeToken: "",
  expiry: c.expiry,
  strike: c.strike,
  type: c.optionType,
  lotSize: c.lotSize,
  tickSize: c.tickSize,
});

export function recommend(x: RecommendInput): RecommendationView {
  const capital = x.capital ?? RECO_CAPITAL;
  const minutes = istMinutes(x.now);
  const date = istDate(x.now);
  const charges = x.chargesFor ?? roundTripCharges;
  const cutoff = x.isExpiryDay ? EXPIRY_DAY_UNTIL : RECO_UNTIL;
  const squareOff = parseHHMM(x.exits.squareOffIst);

  if (!x.phaseOpen) return blank(x, capital, "NO_TRADE", `${x.index}: market closed — no trade.`, ["The market is closed."]);
  if (minutes < parseHHMM(RECO_FROM)) return blank(x, capital, "WAIT", `${x.index}: nothing new before ${RECO_FROM} IST.`, [`Nothing new before ${RECO_FROM} IST: the first ten minutes carry the day's richest premium and no setup has formed.`]);
  if (minutes > parseHHMM(RECO_UNTIL)) return blank(x, capital, "NO_TRADE", `${x.index}: no new trades after ${RECO_UNTIL} IST.`, [`No new trades after ${RECO_UNTIL} IST: too little time is left for a trade to work.`]);
  if (x.isExpiryDay && minutes > parseHHMM(EXPIRY_DAY_UNTIL)) return blank(x, capital, "NO_TRADE", `${x.index}: expiry day — no new trades after ${EXPIRY_DAY_UNTIL} IST.`, [`${x.index}'s weekly contract expires today: nothing new after ${EXPIRY_DAY_UNTIL} IST.`]);
  if (x.plan?.verdict === "no_trade") {
    const blocks = x.plan.checks.filter((c) => c.status === "block").map((c) => `${c.label}: ${c.detail}`);
    return blank(x, capital, "NO_TRADE", x.plan.headline, blocks.length > 0 ? blocks : [x.plan.headline]);
  }
  const planCautions = (x.plan?.checks ?? []).filter((c) => c.status === "caution").map((c) => `${c.label}: ${c.detail}`);

  const setup = pickSetup(x.setups);
  if (!setup) {
    const ctx = x.flow ? readFlow(x.flow, "BULL", x.now) : null;
    return blank(x, capital, "WAIT", `${x.index}: WAIT — no chart setup near the price.`, ["No chart setup is near the price: nothing to buy yet.", ...(ctx?.available ? ctx.lines : [])], [...planCautions, ...(ctx?.cautions ?? [])]);
  }
  const side = setup.side;
  const optionType: OptionType = side === "BULL" ? "CE" : "PE";
  const flow = readFlow(x.flow, side, x.now);
  const sgn = side === "BULL" ? 1 : -1;
  const spot = x.spot ?? setup.spot;

  const setupLine = `${setup.name} (${setup.status.toLowerCase()}): trigger ${lvl(setup.trigger)} — ${setup.condition}; stop ${lvl(setup.stop)}, targets ${lvl(setup.t1)} (${setup.t1Label}) and ${lvl(setup.t2)} (${setup.t2Label}); index R:R ${setup.rr1.toFixed(2)}.`;
  const evidence = setup.evidence.map((e) => (e.supports ? e.text : `Against: ${e.text}`));
  const reasons = [setupLine, ...evidence.slice(0, 5), ...(flow.available ? [`Option flow ${flow.score >= FLOW_AGREE ? "agrees" : flow.score <= -FLOW_AGREE ? "disagrees" : "is mixed"} (score ${flow.score.toFixed(2)} for a ${side === "BULL" ? "rise" : "fall"}).`] : []), ...flow.lines];
  const cautions = [...setup.cautions, ...planCautions, ...flow.cautions];

  const cands = x.candidates.filter((c) => c.contract.optionType === optionType && c.contract.index === x.index);
  const matched = matchRules(x.stats.rules, { index: x.index, optionType, setup, flow: x.flow, flowScore: flow.score, minutes, now: x.now });
  const primary = matched[0] ?? null;
  const edge = primary !== null && isPositiveRule(primary);
  const historical = historicalOf(primary, matched, x.stats);
  const setupRef = { id: setup.id, name: setup.name, kind: setup.kind, status: setup.status };

  if (cands.length === 0) {
    const v = blank(x, capital, "WAIT", `${x.index}: WAIT — ${setup.name.toLowerCase()} ${setup.status.toLowerCase()}, no option quote yet.`, [...reasons, "No quote for the option yet: the price to pay is unknown."], cautions);
    return { ...v, side, setup: setupRef, historical };
  }
  const triggered = setup.status === "TRIGGERED";
  // Strikes are chosen and sized on the limit actually paid: the ask now, or the premium at the trigger.
  const priced = new Map(cands.map((c) => [c.contract.strike, entryPrice(c, triggered, spot, setup.trigger)]));
  const atLimit = cands.map((c) => ({ ...c, premium: priced.get(c.contract.strike)!.limit }));
  const { fit, cheapest } = chooseStrike(atLimit, capital, date, charges);
  const footnote = sizingFootnote(atLimit, x, date, charges, setup, edge ? primary : null);
  if (!fit) {
    const why = cheapest
      ? `No ${x.index} ${optionType} lot with delta ${MIN_DELTA.toFixed(2)}–${MAX_DELTA.toFixed(2)} fits ${inr(capital)}: the cheapest, ${cheapest.c.contract.strike} ${optionType} (delta ${Math.abs(cheapest.c.delta).toFixed(2)}), costs ${inr(cheapest.total)} a lot with charges. The plan skips the day rather than buy a far out-of-the-money strike.`
      : `No ${x.index} ${optionType} strike with delta ${MIN_DELTA.toFixed(2)}–${MAX_DELTA.toFixed(2)} among the quoted ones.`;
    const v = blank(x, capital, "NO_TRADE", `${x.index}: NO TRADE for ${inr(capital)} — no lot with delta ≥ ${MIN_DELTA.toFixed(2)} fits.`, [why, ...reasons], cautions);
    return { ...v, side, setup: setupRef, historical, sizing: footnote };
  }

  const c = cands.find((y) => y.contract.strike === fit.pick.contract.strike)!;
  const tick = c.contract.tickSize || 0.05;
  const { entry: entryRef, limit } = priced.get(c.contract.strike)!;
  const minutesLeft = Math.max(0, squareOff - minutes);
  // Entering now: priced at the index now. Waiting: priced at the trigger.
  const plan = optionPlan({
    contract: asContract(c.contract),
    premiumNow: c.premium,
    priceSource: c.priceSource === "model" ? "model" : "broker",
    iv: c.iv,
    spot,
    greeks: { delta: c.delta, gamma: c.gamma, thetaPerMin: c.thetaPerMin },
    trigger: triggered ? spot : setup.trigger,
    stop: setup.stop,
    t1: setup.t1,
    t2: setup.t2,
    maxStopPct: x.exits.stopPct,
    minutesLeft,
  });
  const capPrice = (pct: number, mode: "up" | "down") => roundToTick(limit * (1 + pct / 100), tick, mode);
  let stop: number;
  let t1: number;
  let t2: number;
  let timeExitMin: number;
  if (edge && primary) {
    // The measured exits, the stop only when tighter than the engine's.
    const stopPct = Math.max(primary.stopPct, x.exits.stopPct);
    stop = capPrice(stopPct, "up");
    t1 = capPrice(primary.targetPct, "down");
    t2 = t1;
    timeExitMin = Math.min(firstHHMM(primary.timeExit) ?? minutes + HOLD_MIN.t2, squareOff);
  } else {
    const scale = limit / plan.entry;
    stop = Math.max(roundToTick(plan.stop * scale, tick, "up"), capPrice(x.exits.stopPct, "up"));
    const cap = capPrice(x.exits.targetPct, "down");
    t1 = Math.min(roundToTick(plan.t1 * scale, tick, "down"), cap);
    t2 = Math.min(roundToTick(plan.t2 * scale, tick, "down"), cap);
    timeExitMin = Math.min(minutes + HOLD_MIN.t2, squareOff);
  }
  stop = Math.min(stop, Math.max(tick, limit - tick));
  t1 = Math.max(t1, limit + tick);
  t2 = Math.max(t2, t1);

  const perLot = lotCost(c, limit, 1, date, charges);
  const riskPerLot = (limit - stop) * c.contract.lotSize + perLot.chargesRupees;
  const lots = sizeLots(capital, perLot.totalRupees, riskPerLot);
  const fits = lots >= 1;
  const cost = lotCost(c, limit, Math.max(1, lots), date, charges);
  const riskRupees = r2((limit - stop) * cost.units + cost.chargesRupees);
  const rewardT1 = r2((t1 - limit) * cost.units - cost.chargesRupees);
  const rewardT2 = r2((t2 - limit) * cost.units - cost.chargesRupees);

  // A: a positive measured rule matches and the flow does not oppose it; B: the flow agrees with the setup.
  const flowAgrees = flow.available && flow.score >= FLOW_AGREE;
  const grade: RecommendationView["grade"] = edge && flow.score > -FLOW_AGREE ? "A" : flowAgrees ? "B" : "C";
  const live = c.priceSource !== "model";
  const insideChase = sgn * (spot - setup.chaseLimit) <= 0;
  const waits: string[] = [];
  if (!triggered) waits.push(setup.status === "READY" ? "the price is at the trigger but no 5-minute candle has confirmed it yet" : "the setup has not triggered yet");
  if (grade === "C") waits.push(flow.available ? `the option flow does not confirm (score ${flow.score.toFixed(2)})` : "there is no live option-flow reading to confirm it");
  if (x.eventBlackout) waits.push(x.eventBlackout);
  if (flow.dryUp) waits.push("premium is drying up at ATM");
  if (!live) waits.push("there is no live quote for the option (model price only)");
  if (!insideChase) waits.push(`the index is past the chase limit ${lvl(setup.chaseLimit)}`);
  if (!fits) waits.push(`one lot does not fit ${inr(capital)}`);
  const status: RecommendationView["status"] = waits.length === 0 ? "ENTER" : "WAIT";

  const validUntilMs = status === "ENTER" ? Math.min(x.now + ENTER_VALID_MS, x.now + (parseHHMM(cutoff) - minutes) * MINUTE_MS) : x.now + Math.max(0, parseHHMM(cutoff) - minutes) * MINUTE_MS;
  const label = contractLabel({ index: c.contract.index, expiry: c.contract.expiry, strike: c.contract.strike, optionType });
  const what = `${x.index} ${c.contract.strike} ${optionType} (${shortDate(c.contract.expiry)})`;
  const timeExit = formatHHMM(timeExitMin);
  const lotsText = `${Math.max(1, lots)} lot${lots > 1 ? "s" : ""}`;
  const headline =
    status === "ENTER"
      ? `BUY ${lotsText} ${what} at ≤ ${inr2(limit)} · stop ${inr2(stop)} · target ${inr2(t1)}${t2 > t1 ? ` / ${inr2(t2)}` : ""} · out by ${timeExit}`
      : triggered
        ? `WAIT: ${setup.name} triggered, but ${waits[0]}.`
        : `WAIT: buy ${what} at ≤ ${inr2(limit)} only if ${setup.condition}.`;
  if (!triggered) reasons.push(`Entry is priced at the trigger: about ${inr2(entryRef)} when the index reaches ${lvl(setup.trigger)} (delta ${Math.abs(c.delta).toFixed(2)} and gamma from ${inr2(c.premium)} now).`);
  reasons.push(`Contract: ${label}, delta ${Math.abs(c.delta).toFixed(2)}${c.iv !== null ? `, IV ${c.iv.toFixed(1)}%` : ""}; ${c.priceSource === "model" ? "model price (no live quote)" : `ask ${c.ask !== null ? inr2(c.ask) : "?"}${c.bid !== null ? `, bid ${inr2(c.bid)}` : ""} (${c.priceSource})`}.`);
  reasons.push(
    edge
      ? `Exits as measured by ${primary!.id}: target ${primary!.targetPct >= 0 ? "+" : ""}${primary!.targetPct}%, stop ${Math.max(primary!.stopPct, x.exits.stopPct)}%, out by ${timeExit}.`
      : `Exits: the index stop ${lvl(setup.stop)} mapped to the premium (never more than −${Math.abs(x.exits.stopPct)}%), targets at the index levels capped at +${x.exits.targetPct}%, out ${HOLD_MIN.t2} minutes after entry (${timeExit} if entered now) and by ${x.exits.squareOffIst} at the latest.`,
  );
  if (!live) cautions.push("No live quote for this contract: the price is a model estimate. Check the real ask in your broker app before acting.");
  if (status === "WAIT" && waits.length > 0) reasons.push(`Waiting because ${waits.join("; ")}.`);

  return {
    index: x.index,
    status,
    grade,
    headline,
    at: istIso(x.now),
    capital,
    side,
    setup: setupRef,
    contract: {
      index: c.contract.index,
      expiry: c.contract.expiry,
      strike: c.contract.strike,
      optionType,
      tradingSymbol: c.contract.tradingSymbol,
      lotSize: c.contract.lotSize,
      label,
      delta: r2(c.delta),
      iv: c.iv,
      priceSource: c.priceSource,
    },
    entry: {
      limit,
      ask: c.ask,
      bid: c.bid,
      validUntil: istIso(validUntilMs),
      trigger: triggered ? `Triggered at ${lvl(setup.trigger)}: buy only while ${x.index} is ${side === "BULL" ? "below" : "above"} ${lvl(setup.chaseLimit)} (the chase limit).` : `${x.index}: ${setup.condition}.`,
      triggerLevel: setup.trigger,
      chaseLimit: setup.chaseLimit,
    },
    stop: { premium: stop, pct: r2((stop / limit - 1) * 100), index: setup.stop },
    target: { t1, t2, t1Pct: r2((t1 / limit - 1) * 100), t2Pct: r2((t2 / limit - 1) * 100), indexT1: setup.t1, indexT2: setup.t2 },
    timeExit,
    qty: fits ? { lots, units: cost.units, premiumRupees: cost.premiumRupees, chargesRupees: cost.chargesRupees, totalRupees: cost.totalRupees } : null,
    risk: fits ? { riskRupees, rewardT1Rupees: rewardT1, rewardT2Rupees: rewardT2, rr1: riskRupees > 0 ? r2(rewardT1 / riskRupees) : 0, rr2: riskRupees > 0 ? r2(rewardT2 / riskRupees) : 0, pctOfCapital: r2((riskRupees / capital) * 100) } : null,
    reasons,
    cautions,
    historical,
    honest: honestLine(grade, primary, x.stats),
    sizing: footnote,
    flowAsOf: x.flow?.asOf ?? null,
  };
}

/** The same trade sized for the footnote's capitals. */
function sizingFootnote(
  cands: readonly RecoCandidate[],
  x: RecommendInput,
  date: string,
  charges: NonNullable<RecommendInput["chargesFor"]>,
  setup: TradeSetupView,
  edgeRule: RuleStats | null,
): RecommendationView["sizing"] {
  const stopPct = edgeRule ? Math.max(edgeRule.stopPct, x.exits.stopPct) : x.exits.stopPct;
  return (x.footnoteCapitals ?? FOOTNOTE_CAPITALS).map((capital) => {
    const { fit, cheapest } = chooseStrike(cands, capital, date, charges);
    if (!fit) {
      return {
        capital,
        fits: false,
        lots: 0,
        strike: null,
        optionType: null,
        totalRupees: null,
        text: cheapest ? `${inr(capital)}: no lot fits (the cheapest with delta ≥ ${MIN_DELTA.toFixed(2)}, ${cheapest.c.contract.strike} ${cheapest.c.contract.optionType}, costs ${inr(cheapest.total)}).` : `${inr(capital)}: no eligible strike quoted.`,
      };
    }
    const c = fit.pick;
    const riskPerLot = c.premium * c.contract.lotSize * (Math.abs(stopPct) / 100) + fit.chargesRupees;
    const lots = sizeLots(capital, fit.totalRupees, riskPerLot);
    const total = lotCost(c, c.premium, lots, date, charges).totalRupees;
    return {
      capital,
      fits: true,
      lots,
      strike: c.contract.strike,
      optionType: c.contract.optionType,
      totalRupees: total,
      text: `${inr(capital)}: ${lots} lot${lots > 1 ? "s" : ""} of ${c.contract.strike} ${c.contract.optionType} (delta ${Math.abs(c.delta).toFixed(2)}) at ≤ ${inr2(c.premium)}, ${inr(total)} with charges${lots > 1 ? `; lots capped so the stop loses at most ${MAX_RISK_PCT}% of the capital` : ""}${c.priceSource === "model" ? " (model price)" : ""}.`,
    };
  });
}
