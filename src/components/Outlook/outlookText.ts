/** Pure helpers for the outlook panel (no React), unit-tested in outlookText.test.ts. */
import type { OutlookEvent, OutlookExpiry, Straddle } from "@/lib/options/outlook";
import { MAX_MID_SPREAD_PCT, ONE_SIGMA_FACTOR } from "@/lib/options/outlook";
import { REFRESH_CLOSED_MS } from "@/lib/refresh";
import { isMarketHours } from "@/components/Options/chainView";

/** While expiries are still being read the panel asks again soon; then once a minute in market hours, every 10 minutes otherwise. */
export const OUTLOOK_FILL_MS = 5_000;
export const OUTLOOK_OPEN_MS = 60_000;

export function outlookPollMs(pending: number | null, engineNowMs: number | null): number {
  if (pending != null && pending > 0) return OUTLOOK_FILL_MS;
  if (engineNowMs == null) return OUTLOOK_OPEN_MS;
  return isMarketHours(engineNowMs) ? OUTLOOK_OPEN_MS : REFRESH_CLOSED_MS;
}

/**
 * Each row's events that no earlier row lists: the rows are cumulative (everything before 19 Oct is also
 * before 27 Oct), so each row shows only what is new since the previous expiry.
 */
export function newEventsPerRow(rows: readonly Pick<OutlookExpiry, "events">[]): OutlookEvent[][] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const fresh = r.events.filter((e) => !seen.has(e.id));
    for (const e of r.events) seen.add(e.id);
    return fresh;
  });
}

/** One scale for every row's break-even range and the spot, padded 4% each side; null with nothing to draw. */
export function rangeScale(rows: readonly Pick<OutlookExpiry, "range">[], spot: number | null): { min: number; max: number } | null {
  const xs: number[] = [];
  for (const r of rows) if (r.range) xs.push(r.range.low, r.range.high);
  if (xs.length === 0) return null;
  if (spot != null && spot > 0) xs.push(spot);
  let min = Math.min(...xs);
  let max = Math.max(...xs);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.04;
  return { min: min - pad, max: max + pad };
}

/** A value's position on the scale, in percent of the width (clamped to 0–100). */
export function scalePct(x: number, scale: { min: number; max: number }): number {
  return Math.min(100, Math.max(0, ((x - scale.min) / (scale.max - scale.min)) * 100));
}

const MINUS = "−";

/** Signed Indian-style OI figure: +21.3L, −4.1k, 0. */
export function fmtOiChange(n: number): string {
  const a = Math.abs(n);
  const body = a >= 1e7 ? `${(a / 1e7).toFixed(2)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(1)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${Math.round(a)}`;
  if (body === "0") return "0";
  return `${n < 0 ? MINUS : "+"}${body}`;
}

/** "Calls +21.3L · Puts −4.1L" (net OI change since yesterday's close), or null when neither side reported it. */
export function oiChangeLine(c: OutlookExpiry["oiChange"]): string | null {
  if (c.ce == null && c.pe == null) return null;
  const part = (label: string, n: number | null) => `${label} ${n == null ? "no data" : fmtOiChange(n)}`;
  return `${part("Calls", c.ce)} · ${part("Puts", c.pe)}`;
}

/** How the straddle was priced, for its tooltip. */
export function basisWords(basis: Straddle["basis"]): string {
  if (basis === "mid") return `bid/ask mids (spreads within ${MAX_MID_SPREAD_PCT}%)`;
  if (basis === "ltp") return "last traded prices (no tight bid/ask quote)";
  return "a bid/ask mid on one side and the last trade on the other";
}

/** The priced move's tooltip: the arithmetic, and the model 1σ figure clearly marked as a model's. */
export function moveTooltip(r: Pick<OutlookExpiry, "straddle" | "atmStrike" | "movePct" | "oneSigmaPct">): string | undefined {
  if (!r.straddle || r.atmStrike == null || r.movePct == null) return undefined;
  const s = r.straddle;
  const lines = [
    `${r.atmStrike} call ₹${s.ce.toFixed(2)} + put ₹${s.pe.toFixed(2)} = ₹${s.total.toFixed(2)}, from ${basisWords(s.basis)}.`,
    `₹${s.total.toFixed(2)} is ${r.movePct.toFixed(2)}% of the spot.`,
  ];
  if (r.oneSigmaPct != null) {
    lines.push(`Model figure: a straddle is about ${ONE_SIGMA_FACTOR}× a one-standard-deviation move under Black-Scholes, so 1σ ≈ ±${r.oneSigmaPct.toFixed(2)}%. Real moves have fatter tails than the model.`);
  }
  return lines.join("\n");
}

/** "11 days · 7 sessions" / "today · 1 session" / "1 day · 2 sessions". */
export function daysLine(days: number, sessions: number): string {
  const d = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`;
  return `${d} · ${sessions} session${sessions === 1 ? "" : "s"} left`;
}
