/** Slices for the Live P&L page's two donuts: how much capital the open positions use, and where today's P&L comes from. */
import type { PositionView } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { rawUnrealized } from "./liveMarks";

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Categorical slots 1 to 3 of the reference palette. The fallbacks are the dark-mode steps; the light
 * theme (theme.ts) sets the light-mode steps. Both were checked with the palette validator.
 */
export const SERIES_COLORS = ["var(--viz-1, #3987e5)", "var(--viz-2, #d95926)", "var(--viz-3, #199e70)"] as const;
export const NEUTRAL_SLICE = "var(--viz-neutral, #4a4a48)";
export const FREE_SLICE = "var(--viz-free, #2a2a29)";
export const GAIN_COLOR = C.green;
export const LOSS_COLOR = C.red;

/** Premium paid for a position: entry price times quantity (the most it can lose, since options are only bought). */
export const premiumPaid = (p: Pick<PositionView, "avgPrice" | "qty">) => p.avgPrice * p.qty;

export interface CapitalSplit {
  slices: PieSlice[];
  used: number;
  usedPct: number;
}

/** One slice per open position (a fourth and later fold into "Other positions") plus the free capital. */
export function capitalSlices(capital: number, positions: PositionView[]): CapitalSplit {
  const slices: PieSlice[] = [];
  positions.slice(0, SERIES_COLORS.length).forEach((p, i) => {
    slices.push({ key: p.id, label: `${p.contract.strike} ${p.contract.optionType}`, value: premiumPaid(p), color: SERIES_COLORS[i] });
  });
  const rest = positions.slice(SERIES_COLORS.length);
  if (rest.length > 0) slices.push({ key: "other", label: "Other positions", value: rest.reduce((s, p) => s + premiumPaid(p), 0), color: NEUTRAL_SLICE });
  const used = slices.reduce((s, x) => s + x.value, 0);
  slices.push({ key: "free", label: "Free capital", value: Math.max(0, capital - used), color: FREE_SLICE });
  return { slices, used, usedPct: capital > 0 ? (used / capital) * 100 : 0 };
}

export interface PnlSplit {
  slices: PieSlice[];
  gains: number;
  losses: number;
  net: number;
}

/**
 * Gross profit and gross loss across closed trades (the realized total counts as one) and open positions,
 * plus charges. Nothing is netted inside a slice, so every slice is a positive size.
 */
export function pnlSlices(o: { realized: number; positions: PositionView[]; charges: number }): PnlSplit {
  let gains = Math.max(0, o.realized);
  let losses = Math.max(0, -o.realized);
  // The price move, not the P&L after entry charges: charges are their own slice, so nothing is counted twice.
  for (const p of o.positions) {
    const move = rawUnrealized(p);
    gains += Math.max(0, move);
    losses += Math.max(0, -move);
  }
  const slices: PieSlice[] = [
    { key: "gain", label: "Profit (gross)", value: gains, color: GAIN_COLOR },
    { key: "loss", label: "Loss (gross)", value: losses, color: LOSS_COLOR },
    { key: "charges", label: "Charges", value: o.charges, color: NEUTRAL_SLICE },
  ].filter((s) => s.value > 0);
  return { slices, gains, losses, net: gains - losses - o.charges };
}
