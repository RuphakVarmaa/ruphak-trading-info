/**
 * Validation of the model's brief (pure, unit-tested): every idea is mapped to a real listed contract from the
 * candidate list and re-priced against its live ask; ideas that name an unknown contract, a buy zone far from
 * the ask, or a stop/target the engine cannot accept are dropped (small problems are fixed and noted). Today's
 * BUY only stands when its idea survived. The cost of the brief comes from token usage.
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
/** Extra lots only while the total maximum loss stays within this share of the capital. */
export const MAX_RISK_SHARE = 0.3;
export const MAX_IDEAS = 6;

/** Claude Opus 5.5 list prices, USD per million tokens, and per web search. */
export const PRICE_USD = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, perWebSearch: 0.01 } as const;

const tick = (n: number) => Math.round(n * 20) / 20;
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

/** Validates and re-prices one idea against its candidate contract. */
export function validateIdea(raw: IdeaInput, c: AdvisorCandidate | undefined, opts: { id: string; nowMs: number; capital?: number }): IdeaCheck {
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
  if (lo !== tick(Math.min(raw.entryLow, raw.entryHigh)) || hi !== tick(Math.max(raw.entryLow, raw.entryHigh))) notes.push(`buy zone clamped to ₹${lo}–${hi} around the live price ₹${ask}`);
  // The price a buyer pays now, inside the zone.
  const entry = tick(Math.min(Math.max(ask, lo), hi));
  if (!(raw.stop > 0) || raw.stop >= ask) return { ok: false, reason: `${c.label}: stop ₹${raw.stop} is not below the live price ₹${ask}` };
  if (raw.target <= ask) return { ok: false, reason: `${c.label}: target ₹${raw.target} is not above the live price ₹${ask}` };
  let stop = tick(raw.stop);
  const tightest = tick(entry * (1 - MIN_STOP_PCT));
  const widest = tick(entry * (1 - MAX_STOP_PCT));
  if (stop > tightest) {
    stop = tightest;
    notes.push(`stop widened to ₹${stop} (at least 10% below the entry)`);
  } else if (stop < widest) {
    stop = widest;
    notes.push(`stop raised to ₹${stop} (at most 60% below the entry)`);
  }
  let target = tick(raw.target);
  const minTarget = tick(entry + MIN_REWARD_RISK * (entry - stop));
  if (target < minTarget) {
    target = minTarget;
    notes.push(`target raised to ₹${target} (at least 1.2× the risk)`);
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
  if (c.priceBasis === "ltp") notes.push("no live ask was quoted (market closed): checked against the last traded price");

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
    breakevenAtExpiry: r2(c.optionType === "CE" ? c.strike + entry : c.strike - entry),
    delta: c.delta,
    iv: c.iv,
    probItm: c.delta == null ? null : r2(Math.min(1, Math.abs(c.delta))),
    why: texts(raw.why, 6),
    wrongIf: text(raw.wrongIf, 300) || "The index moves against the idea and the stop is hit.",
    confidence: raw.confidence,
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
    byKey.set("FII_DII", {
      key: "FII_DII",
      label: FACTOR_LABELS.FII_DII,
      reading: "NO_DATA",
      detail: `No data: ${research.error ?? "the web research did not run"} FII/DII figures could not be checked this time.`,
      source: "web research (failed)",
    });
  }
  for (const key of FACTOR_ORDER.slice(0, 8)) {
    if (!byKey.has(key)) byKey.set(key, { key, label: FACTOR_LABELS[key], reading: "NO_DATA", detail: "No data: not assessed in this brief.", source: "—" });
  }
  return FACTOR_ORDER.map((k) => byKey.get(k)).filter((f): f is AdvisorFactor => f != null);
}

function outlookOf(advice: AdviceOut): AdvisorOutlook[] {
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
  const best = [...ctx.zeroHeroCandidates].filter((z) => z.delta != null).sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number))[0];
  const odds = best
    ? ` Market odds: ${best.label} at ₹${best.price} (${rupees(best.costPerLot)} a lot) has delta ${Math.abs(best.delta as number).toFixed(2)}, so options like it expire worthless roughly ${best.impliedWorthlessPct}% of the time by the market's own pricing.`
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
    const check = validateIdea(raw, byId.get(raw.candidateId), { id: `${i.id}-${ideas.length + 1}`, nowMs: i.nowMs, capital: i.capital });
    if (!check.ok) {
      notes.push(`dropped: ${check.reason}`);
      continue;
    }
    ideas.push(check.idea);
    for (const n of check.notes) notes.push(`${check.idea.contract.label}: ${n}`);
  }

  let action = advice.today?.action ?? "WAIT";
  let summary = text(advice.today?.summary, 1200) || "No summary.";
  let ideaId: string | null = null;
  if (action === "BUY") {
    const wanted = advice.today?.candidateId ?? null;
    const of = (x: AdvisorIdea) => candidateId(x.contract.index, x.contract.expiry, x.contract.strike, x.contract.optionType);
    const match = wanted ? (ideas.find((x) => of(x) === wanted && x.horizon === "TODAY") ?? ideas.find((x) => of(x) === wanted)) : undefined;
    if (match) ideaId = match.id;
    else {
      action = "WAIT";
      summary = `${summary} (Changed to WAIT: ${wanted ? "the suggested contract did not pass the engine's live-price checks" : "no contract was named"}.)`;
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
    headline: text(advice.headline, 300) || "No headline.",
    today: { action, summary, ideaId },
    outlook: outlookOf(advice),
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
