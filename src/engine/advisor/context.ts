/**
 * The advisor's context builder (pure, no I/O): turns what the engine already serves (live index levels,
 * signals, option flow, option chains across expiries, news, scheduled events, today's plan, the paper book)
 * into one compact JSON for the advice call, plus the list of real listed contracts the model may pick from.
 *
 * The readings a beginner cannot do by eye are computed here, not left to the model: short covering per
 * expiry and on the live flow, the premium read (ATM IV across expiries, IV against VIX, events that could
 * deflate premiums, the measured cheapest time of day), and the zero-hero odds. Missing data stays null and
 * is listed under `dataGaps`; nothing is invented.
 */
import { buildOutlook, daysToExpiry, monthlyExpiries, outlookHeadline, type OutlookExpiry } from "../../lib/options/outlook";
import {
  contractLabel,
  type EventClusterView,
  type IndexId,
  type LiveIndexLevelsView,
  type OptionChainRowView,
  type OptionChainView,
  type OptionFlowView,
  type OptionSideView,
  type OptionType,
  type ScheduledEventView,
  type SignalView,
} from "../api-types";
import { SESSION, istDate, istIso, istMinutes, istParts } from "../clock";
import { FLOW_STATS } from "../flow/flowStats";
import { optionTradingSymbol } from "../instruments/syntheticInstruments";
import { RESEARCH_FINDINGS } from "./knowledge";
import type { AdvisorCalendar, AdvisorCandidate, AdvisorContext, AdvisorImpliedRange, AdvisorInputs, CandidateExpiryKind, ZeroHeroCandidate } from "./types";

export const ADVISOR_INDICES: readonly IndexId[] = ["NIFTY", "SENSEX"];
/** Calendar days of expiries the outlook reads. */
export const OUTLOOK_DAYS = 35;
/** Strikes either side of the ATM strike offered as candidates. */
export const CANDIDATE_STRIKES_EACH_SIDE = 3;
/** Zero-hero: a contract expiring today priced at or under this many rupees. */
export const ZERO_HERO_MAX_PRICE = 10;
export const ZERO_HERO_PER_SIDE = 3;
export const TOP_NEWS = 15;
export const FII_NEWS = 8;
export const NEWS_HOURS = 48;
export const SCHEDULED_DAYS = 30;
/** The owner's typical capital (rupees): ideas are sized and filtered for it. */
export const DEFAULT_CAPITAL = 10_000;

/** A move counts as "rising" or "falling" beyond ±0.10%, and an OI change as meaningful beyond ±2% of the OI. */
export const MOVE_THRESHOLD_PCT = 0.1;
export const OI_THRESHOLD_PCT = 2;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pos = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
const fin = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function candidateId(index: IndexId, expiry: string, strike: number, type: OptionType): string {
  return `${index}-${expiry}-${strike}-${type}`;
}

// ---------------------------------------------------------------------------
// Short covering (computed in code)
// ---------------------------------------------------------------------------

export type ShortCoveringLean = "BULLISH" | "BEARISH" | "NEUTRAL" | "NO_DATA";

export interface ShortCoveringRead {
  lean: ShortCoveringLean;
  /** CALL_COVERING, PUT_COVERING, CALL_WRITING, PUT_WRITING: the patterns found. */
  signals: string[];
  text: string;
}

export interface ShortCoveringInput {
  /** The index's change today, percent (vs the previous close). */
  indexChangePct: number | null;
  /** OI change since the previous close, summed over the chain, per side. */
  ceOiChange: number | null;
  peOiChange: number | null;
  /** Current total OI per side. */
  ceOi: number | null;
  peOi: number | null;
}

/** OI change as a percent of the previous session's OI (OI now minus the change). */
function oiChangePct(change: number | null, now: number | null): number | null {
  if (!fin(change) || !pos(now)) return null;
  const before = now - change;
  return before > 0 ? (change / before) * 100 : null;
}

/**
 * Short covering from the day's OI change and the index move:
 * - call OI falling with the index rising: call writers buying back (covering) → bullish;
 * - put OI falling with the index falling: put writers covering → bearish;
 * - call OI rising with the index falling (call writing, resistance building) → bearish;
 * - put OI rising with the index rising (put writing, support building) → bullish.
 */
export function shortCoveringRead(i: ShortCoveringInput): ShortCoveringRead {
  const move = i.indexChangePct;
  const ce = oiChangePct(i.ceOiChange, i.ceOi);
  const pe = oiChangePct(i.peOiChange, i.peOi);
  if (!fin(move) || (ce == null && pe == null)) return { lean: "NO_DATA", signals: [], text: "No data: the index move or the open-interest change is missing." };
  const rising = move >= MOVE_THRESHOLD_PCT;
  const falling = move <= -MOVE_THRESHOLD_PCT;
  const big = (p: number | null): p is number => p != null && Math.abs(p) >= OI_THRESHOLD_PCT;
  const signals: string[] = [];
  const parts: string[] = [];
  let score = 0;
  const m = `${move >= 0 ? "+" : ""}${r2(move)}%`;
  if (rising && big(ce) && ce < 0) {
    signals.push("CALL_COVERING");
    parts.push(`call OI fell ${r1(-ce)}% while the index rose ${m}: call writers are covering (buying back), which tends to push the index up`);
    score++;
  }
  if (falling && big(pe) && pe < 0) {
    signals.push("PUT_COVERING");
    parts.push(`put OI fell ${r1(-pe)}% while the index fell ${m}: put writers are covering, which tends to push the index down`);
    score--;
  }
  if (falling && big(ce) && ce > 0) {
    signals.push("CALL_WRITING");
    parts.push(`call OI rose ${r1(ce)}% while the index fell ${m}: call writers are adding (resistance building)`);
    score--;
  }
  if (rising && big(pe) && pe > 0) {
    signals.push("PUT_WRITING");
    parts.push(`put OI rose ${r1(pe)}% while the index rose ${m}: put writers are adding (support building)`);
    score++;
  }
  if (signals.length === 0) {
    const ceTxt = ce == null ? "call OI change unknown" : `call OI ${ce >= 0 ? "+" : ""}${r1(ce)}%`;
    const peTxt = pe == null ? "put OI change unknown" : `put OI ${pe >= 0 ? "+" : ""}${r1(pe)}%`;
    return { lean: "NEUTRAL", signals, text: `No short covering: index ${m}, ${ceTxt}, ${peTxt} since yesterday.` };
  }
  const lean: ShortCoveringLean = score > 0 ? "BULLISH" : score < 0 ? "BEARISH" : "NEUTRAL";
  const text = parts.join("; ");
  return { lean, signals, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
}

/**
 * Short covering on the live flow (the 15-minute window, or the day on the REST fallback): strikes whose
 * price rose while OI fell. Calls covering → bullish; puts covering → bearish; short build-up on calls
 * (price down, OI up) → bearish, on puts → bullish. Needs at least 2 strikes agreeing.
 */
export function flowShortCoveringRead(flow: OptionFlowView | null): ShortCoveringRead & { window: string | null; counts: Record<string, number> } {
  const empty = { window: null, counts: {} };
  if (!flow) return { lean: "NO_DATA", signals: [], text: "No data: the option flow could not be read.", ...empty };
  const w = flow.windows["15m"]?.rows.length ? { key: "15 minutes", rows: flow.windows["15m"].rows } : flow.day?.rows.length ? { key: "the day", rows: flow.day.rows } : null;
  if (!w) return { lean: "NO_DATA", signals: [], text: "No data: the flow has no minutes yet.", ...empty };
  const counts = { ceCovering: 0, peCovering: 0, ceBuildup: 0, peBuildup: 0 };
  for (const r of w.rows) {
    if (r.ce?.buildup === "SHORT_COVERING") counts.ceCovering++;
    if (r.pe?.buildup === "SHORT_COVERING") counts.peCovering++;
    if (r.ce?.buildup === "SHORT_BUILDUP") counts.ceBuildup++;
    if (r.pe?.buildup === "SHORT_BUILDUP") counts.peBuildup++;
  }
  const bull = (counts.ceCovering >= 2 ? counts.ceCovering : 0) + (counts.peBuildup >= 2 ? counts.peBuildup : 0);
  const bear = (counts.peCovering >= 2 ? counts.peCovering : 0) + (counts.ceBuildup >= 2 ? counts.ceBuildup : 0);
  const signals: string[] = [];
  if (counts.ceCovering >= 2) signals.push("CALL_COVERING");
  if (counts.peCovering >= 2) signals.push("PUT_COVERING");
  if (counts.ceBuildup >= 2) signals.push("CALL_WRITING");
  if (counts.peBuildup >= 2) signals.push("PUT_WRITING");
  const lean: ShortCoveringLean = bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "NEUTRAL";
  const text =
    `Over ${w.key}: ${counts.ceCovering} call strikes and ${counts.peCovering} put strikes show short covering (price up, OI down); ` +
    `${counts.ceBuildup} call and ${counts.peBuildup} put strikes show short build-up (price down, OI up). ` +
    (lean === "BULLISH" ? "Leans up (call writers covering or put writers adding)." : lean === "BEARISH" ? "Leans down (put writers covering or call writers adding)." : "No clear lean.");
  return { lean, signals, text, window: w.key, counts };
}

// ---------------------------------------------------------------------------
// Premium read
// ---------------------------------------------------------------------------

export interface PremiumRead {
  vix: number | null;
  /** ATM IV per expiry, nearest first. */
  ivByExpiry: { expiry: string; days: number; atmIv: number | null }[];
  /** Nearest priced expiry's ATM IV minus India VIX, vol points. */
  ivMinusVix: number | null;
  /** Nearest IV vs the next expiry's: INVERTED (near richer, often before an event), UPWARD, FLAT. */
  termStructure: "INVERTED" | "UPWARD" | "FLAT" | null;
  /** HIGH-impact scheduled events before each expiry: IV usually drops ("IV crush") once they pass. */
  eventsBeforeExpiry: { expiry: string; events: string[] }[];
  /** Rough rule of thumb from the numbers above (not a measured edge). */
  ruleOfThumb: "CHEAP" | "NORMAL" | "EXPENSIVE" | "NO_DATA";
  text: string;
}

export function premiumRead(vix: number | null, expiries: readonly OutlookExpiry[]): PremiumRead {
  const ivByExpiry = expiries.map((e) => ({ expiry: e.expiry, days: e.days, atmIv: e.atmIv }));
  const priced = expiries.filter((e) => pos(e.atmIv) && e.days > 0);
  const near = priced[0] ?? null;
  const next = priced[1] ?? null;
  const ivMinusVix = near && pos(vix) ? r2((near.atmIv as number) - vix) : null;
  const diff = near && next ? (near.atmIv as number) - (next.atmIv as number) : null;
  const termStructure = diff == null ? null : diff > 1 ? "INVERTED" : diff < -1 ? "UPWARD" : "FLAT";
  const eventsBeforeExpiry = expiries
    .map((e) => ({ expiry: e.expiry, events: e.events.filter((ev) => ev.impact === "HIGH").map((ev) => `${ev.title} (${ev.at.slice(0, 16).replace("T", " ")})`) }))
    .filter((e) => e.events.length > 0);
  let ruleOfThumb: PremiumRead["ruleOfThumb"] = "NO_DATA";
  if (ivMinusVix != null) ruleOfThumb = ivMinusVix > 2 || termStructure === "INVERTED" ? "EXPENSIVE" : ivMinusVix < -2 ? "CHEAP" : "NORMAL";
  else if (termStructure != null) ruleOfThumb = termStructure === "INVERTED" ? "EXPENSIVE" : "NORMAL";
  const bits: string[] = [];
  if (near) bits.push(`nearest ATM IV ${near.atmIv}% (${near.expiry})`);
  if (pos(vix)) bits.push(`India VIX ${r2(vix)}`);
  if (ivMinusVix != null) bits.push(`IV ${ivMinusVix >= 0 ? "+" : ""}${ivMinusVix} points vs VIX`);
  if (termStructure) bits.push(`term structure ${termStructure.toLowerCase()}`);
  if (eventsBeforeExpiry.length > 0) bits.push(`high-impact events before ${eventsBeforeExpiry.map((e) => e.expiry).join(", ")} (IV usually drops after them)`);
  return { vix: pos(vix) ? vix : null, ivByExpiry, ivMinusVix, termStructure, eventsBeforeExpiry, ruleOfThumb, text: bits.length ? bits.join("; ") : "No data" };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** The expiries ideas may use: the nearest one not expiring today, the next weekly, and the monthly within 35 days. */
export function candidateExpiries(listed: readonly string[], nowMs: number, index: IndexId, calendar: Pick<AdvisorCalendar, "isTradingDay" | "followingExpiry">, horizonDays = OUTLOOK_DAYS): { expiry: string; kind: CandidateExpiryKind; monthly: boolean }[] {
  const today = istDate(nowMs);
  const monthly = monthlyExpiries(listed, index, calendar);
  const live = [...new Set(listed)].sort().filter((e) => e > today && daysToExpiry(nowMs, e) <= horizonDays);
  const out: { expiry: string; kind: CandidateExpiryKind; monthly: boolean }[] = [];
  if (live[0]) out.push({ expiry: live[0], kind: "nearest", monthly: monthly.has(live[0]) });
  if (live[1]) out.push({ expiry: live[1], kind: "nextWeekly", monthly: monthly.has(live[1]) });
  const m = live.find((e) => monthly.has(e) && !out.some((o) => o.expiry === e));
  if (m) out.push({ expiry: m, kind: "monthly", monthly: true });
  return out;
}

const sorted = (rows: readonly OptionChainRowView[]) => [...rows].sort((a, b) => a.strike - b.strike);

function atmIndex(rows: readonly OptionChainRowView[], chain: OptionChainView): number {
  const exact = rows.findIndex((r) => r.strike === chain.atmStrike);
  if (exact >= 0) return exact;
  if (!pos(chain.spot) || rows.length === 0) return -1;
  let best = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.strike - chain.spot) < Math.abs(rows[best].strike - chain.spot)) best = i;
  });
  return best;
}

function sidePrice(s: OptionSideView | null): { price: number; basis: "ask" | "ltp" } | null {
  if (!s) return null;
  if (pos(s.ask)) return { price: s.ask, basis: "ask" };
  if (pos(s.ltp)) return { price: s.ltp, basis: "ltp" };
  return null;
}

/** ATM−3 … ATM+3, CE and PE, for one expiry's chain; contracts with no ask and no LTP are left out. */
export function chainCandidates(chain: OptionChainView, kind: CandidateExpiryKind, monthly: boolean, nowMs: number, each = CANDIDATE_STRIKES_EACH_SIDE): AdvisorCandidate[] {
  if (chain.error || chain.rows.length === 0 || !pos(chain.lotSize)) return [];
  const rows = sorted(chain.rows);
  const atm = atmIndex(rows, chain);
  if (atm < 0) return [];
  const days = daysToExpiry(nowMs, chain.expiry);
  const out: AdvisorCandidate[] = [];
  for (let k = -each; k <= each; k++) {
    const row = rows[atm + k];
    if (!row) continue;
    for (const optionType of ["CE", "PE"] as const) {
      const side = optionType === "CE" ? row.ce : row.pe;
      const p = sidePrice(side);
      if (!side || !p) continue;
      const c = { index: chain.index, expiry: chain.expiry, strike: row.strike, optionType };
      out.push({
        id: candidateId(chain.index, chain.expiry, row.strike, optionType),
        ...c,
        expiryKind: kind,
        monthly,
        atmOffset: k,
        tradingSymbol: optionTradingSymbol(chain.index, chain.expiry, row.strike, optionType, monthly),
        label: contractLabel(c),
        lotSize: chain.lotSize,
        bid: pos(side.bid) ? side.bid : null,
        ask: pos(side.ask) ? side.ask : null,
        ltp: pos(side.ltp) ? side.ltp : null,
        price: p.price,
        priceBasis: p.basis,
        delta: fin(side.delta) ? side.delta : null,
        iv: pos(side.iv) ? side.iv : null,
        theta: fin(side.theta) ? side.theta : null,
        oi: fin(side.oi) ? side.oi : null,
        oiChange: fin(side.oiChange) ? side.oiChange : null,
        daysToExpiry: days,
        breakevenAtExpiry: r2(optionType === "CE" ? row.strike + p.price : row.strike - p.price),
        costPerLot: r2(p.price * chain.lotSize),
        asOf: chain.fetchedAt,
      });
    }
  }
  return out;
}

/** Today's expiring contracts priced at ₹10 or less, out of the money, the nearest few each side. */
export function zeroHeroCandidates(chain: OptionChainView, maxPrice = ZERO_HERO_MAX_PRICE, perSide = ZERO_HERO_PER_SIDE): ZeroHeroCandidate[] {
  if (chain.error || chain.rows.length === 0 || !pos(chain.spot) || !pos(chain.lotSize)) return [];
  const spot = chain.spot;
  const make = (row: OptionChainRowView, optionType: OptionType): ZeroHeroCandidate | null => {
    const side = optionType === "CE" ? row.ce : row.pe;
    const p = sidePrice(side);
    if (!side || !p || p.price > maxPrice) return null;
    const delta = fin(side.delta) ? side.delta : null;
    const c = { index: chain.index, expiry: chain.expiry, strike: row.strike, optionType };
    return {
      id: candidateId(chain.index, chain.expiry, row.strike, optionType),
      ...c,
      label: contractLabel(c),
      lotSize: chain.lotSize,
      price: p.price,
      priceBasis: p.basis,
      delta,
      costPerLot: r2(p.price * chain.lotSize),
      distancePct: r2((Math.abs(row.strike - spot) / spot) * 100),
      impliedWorthlessPct: delta == null ? null : r1((1 - Math.min(1, Math.abs(delta))) * 100),
    };
  };
  const rows = sorted(chain.rows);
  const calls = rows.filter((r) => r.strike > spot).map((r) => make(r, "CE")).filter((c): c is ZeroHeroCandidate => c != null);
  const puts = rows.filter((r) => r.strike < spot).reverse().map((r) => make(r, "PE")).filter((c): c is ZeroHeroCandidate => c != null);
  return [...calls.slice(0, perSide), ...puts.slice(0, perSide)];
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/** Impact still active on an index (signed), for ranking. */
function newsWeight(e: EventClusterView): number {
  const max = e.impacts.reduce((m, i) => Math.max(m, Math.abs(i.score)), 0);
  return max * (Number.isFinite(e.decayRemaining) ? Math.max(0.1, e.decayRemaining) : 1) * (e.scorer === "pending" ? 0.5 : 1);
}

function newsRow(e: EventClusterView) {
  const impact: Record<string, number> = {};
  for (const i of e.impacts) impact[i.index] = r2(i.score);
  return {
    title: clip(e.title, 160),
    type: e.taxonomy,
    severity: e.severity,
    lastSeen: e.lastSeenAt.slice(0, 16),
    sources: e.sources.slice(0, 2),
    impact,
    pricedIn: e.pricedIn,
    decayLeft: r2(e.decayRemaining),
    summary: clip(e.summary, 200),
    url: e.topUrl,
  };
}

export function topNews(events: readonly EventClusterView[], nowMs: number, n = TOP_NEWS, hours = NEWS_HOURS) {
  const since = nowMs - hours * 3_600_000;
  const recent = events.filter((e) => {
    const t = Date.parse(e.lastSeenAt);
    return !Number.isFinite(t) || t >= since;
  });
  const top = [...recent].sort((a, b) => newsWeight(b) - newsWeight(a)).slice(0, n);
  const fii = recent.filter((e) => e.taxonomy === "FII_FLOWS").sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, FII_NEWS);
  return { top: top.map(newsRow), fiiFlows: fii.map(newsRow), urls: [...top, ...fii].map((e) => e.topUrl).filter((u): u is string => !!u) };
}

// ---------------------------------------------------------------------------
// Signals, flow, outlook (compact)
// ---------------------------------------------------------------------------

function signalSummary(s: SignalView | null) {
  if (!s) return null;
  const reco = s.recommendation ?? null;
  return {
    computedAt: s.computedAt.slice(0, 16),
    stance: s.stance,
    conviction: r2(s.conviction),
    entryThreshold: r2(s.entryThreshold),
    regime: s.regime,
    spot: s.spot,
    expectedMovePct: s.expectedMovePct,
    impliedMovePct: s.impliedMovePct,
    edgeRatio: s.edgeRatio,
    components: s.components.map((c) => ({ source: c.source, value: r2(c.value), weight: r2(c.weight), ...(c.abstain ? { abstain: true } : {}), ...(c.enabled ? {} : { off: true }) })),
    failingGates: s.gates.filter((g) => g.passed === false).slice(0, 3).map((g) => ({ gate: g.label, detail: clip(g.detail, 160) })),
    engineAdvice: s.advice ? { action: "ENTER", contract: s.advice.contract.label, premium: s.advice.premium, stop: s.advice.levels.stop, target: s.advice.levels.target, pausedBy: s.advice.pausedBy } : { action: "WAIT" },
    recommendation10k: reco
      ? {
          status: reco.status,
          grade: reco.grade,
          headline: clip(reco.headline, 200),
          contract: reco.contract?.label ?? null,
          entryLimit: reco.entry?.limit ?? null,
          trigger: reco.entry ? clip(reco.entry.trigger, 120) : null,
          stop: reco.stop?.premium ?? null,
          targets: reco.target ? [reco.target.t1, reco.target.t2] : null,
          timeExit: reco.timeExit,
          reasons: reco.reasons.slice(0, 3).map((t) => clip(t, 160)),
          cautions: reco.cautions.slice(0, 3).map((t) => clip(t, 160)),
          measured: clip(reco.historical.text, 200),
        }
      : null,
    setups: (s.setups ?? []).slice(0, 3).map((t) => ({
      name: t.name,
      side: t.side,
      status: t.status,
      trigger: t.trigger,
      condition: clip(t.condition, 120),
      stop: t.stop,
      t1: t.t1,
      t2: t.t2,
      option: t.option ? { contract: t.option.contract.label, premiumNow: t.option.premiumNow, delta: r2(t.option.delta) } : null,
    })),
    setupNote: s.setupNote ?? null,
    keyLevels: (s.levels ?? []).slice(0, 6).map((l) => ({ price: l.price, label: l.label, strength: l.strength })),
    rationale: clip(s.rationale, 300),
  };
}

function flowSummary(f: OptionFlowView | null) {
  if (!f) return null;
  const s = f.summary;
  return {
    source: f.source,
    asOf: f.asOf?.slice(0, 16) ?? null,
    expiry: f.expiry,
    spot: f.spot,
    atm: f.atm,
    minutes: f.minutes,
    note: f.note,
    pcr: s.pcr,
    pcrChange15m: s.pcrChg15m,
    writers: { window: s.callWritersVsPutWriters.window, callOiAdded: s.callWritersVsPutWriters.ceOiAdded, putOiAdded: s.callWritersVsPutWriters.peOiAdded, lean: s.callWritersVsPutWriters.lean, text: clip(s.callWritersVsPutWriters.text, 200) },
    resistanceWall: s.resistance,
    supportWall: s.support,
    fastestOiAdd: s.fastestOiAdd,
    premiumDryUp: s.premiumDryUp,
    dryUpDetail: clip(s.dryUpDetail, 160),
    atmDecayPctPerHour: s.decayPctPerHourAtm,
    entryWindow: { verdict: f.bestEntryWindow.verdict, text: clip(f.bestEntryWindow.text, 220), now: f.bestEntryWindow.now, best: f.bestEntryWindow.best },
    lastEvents: f.events.slice(0, 10).map((e) => clip(e.text, 160)),
  };
}

function chainOiTotals(chain: OptionChainView | undefined): { ce: number | null; pe: number | null } {
  if (!chain || chain.error || chain.rows.length === 0) return { ce: null, pe: null };
  let ce = 0;
  let pe = 0;
  for (const r of chain.rows) {
    ce += r.ce?.oi ?? 0;
    pe += r.pe?.oi ?? 0;
  }
  return { ce: ce > 0 ? ce : null, pe: pe > 0 ? pe : null };
}

function levelOf(indices: LiveIndexLevelsView | null, key: string) {
  return indices?.levels.find((l) => l.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// The whole context
// ---------------------------------------------------------------------------

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface BuildContextOptions {
  capital?: number;
}

/** The main paper account's limits as read: the only basis for saying the engine hit a cap or was stopped. */
export function limitsOf(state: AdvisorInputs["state"]) {
  if (!state) return null;
  const { dailyLossCap, dailyLossUsed, ordersToday, maxOrdersPerDay } = state.caps;
  return {
    dailyLossCap,
    dailyLossUsed,
    dailyLossLeft: Math.max(0, dailyLossCap - dailyLossUsed),
    dailyLossCapHit: dailyLossCap > 0 && dailyLossUsed >= dailyLossCap,
    ordersToday,
    maxOrdersPerDay,
    killSwitch: state.killSwitch,
    killReason: state.killReason ? clip(state.killReason, 120) : null,
  };
}

export function buildAdvisorContext(inputs: AdvisorInputs, calendar: AdvisorCalendar, opts: BuildContextOptions = {}): AdvisorContext {
  const { nowMs } = inputs;
  const today = istDate(nowMs);
  const closed = istMinutes(nowMs) >= SESSION.close;
  const capital = opts.capital ?? DEFAULT_CAPITAL;
  const phase = calendar.sessionPhase(nowMs);
  const nifty = levelOf(inputs.indices, "NIFTY");
  const sensex = levelOf(inputs.indices, "SENSEX");
  const vix = levelOf(inputs.indices, "INDIAVIX");
  const vixPrice = pos(vix?.price) ? vix.price : null;

  const candidates: AdvisorCandidate[] = [];
  const zeroHero: ZeroHeroCandidate[] = [];
  const expiryToday: Partial<Record<IndexId, string>> = {};
  const impliedRanges: Partial<Record<IndexId, AdvisorImpliedRange[]>> = {};
  const perIndex: Record<string, unknown> = {};
  const gaps = [...inputs.errors];

  for (const index of ADVISOR_INDICES) {
    const input = inputs.perIndex[index];
    if (!input) {
      perIndex[index] = null;
      gaps.push(`${index}: no inputs`);
      continue;
    }
    const chains = new Map(input.chains.map((c) => [c.expiry, c]));
    const level = levelOf(inputs.indices, index);
    const changePct = fin(level?.changePct) ? level.changePct : null;
    const outlook = buildOutlook({
      index,
      nowMs,
      listed: input.listed,
      readings: new Map([...chains].map(([e, chain]) => [e, { chain, error: null }])),
      scheduled: inputs.scheduled,
      calendar,
      horizonDays: OUTLOOK_DAYS,
      error: input.listed.length === 0 ? "No expiry list (the option chain could not be read)." : null,
    });
    impliedRanges[index] = outlook.expiries.flatMap((e) => (e.range ? [{ expiry: e.expiry, days: e.days, low: e.range.low, high: e.range.high }] : []));
    const expiries = outlook.expiries.map((e) => {
      const totals = chainOiTotals(chains.get(e.expiry));
      return {
        expiry: e.expiry,
        monthly: e.monthly,
        days: e.days,
        sessionsLeft: e.sessions,
        straddle: e.straddle?.total ?? null,
        impliedMovePct: e.movePct,
        impliedRange: e.range,
        atmIv: e.atmIv,
        pcr: e.pcr,
        maxPain: e.maxPain,
        putOiWalls: e.support,
        callOiWalls: e.resistance,
        oiChangeSinceYesterday: e.oiChange,
        shortCovering: shortCoveringRead({ indexChangePct: changePct, ceOiChange: e.oiChange.ce, peOiChange: e.oiChange.pe, ceOi: totals.ce, peOi: totals.pe }),
        highImpactEvents: e.events.filter((ev) => ev.impact === "HIGH").map((ev) => clip(ev.title, 80)),
        error: e.error,
      };
    });
    perIndex[index] = {
      level: level ? { price: level.price, changePct: level.changePct, open: level.open, high: level.high, low: level.low, prevClose: level.prevClose } : null,
      signal: signalSummary(input.signal),
      flow: flowSummary(input.flow),
      flowShortCovering: flowShortCoveringRead(input.flow),
      outlook: { headline: outlookHeadline(index, outlook.expiries), note: "Implied range = ATM strike ± the ATM straddle: what option prices imply, not a forecast.", expiries },
      premium: premiumRead(vixPrice, outlook.expiries),
      entryTimes: FLOW_STATS.entryTimes[index] ?? [],
    };
    if (input.signal == null) gaps.push(`${index}: no engine signal`);
    if (input.flow == null) gaps.push(`${index}: no option flow`);

    for (const ce of candidateExpiries(input.listed, nowMs, index, calendar)) {
      const chain = chains.get(ce.expiry);
      if (!chain) {
        gaps.push(`${index} ${ce.expiry}: chain not read`);
        continue;
      }
      candidates.push(...chainCandidates(chain, ce.kind, ce.monthly, nowMs));
    }
    if (!closed && input.listed.includes(today)) {
      expiryToday[index] = today;
      const chain = chains.get(today);
      if (chain) zeroHero.push(...zeroHeroCandidates(chain));
    }
  }

  const news = inputs.events ? topNews(inputs.events, nowMs) : null;
  if (!news) gaps.push("news: could not be read");
  const scheduled = (inputs.scheduled ?? [])
    .filter((e: ScheduledEventView) => e.kind !== "EXPIRY" && Date.parse(e.at) >= nowMs - 2 * 3_600_000 && Date.parse(e.at) <= nowMs + SCHEDULED_DAYS * 86_400_000)
    .slice(0, 40)
    .map((e) => ({ at: e.at.slice(0, 16), title: clip(e.title, 100), kind: e.kind, impact: e.impact, indices: e.indices, ...(e.approx ? { approx: true } : {}) }));
  if (!inputs.scheduled) gaps.push("scheduled events: could not be read");
  const plan = inputs.plan
    ? {
        date: inputs.plan.date,
        when: inputs.plan.when,
        buyingPaused: inputs.plan.buyingPaused,
        pausedReason: inputs.plan.pausedReason ? clip(inputs.plan.pausedReason, 200) : null,
        windows: inputs.plan.windows.map((w) => ({ from: w.from, to: w.to, kind: w.kind, label: w.label })),
        indices: inputs.plan.indices.map((i) => ({
          index: i.index,
          verdict: i.verdict,
          headline: clip(i.headline, 160),
          expectedGapPct: i.expectedGapPct,
          gapPct: i.gapPct,
          checks: i.checks.filter((c) => c.status !== "clear").map((c) => ({ rule: c.rule, status: c.status, detail: clip(c.detail, 160) })),
        })),
      }
    : null;
  const book = {
    today: inputs.pnl ? { realized: inputs.pnl.today.realized, unrealized: inputs.pnl.today.unrealized, net: inputs.pnl.today.net, trades: inputs.pnl.today.trades } : null,
    open: (inputs.positions ?? []).map((p) => ({ contract: p.contract.label, qty: p.qty, avgPrice: p.avgPrice, ltp: p.ltp, pnl: p.pnl, stop: p.stopPrice, target: p.targetPrice })),
    limits: limitsOf(inputs.state ?? null),
  };
  if (!inputs.state) gaps.push("engine limits (loss cap, kill switch): could not be read");

  const p = istParts(nowMs);
  const doc = {
    now: istIso(nowMs),
    weekday: WEEKDAYS[p.weekday] ?? "",
    sessionPhase: phase,
    capitalRupees: capital,
    market: {
      source: inputs.indices?.source ?? null,
      asOf: inputs.indices?.fetchedAt?.slice(0, 19) ?? null,
      error: inputs.indices?.error ?? (inputs.indices ? null : "index levels could not be read"),
      nifty: nifty ? { price: nifty.price, changePct: nifty.changePct } : null,
      sensex: sensex ? { price: sensex.price, changePct: sensex.changePct } : null,
      indiaVix: vix ? { price: vix.price, changePct: vix.changePct } : null,
    },
    indices: perIndex,
    news: news ? { top: news.top, fiiFlowStories: news.fiiFlows } : null,
    scheduledNext30Days: scheduled,
    todayPlan: plan,
    paperEngineBook: book,
    measuredResearch: { flowStudy: FLOW_STATS.honestSummary, mainFindings: RESEARCH_FINDINGS },
    candidates: candidates.map((c) => ({
      id: c.id,
      label: c.label,
      expiryKind: c.expiryKind,
      days: c.daysToExpiry,
      atmOffset: c.atmOffset,
      lotSize: c.lotSize,
      bid: c.bid,
      ask: c.ask,
      ltp: c.ltp,
      ...(c.priceBasis === "ltp" ? { note: "no live ask; last traded price" } : {}),
      delta: c.delta,
      iv: c.iv,
      theta: c.theta,
      oi: c.oi,
      oiChange: c.oiChange,
      breakevenAtExpiry: c.breakevenAtExpiry,
      costPerLot: c.costPerLot,
      fitsCapital: c.costPerLot <= capital,
    })),
    zeroHero: {
      expiryToday,
      candidates: zeroHero.map((z) => ({ id: z.id, label: z.label, price: z.price, delta: z.delta, costPerLot: z.costPerLot, distancePct: z.distancePct, impliedWorthlessPct: z.impliedWorthlessPct })),
      note:
        Object.keys(expiryToday).length === 0
          ? "No index expires today."
          : "Far out-of-the-money options expiring today. |delta| ≈ the market's own odds of finishing in the money; most expire worthless.",
    },
    dataGaps: gaps,
  };

  return {
    promptJson: JSON.stringify(doc),
    candidates,
    impliedRanges,
    zeroHeroCandidates: zeroHero,
    market: { nifty: nifty?.price ?? null, sensex: sensex?.price ?? null, vix: vixPrice, phase },
    expiryToday,
    knownUrls: news?.urls ?? [],
  };
}
