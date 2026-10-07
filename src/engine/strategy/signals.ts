/**
 * The six signal components. Each maps features (and event pressure) to a directional view in
 * [-1, 1] with a natural horizon. VOL_REGIME only modifies thresholds and size.
 */
import type { EngineConfig } from "../config";
import type { EventPressure, GlobalKey, MarketFeatures, SignalComponent, SignalSource } from "../types";
import { clamp } from "../util/math";

export type RawComponent = Omit<SignalComponent, "weight" | "enabled">;

/** Standard deviation of an index move over `minutes`, in percent, from an annualized vol in percent. */
export function sigmaPct(annualVolPct: number, minutes: number, cfg: EngineConfig): number {
  return annualVolPct * Math.sqrt(minutes / (cfg.pricing.tradingMinutesPerDay * cfg.pricing.tradingDaysPerYear));
}

/** Annualized vol used to normalize returns: realized when available, floored by a fraction of VIX. */
export function normVol(f: MarketFeatures): number {
  return Math.max(f.realizedVol2h, f.vix * 0.6, 5);
}

export function eventSignal(p: EventPressure | null): RawComponent {
  if (!p || p.activeClusters === 0) return { source: "EVENT", value: 0, horizonMin: 120, notes: "no live events" };
  const top = p.topContributors[0];
  return {
    source: "EVENT",
    value: clamp(p.epi, -1, 1),
    horizonMin: 180,
    notes: top ? `${p.activeClusters} live stories; top: ${top.title.slice(0, 80)}` : `${p.activeClusters} live stories`,
  };
}

export function momentumSignal(f: MarketFeatures, cfg: EngineConfig): RawComponent {
  if (f.minutesSinceOpen < 5) return { source: "MOMENTUM", value: 0, horizonMin: 60, notes: "session just opened" };
  const vol = normVol(f);
  const z15 = f.ret15m / Math.max(1e-6, sigmaPct(vol, 15, cfg));
  const z60 = f.ret60m / Math.max(1e-6, sigmaPct(vol, 60, cfg));
  const trend = 0.4 * Math.tanh(z15 / 2) + 0.6 * Math.tanh(z60 / 2);
  const vwapTerm = clamp(f.barsSameSideOfVwap / 6, -1, 1) * 0.3;
  const orTerm = f.openingRange.state === "BROKE_UP" ? 0.2 : f.openingRange.state === "BROKE_DOWN" ? -0.2 : 0;
  let value = clamp(trend + vwapTerm + orTerm, -1, 1);
  if (f.minutesSinceOpen < 15) value *= 0.5; // the first 15 minutes are noisy
  return { source: "MOMENTUM", value, horizonMin: 60, notes: `z15 ${z15.toFixed(2)}, z60 ${z60.toFixed(2)}, VWAP bars ${f.barsSameSideOfVwap}` };
}

/** Opening-gap behaviour in the first 90 minutes: continuation when price extends the gap, fade when it fills. */
export function gapSignal(f: MarketFeatures): RawComponent {
  const horizonMin = 60;
  if (f.minutesSinceOpen > 90 || Math.abs(f.gapPct) < 0.25) return { source: "GAP", value: 0, horizonMin, notes: "no material gap" };
  const fade = 1 - f.minutesSinceOpen / 90;
  const sameWay = Math.sign(f.retFromOpen) === Math.sign(f.gapPct) && Math.abs(f.retFromOpen) >= 0.1;
  const filling = Math.sign(f.retFromOpen) === -Math.sign(f.gapPct) && Math.abs(f.retFromOpen) >= 0.1;
  let value = 0;
  let notes = `gap ${f.gapPct.toFixed(2)}%, since open ${f.retFromOpen.toFixed(2)}%`;
  if (sameWay) {
    value = Math.sign(f.gapPct) * Math.min(1, Math.abs(f.gapPct) / 0.8) * 0.7;
    notes += " (extending)";
  } else if (filling) {
    value = -Math.sign(f.gapPct) * Math.min(1, Math.abs(f.retFromOpen) / 0.4) * 0.5;
    notes += " (filling)";
  }
  return { source: "GAP", value: clamp(value * fade, -1, 1), horizonMin, notes };
}

/**
 * Cross-asset residual: what overnight and intraday global moves (S&P futures, crude, rupee,
 * yields, Asia) imply India "should" have done since the prior close, minus what it did.
 * A positive residual means India lags good global news: expect catch-up.
 */
export function globalBetaSignal(f: MarketFeatures, cfg: EngineConfig): RawComponent {
  let expected = 0;
  let used = 0;
  for (const [k, beta] of Object.entries(cfg.features.gapBetas)) {
    const mv = f.global[k as GlobalKey];
    if (mv === null || mv === undefined || !Number.isFinite(mv)) continue;
    expected += beta * mv;
    used++;
  }
  if (used < 3) return { source: "GLOBAL_BETA", value: 0, horizonMin: 90, notes: "insufficient global data" };
  const actual = f.gapPct + f.retFromOpen;
  const residual = expected - actual;
  if (Math.abs(residual) < 0.15) return { source: "GLOBAL_BETA", value: 0, horizonMin: 90, notes: `residual ${residual.toFixed(2)}% (small)` };
  return {
    source: "GLOBAL_BETA",
    value: clamp(Math.tanh(residual / 0.5) * 0.8, -1, 1),
    horizonMin: 90,
    notes: `globals imply ${expected.toFixed(2)}%, India ${actual.toFixed(2)}%`,
  };
}

/** Nifty-Sensex spread mean reversion plus Bank Nifty leading Nifty. */
export function relativeValueSignal(f: MarketFeatures): RawComponent {
  const z = f.divergence.vsOtherIndexZ;
  const catchUp = Math.abs(z) >= 2 ? -Math.tanh(z / 3) * 0.6 : 0;
  const bz = f.index === "NIFTY" ? f.divergence.vsBankNiftyZ : 0;
  const bankLead = Math.abs(bz) >= 1.5 ? Math.tanh(bz / 2.5) * 0.5 : 0;
  const value = clamp(catchUp + bankLead, -1, 1);
  return {
    source: "RELATIVE_VALUE",
    value,
    horizonMin: 30,
    notes: `spread z ${z.toFixed(2)}${f.index === "NIFTY" ? `, BankNifty lead z ${bz.toFixed(2)}` : ""}`,
  };
}

/** Options are cheap when realized vol runs above implied: lower the bar and size up, and vice versa. */
export function volRegimeSignal(f: MarketFeatures): RawComponent {
  const r = f.rvIvRatio;
  if (r >= 1.2) return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: -0.05, sizeMult: 1.25 }, notes: `RV/IV ${r.toFixed(2)}: options cheap` };
  if (r > 0 && r <= 0.7) return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: 0.1, sizeMult: 0.5 }, notes: `RV/IV ${r.toFixed(2)}: options rich` };
  return { source: "VOL_REGIME", value: 0, horizonMin: 60, modifiers: { thresholdDelta: 0, sizeMult: 1 }, notes: `RV/IV ${r.toFixed(2)}` };
}

export function rawComponents(f: MarketFeatures, p: EventPressure | null, cfg: EngineConfig, opts: { noEvents?: boolean } = {}): RawComponent[] {
  return [
    opts.noEvents ? { source: "EVENT" as SignalSource, value: 0, horizonMin: 120, notes: "event layer disabled" } : eventSignal(p),
    momentumSignal(f, cfg),
    gapSignal(f),
    relativeValueSignal(f),
    globalBetaSignal(f, cfg),
    volRegimeSignal(f),
  ];
}
