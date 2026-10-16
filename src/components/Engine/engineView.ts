/**
 * Pure helpers for the Paper Engine page ("/"): the account in the URL, the safety strip's chips,
 * today's and all-time P&L, and one row per copy ticket. No React and no engine access, so they are
 * tested on their own (engineView.test.ts) and safe to import from the server page.
 */
import { ACCOUNTS, parseAccountId } from "@/engine/accounts";
import type { AccountView, CopyTicketView, EngineStateDTO, PnlResponse, PositionView, SessionPhase, TodayPlanView } from "@/engine/api-types";
import { EXIT_WORDS } from "@/lib/copy/action";
import { istParts } from "@/lib/ist";
import { fmtAge, fmtDuration, fmtInr, fmtIstDay, fmtIstHm } from "@/components/shared/format";

type Query = Record<string, string | string[] | undefined>;

const ACCOUNT_RE = /^[a-z0-9]{1,32}$/;

/** `?account=small10k` selects that paper account; no parameter, "main" or anything malformed is main (undefined). Same rule as /live and /copy. */
export function accountFromQuery(query: Query): string | undefined {
  const raw = Array.isArray(query.account) ? query.account[0] : query.account;
  return raw && raw !== "main" && ACCOUNT_RE.test(raw) ? raw : undefined;
}

/** A link to another page for the same account: main keeps the plain path. */
export function accountHref(path: string, account: string | null | undefined, params: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  if (account && account !== "main") sp.set("account", account);
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * True for an account of kind "agent" (the options agent's paper experiment), by the account registry or by the
 * engine's own view of it. Its trades are never offered as copy tickets (the engine refuses /api/engine/copy for
 * it), so the pages skip that poll and show a plain note instead.
 */
export function isAgentAccount(account: string | null | undefined, state: Pick<EngineStateDTO, "account" | "accounts"> | null = null): boolean {
  if (!account) return false;
  const id = parseAccountId(account);
  if (id != null && ACCOUNTS[id].kind === "agent") return true;
  const view = state?.account?.id === account ? state.account : state?.accounts?.find((a) => a.id === account);
  return view?.kind === "agent";
}

/** The account's starting capital as the engine reports it; null when it does not (never a default). */
export function capitalOf(state: Pick<EngineStateDTO, "account" | "accounts"> | null, accountId: string): number | null {
  if (!state) return null;
  if (state.account && state.account.id === accountId) return state.account.capitalRupees;
  const listed: AccountView | undefined = state.accounts?.find((a) => a.id === accountId);
  return listed?.capitalRupees ?? null;
}

// ---------------------------------------------------------------------------
// Market session line
// ---------------------------------------------------------------------------

/** "Market open · closes in 3h 47m", "Market closed · opens Mon 19 Oct 09:15 IST", … */
export function marketStatusText(phase: SessionPhase, nowMs: number | null, nextOpenMs: number | null, nextCloseMs: number | null, holiday: string | null): string {
  if (phase === "OPEN") return `Market open${nextCloseMs != null && nowMs != null && nextCloseMs > nowMs ? ` · closes in ${fmtDuration(nextCloseMs - nowMs)}` : ""}`;
  if (phase === "PRE_OPEN") return "Pre-open session";
  if (phase === "HOLIDAY") return `Market holiday${holiday ? ` · ${holiday}` : ""}`;
  return `Market closed${nextOpenMs != null && nowMs != null && nextOpenMs > nowMs ? ` · opens ${fmtIstDay(nextOpenMs)} ${fmtIstHm(nextOpenMs)} IST` : ""}`;
}

// ---------------------------------------------------------------------------
// Safety strip
// ---------------------------------------------------------------------------

/** ok: nothing to do; info: a plain fact; warn: worth a look; bad: act or read now; mock: demo data; muted: no data. */
export type ChipTone = "ok" | "info" | "warn" | "bad" | "mock" | "muted";

export interface SafetyChip {
  key: "mock" | "mode" | "kill" | "engine" | "buying";
  tone: ChipTone;
  label: string;
  detail: string | null;
  /** Longer text for a tooltip (the full reason). */
  title: string | null;
  /** In-page link to the panel that explains or controls it. */
  href: string | null;
}

export interface SafetyInput {
  state: Pick<EngineStateDTO, "dataSource" | "mode" | "liveTradingEnabled" | "armed" | "armedUntil" | "killSwitch" | "killReason" | "heartbeat" | "market"> | null;
  /** The provider's source ("mock" when the dashboard serves its built-in mock). */
  source: "engine" | "mock" | null;
  status: "loading" | "live" | "stale" | "offline";
  plan: Pick<TodayPlanView, "buyingPaused" | "pausedReason"> | null;
  /** Today's tickets that carry the paper practice-quota gate. */
  practiceToday: number;
  /** Now on the engine's clock (null during server render and hydration). */
  nowMs: number | null;
}

const chip = (key: SafetyChip["key"], tone: ChipTone, label: string, detail: string | null = null, extra: Partial<Pick<SafetyChip, "title" | "href">> = {}): SafetyChip => ({
  key,
  tone,
  label,
  detail,
  title: extra.title ?? null,
  href: extra.href ?? null,
});

function modeChip(s: NonNullable<SafetyInput["state"]>): SafetyChip {
  if (s.mode === "PAPER") return chip("mode", "info", "Paper", "simulated orders", { title: "PAPER mode: every order is simulated against live quotes; nothing reaches a broker." });
  if (s.armed && s.liveTradingEnabled) {
    return chip("mode", "bad", "LIVE · armed", s.armedUntil ? `real orders until ${fmtIstHm(s.armedUntil)} IST` : "real orders can be placed", {
      title: "LIVE mode with the live key on and the engine armed: entries place real orders.",
      href: "#operations",
    });
  }
  return chip("mode", "warn", "Live mode", s.liveTradingEnabled ? "not armed: no real orders" : "live key off: no real orders", {
    title: "LIVE mode needs three keys (LIVE_TRADING, LIVE mode, armed) before a real order; not all are on.",
    href: "#operations",
  });
}

function killChip(s: NonNullable<SafetyInput["state"]>): SafetyChip {
  if (s.killSwitch || s.heartbeat.phase === "KILLED") {
    return chip("kill", "bad", "Kill switch ON", s.killReason ?? "no reason recorded", { title: "No new entries while the kill switch is on. Reset it under Book, controls and health.", href: "#operations" });
  }
  return chip("kill", "ok", "Kill switch off");
}

function engineChip(input: SafetyInput): SafetyChip {
  const { state, status, nowMs } = input;
  const hb = state?.heartbeat ?? null;
  const age = hb?.lastTickAt && nowMs != null ? Math.max(0, nowMs - Date.parse(hb.lastTickAt)) : null;
  const ran = age != null ? `last ran ${fmtAge(age)} ago` : null;
  if (status === "offline") return chip("engine", "bad", "Engine not answering", "showing the last data received", { href: "#operations" });
  if (status === "stale") return chip("engine", "warn", "Data out of date", ran, { href: "#operations" });
  if (!hb) return chip("engine", "muted", "Engine", "connecting…");
  if (hb.consecutiveErrors > 0) {
    return chip("engine", "bad", "Engine errors", `${hb.consecutiveErrors} in a row${ran ? ` · ${ran}` : ""}`, { title: hb.lastError ?? null, href: "#operations" });
  }
  if (hb.phase === "DEGRADED") return chip("engine", "warn", "Engine degraded", ran, { title: hb.lastError ?? null, href: "#operations" });
  if (!hb.lastTickAt) return chip("engine", "warn", "Engine has not run yet", null, { href: "#operations" });
  const marketActive = state?.market.phase === "OPEN" || state?.market.phase === "PRE_OPEN";
  if (marketActive && age != null && age > 3 * hb.loopIntervalSec * 1000) {
    return chip("engine", "warn", "Engine late", `${ran} (runs every ${hb.loopIntervalSec}s)`, { href: "#operations" });
  }
  const idle = hb.phase === "IDLE" || hb.phase === "CLOSED";
  return chip("engine", "ok", idle ? "Engine idle" : "Engine running", [ran, "no errors"].filter(Boolean).join(" · "));
}

function buyingChip(plan: SafetyInput["plan"], practiceToday: number): SafetyChip {
  if (!plan) return chip("buying", "muted", "Buying", "no data");
  const practice = practiceToday > 0 ? ` · ${practiceToday} practice trade${practiceToday === 1 ? "" : "s"} today` : "";
  if (plan.buyingPaused) {
    return chip("buying", "warn", "New buys paused", `measured-edge check${practice}`, { title: plan.pausedReason, href: "#why" });
  }
  return chip("buying", "ok", "Buying on", `each entry still needs every check${practice}`, { href: "#why" });
}

/** The safety strip, most important first: demo data (when on), mode, kill switch, engine heartbeat, buying. */
export function safetyChips(input: SafetyInput): SafetyChip[] {
  const out: SafetyChip[] = [];
  const s = input.state;
  if (s?.dataSource === "mock" || input.source === "mock") {
    out.push(chip("mock", "mock", "Demo data", "mock engine, not market data", { title: "The dashboard is serving its built-in mock engine (ENGINE_MOCK=1 or no engine binding): every figure on this page is simulated." }));
  }
  out.push(s ? modeChip(s) : chip("mode", "muted", "Mode", "no data"));
  out.push(s ? killChip(s) : chip("kill", "muted", "Kill switch", "no data"));
  out.push(engineChip(input));
  out.push(buyingChip(input.plan, input.practiceToday));
  return out;
}

// ---------------------------------------------------------------------------
// P&L
// ---------------------------------------------------------------------------

export interface PnlFigures {
  /** Today after charges, on the engine's latest marks (exactly PnlTiles' "Net P&L today"). */
  netToday: number;
  /** Equity now: today's starting equity plus netToday (PnlTiles' equity). */
  equityNow: number;
  capital: number | null;
  /** equityNow − capital: every session since the account started, in this mode; null without a capital. */
  allTime: number | null;
  allTimePct: number | null;
  /** The P&L window the engine returned: its first date (YYYY-MM-DD) and the net since then, today included. */
  window: { from: string; net: number };
}

/**
 * Today's and all-time P&L from the engine's P&L summary. The engine's ledger starts each day at
 * capital + every earlier day's (realized − charges) in the same mode, so equity now minus the
 * capital is the P&L since the start. Unrealized uses each open position's latest mark, as PnlTiles does.
 */
export function pnlFigures(pnl: Pick<PnlResponse, "today" | "history"> | null, positions: Pick<PositionView, "ltp" | "avgPrice" | "qty">[] | null, capital: number | null): PnlFigures | null {
  if (!pnl) return null;
  const t = pnl.today;
  const open = positions ?? [];
  const unrealized = open.length > 0 ? open.reduce((s, p) => s + (p.ltp == null ? 0 : (p.ltp - p.avgPrice) * p.qty), 0) : t.unrealized;
  const netToday = t.realized + unrealized - t.charges;
  const equityNow = t.equityEnd - t.net + netToday;
  const usable = capital != null && Number.isFinite(capital) && capital > 0 ? capital : null;
  const allTime = usable != null ? equityNow - usable : null;
  // The engine's history includes today's ledger once the day has one; the mock's does not.
  const prior = pnl.history.filter((d) => d.date !== t.date);
  const from = prior.reduce((min, d) => (d.date < min ? d.date : min), t.date);
  return {
    netToday,
    equityNow,
    capital: usable,
    allTime,
    allTimePct: allTime != null && usable != null ? (allTime / usable) * 100 : null,
    window: { from, net: prior.reduce((s, d) => s + d.net, 0) + netToday },
  };
}

// ---------------------------------------------------------------------------
// Today's trades
// ---------------------------------------------------------------------------

export interface TradeRow {
  id: string;
  href: string;
  /** The exchange contract, e.g. "NIFTY 19-OCT-2026 22600 CE". */
  contract: string;
  /** "BUY NIFTY 22600 CE (19 Oct)". */
  headline: string;
  open: boolean;
  /** Taken by the paper practice quota (the measured-edge check was off for it). */
  practice: boolean;
  inText: string;
  outText: string;
  /** After charges (entry charges while open); null when the engine has no mark or exit. */
  pnl: number | null;
}

/** True when the trade carries the engine's practice-quota gate. */
export function isPractice(t: Pick<CopyTicketView, "setup">): boolean {
  return t.setup?.gates.some((g) => g.gate === "practice") ?? false;
}

const premium = (n: number) => fmtInr(n, { decimals: 2 });

/** One row of "Today's trades": in, out (or the latest mark), P&L, and the /copy link for the account. */
export function tradeRow(t: CopyTicketView, account: string | null | undefined): TradeRow {
  const inText = `in ${fmtIstHm(t.entry.at)} at ${premium(t.entry.premium)}`;
  let outText: string;
  if (t.exit) {
    const reason = EXIT_WORDS[t.exit.reason] ?? t.exit.reasonText ?? "closed";
    outText = `out ${fmtIstHm(t.exit.at)} at ${premium(t.exit.premium)} · ${reason}`;
  } else if (t.status === "OPEN") {
    outText = t.live ? `open · mark ${premium(t.live.mark)}${t.live.markAt ? ` at ${fmtIstHm(t.live.markAt)}` : ""}` : "open · no mark yet";
  } else {
    outText = "closed · no exit record";
  }
  return {
    id: t.id,
    href: accountHref("/copy", account, { id: t.id }),
    contract: t.contract.label,
    headline: t.headline,
    open: t.status === "OPEN",
    practice: isPractice(t),
    inText,
    outText,
    pnl: t.exit?.pnl ?? t.live?.pnl ?? null,
  };
}

/** The empty "Today's trades" text: "yet" only while a trade can still come today. */
export function noTradesText(phase: SessionPhase | null | undefined, nowMs: number | null): string {
  if (phase === "HOLIDAY") return "No trades today: the market is closed for a holiday.";
  if (phase === "OPEN" || phase === "PRE_OPEN") return "No trades yet today.";
  if (nowMs != null) {
    const p = istParts(nowMs);
    if (p.weekday <= 5 && p.minutesOfDay < 9 * 60 + 15) return "No trades yet today. The market opens at 09:15 IST.";
  }
  return "No trades today.";
}
