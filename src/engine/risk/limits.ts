/** Engine-wide risk limits and kill triggers. */
import type { EngineConfig } from "../config";
import { MINUTE_MS } from "../clock";
import type { GateResult, IndexId, RiskState, TradeSide } from "../types";

/** Today's loss (realized + unrealized) as a positive number; 0 when in profit. */
export function dailyLoss(r: RiskState): number {
  const net = r.day.realized + r.day.unrealized - r.day.charges;
  return net < 0 ? -net : 0;
}

/** Reasons the engine must stop opening positions and flatten (null = keep trading). */
export function haltReason(r: RiskState, cfg: EngineConfig): { reason: "KILL_SWITCH" | "DAILY_LOSS_CAP"; detail: string } | null {
  if (r.settings.killSwitch) return { reason: "KILL_SWITCH", detail: r.settings.killReason ?? "kill switch engaged" };
  const cap = Math.min(r.settings.dailyLossCapInr, (r.capitalRupees * cfg.risk.dailyLossCapPct) / 100);
  const loss = dailyLoss(r);
  if (loss >= cap) return { reason: "DAILY_LOSS_CAP", detail: `daily loss ₹${loss.toFixed(0)} reached the cap ₹${cap.toFixed(0)}` };
  return null;
}

export function riskGates(index: IndexId, side: TradeSide, r: RiskState, cfg: EngineConfig): GateResult[] {
  const out: GateResult[] = [];
  const halt = haltReason(r, cfg);
  out.push({ gate: "halt", label: "Kill switch and daily loss cap", passed: halt === null, detail: halt?.detail ?? "trading allowed" });
  const weeklyCap = (r.capitalRupees * cfg.risk.weeklyLossCapPct) / 100;
  out.push({
    gate: "weekly_loss",
    label: "Weekly loss cap",
    passed: -r.weekRealized < weeklyCap,
    detail: `week ₹${r.weekRealized.toFixed(0)} vs cap -₹${weeklyCap.toFixed(0)}`,
  });
  out.push({
    gate: "loss_streak",
    label: "Consecutive losses today",
    passed: r.day.consecutiveLosses < cfg.risk.maxConsecutiveLossesPerDay,
    detail: `${r.day.consecutiveLosses} of ${cfg.risk.maxConsecutiveLossesPerDay}`,
  });
  const lastStop = r.lastStopOutMs[index];
  const cooled = lastStop === undefined || r.nowMs - lastStop >= cfg.gates.stopOutCooldownMin * MINUTE_MS;
  out.push({
    gate: "cooldown",
    label: "Cooldown after a stop-out",
    passed: cooled,
    detail: cooled ? "no recent stop-out" : `stopped out ${Math.round((r.nowMs - (lastStop ?? 0)) / MINUTE_MS)} min ago`,
  });
  const openHere = r.openPositions.filter((p) => p.index === index).length;
  out.push({ gate: "per_index", label: "Open positions on this index", passed: openHere < cfg.sizing.maxOpenPerIndex, detail: `${openHere} of ${cfg.sizing.maxOpenPerIndex}` });
  out.push({
    gate: "max_positions",
    label: "Open positions overall",
    passed: r.openPositions.length < r.settings.maxOpenPositions,
    detail: `${r.openPositions.length} of ${r.settings.maxOpenPositions}`,
  });
  const entries = r.entriesToday.NIFTY + r.entriesToday.SENSEX;
  out.push({ gate: "trades_today", label: "Trades today", passed: entries < cfg.sizing.maxTradesPerDay, detail: `${entries} of ${cfg.sizing.maxTradesPerDay}` });
  out.push({
    gate: "orders_today",
    label: "Orders today",
    // Keep two orders in reserve so an entry can always be exited.
    passed: r.ordersToday + 2 <= r.settings.maxOrdersPerDay,
    detail: `${r.ordersToday} of ${r.settings.maxOrdersPerDay}`,
  });
  // NIFTY and SENSEX move together: opposite positions just pay theta twice.
  const opposite = r.openPositions.some((p) => p.index !== index && p.side !== side);
  out.push({ gate: "no_opposite", label: "No opposite position on the other index", passed: !opposite, detail: opposite ? "other index is positioned the other way" : "ok" });
  return out;
}
