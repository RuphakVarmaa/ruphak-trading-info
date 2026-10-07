/** Indian index-option charges from the dated schedule in config. */
import { CHARGE_SCHEDULES, type ChargeSchedule } from "../config";
import type { ChargeBreakdown, Exchange, Side } from "../types";

export function scheduleFor(date: string, schedules: readonly ChargeSchedule[] = CHARGE_SCHEDULES): ChargeSchedule {
  let chosen = schedules[0];
  for (const s of schedules) if (s.effectiveFrom <= date && s.effectiveFrom >= chosen.effectiveFrom) chosen = s;
  return chosen;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Charges for one executed order (one fill aggregate) of `qty` units at `price` premium. */
export function computeCharges(side: Side, price: number, qty: number, exchange: Exchange, date: string, schedules?: readonly ChargeSchedule[]): ChargeBreakdown {
  const s = scheduleFor(date, schedules);
  const turnover = price * qty;
  if (turnover <= 0) return { brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, total: 0 };
  const brokerage = s.brokeragePerOrder;
  const stt = side === "SELL" ? (turnover * s.sttSellPct) / 100 : 0;
  const exchangeTxn = (turnover * s.exchangeTxnPct[exchange]) / 100;
  const sebi = (turnover * s.sebiPct) / 100;
  const stampDuty = side === "BUY" ? (turnover * s.stampBuyPct) / 100 : 0;
  const ipft = (turnover * s.ipftPct) / 100;
  const gst = ((brokerage + exchangeTxn + sebi + ipft) * s.gstPct) / 100;
  const total = brokerage + stt + exchangeTxn + sebi + stampDuty + ipft + gst;
  return { brokerage: r2(brokerage), stt: r2(stt), exchangeTxn: r2(exchangeTxn), sebi: r2(sebi), stampDuty: r2(stampDuty), ipft: r2(ipft), gst: r2(gst), total: r2(total) };
}

/** Estimated round-trip charges per unit (buy then sell at the same price), for planning gates. */
export function roundTripChargesPerUnit(price: number, qty: number, exchange: Exchange, date: string): number {
  if (qty <= 0) return 0;
  return (computeCharges("BUY", price, qty, exchange, date).total + computeCharges("SELL", price, qty, exchange, date).total) / qty;
}

export function addCharges(a: ChargeBreakdown, b: ChargeBreakdown): ChargeBreakdown {
  return {
    brokerage: r2(a.brokerage + b.brokerage),
    stt: r2(a.stt + b.stt),
    exchangeTxn: r2(a.exchangeTxn + b.exchangeTxn),
    sebi: r2(a.sebi + b.sebi),
    stampDuty: r2(a.stampDuty + b.stampDuty),
    ipft: r2(a.ipft + b.ipft),
    gst: r2(a.gst + b.gst),
    total: r2(a.total + b.total),
  };
}

export const ZERO_CHARGES: ChargeBreakdown = { brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, total: 0 };
