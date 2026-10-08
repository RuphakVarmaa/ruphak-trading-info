/**
 * One decisive status per index for a person copying the engine's paper trades by hand:
 *
 *   ENTER NOW  the engine opened a trade ≤ 10 min ago, it is still open, the index has not passed the
 *              ticket's skip level, the live index feed is fresh and the ticket data is current.
 *   PAUSED     the same trade, but the live feed (or the engine data) is stale: never enter on old data.
 *   MANAGE     a trade is open but older than 10 min, or the index has passed the skip level.
 *   EXIT NOW   the engine closed a trade ≤ 10 min ago (or its 15:05 square-off time has come).
 *   WAIT       nothing open: the main reason no entry is being made, and what would trigger one.
 *   DONE       nothing open after the last entry time (14:30 IST), or the market has closed.
 *   LOADING    today's trades have not loaded (or cannot be loaded).
 *
 * Pure: every input is passed in (now on the engine's clock, data ages on the browser's), so each
 * branch is unit-tested. Gate and regime names are the engine's own (src/engine/strategy/gates.ts,
 * src/engine/risk/limits.ts, src/engine/strategy/planner.ts, src/engine/strategy/optionSelect.ts).
 */
import type { CopyTicketView, GateResult, IndexId, OrderReason, PositionView, Regime, SessionPhase, SignalView } from "@/engine/api-types";
import { DEFAULT_CONFIG } from "@/engine/config";
import { istParts } from "@/lib/ist";
import type { Freshness, LiveIndicesFeed } from "@/lib/market/liveIndices";
import { buyLimit, ceilTick, floorTick, indexLevel, indexPrice, rupees, wholeRupees } from "./prices";

/** A trade younger than this can still be copied (if the index has not run past its skip level). */
export const ENTER_WINDOW_MS = 10 * 60_000;
/** An exit stays on screen as EXIT NOW this long. */
export const EXIT_WINDOW_MS = 10 * 60_000;
/** Ticket data older than this cannot back an ENTER NOW (the page polls tickets every 5 s). */
export const TICKETS_MAX_AGE_MS = 30_000;
/** The engine stores a reading per closed 5-minute bar after a 90 s data lag: older than this is late. */
export const SIGNAL_MAX_AGE_MS = 8 * 60_000;

export type ActionKind = "ENTER_NOW" | "PAUSED" | "MANAGE" | "EXIT_NOW" | "WAIT" | "DONE" | "LOADING";

/** Statuses that chime and notify when they appear. */
export const ALERT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["ENTER_NOW", "PAUSED", "MANAGE", "EXIT_NOW"]);

export const KIND_LABEL: Record<ActionKind, string> = {
  ENTER_NOW: "ENTER NOW",
  PAUSED: "PAUSED",
  MANAGE: "MANAGE",
  EXIT_NOW: "EXIT NOW",
  WAIT: "WAIT",
  DONE: "DONE",
  LOADING: "LOADING",
};

/** What the colour of a status means: an action to take, stale data, a trade to hold, or nothing to do. */
export type ActionTone = "action" | "stale" | "hold" | "idle";

export interface FeedInput {
  /** freshnessOf() for the live index feed (src/lib/market/liveIndices.ts). */
  freshness: Freshness;
  /** Ms since the feed's last good response (browser clock); null before the first. */
  ageMs: number | null;
  /** This index's last price in the feed; null when it is missing from the payload. */
  price: number | null;
  /** The last poll failed (with no response yet this means the feed is offline, not loading). */
  error?: boolean;
  /** The server is re-serving its last good payload because its source failed. */
  sourceStale?: boolean;
  /** The tab is in the background, where the feed does not poll. */
  hidden?: boolean;
}

/** The live feed state as useLiveIndices() gives it. */
export interface LiveFeedState {
  data: LiveIndicesFeed | null;
  freshness: Freshness;
  ageMs: number | null;
  error: string | null;
}

/** The feed input for one index: stale when the payload, or this index's own value, is a repeat. */
export function feedInput(live: LiveFeedState, index: IndexId, hidden: boolean): FeedInput {
  const quote = live.data?.indices.find((i) => i.index === index) ?? null;
  return {
    freshness: live.freshness,
    ageMs: live.ageMs,
    price: quote?.price ?? null,
    error: live.error != null,
    sourceStale: live.data?.stale === true || quote?.stale === true,
    hidden,
  };
}

export interface ActionInput {
  index: IndexId;
  /** Account id ("main", "small10k", any other). Only used in the alert identity. */
  account: string;
  /** The engine's latest reading for this index and account (null when not loaded). */
  signal: SignalView | null;
  /** The account's copy tickets for today, every index (null until loaded). */
  tickets: CopyTicketView[] | null;
  /** Ms since the last good ticket response (browser clock); null before the first. */
  ticketsAgeMs: number | null;
  /** The last ticket request failed. */
  ticketsError?: boolean;
  /** The account's open positions (used only when the tickets cannot be loaded). */
  positions?: PositionView[] | null;
  /** Now on the engine's clock, epoch ms. */
  nowMs: number;
  phase: SessionPhase;
  /** The next session open (state.market.nextOpenAt) as an ISO time, when known. */
  nextOpenAt?: string | null;
  /** Today's holiday name when the market is closed for one ("Weekend" on weekends). */
  holidayName?: string | null;
  feed: FeedInput;
  /** Ticket ids whose index was already seen past the skip level: that copy stays too late. */
  skipLatched?: ReadonlySet<string>;
  /**
   * Quantity shown for a ticket while it was open, by ticket id. A closed ticket can report double
   * its quantity (engine issue COPY-1), and selling more than you hold opens a short: EXIT NOW uses this.
   */
  openQty?: ReadonlyMap<string, number>;
  /** Exits the user has acknowledged ("I've sold"): they stop showing as EXIT NOW. */
  acked?: ReadonlySet<string>;
  /** The engine's entry window, "HH:MM" IST (defaults: the engine's config, 09:25–14:30). */
  entryFrom?: string;
  entryTo?: string;
}

export interface SkipRule {
  /** The index level as shown: rounded the safe way (down for calls, up for puts). */
  level: number;
  /** Calls skip above the level, puts below it. */
  above: boolean;
}

export interface IndexAction {
  index: IndexId;
  kind: ActionKind;
  /** "ENTER NOW", "PAUSED — live feed stale (14 s)", "MANAGE", "EXIT NOW", "WAIT", "DONE for today". */
  headline: string;
  /** The exact order or levels to copy; null when there is nothing to type. */
  order: string | null;
  /** Plain sentences under the headline, most important first. */
  details: string[];
  /** WAIT: what would trigger an entry. */
  trigger: string | null;
  tone: ActionTone;
  /** The trade this status is about. */
  ticket: CopyTicketView | null;
  /** The most to pay for the buy (ENTER NOW, PAUSED). */
  limit: number | null;
  skip: SkipRule | null;
  /** True when this evaluation saw the index past the skip level on fresh data (the caller latches it). */
  pastSkipNow: boolean;
  /** Changes exactly when the status changes; alerts compare it. */
  statusKey: string;
  /** Whether a change to this status should chime and notify. */
  alert: boolean;
  /** Desktop-notification text. */
  notice: { title: string; body: string } | null;
  /** P&L in rupees after charges to colour (EXIT NOW: the trade; DONE: the index's day). */
  pnl: number | null;
}

// ---------------------------------------------------------------------------
// Small formatters (IST, from ISO strings with an offset or epoch ms)
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad2 = (n: number) => String(n).padStart(2, "0");

const msOf = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** "11:05" (IST). */
export function hm(at: string | number): string {
  const ms = typeof at === "number" ? at : msOf(at);
  if (!Number.isFinite(ms)) return "—";
  const p = istParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "11:05:02" (IST). */
export function hms(at: string | number): string {
  const ms = typeof at === "number" ? at : msOf(at);
  if (!Number.isFinite(ms)) return "—";
  const p = istParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** "2026-10-13" -> "13-Oct" (the order line's expiry). */
export function expiryShort(expiry: string): string {
  const [, m, d] = expiry.split("-");
  return `${Number(d)}-${MONTHS[Number(m) - 1] ?? m}`;
}

/** "2026-10-13" -> "Tue 13 Oct 2026". */
export function expiryLong(expiry: string): string {
  const [y, m, d] = expiry.split("-");
  const wd = istParts(Date.UTC(Number(y), Number(m) - 1, Number(d), 6, 30)).weekday;
  return `${WEEKDAYS[wd - 1] ?? ""} ${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`.trim();
}

/** "14 s", "3 min", "1 h 5 min". */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** +0.07 / −0.20 / 0.00 (two decimals, a true minus sign). */
export function signedScore(x: number): string {
  const s = Math.abs(x).toFixed(2);
  if (Number(s) === 0) return "0.00";
  return `${x < 0 ? "−" : "+"}${s}`;
}

/** "Fri 09:15 IST" (or "09:15 IST" today, or "Fri 16 Oct 09:15 IST" further out). */
export function opensText(nextOpenAt: string | null | undefined, nowMs: number): string | null {
  const at = msOf(nextOpenAt);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  const p = istParts(at);
  const today = istParts(nowMs).date;
  const time = `${pad2(p.hour)}:${pad2(p.minute)} IST`;
  if (p.date === today) return `today ${time}`;
  const days = (at - nowMs) / 86_400_000;
  return days < 6 ? `${WEEKDAYS[p.weekday - 1]} ${time}` : `${WEEKDAYS[p.weekday - 1]} ${p.day} ${MONTHS[p.month - 1]} ${time}`;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// ---------------------------------------------------------------------------
// The order, its limit, skip level and exit levels
// ---------------------------------------------------------------------------

/** "1 lot = 65 qty" / "2 lots = 130 qty". */
export function lotsText(lots: number, qty: number): string {
  return `${lots} lot${lots === 1 ? "" : "s"} = ${qty} qty`;
}

/** The skip level as shown and checked: rounded down for calls (skip above), up for puts (skip below). */
export function skipRule(t: CopyTicketView): SkipRule | null {
  const raw = t.entry.skipBeyondSpot;
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  const above = t.side === "BULL";
  return { level: above ? Math.floor(raw) : Math.ceil(raw), above };
}

export function isPastSkip(price: number, skip: SkipRule): boolean {
  return skip.above ? price > skip.level : price < skip.level;
}

/** The engine's own limit price for the entry order (`entry.limitPrice`); null for market orders. */
export function engineEntryLimit(t: CopyTicketView): number | null {
  const v = t.entry.limitPrice;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export interface CopyLimit {
  /** The most a copier should pay, on the tick. */
  price: number;
  /** What it is built from (on the tick): the engine's entry limit when the ticket has one, else its fill. */
  base: number;
  /** "engine limit ₹142.60" or "engine fill ₹142.50". */
  baseLabel: string;
}

/** The copy limit: the engine's entry limit (else its fill), rounded up to the tick, plus 2 % (see buyLimit). */
export function copyLimit(t: CopyTicketView): CopyLimit {
  const engineLimit = engineEntryLimit(t);
  const base = ceilTick(engineLimit ?? t.entry.premium);
  return { price: buyLimit(base), base, baseLabel: `${engineLimit != null ? "engine limit" : "engine fill"} ${rupees(base)}` };
}

/** "BUY NIFTY 22600 CE 13-Oct · 1 lot = 65 qty · limit ≤ ₹145.35 · skip if NIFTY > 22,631". */
export function buyOrderText(t: CopyTicketView): string {
  const c = t.contract;
  const skip = skipRule(t);
  const parts = [`BUY ${t.index} ${c.strike} ${c.optionType} ${expiryShort(c.expiry)}`, lotsText(t.lots, t.qty), `limit ≤ ${rupees(copyLimit(t).price)}`];
  if (skip) parts.push(`skip if ${t.index} ${skip.above ? ">" : "<"} ${indexLevel(skip.level)}`);
  return parts.join(" · ");
}

/** Exit reasons in a few words, for "SELL NIFTY 22600 CE now — stop-loss hit". */
export const EXIT_WORDS: Record<OrderReason, string> = {
  ENTRY: "closed",
  STOP: "stop-loss hit",
  TARGET: "target hit",
  TRAIL: "trailing stop hit",
  TIME_STOP: "time stop",
  SQUARE_OFF: "square-off",
  SIGNAL_FLIP: "signal flip",
  EVENT_INVALIDATION: "the news behind it was re-scored",
  KILL_SWITCH: "kill switch",
  DAILY_LOSS_CAP: "daily loss cap",
  RECONCILE: "broker reconciliation",
  MANUAL: "closed by hand",
};

/** "SELL NIFTY 22600 CE 13-Oct · 1 lot = 65 qty · market order now · stop-loss hit". */
export function sellOrderText(t: CopyTicketView, reason: string, qty = t.qty): string {
  const c = t.contract;
  const lots = c.lotSize > 0 ? Math.max(1, Math.round(qty / c.lotSize)) : t.lots;
  return `SELL ${t.index} ${c.strike} ${c.optionType} ${expiryShort(c.expiry)} · ${lotsText(lots, qty)} · market order now · ${reason}`;
}

/** The quantity to sell: what was shown while the trade was open, when this page saw it open. */
export function sellQty(t: CopyTicketView, openQty?: ReadonlyMap<string, number>): number {
  const seen = openQty?.get(t.id);
  return seen != null && seen > 0 ? seen : t.qty;
}

export interface ExitLevels {
  /** The engine's stop-loss (rounded down: it sells at or below it). */
  stop: number;
  /** The engine's target (rounded up: it sells at or above it). */
  target: number;
  /** Where the trailing stop turns on (rounded up). */
  trailFrom: number;
  /** The trailing stop once on (rounded down), else null. */
  trail: number | null;
  /** The time stop sells unless the premium is at least this (rounded up). */
  timeStopKeep: number;
  timeStopAt: string;
  squareOffAt: string;
}

export function exitLevels(t: CopyTicketView): ExitLevels {
  const lv = t.levels;
  return {
    stop: floorTick(lv.stop),
    target: ceilTick(lv.target),
    trailFrom: ceilTick(lv.trailActivateAt),
    trail: lv.trail != null ? floorTick(lv.trail) : null,
    timeStopKeep: ceilTick(t.entry.premium * (1 + lv.timeStopMinPnlPct / 100)),
    timeStopAt: lv.timeStopAt,
    squareOffAt: lv.squareOffAt,
  };
}

/** "If you hold it: stop ₹99.75 (it trails once the premium reaches ₹185.25), target ₹213.75, out by 15:05. If you don't: don't chase." */
export function manageText(t: CopyTicketView): string {
  const x = exitLevels(t);
  const stop = x.trail != null && x.trail > x.stop ? `trailing stop ${rupees(x.trail)} (the trail is on)` : `stop ${rupees(x.stop)} (it trails once the premium reaches ${rupees(x.trailFrom)})`;
  return `If you hold it: ${stop}, target ${rupees(x.target)}, out by ${hm(x.squareOffAt)}. If you don't: don't chase.`;
}

function manageFromPosition(p: PositionView): string {
  const stop = floorTick(p.trailPrice != null && p.trailPrice > p.stopPrice ? p.trailPrice : p.stopPrice);
  return `If you hold it: ${p.trailPrice != null && p.trailPrice > p.stopPrice ? "trailing stop" : "stop"} ${rupees(stop)}, target ${rupees(ceilTick(p.targetPrice))}, out by ${hm(p.squareOffAt)}. If you don't: don't chase.`;
}

// ---------------------------------------------------------------------------
// Why no entry: the engine's gates in plain words
// ---------------------------------------------------------------------------

/** Every gate id the engine emits, in the order its failure matters most to a copier. */
export const GATE_RANK: Readonly<Record<string, number>> = {
  // Account-level stops: nothing more today (or this week).
  halt: 10,
  weekly_loss: 11,
  loss_streak: 12,
  trades_today: 13,
  orders_today: 14,
  // The clock and the calendar.
  market_open: 20,
  entry_window: 21,
  expiry_day: 22,
  event_blackout: 23,
  data_fresh: 24,
  // Capacity: a trade already open, or a recent stop-out.
  cooldown: 30,
  per_index: 31,
  max_positions: 32,
  no_opposite: 33,
  // The signal itself.
  conviction: 40,
  event_fresh: 41,
  // The contract and its price.
  premium_band: 50,
  contract: 51,
  quote: 52,
  spread: 53,
  open_interest: 54,
  // The economics and the size.
  edge_ratio: 60,
  expected_vs_implied: 61,
  size: 62,
  loss_room: 63,
};

const UNKNOWN_RANK = 90;

export interface Block {
  gate: string;
  rank: number;
  reason: string;
  trigger: string | null;
}

const isConviction = (g: GateResult) => g.gate.toLowerCase() === "conviction";

function counterTrend(s: SignalView): boolean {
  return (s.regime === "TREND_UP" && s.conviction < 0) || (s.regime === "TREND_DOWN" && s.conviction > 0);
}

const TREND_WORD: Partial<Record<Regime, string>> = { TREND_UP: "uptrend", TREND_DOWN: "downtrend" };

export function convictionReason(s: SignalView): string {
  const thr = s.entryThreshold.toFixed(2);
  if (counterTrend(s)) return `Conviction ${signedScore(s.conviction)} is short of the ${s.conviction < 0 ? "−" : "+"}${thr} needed against the ${TREND_WORD[s.regime]} (${s.regime})`;
  return `Conviction ${signedScore(s.conviction)} is inside the ±${thr} no-trade band (${s.regime})`;
}

export function convictionTrigger(s: SignalView): string {
  const thr = s.entryThreshold.toFixed(2);
  if (counterTrend(s)) return `A ${s.conviction < 0 ? "PE" : "CE"} needs conviction ${s.conviction < 0 ? "−" : "+"}${thr} against the ${TREND_WORD[s.regime]}, with every other check passing.`;
  return `An entry needs conviction beyond ±${thr} (above +${thr} buys a CE, below −${thr} a PE), with every other check passing.`;
}

const NONE_TODAY = "None today: this check resets at the next session.";

/** The engine cancels its own unfilled entry after 30 s; a copier's limit order would sit all day. */
export const CANCEL_UNFILLED = "Not filled within about a minute? Cancel it — don't chase.";
/** Before a market sell: an open stop-loss or target order could also fill and leave you short. */
export const CANCEL_EXITS = "First cancel your open stop-loss and target orders. If your stop-loss already filled, you are out — do nothing more.";

/** An engine detail with error-code prefixes ("ENGINE_UNREACHABLE: ", "HTTP_403: ") taken out. */
export function plainDetail(detail: string): string {
  return detail.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+:\s*/g, "").replace(/\s+/g, " ").trim();
}

/** The plain-language reason a failed gate blocks an entry, and what would unblock it. */
export function gateBlock(g: GateResult, s: SignalView, entryFrom: string, entryTo: string): Block {
  const id = g.gate.toLowerCase();
  const rank = GATE_RANK[id] ?? UNKNOWN_RANK;
  const detail = plainDetail(g.detail);
  const index = s.index;
  const block = (reason: string, trigger: string | null): Block => ({ gate: id, rank, reason, trigger });
  switch (id) {
    case "halt": {
      const m = /daily loss ₹(\d+) reached the cap ₹(\d+)/.exec(detail);
      if (m) return block(`Daily loss cap reached (${wholeRupees(Number(m[1]))} lost, cap ${wholeRupees(Number(m[2]))}): no new entries today`, NONE_TODAY);
      if (/daily loss/i.test(detail)) return block(`Daily loss cap reached: no new entries today`, NONE_TODAY);
      return block(`Kill switch is on${detail && detail !== "kill switch engaged" ? ` (${detail})` : ""}: no new entries`, "Entries resume only after the kill switch is reset.");
    }
    case "weekly_loss":
      return block(`Weekly loss cap reached (${detail}): no new entries this week`, "None this week: the cap resets on Monday.");
    case "loss_streak":
      return block(`Too many losses in a row today (${detail}): no new entries today`, NONE_TODAY);
    case "trades_today":
      return block(`Trade limit reached (${detail} entries today)`, NONE_TODAY);
    case "orders_today":
      return block(`Order limit reached (${detail} orders today)`, NONE_TODAY);
    case "market_open":
      return block(`Market not open (${detail})`, null);
    case "entry_window":
      if (/early/i.test(detail)) return block(`New entries start at ${entryFrom} IST`, null);
      return block(`No new entries after ${entryTo} IST`, NONE_TODAY);
    case "expiry_day": {
      const m = /(\d+) min to close/.exec(detail);
      return block(`${index} expires today: no new ${index} entries this close to the expiry${m ? ` (${m[1]} min to the close)` : ""}`, `None on ${index} today; the other index can still trade.`);
    }
    case "event_blackout":
      return block(`Scheduled-event blackout: ${detail}`, "Entries resume once the event window has passed.");
    case "data_fresh":
      return block(`The engine's market data is late: ${detail}`, "Entries resume when its data is fresh again.");
    case "cooldown": {
      const m = /stopped out (\d+) min ago/.exec(detail);
      const wait = DEFAULT_CONFIG.gates.stopOutCooldownMin;
      const left = m ? Math.max(1, wait - Number(m[1])) : null;
      return block(`Cooling down after a stop-out (${detail})`, left != null ? `Entries on ${index} can resume in about ${left} min.` : `Entries on ${index} resume ${wait} min after the stop-out.`);
    }
    case "per_index":
      return block(`Already holding a ${index} trade (${detail})`, `After the open ${index} trade closes.`);
    case "max_positions":
      return block(`The account is at its open-trade limit (${detail})`, "After the open trade closes.");
    case "no_opposite":
      return block("The other index holds a trade in the opposite direction", "After that trade closes.");
    case "conviction":
      return block(convictionReason(s), convictionTrigger(s));
    case "event_fresh":
      return block(`The news behind the signal is old: ${detail}`, "A fresh story, or another signal taking the lead.");
    case "premium_band":
      return block(`No strike fits the premium band: ${detail}`, "When a strike near the money prices inside the band.");
    case "contract":
      return block(`No tradable contract: ${detail}`, "When a contract can be resolved.");
    case "quote":
      return block(`No usable option quote: ${detail}`, "When the option has a fresh two-sided quote.");
    case "spread":
      return block(`Bid-ask spread too wide: ${detail} (${g.label.replace(/^Bid-ask spread\s*/, "allowed ")})`, "When the spread narrows.");
    case "open_interest":
      return block(`Open interest too low: ${detail}`, "When open interest builds up.");
    case "edge_ratio":
      return block(`Edge after time decay and costs too small: ${detail}`, "A stronger conviction (a bigger expected move) or a cheaper option.");
    case "expected_vs_implied":
      return block(`Expected move too small next to the option's implied move: ${detail}`, "A stronger conviction (a bigger expected move).");
    case "size":
      return block(`Not even one lot fits the risk limits: ${detail}`, "A cheaper option, or more room under the limits.");
    case "loss_room":
      return block(`Not enough room under the daily loss cap: ${detail}`, NONE_TODAY);
    default:
      return block(detail ? `${g.label}: ${detail}` : g.label, null);
  }
}

/** Every blocking reason for the signal, most important first (the conviction band counts even without its gate). */
export function blocksFor(s: SignalView, entryFrom: string, entryTo: string): Block[] {
  const failed = s.gates.filter((g) => g.passed === false);
  const blocks = failed.map((g) => gateBlock(g, s, entryFrom, entryTo));
  const hasConvictionGate = s.gates.some(isConviction);
  if (!hasConvictionGate && Math.abs(s.conviction) < s.entryThreshold) {
    blocks.push({ gate: "conviction", rank: GATE_RANK.conviction, reason: convictionReason(s), trigger: convictionTrigger(s) });
  }
  return blocks.sort((a, b) => a.rank - b.rank);
}

// ---------------------------------------------------------------------------
// The status
// ---------------------------------------------------------------------------

function base(input: ActionInput, kind: ActionKind, ticket: CopyTicketView | null): IndexAction {
  return {
    index: input.index,
    kind,
    headline: KIND_LABEL[kind],
    order: null,
    details: [],
    trigger: null,
    tone: kind === "ENTER_NOW" || kind === "EXIT_NOW" ? "action" : kind === "PAUSED" ? "stale" : kind === "MANAGE" ? "hold" : "idle",
    ticket,
    limit: null,
    skip: null,
    pastSkipNow: false,
    statusKey: `${kind}:${ticket?.id ?? ""}`,
    alert: ALERT_KINDS.has(kind),
    notice: null,
    pnl: null,
  };
}

const newestFirst = (a: CopyTicketView, b: CopyTicketView) => msOf(b.entry.at) - msOf(a.entry.at);

/** Why the live check cannot be trusted right now (null when it can). */
function pauseReason(input: ActionInput): { headline: string; sentence: string; quiet: boolean } | null {
  const f = input.feed;
  const index = input.index;
  const age = f.ageMs != null ? shortAge(f.ageMs) : null;
  if (f.hidden && (f.freshness === "stale" || f.freshness === "offline")) {
    return { headline: "PAUSED — live feed paused in the background", sentence: `This tab is in the background, so the live ${index} price is not updating. Open the tab to confirm the price before buying.`, quiet: false };
  }
  if (f.freshness === "loading" && !f.error) return { headline: "PAUSED — waiting for the live feed", sentence: `The live ${index} price has not loaded yet.`, quiet: true };
  if (f.freshness === "loading" || f.freshness === "offline") {
    return { headline: `PAUSED — live feed offline${age ? ` (${age})` : ""}`, sentence: `The live ${index} price is not coming through, so the skip check cannot be confirmed.`, quiet: false };
  }
  if (f.freshness === "stale") return { headline: `PAUSED — live feed stale (${age ?? "old"})`, sentence: `The live ${index} price is ${age ?? "too"} old, so the skip check cannot be confirmed.`, quiet: false };
  if (f.sourceStale) return { headline: "PAUSED — live feed stale (its source stopped updating)", sentence: `The live ${index} price is being repeated from an earlier fetch.`, quiet: false };
  if (f.price == null || !(f.price > 0)) return { headline: `PAUSED — no live ${index} price`, sentence: `The live feed has no ${index} price right now.`, quiet: false };
  if (input.ticketsAgeMs == null || input.ticketsAgeMs > TICKETS_MAX_AGE_MS) {
    const t = input.ticketsAgeMs != null ? shortAge(input.ticketsAgeMs) : null;
    return { headline: `PAUSED — engine data stale${t ? ` (${t})` : ""}`, sentence: "The engine's trade list has not refreshed, so the trade may already have closed.", quiet: false };
  }
  return null;
}

function openAction(input: ActionInput, t: CopyTicketView, others: string[]): IndexAction {
  const now = input.nowMs;
  const entryMs = msOf(t.entry.at);
  const ageMs = Number.isFinite(entryMs) ? Math.max(0, now - entryMs) : Infinity;
  const squareOffMs = msOf(t.levels.squareOffAt);
  const c = t.contract;
  const name = `${t.index} ${c.strike} ${c.optionType}`;
  const x = exitLevels(t);
  const model = t.entry.priceSource === "model";
  const fillLine = `The engine bought at ${hms(t.entry.at)} IST (${shortAge(ageMs)} ago) at ${rupees(t.entry.premium)}${model ? ", a model price: Groww's will differ" : ""}.`;

  // Its square-off time has come: the engine is selling everything (and will confirm on its next tick).
  if (Number.isFinite(squareOffMs) && now >= squareOffMs) {
    const p = istParts(now);
    const afterClose = p.date !== istParts(squareOffMs).date || p.minutesOfDay >= 15 * 60 + 30;
    if (afterClose) {
      const a = base(input, "DONE", t);
      a.headline = "DONE for today";
      a.details = [`The market has closed. The engine still lists ${name} as open: check your own positions in Groww.`, ...others];
      return a;
    }
    const a = base(input, "EXIT_NOW", t);
    const reason = `square-off ${hm(t.levels.squareOffAt)}`;
    a.headline = `SELL ${name} now — ${reason}`;
    a.order = sellOrderText(t, reason, sellQty(t, input.openQty));
    a.details = [`It is past the ${hm(t.levels.squareOffAt)} IST square-off: the engine sells every open trade now.`, ...others];
    a.notice = { title: `EXIT NOW · ${t.index}`, body: `SELL ${name} now — ${reason}` };
    return a;
  }

  const skip = skipRule(t);
  const latched = input.skipLatched?.has(t.id) ?? false;
  const pause = pauseReason(input);
  const price = input.feed.price;
  const pastNow = pause == null && skip != null && price != null && isPastSkip(price, skip);
  // The trailing stop is on once the premium is 30 % up: far past any copy limit, so too late to copy.
  const trailOn = x.trail != null;

  if (ageMs <= ENTER_WINDOW_MS && !latched && !pastNow && !trailOn) {
    const order = buyOrderText(t);
    const lim = copyLimit(t);
    const limit = lim.price;
    const skipText = skip ? `skip if ${t.index} is ${skip.above ? "above" : "below"} ${indexLevel(skip.level)}` : null;
    if (pause) {
      const a = base(input, "PAUSED", t);
      a.headline = pause.headline;
      a.order = order;
      a.limit = limit;
      a.skip = skip;
      a.alert = !pause.quiet;
      a.details = [
        `${pause.sentence} Don't buy on old data.`,
        skipText ? `To check it yourself, look at ${t.index} in Groww: ${skipText}.` : `The engine gave no skip level: use the limit as the cap.`,
        ...others,
      ];
      a.notice = { title: `PAUSED · ${t.index} trade`, body: `${pause.headline.replace(/^PAUSED — /, "")}. ${order}` };
      return a;
    }
    const a = base(input, "ENTER_NOW", t);
    a.order = order;
    a.limit = limit;
    a.skip = skip;
    a.details = [
      fillLine,
      `Limit = ${lim.baseLabel} + 2%, rounded up to ₹0.05. Once filled: stop-loss ${rupees(x.stop)}, target ${rupees(x.target)}, out by ${hm(x.squareOffAt)}.`,
      ...(price != null && skip ? [`${t.index} ${indexPrice(price)} is inside the skip level ${indexLevel(skip.level)}.`] : []),
      ...(t.live && t.live.mark > limit
        ? [`The engine's latest mark ${rupees(t.live.mark)}${t.live.markAt ? ` (${hm(t.live.markAt)})` : ""} is already above the limit: the order may not fill. Don't raise the limit.`]
        : []),
      ...(skip ? [] : ["The engine gave no skip level for this trade: the limit is the only cap."]),
      CANCEL_UNFILLED,
      ...others,
    ];
    a.notice = { title: `ENTER NOW · ${t.index}`, body: order };
    return a;
  }

  const a = base(input, "MANAGE", t);
  a.order = manageText(t);
  a.pastSkipNow = pastNow;
  a.skip = skip;
  if (trailOn) {
    // Its own status: the trailing stop turning on is worth an alert (raise your stop-loss).
    a.statusKey = `MANAGE:${t.id}:trail`;
    a.headline = `MANAGE — trailing stop on (${rupees(x.trail!)})`;
  }
  const why =
    pastNow && price != null && skip
      ? `${t.index} ${indexPrice(price)} is past the skip level ${indexLevel(skip.level)} — don't chase.`
      : latched && skip
        ? `${t.index} went past the skip level ${indexLevel(skip.level)} — don't chase.`
        : trailOn && ageMs <= ENTER_WINDOW_MS
          ? `The premium already ran 30% up (the trailing stop is on) — don't chase.`
          : `Opened at ${hm(t.entry.at)} IST, ${shortAge(ageMs)} ago: too late to copy.`;
  const markLine = t.live ? `Engine mark ${rupees(t.live.mark)}${t.live.markAt ? ` at ${hm(t.live.markAt)}` : ""} (${t.live.movePct >= 0 ? "+" : "−"}${Math.abs(t.live.movePct).toFixed(1)}% on the premium).` : null;
  const trailLine = trailOn ? [`Holding it? Raise your stop-loss to ${rupees(x.trail!)}: the engine sells if the premium falls back there.`] : [];
  a.details = [why, "Cancel any unfilled buy order for it.", ...trailLine, ...(markLine ? [markLine] : []), `The time stop at ${hm(x.timeStopAt)} sells unless the premium is at least ${rupees(x.timeStopKeep)}.`, ...others];
  a.notice = trailOn
    ? { title: `TRAILING STOP ON · ${t.index}`, body: `${name}: raise your stop-loss to ${rupees(x.trail!)}. Target ${rupees(x.target)}, out by ${hm(x.squareOffAt)}.` }
    : { title: `MANAGE · ${t.index}`, body: `${name}: ${a.order}` };
  return a;
}

function exitAction(input: ActionInput, t: CopyTicketView, others: string[]): IndexAction {
  const x = t.exit!;
  const c = t.contract;
  const name = `${t.index} ${c.strike} ${c.optionType}`;
  const reason = EXIT_WORDS[x.reason] ?? "closed";
  const a = base(input, "EXIT_NOW", t);
  const qty = sellQty(t, input.openQty);
  const late = input.nowMs - msOf(x.at) > EXIT_WINDOW_MS;
  a.headline = `SELL ${name} now — ${reason}`;
  a.order = sellOrderText(t, reason, qty);
  a.pnl = x.pnl;
  a.details = [
    CANCEL_EXITS,
    `The engine sold at ${rupees(x.premium)} at ${hm(x.at)} IST after ${x.holdMin} min: ${wholeRupees(x.pnl, true)} after charges (${x.reasonText.toLowerCase()}).`,
    ...(late ? [`That was ${shortAge(input.nowMs - msOf(x.at))} ago. If you still hold it, sell now.`] : []),
    qty !== t.qty ? `Sell the ${qty} qty shown while it was open: the closed record lists ${t.qty}, and selling more than you hold opens a short.` : "Sell only the quantity you actually hold.",
    ...others,
  ];
  a.notice = { title: `EXIT NOW · ${t.index}`, body: `SELL ${name} now — ${reason}` };
  return a;
}

function daySummary(index: IndexId, tickets: CopyTicketView[]): { line: string; pnl: number } | null {
  const closed = tickets.filter((t) => t.index === index && t.exit);
  if (closed.length === 0) return null;
  const pnl = closed.reduce((s, t) => s + (t.exit?.pnl ?? 0), 0);
  return { line: `Today on ${index}: ${closed.length} trade${closed.length === 1 ? "" : "s"}, ${wholeRupees(pnl, true)} after charges.`, pnl };
}

function idleAction(input: ActionInput, tickets: CopyTicketView[] | null, others: string[]): IndexAction {
  const { index, nowMs: now, phase } = input;
  const entryFrom = input.entryFrom ?? DEFAULT_CONFIG.gates.noEntryBeforeIst;
  const entryTo = input.entryTo ?? DEFAULT_CONFIG.gates.noEntryAfterIst;
  const mins = istParts(now).minutesOfDay;
  const opens = opensText(input.nextOpenAt, now);
  const summary = tickets ? daySummary(index, tickets) : null;
  const done = (line: string): IndexAction => {
    const a = base(input, "DONE", null);
    a.headline = "DONE for today";
    a.details = [line, ...(summary ? [summary.line] : []), ...others];
    a.pnl = summary?.pnl ?? null;
    return a;
  };
  const wait = (reason: string, trigger: string | null, extra: string[] = []): IndexAction => {
    const a = base(input, "WAIT", null);
    a.details = [reason, ...extra, ...(summary ? [summary.line] : []), ...others];
    a.trigger = trigger;
    return a;
  };

  const weekend = istParts(now).weekday >= 6;
  if (phase === "HOLIDAY" || (phase === "CLOSED" && weekend)) {
    const named = input.holidayName && input.holidayName !== "Weekend" ? input.holidayName : null;
    const what = named ? `Market closed today (${named})` : weekend ? "Market closed (weekend)" : "Market closed today";
    return wait(`${what}${opens ? ` — opens ${opens}` : ""}`, `New entries can come from ${entryFrom} IST on the next session.`);
  }
  if (phase === "CLOSED") {
    if (mins >= 15 * 60 + 30) return done(`Market closed at 15:30 IST${opens ? ` — opens ${opens}` : ""}.`);
    return wait(`Market closed — opens ${opens ?? "09:15 IST"}`, `New entries can come from ${entryFrom} IST.`);
  }
  if (phase === "PRE_OPEN") return wait(`Pre-open — trading starts at 09:15 IST; new entries from ${entryFrom} IST`, `From ${entryFrom} IST, when the engine's checks pass.`);

  // OPEN
  if (mins > minutesOf(entryTo)) return done(`No new entries after ${entryTo} IST, and nothing is open on ${index}.`);
  const s = input.signal;
  if (mins < minutesOf(entryFrom)) {
    const extra = s ? [`Engine reading at ${hm(s.computedAt)} IST: conviction ${signedScore(s.conviction)} (needs ±${s.entryThreshold.toFixed(2)}, ${s.regime}).`] : [];
    return wait(`New entries start at ${entryFrom} IST`, s ? convictionTrigger(s) : null, extra);
  }
  if (!s) return wait(`No engine reading for ${index} yet`, null);

  const age = now - msOf(s.computedAt);
  const stale = Number.isFinite(age) && age > SIGNAL_MAX_AGE_MS;
  const staleLine = stale ? [`The engine's last ${index} reading is from ${hm(s.computedAt)} IST (${shortAge(age)} ago): it may be behind.`] : [];
  const blocks = blocksFor(s, entryFrom, entryTo);
  const main = blocks[0];
  if (!main) {
    const a = wait(`Every check passes on the engine's ${hm(s.computedAt)} IST reading: an entry may follow within seconds`, null, staleLine);
    if (stale) a.tone = "stale";
    return a;
  }
  const more = blocks.length - 1;
  const extra = [...staleLine, ...(more > 0 ? [`${more} more check${more === 1 ? "" : "s"} failing (see Details).`] : []), `Engine reading at ${hm(s.computedAt)} IST.`];
  // When the conviction is short too, say so in the trigger, unless the main reason already rules out
  // any entry today (account-wide stops) or is the conviction itself.
  const convictionToo = main.gate !== "conviction" && main.rank >= 20 && blocks.some((b) => b.gate === "conviction");
  const trigger = [main.trigger, convictionToo ? convictionTrigger(s) : null].filter(Boolean).join(" ") || null;
  const a = wait(main.reason, trigger, extra);
  if (stale) a.tone = "stale";
  return a;
}

/** One decisive status for one index. */
export function deriveIndexAction(input: ActionInput): IndexAction {
  const { index } = input;
  const all = input.tickets;
  const mine = (all ?? []).filter((t) => t.index === index);
  const open = mine.filter((t) => t.status === "OPEN").sort(newestFirst);
  // An exit stays EXIT NOW for 10 min, and while the market is open for as long as this tab saw the
  // trade open and the user has not said "I've sold". It outranks any other open trade on the index.
  const pendingExit = mine
    .filter((t) => {
      if (t.status !== "CLOSED" || !t.exit || input.acked?.has(t.id)) return false;
      const age = input.nowMs - msOf(t.exit.at);
      if (age < -60_000) return false;
      return age <= EXIT_WINDOW_MS || (input.phase === "OPEN" && (input.openQty?.has(t.id) ?? false));
    })
    .sort((a, b) => msOf(b.exit!.at) - msOf(a.exit!.at));
  const alsoOpen = (list: CopyTicketView[]) => list.map((t) => `Also open: ${t.index} ${t.contract.strike} ${t.contract.optionType} (since ${hm(t.entry.at)}).`);

  if (pendingExit.length > 0) {
    const others = [
      ...pendingExit.slice(1).map((t) => `Also: sell ${t.index} ${t.contract.strike} ${t.contract.optionType} if you still hold it (${EXIT_WORDS[t.exit!.reason]} at ${hm(t.exit!.at)}).`),
      ...alsoOpen(open),
    ];
    return exitAction(input, pendingExit[0], others);
  }
  if (open.length > 0) return openAction(input, open[0], alsoOpen(open.slice(1)));

  if (all == null) {
    // The trade list is not available: fall back to the engine's open positions for the levels.
    const pos = (input.positions ?? []).filter((p) => p.index === index).sort((a, b) => msOf(b.openedAt) - msOf(a.openedAt))[0];
    if (pos) {
      const a = base(input, "MANAGE", null);
      a.statusKey = `MANAGE:${pos.id}`;
      a.order = manageFromPosition(pos);
      a.details = [`The engine holds ${pos.contract.index} ${pos.contract.strike} ${pos.contract.optionType} (since ${hm(pos.openedAt)}), but today's trade list did not load, so it cannot be copied from here.`];
      a.notice = { title: `MANAGE · ${index}`, body: a.order };
      return a;
    }
    if (input.phase === "OPEN" || input.phase === "PRE_OPEN") {
      const a = base(input, "LOADING", null);
      a.headline = input.ticketsError ? "Can't load today's trades" : "Loading today's trades…";
      a.details = input.ticketsError ? ["The engine is not answering. This retries every few seconds."] : [];
      if (input.ticketsError) a.tone = "stale";
      return a;
    }
    return idleAction(input, null, []);
  }
  return idleAction(input, all, []);
}

/** The single "what to do now" line for a trade card. */
export function nowLine(a: IndexAction | null, t: CopyTicketView | null): string {
  if (!t) return a ? [a.headline, a.details[0]].filter(Boolean).join(": ") : "Nothing to do yet.";
  const name = `${t.index} ${t.contract.strike} ${t.contract.optionType}`;
  const x = exitLevels(t);
  if (a && a.ticket?.id === t.id) {
    switch (a.kind) {
      case "ENTER_NOW":
        return `Buy ${t.qty} qty of ${name} now with a limit of ${rupees(a.limit ?? copyLimit(t).price)} or less, then place the stop-loss at ${rupees(x.stop)}.`;
      case "PAUSED":
        return `Wait: ${a.headline.replace(/^PAUSED — /, "")}. Don't buy ${name} until the live price is back${a.skip ? `, and skip it if ${t.index} is ${a.skip.above ? "above" : "below"} ${indexLevel(a.skip.level)}` : ""}.`;
      case "MANAGE":
        return `Holding ${name}? Keep the stop at ${rupees(x.trail != null && x.trail > x.stop ? x.trail : x.stop)} and sell by ${hm(x.squareOffAt)} IST. Not holding it? Don't chase it.`;
      case "EXIT_NOW": {
        const qty = Number(/= (\d+) qty/.exec(a.order ?? "")?.[1] ?? t.qty);
        return `Cancel your open stop-loss and target orders, then sell your ${qty} qty of ${name} at market (${a.headline.split(" — ")[1] ?? "the engine sold"}). If your stop-loss already filled, you are out.`;
      }
      default:
        break;
    }
  }
  if (t.status === "CLOSED" && t.exit) return `${name} closed at ${hm(t.exit.at)} IST (${EXIT_WORDS[t.exit.reason]}). If you still hold it, sell now; otherwise nothing to do.`;
  return `${name} is open: follow the stop-loss ${rupees(x.stop)} and target ${rupees(x.target)}, out by ${hm(x.squareOffAt)} IST.`;
}
