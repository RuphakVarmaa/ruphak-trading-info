/**
 * Validation of the model's brief (pure, unit-tested): every idea is mapped to a real listed contract from the
 * candidate list and re-priced against its live ask (the pipeline re-reads those chains after the model
 * answers); ideas that name an unknown contract, a buy zone far from the ask, or a stop/target the engine
 * cannot accept are dropped. Small problems are fixed, and each fix is kept on the idea (engineNotes) with the
 * model's original value. Today's BUY only stands when its idea survived. Outlook ranges are checked against
 * the index level and the option-implied range. The cost of the brief comes from token usage.
 */
import type { AdvisorConfidence, AdvisorFactor, AdvisorFactorKey, AdvisorHorizon, AdvisorIdea, AdvisorOutlook, AdvisorReport, AdvisorReportSummary, IndexId } from "../api-types";
import { computeCharges } from "../broker/charges";
import { istAt, istDate, istIso } from "../clock";
import type { AdviceOut } from "./advise";
import { DEFAULT_CAPITAL, candidateId } from "./context";
import { HONESTY_LINE } from "./knowledge";
import type { ResearchResult } from "./research";
import type { AdvisorCandidate, AdvisorContext, AdvisorUsage } from "./types";

/** The model's buy zone may sit at most this far from the live ask (fraction). */
export const MAX_ZONE_GAP = 0.15;
/** The kept zone is clamped to ask × [0.85, 1.05]: no chasing more than 5% above the ask. */
export const ZONE_FLOOR = 0.85;
export const ZONE_CAP = 1.05;
/** Stop between 10% and 60% below the entry. */
export const MIN_STOP_PCT = 0.1;
export const MAX_STOP_PCT = 0.6;
/** Target at least 1.2 × the risk above the entry. */
export const MIN_REWARD_RISK = 1.2;
/** Target at most this many times the entry: the premium may at most double (TODAY), triple (WEEK) or quadruple (MONTH). */
export const MAX_TARGET_MULT: Record<AdvisorHorizon, number> = { TODAY: 2, WEEK: 3, MONTH: 4 };
/** An outlook range end may sit at most this far from the index level (fraction of it), per horizon. */
export const MAX_RANGE_FRAC: Record<AdvisorHorizon, number> = { TODAY: 0.03, WEEK: 0.08, MONTH: 0.15 };
/** Outlook ranges are clamped to the matching expiry's option-implied range, widened this much about its middle. */
export const IMPLIED_RANGE_WIDEN = 1.5;
/** Extra lots only while the total maximum loss stays within this share of the capital. */
export const MAX_RISK_SHARE = 0.3;
export const MAX_IDEAS = 6;

/** Claude Opus 5.5 list prices, USD per million tokens, and per web search. */
export const PRICE_USD = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, perWebSearch: 0.01 } as const;

const tick = (n: number) => Math.round(n * 20) / 20;
/** A model's number as quoted back in a note (2 decimals at most). */
const q = (n: number) => String(Math.round(n * 100) / 100);
const r2 = (n: number) => Math.round(n * 100) / 100;
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const text = (s: unknown, n = 600) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
const texts = (a: unknown, max = 10, n = 400) => (Array.isArray(a) ? a.map((s) => text(s, n)).filter(Boolean).slice(0, max) : []);
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function costUsd(u: AdvisorUsage): number {
  const usd =
    (u.inputTokens * PRICE_USD.inputPerM + u.outputTokens * PRICE_USD.outputPerM + u.cacheReadTokens * PRICE_USD.cacheReadPerM + u.cacheCreationTokens * PRICE_USD.cacheWritePerM) / 1e6 +
    u.webSearches * PRICE_USD.perWebSearch;
  return Math.round(usd * 10_000) / 10_000;
}

const EXCHANGE: Record<IndexId, "NSE" | "BSE"> = { NIFTY: "NSE", SENSEX: "BSE" };

/** Approximate round-trip charges for one lot: buy at `entry`, sell at `exit`. */
export function roundTripCharges(c: Pick<AdvisorCandidate, "index" | "lotSize">, entry: number, exit: number, date: string): number {
  const ex = EXCHANGE[c.index];
  return r2(computeCharges("BUY", entry, c.lotSize, ex, date).total + computeCharges("SELL", Math.max(exit, 0.05), c.lotSize, ex, date).total);
}

/** "2026-10-20T15:00" (or with a space, seconds or an offset) read as IST; null when it is not a date-time. */
export function parseIstDateTime(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return null;
  const ms = istAt(m[1], h * 60 + min);
  return Number.isFinite(ms) ? ms : null;
}

const EXIT_LATEST_MIN = 15 * 60 + 15;
const EXIT_EARLIEST_MIN = 9 * 60 + 20;

/** The exit time: the model's when it is a date-time between now and the expiry, inside 09:20–15:15; else a default. */
export function exitByFor(raw: string, horizon: AdvisorHorizon, expiry: string, nowMs: number): string {
  const latest = istAt(expiry, EXIT_LATEST_MIN);
  const today = istDate(nowMs);
  let ms = parseIstDateTime(raw);
  if (ms != null) {
    const date = istDate(ms);
    const minutes = Math.round((ms - istAt(date, 0)) / 60_000);
    if (minutes > EXIT_LATEST_MIN) ms = istAt(date, EXIT_LATEST_MIN);
    if (minutes < EXIT_EARLIEST_MIN) ms = istAt(date, EXIT_EARLIEST_MIN);
  }
  if (ms == null || ms <= nowMs) ms = horizon === "TODAY" && istAt(today, EXIT_LATEST_MIN) > nowMs ? istAt(today, EXIT_LATEST_MIN) : latest;
  return istIso(Math.min(ms, latest));
}

export type IdeaCheck = { ok: true; idea: AdvisorIdea; notes: string[] } | { ok: false; reason: string };

export interface IdeaInput {
  candidateId: string;
  horizon: AdvisorHorizon;
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
  exitBy: string;
  why: string[];
  wrongIf: string;
  confidence: AdvisorConfidence;
}

/**
 * |delta| at `strike` for one expiry and option type, interpolated between the listed strikes on either side
 * (the market's rough odds that the index ends beyond that strike); null outside the strikes with a delta.
 */
export function deltaAtStrike(peers: readonly AdvisorCandidate[], c: Pick<AdvisorCandidate, "index" | "expiry" | "optionType">, strike: number): number | null {
  const pts = peers
    .filter((p) => p.index === c.index && p.expiry === c.expiry && p.optionType === c.optionType && fin(p.delta))
    .map((p) => ({ k: p.strike, d: Math.min(1, Math.abs(p.delta as number)) }))
    .sort((a, b) => a.k - b.k);
  const exact = pts.find((p) => p.k === strike);
  if (exact) return exact.d;
  const below = pts.filter((p) => p.k < strike).at(-1);
  const above = pts.find((p) => p.k > strike);
  if (!below || !above) return null;
  return below.d + ((above.d - below.d) * (strike - below.k)) / (above.k - below.k);
}

export interface ValidateIdeaOptions {
  id: string;
  nowMs: number;
  capital?: number;
  /** The candidates (same expiry ones are used) for the odds at the break-even. */
  peers?: readonly AdvisorCandidate[];
}

/** Validates and re-prices one idea against its candidate contract. */
export function validateIdea(raw: IdeaInput, c: AdvisorCandidate | undefined, opts: ValidateIdeaOptions): IdeaCheck {
  if (!c) return { ok: false, reason: `unknown contract id "${text(raw.candidateId, 60)}"` };
  const ask = c.price;
  if (!(ask > 0)) return { ok: false, reason: `${c.label}: no live price` };
  if (![raw.entryLow, raw.entryHigh, raw.stop, raw.target].every(fin)) return { ok: false, reason: `${c.label}: missing prices` };
  const notes: string[] = [];
  let lo = Math.min(raw.entryLow, raw.entryHigh);
  let hi = Math.max(raw.entryLow, raw.entryHigh);
  const gap = ask < lo ? (lo - ask) / ask : ask > hi ? (ask - hi) / ask : 0;
  if (gap > MAX_ZONE_GAP) return { ok: false, reason: `${c.label}: buy zone ₹${lo}–${hi} is ${Math.round(gap * 100)}% away from the live price ₹${ask}` };
  lo = tick(Math.min(Math.max(lo, ask * ZONE_FLOOR), ask * ZONE_CAP));
  hi = tick(Math.max(Math.min(hi, ask * ZONE_CAP), lo));
  if (lo !== tick(Math.min(raw.entryLow, raw.entryHigh)) || hi !== tick(Math.max(raw.entryLow, raw.entryHigh)))
    notes.push(`buy zone clamped to ₹${lo}–${hi} (was ₹${q(Math.min(raw.entryLow, raw.entryHigh))}–${q(Math.max(raw.entryLow, raw.entryHigh))}) around the live price ₹${ask}`);
  // The price a buyer pays now, inside the zone.
  const entry = tick(Math.min(Math.max(ask, lo), hi));
  if (!(raw.stop > 0) || raw.stop >= ask) return { ok: false, reason: `${c.label}: stop ₹${raw.stop} is not below the live price ₹${ask}` };
  if (raw.target <= ask) return { ok: false, reason: `${c.label}: target ₹${raw.target} is not above the live price ₹${ask}` };
  let stop = tick(raw.stop);
  const tightest = tick(entry * (1 - MIN_STOP_PCT));
  const widest = tick(entry * (1 - MAX_STOP_PCT));
  if (stop > tightest) {
    stop = tightest;
    notes.push(`stop widened to ₹${stop} (was ₹${q(raw.stop)}; at least 10% below the entry ₹${entry})`);
  } else if (stop < widest) {
    stop = widest;
    notes.push(`stop raised to ₹${stop} (was ₹${q(raw.stop)}; at most 60% below the entry ₹${entry})`);
  }
  let target = tick(raw.target);
  const minTarget = tick(entry + MIN_REWARD_RISK * (entry - stop));
  if (target < minTarget) {
    target = minTarget;
    notes.push(`target raised to ₹${target} (was ₹${q(raw.target)}; at least 1.2× the risk)`);
  }
  const mult = MAX_TARGET_MULT[raw.horizon] ?? MAX_TARGET_MULT.TODAY;
  const maxTarget = tick(entry * mult);
  if (maxTarget < minTarget) return { ok: false, reason: `${c.label}: no target fits between 1.2× the risk (₹${minTarget}) and ${mult}× the entry (₹${maxTarget})` };
  if (target > maxTarget) {
    target = maxTarget;
    notes.push(`target lowered to ₹${target} (was ₹${q(raw.target)}; at most ${mult}× the entry for a ${raw.horizon} idea)`);
  }
  if (!(stop < ask && ask < target)) return { ok: false, reason: `${c.label}: stop ₹${stop} / target ₹${target} do not bracket the live price ₹${ask}` };

  const capital = opts.capital ?? DEFAULT_CAPITAL;
  const date = istDate(opts.nowMs);
  const costPerLot = r2(entry * c.lotSize);
  if (costPerLot > capital) return { ok: false, reason: `${c.label}: one lot costs ${rupees(costPerLot)}, more than the ${rupees(capital)} capital` };
  const maxLossPerLot = r2((entry - stop) * c.lotSize + roundTripCharges(c, entry, stop, date));
  const rewardPerLot = r2((target - entry) * c.lotSize - roundTripCharges(c, entry, target, date));
  const fit = Math.max(1, Math.floor(capital / costPerLot));
  const byRisk = maxLossPerLot > 0 ? Math.max(1, Math.floor((capital * MAX_RISK_SHARE) / maxLossPerLot)) : fit;
  const lots = Math.min(fit, byRisk);
  if (c.priceBasis === "ltp") notes.push(`no live ask was quoted (market closed): checked against the last traded price ₹${ask}`);
  const breakeven = r2(c.optionType === "CE" ? c.strike + entry : c.strike - entry);
  const beyond = deltaAtStrike(opts.peers ?? [c], c, breakeven);

  const idea: AdvisorIdea = {
    id: opts.id,
    horizon: raw.horizon,
    contract: { index: c.index, expiry: c.expiry, strike: c.strike, optionType: c.optionType, tradingSymbol: c.tradingSymbol, lotSize: c.lotSize, label: c.label },
    entry: { low: lo, high: hi, ask, asOf: c.asOf },
    stop,
    target,
    exitBy: exitByFor(text(raw.exitBy, 40), raw.horizon, c.expiry, opts.nowMs),
    lots,
    costPerLot,
    maxLossPerLot,
    rewardPerLot,
    breakevenAtExpiry: breakeven,
    delta: c.delta,
    iv: c.iv,
    // |delta|: the chance it ends in the money, not in profit (that needs the index past the break-even).
    probItm: c.delta == null ? null : r2(Math.min(1, Math.abs(c.delta))),
    why: texts(raw.why, 6),
    wrongIf: text(raw.wrongIf, 300) || "The index moves against the idea and the stop is hit.",
    confidence: raw.confidence,
    probAboveBreakeven: beyond == null ? null : r2(beyond),
    engineNotes: [...notes],
  };
  return { ok: true, idea, notes };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export const FACTOR_ORDER: readonly AdvisorFactorKey[] = ["FII_DII", "NEWS_UNCERTAINTY", "GLOBAL_CUES", "SHORT_COVERING", "OPTIONS_POSITIONING", "VOLATILITY_PREMIUM", "TREND", "EVENTS", "OTHER"];
const FACTOR_LABELS: Record<AdvisorFactorKey, string> = {
  FII_DII: "Foreign and domestic funds (FII/DII)",
  NEWS_UNCERTAINTY: "News and uncertainty",
  GLOBAL_CUES: "Global markets",
  SHORT_COVERING: "Short covering",
  OPTIONS_POSITIONING: "Options positioning (OI, PCR, max pain)",
  VOLATILITY_PREMIUM: "Option premiums and volatility",
  TREND: "Trend and setups",
  EVENTS: "Scheduled events",
  OTHER: "Other",
};
const HORIZONS: readonly AdvisorHorizon[] = ["TODAY", "WEEK", "MONTH"];
const READINGS = new Set(["SUPPORTS_UP", "SUPPORTS_DOWN", "NEUTRAL", "RISK", "NO_DATA"]);

function factorsOf(advice: AdviceOut, research: ResearchResult): AdvisorFactor[] {
  const byKey = new Map<AdvisorFactorKey, AdvisorFactor>();
  for (const f of advice.factors ?? []) {
    if (!FACTOR_ORDER.includes(f.key) || byKey.has(f.key)) continue;
    byKey.set(f.key, {
      key: f.key,
      label: text(f.label, 80) || FACTOR_LABELS[f.key],
      reading: READINGS.has(f.reading) ? f.reading : "NO_DATA",
      detail: text(f.detail, 500) || "No data.",
      source: text(f.source, 120) || "—",
    });
  }
  if (!research.ok) {
    // The engine has no feed for these: without the research, any figures would come from the model's memory.
    byKey.set("FII_DII", {
      key: "FII_DII",
      label: FACTOR_LABELS.FII_DII,
      reading: "NO_DATA",
      detail: `No data: ${research.error ?? "the web research did not run"} FII/DII figures could not be checked this time.`,
      source: "web research (failed)",
    });
    byKey.set("GLOBAL_CUES", {
      key: "GLOBAL_CUES",
      label: FACTOR_LABELS.GLOBAL_CUES,
      reading: "NO_DATA",
      detail: "No data: global markets could not be checked this time (the web research did not run).",
      source: "web research (failed)",
    });
  }
  for (const key of FACTOR_ORDER.slice(0, 8)) {
    if (!byKey.has(key)) byKey.set(key, { key, label: FACTOR_LABELS[key], reading: "NO_DATA", detail: "No data: not assessed in this brief.", source: "—" });
  }
  return FACTOR_ORDER.map((k) => byKey.get(k)).filter((f): f is AdvisorFactor => f != null);
}

/** Calendar days a horizon looks ahead, to pick the expiry whose implied range bounds it. */
const HORIZON_DAYS: Record<AdvisorHorizon, number> = { TODAY: 0, WEEK: 7, MONTH: 30 };

/** The option-implied range of the first expiry at or past the horizon (else the farthest), widened 1.5× about its middle. */
function impliedBand(ctx: AdvisorContext, index: IndexId, horizon: AdvisorHorizon): { low: number; high: number; expiry: string } | null {
  const list = (ctx.impliedRanges?.[index] ?? []).filter((r) => fin(r.low) && fin(r.high) && r.high > r.low).sort((a, b) => a.days - b.days);
  const r = list.find((x) => x.days >= HORIZON_DAYS[horizon]) ?? list.at(-1);
  if (!r) return null;
  const mid = (r.low + r.high) / 2;
  const half = ((r.high - r.low) / 2) * IMPLIED_RANGE_WIDEN;
  return { low: mid - half, high: mid + half, expiry: r.expiry };
}

const spotOf = (ctx: AdvisorContext, index: IndexId) => (index === "NIFTY" ? ctx.market.nifty : ctx.market.sensex);

/** The model's range, checked: dropped without an index level or when an end is far from it, else clamped to the implied band. */
function checkedRange(o: { index: IndexId; horizon: AdvisorHorizon }, lo: number | null, hi: number | null, ctx: AdvisorContext, notes: string[]): [number | null, number | null] {
  if (lo == null && hi == null) return [null, null];
  const what = `outlook ${o.index} ${o.horizon}: range ${lo ?? "?"}–${hi ?? "?"}`;
  const spot = spotOf(ctx, o.index);
  if (!fin(spot) || spot <= 0) {
    notes.push(`${what} dropped (no index level to check it against)`);
    return [null, null];
  }
  const maxGap = MAX_RANGE_FRAC[o.horizon] * spot;
  if ([lo, hi].some((v) => v != null && Math.abs(v - spot) > maxGap)) {
    notes.push(`${what} dropped (an end is more than ${Math.round(MAX_RANGE_FRAC[o.horizon] * 100)}% from the index at ${spot})`);
    return [null, null];
  }
  const band = impliedBand(ctx, o.index, o.horizon);
  if (!band) return [lo, hi];
  const clamp = (v: number | null) => (v == null ? null : v < band.low ? Math.round(band.low) : v > band.high ? Math.round(band.high) : v);
  const [nlo, nhi] = [clamp(lo), clamp(hi)];
  if (nlo != null && nhi != null && nlo >= nhi) {
    notes.push(`${what} dropped (outside the ${band.expiry} option-implied range, widened ${IMPLIED_RANGE_WIDEN}×)`);
    return [null, null];
  }
  if (nlo !== lo || nhi !== hi) notes.push(`${what} clamped to ${nlo ?? "?"}–${nhi ?? "?"} (the ${band.expiry} option-implied range, widened ${IMPLIED_RANGE_WIDEN}×)`);
  return [nlo, nhi];
}

function outlookOf(advice: AdviceOut, ctx: AdvisorContext, notes: string[]): AdvisorOutlook[] {
  const seen = new Set<string>();
  const out: AdvisorOutlook[] = [];
  for (const o of advice.outlook ?? []) {
    if ((o.index !== "NIFTY" && o.index !== "SENSEX") || !HORIZONS.includes(o.horizon)) continue;
    const key = `${o.index}|${o.horizon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let lo = fin(o.rangeLow) && o.rangeLow > 0 ? o.rangeLow : null;
    let hi = fin(o.rangeHigh) && o.rangeHigh > 0 ? o.rangeHigh : null;
    if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
    [lo, hi] = checkedRange(o, lo, hi, ctx, notes);
    out.push({ index: o.index, horizon: o.horizon, lean: o.lean, confidence: o.confidence, rangeLow: lo, rangeHigh: hi, why: texts(o.why, 6) });
  }
  const rank = (o: AdvisorOutlook) => (o.index === "NIFTY" ? 0 : 3) + HORIZONS.indexOf(o.horizon);
  return out.sort((a, b) => rank(a) - rank(b));
}

function sourcesOf(advice: AdviceOut, research: ResearchResult, ctx: AdvisorContext): { title: string; url: string }[] {
  const known = new Set([...research.sources.map((s) => s.url), ...ctx.knownUrls]);
  const out = new Map<string, { title: string; url: string }>();
  for (const s of advice.sources ?? []) {
    const url = text(s.url, 500);
    if (!/^https?:\/\//i.test(url) || !known.has(url) || out.has(url)) continue;
    out.set(url, { title: text(s.title, 200) || url, url });
  }
  for (const s of research.sources) if (!out.has(s.url)) out.set(s.url, s);
  return [...out.values()].slice(0, 30);
}

function zeroHeroOf(advice: AdviceOut, ctx: AdvisorContext): AdvisorReport["zeroHero"] {
  const expiry = ctx.expiryToday.NIFTY ?? ctx.expiryToday.SENSEX ?? null;
  if (!expiry) return { applicable: false, expiry: null, summary: "No expiry today." };
  // The range across every listed ticket, not the most favourable one.
  const priced = ctx.zeroHeroCandidates.filter((z) => z.delta != null && z.impliedWorthlessPct != null);
  const span = (xs: number[], f: (n: number) => string) => {
    const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
    return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
  };
  const odds =
    priced.length > 0
      ? ` Market odds: the ${priced.length} far out-of-the-money contract${priced.length === 1 ? "" : "s"} listed at ₹10 or less (${span(
          priced.map((z) => z.costPerLot),
          rupees,
        )} a lot, |delta| ${span(
          priced.map((z) => Math.abs(z.delta as number)),
          (n) => n.toFixed(2),
        )}) expire worthless roughly ${span(
          priced.map((z) => z.impliedWorthlessPct as number),
          String,
        )}% of the time by the market's own pricing. On real prices, even NIFTY weeklies just 2 strikes out of the money expired worthless 62% of the time when held to expiry (research §10); these are further out.`
      : ctx.zeroHeroCandidates.length > 0
        ? " The far out-of-the-money contracts at ₹10 or less had no delta, so the market's own odds are not known; most such options expire worthless."
        : " No far out-of-the-money contract at ₹10 or less had a usable price.";
  const summary = text(advice.zeroHero?.summary, 800) || "Expiry-day lottery tickets: most expire worthless.";
  return { applicable: true, expiry, summary: `${summary}${odds}` };
}

export interface BuildReportInput {
  id: string;
  nowMs: number;
  model: string;
  durationMs: number;
  usage: AdvisorUsage;
  advice: AdviceOut;
  context: AdvisorContext;
  research: ResearchResult;
  capital?: number;
}

export interface BuildReportResult {
  report: AdvisorReport;
  /** Ideas dropped and fixes made, in plain words (for the log). */
  notes: string[];
}

export function buildReport(i: BuildReportInput): BuildReportResult {
  const { advice, context } = i;
  const byId = new Map(context.candidates.map((c) => [c.id, c]));
  const notes: string[] = [];
  const ideas: AdvisorIdea[] = [];
  const seen = new Set<string>();
  for (const raw of advice.ideas ?? []) {
    if (ideas.length >= MAX_IDEAS) break;
    const key = `${raw.candidateId}|${raw.horizon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const check = validateIdea(raw, byId.get(raw.candidateId), { id: `${i.id}-${ideas.length + 1}`, nowMs: i.nowMs, capital: i.capital, peers: context.candidates });
    if (!check.ok) {
      notes.push(`dropped: ${check.reason}`);
      continue;
    }
    ideas.push(check.idea);
    for (const n of check.notes) notes.push(`${check.idea.contract.label}: ${n}`);
  }

  let action = advice.today?.action ?? "WAIT";
  let summary = text(advice.today?.summary, 1200) || "No summary.";
  let headline = text(advice.headline, 300) || "No headline.";
  let ideaId: string | null = null;
  if (action === "BUY") {
    const wanted = advice.today?.candidateId ?? null;
    const of = (x: AdvisorIdea) => candidateId(x.contract.index, x.contract.expiry, x.contract.strike, x.contract.optionType);
    const match = wanted ? (ideas.find((x) => of(x) === wanted && x.horizon === "TODAY") ?? ideas.find((x) => of(x) === wanted)) : undefined;
    if (match) ideaId = match.id;
    else {
      action = "WAIT";
      summary = `${summary} (Changed to WAIT: ${wanted ? "the suggested contract did not pass the engine's live-price checks" : "no contract was named"}.)`;
      // The model's headline recommends the rejected trade; the answer-first line must match the WAIT.
      headline = wanted
        ? "WAIT: the suggested trade did not pass the engine's live-price checks, so there is no trade today."
        : "WAIT: the brief named no contract to buy, so there is no trade today.";
      notes.push(`today: BUY changed to WAIT (${wanted ? `idea ${wanted} not valid` : "no idea named"})`);
    }
  }

  const report: AdvisorReport = {
    id: i.id,
    createdAt: istIso(i.nowMs),
    model: i.model,
    durationMs: Math.max(0, Math.round(i.durationMs)),
    costUsd: costUsd(i.usage),
    market: context.market,
    headline,
    today: { action, summary, ideaId },
    outlook: outlookOf(advice, context, notes),
    factors: factorsOf(advice, i.research),
    ideas,
    zeroHero: zeroHeroOf(advice, context),
    premium: { verdict: advice.premium?.verdict ?? "NO_DATA", detail: text(advice.premium?.detail, 600) || "No data." },
    alsoKnow: texts(advice.alsoKnow, 10),
    avoid: texts(advice.avoid, 10),
    sources: sourcesOf(advice, i.research, context),
    honesty: HONESTY_LINE,
  };
  return { report, notes };
}

export function summarize(r: AdvisorReport): AdvisorReportSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    headline: r.headline,
    todayAction: r.today.action,
    ideas: r.ideas.map((x) => ({ id: x.id, label: x.contract.label, horizon: x.horizon, entryAsk: x.entry.ask, stop: x.stop, target: x.target })),
  };
}
