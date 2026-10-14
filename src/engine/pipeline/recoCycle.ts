/**
 * The recommendation for one index on one engine tick (main account only, after the setups): gather the
 * live setups, the live option flow (deps.flow), the plan's no-trade rules and quotes for a few strikes of
 * the expiry a ₹10,000 buyer may use, then store recommend()'s result in kv `reco:latest:<index>`.
 *
 * At most once a minute per index unless the setups' statuses or the plan's verdict change. Quotes: up to six
 * strikes around ATM on the trade's side, from the engine's option quotes (batched, cached a few seconds),
 * else the flow's latest minute sample when it monitors that expiry, else a model price flagged as such.
 * Decision support only: never places an order, never touches a gate, stop or cap, and never throws into the
 * tick (the caller wraps it).
 */
import type { OptionFlowView, RecommendationView } from "../api-types";
import type { TradingCalendar } from "../calendar/calendar";
import { daysBetween, istDate } from "../clock";
import { FLOW_STATS, type FlowStatsFile } from "../flow/flowStats";
import { FLOW_MAX_AGE_MS, MIN_DAYS_LEFT, RECO_CAPITAL, pickSetup, recoKey, recommend, type RecoCandidate } from "../flow/recommend";
import { bsGreeks, bsPrice } from "../pricing/blackScholes";
import { syntheticVol } from "../pricing/syntheticOptionPricer";
import { yearsToExpiry } from "../pricing/timeToExpiry";
import type { EngineDeps, InstrumentProvider } from "../ports";
import { n2DailyByIndex } from "../strategy/rules";
import { SETUPS_MAX_AGE_MS, type SetupsRecord } from "../strategy/setups";
import { buildTodayPlan } from "../strategy/todayPlan";
import type { IndexId, MarketFeatures, MarketSnapshot, OptionType } from "../types";

export interface RecoRecord {
  t: number;
  session: string;
  index: IndexId;
  /** What forces a recompute inside the minute: the setups' ids and statuses and the plan's verdict. */
  sig: string;
  view: RecommendationView;
}

/** Recomputed at least this often per index. */
export const RECO_REFRESH_MS = 55_000;
/** Strikes quoted: from this many in the money to this many out of the money. */
export const RECO_ITM_STEPS = 2;
export const RECO_OTM_STEPS = 3;

/** The nearest listed expiry with at least MIN_DAYS_LEFT calendar days left (never today's); null when none. */
export async function recoExpiry(index: IndexId, now: number, instruments: InstrumentProvider, calendar: TradingCalendar): Promise<string | null> {
  const today = istDate(now);
  const enough = (e: string) => e > today && daysBetween(today, e) >= MIN_DAYS_LEFT;
  const listed = (await instruments.expiries(index)).filter((e) => e > today).sort();
  if (listed.length > 0) return listed.find(enough) ?? null;
  let e = calendar.nextExpiry(index, now);
  for (let i = 0; i < 4 && !enough(e); i++) e = calendar.followingExpiry(index, e);
  return enough(e) ? e : null;
}

/** Strikes from RECO_ITM_STEPS in the money to RECO_OTM_STEPS out of the money, snapped to listed strikes. */
export function recoStrikes(spot: number, step: number, type: OptionType, listed: readonly number[]): number[] {
  const atm = Math.round(spot / step) * step;
  const dir = type === "CE" ? 1 : -1;
  const raw: number[] = [];
  for (let k = -RECO_ITM_STEPS; k <= RECO_OTM_STEPS; k++) raw.push(atm + dir * k * step);
  if (listed.length === 0) return raw;
  const snap = (s: number) => listed.reduce((b, x) => (Math.abs(x - s) < Math.abs(b - s) ? x : b), listed[0]);
  return [...new Set(raw.map(snap))];
}

function flowQuote(flow: OptionFlowView | null, expiry: string, strike: number, type: OptionType, now: number) {
  if (!flow || flow.source !== "feed" || flow.expiry !== expiry || !flow.asOf || now - Date.parse(flow.asOf) > FLOW_MAX_AGE_MS) return null;
  const row = flow.windows["1m"].rows.find((r) => r.strike === strike);
  const q = type === "CE" ? row?.ce : row?.pe;
  return q && q.ask !== null && q.ask > 0 ? q : null;
}

/** Quotes and greeks for the candidate strikes (see the header). */
export async function recoCandidates(
  deps: EngineDeps,
  index: IndexId,
  type: OptionType,
  expiry: string,
  f: Pick<MarketFeatures, "spot" | "vix">,
  flow: OptionFlowView | null,
  calendar: TradingCalendar,
): Promise<RecoCandidate[]> {
  const { cfg } = deps;
  const now = deps.clock.now();
  const listed = await deps.instruments.strikes(index, expiry);
  const strikes = recoStrikes(f.spot, cfg.indexSpecs[index].strikeStep, type, listed);
  const tYears = yearsToExpiry(now, expiry, calendar, cfg);
  const out = await Promise.all(
    strikes.map(async (strike): Promise<RecoCandidate | null> => {
      const contract = await deps.instruments.resolve(index, expiry, strike, type);
      if (!contract) return null;
      // The freshest real ask first (the engine's quote source, cached ≤ 5 s), then the feed's minute sample, else a model price.
      const q = await deps.optionQuotes.quote(contract, { t: now, spot: f.spot, vix: f.vix }).catch(() => null);
      const broker = q !== null && q.ask > 0 && q.source !== "synthetic" ? q : null;
      const fq = flowQuote(flow, expiry, strike, type, now);
      const ivPct = (broker?.iv && broker.iv > 0 ? broker.iv : null) ?? fq?.iv ?? null;
      const vol = ivPct !== null && ivPct > 0 ? ivPct / 100 : syntheticVol(index, f.vix, cfg, { tYears, spot: f.spot, strike });
      if (!(vol > 0)) return null;
      const g = bsGreeks({ spot: f.spot, strike, tYears, vol, r: cfg.pricing.r, type });
      const premium = broker ? broker.ask : fq ? fq.ask! : bsPrice({ spot: f.spot, strike, tYears, vol, r: cfg.pricing.r, type });
      if (!(premium > 0)) return null;
      return {
        contract: { index, expiry, strike, optionType: type, tradingSymbol: contract.tradingSymbol, lotSize: contract.lotSize, tickSize: contract.tickSize || 0.05, exchange: contract.exchange },
        bid: broker ? broker.bid : fq ? fq.bid : null,
        ask: broker ? broker.ask : fq ? fq.ask : null,
        ltp: broker ? broker.ltp : fq ? fq.ltp : null,
        premium: Math.round(premium * 100) / 100,
        delta: fq?.delta ?? g.delta,
        gamma: g.gamma,
        thetaPerMin: g.thetaPerDay / cfg.pricing.tradingMinutesPerDay,
        iv: ivPct !== null ? Math.round(ivPct * 10) / 10 : Math.round(vol * 1000) / 10,
        priceSource: broker ? "broker" : fq ? "feed" : "model",
      };
    }),
  );
  return out.filter((c): c is RecoCandidate => c !== null);
}

/**
 * Plan rule N1 inside the session: no new entry from max(30, preEventBlackoutMin) minutes before a HIGH or
 * MED scheduled event until max(30, postEventWaitMin) minutes after it (the windows the Desk's plan prints).
 */
export function eventBlackout(
  f: Pick<MarketFeatures, "nextScheduledEvent" | "recentScheduledEvent">,
  g: { preEventBlackoutMin: number; postEventWaitMin: number },
): string | null {
  const pre = Math.max(30, g.preEventBlackoutMin);
  const post = Math.max(30, g.postEventWaitMin);
  const big = (impact: string) => impact === "HIGH" || impact === "MED";
  const n = f.nextScheduledEvent;
  if (n && big(n.impact) && n.minutesAway <= pre) return `${n.name} is in ${Math.round(n.minutesAway)} min: no new entry from ${pre} min before it (plan rule N1)`;
  const r = f.recentScheduledEvent;
  if (r && big(r.impact) && r.minutesAgo <= post) return `${r.name} was ${Math.round(r.minutesAgo)} min ago: no new entry until ${post} min after it (plan rule N1)`;
  return null;
}

export interface RecoOptions {
  capital?: number;
  stats?: FlowStatsFile;
}

export async function refreshRecommendation(
  deps: EngineDeps,
  index: IndexId,
  f: MarketFeatures,
  snap: MarketSnapshot,
  setupsRecord: SetupsRecord | null,
  calendar: TradingCalendar,
  o: RecoOptions = {},
): Promise<RecoRecord | null> {
  const { repo, cfg } = deps;
  const now = deps.clock.now();
  if (!(f.spot > 0)) return null;
  const session = istDate(now);
  const setups = setupsRecord && setupsRecord.session === session && now - setupsRecord.t <= SETUPS_MAX_AGE_MS ? setupsRecord.setups : [];
  const plan =
    buildTodayPlan({ nowMs: now, calendar, cfg, snapshot: { t: now, features: { [index]: f }, daily: n2DailyByIndex(snap, [index], now, cfg) } }).indices.find((p) => p.index === index) ?? null;
  const sig = `${setups.map((s) => `${s.id}:${s.status}`).join(",")}|${plan?.verdict ?? "?"}`;
  const key = recoKey(index);
  const prev = await repo.state.get<RecoRecord>(key);
  if (prev && prev.session === session && now - prev.t < RECO_REFRESH_MS && prev.sig === sig) return prev;

  const flow = deps.flow ? await deps.flow.view(index).catch(() => null) : null;
  const setup = pickSetup(setups);
  const phaseOpen = calendar.sessionPhase(now) === "OPEN";
  let candidates: RecoCandidate[] = [];
  if (setup && phaseOpen) {
    const expiry = await recoExpiry(index, now, deps.instruments, calendar);
    if (expiry) candidates = await recoCandidates(deps, index, setup.side === "BULL" ? "CE" : "PE", expiry, f, flow, calendar);
  }
  const view = recommend({
    index,
    now,
    capital: o.capital ?? RECO_CAPITAL,
    spot: f.spot,
    setups,
    flow,
    stats: o.stats ?? FLOW_STATS,
    candidates,
    phaseOpen,
    isExpiryDay: calendar.isExpiryDay(index, session),
    plan,
    eventBlackout: eventBlackout(f, cfg.gates),
    exits: { stopPct: cfg.exits.stopPct, targetPct: cfg.exits.targetPct, squareOffIst: cfg.exits.squareOffIst },
  });
  const record: RecoRecord = { t: now, session, index, sig, view };
  await repo.state.set(key, record);
  return record;
}
