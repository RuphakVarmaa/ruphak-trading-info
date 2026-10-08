/** Position sizing: premium at risk from a risk budget, fractional Kelly once a source has history. */
import type { EngineConfig } from "../config";
import type { EngineSettings, OptionContract, SignalPerformance } from "../types";
import { clamp } from "../util/math";

export interface SizingInput {
  premium: number;
  contract: OptionContract;
  perf: SignalPerformance | undefined;
  sizeMult: number;
  capitalRupees: number;
  /** Premium already deployed in open positions, rupees. */
  openPremiumRupees: number;
  settings: EngineSettings;
  /** Free cash for new premium (small accounts); no cash cap when undefined. */
  cashRupees?: number;
  /** Round-trip charges reserved per lot from the free cash. */
  chargeReservePerLot?: number;
}

export interface SizingResult {
  lots: number;
  qty: number;
  riskRupees: number;
  riskPct: number;
  kellyFraction: number;
  /** Why the size is what it is (binding cap). */
  limitedBy: string;
}

/** Full Kelly fraction for a binary-ish payoff: f* = p − (1 − p) / b. */
export function kellyFraction(hitRate: number, avgWinPct: number, avgLossPct: number): number {
  const b = Math.abs(avgLossPct) > 1e-9 ? avgWinPct / Math.abs(avgLossPct) : 0;
  if (!(b > 0)) return 0;
  return hitRate - (1 - hitRate) / b;
}

export function sizePosition(i: SizingInput, cfg: EngineConfig): SizingResult {
  const s = cfg.sizing;
  let riskPct = s.defaultRiskPct;
  let kelly = 0;
  if (i.perf && i.perf.windowTrades >= s.kellyMinTrades) {
    kelly = kellyFraction(i.perf.hitRate, i.perf.avgWinPct, i.perf.avgLossPct);
    if (kelly <= 0) return { lots: 0, qty: 0, riskRupees: 0, riskPct: 0, kellyFraction: kelly, limitedBy: "negative Kelly edge" };
    riskPct = clamp(s.kellyFraction * kelly * 100, s.minRiskPct, s.maxRiskPctPerTrade);
  }
  const riskRupees = (i.capitalRupees * riskPct * i.sizeMult) / 100;
  const unit = i.premium * i.contract.lotSize;
  const perLotRisk = (Math.abs(cfg.exits.stopPct) / 100) * unit;
  if (!(unit > 0) || !(perLotRisk > 0)) return { lots: 0, qty: 0, riskRupees: 0, riskPct, kellyFraction: kelly, limitedBy: "no premium" };

  const caps: [string, number][] = [
    ["risk budget", Math.floor(riskRupees / perLotRisk)],
    ["max premium per trade (config)", Math.floor((i.capitalRupees * s.maxPremiumPctPerTrade) / 100 / unit)],
    ["max premium per trade (settings)", Math.floor(i.settings.maxPremiumPerTradeInr / unit)],
    ["combined premium cap", Math.floor(((i.capitalRupees * s.maxCombinedPremiumPct) / 100 - i.openPremiumRupees) / unit)],
    ["max lots (config)", s.maxLots],
    ["max lots per order (settings)", i.settings.maxLotsPerOrder],
  ];
  if (i.contract.freezeQty && i.contract.freezeQty > 0) caps.push(["exchange freeze quantity", Math.floor(i.contract.freezeQty / i.contract.lotSize)]);
  if (i.cashRupees !== undefined) caps.push(["cash available", Math.floor(Math.max(0, i.cashRupees) / (unit + Math.max(0, i.chargeReservePerLot ?? 0)))]);
  let lots = Infinity;
  let limitedBy = "";
  for (const [name, n] of caps) {
    if (n < lots) {
      lots = n;
      limitedBy = name;
    }
  }
  lots = Math.max(0, lots);
  // Small accounts: when the budget rounds down to zero lots, still allow one lot if it costs at most
  // 1.5x the budget and stays within the hard per-trade risk cap (and no other cap forbids it).
  if (lots === 0 && limitedBy === "risk budget") {
    const hardCap = (i.capitalRupees * s.maxRiskPctPerTrade) / 100;
    const otherCapsAllowOne = caps.filter(([name]) => name !== "risk budget").every(([, n]) => n >= 1);
    if (perLotRisk <= riskRupees * 1.5 && perLotRisk <= hardCap && otherCapsAllowOne) {
      lots = 1;
      limitedBy = "minimum one lot (within 1.5x budget and hard cap)";
    }
  }
  return { lots, qty: lots * i.contract.lotSize, riskRupees: lots * perLotRisk, riskPct, kellyFraction: kelly, limitedBy };
}
