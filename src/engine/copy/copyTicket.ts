/**
 * Copy tickets: a paper trade laid out so a person can repeat it by hand in their own broker account
 * (what to buy, the levels, why the engine took it and where the index stood), plus the Telegram
 * texts sent when the engine buys, when its trailing stop turns on, and when it sells. Pure.
 */
import { SIGNAL_SOURCE_LABELS, contractLabel, type AccountView, type CopyTicketView, type SignalComponentView } from "../api-types";
import { computeCharges } from "../broker/charges";
import { MINUTE_MS, istDate, istIso, istParts, weekdayOf } from "../clock";
import { stopPrice, targetPrice, trailPrice } from "../strategy/exits";
import type { IndicatorView, OrderReason, Position, Quote, Regime, SignalComponent, TradePlan } from "../types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const EXIT_REASON_TEXT: Record<OrderReason, string> = {
  ENTRY: "Entry",
  STOP: "Stop-loss hit",
  TARGET: "Target hit",
  TRAIL: "Trailing stop: gave back part of the gain",
  TIME_STOP: "Time stop: the move did not come in time",
  SQUARE_OFF: "End-of-day square-off",
  SIGNAL_FLIP: "The signals turned against the trade",
  EVENT_INVALIDATION: "The news behind the trade was re-scored",
  KILL_SWITCH: "Kill switch",
  DAILY_LOSS_CAP: "Daily loss cap reached",
  RECONCILE: "Broker reconciliation",
  MANUAL: "Closed by hand",
};

const REGIME_TEXT: Record<Regime, string> = {
  TREND_UP: "trending-up",
  TREND_DOWN: "trending-down",
  RANGE: "range-bound",
  HIGH_VOL: "high-volatility",
  EVENT: "news-driven",
};

export interface CopyTicketInput {
  position: Position;
  /** The plan the position was opened from (null when the record is missing). */
  plan: TradePlan | null;
  account: AccountView;
  /** The account's exits.timeStopMinPnlPct. */
  timeStopMinPnlPct: number;
  /** Readings to show when the plan predates TradePlan.indicators (main's decision for the plan). */
  fallbackIndicators?: IndicatorView | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** "2026-10-13" -> "13 Oct". */
export function dayMonth(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

/** "2026-10-13" -> "Tue 13 Oct". */
export function expiryLabel(date: string): string {
  return `${WEEKDAYS[weekdayOf(date) - 1] ?? ""} ${dayMonth(date)}`.trim();
}

const contribution = (c: SignalComponent) => Math.abs(c.weight * c.value);
const votes = (c: SignalComponent) => c.enabled && !c.abstain && c.source !== "VOL_REGIME" && c.weight > 0 && c.value !== 0;

/** Plain-language reasons from the signals that voted, strongest first, then the volatility note. */
export function setupReasons(plan: TradePlan): string[] {
  const comps = plan.conviction.components;
  const voters = comps.filter(votes).sort((a, b) => contribution(b) - contribution(a));
  const total = voters.reduce((s, c) => s + contribution(c), 0) || 1;
  const out = voters.map(
    (c) => `${SIGNAL_SOURCE_LABELS[c.source]}, ${c.value > 0 ? "bullish" : "bearish"} (${Math.round((contribution(c) / total) * 100)}% of the vote)${c.notes ? `: ${c.notes}` : ""}`,
  );
  const vol = comps.find((c) => c.source === "VOL_REGIME" && c.notes);
  if (vol) out.push(`Volatility: ${vol.notes}`);
  return out;
}

function componentViews(plan: TradePlan): SignalComponentView[] {
  const order = (c: SignalComponent) => (votes(c) ? 0 : 1);
  return [...plan.conviction.components]
    .sort((a, b) => order(a) - order(b) || contribution(b) - contribution(a))
    .map((c) => ({ source: c.source, value: c.value, weight: c.weight, enabled: c.enabled, ...(c.notes ? { notes: c.notes } : {}), ...(c.abstain ? { abstain: true } : {}) }));
}

/** Where the entry premium came from; plans made before quoteSource existed say so in their quote gate. */
function quoteSourceOf(plan: TradePlan | null): Quote["source"] | null {
  if (!plan) return null;
  if (plan.quoteSource) return plan.quoteSource;
  const detail = plan.gates.find((g) => g.gate === "quote")?.detail ?? "";
  return detail.startsWith("groww") ? "groww" : detail.startsWith("synthetic") ? "synthetic" : null;
}

const hm = (ms: number) => {
  const p = istParts(ms);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/**
 * Units bought at entry. An open position's qty is what is still held (exitedQty has been sold); a
 * closed one keeps its full traded quantity in qty (applyExitFills), so adding exitedQty would count
 * the exit as a second entry.
 */
export function entryQuantity(p: Pick<Position, "status" | "qty" | "exitedQty">): number {
  return p.status === "CLOSED" ? Math.max(p.qty, p.exitedQty ?? 0) : p.qty + (p.exitedQty ?? 0);
}

export function copyTicketView(i: CopyTicketInput): CopyTicketView {
  const { position: p, plan, account } = i;
  const c = p.contract;
  const entryQty = entryQuantity(p);
  const lots = c.lotSize > 0 ? Math.max(1, Math.round(entryQty / c.lotSize)) : 0;
  const indicators = plan?.indicators ?? i.fallbackIndicators ?? null;
  const spot = plan?.refSpot ?? indicators?.spot ?? 0;
  const dir = p.side === "BULL" ? 1 : -1;
  const skipBeyondSpot = plan && plan.expectedMovePct > 0 && spot > 0 ? round2(spot * (1 + (dir * plan.expectedMovePct) / 200)) : null;
  const stop = stopPrice(p);
  const target = targetPrice(p);
  const trailActivateAt = p.avgEntry * (1 + p.stops.trailActivatePct / 100);
  const risk = (p.avgEntry - stop) * entryQty + p.entryCharges + computeCharges("SELL", stop, entryQty, c.exchange, istDate(p.entryMs)).total;
  const priceSource = quoteSourceOf(plan) === "groww" ? "broker" : "model";
  const open = p.status === "OPEN";
  const mark = p.markPremium > 0 ? p.markPremium : p.avgEntry;
  const trail = open ? trailPrice(p) : null;
  const prevClose = indicators?.prevDayClose ?? 0;
  const searchText = `${c.index} ${c.strike} ${c.type}`;
  const label = expiryLabel(c.expiry);
  const fill = round2(p.avgEntry);

  const steps = [
    `Search "${searchText}" in your broker app and pick the ${label} expiry.`,
    `Buy ${lots} lot${lots === 1 ? "" : "s"} (${entryQty} qty) with a limit order near the ask. The engine's ${p.mode === "LIVE" ? "live" : "paper"} fill was ₹${fill.toFixed(2)}${priceSource === "model" ? ", a model price: the real one will differ" : ""}.`,
    ...(skipBeyondSpot !== null
      ? [`Skip it if ${c.index} is already ${dir > 0 ? "above" : "below"} ${Math.round(skipBeyondSpot).toLocaleString("en-IN")}: half of the expected move has happened.`]
      : []),
    `Set a stop-loss ${Math.abs(p.stops.stopPct)}% under your own fill (₹${round2(stop).toFixed(2)} for a ₹${fill.toFixed(2)} fill). The target is +${p.stops.targetPct}% (₹${round2(target).toFixed(2)}).`,
    `Sell when the engine sells, at the latest by ${hm(p.stops.squareOffMs)} IST. It also sells on its trailing stop, its time stop (${hm(p.stops.timeStopMs)}) and when the signals turn.`,
  ];

  return {
    id: p.id,
    planId: p.planId,
    account: { id: account.id, label: account.label, shortLabel: account.shortLabel, capitalRupees: account.capitalRupees },
    mode: p.mode,
    status: p.status,
    index: p.index,
    side: p.side,
    headline: `BUY ${searchText} (${dayMonth(c.expiry)})`,
    contract: {
      index: c.index,
      expiry: c.expiry,
      strike: c.strike,
      optionType: c.type,
      tradingSymbol: c.tradingSymbol,
      growwSymbol: c.growwSymbol,
      lotSize: c.lotSize,
      lots,
      premium: fill,
      premiumAtRisk: Math.round(risk),
      label: contractLabel({ index: c.index, expiry: c.expiry, strike: c.strike, optionType: c.type }),
    },
    searchText,
    expiryLabel: label,
    qty: entryQty,
    lots,
    entry: {
      at: istIso(p.entryMs),
      premium: fill,
      costRupees: round2(p.avgEntry * entryQty),
      charges: round2(p.entryCharges),
      priceSource,
      spot: round2(spot),
      skipBeyondSpot,
    },
    levels: {
      stopPct: p.stops.stopPct,
      stop: round2(stop),
      targetPct: p.stops.targetPct,
      target: round2(target),
      trailActivatePct: p.stops.trailActivatePct,
      trailActivateAt: round2(trailActivateAt),
      trailGivebackPct: p.stops.trailGivebackPct,
      trail: trail === null ? null : round2(trail),
      timeStopAt: istIso(p.stops.timeStopMs),
      timeStopMinPnlPct: i.timeStopMinPnlPct,
      squareOffAt: istIso(p.stops.squareOffMs),
    },
    riskAtStop: { rupees: Math.round(risk), pctOfCapital: account.capitalRupees > 0 ? round2((risk / account.capitalRupees) * 100) : 0 },
    live: open
      ? {
          mark: round2(mark),
          markAt: p.markMs > 0 ? istIso(p.markMs) : null,
          pnl: round2(p.unrealized - p.entryCharges),
          movePct: round2((mark / p.avgEntry - 1) * 100),
          peak: round2(p.peakPremium),
          mfePct: round2(p.mfePct),
          maePct: round2(p.maePct),
        }
      : null,
    exit:
      !open && p.exitMs
        ? {
            at: istIso(p.exitMs),
            premium: round2(p.avgExit ?? mark),
            reason: p.exitReason ?? "MANUAL",
            reasonText: EXIT_REASON_TEXT[p.exitReason ?? "MANUAL"],
            pnl: round2((p.realized ?? 0) - p.entryCharges - (p.exitCharges ?? 0)),
            movePct: round2(((p.avgExit ?? mark) / p.avgEntry - 1) * 100),
            holdMin: Math.max(0, Math.round((p.exitMs - p.entryMs) / MINUTE_MS)),
          }
        : null,
    setup: plan
      ? {
          stance: plan.conviction.stance,
          conviction: round2(plan.conviction.score),
          threshold: plan.conviction.threshold,
          regime: plan.conviction.regime,
          dominantSource: plan.dominantSource,
          expectedMovePct: plan.expectedMovePct,
          impliedMovePct: plan.impliedMovePct,
          breakevenMovePct: plan.breakevenMovePct,
          edgeRatio: plan.edgeRatio,
          horizonMin: plan.horizonMin,
          components: componentViews(plan),
          gates: plan.gates,
          reasons: setupReasons(plan),
        }
      : null,
    market: {
      spot: round2(spot),
      changePct: prevClose > 0 && spot > 0 ? round2((spot / prevClose - 1) * 100) : null,
      vix: plan?.vix ?? null,
      indicators,
    },
    steps,
  };
}

// ---------------------------------------------------------------------------
// Telegram texts (plain text, no markup)
// ---------------------------------------------------------------------------

const inr = (x: number) => `₹${Math.round(Math.abs(x)).toLocaleString("en-IN")}`;
const signedInr = (x: number) => `${x < 0 ? "−" : "+"}${inr(x)}`;
const prem = (x: number) => `₹${x.toFixed(2)}`;
const level = (x: number) => Math.round(x).toLocaleString("en-IN");
const pct = (x: number, digits = 1) => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(digits)}%`;
const hmIso = (iso: string) => iso.slice(11, 16);

/** 500000 -> "₹5L", 10000 -> "₹10k". */
export function capitalShort(rupees: number): string {
  return rupees >= 100_000 ? `₹${Number((rupees / 100_000).toFixed(1))}L` : `₹${Math.round(rupees / 1000)}k`;
}

/** "₹10k" for accounts whose short label already names the capital, else "Main ₹5L". */
export function accountTag(a: { shortLabel: string; capitalRupees: number }): string {
  return a.shortLabel.includes("₹") ? a.shortLabel : `${a.shortLabel} ${capitalShort(a.capitalRupees)}`;
}

/** Link to the ticket on the dashboard's copy-trade page, or null without a dashboard URL. */
export function copyLink(dashboardUrl: string | undefined, t: Pick<CopyTicketView, "id" | "account">): string | null {
  const base = (dashboardUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  const account = t.account.id !== "main" ? `account=${encodeURIComponent(t.account.id)}&` : "";
  return `${base}/copy?${account}id=${encodeURIComponent(t.id)}`;
}

const OR_STATE: Record<string, string> = { INSIDE: "inside", BROKE_UP: "broken upward", BROKE_DOWN: "broken downward", FORMING: "forming" };

/** One line on where the index stood when the trade was planned. */
export function marketLine(t: CopyTicketView): string {
  const m = t.market;
  const parts = [`${t.index} ${level(m.spot)}${m.changePct !== null ? ` (${pct(m.changePct, 2)} on the day)` : ""}`];
  const ind = m.indicators;
  if (ind) {
    if (ind.vwap > 0) parts.push(`VWAP ${level(ind.vwap)} (${ind.vwapZ >= 0 ? "+" : "−"}${Math.abs(ind.vwapZ).toFixed(1)}σ)`);
    const or = ind.openingRange;
    if (or && or.high > 0 && or.state !== "FORMING") parts.push(`opening range ${level(or.low)}–${level(or.high)} ${OR_STATE[or.state] ?? or.state.toLowerCase()}`);
    parts.push(`RSI ${ind.rsi14.toFixed(0)}`);
    parts.push(`ADX ${ind.adx14.toFixed(0)} (+DI ${ind.plusDi14.toFixed(0)} / −DI ${ind.minusDi14.toFixed(0)})`);
    if (ind.supertrendDir !== 0) parts.push(`Supertrend ${ind.supertrendDir > 0 ? "up" : "down"}`);
  }
  if (m.vix !== null) parts.push(`VIX ${m.vix.toFixed(1)}`);
  return parts.join(" · ");
}

/** Sent when the engine buys: what to buy, the levels, why, and where the index stood. */
export function copyEntryText(t: CopyTicketView, link: string | null): string {
  const tag = accountTag(t.account);
  const lv = t.levels;
  const lines = [
    `🟢 COPY ${tag} · ${t.headline}`,
    `${t.lots} lot = ${t.qty} qty · ${t.mode === "LIVE" ? "live" : "paper"} fill ${prem(t.entry.premium)}${t.entry.priceSource === "model" ? " (model price: check the real one)" : ""} · cost ${inr(t.entry.costRupees)}`,
  ];
  if (t.entry.skipBeyondSpot !== null) lines.push(`Skip if ${t.index} is already ${t.side === "BULL" ? "above" : "below"} ${level(t.entry.skipBeyondSpot)} (it was ${level(t.entry.spot)})`);
  lines.push(`Stop ${pct(lv.stopPct, 0)} → ${prem(lv.stop)} · Target ${pct(lv.targetPct, 0)} → ${prem(lv.target)}`);
  lines.push(
    `Trail from ${pct(lv.trailActivatePct, 0)} (${prem(lv.trailActivateAt)}), gives back ${lv.trailGivebackPct}% of the gain · time stop ${hmIso(lv.timeStopAt)} unless ${pct(lv.timeStopMinPnlPct, 0)} · out by ${hmIso(lv.squareOffAt)}`,
  );
  lines.push(`If stopped: −${inr(t.riskAtStop.rupees)} with charges (${t.riskAtStop.pctOfCapital.toFixed(1)}% of ${capitalShort(t.account.capitalRupees)})`);
  const s = t.setup;
  if (s) {
    lines.push("", `Why: ${s.stance === "BULLISH" ? "bullish" : s.stance === "BEARISH" ? "bearish" : "neutral"} ${s.conviction >= 0 ? "+" : "−"}${Math.abs(s.conviction).toFixed(2)} (needs ${s.threshold.toFixed(2)}) on a ${REGIME_TEXT[s.regime]} day`);
    for (const r of s.reasons.slice(0, 4)) lines.push(`• ${r}`);
    lines.push(`Edge: expects ${s.expectedMovePct.toFixed(2)}% vs ${s.impliedMovePct.toFixed(2)}% priced in over ${s.horizonMin} min (×${s.edgeRatio.toFixed(2)})`);
  }
  lines.push("", marketLine(t));
  if (link) lines.push("", link);
  return lines.join("\n");
}

/** Sent when the trailing stop turns on (once per position). */
export function copyTrailText(t: CopyTicketView, link: string | null): string | null {
  if (!t.live || t.levels.trail === null) return null;
  const c = t.contract;
  const lines = [
    `🟡 COPY ${accountTag(t.account)} · ${t.searchText} (${dayMonth(c.expiry)}): trailing stop on`,
    `The premium reached ${prem(t.live.peak)} (${pct((t.live.peak / t.entry.premium - 1) * 100, 0)}). The engine now sells if it falls to ${prem(t.levels.trail)}, giving back ${t.levels.trailGivebackPct}% of the gain.`,
    "Holding a copy? Raise your stop-loss so it keeps a gain.",
  ];
  if (link) lines.push(link);
  return lines.join("\n");
}

/** Sent when the engine sells. */
export function copyExitText(t: CopyTicketView, link: string | null): string | null {
  const x = t.exit;
  if (!x) return null;
  const lines = [
    `🔴 COPY ${accountTag(t.account)} · SELL ${t.searchText} (${dayMonth(t.contract.expiry)}) now`,
    `${x.reasonText} · ${t.mode === "LIVE" ? "live" : "paper"} ${prem(t.entry.premium)} → ${prem(x.premium)} (${pct(x.movePct)}) · ${signedInr(x.pnl)} after charges ${x.pnl >= 0 ? "✅" : "❌"}`,
    `Held ${x.holdMin} min`,
  ];
  if (link) lines.push(link);
  return lines.join("\n");
}
