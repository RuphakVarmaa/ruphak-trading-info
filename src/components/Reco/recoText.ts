/**
 * Pure text and state helpers for the "₹10k trade now" card (no React), unit-tested in recoText.test.ts:
 * the exact order line, the clipboard text, rupee and premium figures, the measured-history box, the
 * grade and verdict words, the alert key, and whether a reading is stale or past its validity.
 */
import type { IndexId, RecommendationView, SignalView } from "@/engine/api-types";
import { C } from "@/components/shared/colors";
import { fmtIstHm } from "@/components/shared/format";
import { shortExpiry } from "@/components/Setups/setupText";
import { istAt, istDate } from "@/lib/ist";

export type Reco = RecommendationView;
export type Historical = NonNullable<Reco["historical"]>;

export const STATUS_WORDS: Record<Reco["status"], string> = { ENTER: "ENTER", WAIT: "WAIT", NO_TRADE: "NO TRADE" };
export const STATUS_COLOR: Record<Reco["status"], string> = { ENTER: C.green, WAIT: C.orange, NO_TRADE: C.muted };

/** A reading older than this (on the engine's clock) is stale: nothing on it should be acted on. */
export const RECO_STALE_MS = 3 * 60_000;

const MINUS = "−";

/** "₹9,262" / "−₹1,026" (whole rupees, en-IN grouping); `sign` adds "+" to gains. */
export function rupees(n: number | null | undefined, sign = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  const body = `₹${Math.abs(r).toLocaleString("en-IN")}`;
  return r < 0 ? `${MINUS}${body}` : sign && r > 0 ? `+${body}` : body;
}

/** "₹142.50". */
export function premium(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `₹${n.toFixed(2)}`;
}

/** An index level: "22,540". */
export function indexLevel(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-IN");
}

/** "10:48" from an ISO time, or the clock in a text such as "13:30 IST"; the text itself when neither. */
export function clockText(s: string | null | undefined): string | null {
  if (s == null || s === "") return null;
  const hm = /^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*IST)?$/.exec(s.trim());
  if (hm) return `${hm[1].padStart(2, "0")}:${hm[2]}`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && /\dT\d/.test(s) ? fmtIstHm(ms) : s;
}

/** "1 lot = 65 qty" / "2 lots = 40 qty". */
export function lotsText(lots: number, lotSize: number): string {
  return `${lots} lot${lots === 1 ? "" : "s"} = ${lots * lotSize} qty`;
}

/**
 * The exact order: "BUY NIFTY 22500 CE 20-Oct · 1 lot = 65 qty · limit ≤ ₹142.50 · valid till 10:48".
 * Null when there is no contract, no entry price or no whole lot.
 */
export function orderLine(r: Pick<Reco, "index" | "contract" | "entry" | "lots">): string | null {
  const c = r.contract;
  const e = r.entry;
  if (!c || !e || !(r.lots >= 1)) return null;
  const till = clockText(e.validUntil);
  return [`BUY ${r.index} ${c.strike} ${c.optionType} ${shortExpiry(c.expiry)}`, lotsText(r.lots, c.lotSize), `limit ≤ ${premium(e.limit)}`, ...(till ? [`valid till ${till}`] : [])].join(" · ");
}

/** "Stop ₹99.75 (NIFTY 22,431)"; null without a stop. */
export function stopText(r: Pick<Reco, "index" | "stop">): string | null {
  if (!r.stop) return null;
  return `Stop ${premium(r.stop.premium)}${r.stop.index != null ? ` (${r.index} ${indexLevel(r.stop.index)})` : ""}`;
}

/** "T1 ₹213.75 (NIFTY 22,655) · T2 ₹256.50"; null without a target. */
export function targetText(r: Pick<Reco, "index" | "target">): string | null {
  const t = r.target;
  if (!t) return null;
  const t1 = `T1 ${premium(t.t1)}${t.indexT1 != null ? ` (${r.index} ${indexLevel(t.indexT1)})` : ""}`;
  return t.t2 != null ? `${t1} · T2 ${premium(t.t2)}` : t1;
}

/** The clipboard text: the order line, then the stop, the targets and the time exit. */
export function recoCopyText(r: Reco): string {
  const lines = [orderLine(r) ?? `${STATUS_WORDS[r.status]} ${r.index}`];
  const levels = [stopText(r), targetText(r), r.timeExit ? `exit by ${clockText(r.timeExit)}` : null].filter((x): x is string => x != null);
  if (levels.length) lines.push(levels.join(" · "));
  if (r.entry?.trigger) lines.push(`Entry: ${r.entry.trigger}`);
  return lines.join("\n");
}

/** "1:1.6"; "—" when unknown. */
export function rrText(rr: number | null | undefined): string {
  return rr == null || !Number.isFinite(rr) ? "—" : `1:${rr.toFixed(1)}`;
}

/** "41%"; "—" when unknown. */
export function pct0(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`;
}

/** "−₹1,026 to −₹326"; "—" when unknown. */
export function ciText(ci: [number, number] | null | undefined): string {
  return ci ? `${rupees(ci[0], true)} to ${rupees(ci[1], true)}` : "—";
}

export const VERDICT_META: Record<Historical["verdict"], { label: string; color: string; meaning: string }> = {
  positive: { label: "Positive", color: C.green, meaning: "The 95% range of the average result per lot is above zero on data the rule was not fitted on." },
  not_proven: { label: "Not proven", color: C.orange, meaning: "The 95% range includes zero: the history cannot tell this rule from luck." },
  negative: { label: "Negative", color: C.red, meaning: "On the test data this rule lost money on average after charges." },
};

export const GRADE_COLOR: Record<Reco["grade"], string> = { A: C.green, B: C.blue, C: C.muted };
export const GRADE_TITLE = "Grade A only when the rule's measured history is positive; otherwise read the line under the card before acting.";

/** The honest line shows unless the grade is A and the measured history really is positive. */
export function showHonestLine(r: Pick<Reco, "grade" | "historical">): boolean {
  return r.grade !== "A" || r.historical?.verdict !== "positive";
}

/** Rows for the measured-history box (label, value, colour). */
export function historyRows(h: Historical): { label: string; value: string; color?: string }[] {
  const avgColor = h.avgPnlPerLot == null ? undefined : h.avgPnlPerLot > 0 ? C.green : h.avgPnlPerLot < 0 ? C.red : undefined;
  return [
    { label: "Test trades", value: h.sample.toLocaleString("en-IN") },
    { label: "Made money", value: pct0(h.hitRate) },
    { label: "Avg per lot", value: rupees(h.avgPnlPerLot, true), color: avgColor },
    { label: "95% range", value: ciText(h.ci95) },
  ];
}

/** Chime once per index, contract and status; only ENTER chimes. */
export function recoAlertKey(r: Pick<Reco, "status" | "index" | "contract">): string | null {
  if (r.status !== "ENTER" || !r.contract) return null;
  const c = r.contract;
  return `${r.index}|${c.tradingSymbol || `${c.strike}${c.optionType}${c.expiry}`}|ENTER`;
}

/** The notification for an ENTER: title and body. */
export function recoNotice(r: Reco): { title: string; body: string } {
  return { title: `ENTER · ${r.index} (grade ${r.grade})`, body: [orderLine(r), stopText(r), targetText(r)].filter(Boolean).join("\n") };
}

/**
 * The engine's clock from the browser's: `offsetMs` is the page's engine-clock offset (0 in production;
 * the mock runs its own simulated session).
 */
export function engineNow(browserNowMs: number, offsetMs: number): number {
  return browserNowMs + offsetMs;
}

/**
 * When the entry stops being valid, in epoch ms: an ISO time as given, or a clock time ("10:48", "10:48 IST")
 * on the reading's IST day. Null when it cannot be read.
 */
export function validUntilMs(validUntil: string, asOf: string): number | null {
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*IST)?$/.exec(validUntil.trim());
  if (hm) {
    const asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) return null;
    return istAt(istDate(asOfMs), Number(hm[1]) * 60 + Number(hm[2])) + Number(hm[3] ?? 0) * 1000;
  }
  const ms = Date.parse(validUntil);
  return Number.isFinite(ms) ? ms : null;
}

/** Stale: older than RECO_STALE_MS on the engine's clock. Expired: past the entry's "valid till". */
export function recoState(r: Pick<Reco, "asOf" | "entry">, engineNowMs: number | null): { stale: boolean; expired: boolean; ageMs: number | null } {
  if (engineNowMs == null) return { stale: false, expired: false, ageMs: null };
  const asOf = Date.parse(r.asOf);
  const ageMs = Number.isFinite(asOf) ? Math.max(0, engineNowMs - asOf) : null;
  const until = r.entry ? validUntilMs(r.entry.validUntil, r.asOf) : null;
  return { stale: ageMs != null && ageMs > RECO_STALE_MS, expired: until != null && engineNowMs > until, ageMs };
}

/** "₹10k" from 10,000; "₹12.5k" from 12,500; "₹2.5L" from 2,50,000. */
export function capitalLabel(capital: number): string {
  if (!(capital > 0)) return "₹—";
  if (capital >= 1e5) return `₹${+(capital / 1e5).toFixed(1)}L`;
  if (capital >= 1e3) return `₹${+(capital / 1e3).toFixed(1)}k`;
  return `₹${Math.round(capital)}`;
}

/**
 * Each index's recommendation from the signals: the view, null when the engine says there is none, or
 * undefined when the engine does not publish recommendations at all (an engine that predates them).
 */
export function recosFrom(signals: SignalView[] | null, indices: readonly IndexId[]): Record<IndexId, Reco | null | undefined> {
  const out = {} as Record<IndexId, Reco | null | undefined>;
  for (const i of indices) {
    const s = signals?.find((x) => x.index === i);
    out[i] = s ? s.recommendation : undefined;
  }
  return out;
}
