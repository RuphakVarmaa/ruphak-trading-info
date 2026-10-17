/** Pure helpers for the /options chain (no React), unit-tested in chainView.test.ts. */
import { REFRESH_CLOSED_MS, REFRESH_OTHER_MS } from "@/lib/refresh";
import type { IndexId, OptionChainRowView, SignalAdviceView, SignalView } from "@/engine/api-types";
import { istParts, SESSION } from "@/lib/ist";

export type Side = "CE" | "PE";
export type Flash = "up" | "down";

/** A call is in the money below the spot, a put above it. At the spot exactly, neither. */
export function isItm(strike: number, spot: number, type: Side): boolean {
  return type === "CE" ? strike < spot : strike > spot;
}

/**
 * Where the spot line goes among strikes sorted ascending: the index of the first strike above the spot
 * (the line is drawn just before that row). 0 puts it above every row, rows.length below them all.
 */
export function spotLineIndex(strikes: number[], spot: number): number {
  const i = strikes.findIndex((s) => s > spot);
  return i === -1 ? strikes.length : i;
}

/** Index of the strike nearest the spot (or of `atm` when it is listed). */
export function atmIndex(strikes: number[], spot: number, atm?: number): number {
  if (atm != null) {
    const i = strikes.indexOf(atm);
    if (i >= 0) return i;
  }
  let best = -1;
  let bestD = Infinity;
  strikes.forEach((s, i) => {
    const d = Math.abs(s - spot);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The rows to draw: ±`around` strikes about the ATM strike, or all of them. */
export function visibleRows(rows: OptionChainRowView[], spot: number, atm: number, showAll: boolean, around = 10): OptionChainRowView[] {
  if (showAll || rows.length <= around * 2 + 1) return rows;
  const i = atmIndex(
    rows.map((r) => r.strike),
    spot,
    atm,
  );
  if (i < 0) return rows;
  return rows.slice(Math.max(0, i - around), i + around + 1);
}

export const flashKey = (strike: number, type: Side) => `${strike}:${type}`;

/** LTPs that moved between two polls of the same chain: up or down per strike side. */
export function diffFlashes(prev: OptionChainRowView[] | null, next: OptionChainRowView[]): Map<string, Flash> {
  const out = new Map<string, Flash>();
  if (!prev) return out;
  const before = new Map<string, number>();
  for (const r of prev) {
    if (r.ce?.ltp != null) before.set(flashKey(r.strike, "CE"), r.ce.ltp);
    if (r.pe?.ltp != null) before.set(flashKey(r.strike, "PE"), r.pe.ltp);
  }
  for (const r of next) {
    for (const type of ["CE", "PE"] as const) {
      const ltp = (type === "CE" ? r.ce : r.pe)?.ltp;
      const key = flashKey(r.strike, type);
      const was = before.get(key);
      if (ltp == null || was == null || ltp === was) continue;
      out.set(key, ltp > was ? "up" : "down");
    }
  }
  return out;
}

/** NSE/BSE cash session: Mon–Fri 09:15–15:30 IST (holidays aside). */
export function isMarketHours(nowMs: number): boolean {
  const p = istParts(nowMs);
  return p.weekday <= 5 && p.minutesOfDay >= SESSION.open && p.minutesOfDay < SESSION.close;
}

/** Poll every 2 s in market hours, every 10 minutes otherwise. */
export const chainPollMs = (nowMs: number) => (isMarketHours(nowMs) ? REFRESH_OTHER_MS : REFRESH_CLOSED_MS);

/** The /options address for an index and chain expiry, as the page keeps it in the address bar: "/options?index=SENSEX&expiry=2026-10-29#chain". */
export function optionsHref(index: IndexId, expiry: string | null, hash?: string): string {
  const q = new URLSearchParams({ index });
  if (expiry) q.set("expiry", expiry);
  return `/options?${q.toString()}${hash ? `#${hash.replace(/^#/, "")}` : ""}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-19" -> "19-Oct". */
export function shortExpiry(expiry: string): string {
  const [, m, d] = expiry.split("-");
  return `${Number(d)}-${MON[Number(m) - 1] ?? m}`;
}

/** Indian-style compact figures for OI and volume: 1.24Cr, 12.4L, 8.2k. */
export function fmtLakh(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}k`;
  return `${sign}${Math.round(a)}`;
}

export interface EngineTieIn {
  /** The engine says ENTER on this index. */
  advice: SignalAdviceView | null;
  /** The contract is on the chain's expiry (so it can be highlighted). */
  onThisExpiry: boolean;
  /** When there is no advice: the signal's first failing reason, if any. */
  reason: string | null;
}

/** The engine's live reading for one index, as the chain shows it. */
export function engineTieIn(signals: SignalView[] | null, index: IndexId, expiry: string): EngineTieIn {
  const s = signals?.find((x) => x.index === index) ?? null;
  const advice = s?.advice?.kind === "ENTER" && s.advice.contract.index === index ? s.advice : null;
  if (advice) return { advice, onThisExpiry: advice.contract.expiry === expiry, reason: null };
  const failing = s?.gates.find((g) => g.passed === false);
  return { advice: null, onThisExpiry: false, reason: s?.noPlanReason ?? failing?.label ?? null };
}

/** "Engine's live reading says buy NIFTY 22500 CE 19-Oct, limit ≤ ₹63.00 — paper engine paused, no measured edge". */
export function adviceLine(a: SignalAdviceView): string {
  const c = a.contract;
  return `Engine's live reading says buy ${c.index} ${c.strike} ${c.optionType} ${shortExpiry(c.expiry)}, limit ≤ ₹${a.premium.toFixed(2)} — paper engine paused, no measured edge`;
}

/** Breakeven at expiry for a buyer: strike + premium for a call, strike − premium for a put. */
export function breakeven(strike: number, ltp: number, type: Side): number {
  return Math.round((type === "CE" ? strike + ltp : strike - ltp) * 100) / 100;
}
