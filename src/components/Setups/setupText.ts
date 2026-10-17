/** Pure text and layout helpers for the trade-setup board (no React, so they are unit-tested). */
import type { TradeSetupView } from "@/engine/api-types";

const inr0 = (x: number) => Math.round(x).toLocaleString("en-IN");

/** "20-Oct" from "2026-10-20". */
export function shortExpiry(expiry: string): string {
  const [, m, d] = expiry.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] ?? "";
  return `${String(d).padStart(2, "0")}-${mon}`;
}

/** "BUY NIFTY 22500 CE 20-Oct · 1 lot = 65 qty · enter when a 5-min candle closes above 22,540 (now 22,512)". */
export function tradeLine(s: TradeSetupView): string {
  const o = s.option;
  const what = o
    ? `BUY ${s.index} ${o.contract.strike} ${o.contract.optionType} ${shortExpiry(o.contract.expiry)} · 1 lot = ${o.contract.lotSize} qty`
    : `BUY ${s.index} ${s.side === "BULL" ? "CE" : "PE"} (contract not priced yet)`;
  return `${what} · enter when ${s.condition} (now ${inr0(s.spot)})`;
}

/** The clipboard text: the trade line, then the levels. */
export function setupCopyText(s: TradeSetupView): string {
  const o = s.option;
  const lines = [tradeLine(s), `Stop ${inr0(s.stop)} · T1 ${inr0(s.t1)} · T2 ${inr0(s.t2)} (index)`];
  if (o) lines.push(`Premium: entry ≈ ${o.entry.toFixed(2)} · stop ${o.stop.toFixed(2)} (${o.stopPct}%) · T1 ${o.t1.toFixed(2)} · T2 ${o.t2.toFixed(2)}`);
  lines.push(`Invalid if ${s.invalidation}`);
  return lines.join("\n");
}

/**
 * How close the price is to the trigger, 0 (twice the WATCHING band away, or more) to 1 (at or past
 * it). The band is max(0.5 ATR, 0.12%), as the engine uses for WATCHING.
 */
export function triggerProximity(s: Pick<TradeSetupView, "distance" | "atr" | "spot">): number {
  const band = Math.max(0.5 * s.atr, s.spot * 0.0012);
  if (!(band > 0)) return 0;
  if (s.distance <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - s.distance / (2 * band)));
}

/** The alert key for a status change worth a chime (READY, TRIGGERED), else null. */
export function alertKey(s: Pick<TradeSetupView, "id" | "status">): string | null {
  return s.status === "READY" || s.status === "TRIGGERED" ? `${s.id}|${s.status}` : null;
}
