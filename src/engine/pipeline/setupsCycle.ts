/**
 * The trade-setup board for one index on one engine tick (main account only): read the chart
 * (strategy/setups.ts), quote the option for at most two setups, and store `setups:latest:<index>`
 * in kv when anything material changed or at least every minute. Never trades, never throws into
 * the tick: the caller wraps it.
 */
import type { TradingCalendar } from "../calendar/calendar";
import { istDate } from "../clock";
import { chooseExpiry } from "../strategy/optionSelect";
import { bsGreeks, bsPrice } from "../pricing/blackScholes";
import { syntheticVol } from "../pricing/syntheticOptionPricer";
import { yearsToExpiry } from "../pricing/timeToExpiry";
import type { EngineDeps } from "../ports";
import {
  buildSetupContext,
  evaluateSetups,
  minutesUntil,
  nearestZones,
  optionPlan,
  setupStrike,
  setupsChanged,
  setupsKey,
  type SetupsRecord,
} from "../strategy/setups";
import type { IndexId, MarketFeatures, MarketSnapshot, Regime } from "../types";
import { MARKET_SYMBOLS } from "../types";
import type { TradeSetupView } from "../api-types";

const MAX_QUOTES_PER_INDEX = 2;

/** Today's-plan style warnings from the features: a scheduled event close by, or a VIX jump. */
export function setupCautions(f: MarketFeatures, vixDayJumpPct: number): string[] {
  const out: string[] = [];
  const e = f.nextScheduledEvent;
  if (e && (e.impact === "HIGH" || e.impact === "MED") && e.minutesAway <= 60) out.push(`${e.name} in ${Math.round(e.minutesAway)} min: the Desk's plan holds off entries around it.`);
  const r = f.recentScheduledEvent;
  if (r && (r.impact === "HIGH" || r.impact === "MED") && r.minutesAgo <= 30) out.push(`${r.name} ${Math.round(r.minutesAgo)} min ago: let the first reaction settle.`);
  if (Number.isFinite(f.vixChangePct) && f.vixChangePct > vixDayJumpPct) out.push(`India VIX up ${f.vixChangePct.toFixed(1)}% today (above +${vixDayJumpPct}%): the Desk's plan would wait.`);
  return out;
}

export async function refreshSetups(
  deps: EngineDeps,
  index: IndexId,
  f: MarketFeatures,
  snap: MarketSnapshot,
  regime: Regime,
  calendar: TradingCalendar,
): Promise<SetupsRecord | null> {
  const { repo, cfg } = deps;
  const now = deps.clock.now();
  if (!(f.spot > 0)) return null;
  const ctx = buildSetupContext({
    index,
    t: now,
    spot: f.spot,
    atrPct5m: f.atrPct5m,
    ind: f.indicators,
    or: f.openingRange,
    regime,
    candles: snap.candles[MARKET_SYMBOLS[index]] ?? [],
    isExpiryDay: f.isExpiryDay,
    cautions: setupCautions(f, cfg.rules.n2.vixDayJumpPct),
  });
  const key = setupsKey(index);
  const prev = await repo.state.get<SetupsRecord>(key);
  const { setups, note } = evaluateSetups(ctx, prev);

  let quoted = 0;
  const priced: TradeSetupView[] = [];
  for (const s of setups) {
    const live = s.status === "WATCHING" || s.status === "READY" || s.status === "TRIGGERED";
    if (!live || quoted >= MAX_QUOTES_PER_INDEX) {
      priced.push(s);
      continue;
    }
    quoted += 1;
    priced.push({ ...s, option: await priceSetup(deps, s, f, calendar, now).catch(() => s.option) });
  }
  const record: SetupsRecord = { t: now, index, session: istDate(now), spot: f.spot, setups: priced, levels: nearestZones(ctx.zones, f.spot), note };
  if (setupsChanged(prev, record)) await repo.state.set(key, record);
  return record;
}

async function priceSetup(deps: EngineDeps, s: TradeSetupView, f: MarketFeatures, calendar: TradingCalendar, now: number): Promise<TradeSetupView["option"]> {
  const { cfg } = deps;
  const spec = cfg.indexSpecs[s.index];
  const expiry = await chooseExpiry(s.index, now, deps.instruments, calendar);
  const type = s.side === "BULL" ? "CE" : "PE";
  let strike = setupStrike(f.spot, spec.strikeStep, s.side, s.score);
  const listed = await deps.instruments.strikes(s.index, expiry);
  if (listed.length > 0 && !listed.includes(strike)) strike = listed.reduce((b, x) => (Math.abs(x - strike) < Math.abs(b - strike) ? x : b), listed[0]);
  const contract = await deps.instruments.resolve(s.index, expiry, strike, type);
  if (!contract) return null;
  const tYears = yearsToExpiry(now, expiry, calendar, cfg);
  const quote = await deps.optionQuotes.quote(contract, { t: now, spot: f.spot, vix: f.vix }).catch(() => null);
  const modelVol = syntheticVol(s.index, f.vix, cfg, { tYears, spot: f.spot, strike });
  const vol = quote?.iv && quote.iv > 0 ? quote.iv / 100 : modelVol;
  if (!(vol > 0)) return null;
  const base = { strike, tYears, vol, r: cfg.pricing.r, type } as const;
  const hasAsk = quote !== null && quote.ask > 0;
  const premiumNow = hasAsk ? quote.ask : bsPrice({ ...base, spot: f.spot });
  if (!(premiumNow > 0)) return null;
  const g = bsGreeks({ ...base, spot: s.trigger });
  return optionPlan({
    contract,
    premiumNow,
    priceSource: hasAsk && quote.source !== "synthetic" ? "broker" : "model",
    iv: Math.round(vol * 1000) / 10,
    spot: f.spot,
    greeks: { delta: g.delta, gamma: g.gamma, thetaPerMin: g.thetaPerDay / cfg.pricing.tradingMinutesPerDay },
    trigger: s.trigger,
    stop: s.stop,
    t1: s.t1,
    t2: s.t2,
    maxStopPct: cfg.exits.stopPct,
    minutesLeft: minutesUntil(now, cfg.exits.squareOffIst),
  });
}
