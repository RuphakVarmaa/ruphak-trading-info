/**
 * Plain-language status for the data feeds behind the Live P&L page: the index feed,
 * option prices, the engine loop and the dashboard's own polling. Pure, so it is unit-tested.
 */
import type { EngineStateDTO, PositionView, SignalView } from "@/engine/api-types";
import { fmtAge, fmtIstHm, fmtNum } from "@/components/shared/format";

export type FeedLevel = "ok" | "wait" | "stale" | "down";

export interface FeedStatus {
  level: FeedLevel;
  headline: string;
  detail: string;
}

/** 5-minute bars plus Yahoo's 1–2 minute delay. */
export const MARKET_FEED_MAX_AGE_MS = 10 * 60_000;
/** Open positions are re-marked every loop tick (30 s). */
export const OPTION_PRICE_MAX_AGE_MS = 3 * 60_000;
/** Decisions are stored once per closed 5-minute bar, after the 90 s data lag. */
export const SIGNAL_PRICE_MAX_AGE_MS = 8 * 60_000;

const ageOf = (iso: string | null | undefined, now: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};

const inSession = (state: EngineStateDTO) => state.market.phase === "OPEN" || state.market.phase === "PRE_OPEN";

export function marketFeedStatus(state: EngineStateDTO, now: number, index = "NIFTY"): FeedStatus {
  const q = state.quotes.find((x) => x.key === index);
  if (!q) return { level: "down", headline: `No ${index} price`, detail: "The engine has not stored a market snapshot yet." };
  const age = ageOf(q.asOf, now);
  const last = `${index} ${fmtNum(q.price)} at ${fmtIstHm(q.asOf)} IST`;
  if (state.market.phase !== "OPEN") {
    const when = state.market.phase === "PRE_OPEN" ? "pre-open, trading starts" : "market closed, opens";
    return { level: "wait", headline: "Waiting for the open", detail: `Last ${last} · ${when} ${fmtIstHm(state.market.nextOpenAt)} IST` };
  }
  const yahoo = state.health.yahoo;
  if (yahoo && !yahoo.ok) {
    return { level: "down", headline: "Feed failing", detail: `Yahoo is not answering${yahoo.detail ? ` (${yahoo.detail})` : ""} · last ${last}` };
  }
  if (q.stale || age == null || age > MARKET_FEED_MAX_AGE_MS) {
    return { level: "stale", headline: "Feed delayed", detail: `Last ${last}${age == null ? "" : `, ${fmtAge(age)} old`}` };
  }
  return { level: "ok", headline: "Coming through", detail: `${last} · ${fmtAge(age)} old · Yahoo, about 1–2 min delayed` };
}

export function optionPriceStatus(
  state: EngineStateDTO,
  positions: PositionView[] | null,
  signals: SignalView[] | null,
  now: number,
  index = "NIFTY",
): FeedStatus {
  const source = state.health.groww?.ok ? "Groww live quotes" : "Model price (Black-Scholes on India VIX), broker feed not connected";
  // Prefer the freshest open-position mark, then the premium on the latest decision's contract.
  let price: { label: string; value: number; asOf: string; maxAgeMs: number } | null = null;
  for (const p of positions ?? []) {
    if (p.ltp == null || !p.ltpAsOf) continue;
    if (!price || Date.parse(p.ltpAsOf) > Date.parse(price.asOf)) price = { label: p.contract.label, value: p.ltp, asOf: p.ltpAsOf, maxAgeMs: OPTION_PRICE_MAX_AGE_MS };
  }
  if (!price) {
    const s = signals?.find((x) => x.index === index);
    if (s?.contract && s.contract.premium != null) price = { label: s.contract.label, value: s.contract.premium, asOf: s.computedAt, maxAgeMs: SIGNAL_PRICE_MAX_AGE_MS };
  }
  if (!price) {
    return inSession(state)
      ? { level: "stale", headline: "No option price yet", detail: `Source: ${source}` }
      : { level: "wait", headline: "Starts at the pre-open", detail: `Prices begin with the 09:00 IST decisions · source: ${source}` };
  }
  const age = ageOf(price.asOf, now);
  const line = `${price.label} ₹${fmtNum(price.value)} at ${fmtIstHm(price.asOf)} IST`;
  if (!inSession(state)) return { level: "wait", headline: "Market closed", detail: `Last ${line} · source: ${source}` };
  if (age == null || age > price.maxAgeMs) {
    return { level: "stale", headline: "Prices delayed", detail: `Last ${line}${age == null ? "" : `, ${fmtAge(age)} old`} · source: ${source}` };
  }
  return { level: "ok", headline: "Coming through", detail: `${line} · ${fmtAge(age)} old · source: ${source}` };
}

export function engineLoopStatus(state: EngineStateDTO, now: number): FeedStatus {
  const hb = state.heartbeat;
  const age = ageOf(hb.lastTickAt, now);
  const last = hb.lastTickAt ? `last tick ${fmtIstHm(hb.lastTickAt)} IST${age == null ? "" : `, ${fmtAge(age)} ago`}` : "no tick yet";
  if (state.killSwitch || hb.phase === "KILLED") {
    return { level: "down", headline: "Kill switch on", detail: `${state.killReason ?? "Trading stopped"} · ${last}` };
  }
  if (hb.phase === "DEGRADED" || hb.consecutiveErrors > 0) {
    const level: FeedLevel = hb.phase === "DEGRADED" ? "down" : "stale";
    return { level, headline: `${hb.consecutiveErrors} failed tick${hb.consecutiveErrors === 1 ? "" : "s"}`, detail: `${hb.lastError ?? "see engine logs"} · ${last}` };
  }
  if (!inSession(state)) return { level: "wait", headline: "Idle until the pre-open", detail: `Runs every ${hb.loopIntervalSec} s from 09:00 IST · ${last}` };
  const maxAge = Math.max(3 * hb.loopIntervalSec, 90) * 1000;
  if (age == null || age > maxAge) return { level: "stale", headline: "Loop not ticking", detail: last };
  return { level: "ok", headline: "Running", detail: `Every ${hb.loopIntervalSec} s · ${last} · 0 errors` };
}

export function dashboardLinkStatus(status: "loading" | "live" | "stale" | "offline", lastOkAt: number | null, intervalMs: number, clientNow: number | null): FeedStatus {
  const ago = lastOkAt != null && clientNow != null ? `, last update ${fmtAge(Math.max(0, clientNow - lastOkAt))} ago` : "";
  if (status === "live") return { level: "ok", headline: "Connected", detail: `Refreshing every ${Math.round(intervalMs / 1000)} s${ago}` };
  if (status === "loading") return { level: "wait", headline: "Connecting", detail: "Loading the first update" };
  if (status === "stale") return { level: "stale", headline: "Updates delayed", detail: `The engine API is slow to answer${ago}` };
  return { level: "down", headline: "Offline", detail: `Cannot reach the engine API${ago}` };
}
