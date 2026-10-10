/**
 * Today's plan: the plan's no-trade rules (docs/research/options-trading-plan.md §4) checked for the
 * session, with the session's entry windows (§4 N3, §5) and the paused-buying state. Read-only: it informs
 * the Desk and a person trading by hand. Nothing here changes a trading decision or a gate.
 *
 * - N1 scheduled event. A HIGH-impact event after the session and up to the next session's close blocks
 *   the session before it (premium is bid up before the event and falls on the day). One inside the
 *   session is a caution, with its blackout window. A MED one is a caution.
 * - N2 volatility jump or a big run (cfg.rules.n2, the plan's thresholds):
 *   - India VIX more than 10% above its close five sessions earlier;
 *   - VIX more than 8% up on the day (checked once the market is open);
 *   - VIX in the top third of its year;
 *   - the index more than 2% from its close five sessions earlier.
 * - N4 short-dated contract. The nearest contract a buyer may use (never one expiring on the session) has
 *   one session or less left: use the following week's.
 * - N7 expiry day. No new entries after 14:00 on the index's own expiry day.
 * - N9 the gap. A global-markets gap estimate (the engine's fitted model) of 0.3% or more means no early
 *   trade. Never trade the gap itself.
 *
 * Pure and web-standard (no node: imports).
 */
import type { IndexPlanView, PlanCheckView, PlanWindowView, TodayPlanView } from "../api-types";
import { MINUTE_MS, SESSION, formatHHMM, istDate, istIso, istMinutes } from "../clock";
import type { EngineConfig } from "../config";
import type { IndexId, MarketFeatures, N2Daily, ScheduledEvent } from "../types";

/** What the plan needs from the trading calendar (TradingCalendar implements it). */
export interface PlanCalendar {
  isTradingDay(date: string): boolean;
  nextTradingDay(date: string): string;
  tradingDaysBetween(from: string, to: string): number;
  openMs(date: string): number;
  closeMs(date: string): number;
  expiryOnOrAfter(index: IndexId, date: string): string;
  followingExpiry(index: IndexId, expiry: string): string;
  isExpiryDay(index: IndexId, date: string): boolean;
  scheduledEvents(fromMs: number, toMs: number, opts?: { includeExpiries?: boolean }): ScheduledEvent[];
}

export interface TodayPlanInput {
  nowMs: number;
  calendar: PlanCalendar;
  cfg: EngineConfig;
  /** The engine's latest snapshot (null without one). */
  snapshot: {
    t: number;
    features: Partial<Record<IndexId, Pick<MarketFeatures, "vixChangePct" | "expectedGapPct" | "gapPct">>>;
    daily?: Partial<Record<IndexId, N2Daily | null>>;
  } | null;
}

/** Opening-gap estimate from which the plan says "no early trade" (rule N9 and §0: a big gap means wait for 09:30). */
export const BIG_GAP_PCT = 0.3;
/** A snapshot older than this says nothing about the session's market (the plan marks its market checks unknown). */
export const SNAPSHOT_MAX_AGE_MS = 36 * 60 * MINUTE_MS;
export const PLAN_SOURCE = "docs/research/options-trading-plan.md §4–§5 (rules N1, N2, N4, N7, N9; the session windows)";

const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}%`;
const hhmm = (ms: number) => formatHHMM(istMinutes(ms));

/** The session the plan is for: today while it is a trading day and before the close, otherwise the next trading day. */
export function planSession(nowMs: number, cal: Pick<PlanCalendar, "isTradingDay" | "nextTradingDay" | "closeMs">): { date: string; when: "today" | "next" } {
  const today = istDate(nowMs);
  if (cal.isTradingDay(today) && nowMs < cal.closeMs(today)) return { date: today, when: "today" };
  return { date: cal.nextTradingDay(today), when: "next" };
}

/** The session's windows for a buyer (§4 N3, §5): the morning window is the only one the evidence supports. */
export function planWindows(cfg: EngineConfig): PlanWindowView[] {
  const open = formatHHMM(SESSION.open);
  const from = cfg.rules.n3.entryFromIst;
  const to = cfg.rules.n3.exitByIst;
  const squareOff = cfg.exits.squareOffIst;
  return [
    {
      from: open,
      to: from,
      kind: "avoid",
      label: "Opening minutes",
      why: "The day's richest premium. On real prices an hour bought at 09:15 cost ₹2,176 a NIFTY lot, against ₹818 bought at 09:30.",
    },
    {
      from,
      to,
      kind: "trade",
      label: "Morning window",
      why: "The only part of the day where the index moved more than the decay it cost (rule N3). A trade still needs a signal that passes every check.",
    },
    {
      from: to,
      to: "14:15",
      kind: "avoid",
      label: "Midday",
      why: "The index moved only about 0.7× the decay here, in both halves of the sample and on both indices.",
    },
    {
      from: "14:15",
      to: squareOff,
      kind: "avoid",
      label: "Afternoon",
      why: "No new entries. On an index's expiry day the 14:00–15:00 hour cost 15% of the premium.",
    },
    { from: squareOff, to: formatHHMM(SESSION.close), kind: "close", label: "Square-off", why: "Everything is closed by 15:05: no overnight or weekend holds (rule N5)." },
  ];
}

/** Rule N1 for one index: HIGH events before the next session's close block the session before them; events inside it, and MED ones, are cautions. */
export function eventCheck(index: IndexId, date: string, cal: PlanCalendar, cfg: EngineConfig): PlanCheckView {
  const open = cal.openMs(date);
  const close = cal.closeMs(date);
  const nextClose = cal.closeMs(cal.nextTradingDay(date));
  const events = cal
    .scheduledEvents(open - 12 * 60 * MINUTE_MS, nextClose, { includeExpiries: false })
    .filter((e) => e.kind !== "EXPIRY" && e.indices.includes(index) && (e.impact === "HIGH" || e.impact === "MED"));
  const label = "N1 · Scheduled events";
  const before = events.filter((e) => e.impact === "HIGH" && e.at > close && e.at <= nextClose);
  if (before.length > 0) {
    const e = before[0];
    return {
      rule: "N1",
      label,
      status: "block",
      detail: `The session before ${e.title} (${istDate(e.at)} ${hhmm(e.at)}${e.approx ? ", approximate" : ""}). Premium is bid up before scheduled events and falls on the day, so no new position today.`,
    };
  }
  const inside = events.filter((e) => e.at >= open - cfg.gates.preEventBlackoutMin * MINUTE_MS && e.at <= close);
  if (inside.length > 0) {
    const e = inside[0];
    const from = hhmm(e.at - Math.max(30, cfg.gates.preEventBlackoutMin) * MINUTE_MS);
    const to = hhmm(e.at + Math.max(30, cfg.gates.postEventWaitMin) * MINUTE_MS);
    return { rule: "N1", label, status: "caution", detail: `${e.title} at ${hhmm(e.at)}${e.approx ? " (approximate)" : ""}: no entries from ${from} to ${to}.` };
  }
  const med = events.find((e) => e.impact === "MED" && e.at > close && e.at <= nextClose);
  if (med) return { rule: "N1", label, status: "caution", detail: `${med.title} after the session (${istDate(med.at)} ${hhmm(med.at)}): a medium-impact release; keep size small.` };
  return { rule: "N1", label, status: "clear", detail: "No high-impact scheduled event in this session or before the next one." };
}

/** Rule N2 for one index from the snapshot's daily inputs; the on-the-day VIX jump only counts while the market is open. */
export function volatilityCheck(d: N2Daily | null | undefined, vixChangePct: number | null, cfg: EngineConfig): PlanCheckView {
  const r = cfg.rules.n2;
  const label = "N2 · Volatility jump or a big run";
  if (!d) return { rule: "N2", label, status: "unknown", detail: "No India VIX history in the engine's latest snapshot." };
  const blocks: string[] = [];
  const missing: string[] = [];
  if (d.vix5dChangePct === null) missing.push("the 5-session VIX change");
  else if (d.vix5dChangePct > r.vix5dJumpPct) blocks.push(`VIX ${pct(d.vix5dChangePct)} over 5 sessions (above +${r.vix5dJumpPct}%)`);
  if (vixChangePct !== null && Number.isFinite(vixChangePct) && vixChangePct > r.vixDayJumpPct) blocks.push(`VIX ${pct(vixChangePct)} today (above +${r.vixDayJumpPct}%)`);
  if (d.vixPctile === null) missing.push("VIX's 1-year percentile");
  else if (d.vixPctile > r.vixPctileAbove) blocks.push(`VIX at the ${Math.round(d.vixPctile * 100)}th percentile of its year (top third)`);
  if (d.run5dPct === null) missing.push("the 5-session index move");
  else if (Math.abs(d.run5dPct) > r.run5dPct) blocks.push(`index ${pct(d.run5dPct, 2)} over 5 sessions (beyond ±${r.run5dPct}%)`);
  const facts = [
    d.vix5dChangePct === null ? null : `VIX ${pct(d.vix5dChangePct)} over 5 sessions`,
    vixChangePct === null ? null : `${pct(vixChangePct)} today`,
    d.vixPctile === null ? null : `${Math.round(d.vixPctile * 100)}th percentile of its year`,
    d.run5dPct === null ? null : `index ${pct(d.run5dPct, 2)} over 5 sessions`,
  ].filter((x): x is string => x !== null);
  if (blocks.length > 0) return { rule: "N2", label, status: "block", detail: `${blocks.join("; ")}. Buying after a volatility jump or a big run lost the most on real prices.` };
  if (missing.length > 0) return { rule: "N2", label, status: "unknown", detail: `Not enough history for ${missing.join(", ")}.${facts.length ? ` ${facts.join("; ")}.` : ""}` };
  return { rule: "N2", label, status: "clear", detail: `${facts.join("; ")} (closes up to ${d.lastSession}).` };
}

/** Rules N4 and N7 for one index: the contract a buyer may use, and the expiry-day limit. */
export function expiryChecks(index: IndexId, date: string, cal: PlanCalendar): { checks: PlanCheckView[]; expiry: string; sessionsLeft: number } {
  const checks: PlanCheckView[] = [];
  const expiringToday = cal.isExpiryDay(index, date);
  // Never the contract expiring on the session (the engine's own rule), so the next one after it.
  let expiry = cal.expiryOnOrAfter(index, date);
  if (expiry <= date) expiry = cal.followingExpiry(index, expiry);
  let sessionsLeft = cal.tradingDaysBetween(date, expiry);
  if (sessionsLeft <= 1) {
    const next = cal.followingExpiry(index, expiry);
    const nextLeft = cal.tradingDaysBetween(date, next);
    checks.push({
      rule: "N4",
      label: "N4 · Contract with one session or less left",
      status: "caution",
      detail: `The nearest contract (${expiry}) has ${sessionsLeft} session${sessionsLeft === 1 ? "" : "s"} left. Buy the following week's (${next}, ${nextLeft} sessions) or skip; one-session contracts lost 10.6% of premium a day on real prices.`,
    });
    expiry = next;
    sessionsLeft = nextLeft;
  } else {
    checks.push({ rule: "N4", label: "N4 · Contract with one session or less left", status: "clear", detail: `The nearest contract to buy is ${expiry}, with ${sessionsLeft} sessions left.` });
  }
  checks.push(
    expiringToday
      ? {
          rule: "N7",
          label: "N7 · Expiry day",
          status: "caution",
          detail: `${index}'s weekly contract expires today: never buy it, and no new entries after 14:00 (that hour cost 15% of the premium on real prices).`,
        }
      : { rule: "N7", label: "N7 · Expiry day", status: "clear", detail: `Not ${index}'s expiry day.` },
  );
  return { checks, expiry, sessionsLeft };
}

/** Rule N9 for one index: the opening gap. */
export function gapCheck(expectedGapPct: number | null, gapPct: number | null, opened: boolean): PlanCheckView {
  const label = "N9 · The opening gap";
  if (opened && gapPct !== null && Number.isFinite(gapPct)) {
    const big = Math.abs(gapPct) >= BIG_GAP_PCT;
    return {
      rule: "N9",
      label,
      status: big ? "caution" : "clear",
      detail: `Opened ${pct(gapPct, 2)} from the previous close${expectedGapPct === null ? "" : ` (global markets implied ${pct(expectedGapPct, 2)})`}. ${big ? "A big gap: wait for 09:30 and never trade the gap itself; gap-up and gap-down days closed above their open only 48% of the time." : "A small gap: no early trade, and the gap says nothing about the rest of the day."}`,
    };
  }
  if (expectedGapPct === null || !Number.isFinite(expectedGapPct)) return { rule: "N9", label, status: "unknown", detail: "No global-markets gap estimate yet; NSE's pre-open auction fixes the open at 09:08." };
  const big = Math.abs(expectedGapPct) >= BIG_GAP_PCT;
  return {
    rule: "N9",
    label,
    status: big ? "caution" : "clear",
    detail: `Global markets imply a ${pct(expectedGapPct, 2)} open (typical error 0.26%); NSE's pre-open auction fixes it at 09:08. ${big ? "A big gap: wait for 09:30 and never trade the gap itself." : "A small gap: no early trade."}`,
  };
}

function headlineFor(index: IndexId, verdict: IndexPlanView["verdict"], checks: PlanCheckView[]): string {
  const names = (status: PlanCheckView["status"]) => checks.filter((c) => c.status === status).map((c) => c.label.replace(/^N\d · /, "").toLowerCase());
  if (verdict === "no_trade") return `${index}: no new entries this session (${names("block").join("; ")}).`;
  if (verdict === "caution") {
    const parts = [names("caution").join("; "), names("unknown").length ? `no data yet for: ${names("unknown").join("; ")}` : ""].filter(Boolean);
    return `${index}: only inside the morning window, with care (${parts.join("; ")}).`;
  }
  return `${index}: no rule blocks this session; entries only in the morning window, and only on a signal that passes every check.`;
}

export function buildTodayPlan(input: TodayPlanInput): TodayPlanView {
  const { nowMs, calendar: cal, cfg, snapshot } = input;
  const { date, when } = planSession(nowMs, cal);
  const fresh = snapshot !== null && nowMs - snapshot.t <= SNAPSHOT_MAX_AGE_MS;
  const opened = when === "today" && nowMs >= cal.openMs(date) && fresh && snapshot !== null && istDate(snapshot.t) === date && snapshot.t >= cal.openMs(date);
  const indices: IndexPlanView[] = cfg.indices.map((index) => {
    const f = fresh ? snapshot?.features[index] : undefined;
    const d = fresh ? snapshot?.daily?.[index] : undefined;
    const { checks: expiry, expiry: contractExpiry, sessionsLeft } = expiryChecks(index, date, cal);
    const expectedGapPct = f && Number.isFinite(f.expectedGapPct) ? f.expectedGapPct : null;
    const gapPct = opened && f && Number.isFinite(f.gapPct) ? f.gapPct : null;
    const checks: PlanCheckView[] = [
      eventCheck(index, date, cal, cfg),
      volatilityCheck(d, opened && f ? f.vixChangePct : null, cfg),
      ...expiry,
      gapCheck(expectedGapPct, gapPct, opened),
    ];
    // A missing input is never read as clear: the verdict is "clear" only when every check is.
    const verdict: IndexPlanView["verdict"] = checks.some((c) => c.status === "block") ? "no_trade" : checks.every((c) => c.status === "clear") ? "clear" : "caution";
    return { index, verdict, headline: headlineFor(index, verdict, checks), checks, expectedGapPct, gapPct, expiry: contractExpiry, sessionsLeft };
  });
  const buyingPaused = cfg.gates.expectedMoveModel === "calibrated";
  return {
    date,
    when,
    buyingPaused,
    pausedReason: buyingPaused
      ? "Buying is paused: the measured-edge check (EDGE_GATE=calibrated) blocks every entry on the current signals, because none has beaten its decay and costs in the research program (options-trading-plan.md §15). The checks below still show what the plan's rules say about the session."
      : null,
    windows: planWindows(cfg),
    indices,
    asOf: snapshot ? istIso(snapshot.t) : null,
    source: PLAN_SOURCE,
  };
}
